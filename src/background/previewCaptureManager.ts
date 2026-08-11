import type { CaptureImageFormat } from '../shared/messages'
import {
  BACKOFF_STEPS_MS,
  CAPTURE_INTERVAL_MS,
  CAPTURE_TIMEOUT_MS,
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
export interface CaptureRecord {
  tileId: string
  tabId: number
  attemptToken: number
  attemptIndex: number
  startedAt: number
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

  private async runCapture(item: CaptureQueueItem): Promise<void> {
    const state = this.tiles.get(item.tileId)
    if (state === undefined) {
      //+_+// pump 안에서 동기적으로 도달한다. 여기서 다시 pump 하지 않는다. 바깥 반복이 이어 받는다
      this.slots.delete(item.tileId)
      return
    }

    //+_+// 리스는 타일이 등록돼 있는 동안 유지한다. 캡처마다 attach 와 detach 를 반복하지 않는다
    if (!state.holdsLease) {
      const attached = await this.sessions.ensureAttached(state.tabId)
      if (!attached.ok) {
        this.settleWithoutCall(state, attached.message, tileStatusForDebuggerError(attached.errorCode))
        return
      }
      state.holdsLease = true
    }

    if (!state.pageEnabled) {
      try {
        await this.backend.sendCommand(state.tabId, 'Page.enable')
        state.pageEnabled = true
      } catch (error) {
        this.settleWithoutCall(state, errorMessage(error), null)
        return
      }
    }

    this.startTimedCapture(state)
  }

  //+_+// startedAt 은 호출 직전에 기록한다. 타임아웃 경로에서도 이 값이 남는다
  private startTimedCapture(state: TileState): void {
    this.nextToken += 1
    state.attemptCount += 1
    const attempt: InFlightAttempt = {
      tileId: state.tileId,
      tabId: state.tabId,
      token: this.nextToken,
      attemptIndex: state.attemptCount - 1,
      startedAt: this.clock.now(),
      cancelTimer: () => undefined,
    }
    attempt.cancelTimer = this.clock.schedule(CAPTURE_TIMEOUT_MS, () => {
      this.onTimeout(attempt)
    })
    this.inFlight.set(state.tileId, attempt)

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

  //+_+// 슬롯을 그 자리에서 반납한다. sendCommand 는 취소할 수 없으므로 응답을 기다리지 않는다
  private onTimeout(attempt: InFlightAttempt): void {
    if (this.inFlight.get(attempt.tileId)?.token !== attempt.token) {
      return
    }
    this.inFlight.delete(attempt.tileId)
    this.slots.delete(attempt.tileId)
    const now = this.clock.now()
    this.record(attempt, {
      outcome: 'timeout',
      durationMs: now - attempt.startedAt,
      bytes: null,
      message: null,
    })
    const state = this.tiles.get(attempt.tileId)
    if (state !== undefined) {
      this.applyFailure(state, now, null)
    }
    this.pump()
  }

  private onResponse(attempt: InFlightAttempt, data: string | null, failure: string | null): void {
    const now = this.clock.now()
    const current = this.inFlight.get(attempt.tileId)

    //+_+// 이미 포기한 회차다. 프레임으로 채택하지 않는다. 다음 회차의 결과로 섞이지 않는다
    if (current === undefined || current.token !== attempt.token) {
      const durationMs = now - attempt.startedAt
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

    attempt.cancelTimer()
    this.inFlight.delete(attempt.tileId)
    this.slots.delete(attempt.tileId)
    const durationMs = now - attempt.startedAt
    const state = this.tiles.get(attempt.tileId)

    if (data === null) {
      this.record(attempt, {
        outcome: 'failure',
        durationMs,
        bytes: null,
        message: failure ?? 'empty screenshot payload',
      })
      if (state !== undefined) {
        this.applyFailure(state, now, null)
      }
      this.pump()
      return
    }

    const frame: CapturedFrame = {
      imageBase64: data,
      format: this.format,
      bytes: base64ByteLength(data),
    }
    this.frames.set(attempt.tileId, frame)
    if (state !== undefined) {
      state.lastFrameAt = now
      state.consecutiveFailures = 0
      state.demoted = false
      state.fault = null
      state.nextDueAt = now + state.baseIntervalMs
    }
    this.record(attempt, { outcome: 'success', durationMs, bytes: frame.bytes, message: null }, frame)
    this.pump()
  }

  //+_+// 캡처 호출에 이르지 못한 실패다. 회차 기록을 남기지 않고 실패 계단만 올린다
  private settleWithoutCall(state: TileState, message: string, fault: TileStatus | null): void {
    const now = this.clock.now()
    this.slots.delete(state.tileId)
    this.nextToken += 1
    state.attemptCount += 1
    this.record(
      {
        tileId: state.tileId,
        tabId: state.tabId,
        token: this.nextToken,
        attemptIndex: state.attemptCount - 1,
        startedAt: now,
        cancelTimer: () => undefined,
      },
      { outcome: 'failure', durationMs: 0, bytes: null, message },
    )
    this.applyFailure(state, now, fault)
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
      //+_+// 값이 dashboardHidden 과 같으나 별개의 정책이다. 새 상수를 만들지 않으려고 재사용한다
      state.demoted = true
      state.nextDueAt = now + CAPTURE_INTERVAL_MS.dashboardHidden
      return
    }
    state.demoted = false
    state.nextDueAt = now + nextDelayMs(state.consecutiveFailures, state.baseIntervalMs)
  }

  private record(
    attempt: InFlightAttempt,
    settled: Pick<CaptureRecord, 'outcome' | 'durationMs' | 'bytes' | 'message'>,
    frame: CapturedFrame | null = null,
  ): void {
    const entry: CaptureRecord = {
      tileId: attempt.tileId,
      tabId: attempt.tabId,
      attemptToken: attempt.token,
      attemptIndex: attempt.attemptIndex,
      startedAt: attempt.startedAt,
      ...settled,
    }
    this.captureLog.push(entry)
    this.onCaptureSettled?.(entry, frame)
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
