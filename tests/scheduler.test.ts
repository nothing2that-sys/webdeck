import { describe, expect, it } from 'vitest'
import {
  MAX_CONCURRENT_CAPTURES,
  canEnqueue,
  defaultRefreshIntervalMs,
  effectiveIntervalMs,
  nextDelayMs,
} from '../src/shared/scheduler'
import type { CaptureQueueItem } from '../src/shared/scheduler'
import type { WebTile } from '../src/shared/types'

function tile(w: number, h: number, refreshIntervalMs: number): WebTile {
  return {
    id: `t-${String(w)}x${String(h)}`,
    launchUrl: 'https://example.com/',
    matchMode: 'origin',
    x: 0,
    y: 0,
    w,
    h,
    refreshIntervalMs,
    fitMode: 'contain',
    keepAlive: false,
  }
}

const SPANS = [1, 2, 3, 4]

describe('v1 25.1 item 9 - scheduler priority', () => {
  it('gives a visible 2x2 tile the 2000 ms interval', () => {
    expect(defaultRefreshIntervalMs(2, 2)).toBe(2000)
  })

  it('gives visible 3x3 and 4x4 tiles the 2000 ms interval', () => {
    expect(defaultRefreshIntervalMs(3, 3)).toBe(2000)
    expect(defaultRefreshIntervalMs(4, 4)).toBe(2000)
  })

  it('gives visible 2x1 and 1x2 tiles the 2500 ms interval', () => {
    expect(defaultRefreshIntervalMs(2, 1)).toBe(2500)
    expect(defaultRefreshIntervalMs(1, 2)).toBe(2500)
  })

  it('gives a visible 1x1 tile the 4000 ms interval', () => {
    expect(defaultRefreshIntervalMs(1, 1)).toBe(4000)
  })

  it('uses the hidden dashboard interval when the dashboard is hidden', () => {
    expect(effectiveIntervalMs(tile(2, 2, 2000), false)).toBe(45000)
    expect(effectiveIntervalMs(tile(1, 1, 4000), false)).toBe(45000)
  })

  it('lets the tile refreshIntervalMs win while the dashboard is visible', () => {
    expect(effectiveIntervalMs(tile(1, 1, 10000), true)).toBe(10000)
    expect(effectiveIntervalMs(tile(4, 4, 30000), true)).toBe(30000)
  })

  it('always returns a positive integer', () => {
    for (const w of SPANS) {
      for (const h of SPANS) {
        const span = defaultRefreshIntervalMs(w, h)
        expect(Number.isInteger(span)).toBe(true)
        expect(span).toBeGreaterThan(0)

        for (const visible of [true, false]) {
          const effective = effectiveIntervalMs(tile(w, h, span), visible)
          expect(Number.isInteger(effective)).toBe(true)
          expect(effective).toBeGreaterThan(0)
        }
      }
    }
  })

  it('classifies all 16 span combinations into one of the three buckets with none left over', () => {
    const counts = new Map<number, number>()
    for (const w of SPANS) {
      for (const h of SPANS) {
        const value = defaultRefreshIntervalMs(w, h)
        counts.set(value, (counts.get(value) ?? 0) + 1)
      }
    }

    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([2000, 2500, 4000])
    expect(counts.get(2000)).toBe(9)
    expect(counts.get(2500)).toBe(6)
    expect(counts.get(4000)).toBe(1)
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBe(16)
  })
})

describe('v1 25.1 item 10 - scheduler duplicate prevention', () => {
  const a: CaptureQueueItem = { tileId: 'a', tabId: 1 }
  const b: CaptureQueueItem = { tileId: 'b', tabId: 2 }
  const c: CaptureQueueItem = { tileId: 'c', tabId: 3 }

  it('admits the same tileId only once', () => {
    expect(canEnqueue(a, [], [])).toBe(true)
    expect(canEnqueue(a, [], [a])).toBe(false)
  })

  it('rejects a tileId that is already in flight', () => {
    expect(canEnqueue(a, [a], [])).toBe(false)
  })

  it('admits the same tileId again once the capture has completed', () => {
    expect(canEnqueue(a, [a], [])).toBe(false)
    expect(canEnqueue(a, [], [])).toBe(true)
  })

  it('queues the third of three distinct items rather than rejecting it', () => {
    expect(canEnqueue(a, [], [])).toBe(true)
    expect(canEnqueue(b, [], [a])).toBe(true)
    expect(canEnqueue(c, [a, b], [])).toBe(true)
    expect(MAX_CONCURRENT_CAPTURES).toBe(2)
  })

  it('treats two different tileIds pointing at one tabId as duplicates', () => {
    const sameTab: CaptureQueueItem = { tileId: 'other', tabId: 1 }
    expect(canEnqueue(sameTab, [], [a])).toBe(false)
    expect(canEnqueue(sameTab, [a], [])).toBe(false)
  })
})

describe('v1 25.1 item 11 - capture backoff', () => {
  const base = 2000

  it('delays 2000 ms after one consecutive failure', () => {
    expect(nextDelayMs(1, base)).toBe(2000)
  })

  it('delays 5000 ms after two consecutive failures', () => {
    expect(nextDelayMs(2, base)).toBe(5000)
  })

  it('delays 15000 ms after three consecutive failures', () => {
    expect(nextDelayMs(3, base)).toBe(15000)
  })

  it('delays 30000 ms after four consecutive failures', () => {
    expect(nextDelayMs(4, base)).toBe(30000)
  })

  it('holds at 30000 ms and never grows without bound', () => {
    expect(nextDelayMs(5, base)).toBe(30000)
    expect(nextDelayMs(10, base)).toBe(30000)
    expect(nextDelayMs(100, base)).toBe(30000)
  })

  it('returns to the base interval once the failure count is zero', () => {
    expect(nextDelayMs(0, base)).toBe(base)
    expect(nextDelayMs(0, 45000)).toBe(45000)
  })

  it('returns the base interval for a negative count without throwing', () => {
    expect(() => nextDelayMs(-1, base)).not.toThrow()
    expect(nextDelayMs(-1, base)).toBe(base)
  })
})
