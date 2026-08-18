import type { CaptureImageFormat } from '../shared/messages'
import {
  BACKOFF_STEPS_MS,
  CAPTURE_TIMEOUT_MS,
  DEGRADED_INTERVAL_MS,
  MAX_CONCURRENT_CAPTURES,
  STALE_AFTER_MULTIPLIER,
  canEnqueue,
  nextDelayMs,
  nextDueAtFrom,
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

//+_+// failure 를 세 갈래로 나눈다. 리포트가 attach 실패와 캡처 실패를 구분해야 한다
export type CaptureOutcome =
  | 'success'
  | 'timeout'
  | 'attachFailed'
  | 'captureFailed'
  | 'tabGone'

export interface CapturedFrame {
  imageBase64: string
  format: CaptureImageFormat
  bytes: number
}

//+_+// 타임아웃 행에도 startedAt 과 roundDurationMs 가 있다. L23 이 그 공백을 지적했다
//+_+// durationMs 라는 이름을 쓰지 않는다. 회차 소요와 호출 소요는 다른 값이다. P3-D9
//+_+// startedAt 은 회차 시작이고 roundDurationMs 는 회차 전체다. 마감 기준이 회차이기 때문이다
//+_+// calledAt 은 captureScreenshot 을 실제로 보낸 시각이다. 거기서부터가 callDurationMs 다
//+_+// attach 에서 끝난 회차는 calledAt 과 callDurationMs 가 둘 다 null 이다
export interface CaptureRecord {
  tileId: string
  tabId: number
  attemptToken: number
  attemptIndex: number
  startedAt: number
  calledAt: number | null
  roundDurationMs: number
  callDurationMs: number | null
  //+_+// P6-D51. 이 회차의 만기를 정할 때 실제로 더해진 주기다. 회차가 시작될 때 읽는다
  //+_+// 정산 뒤에 읽으면 이 회차의 결과가 이미 계단을 올려 놓은 뒤라 부른 주기와 어긋난다
  scheduleIntervalMs: number
  outcome: CaptureOutcome
  bytes: number | null
  message: string | null
}

//+_+// 타임아웃 뒤에 도착한 응답이다. 프레임으로 쓰지 않고 기록만 한다
export interface LateArrivalRecord {
  tileId: string
  tabId: number
  attemptToken: number
  attemptIndex: number
  startedAt: number
  roundDurationMs: number
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
  //+_+// P6-D51. nextDueAt 을 정할 때 더한 값이다. 기본 주기 · backoff 계단 · 강등 주기 중 하나다
  appliedIntervalMs: number
  nextDueAt: number
  //+_+// P4-D16. 이 회차가 예정돼 있던 시각이다. 다음 만기를 여기서부터 잡는다
  //+_+// 큐에서 슬롯을 기다린 시간이 주기에 더해지지 않도록 실행 시각이 아니라 예정 시각을 쓴다
  scheduledAt: number
  attemptCount: number
  consecutiveFailures: number
  demoted: boolean
  lastFrameAt: number
  holdsLease: boolean
  fault: TileStatus | null
  //+_+// P5-D20. 탭이 닫혔다는 사실이다. fault 와 나누는 이유는 디버거 detach 가 탭 소멸이 아니어서다
  //+_+// detach 는 다음 회차가 다시 붙어야 하고 탭 소멸은 붙을 곳이 없다
  tabGone: boolean
}

interface InFlightAttempt {
  tileId: string
  tabId: number
  token: number
  attemptIndex: number
  startedAt: number
  calledAt: number | null
  scheduleIntervalMs: number
  //+_+// 마감 타이머가 실제로 끝난 시각이다. 그 밖의 사유로 포기한 회차는 null 로 남는다
  timedOutAt: number | null
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

//+_+// r1b 에서 실제로 관측된 문자열이다. 추측이 아니다
//+_+// 06:07:23 강제 detach 직후 "Detached while handling command."
//+_+// 그 뒤 "Debugger is not attached to the tab with id: N" 이 끝까지 반복됐다
//+_+// onDetach 가 발화하지 않는 경로가 있어 리스가 남고 ensureAttached 가 통과시킨다
export const SESSION_LOST_MESSAGES: readonly string[] = [
  'detached while handling command',
  'debugger is not attached',
]

export function isSessionLost(message: string | null): boolean {
  if (message === null) {
    return false
  }
  const lower = message.toLowerCase()
  return SESSION_LOST_MESSAGES.some((needle) => lower.includes(needle))
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
  //+_+// P5-D6. 즉시 캡처를 기다리는 쪽이다. 회차가 정산되면 그 프레임으로 깨운다
  private readonly onceWaiters = new Map<string, ((frame: CapturedFrame | null) => void)[]>()
  //+_+// P6-D46. Pause 는 억제 플래그다. 리스도 슬롯도 건드리지 않으므로 attach 가 유지된다 (D6a)
  //+_+// 시각을 들고 있는 이유는 해제 시 그 길이만큼 만기와 신선도 기준을 밀어야 하기 때문이다
  private pausedAt: number | null = null
  //+_+// P6-D50. Pause 구간 안에서 시각을 새로 잡은 타일이다. 잃은 시간이 없으므로 밀지 않는다
  //+_+// 두 경로가 있다. captureOnce 로 정산된 타일과, Pause 중에 등록된 타일이다
  private readonly freshWhilePaused = new Set<string>()
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

  //+_+// P6-D17. 등록과 해제가 이 수의 경계다. tabGone 타일도 등록돼 있으므로 센다
  get registeredTileCount(): number {
    return this.tiles.size
  }

  get paused(): boolean {
    return this.pausedAt !== null
  }

  //+_+// P6-D46 · D6a. unregister 를 부르지 않는다. 리스를 놓으면 타일이 DETACHED 로 바뀐다
  //+_+// P6-D50. 해제할 때 Pause 구간 길이만큼 만기와 마지막 프레임 시각을 함께 민다
  //+_+// 두 값을 같은 양으로 밀어야 해제 직후에 전 타일이 몰려 돌지도(A-e3) STALE 로 보이지도(A-e4) 않는다
  setPaused(next: boolean): void {
    if (next === (this.pausedAt !== null)) {
      return
    }
    const now = this.clock.now()
    if (next) {
      this.pausedAt = now
      this.freshWhilePaused.clear()
      return
    }

    const shiftMs = now - (this.pausedAt ?? now)
    this.pausedAt = null
    for (const state of this.tiles.values()) {
      //+_+// Pause 구간 안에서 시각을 잡은 타일은 그 시각이 이미 옳다. 밀면 만기가 미래로 달아난다
      //+_+// 워커가 Pause 로 시작하므로 기동 시 등록된 타일이 전부 여기에 해당한다
      //+_+// 그것까지 밀면 Dashboard 를 열어도 워커가 Pause 로 산 시간만큼 첫 회차가 늦는다
      if (this.freshWhilePaused.has(state.tileId)) {
        continue
      }
      state.nextDueAt += shiftMs
      state.scheduledAt += shiftMs
      state.lastFrameAt += shiftMs
    }
    this.freshWhilePaused.clear()
  }

  latestFrame(tileId: string): CapturedFrame | null {
    return this.frames.get(tileId) ?? null
  }

  //+_+// 첫 성공 전에는 등록 시각이 신선도의 기준이다. 한 번도 반환되지 않는 탭도 STALE 로 간다
  //+_+// P5-D20. 같은 탭으로 다시 등록하는 것은 아는 것을 지우지 않는다. 그것이 L36 이었다
  //+_+// 다른 탭에 거는 것만 새 상태다. Reopen 과 Bind 가 fault 를 지우는 유일한 명시 경로가 된다
  //+_+// 만기는 언제나 초기화한다. 새 주기를 적용하는 것이 재등록의 목적이다
  //+_+// P6-D44. 실패 계단은 같은 탭이면 승계한다. 전에는 재등록 한 번이 계단을 통째로 지웠다
  //+_+// 다른 탭이면 지금대로 초기화한다. 새 탭이 fault 를 지우는 명시 경로라는 P5-D32 를 지킨다
  register(tileId: string, tabId: number, baseIntervalMs: number): void {
    const now = this.clock.now()
    const previous = this.tiles.get(tileId)
    const kept = previous !== undefined && previous.tabId === tabId ? previous : null
    this.tiles.set(tileId, {
      tileId,
      tabId,
      baseIntervalMs,
      appliedIntervalMs: baseIntervalMs,
      nextDueAt: now,
      scheduledAt: now,
      attemptCount: 0,
      consecutiveFailures: kept?.consecutiveFailures ?? 0,
      demoted: kept?.demoted ?? false,
      lastFrameAt: kept?.lastFrameAt ?? now,
      holdsLease: kept?.holdsLease ?? false,
      fault: kept?.fault ?? null,
      tabGone: kept?.tabGone ?? false,
    })
    //+_+// P6-D50. Pause 중 등록은 만기를 이미 현재 시각으로 잡았다. 해제 시프트의 대상이 아니다
    if (this.pausedAt !== null) {
      this.freshWhilePaused.add(tileId)
    }
  }

  async unregister(tileId: string): Promise<void> {
    const state = this.tiles.get(tileId)
    if (state === undefined) {
      return
    }
    this.tiles.delete(tileId)
    this.abandonRound(state)
    if (state.holdsLease) {
      await this.sessions.release(state.tabId)
    }
  }

  //+_+// 진행 중이던 회차는 tabGone 으로 닫는다. 조용히 사라지면 회차 수가 맞지 않는다
  private abandonRound(state: TileState): void {
    this.dropQueued(state.tileId)
    this.slots.delete(state.tileId)

    const attempt = this.inFlight.get(state.tileId)
    if (attempt !== undefined) {
      attempt.cancelTimer()
      this.inFlight.delete(state.tileId)
      this.write(attempt, { outcome: 'tabGone', bytes: null, message: null })
    }
    //+_+// 기다리던 즉시 캡처가 있으면 여기서 끝낸다. 회차가 사라졌으므로 깨울 곳이 없다
    this.resolveOnce(state.tileId, null)
  }

  //+_+// P5-D20. 탭이 닫히면 상태를 지우지 않는다. 소멸을 기억하고 스케줄에서만 뺀다
  //+_+// 지우면 다음 등록이 그 사실을 모른 채 새 상태를 만든다. 그것이 L36 이었다
  //+_+// 리스는 그대로 놓는다. detach 동작을 바꾸지 않는다
  async releaseTab(tabId: number): Promise<void> {
    for (const state of this.tiles.values()) {
      if (state.tabId !== tabId) {
        continue
      }
      state.tabGone = true
      state.fault = 'DETACHED'
      this.abandonRound(state)
      if (state.holdsLease) {
        state.holdsLease = false
        await this.sessions.release(tabId)
      }
    }
  }

  //+_+// P5-D6. v1 section 14 의 Refresh Preview 다. 페이지를 reload 하지 않고 프레임만 다시 받는다
  //+_+// 큐를 우회하지 않는다. 만기를 당겨 정상 경로가 집어가게 한다. v1 section 6.1
  //+_+// 같은 탭에 회차가 이미 떠 있으면 canEnqueue 가 막고 그 회차의 결과가 이 약속을 깨운다
  captureOnce(tileId: string): Promise<CapturedFrame | null> {
    const state = this.tiles.get(tileId)
    if (state === undefined || state.tabGone) {
      return Promise.resolve(null)
    }

    const waiting = new Promise<CapturedFrame | null>((resolve) => {
      const waiters = this.onceWaiters.get(tileId) ?? []
      waiters.push(resolve)
      this.onceWaiters.set(tileId, waiters)
    })
    state.nextDueAt = this.clock.now()
    //+_+// P6-D46. 사용자가 지금 보겠다고 누른 것이므로 Pause 가 막지 않는다
    //+_+// tick 을 부르면 게이트에 걸려 이 약속이 깨어날 회차가 영영 생기지 않는다
    this.runDue()
    return waiting
  }

  //+_+// 기다리는 쪽을 남겨 두지 않는다. 회차가 어떻게 끝나든 한 번은 깨운다
  private resolveOnce(tileId: string, frame: CapturedFrame | null): void {
    const waiters = this.onceWaiters.get(tileId)
    if (waiters === undefined) {
      return
    }
    this.onceWaiters.delete(tileId)
    for (const resolve of waiters) {
      resolve(frame)
    }
  }

  //+_+// P5-D35. 엔진이 이 타일을 아직 스케줄에 두고 있는가다
  //+_+// 모르는 타일과 탭이 사라진 타일이 false 다. 재연결과 Open Missing Tabs 가 이것으로 대상을 고른다
  isScheduled(tileId: string): boolean {
    const state = this.tiles.get(tileId)
    return state !== undefined && !state.tabGone
  }

  statusOf(tileId: string): TileStatus | null {
    const state = this.tiles.get(tileId)
    if (state === undefined) {
      return null
    }
    //+_+// P6-D38. Pause 는 캡처를 멈춘다. 그 구간의 경과가 신선도 판정에 들어가면
    //+_+// 수동 Pause 중에 전 타일이 STALE 로 보인다. 멈춘 시각을 그대로 현재로 읽는다
    const at = this.pausedAt ?? this.clock.now()
    const stale = isStale(at, state.lastFrameAt, state.baseIntervalMs)
    return resolveTileStatus([state.fault, stale ? 'STALE' : 'LIVE'])
  }

  //+_+// 구동자는 이 함수를 부르기만 한다. setInterval 은 serviceWorker 쪽에 둔다
  //+_+// P6-D46. Pause 게이트는 이 정기 경로에만 건다. captureOnce 는 runDue 를 직접 부른다
  tick(): void {
    if (this.pausedAt !== null) {
      return
    }
    this.runDue()
  }

  private runDue(): void {
    const now = this.clock.now()
    //+_+// P5-D20. 탭이 사라진 타일은 만기가 와도 큐에 넣지 않는다. 붙일 탭이 없다
    //+_+// 디버거 detach 는 여기에 해당하지 않는다. 탭은 살아 있고 다음 회차가 다시 붙는다
    const alive = [...this.tiles.values()].filter((state) => !state.tabGone)
    const due = selectDueTiles(alive, now)
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

  //+_+// 슬롯 보유 상한은 CAPTURE_TIMEOUT_MS 하나다. attach 도 그 안에 든다. D6
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
        this.settle(attempt, { outcome: 'attachFailed', bytes: null, message: attached.message }, {
          fault: attached.exhausted ? tileStatusForDebuggerError(attached.errorCode) : null,
        })
        return
      }
      state.holdsLease = true
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
    //+_+// P4-D16. 이 회차를 부른 만기를 기억한다. 정산에서 다음 만기의 기준이 된다
    state.scheduledAt = state.nextDueAt
    const attempt: InFlightAttempt = {
      tileId: state.tileId,
      tabId: state.tabId,
      token: this.nextToken,
      attemptIndex: state.attemptCount - 1,
      startedAt: this.clock.now(),
      calledAt: null,
      //+_+// P6-D51. 이 회차를 부른 주기다. 정산이 계단을 올리기 전에 읽는다
      scheduleIntervalMs: state.appliedIntervalMs,
      timedOutAt: null,
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
    attempt.timedOutAt = this.clock.now()
    this.settle(attempt, { outcome: 'timeout', bytes: null, message: null })
  }

  private onResponse(attempt: InFlightAttempt, data: string | null, failure: string | null): void {
    //+_+// 이미 포기한 회차다. 프레임으로 채택하지 않는다. 다음 회차의 결과로 섞이지 않는다
    if (this.isAbandoned(attempt)) {
      //+_+// 늦은 도착은 마감 타이머가 실제로 끝난 뒤에 온 응답만이다
      //+_+// 탭이 닫혀 마감 전에 정리된 회차는 여기에 넣지 않는다. r2a 에서 lateByMs 가 음수로 나왔다
      //+_+// lateByMs 를 마감 시각에서 재므로 구조적으로 음수가 될 수 없다
      if (attempt.timedOutAt !== null) {
        const now = this.clock.now()
        this.lateArrivalLog.push({
          tileId: attempt.tileId,
          tabId: attempt.tabId,
          attemptToken: attempt.token,
          attemptIndex: attempt.attemptIndex,
          startedAt: attempt.startedAt,
          roundDurationMs: now - attempt.startedAt,
          lateByMs: now - attempt.timedOutAt,
          settledAs: data === null ? 'failure' : 'success',
        })
      }
      return
    }

    if (data === null) {
      this.settle(attempt, {
        outcome: 'captureFailed',
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
        //+_+// 세션이 사라졌으면 리스를 무효화한다. 그러지 않으면 다음 회차도 재attach 하지 않는다
        //+_+// 재시도 간격과 시도 상한은 기존 backoff 계단과 시도 카운터가 그대로 맡는다
        if (isSessionLost(settled.message)) {
          this.dropSession(state)
        }
        this.applyFailure(state, now, extra.fault ?? null)
      } else {
        state.lastFrameAt = now
        state.consecutiveFailures = 0
        state.demoted = false
        state.fault = null
        //+_+// P4-D16. 예정 시각 기준이다. now 기준이면 회차 소요가 매 주기에 더해져 주기가 늘어난다
        state.appliedIntervalMs = state.baseIntervalMs
        state.nextDueAt = nextDueAtFrom(state.scheduledAt, state.baseIntervalMs, now)
      }
      //+_+// P6-D50. Pause 중에 끝난 회차다. 해제 시프트가 이 타일을 다시 밀면 시각이 미래가 된다
      if (this.pausedAt !== null) {
        this.freshWhilePaused.add(state.tileId)
      }
    }

    this.write(attempt, settled, frame)
    this.resolveOnce(attempt.tileId, frame)
    this.pump()
  }

  //+_+// detach 를 부르지 않는다. 세션은 이미 없다. 다음 회차가 ensureAttached 로 다시 붙인다
  private dropSession(state: TileState): void {
    state.holdsLease = false
    this.sessions.invalidate(state.tabId)
  }

  //+_+// 기록만 한다. 상태 갱신과 슬롯 반납은 부르는 쪽 책임이다
  private write(
    attempt: InFlightAttempt,
    settled: Pick<CaptureRecord, 'outcome' | 'bytes' | 'message'>,
    frame: CapturedFrame | null = null,
  ): void {
    const now = this.clock.now()
    const entry: CaptureRecord = {
      tileId: attempt.tileId,
      tabId: attempt.tabId,
      attemptToken: attempt.token,
      attemptIndex: attempt.attemptIndex,
      startedAt: attempt.startedAt,
      calledAt: attempt.calledAt,
      roundDurationMs: now - attempt.startedAt,
      callDurationMs: attempt.calledAt === null ? null : now - attempt.calledAt,
      scheduleIntervalMs: attempt.scheduleIntervalMs,
      ...settled,
    }
    this.captureLog.push(entry)
    this.onCaptureSettled?.(entry, frame)
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
      state.appliedIntervalMs = DEGRADED_INTERVAL_MS
      state.nextDueAt = now + DEGRADED_INTERVAL_MS
      return
    }
    state.demoted = false
    state.appliedIntervalMs = nextDelayMs(state.consecutiveFailures, state.baseIntervalMs)
    state.nextDueAt = now + state.appliedIntervalMs
  }

  //+_+// 세션이 끊기면 다음 캡처에서 다시 붙인다. 그 사이에 무한 retry 를 돌리지 않는다
  private applyDetach(event: DetachEventRecord): void {
    for (const state of this.tiles.values()) {
      if (state.tabId !== event.tabId) {
        continue
      }
      state.holdsLease = false
      state.fault = tileStatusForDebuggerError(event.errorCode)
    }
  }
}
