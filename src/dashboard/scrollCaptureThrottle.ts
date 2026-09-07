import type { WebTile } from '../shared/types'

//+_+// P10-D18 의 캡처 케이던스 판정이다. chrome.* 도 타이머도 이 파일 안에 없다 (P10-D22)
//+_+// §8-5.3. 사이트마다 다를 것이 거의 확실해 조정 가능한 자리에 둔다. Settings UI 는 만들지 않는다 (§8-5.4)
export const MIN_CAPTURE_INTERVAL_MS = 1100

//+_+// TASK-P12-06 (S4). P12-D20. tileIntervalMs · tileCaptureTimeoutMs 와 같은 자리다.
//+_+// 미지정이면 이 파일의 기본값(MIN_CAPTURE_INTERVAL_MS)을 쓴다. 소비처(TileCard)가 하나뿐이라
//+_+// scheduler.ts 가 아니라 여기 둔다 -- 하한·상한 검증 함수만 shared 층(scheduler.ts)에 있다
export function tileScrollCaptureIntervalMs(tile: WebTile): number {
  return tile.scrollCaptureIntervalOverrideMs ?? MIN_CAPTURE_INTERVAL_MS
}

//+_+// lastRequestedAt 은 캡처를 요청한 시각이다. 응답이 도착한 시각이 아니다
export interface ScrollCaptureThrottleState {
  lastRequestedAt: number | null
  inFlight: boolean
  pending: boolean
}

export const INITIAL_SCROLL_CAPTURE_THROTTLE_STATE: ScrollCaptureThrottleState = {
  lastRequestedAt: null,
  inFlight: false,
  pending: false,
}

//+_+// 전부 순수 함수다. 입력 상태를 변형하지 않고 새 상태를 반환한다
export function onWheel(state: ScrollCaptureThrottleState): ScrollCaptureThrottleState {
  return { ...state, pending: true }
}

export function onSettled(state: ScrollCaptureThrottleState): ScrollCaptureThrottleState {
  return { ...state, inFlight: false }
}

//+_+// P10-D18 "진행 중이면 건너뛴다".  lastRequestedAt 이 없으면 첫 휠이므로 간격을 안 본다
export function shouldCapture(
  state: ScrollCaptureThrottleState,
  now: number,
  minMs: number,
): boolean {
  return (
    !state.inFlight &&
    state.pending &&
    (state.lastRequestedAt === null || now - state.lastRequestedAt >= minMs)
  )
}

export function onCaptureRequested(
  state: ScrollCaptureThrottleState,
  now: number,
): ScrollCaptureThrottleState {
  return { ...state, inFlight: true, pending: false, lastRequestedAt: now }
}
