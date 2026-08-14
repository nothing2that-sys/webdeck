import { describe, expect, it } from 'vitest'
import { DebuggerSessionManager } from '../src/background/debuggerSessionManager'
import type { DebuggerBackend } from '../src/background/debuggerSessionManager'
import {
  PreviewCaptureManager,
  SESSION_LOST_MESSAGES,
  base64ByteLength,
  isSessionLost,
  isStale,
  resolveTileStatus,
  selectDueTiles,
} from '../src/background/previewCaptureManager'
import type {
  CaptureRecord,
  Clock,
  PreviewCaptureManagerOptions,
} from '../src/background/previewCaptureManager'

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
  readonly attachCalls: number[] = []
  readonly commands: { tabId: number; method: string }[] = []
  readonly captures: Deferred[] = []
  readonly attachRejections: unknown[] = []
  private listener: ((tabId: number, reason: string) => void) | null = null

  attachHangs = false

  attach(tabId: number): Promise<void> {
    this.attachCalls.push(tabId)
    if (this.attachHangs) {
      return new Promise<void>(() => undefined)
    }
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

function build(options: PreviewCaptureManagerOptions = {}) {
  const backend = new FakeCaptureBackend()
  const clock = new FakeClock()
  const sessions = new DebuggerSessionManager(backend)
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
      roundDurationMs: 6200,
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
  //+_+// L23 은 타임아웃 4행이 startedAt 과 소요 시간을 모두 잃은 사건이다
  it('records startedAt and roundDurationMs on the timeout row', async () => {
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
      roundDurationMs: 5000,
      attemptIndex: 0,
      bytes: null,
    })
  })

  it('records startedAt and roundDurationMs on the success row', async () => {
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
      roundDurationMs: 80,
      callDurationMs: 80,
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

  //+_+// ERROR 는 attach 3회 소진에서만 온다. 회차당 1회이므로 세 회차가 필요하다. D6
  it('goes to ERROR only when the three attach attempts are spent', async () => {
    const { manager, clock, backend } = build()
    backend.attachRejections.push(new Error('a'), new Error('b'), new Error('c'))
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    expect(manager.statusOf('a')).not.toBe('ERROR')

    clock.advance(2000)
    manager.tick()
    await flush()
    expect(manager.statusOf('a')).not.toBe('ERROR')

    clock.advance(5000)
    manager.tick()
    await flush()

    expect(manager.statusOf('a')).toBe('ERROR')
    expect(manager.captureRecords[2]).toMatchObject({
      outcome: 'attachFailed',
      message: 'c',
      calledAt: null,
    })
  })
})

describe('TASK-P3-01 - the slot hold time is bounded by one constant', () => {
  //+_+// D6. attach 가 지연되면 예전 구조에서는 마감이 시작되지도 않았다
  it('frees the slot at 5000 ms even while the attach never settles', async () => {
    const { manager, clock, backend } = build()
    backend.attachHangs = true
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(1)

    clock.advance(4999)
    expect(manager.inFlightCount).toBe(1)

    clock.advance(1)
    expect(manager.inFlightCount).toBe(0)
    expect(manager.captureRecords[0]).toMatchObject({
      outcome: 'timeout',
      startedAt: 0,
      roundDurationMs: 5000,
      calledAt: null,
    })
  })

  it('does not hold a second tab hostage while the first attach hangs', async () => {
    const { manager, clock, backend } = build()
    backend.attachHangs = true
    manager.register('a', 1, 2000)
    manager.register('b', 2, 2000)
    manager.register('c', 3, 2000)

    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(2)
    expect(manager.queueLength).toBe(1)

    clock.advance(5000)
    await flush()

    expect(manager.inFlightCount).toBeLessThanOrEqual(2)
    expect(manager.queueLength).toBe(0)
  })

  //+_+// 실패한 attach 는 슬롯을 즉시 놓는다. 마감까지 붙들지 않는다
  it('frees the slot immediately when the attach fails outright', async () => {
    const { manager, backend } = build()
    backend.attachRejections.push(new Error('denied'))
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()

    expect(manager.inFlightCount).toBe(0)
    expect(manager.captureRecords[0]).toMatchObject({
      outcome: 'attachFailed',
      message: 'denied',
      roundDurationMs: 0,
      callDurationMs: null,
    })
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

  //+_+// P3-D17. 회차마다 captureScreenshot 하나뿐이다. 앞에 붙는 CDP 명령이 없다
  it('sends only captureScreenshot on each round', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    clock.advance(2000)
    manager.tick()
    await flush()

    expect(backend.commands.map((entry) => entry.method)).toEqual([
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
      outcome: 'captureFailed',
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

describe('TASK-P3-01-S5 - the record schema after P3-D9', () => {
  //+_+// durationMs 라는 이름을 어디에도 남기지 않는다. 같은 이름이 다른 것을 가리키면 안 된다
  it('names no durationMs field on a capture record', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    clock.advance(90)
    await settleCapture(backend, 0, 'aGVsbG8=')

    const record = manager.captureRecords[0]
    expect(record).toBeDefined()
    expect(Object.hasOwn(record as object, 'durationMs')).toBe(false)

    const keys: Record<keyof CaptureRecord, true> = {
      tileId: true,
      tabId: true,
      attemptToken: true,
      attemptIndex: true,
      startedAt: true,
      calledAt: true,
      roundDurationMs: true,
      callDurationMs: true,
      outcome: true,
      bytes: true,
      message: true,
    }
    expect(Object.keys(record as object).sort()).toEqual(Object.keys(keys).sort())
  })

  //+_+// 회차 소요는 attach 를 포함하고 호출 소요는 포함하지 않는다
  it('separates the round duration from the call duration', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    clock.advance(90)
    await settleCapture(backend, 0)

    expect(manager.captureRecords[0]).toMatchObject({
      startedAt: 0,
      calledAt: 0,
      roundDurationMs: 90,
      callDurationMs: 90,
    })
  })

  it('leaves calledAt and callDurationMs null when the round never reached the command', async () => {
    const { manager, backend } = build()
    backend.attachRejections.push(new Error('denied'))
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()

    expect(manager.captureRecords[0]).toMatchObject({
      outcome: 'attachFailed',
      calledAt: null,
      callDurationMs: null,
    })
  })

  it('splits failure into attachFailed, captureFailed and tabGone', async () => {
    const attach = build()
    attach.backend.attachRejections.push(new Error('denied'))
    attach.manager.register('a', 1, 2000)
    attach.manager.tick()
    await flush()
    expect(attach.manager.captureRecords[0]?.outcome).toBe('attachFailed')

    const capture = build()
    capture.manager.register('a', 1, 2000)
    capture.manager.tick()
    await flush()
    capture.backend.captures[0]?.reject(new Error('cdp error'))
    await flush()
    expect(capture.manager.captureRecords[0]?.outcome).toBe('captureFailed')

    const gone = build()
    gone.manager.register('a', 1, 2000)
    gone.manager.tick()
    await flush()
    await gone.manager.releaseTab(1)
    expect(gone.manager.captureRecords[0]?.outcome).toBe('tabGone')
  })

  it('names no durationMs field on a late arrival either', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    clock.advance(5000)
    await settleCapture(backend, 0)

    const late = manager.lateArrivals[0]
    expect(late).toBeDefined()
    expect(Object.hasOwn(late as object, 'durationMs')).toBe(false)
    expect(late?.roundDurationMs).toBe(5000)
    expect(late?.attemptIndex).toBe(0)
  })
})

describe('TASK-P3-01-S5 - a lost session is reattached on the next round', () => {
  //+_+// r1b 에서 강제 detach 뒤 끝까지 복구되지 않았다. L3 가 처음 실행돼 실패한 항목이다
  it('reattaches on the next round after a not-attached failure', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    expect(backend.attachCalls).toEqual([1])

    backend.captures[0]?.reject(new Error('Debugger is not attached to the tab with id: 1'))
    await flush()
    expect(manager.captureRecords[0]?.outcome).toBe('captureFailed')

    clock.advance(2000)
    manager.tick()
    await flush()

    expect(backend.attachCalls).toEqual([1, 1])
    expect(backend.commands.map((entry) => entry.method)).toEqual([
      'Page.captureScreenshot',
      'Page.captureScreenshot',
    ])
  })

  it('treats the in flight detach message as a lost session too', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    backend.captures[0]?.reject(new Error('Detached while handling command.'))
    await flush()

    clock.advance(2000)
    manager.tick()
    await flush()

    expect(backend.attachCalls).toEqual([1, 1])
  })

  //+_+// 대조군이다. 세션과 무관한 오류로 리스를 버리면 불필요한 재attach 가 생긴다
  it('keeps the lease when the failure is not about the session', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    backend.captures[0]?.reject(new Error('Some other CDP error'))
    await flush()

    clock.advance(2000)
    manager.tick()
    await flush()

    expect(backend.attachCalls).toEqual([1])
  })

  //+_+// 무한 재attach 루프를 만들지 않는다. 회차당 1회이고 간격은 backoff 계단이 만든다
  it('reattaches once per round and follows the backoff steps', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    const lose = async (index: number): Promise<void> => {
      backend.captures[index]?.reject(new Error('Debugger is not attached to the tab with id: 1'))
      await flush()
    }

    manager.tick()
    await flush()
    await lose(0)

    clock.advance(1999)
    manager.tick()
    await flush()
    expect(backend.attachCalls).toEqual([1])

    clock.advance(1)
    manager.tick()
    await flush()
    await lose(1)

    clock.advance(4999)
    manager.tick()
    await flush()
    expect(backend.attachCalls).toEqual([1, 1])

    clock.advance(1)
    manager.tick()
    await flush()
    expect(backend.attachCalls).toEqual([1, 1, 1])
  })

  it('classifies only the observed strings as a lost session', () => {
    expect(isSessionLost('Debugger is not attached to the tab with id: 9')).toBe(true)
    expect(isSessionLost('Detached while handling command.')).toBe(true)
    expect(isSessionLost('DETACHED WHILE HANDLING COMMAND.')).toBe(true)
    expect(isSessionLost('empty screenshot payload')).toBe(false)
    expect(isSessionLost(null)).toBe(false)
    expect(SESSION_LOST_MESSAGES).toHaveLength(2)
  })
})

describe('r2 후속 - lateArrival 은 마감 뒤에 온 응답만이다', () => {
  //+_+// r2a 에 lateByMs -4968 이 실렸다. 실체는 탭이 닫혀 마감 전에 정리된 회차였다
  it('does not log a late arrival when the round was abandoned by a closed tab', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    clock.advance(32)
    await manager.releaseTab(1)
    expect(manager.captureRecords[0]?.outcome).toBe('tabGone')

    await settleCapture(backend, 0)

    expect(manager.lateArrivals).toEqual([])
  })

  it('logs a late arrival only after the deadline actually fired', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()
    clock.advance(5000)
    clock.advance(700)
    await settleCapture(backend, 0)

    expect(manager.lateArrivals).toHaveLength(1)
    expect(manager.lateArrivals[0]).toMatchObject({ lateByMs: 700, roundDurationMs: 5700 })
  })

  //+_+// 마감 시각에서 재므로 구조적으로 음수가 될 수 없다
  it('never reports a negative lateByMs', async () => {
    const { manager, clock, backend } = build()
    manager.register('a', 1, 2000)
    manager.register('b', 2, 2000)

    manager.tick()
    await flush()
    clock.advance(5000)
    await settleCapture(backend, 0)
    await settleCapture(backend, 1)
    clock.advance(10)
    await manager.releaseTab(2)

    for (const entry of manager.lateArrivals) {
      expect(entry.lateByMs).toBeGreaterThanOrEqual(0)
    }
    expect(manager.lateArrivals.every((entry) => entry.lateByMs >= 0)).toBe(true)
  })
})

//+_+// L36. 상태 소유가 두 층에 갈려 있어 닫힌 탭의 타일이 재등록으로 되살아난다
//+_+// P4-D15 는 호출자에 게이트를 걸어 증상만 막았다. 엔진 자체는 탭 소멸을 기억하지 않는다
//+_+// P5-D20 이 소유를 엔진으로 모은다. 아래는 그 전후를 가르는 시험이다
describe('P5-D20 - the capture engine owns the fact that a tab is gone', () => {
  async function captured(): Promise<ReturnType<typeof build>> {
    const value = build()
    value.manager.register('a', 1, 2000)
    value.manager.tick()
    await flush()
    await settleCapture(value.backend, 0)
    expect(value.manager.statusOf('a')).toBe('LIVE')
    return value
  }

  it('reports DETACHED rather than forgetting the tile', async () => {
    const { manager } = await captured()
    await manager.releaseTab(1)

    expect(manager.statusOf('a')).toBe('DETACHED')
  })

  //+_+// 이것이 L36 의 본체다. 게이트 없이 다시 등록하면 오늘은 LIVE 가 된다
  it('does not revive the tile when it is registered again for the same tab', async () => {
    const { manager } = await captured()
    await manager.releaseTab(1)
    manager.register('a', 1, 2000)

    expect(manager.statusOf('a')).toBe('DETACHED')
  })

  it('does not capture a tile whose tab is gone', async () => {
    const { manager, clock, backend } = await captured()
    const before = backend.commands.length
    await manager.releaseTab(1)

    clock.advance(10000)
    manager.tick()
    await flush()
    expect(backend.commands).toHaveLength(before)
  })

  it('does not queue a tile whose tab is gone', async () => {
    const { manager, clock } = await captured()
    await manager.releaseTab(1)

    clock.advance(10000)
    manager.tick()
    expect(manager.queueLength).toBe(0)
    expect(manager.inFlightCount).toBe(0)
  })

  //+_+// Reopen 과 Bind 가 fault 를 지우는 유일한 명시 경로다. 새 탭으로 거는 것이 그 형태다
  it('clears the fault when the tile is registered for a different tab', async () => {
    const { manager } = await captured()
    await manager.releaseTab(1)
    manager.register('a', 2, 2000)

    expect(manager.statusOf('a')).toBe('LIVE')
  })

  it('captures again after it was registered for a different tab', async () => {
    const { manager, backend } = await captured()
    await manager.releaseTab(1)
    manager.register('a', 2, 2000)

    manager.tick()
    await flush()
    expect(backend.commands.at(-1)).toMatchObject({ tabId: 2 })
  })

  //+_+// 같은 탭으로의 재등록은 신선도 기준도 되돌리지 않는다. J28 이 지적한 나머지 절반이다
  it('keeps a stale tile stale when it is registered again for the same tab', async () => {
    const { manager, clock } = await captured()
    clock.advance(2000 * 3 + 1)
    expect(manager.statusOf('a')).toBe('STALE')

    manager.register('a', 1, 2000)
    expect(manager.statusOf('a')).toBe('STALE')
  })

  //+_+// 디버거 detach 는 탭 소멸이 아니다. 다음 회차가 다시 붙어야 한다. 스케줄에서 빼지 않는다
  it('keeps scheduling a tile whose debugger detached but whose tab is alive', async () => {
    const { manager, clock, backend } = await captured()
    backend.fireDetach(1, 'target_closed')
    expect(manager.statusOf('a')).toBe('DETACHED')

    clock.advance(2000)
    manager.tick()
    await flush()
    expect(backend.attachCalls.length).toBeGreaterThan(1)
  })
})
