import { describe, expect, it } from 'vitest'
import { DebuggerSessionManager } from '../src/background/debuggerSessionManager'
import type { DebuggerBackend } from '../src/background/debuggerSessionManager'
import {
  PreviewCaptureManager,
  base64ByteLength,
  isStale,
  resolveTileStatus,
  selectDueTiles,
} from '../src/background/previewCaptureManager'
import type { Clock } from '../src/background/previewCaptureManager'

interface FakeTimer {
  at: number
  callback: () => void
  cancelled: boolean
}

//+_+// 가상 시간이다. 타임아웃과 STALE 을 실제로 기다리지 않는다
class FakeClock implements Clock {
  private current = 0
  private readonly timers: FakeTimer[] = []

  now(): number {
    return this.current
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const timer: FakeTimer = { at: this.current + delayMs, callback, cancelled: false }
    this.timers.push(timer)
    return () => {
      timer.cancelled = true
    }
  }

  advance(ms: number): void {
    const target = this.current + ms
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (due === undefined) {
        break
      }
      due.cancelled = true
      this.current = due.at
      due.callback()
    }
    this.current = target
  }
}

interface Deferred {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

class FakeCaptureBackend implements DebuggerBackend {
  readonly commands: { tabId: number; method: string }[] = []
  readonly captures: Deferred[] = []
  readonly attachRejections: unknown[] = []
  enableRejection: unknown = null
  private listener: ((tabId: number, reason: string) => void) | null = null

  attach(): Promise<void> {
    if (this.attachRejections.length > 0) {
      return Promise.reject(this.attachRejections.shift())
    }
    return Promise.resolve()
  }

  detach(): Promise<void> {
    return Promise.resolve()
  }

  sendCommand(tabId: number, method: string): Promise<unknown> {
    this.commands.push({ tabId, method })
    if (method === 'Page.enable') {
      return this.enableRejection === null
        ? Promise.resolve({})
        : Promise.reject(this.enableRejection)
    }
    return new Promise<unknown>((resolve, reject) => {
      this.captures.push({ resolve, reject })
    })
  }

  onDetach(listener: (tabId: number, reason: string) => void): void {
    this.listener = listener
  }

  fireDetach(tabId: number, reason: string): void {
    this.listener?.(tabId, reason)
  }

  get openCaptures(): number {
    return this.captures.length
  }
}

//+_+// 마이크로태스크를 비운다. 가상 시계와 무관한 실제 타이머 1회다
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function build(options: { quality?: number } = {}) {
  const backend = new FakeCaptureBackend()
  const clock = new FakeClock()
  const sessions = new DebuggerSessionManager(backend, { wait: () => Promise.resolve() })
  const manager = new PreviewCaptureManager(backend, sessions, clock, options)
  return { backend, clock, sessions, manager }
}

//+_+// 캡처 1회를 성공으로 끝낸다. 프레임 문자열은 4의 배수 길이여야 한다
async function settleCapture(
  backend: FakeCaptureBackend,
  index: number,
  data = 'AAAA',
): Promise<void> {
  backend.captures[index]?.resolve({ data })
  await flush()
}

describe('TASK-P3-01 - base64 byte length', () => {
  //+_+// 디코드하지 않는다. len / 4 * 3 에서 말미 = 개수를 뺀다
  it('returns the decoded byte count for known inputs', () => {
    expect(base64ByteLength('aGVsbG8=')).toBe(5)
    expect(base64ByteLength('aGVsbG8h')).toBe(6)
    expect(base64ByteLength('AA==')).toBe(1)
    expect(base64ByteLength('AAA=')).toBe(2)
    expect(base64ByteLength('AAAA')).toBe(3)
    expect(base64ByteLength('')).toBe(0)
  })

  it('is the decoded size, not the base64 string length', () => {
    expect(base64ByteLength('aGVsbG8=')).not.toBe('aGVsbG8='.length)
  })
})

describe('TASK-P3-01 item 10 - one queue entry per tab', () => {
  it('does not queue two tiles that point at the same tab', async () => {
    const { manager, backend } = build()
    manager.register('a', 7, 2000)
    manager.register('b', 7, 2000)

    manager.tick()
    await flush()

    expect(manager.inFlightCount).toBe(1)
    expect(manager.queueLength).toBe(0)
    expect(backend.openCaptures).toBe(1)
  })

  it('does not queue a tile that is already in flight', async () => {
    const { manager } = build()
    manager.register('a', 7, 2000)

    manager.tick()
    await flush()
    manager.tick()
    manager.tick()

    expect(manager.inFlightCount).toBe(1)
    expect(manager.queueLength).toBe(0)
  })
})

describe('TASK-P3-01 item 11 - concurrency never exceeds two', () => {
  it('starts two captures and leaves the third queued', async () => {
    const { manager, backend } = build()
    manager.register('a', 1, 2000)
    manager.register('b', 2, 2000)
    manager.register('c', 3, 2000)

    manager.tick()
    await flush()

    expect(manager.inFlightCount).toBe(2)
    expect(manager.queueLength).toBe(1)
    expect(backend.openCaptures).toBe(2)
  })

  it('starts the queued third capture once a slot frees', async () => {
    const { manager, backend } = build()
    manager.register('a', 1, 2000)
    manager.register('b', 2, 2000)
    manager.register('c', 3, 2000)

    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    expect(manager.inFlightCount).toBe(2)
    expect(manager.queueLength).toBe(0)
    expect(backend.openCaptures).toBe(3)
  })
})

describe('TASK-P3-01 item 12 - the timeout returns the slot', () => {
  it('frees the slot at 5000 ms without waiting for the response', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(1)

    clock.advance(4999)
    expect(manager.inFlightCount).toBe(1)

    clock.advance(1)
    expect(manager.inFlightCount).toBe(0)
  })

  //+_+// L21 이 지적한 잠김이다. 반환되지 않는 호출 2개가 큐를 영구히 막으면 안 된다
  it('lets a blocked queue drain after both slots time out', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)
    manager.register('b', 2, 2000)
    manager.register('c', 3, 2000)

    manager.tick()
    await flush()
    expect(manager.queueLength).toBe(1)
    expect(backend.openCaptures).toBe(2)

    clock.advance(5000)
    await flush()

    expect(backend.openCaptures).toBe(3)
    expect(manager.queueLength).toBe(0)
  })
})

describe('TASK-P3-01 item 13 - a late response is never used as a frame', () => {
  it('records a late arrival and keeps no frame', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    clock.advance(5000)
    expect(manager.inFlightCount).toBe(0)

    clock.advance(1200)
    await settleCapture(backend, 0)

    expect(manager.latestFrame('a')).toBeNull()
    expect(manager.lateArrivals).toHaveLength(1)
    expect(manager.lateArrivals[0]).toMatchObject({
      tileId: 'a',
      tabId: 1,
      startedAt: 0,
      durationMs: 6200,
      lateByMs: 1200,
      settledAs: 'success',
    })
  })

  it('does not add a second capture record for the late response', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    clock.advance(5000)
    await settleCapture(backend, 0)

    expect(manager.captureRecords).toHaveLength(1)
    expect(manager.captureRecords[0]?.outcome).toBe('timeout')
  })

  //+_+// 늦은 응답이 다음 회차의 결과로 섞이면 안 된다. 회차 토큰으로 가른다
  it('keeps the next round frame when the previous round arrives late', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    clock.advance(5000)

    clock.advance(2000)
    manager.tick()
    await flush()
    expect(backend.openCaptures).toBe(2)

    await settleCapture(backend, 1, 'BBBB')
    await settleCapture(backend, 0, 'AAAA')

    expect(manager.latestFrame('a')?.imageBase64).toBe('BBBB')
    expect(manager.lateArrivals.map((entry) => entry.attemptToken)).toEqual([1])
  })

  it('records a late failure as a late arrival too', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    clock.advance(5000)
    backend.captures[0]?.reject(new Error('target closed'))
    await flush()

    expect(manager.lateArrivals).toHaveLength(1)
    expect(manager.lateArrivals[0]?.settledAs).toBe('failure')
  })
})

describe('TASK-P3-01 item 14 - a timeout counts as a failure and enters backoff', () => {
  it('waits the first backoff step before the next attempt', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 4000)

    manager.tick()
    await flush()
    clock.advance(5000)

    clock.advance(1999)
    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(0)

    clock.advance(1)
    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(1)
  })

  it('moves to the second backoff step after a second timeout', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 4000)

    manager.tick()
    await flush()
    clock.advance(5000)
    clock.advance(2000)
    manager.tick()
    await flush()
    clock.advance(5000)

    clock.advance(4999)
    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(0)

    clock.advance(1)
    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(1)
  })
})

describe('TASK-P3-01 item 15 - success returns to the base interval', () => {
  it('uses the base interval again after one failure and one success', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 4000)

    manager.tick()
    await flush()
    clock.advance(5000)

    clock.advance(2000)
    manager.tick()
    await flush()
    await settleCapture(backend, 1)

    clock.advance(3999)
    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(0)

    clock.advance(1)
    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(1)
  })
})

describe('TASK-P3-01 item 16 - demotion to 45000 keeps retrying', () => {
  async function failFiveTimes(manager: PreviewCaptureManager, clock: FakeClock): Promise<void> {
    const steps = [0, 2000, 5000, 15000, 30000]
    for (const step of steps) {
      clock.advance(step)
      manager.tick()
      await flush()
      clock.advance(5000)
    }
  }

  it('demotes the interval to 45000 after the four steps are spent', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000)

    await failFiveTimes(manager, clock)

    clock.advance(44999)
    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(0)

    clock.advance(1)
    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(1)
  })

  it('keeps attempting rather than giving the tile up', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000)

    await failFiveTimes(manager, clock)
    const before = manager.captureRecords.length

    clock.advance(45000)
    manager.tick()
    await flush()

    expect(before).toBe(5)
    expect(manager.inFlightCount).toBe(1)
  })

  //+_+// 강등은 실패의 결과다. 그것 때문에 STALE 판정이 늦어지면 실패를 숨긴다
  it('still judges staleness by the pre-demotion base interval', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000)

    await failFiveTimes(manager, clock)

    //+_+// 강등된 45000 을 기준으로 삼았다면 이 시각은 아직 LIVE 다. 기본 주기를 쓰는지 가른다
    expect(clock.now()).toBeGreaterThan(2000 * 3)
    expect(clock.now()).toBeLessThan(45000 * 3)
    expect(manager.statusOf('a')).toBe('STALE')
  })
})

describe('TASK-P3-01 item 17 - stale after three missed intervals', () => {
  it('stays LIVE up to the boundary and turns STALE past it', () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000)

    clock.advance(6000)
    expect(manager.statusOf('a')).toBe('LIVE')

    clock.advance(1)
    expect(manager.statusOf('a')).toBe('STALE')
  })

  it('computes the boundary from the tile interval, not a fixed value', () => {
    expect(isStale(6000, 0, 2000)).toBe(false)
    expect(isStale(6001, 0, 2000)).toBe(true)
    expect(isStale(12000, 0, 4000)).toBe(false)
    expect(isStale(12001, 0, 4000)).toBe(true)
  })

  it('returns null for a tile it does not know', () => {
    const { manager } = build()
    expect(manager.statusOf('missing')).toBeNull()
  })
})

describe('TASK-P3-01 item 18 - a success returns STALE to LIVE', () => {
  it('goes back to LIVE once a frame arrives', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    clock.advance(6001)
    expect(manager.statusOf('a')).toBe('STALE')

    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    expect(manager.statusOf('a')).toBe('LIVE')
    expect(manager.latestFrame('a')).toEqual({ imageBase64: 'AAAA', format: 'jpeg', bytes: 3 })
  })
})

describe('TASK-P3-01 item 19 - the timeout row carries the time axis', () => {
  //+_+// L23 은 타임아웃 4행이 startedAt 과 durationMs 를 모두 잃은 사건이다
  it('records startedAt and durationMs on the timeout row', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000)

    clock.advance(1234)
    manager.tick()
    await flush()
    clock.advance(5000)

    expect(manager.captureRecords[0]).toMatchObject({
      tileId: 'a',
      tabId: 1,
      outcome: 'timeout',
      startedAt: 1234,
      durationMs: 5000,
      attemptIndex: 0,
      bytes: null,
    })
  })

  it('records startedAt and durationMs on the success row', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    clock.advance(500)
    manager.tick()
    await flush()
    clock.advance(80)
    await settleCapture(backend, 0, 'aGVsbG8=')

    expect(manager.captureRecords[0]).toMatchObject({
      outcome: 'success',
      startedAt: 500,
      durationMs: 80,
      bytes: 5,
    })
  })
})

describe('TASK-P3-01 item 20 - a timeout never becomes ERROR', () => {
  it('leaves the status off ERROR after one timeout', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    clock.advance(5000)

    expect(manager.statusOf('a')).not.toBe('ERROR')
  })

  it('leaves the status off ERROR after five timeouts', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000)

    for (const step of [0, 2000, 5000, 15000, 30000]) {
      clock.advance(step)
      manager.tick()
      await flush()
      clock.advance(5000)
    }

    expect(manager.captureRecords).toHaveLength(5)
    expect(manager.statusOf('a')).not.toBe('ERROR')
    expect(manager.statusOf('a')).toBe('STALE')
  })

  //+_+// ERROR 는 attach 3회 소진에서만 온다. TASK-P3-01 section 3.4
  it('goes to ERROR only when the three attach attempts are spent', async () => {
    const { manager, backend } = build()
    backend.attachRejections.push(new Error('a'), new Error('b'), new Error('c'))
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()

    expect(manager.statusOf('a')).toBe('ERROR')
    expect(manager.captureRecords[0]).toMatchObject({ outcome: 'failure', message: 'c' })
  })
})

describe('TASK-P3-01 - status priority and detach faults', () => {
  //+_+// 세션 상태가 신선도보다 앞선다
  it('ranks ERROR over DETACHED over DEVTOOLS over STALE over LIVE', () => {
    expect(resolveTileStatus(['ERROR', 'DETACHED', 'DEVTOOLS', 'STALE', 'LIVE'])).toBe('ERROR')
    expect(resolveTileStatus(['DETACHED', 'DEVTOOLS', 'STALE'])).toBe('DETACHED')
    expect(resolveTileStatus(['DEVTOOLS', 'STALE'])).toBe('DEVTOOLS')
    expect(resolveTileStatus(['STALE', 'LIVE'])).toBe('STALE')
    expect(resolveTileStatus([null, 'LIVE'])).toBe('LIVE')
    expect(resolveTileStatus([])).toBe('LIVE')
  })

  it('ignores the tab based statuses that v1 section 11 owns', () => {
    expect(resolveTileStatus(['LOADING', 'FROZEN', 'DISCARDED'])).toBe('LIVE')
  })

  it('puts a detached tab into DETACHED even while it would read LIVE', () => {
    const { manager, backend } = build()
    manager.register('a', 1, 2000)

    backend.fireDetach(1, 'target_closed')

    expect(manager.statusOf('a')).toBe('DETACHED')
  })

  it('routes an observed devtools reason to DEVTOOLS', () => {
    const backend = new FakeCaptureBackend()
    const clock = new FakeClock()
    const sessions = new DebuggerSessionManager(backend, {
      wait: () => Promise.resolve(),
      devtoolsDetachReasons: ['observed_devtools_reason'],
    })
    const manager = new PreviewCaptureManager(backend, sessions, clock)
    manager.register('a', 1, 2000)

    backend.fireDetach(1, 'observed_devtools_reason')

    expect(manager.statusOf('a')).toBe('DEVTOOLS')
  })

  it('clears the fault when a capture succeeds again', async () => {
    const { manager, backend } = build()
    manager.register('a', 1, 2000)
    backend.fireDetach(1, 'target_closed')
    expect(manager.statusOf('a')).toBe('DETACHED')

    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    expect(manager.statusOf('a')).toBe('LIVE')
  })
})

describe('TASK-P3-01 - queue order and capture command', () => {
  //+_+// 만기 시각이 이른 순이다. 우선순위 정렬을 따로 만들지 않는다
  it('orders due tiles by their due time', () => {
    const tiles = [
      { tileId: 'late', tabId: 3, nextDueAt: 900 },
      { tileId: 'early', tabId: 1, nextDueAt: 100 },
      { tileId: 'future', tabId: 2, nextDueAt: 2000 },
    ]

    expect(selectDueTiles(tiles, 1000).map((tile) => tile.tileId)).toEqual(['early', 'late'])
    expect(selectDueTiles(tiles, 50)).toEqual([])
  })

  it('enables the page once and then captures on each later round', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    clock.advance(2000)
    manager.tick()
    await flush()

    expect(backend.commands.map((entry) => entry.method)).toEqual([
      'Page.enable',
      'Page.captureScreenshot',
      'Page.captureScreenshot',
    ])
  })

  it('treats an empty payload as a failure rather than a frame', async () => {
    const { manager, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    backend.captures[0]?.resolve({ data: '' })
    await flush()

    expect(manager.latestFrame('a')).toBeNull()
    expect(manager.captureRecords[0]).toMatchObject({
      outcome: 'failure',
      message: 'empty screenshot payload',
    })
  })

  it('stops capturing a tile that has been unregistered', async () => {
    const { manager, backend } = build()
    manager.register('a', 1, 2000)

    await manager.unregister('a')
    manager.tick()
    await flush()

    expect(backend.openCaptures).toBe(0)
    expect(manager.statusOf('a')).toBeNull()
  })
})
