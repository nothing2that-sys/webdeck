import type { WebTile } from './types'

//+_+// 전부 잠정값이다. L4 미해소 상태이므로 Phase 3 진입 전 재확인 대상이다. 한 곳에서만 정의한다
export const CAPTURE_INTERVAL_MS = {
  spanLarge: 2000,
  spanMedium: 2500,
  spanSmall: 4000,
} as const

export const MAX_CONCURRENT_CAPTURES = 2

export const BACKOFF_STEPS_MS = [2000, 5000, 15000, 30000] as const

//+_+// 7번째 상수. 잠정값이다. v1 section 6 / 6.1 에 근거가 없다. L13 갱신이 필요하다고 판정했다
//+_+// L21 이 반환되지 않는 호출을 관측했다. 슬롯 2개가 그런 호출에 잠기면 큐가 영구히 막힌다
//+_+// 성공 캡처는 간헐적으로 1~2초, 페인트 대기는 763~1004ms 다. 5000 은 그보다 충분히 크다
//+_+// 미반환 호출은 timeout30000 에서도 돌아오지 않았다. 5초와 미반환은 구분된다
export const CAPTURE_TIMEOUT_MS = 5000

//+_+// 8번째 상수. 잠정값이다. v1 section 15.2 line 914 는 "일정 시간 이상"만 정하고 값을 정하지 않았다
//+_+// 타일마다 주기가 다르므로 절대값을 쓸 수 없다. 마지막 성공 이후 주기의 배수로 판정한다
export const STALE_AFTER_MULTIPLIER = 3

//+_+// 9번째 상수. 잠정값이다. backoff 4단을 소진한 타일의 강등 주기다
//+_+// P6-D43. hidden 정책이 Pause 가 된 뒤에도 이 값은 남는다. 강등은 실패의 결과이지 표시 상태가 아니다
export const DEGRADED_INTERVAL_MS = 45000

export interface CaptureQueueItem {
  tileId: string
  tabId: number
}

//+_+// v1 section 6 line 408~412 의 세 구간이다. 1x3 이상을 spanMedium 에 넣는 것은 보간이다
export function defaultRefreshIntervalMs(w: number, h: number): number {
  if (Math.min(w, h) >= 2) {
    return CAPTURE_INTERVAL_MS.spanLarge
  }
  if (Math.max(w, h) >= 2) {
    return CAPTURE_INTERVAL_MS.spanMedium
  }
  return CAPTURE_INTERVAL_MS.spanSmall
}

//+_+// P5-D26. 사용자 지정 주기의 하한이다. serviceWorker 의 DRIVER_TICK_MS 와 같은 값이어야 한다
//+_+// 구동자 격자보다 짧은 주기는 표현할 수 없다. L32 가 "주기 < 250 은 tick 하한" 으로 서술한다
//+_+// 두 값이 어긋나는지는 시험이 지킨다. 구동자 상수를 여기로 옮기지 않는다. 층이 다르다
export const MIN_TILE_INTERVAL_MS = 250

//+_+// 저장 경로와 SET_TILE_SETTINGS 가 같은 판정을 써야 한다. 규칙을 두 곳에 두지 않는다
export function isValidIntervalOverride(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_TILE_INTERVAL_MS
}

//+_+// P5-D16. 사용자 지정값이 span 자동 배정을 이긴다. P5-D21 이 별도 필드로 정했다
export function tileIntervalMs(tile: WebTile): number {
  return tile.refreshIntervalOverrideMs ?? tile.refreshIntervalMs
}

//+_+// TASK-P12-04 (S2). P12-D15. 하한은 페인트 대기(L13 의 TASK-P3-PRE-02 갱신, 763~1004ms)보다
//+_+// 짧으면 정상 캡처를 죽인다. 상한은 잠정 방어값이다 -- 슬롯이 둘뿐이라(MAX_CONCURRENT_CAPTURES)
//+_+// 한 타일이 그보다 오래 슬롯을 물면 대시보드 전체가 밀린다. 실측 근거는 없다
export const MIN_CAPTURE_TIMEOUT_OVERRIDE_MS = 1000
export const MAX_CAPTURE_TIMEOUT_OVERRIDE_MS = 10000

//+_+// refreshIntervalOverrideMs 의 isValidIntervalOverride 와 같은 자리·같은 판정 방식이다
//+_+// 상한이 있다는 것만 다르다 -- 주기는 길어도 되지만 타임아웃은 길면 슬롯을 오래 문다
export function isValidCaptureTimeoutOverride(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_CAPTURE_TIMEOUT_OVERRIDE_MS &&
    value <= MAX_CAPTURE_TIMEOUT_OVERRIDE_MS
  )
}

//+_+// tileIntervalMs 와 같은 자리다. 미지정이면 전역 기본값(CAPTURE_TIMEOUT_MS)을 쓴다. P12-D14
export function tileCaptureTimeoutMs(tile: WebTile): number {
  return tile.captureTimeoutOverrideMs ?? CAPTURE_TIMEOUT_MS
}

//+_+// TASK-P12-06 (S4). P12-D21. 상한만 새로 정의한다 -- 하한은 MIN_TILE_INTERVAL_MS 를 그대로
//+_+// 쓴다. "캡처 요청이 나가는 최소 간격" 이라는 같은 성격이라 새 하한 상수를 따로 만들지 않는다
//+_+// storage.ts(shared 층)가 검증에 써야 해서 scrollCaptureThrottle.ts(dashboard 층)가 아니라
//+_+// 여기 둔다 -- shared 가 dashboard 를 참조하면 층이 거꾸로 된다
export const MAX_SCROLL_CAPTURE_INTERVAL_OVERRIDE_MS = 3000

export function isValidScrollCaptureIntervalOverride(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TILE_INTERVAL_MS &&
    value <= MAX_SCROLL_CAPTURE_INTERVAL_OVERRIDE_MS
  )
}

//+_+// 탭 단위로 판정한다. v1 section 6.1 line 451 이 동일 탭 중복 투입을 금지한다
export function canEnqueue(
  item: CaptureQueueItem,
  inFlight: readonly CaptureQueueItem[],
  queued: readonly CaptureQueueItem[],
): boolean {
  const collides = (other: CaptureQueueItem): boolean =>
    other.tileId === item.tileId || other.tabId === item.tabId

  return !inFlight.some(collides) && !queued.some(collides)
}

//+_+// 회차 소요와 호출 소요를 합치지 않는다. 서로 다른 값이다. P3-D9
export interface DurationPercentiles {
  p50: number | null
  p95: number | null
}

//+_+// 기록 전용이다. 스케줄 결정은 이 값을 입력으로 받지 않는다
//+_+// average 를 계산하지도 노출하지도 않는다. 분포가 이봉형이라 평균이 대표값이 아니다. L22
//+_+// 비율에는 분모의 원시 개수를 같이 싣는다. 모든 비율이 재계산 가능해야 한다. P3-D10
export interface CaptureStats {
  attempts: number
  successes: number
  timeouts: number
  lateArrivals: number
  roundDuration: DurationPercentiles
  callDuration: DurationPercentiles
  //+_+// 분모가 0 이면 null 이다. "비율 없음"과 "비율 0" 은 다르다
  timeoutRate: number | null
  lateArrivalRate: number | null
  //+_+// JSON 에 주석을 달 수 없으므로 분모를 데이터로 싣는다
  rateDenominators: { timeoutRate: 'attempts'; lateArrivalRate: 'timeouts' }
}

export interface CaptureStatsInput {
  roundDurationsMs: readonly number[]
  callDurationsMs: readonly number[]
  attempts: number
  successes: number
  timeouts: number
  lateArrivals: number
}

//+_+// nearest-rank 다. 보간하지 않는다. 보간값은 관측되지 않은 수를 만든다
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null
  }
  const rank = Math.min(Math.max(Math.ceil(fraction * sorted.length), 1), sorted.length)
  return sorted[rank - 1]
}

function percentilesOf(values: readonly number[]): DurationPercentiles {
  const sorted = [...values].sort((a, b) => a - b)
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) }
}

export function captureStats(input: CaptureStatsInput): CaptureStats {
  return {
    attempts: input.attempts,
    successes: input.successes,
    timeouts: input.timeouts,
    lateArrivals: input.lateArrivals,
    roundDuration: percentilesOf(input.roundDurationsMs),
    callDuration: percentilesOf(input.callDurationsMs),
    timeoutRate: input.attempts === 0 ? null : input.timeouts / input.attempts,
    //+_+// 분모는 타임아웃 수다. 포기한 호출이 나중에라도 돌아왔는지를 본다. L21 의 질문이다
    //+_+// 타임아웃이 0 이면 늦은 도착률은 정의되지 않는다. 0 으로 적으면 관측했다는 뜻이 된다
    lateArrivalRate: input.timeouts === 0 ? null : input.lateArrivals / input.timeouts,
    rateDenominators: { timeoutRate: 'attempts', lateArrivalRate: 'timeouts' },
  }
}

//+_+// P4-D16. 다음 만기는 예정 시각 기준이다. 정산 시각 기준이면 회차 소요가 매 주기에 더해진다
//+_+// 회차가 주기보다 길어 만기가 이미 지났으면 지나간 만기를 쌓지 않고 한 번에 건너뛴다
//+_+// 그래서 밀린 만기가 누적되지 않고 매 tick 실행으로 떨어지지도 않는다. 실현 주기는 주기의 배수다
export function nextDueAtFrom(scheduledAt: number, intervalMs: number, now: number): number {
  const next = scheduledAt + intervalMs
  if (next > now) {
    return next
  }
  const missed = Math.floor((now - scheduledAt) / intervalMs)
  return scheduledAt + (missed + 1) * intervalMs
}

//+_+// 마지막 계단에서 고정한다. 무한히 커지지 않는다. 성공 시 원래 주기로 복귀한다
export function nextDelayMs(consecutiveFailures: number, baseIntervalMs: number): number {
  if (consecutiveFailures <= 0) {
    return baseIntervalMs
  }
  const step = Math.min(consecutiveFailures, BACKOFF_STEPS_MS.length) - 1
  return BACKOFF_STEPS_MS[step]
}
