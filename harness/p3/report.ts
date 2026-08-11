import type { CaptureStats } from '../../src/shared/scheduler'

//+_+// 버릴 코드다. 제품에 남기지 않는다

export const FRAME_HASH_BASIS = 'fnv1a over base64 payload'

export interface CaptureRow {
  tileId: string
  tabId: number
  attemptIndex: number
  startedAt: number
  calledAt: number | null
  roundDurationMs: number
  callDurationMs: number | null
  outcome: string
  bytes: number | null
  frameHash: string | null
  pageEnableSent: boolean
  message: string | null
}

export interface LateArrivalRow {
  tileId: string
  tabId: number
  attemptIndex: number
  lateByMs: number
  roundDurationMs: number
  settledAs: string
}

export interface AttachStageRow {
  //+_+// 숫자는 단계별 시험이고 runtime 은 캡처가 부른 attach 다
  stage: number | 'runtime'
  requested: number
  ok: number
  fail: number
  errors: string[]
}

export interface DetachEventRow {
  at: string
  tabId: number
  reason: string
  errorCode: string
}

export interface InjectionRow {
  at: string
  name: string
  outcome: string
  detail: string
}

export interface ReencodeResult {
  path: 'worker' | 'document' | 'failed'
  sourceFormat: string
  sourceBytes: number
  q70Bytes: number | null
  q85Bytes: number | null
  error: string | null
}

export interface ProbeResult {
  offscreenCanvas: boolean
  offscreenCanvasError: string | null
  createImageBitmap: boolean
  createImageBitmapError: string | null
  createObjectURL: boolean
}

export interface PortLogRow {
  at: string
  event: 'connect' | 'disconnect'
}

export interface ReportInput {
  chromeFullVersion: string
  round: string
  measuredAt: string
  reportSavedAt: string
  harnessCommit: string | null
  captures: CaptureRow[]
  lateArrivals: LateArrivalRow[]
  attach: AttachStageRow[]
  detachEvents: DetachEventRow[]
  injections: InjectionRow[]
  reencode: ReencodeResult | null
  swStarts: string[]
  portLog: PortLogRow[]
  environment: ProbeResult | null
  userObservations: Record<string, string>
  idleTransition: string | null
}

export interface HarnessReport {
  meta: {
    chromeFullVersion: string
    round: string
    measuredAt: string
    reportSavedAt: string
    harnessCommit?: string
  }
  frameHashBasis: string
  capture: CaptureRow[]
  lateArrivals: LateArrivalRow[]
  stats: CaptureStats
  attach: AttachStageRow[]
  detachEvents: DetachEventRow[]
  injections: InjectionRow[]
  reencode: ReencodeResult | null
  swStarts: string[]
  portLog: PortLogRow[]
  environment: ProbeResult | null
  userObservations: Record<string, string>
  idleTransition: string | null
}

//+_+// POC 가 쓴 것과 같은 fnv1a 다. 픽셀 해시가 아니므로 basis 를 리포트에 남긴다
export function fnv1a(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

//+_+// 성공 회차만 지속시간 표본에 넣는다. 타임아웃은 상수 5000 이라 분포를 오염시킨다
export function durationSamples(captures: readonly CaptureRow[]): {
  round: number[]
  call: number[]
} {
  const success = captures.filter((row) => row.outcome === 'success')
  return {
    round: success.map((row) => row.roundDurationMs),
    call: success
      .map((row) => row.callDurationMs)
      .filter((value): value is number => value !== null),
  }
}

export function countOutcomes(captures: readonly CaptureRow[]): {
  attempts: number
  successes: number
  timeouts: number
} {
  return {
    attempts: captures.length,
    successes: captures.filter((row) => row.outcome === 'success').length,
    timeouts: captures.filter((row) => row.outcome === 'timeout').length,
  }
}

//+_+// harnessCommit 은 값이 있을 때만 필드를 만든다. 빈 문자열을 넣지 않는다
export function buildReport(
  input: ReportInput,
  statsOf: (args: {
    roundDurationsMs: number[]
    callDurationsMs: number[]
    attempts: number
    successes: number
    timeouts: number
    lateArrivals: number
  }) => CaptureStats,
): HarnessReport {
  const samples = durationSamples(input.captures)
  const counts = countOutcomes(input.captures)

  return {
    meta: {
      chromeFullVersion: input.chromeFullVersion,
      round: input.round,
      measuredAt: input.measuredAt,
      reportSavedAt: input.reportSavedAt,
      ...(input.harnessCommit === null ? {} : { harnessCommit: input.harnessCommit }),
    },
    frameHashBasis: FRAME_HASH_BASIS,
    capture: input.captures,
    lateArrivals: input.lateArrivals,
    stats: statsOf({
      roundDurationsMs: samples.round,
      callDurationsMs: samples.call,
      attempts: counts.attempts,
      successes: counts.successes,
      timeouts: counts.timeouts,
      lateArrivals: input.lateArrivals.length,
    }),
    attach: input.attach,
    detachEvents: input.detachEvents,
    injections: input.injections,
    reencode: input.reencode,
    swStarts: input.swStarts,
    portLog: input.portLog,
    environment: input.environment,
    userObservations: input.userObservations,
    idleTransition: input.idleTransition,
  }
}

//+_+// P3-D15. 클립보드를 경유하지 않는다
export function reportFileName(round: string): string {
  const safe = round.trim().replace(/[^A-Za-z0-9_-]+/g, '-') || 'unnamed'
  return `phase3-report-${safe}.json`
}
