import type { CaptureImageFormat } from '../shared/messages'
import {
  BACKOFF_STEPS_MS,
  CAPTURE_TIMEOUT_MS,
  DEGRADED_INTERVAL_MS,
  MAX_CONCURRENT_CAPTURES,
  STALE_AFTER_MULTIPLIER,
  canEnqueue,
  nextDelayMs,
} from '../shared/scheduler'
import type { CaptureQueueItem } from '../shared/scheduler'
import type { TileStatus } from '../shared/types'
import { errorMessage, tileStatusForDebuggerError } from './debuggerSessionManager'
import type {
  DebuggerBackend,
  DebuggerSessionManager,
  DetachEventRecord,
} from './debuggerSessionManager'

//+_+// D2 로 확정된 기본값이다. 스케줄러 상수 8개와 다른 층이므로 scheduler.ts 에 넣지 않는다
export const CAPTURE_FORMAT: CaptureImageFormat = 'jpeg'
export const CAPTURE_QUALITY = 70

//+_+// 시각과 타이머를 주입한다. 타임아웃과 STALE 을 실시간 대기 없이 시험할 수 있어야 한다
export interface Clock {
  now(): number
  schedule(delayMs: number, callback: () => void): () => void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (delayMs, callback) => {
    const handle: ReturnType<typeof setTimeout> = setTimeout(callback, delayMs)
    return () => {
      clearTimeout(handle)
    }
  },
}

export type CaptureOutcome = 'success' | 'timeout' | 'failure'

export interface CapturedFrame {
  imageBase64: string
  format: CaptureImageFormat
  bytes: number
}

//+_+// 타임아웃 행에도 startedAt 과 durationMs 가 있다. L23 이 그 공백을 지적했다
//+_+// startedAt 은 회차 시작이고 durationMs 는 회차 전체다. 마감 기준이 회차이기 때문이다
//+_+// calledAt 은 captureScreenshot 을 실제로 보낸 시각이다. 호출 자체의 소요는 여기서 뺀다
//+_+// attach 나 Page.enable 에서 끝난 회차는 calledAt 이 null 이다
export interface CaptureRecord {
  tileId: string
  tabId: number
  attemptToken: number
  attemptIndex: number
  startedAt: number
  calledAt: number | null
  durationMs: number
  outcome: CaptureOutcome
  bytes: number | null
  message: string | null
}

//+_+// 타임아웃 뒤에 도착한 응답이다. 프레임으로 쓰지 않고 기록만 한다
export interface LateArrivalRecord {
  tileId: string
  tabId: number
  attemptToken: number
  startedAt: number
  durationMs: number
  lateByMs: number
  settledAs: 'success' | 'failure'
}

export interface PreviewCaptureManagerOptions {
  format?: CaptureImageFormat
  quality?: number
  onCaptureSettled?: (record: CaptureRecord, frame: CapturedFrame | null) => void
}

export interface DueTileInput {
  tileId: string
  tabId: number
  nextDueAt: number
}

interface TileState {
  tileId: string
  tabId: number
  baseIntervalMs: number
  nextDueAt: number
  attemptCount: number
  consecutiveFailures: number
  demoted: boolean
  lastFrameAt: number
  holdsLease: boolean
  pageEnabled: boolean
  fault: TileStatus | null
}

interface InFlightAttempt {
  tileId: string
  tabId: number
  token: number
  attemptIndex: number
  startedAt: number
  calledAt: number | null
  cancelTimer: () => void
}

//+_+// 디코드하지 않고 base64 길이에서 산술로 구한다. 말미 = 개수만큼 뺀다
export function base64ByteLength(base64: string): number {
  if (base64.length === 0) {
    return 0
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

//+_+// 만기 시각이 이른 순이다. 별도의 우선순위 정렬을 두지 않는다
//+_+// 지속시간 통계를 입력으로 받지 않는다. 고정 주기와 backoff 만으로 결정한다. L22
export function selectDueTiles(tiles: readonly DueTileInput[], now: number): DueTileInput[] {
  return tiles.filter((tile) => tile.nextDueAt <= now).sort((a, b) => a.nextDueAt - b.nextDueAt)
}

//+_+// 세션 상태가 신선도보다 앞선다. LOADING / FROZEN / DISCARDED 는 탭 상태 기반이고 v1 section 11 이다
export const TILE_STATUS_PRIORITY = ['ERROR', 'DETACHED', 'DEVTOOLS', 'STALE', 'LIVE'] as const

export function resolveTileStatus(candidates: readonly (TileStatus | null)[]): TileStatus {
  for (const status of TILE_STATUS_PRIORITY) {
    if (candidates.includes(status)) {
      return status
    }
  }
  return 'LIVE'
}

//+_+// 판정 기준은 강등 전 기본 주기다. 45000 으로 강등된 뒤에도 기본 주기 x3 을 쓴다
//+_+// 강등은 실패의 결과이므로 그것 때문에 STALE 판정이 늦어지면 실패를 숨기게 된다
export function isStale(now: number, lastFrameAt: number, baseIntervalMs: number): boolean {
  return now - lastFrameAt > baseIntervalMs * STALE_AFTER_MULTIPLIER
}

function screenshotData(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }
  const data = (result as { data?: unknown }).data
  return typeof data === 'string' && data.length > 0 ? data : null
}

export class PreviewCaptureManager {
  private readonly backend: DebuggerBackend
  private readonly sessions: DebuggerSessionManager
  private readonly clock: Clock
  private readonly format: CaptureImageFormat
  private readonly quality: number
  private readonly onCaptureSettled: ((record: CaptureRecord, frame: CapturedFrame | null) => void) | null
  private readonly tiles = new Map<string, TileState>()
  private readonly queue: CaptureQueueItem[] = []
  //+_+// 슬롯은 attach 를 기다리기 전에 잡는다. 비동기 구간에서 상한이 풀리면 안 된다
  private readonly slots = new Map<string, number>()
  private readonly inFlight = new Map<string, InFlightAttempt>()
  private readonly captureLog: CaptureRecord[] = []
  private readonly lateArrivalLog: LateArrivalRecord[] = []
  private readonly frames = new Map<string, CapturedFrame>()
  private nextToken = 0

  constructor(
    backend: DebuggerBackend,
    sessions: DebuggerSessionManager,
    clock: Clock,
    options: PreviewCaptureManagerOptions = {},
  ) {
    this.backend = backend
    this.sessions = sessions
    this.clock = clock
    this.format = options.format ?? CAPTURE_FORMAT
    this.quality = options.quality ?? CAPTURE_QUALITY
    this.onCaptureSettled = options.onCaptureSettled ?? null
    this.sessions.addDetachListener((event) => {
      this.applyDetach(event)
    })
  }

  get captureRecords(): readonly CaptureRecord[] {
    return this.captureLog
  }

  get lateArrivals(): readonly LateArrivalRecord[] {
    return this.lateArrivalLog
  }

  get inFlightCount(): number {
    return this.slots.size
  }

  get queueLength(): number {
    return this.queue.length
  }

  latestFrame(tileId: string): CapturedFrame | null {
    return this.frames.get(tileId) ?? null
  }

  //+_+// 첫 성공 전에는 등록 시각이 신선도의 기준이다. 한 번도 반환되지 않는 탭도 STALE 로 간다
  register(tileId: string, tabId: number, baseIntervalMs: number): void {
    const now = this.clock.now()
    this.tiles.set(tileId, {
      tileId,
      tabId,
      baseIntervalMs,
      nextDueAt: now,
      attemptCount: 0,
      consecutiveFailures: 0,
      demoted: false,
      lastFrameAt: now,
      holdsLease: false,
      pageEnabled: false,
      fault: null,
    })
  }

  async unregister(tileId: string): Promise<void> {
    const state = this.tiles.get(tileId)
    if (state === undefined) {
      return
    }
    this.tiles.delete(tileId)
    this.dropQueued(tileId)
    this.slots.delete(tileId)
    const attempt = this.inFlight.get(tileId)
    if (attempt !== undefined) {
      attempt.cancelTimer()
      this.inFlight.delete(tileId)
    }
    if (state.holdsLease) {
      await this.sessions.release(state.tabId)
    }
  }

  //+_+// v1 section 5.2 조건 9 는 navigation 후 캡처가 복구되는지 확인하라고만 정한다
  //+_+// 세션이 navigation 을 넘겨 살아남는지는 확인되지 않았다. 리스를 놓지 않는다
  //+_+// Page.enable 만 다시 보낸다. 세션이 실제로 죽었으면 다음 캡처가 실패해 계단이 처리한다
  noteNavigation(tabId: number): void {
    for (const state of this.tiles.values()) {
      if (state.tabId === tabId) {
        state.pageEnabled = false
      }
    }
  }

  //+_+// 탭이 닫히면 그 탭에 걸린 타일을 전부 내린다. 리스도 함께 놓는다
  async releaseTab(tabId: number): Promise<void> {
    const tileIds = [...this.tiles.values()]
      .filter((state) => state.tabId === tabId)
      .map((state) => state.tileId)
    for (const tileId of tileIds) {
      await this.unregister(tileId)
    }
  }

  statusOf(tileId: string): TileStatus | null {
    const state = this.tiles.get(tileId)
    if (state === undefined) {
      return null
    }
    const stale = isStale(this.clock.now(), state.lastFrameAt, state.baseIntervalMs)
    return resolveTileStatus([state.fault, stale ? 'STALE' : 'LIVE'])
  }

  //+_+// 구동자는 이 함수를 부르기만 한다. setInterval 은 serviceWorker 쪽에 둔다
  tick(): void {
    const now = this.clock.now()
    const due = selectDueTiles([...this.tiles.values()], now)
    const running = [...this.slots.entries()].map(([tileId, tabId]) => ({ tileId, tabId }))
    for (const tile of due) {
      const item: CaptureQueueItem = { tileId: tile.tileId, tabId: tile.tabId }
      if (canEnqueue(item, running, this.queue)) {
        this.queue.push(item)
      }
    }
    this.pump()
  }

  private pump(): void {
    while (this.slots.size < MAX_CONCURRENT_CAPTURES && this.queue.length > 0) {
      const item = this.queue.shift()
      if (item === undefined) {
        return
      }
      this.slots.set(item.tileId, item.tabId)
      void this.runCapture(item)
    }
  }

  private dropQueued(tileId: string): void {
    const index = this.queue.findIndex((item) => item.tileId === tileId)
    if (index >= 0) {
      this.queue.splice(index, 1)
    }
  }

  //+_+// 슬롯 보유 상한은 CAPTURE_TIMEOUT_MS 하나다. attach 와 Page.enable 도 그 안에 든다. D6
  private async runCapture(item: CaptureQueueItem): Promise<void> {
    const state = this.tiles.get(item.tileId)
    if (state === undefined) {
      //+_+// pump 안에서 동기적으로 도달한다. 여기서 다시 pump 하지 않는다. 바깥 반복이 이어 받는다
      this.slots.delete(item.tileId)
      return
    }

    const attempt = this.beginAttempt(state)

    //+_+// 리스는 타일이 등록돼 있는 동안 유지한다. 캡처마다 attach 와 detach 를 반복하지 않는다
    if (!state.holdsLease) {
      const attached = await this.sessions.ensureAttached(state.tabId)
      if (this.isAbandoned(attempt)) {
        return
      }
      if (!attached.ok) {
        //+_+// 누적 시도가 소진됐을 때만 ERROR 다. 한두 번 실패는 계단만 올린다
        this.settle(attempt, { outcome: 'failure', bytes: null, message: attached.message }, {
          fault: attached.exhausted ? tileStatusForDebuggerError(attached.errorCode) : null,
        })
        return
      }
      state.holdsLease = true
    }

    //+_+// Page.enable 이 정말 필요한지 확인되지 않았다. POC 가 보냈으므로 같은 순서를 유지한다
    //+_+// 하네스가 생략 변형과 대조한다. 확인 전까지 뺄 근거가 없다
    if (!state.pageEnabled) {
      try {
        await this.backend.sendCommand(state.tabId, 'Page.enable')
        state.pageEnabled = true
      } catch (error) {
        if (!this.isAbandoned(attempt)) {
          this.settle(attempt, { outcome: 'failure', bytes: null, message: errorMessage(error) })
        }
        return
      }
      if (this.isAbandoned(attempt)) {
        return
      }
    }

    attempt.calledAt = this.clock.now()
    this.backend
      .sendCommand(state.tabId, 'Page.captureScreenshot', {
        format: this.format,
        quality: this.quality,
      })
      .then(
        (result) => {
          this.onResponse(attempt, screenshotData(result), null)
        },
        (error: unknown) => {
          this.onResponse(attempt, null, errorMessage(error))
        },
      )
  }

  //+_+// startedAt 은 회차 시작이고 마감의 기준이다. 타임아웃 경로에서도 남는다. L23
  private beginAttempt(state: TileState): InFlightAttempt {
    this.nextToken += 1
    state.attemptCount += 1
    const attempt: InFlightAttempt = {
      tileId: state.tileId,
      tabId: state.tabId,
      token: this.nextToken,
      attemptIndex: state.attemptCount - 1,
      startedAt: this.clock.now(),
      calledAt: null,
      cancelTimer: () => undefined,
    }
    attempt.cancelTimer = this.clock.schedule(CAPTURE_TIMEOUT_MS, () => {
      this.onTimeout(attempt)
    })
    this.inFlight.set(state.tileId, attempt)
    return attempt
  }

  private isAbandoned(attempt: InFlightAttempt): boolean {
    return this.inFlight.get(attempt.tileId)?.token !== attempt.token
  }

  //+_+// 슬롯을 그 자리에서 반납한다. sendCommand 는 취소할 수 없으므로 응답을 기다리지 않는다
  private onTimeout(attempt: InFlightAttempt): void {
    if (this.isAbandoned(attempt)) {
      return
    }
    this.settle(attempt, { outcome: 'timeout', bytes: null, message: null })
  }

  private onResponse(attempt: InFlightAttempt, data: string | null, failure: string | null): void {
    //+_+// 이미 포기한 회차다. 프레임으로 채택하지 않는다. 다음 회차의 결과로 섞이지 않는다
    if (this.isAbandoned(attempt)) {
      const durationMs = this.clock.now() - attempt.startedAt
      this.lateArrivalLog.push({
        tileId: attempt.tileId,
        tabId: attempt.tabId,
        attemptToken: attempt.token,
        startedAt: attempt.startedAt,
        durationMs,
        lateByMs: durationMs - CAPTURE_TIMEOUT_MS,
        settledAs: data === null ? 'failure' : 'success',
      })
      return
    }

    if (data === null) {
      this.settle(attempt, {
        outcome: 'failure',
        bytes: null,
        message: failure ?? 'empty screenshot payload',
      })
      return
    }

    const frame: CapturedFrame = {
      imageBase64: data,
      format: this.format,
      bytes: base64ByteLength(data),
    }
    this.settle(attempt, { outcome: 'success', bytes: frame.bytes, message: null }, { frame })
  }

  //+_+// 회차를 끝내는 유일한 자리다. 슬롯 반납과 기록과 다음 만기를 한 곳에서 처리한다
  private settle(
    attempt: InFlightAttempt,
    settled: Pick<CaptureRecord, 'outcome' | 'bytes' | 'message'>,
    extra: { frame?: CapturedFrame; fault?: TileStatus | null } = {},
  ): void {
    attempt.cancelTimer()
    this.inFlight.delete(attempt.tileId)
    this.slots.delete(attempt.tileId)

    const now = this.clock.now()
    const state = this.tiles.get(attempt.tileId)
    const frame = extra.frame ?? null

    if (frame !== null) {
      this.frames.set(attempt.tileId, frame)
    }
    if (state !== undefined) {
      if (frame === null) {
        this.applyFailure(state, now, extra.fault ?? null)
      } else {
        state.lastFrameAt = now
        state.consecutiveFailures = 0
        state.demoted = false
        state.fault = null
        state.nextDueAt = now + state.baseIntervalMs
      }
    }

    const entry: CaptureRecord = {
      tileId: attempt.tileId,
      tabId: attempt.tabId,
      attemptToken: attempt.token,
      attemptIndex: attempt.attemptIndex,
      startedAt: attempt.startedAt,
      calledAt: attempt.calledAt,
      durationMs: now - attempt.startedAt,
      ...settled,
    }
    this.captureLog.push(entry)
    this.onCaptureSettled?.(entry, frame)
    this.pump()
  }

  //+_+// 타임아웃 1회로 ERROR 를 만들지 않는다. fault 는 세션 사유가 있을 때만 실린다
  private applyFailure(state: TileState, now: number, fault: TileStatus | null): void {
    state.consecutiveFailures += 1
    if (fault !== null) {
      state.fault = fault
    }
    if (state.consecutiveFailures > BACKOFF_STEPS_MS.length) {
      //+_+// 계단을 소진해도 재시도를 멈추지 않는다. 주기만 강등한다
      state.demoted = true
      state.nextDueAt = now + DEGRADED_INTERVAL_MS
      return
    }
    state.demoted = false
    state.nextDueAt = now + nextDelayMs(state.consecutiveFailures, state.baseIntervalMs)
  }

  //+_+// 세션이 끊기면 다음 캡처에서 다시 붙인다. 그 사이에 무한 retry 를 돌리지 않는다
  private applyDetach(event: DetachEventRecord): void {
    for (const state of this.tiles.values()) {
      if (state.tabId !== event.tabId) {
        continue
      }
      state.holdsLease = false
      state.pageEnabled = false
      state.fault = tileStatusForDebuggerError(event.errorCode)
    }
  }
}
