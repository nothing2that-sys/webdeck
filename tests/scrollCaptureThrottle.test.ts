import { describe, expect, it } from 'vitest'
import {
  INITIAL_SCROLL_CAPTURE_THROTTLE_STATE,
  MIN_CAPTURE_INTERVAL_MS,
  onCaptureRequested,
  onSettled,
  onWheel,
  shouldCapture,
} from '../src/dashboard/scrollCaptureThrottle'
import type { ScrollCaptureThrottleState } from '../src/dashboard/scrollCaptureThrottle'

const MIN_MS = MIN_CAPTURE_INTERVAL_MS

describe('P10-D18 - scroll capture throttle', () => {
  it('does not capture when pending is false', () => {
    const state: ScrollCaptureThrottleState = {
      lastRequestedAt: 0,
      inFlight: false,
      pending: false,
    }
    expect(shouldCapture(state, 100_000, MIN_MS)).toBe(false)
  })

  it('does not capture while a request is in flight, even past the interval', () => {
    const state: ScrollCaptureThrottleState = {
      lastRequestedAt: 0,
      inFlight: true,
      pending: true,
    }
    expect(shouldCapture(state, 100_000, MIN_MS)).toBe(false)
  })

  it('captures immediately on the first wheel (lastRequestedAt is null)', () => {
    const state = onWheel(INITIAL_SCROLL_CAPTURE_THROTTLE_STATE)
    expect(shouldCapture(state, 0, MIN_MS)).toBe(true)
  })

  it('holds at the boundary - 1099ms does not capture, 1100ms does', () => {
    const state: ScrollCaptureThrottleState = {
      lastRequestedAt: 1000,
      inFlight: false,
      pending: true,
    }
    expect(shouldCapture(state, 1000 + 1099, MIN_MS)).toBe(false)
    expect(shouldCapture(state, 1000 + 1100, MIN_MS)).toBe(true)
  })

  it('clears pending after a request; a later wheel sets it true again', () => {
    const requested = onCaptureRequested(
      { lastRequestedAt: null, inFlight: false, pending: true },
      1000,
    )
    expect(requested.pending).toBe(false)

    const wheeledAgain = onWheel(requested)
    expect(wheeledAgain.pending).toBe(true)
  })

  it('onSettled alone does not make it capture again - pending and interval both matter', () => {
    const settled = onSettled({ lastRequestedAt: 1000, inFlight: true, pending: false })
    expect(shouldCapture(settled, 1000 + MIN_MS, MIN_MS)).toBe(false)
  })

  it('transition functions do not mutate their input state', () => {
    const state: ScrollCaptureThrottleState = {
      lastRequestedAt: 0,
      inFlight: true,
      pending: false,
    }
    const frozen = Object.freeze({ ...state })

    expect(() => onWheel(frozen)).not.toThrow()
    expect(() => onSettled(frozen)).not.toThrow()
    expect(() => onCaptureRequested(frozen, 500)).not.toThrow()
    expect(frozen).toEqual({ lastRequestedAt: 0, inFlight: true, pending: false })
  })
})
