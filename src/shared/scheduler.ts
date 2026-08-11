import type { WebTile } from './types'

//+_+// 전부 잠정값이다. L4 미해소 상태이므로 Phase 3 진입 전 재확인 대상이다. 한 곳에서만 정의한다
export const CAPTURE_INTERVAL_MS = {
  spanLarge: 2000,
  spanMedium: 2500,
  spanSmall: 4000,
  dashboardHidden: 45000,
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
//+_+// dashboardHidden 과 값이 같으나 정책이 다르다. 리터럴을 공유하지 않는다
//+_+// hidden 정책이 Pause 로 바뀌어도(L17) 이 값은 따라 움직이지 않는다
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

//+_+// hidden 은 타일 값을 무시하는 별도 정책이다. v1 section 6 line 414~417
export function effectiveIntervalMs(tile: WebTile, dashboardVisible: boolean): number {
  if (!dashboardVisible) {
    return CAPTURE_INTERVAL_MS.dashboardHidden
  }
  return tile.refreshIntervalMs
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

//+_+// 마지막 계단에서 고정한다. 무한히 커지지 않는다. 성공 시 원래 주기로 복귀한다
export function nextDelayMs(consecutiveFailures: number, baseIntervalMs: number): number {
  if (consecutiveFailures <= 0) {
    return baseIntervalMs
  }
  const step = Math.min(consecutiveFailures, BACKOFF_STEPS_MS.length) - 1
  return BACKOFF_STEPS_MS[step]
}
