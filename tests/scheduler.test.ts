import { describe, expect, it } from 'vitest'
import {
  BACKOFF_STEPS_MS,
  CAPTURE_INTERVAL_MS,
  CAPTURE_TIMEOUT_MS,
  DEGRADED_INTERVAL_MS,
  MAX_CONCURRENT_CAPTURES,
  STALE_AFTER_MULTIPLIER,
  canEnqueue,
  defaultRefreshIntervalMs,
  effectiveIntervalMs,
  nextDelayMs,
  nextDueAtFrom,
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

describe('TASK-P3-01 item 03 - the constants added after the original six', () => {
  it('caps a single capture call at 5000 ms', () => {
    expect(CAPTURE_TIMEOUT_MS).toBe(5000)
  })

  it('declares a tile stale after three missed intervals', () => {
    expect(STALE_AFTER_MULTIPLIER).toBe(3)
  })

  //+_+// D7. dashboardHidden 과 값은 같으나 정책이 다르다. 리터럴을 공유하지 않는다
  it('names the degraded interval separately from the hidden dashboard interval', () => {
    expect(DEGRADED_INTERVAL_MS).toBe(45000)
    expect(CAPTURE_INTERVAL_MS.dashboardHidden).toBe(45000)
  })

  //+_+// L13 갱신은 기존 6개를 유지하라고 판정했다. 신설은 2개뿐이다
  it('leaves the six existing constants untouched', () => {
    expect(CAPTURE_INTERVAL_MS.spanLarge).toBe(2000)
    expect(CAPTURE_INTERVAL_MS.spanMedium).toBe(2500)
    expect(CAPTURE_INTERVAL_MS.spanSmall).toBe(4000)
    expect(CAPTURE_INTERVAL_MS.dashboardHidden).toBe(45000)
    expect(MAX_CONCURRENT_CAPTURES).toBe(2)
    expect(BACKOFF_STEPS_MS).toEqual([2000, 5000, 15000, 30000])
  })

  //+_+// 성공 캡처가 간헐적으로 1~2초다. 타임아웃이 정상 캡처를 자르면 안 된다
  //+_+// 미반환 호출은 30000 에서도 돌아오지 않았다. 5000 은 그 관측과 뚜렷이 구분된다
  it('sits above the observed slow success band and far below the 30000 ms that never returned', () => {
    expect(CAPTURE_TIMEOUT_MS).toBeGreaterThan(2000)
    expect(CAPTURE_TIMEOUT_MS).toBeLessThan(30000)
  })
})

describe('P4-D16 - the next due time is relative to the scheduled time', () => {
  it('adds the interval to the scheduled time, not to the settle time', () => {
    expect(nextDueAtFrom(0, 2000, 100)).toBe(2000)
    expect(nextDueAtFrom(0, 2000, 1999)).toBe(2000)
    expect(nextDueAtFrom(4000, 4000, 4100)).toBe(8000)
  })

  //+_+// 회차가 주기보다 길었다. 지나간 만기를 쌓지 않고 다음 배수로 건너뛴다
  it('skips the missed due times instead of queueing them', () => {
    expect(nextDueAtFrom(0, 2000, 2018)).toBe(4000)
    expect(nextDueAtFrom(0, 2000, 4000)).toBe(6000)
    expect(nextDueAtFrom(0, 2000, 9500)).toBe(10000)
  })

  //+_+// 어떤 경우에도 다음 만기는 지금보다 뒤다. 그래서 매 tick 실행으로 떨어지지 않는다
  it('never returns a due time that is already past', () => {
    for (const now of [0, 1, 999, 2000, 2001, 5000, 12345]) {
      expect(nextDueAtFrom(0, 2000, now)).toBeGreaterThan(now)
    }
  })

  //+_+// 실현 주기는 배정 주기의 배수다. 드리프트가 누적되지 않는다
  it('keeps every due time on the multiple of the interval', () => {
    let due = 0
    for (let round = 0; round < 5; round += 1) {
      due = nextDueAtFrom(due, 2000, due + 2018)
    }
    expect(due).toBe(20000)
  })
})
