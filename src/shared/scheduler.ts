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
