import type { TileStatus } from '../shared/types'

//+_+// v1 section 21 line 1201~1213 의 이름을 그대로 쓴다. 캡처 자체의 실패는 이 모듈이 내지 않는다
export type DebuggerErrorCode =
  | 'DEBUGGER_ATTACH_FAILED'
  | 'DEBUGGER_DETACHED'
  | 'DEVTOOLS_CONFLICT'
  | 'TAB_NOT_FOUND'
  | 'TAB_CLOSED'
  | 'RESTRICTED_URL'

//+_+// v1 section 12 가 정한 값이다. 회차를 넘어 탭 단위로 누적하고 성공하면 0 으로 돌아간다
export const MAX_ATTACH_ATTEMPTS = 3

//+_+// 비워 둔다. onDetach 의 reason 문자열은 아직 관측되지 않았다
//+_+// chrome 타입 선언은 canceled_by_user 와 target_closed 둘만 적지만 그것을 근거로 삼지 않는다
//+_+// 관측 후 이 목록을 채운다. 그때까지 모든 reason 은 DEBUGGER_DETACHED 로 간다
export const DEVTOOLS_DETACH_REASONS: readonly string[] = []

//+_+// chrome.debugger 를 직접 부르지 않는다. 어댑터는 serviceWorker 가 주입한다
export interface DebuggerBackend {
  attach(tabId: number): Promise<void>
  detach(tabId: number): Promise<void>
  sendCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>
  onDetach(listener: (tabId: number, reason: string) => void): void
}

//+_+// L24 재발 방지. 실패 1건마다 원문 문자열을 남긴다. 요약하지 않는다
export interface AttachFailureRecord {
  tabId: number
  attempt: number
  message: string
}

export interface DetachEventRecord {
  tabId: number
  reason: string
  errorCode: DebuggerErrorCode
}

export interface DetachFailureRecord {
  tabId: number
  message: string
}

//+_+// exhausted 는 누적 시도가 MAX_ATTACH_ATTEMPTS 에 닿았다는 뜻이다. 그때만 ERROR 로 간다
export type AttachResult =
  | { ok: true; reused: boolean }
  | {
      ok: false
      errorCode: DebuggerErrorCode
      message: string
      attempts: number
      exhausted: boolean
    }

export interface DebuggerSessionManagerOptions {
  devtoolsDetachReasons?: readonly string[]
}

//+_+// Error 가 아닌 값으로 reject 되어도 문자열을 잃지 않는다
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

//+_+// 관측 전이므로 reason 을 문자열 매칭으로 추측하지 않는다. 목록에 있는 것만 DevTools 로 본다
export function classifyDetachReason(
  reason: string,
  devtoolsReasons: readonly string[],
): DebuggerErrorCode {
  return devtoolsReasons.includes(reason) ? 'DEVTOOLS_CONFLICT' : 'DEBUGGER_DETACHED'
}

//+_+// TASK-P3-01 section 3.4 의 전이표다. 캡처 실패와 타임아웃은 여기에 오지 않는다
export function tileStatusForDebuggerError(code: DebuggerErrorCode): TileStatus {
  switch (code) {
    case 'DEVTOOLS_CONFLICT':
      return 'DEVTOOLS'
    case 'DEBUGGER_DETACHED':
    case 'TAB_NOT_FOUND':
    case 'TAB_CLOSED':
      return 'DETACHED'
    case 'DEBUGGER_ATTACH_FAILED':
    case 'RESTRICTED_URL':
      return 'ERROR'
  }
}

//+_+// lease 다. 같은 탭에 두 번 attach 하지 않고 참조 카운트가 0 일 때만 detach 한다
export class DebuggerSessionManager {
  private readonly backend: DebuggerBackend
  private readonly devtoolsDetachReasons: readonly string[]
  private readonly leases = new Map<number, number>()
  private readonly attachAttempts = new Map<number, number>()
  private readonly attachFailureLog: AttachFailureRecord[] = []
  private readonly detachEventLog: DetachEventRecord[] = []
  private readonly detachFailureLog: DetachFailureRecord[] = []
  private readonly detachListeners: ((event: DetachEventRecord) => void)[] = []

  constructor(backend: DebuggerBackend, options: DebuggerSessionManagerOptions = {}) {
    this.backend = backend
    this.devtoolsDetachReasons = options.devtoolsDetachReasons ?? DEVTOOLS_DETACH_REASONS
    this.backend.onDetach((tabId, reason) => {
      this.handleDetach(tabId, reason)
    })
  }

  get attachFailures(): readonly AttachFailureRecord[] {
    return this.attachFailureLog
  }

  get detachEvents(): readonly DetachEventRecord[] {
    return this.detachEventLog
  }

  get detachFailures(): readonly DetachFailureRecord[] {
    return this.detachFailureLog
  }

  //+_+// 분류된 detach 를 한 곳에서만 만든다. 구독자는 reason 을 다시 해석하지 않는다
  addDetachListener(listener: (event: DetachEventRecord) => void): void {
    this.detachListeners.push(listener)
  }

  isAttached(tabId: number): boolean {
    return this.leases.has(tabId)
  }

  refCount(tabId: number): number {
    return this.leases.get(tabId) ?? 0
  }

  //+_+// 이미 붙어 있으면 attach 를 다시 부르지 않는다. L24 의 유력한 설명이 중복 attach 였다
  //+_+// 한 회차에 한 번만 시도한다. 여기서 재우면 슬롯이 CAPTURE_TIMEOUT_MS 를 넘겨 잡힌다. D6
  //+_+// 시도 사이의 간격은 호출자의 캡처 backoff 계단이 만든다
  async ensureAttached(tabId: number): Promise<AttachResult> {
    const held = this.leases.get(tabId)
    if (held !== undefined) {
      this.leases.set(tabId, held + 1)
      return { ok: true, reused: true }
    }

    const attempt = (this.attachAttempts.get(tabId) ?? 0) + 1
    this.attachAttempts.set(tabId, attempt)

    try {
      await this.backend.attach(tabId)
      this.attachAttempts.delete(tabId)
      this.leases.set(tabId, 1)
      return { ok: true, reused: false }
    } catch (error) {
      const message = errorMessage(error)
      this.attachFailureLog.push({ tabId, attempt, message })
      return {
        ok: false,
        errorCode: 'DEBUGGER_ATTACH_FAILED',
        message,
        attempts: attempt,
        exhausted: attempt >= MAX_ATTACH_ATTEMPTS,
      }
    }
  }

  //+_+// detach 실패는 삼킨다. 세션은 어차피 놓는다. 기록만 남긴다
  async release(tabId: number): Promise<void> {
    const held = this.leases.get(tabId)
    if (held === undefined) {
      return
    }
    if (held > 1) {
      this.leases.set(tabId, held - 1)
      return
    }

    this.leases.delete(tabId)
    try {
      await this.backend.detach(tabId)
    } catch (error) {
      this.detachFailureLog.push({ tabId, message: errorMessage(error) })
    }
  }

  //+_+// reason 원문을 그대로 남긴다. 분류는 관측 후에 확정한다
  private handleDetach(tabId: number, reason: string): void {
    const event: DetachEventRecord = {
      tabId,
      reason,
      errorCode: classifyDetachReason(reason, this.devtoolsDetachReasons),
    }
    this.detachEventLog.push(event)
    this.leases.delete(tabId)
    for (const listener of this.detachListeners) {
      listener(event)
    }
  }
}
