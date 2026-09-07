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
import { RECORD_LOG_LIMIT } from '../src/shared/recordLimit'

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

describe('TASK-P12-04 (S2) - the capture timeout is a per-tile value', () => {
  //+_+// register 의 4번째 인자를 생략한 기존 호출부는 전부 이 기본값 그대로여야 한다
  it('keeps CAPTURE_TIMEOUT_MS(5000) as the default when no override is given', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000)

    manager.tick()
    await flush()

    clock.advance(4999)
    expect(manager.inFlightCount).toBe(1)
    clock.advance(1)
    expect(manager.inFlightCount).toBe(0)
  })

  it('frees the slot at the tile-specific timeout instead of 5000 ms', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000, 1000)

    manager.tick()
    await flush()

    clock.advance(999)
    expect(manager.inFlightCount).toBe(1)
    clock.advance(1)
    expect(manager.inFlightCount).toBe(0)
  })

  it('also honours a value longer than the default', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000, 8000)

    manager.tick()
    await flush()

    clock.advance(5000)
    expect(manager.inFlightCount).toBe(1)
    clock.advance(3000)
    expect(manager.inFlightCount).toBe(0)
  })

  //+_+// TASK-P12-04 §4. 값이 바뀌면 다음 회차부터 적용된다. 진행 중인 회차를 중단하지 않는다
  //+_+// beginAttempt 가 타이머를 걸 때의 state.captureTimeoutMs 값이 그 회차 내내 고정이다
  it('does not change an in-flight round when the tile is re-registered with a new timeout', async () => {
    const { manager, clock } = build()
    manager.register('a', 1, 2000, 5000)

    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(1)

    //+_+// 같은 탭으로 다시 등록한다. 진행 중인 회차의 타이머는 이미 5000 으로 걸려 있다
    manager.register('a', 1, 2000, 1000)

    clock.advance(1000)
    //+_+// 1000ms 로는 아직 안 끝난다 -- 이 회차는 여전히 5000 을 쓰고 있었다는 뜻이다
    expect(manager.inFlightCount).toBe(1)

    clock.advance(4000)
    //+_+// 5000ms 에 도달하면 끝난다 (타임아웃). 슬롯이 반납되고 backoff 2000ms 가 걸린다
    expect(manager.inFlightCount).toBe(0)

    //+_+// backoff 첫 계단(2000ms)이 지나야 다음 회차가 due 해진다
    clock.advance(2000)
    manager.tick()
    await flush()
    expect(manager.inFlightCount).toBe(1)

    //+_+// 다음 회차부터는 새 값(1000)이 적용된다
    clock.advance(999)
    expect(manager.inFlightCount).toBe(1)
    clock.advance(1)
    expect(manager.inFlightCount).toBe(0)
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
      scheduleIntervalMs: true,
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


//+_+// D6a · P6-D46. Pause 는 억제 플래그다. 리스도 슬롯도 건드리지 않는다
describe('D6a - a pause suppresses rounds without dropping the attach', () => {
  it('runs no round while paused even after the due time passed', async () => {
    const { manager, backend, clock } = build()
    manager.register('t1', 11, 4000)
    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    manager.setPaused(true)
    clock.advance(100_000)
    manager.tick()
    await flush()
    expect(manager.captureRecords).toHaveLength(1)
  })

  //+_+// A-e2. unregister 를 부르면 리스가 풀린다. Pause 는 그 자리에 닿지 않아야 한다
  it('keeps the lease and the registration through a pause', async () => {
    const { manager, backend, sessions } = build()
    manager.register('t1', 11, 4000)
    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    manager.setPaused(true)
    expect(manager.registeredTileCount).toBe(1)
    expect(manager.isScheduled('t1')).toBe(true)
    expect(sessions.isAttached(11)).toBe(true)
    expect(manager.statusOf('t1')).not.toBe('DETACHED')
  })

  //+_+// A-e3. 해제 시각이 아니라 남은 시간이 보존된다. 그래서 전 타일이 동시에 몰리지 않는다
  it('carries the remaining time to the next due across the pause', async () => {
    const { manager, backend, clock } = build()
    manager.register('t1', 11, 4000)
    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    manager.setPaused(true)
    clock.advance(500_000)
    manager.setPaused(false)

    manager.tick()
    expect(manager.inFlightCount).toBe(0)

    clock.advance(3999)
    manager.tick()
    expect(manager.inFlightCount).toBe(0)

    clock.advance(1)
    manager.tick()
    expect(manager.inFlightCount).toBe(1)
  })

  //+_+// A-e4 · D38. Pause 구간의 경과가 신선도에 들어가면 해제 직후 전 타일이 STALE 로 보인다
  it('does not let the paused span make the tile stale', async () => {
    const { manager, backend, clock } = build()
    manager.register('t1', 11, 4000)
    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    manager.setPaused(true)
    clock.advance(500_000)
    expect(manager.statusOf('t1')).toBe('LIVE')

    manager.setPaused(false)
    expect(manager.statusOf('t1')).toBe('LIVE')

    //+_+// 해제 뒤의 경과는 그대로 센다. Pause 가 신선도를 영영 얼리지는 않는다
    clock.advance(4000 * 3 + 1)
    expect(manager.statusOf('t1')).toBe('STALE')
  })

  //+_+// P6-D46. Refresh Preview 는 사용자가 지금 보겠다고 누른 것이므로 Pause 가 막지 않는다
  it('still serves captureOnce while paused', async () => {
    const { manager, backend } = build()
    manager.register('t1', 11, 4000)
    manager.setPaused(true)

    const waiting = manager.captureOnce('t1')
    await flush()
    await settleCapture(backend, 0)
    await expect(waiting).resolves.toMatchObject({ format: 'jpeg' })
  })

  //+_+// P6-D50. 워커는 Pause 로 시작하므로 기동 시 등록된 타일이 전부 이 경로다
  //+_+// 그것까지 밀면 Dashboard 를 열어도 워커가 Pause 로 산 시간만큼 첫 회차가 늦는다
  it('lets a tile registered during the pause run as soon as the pause ends', async () => {
    const { manager, clock } = build()
    //+_+// 워커가 Pause 로 5분을 산 뒤 Dashboard 가 열리는 상황이다
    manager.setPaused(true)
    manager.register('t1', 11, 4000)
    clock.advance(300_000)
    manager.setPaused(false)

    manager.tick()
    expect(manager.inFlightCount).toBe(1)
  })

  //+_+// P6-D59. hidden-reach P2 가 잡은 결함이다. 구간 안에서 정산된 타일만 STALE 로 보였다
  //+_+// 정산 직후에는 제 시각이 옳지만 그 뒤로도 Pause 가 이어지면 그만큼은 그 타일도 잃는다
  it('shifts a tile that settled inside the pause by the part of the pause that followed', async () => {
    const { manager, backend, clock } = build()
    manager.register('t1', 11, 4000)
    manager.setPaused(true)

    //+_+// Pause 가 시작되고 10초 뒤에 회차 하나가 끝난다. captureOnce 는 Pause 를 통과한다
    clock.advance(10_000)
    const waiting = manager.captureOnce('t1')
    await flush()
    await settleCapture(backend, 0)
    await waiting

    //+_+// 그 뒤로 Pause 가 100초 더 이어진다. 그 100초는 이 타일도 잃은 시간이다
    clock.advance(100_000)
    manager.setPaused(false)

    expect(manager.statusOf('t1')).toBe('LIVE')
  })

  //+_+// 만기 쪽도 같은 양으로 밀린다. 해제 직후에 몰려 돌지 않는다
  it('gives that tile a full interval from the moment the pause ended', async () => {
    const { manager, backend, clock } = build()
    manager.register('t1', 11, 4000)
    manager.setPaused(true)

    clock.advance(10_000)
    const waiting = manager.captureOnce('t1')
    await flush()
    await settleCapture(backend, 0)
    await waiting

    clock.advance(100_000)
    manager.setPaused(false)

    manager.tick()
    expect(manager.inFlightCount).toBe(0)

    clock.advance(3999)
    manager.tick()
    expect(manager.inFlightCount).toBe(0)

    clock.advance(1)
    manager.tick()
    expect(manager.inFlightCount).toBe(1)
  })

  //+_+// Pause 시작 전에 정산된 타일은 종전대로 구간 전체를 받는다. 그 동작을 바꾸지 않는다
  it('still shifts a tile that settled before the pause by the whole pause', async () => {
    const { manager, backend, clock } = build()
    manager.register('t1', 11, 4000)
    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    manager.setPaused(true)
    clock.advance(500_000)
    manager.setPaused(false)

    expect(manager.statusOf('t1')).toBe('LIVE')
    clock.advance(3999)
    manager.tick()
    expect(manager.inFlightCount).toBe(0)
    clock.advance(1)
    manager.tick()
    expect(manager.inFlightCount).toBe(1)
  })

  //+_+// P6-D50. Pause 중에 끝난 회차는 이미 제 시각을 가졌다. 다시 밀면 시각이 미래가 된다
  it('does not push a tile that already settled during the pause into the future', async () => {
    const { manager, backend, clock } = build()
    manager.register('t1', 11, 4000)
    manager.setPaused(true)

    clock.advance(10_000)
    const waiting = manager.captureOnce('t1')
    await flush()
    await settleCapture(backend, 0)
    await waiting

    clock.advance(10_000)
    manager.setPaused(false)

    //+_+// 미래 시각이 들어갔으면 isStale 이 음수 경과를 보고 한참 동안 LIVE 로 남는다
    clock.advance(4000 * 3 + 1)
    expect(manager.statusOf('t1')).toBe('STALE')
  })
})

//+_+// P6-D44 · D28. 재등록 한 번이 실패 계단을 통째로 지우던 것을 막는다
describe('P6-D44 - a re-registration on the same tab inherits the failure ladder', () => {
  //+_+// 회차 1건을 실패로 끝낸다. 계단은 실패 수로만 오르므로 실패를 세는 것이 이 시험의 전부다
  async function failRound(value: ReturnType<typeof build>, index: number): Promise<void> {
    value.manager.tick()
    await flush()
    value.backend.captures[index]?.reject(new Error('capture refused'))
    await flush()
  }

  it('keeps the consecutive failure count when the tab is the same', async () => {
    const value = build()
    value.manager.register('t1', 11, 4000)
    await failRound(value, 0)

    //+_+// 재등록이 만기를 now 로 되돌리므로 두 번째 실패는 그 자리에서 난다
    //+_+// 계단 1단은 2000 이고 2단은 5000 이다. 승계했으면 다음 재시도가 5000 이어야 한다
    value.manager.register('t1', 11, 4000)
    await failRound(value, 1)

    value.clock.advance(4999)
    value.manager.tick()
    await flush()
    expect(value.backend.openCaptures).toBe(2)

    value.clock.advance(1)
    value.manager.tick()
    await flush()
    expect(value.backend.openCaptures).toBe(3)
  })

  //+_+// P5-D32. 새 탭에 거는 것은 fault 를 지우는 명시 경로다. 그 성질을 바꾸지 않는다
  it('clears the ladder when the tile moves to another tab', async () => {
    const value = build()
    value.manager.register('t1', 11, 4000)
    await failRound(value, 0)

    value.manager.register('t1', 12, 4000)
    await failRound(value, 1)

    //+_+// 계단이 지워졌으면 다음은 1단 2000 이다
    value.clock.advance(2000)
    value.manager.tick()
    await flush()
    expect(value.backend.openCaptures).toBe(3)
  })
})

//+_+// P6-D51. every 는 타일 설정이고 이 값은 이 회차의 만기를 정할 때 실제로 더해진 주기다
describe('P6-D51 - the record names the interval that scheduled the round', () => {
  it('reports the base interval while the tile is healthy', async () => {
    const { manager, backend } = build()
    manager.register('t1', 11, 4000)
    manager.tick()
    await flush()
    await settleCapture(backend, 0)

    expect(manager.captureRecords[0]?.scheduleIntervalMs).toBe(4000)
  })

  //+_+// 계단으로 불린 회차는 기본 주기와 다른 값을 싣는다. 그것이 이 필드의 목적이다
  it('reports the backoff step that actually called the round', async () => {
    const { manager, backend, clock } = build()
    manager.register('t1', 11, 4000)
    manager.tick()
    await flush()
    backend.captures[0]?.reject(new Error('capture refused'))
    await flush()

    clock.advance(2000)
    manager.tick()
    await flush()
    backend.captures[1]?.reject(new Error('capture refused'))
    await flush()

    expect(manager.captureRecords[0]?.scheduleIntervalMs).toBe(4000)
    expect(manager.captureRecords[1]?.scheduleIntervalMs).toBe(2000)
  })
})

//+_+// P6-D104. L29 의 요지가 "영원히 붙을 수 없는 탭도 계속 재시도한다" 이다
//+_+// 표시만 바꾸고 재시도를 그대로 두면 L29 가 닫히지 않는다. 회차 자체를 만들지 않는다
describe('P6-D104 - a restricted tile makes no capture round', () => {
  it('never attaches and never sends a command', async () => {
    const { manager, backend } = build()
    manager.register('a', 7, 2000)
    manager.setRestricted('a', true)

    manager.tick()
    await flush()
    manager.tick()
    await flush()

    expect(backend.attachCalls).toEqual([])
    expect(backend.commands).toEqual([])
    expect(manager.captureRecords).toHaveLength(0)
  })

  it('keeps retrying nothing as the clock runs on', async () => {
    const { manager, backend, clock } = build()
    manager.register('a', 7, 2000)
    manager.setRestricted('a', true)

    for (let round = 0; round < 20; round += 1) {
      clock.advance(2000)
      manager.tick()
      await flush()
    }

    expect(backend.attachCalls).toEqual([])
    expect(manager.captureRecords).toHaveLength(0)
  })

  //+_+// P5-D6. Refresh Preview 는 Pause 를 우회한다. 제한 URL 은 우회 대상이 아니다
  it('refuses the immediate capture as well', async () => {
    const { manager, backend } = build()
    manager.register('a', 7, 2000)
    manager.setRestricted('a', true)

    await expect(manager.captureOnce('a')).resolves.toBeNull()
    expect(backend.attachCalls).toEqual([])
  })

  //+_+// P5-D35. 스케줄에서 빠진 것이 아니다. 재연결 대상으로 잡히면 Open Missing Tabs 가 탭을 또 연다
  it('stays scheduled so that reconnect does not treat it as missing', () => {
    const { manager } = build()
    manager.register('a', 7, 2000)
    manager.setRestricted('a', true)
    expect(manager.isScheduled('a')).toBe(true)
  })

  //+_+// B-e5. 제한이 풀리면 다시 돈다. 상태는 최신 탭 URL 이 정한다
  it('runs again once the restriction is lifted', async () => {
    const { manager, backend } = build()
    manager.register('a', 7, 2000)
    manager.setRestricted('a', true)
    manager.tick()
    await flush()
    expect(backend.attachCalls).toEqual([])

    manager.setRestricted('a', false)
    manager.tick()
    await flush()
    expect(backend.attachCalls).toEqual([7])
  })

  //+_+// B-e5. 제한이 아닌 타일은 그대로 돈다
  it('leaves the other tiles alone', async () => {
    const { manager, backend } = build()
    manager.register('a', 7, 2000)
    manager.register('b', 8, 2000)
    manager.setRestricted('a', true)

    manager.tick()
    await flush()

    expect(backend.attachCalls).toEqual([8])
  })

  //+_+// 재등록이 제한을 지우지 않는다. fault 와 tabGone 을 승계하는 것과 같은 규칙이다
  it('keeps the restriction across a re-register of the same tab', async () => {
    const { manager, backend } = build()
    manager.register('a', 7, 2000)
    manager.setRestricted('a', true)
    manager.register('a', 7, 4000)

    manager.tick()
    await flush()

    expect(backend.attachCalls).toEqual([])
  })
})

//+_+// P6-D7. L26 이 연 항목이다. captureRecords 와 lateArrivals 가 상한 있는 기록이 됐다
describe('P6-D7 - the capture record logs are bounded', () => {
  it('keeps at most RECORD_LOG_LIMIT capture records', async () => {
    const { manager, backend, clock } = build()
    manager.register('a', 1, 2000)

    for (let round = 0; round < RECORD_LOG_LIMIT + 25; round += 1) {
      clock.advance(2000)
      manager.tick()
      await flush()
      await settleCapture(backend, round)
    }

    expect(manager.captureRecords).toHaveLength(RECORD_LOG_LIMIT)
  })

  //+_+// B-e2. 최근 것이 남는다. 앞을 버린다
  it('keeps the newest records and drops the oldest', async () => {
    const { manager, backend, clock } = build()
    manager.register('a', 1, 2000)

    for (let round = 0; round < RECORD_LOG_LIMIT + 25; round += 1) {
      clock.advance(2000)
      manager.tick()
      await flush()
      await settleCapture(backend, round)
    }

    const tokens = manager.captureRecords.map((record) => record.attemptToken)
    expect(tokens[tokens.length - 1]).toBe(RECORD_LOG_LIMIT + 25)
    expect(tokens[0]).toBe(26)
  })

  //+_+// B-e3 의 반대쪽이다. 배열 길이는 누적 카운터가 아니다. 시도 카운터는 따로 계속 는다
  it('does not stop the per tile attempt counter at the limit', async () => {
    const { manager, backend, clock } = build()
    manager.register('a', 1, 2000)

    for (let round = 0; round < RECORD_LOG_LIMIT + 25; round += 1) {
      clock.advance(2000)
      manager.tick()
      await flush()
      await settleCapture(backend, round)
    }

    const last = manager.captureRecords[manager.captureRecords.length - 1]
    expect(last?.attemptIndex).toBe(RECORD_LOG_LIMIT + 24)
  })
})

//+_+// P6-D111 · P3-D5. STALE 의 의미를 고정한다. "캡처가 되고 있지 않다" 이지 "화면이 안 바뀐다" 가 아니다
//+_+// L9 가 배경 탭 페이지 타이머의 스로틀을 확정했다. 화면 변화로 판정하면 배경 탭에서 상시 켜진다
describe('P6-D111 - STALE means the capture stopped, not that the picture stopped', () => {
  //+_+// D-e1. 같은 프레임이 20회 이어져도 캡처가 성공하는 한 STALE 이 아니다
  it('stays LIVE while the frame hash never changes', async () => {
    const { manager, backend, clock } = build()
    manager.register('a', 1, 2000)

    for (let round = 0; round < 20; round += 1) {
      clock.advance(2000)
      manager.tick()
      await flush()
      //+_+// 매 회차 같은 데이터다. 프레임 지문이 바뀌지 않는다
      await settleCapture(backend, round, 'AAAA')
    }

    expect(manager.statusOf('a')).toBe('LIVE')
    const frames = manager.captureRecords.map((record) => record.bytes)
    expect(new Set(frames).size).toBe(1)
  })

  //+_+// D-e2. 캡처가 임계를 넘겨 성공하지 못하면 STALE 이다
  it('turns STALE once no capture has succeeded past the threshold', async () => {
    const { manager, backend, clock } = build()
    manager.register('a', 1, 2000)

    clock.advance(2000)
    manager.tick()
    await flush()
    await settleCapture(backend, 0)
    expect(manager.statusOf('a')).toBe('LIVE')

    //+_+// 그 뒤로 아무 회차도 성공하지 않는다. 임계는 2000 x 3 이다
    clock.advance(6001)
    expect(manager.statusOf('a')).toBe('STALE')
  })

  //+_+// D-e3. 임계를 바꾸지 않았다. baseIntervalMs x 3 그대로다
  it('keeps the threshold at three times the base interval', () => {
    expect(isStale(6000, 0, 2000)).toBe(false)
    expect(isStale(6001, 0, 2000)).toBe(true)
    expect(isStale(12000, 0, 4000)).toBe(false)
    expect(isStale(12001, 0, 4000)).toBe(true)
  })

  //+_+// D-e4. P6-D59 의 시프트가 Pause 구간을 덮는다. 멈춘 동안의 경과가 신선도에 들어가지 않는다
  it('does not turn STALE across a long pause', async () => {
    const { manager, backend, clock } = build()
    manager.register('a', 1, 2000)

    clock.advance(2000)
    manager.tick()
    await flush()
    await settleCapture(backend, 0)
    expect(manager.statusOf('a')).toBe('LIVE')

    manager.setPaused(true)
    //+_+// 임계 6000 을 한참 넘긴다
    clock.advance(600000)
    expect(manager.statusOf('a')).toBe('LIVE')
    manager.setPaused(false)
    expect(manager.statusOf('a')).toBe('LIVE')
  })
})
