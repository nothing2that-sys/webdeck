import { describe, expect, it } from 'vitest'
import type { DebuggerBackend } from '../src/background/debuggerSessionManager'
import { DebuggerSessionManager } from '../src/background/debuggerSessionManager'
import { PreviewCaptureManager } from '../src/background/previewCaptureManager'
import type { Clock } from '../src/background/previewCaptureManager'
import { DRIVER_TICK_MS } from '../src/background/serviceWorker'

//+_+// TASK-P4-03 N1 계측이다. 제품 코드를 바꾸지 않고 실현 주기를 재기만 한다
//+_+// 실측 로그의 5.0초가 코드만으로 재현되는지 본다. 재현되면 외부 스로틀 가설이 필요하지 않다

interface SimTimer {
  at: number
  fn: () => void
  cancelled: boolean
}

class SimClock implements Clock {
  current = 0
  private readonly timers: SimTimer[] = []

  now(): number {
    return this.current
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const timer: SimTimer = { at: this.current + delayMs, fn: callback, cancelled: false }
    this.timers.push(timer)
    return () => {
      timer.cancelled = true
    }
  }

  runDue(): boolean {
    let fired = false
    for (const timer of this.timers) {
      if (!timer.cancelled && timer.at <= this.current) {
        timer.cancelled = true
        timer.fn()
        fired = true
      }
    }
    return fired
  }
}

interface PendingCapture {
  resolveAt: number
  settle: () => void
}

interface RunOptions {
  attachDurationMs?: number
}

//+_+// 탭마다 캡처 호출이 걸리는 시간을 정해 둔다. 실측에서 나온 값을 그대로 쓴다
class SimDebugger implements DebuggerBackend {
  readonly pending: PendingCapture[] = []
  attachDurationMs = 0

  constructor(
    private readonly clock: SimClock,
    private readonly callDurationMs: Map<number, number>,
  ) {}

  attach(): Promise<void> {
    if (this.attachDurationMs === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.pending.push({
        resolveAt: this.clock.current + this.attachDurationMs,
        settle: () => {
          resolve()
        },
      })
    })
  }

  detach(): Promise<void> {
    return Promise.resolve()
  }

  sendCommand(tabId: number): Promise<unknown> {
    const duration = this.callDurationMs.get(tabId) ?? 100
    return new Promise((resolve) => {
      this.pending.push({
        resolveAt: this.clock.current + duration,
        settle: () => {
          resolve({ data: 'AAAA' })
        },
      })
    })
  }

  onDetach(): void {
    return undefined
  }
}

interface SimTile {
  tileId: string
  tabId: number
  intervalMs: number
  callDurationMs: number
  //+_+// 등록 시각이다. dev 바인딩과 Resize 재등록이 서로 다른 순간에 일어난다
  registerAtMs?: number
}

interface Settled {
  tileId: string
  at: number
  roundDurationMs: number
  callDurationMs: number | null
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

//+_+// 구동자를 그대로 흉내낸다. startPreviewDriver 는 setInterval(tick, DRIVER_TICK_MS) 하나다
async function run(
  tiles: readonly SimTile[],
  horizonMs: number,
  options: RunOptions = {},
): Promise<Settled[]> {
  const clock = new SimClock()
  const durations = new Map(tiles.map((tile) => [tile.tabId, tile.callDurationMs]))
  const backend = new SimDebugger(clock, durations)
  backend.attachDurationMs = options.attachDurationMs ?? 0
  const sessions = new DebuggerSessionManager(backend)
  const settled: Settled[] = []
  const manager = new PreviewCaptureManager(backend, sessions, clock, {
    onCaptureSettled: (record) => {
      settled.push({
        tileId: record.tileId,
        at: clock.current,
        roundDurationMs: record.roundDurationMs,
        callDurationMs: record.callDurationMs,
      })
    },
  })

  const pendingRegistration = [...tiles].filter((tile) => (tile.registerAtMs ?? 0) > 0)
  for (const tile of tiles) {
    if ((tile.registerAtMs ?? 0) === 0) {
      manager.register(tile.tileId, tile.tabId, tile.intervalMs)
    }
  }

  for (let t = 0; t <= horizonMs; t += 1) {
    clock.current = t
    let acted = clock.runDue()

    for (let index = pendingRegistration.length - 1; index >= 0; index -= 1) {
      const tile = pendingRegistration[index]
      if ((tile.registerAtMs ?? 0) <= t) {
        pendingRegistration.splice(index, 1)
        manager.register(tile.tileId, tile.tabId, tile.intervalMs)
        acted = true
      }
    }

    for (let index = backend.pending.length - 1; index >= 0; index -= 1) {
      const call = backend.pending[index]
      if (call.resolveAt <= t) {
        backend.pending.splice(index, 1)
        call.settle()
        acted = true
      }
    }

    if (t % DRIVER_TICK_MS === 0) {
      manager.tick()
      acted = true
    }
    if (acted) {
      await flush()
    }
  }

  return settled
}

function deltas(settled: readonly Settled[], tileId: string): number[] {
  const times = settled.filter((entry) => entry.tileId === tileId).map((entry) => entry.at)
  return times.slice(1).map((at, index) => at - times[index])
}

describe('P4-D16 - the realized period after the fix', () => {
  it('keeps the driver tick at the value P4-D16 chose', () => {
    expect(DRIVER_TICK_MS).toBe(250)
  })

  //+_+// 회차 소요가 배정 주기보다 짧으면 실현 주기가 배정 주기와 정확히 같다
  //+_+// 250 이 2000 / 2500 / 4000 / 45000 을 모두 나누므로 올림 오차가 0 이다
  it('realizes the assigned interval exactly while the round fits inside it', async () => {
    const cases = [
      { intervalMs: 2000, callDurationMs: 100 },
      { intervalMs: 2000, callDurationMs: 900 },
      { intervalMs: 2000, callDurationMs: 1100 },
      { intervalMs: 2000, callDurationMs: 1900 },
      { intervalMs: 2500, callDurationMs: 100 },
      { intervalMs: 4000, callDurationMs: 100 },
      { intervalMs: 4000, callDurationMs: 2018 },
    ]
    for (const value of cases) {
      const settled = await run(
        [{ tileId: 'a', tabId: 1, intervalMs: value.intervalMs, callDurationMs: value.callDurationMs }],
        value.intervalMs * 3 + value.callDurationMs + 500,
      )
      expect(deltas(settled, 'a').slice(0, 2)).toEqual([value.intervalMs, value.intervalMs])
    }
  })

  //+_+// 회차 소요가 배정 주기를 넘으면 지나간 만기를 건너뛴다. 실현 주기는 배정 주기의 배수가 된다
  //+_+// 매 tick 실행으로 떨어지지 않고 밀린 만기도 쌓이지 않는다
  it('skips to the next multiple when the round outlasts the interval', async () => {
    const settled = await run(
      [{ tileId: 'a', tabId: 1, intervalMs: 2000, callDurationMs: 2018 }],
      18000,
    )
    expect(new Set(deltas(settled, 'a'))).toEqual(new Set([4000]))
  })

  it('skips two multiples when the round outlasts two intervals', async () => {
    const settled = await run(
      [{ tileId: 'a', tabId: 1, intervalMs: 2000, callDurationMs: 4100 }],
      24000,
    )
    expect(new Set(deltas(settled, 'a'))).toEqual(new Set([6000]))
  })

  //+_+// spanLarge 2000 과 spanMedium 2500 이 구분된다. tick 1000 에서는 둘 다 3000 으로 접혔다
  it('separates spanLarge from spanMedium', async () => {
    const large = await run([{ tileId: 'a', tabId: 1, intervalMs: 2000, callDurationMs: 100 }], 9000)
    const medium = await run([{ tileId: 'a', tabId: 1, intervalMs: 2500, callDurationMs: 100 }], 11000)
    expect(new Set(deltas(large, 'a'))).toEqual(new Set([2000]))
    expect(new Set(deltas(medium, 'a'))).toEqual(new Set([2500]))
  })

  //+_+// tick 격자를 나누지 못하는 주기는 올림된다. 다만 드리프트는 누적되지 않는다
  it('rounds an interval that the tick does not divide up to the next tick', async () => {
    const settled = await run([{ tileId: 'a', tabId: 1, intervalMs: 2400, callDurationMs: 100 }], 13000)
    for (const delta of deltas(settled, 'a')) {
      expect(delta).toBeGreaterThanOrEqual(2250)
      expect(delta).toBeLessThanOrEqual(2500)
    }
    //+_+// 5회차의 누적 오차가 1 tick 을 넘지 않는다. 완료 기준이었다면 계속 늘어났다
    const times = settled.map((entry) => entry.at)
    expect(times[4] - times[0]).toBeLessThanOrEqual(2400 * 4 + DRIVER_TICK_MS)
  })

  it('still cannot honour an interval shorter than the driver tick', async () => {
    const settled = await run([{ tileId: 'a', tabId: 1, intervalMs: 100, callDurationMs: 50 }], 3000)
    expect(new Set(deltas(settled, 'a'))).toEqual(new Set([DRIVER_TICK_MS]))
  })
})

describe('N1 - three tiles on the observed configuration', () => {
  //+_+// 실측 구성이다. 1x1 두 개는 spanSmall 4000, 2x2 하나는 spanLarge 2000 이다
  const OBSERVED: SimTile[] = [
    { tileId: 'small-1', tabId: 1, intervalMs: 4000, callDurationMs: 100 },
    { tileId: 'small-2', tabId: 2, intervalMs: 4000, callDurationMs: 120 },
    { tileId: 'large', tabId: 3, intervalMs: 2000, callDurationMs: 2018 },
  ]

  //+_+// 1x1 은 배정대로 4000 이다. 2x2 는 회차 소요 2018 때문에 2000 이 아니라 4000 이다
  //+_+// 후자는 스케줄러 결함이 아니라 N2 의 물리적 하한이다. 소요보다 빠른 주기는 만들 수 없다
  it('gives the small tiles their assigned interval and the large tile the next multiple', async () => {
    const settled = await run(OBSERVED, 20000)
    expect(new Set(deltas(settled, 'small-1'))).toEqual(new Set([4000]))
    expect(new Set(deltas(settled, 'small-2'))).toEqual(new Set([4000]))
    expect(new Set(deltas(settled, 'large'))).toEqual(new Set([4000]))
  })

  it('reports the round duration the call took and nothing more', async () => {
    const settled = await run(OBSERVED, 12000)
    const large = settled.filter((entry) => entry.tileId === 'large')
    expect(large.length).toBeGreaterThanOrEqual(2)
    expect(new Set(large.map((entry) => entry.roundDurationMs))).toEqual(new Set([2018]))
  })
})

//+_+// TASK-P4-04 항목 2. TASK-P4-03 의 예측이 틀렸다. 실제 로그는 2x2 가 먼저 찍힌다
//+_+// 원인은 스케줄 규칙이 아니라 초기 조건이다. register 가 nextDueAt 을 등록 시각으로 잡고
//+_+// 그 위상이 그대로 유지된다. 세 타일을 같은 순간에 등록하면 tie 가 되어 순서가 뒤바뀐다
describe('N1 - the order inside a burst is decided by registration phase', () => {
  const SMALLS: SimTile[] = [
    { tileId: 'small-1', tabId: 1, intervalMs: 4000, callDurationMs: 100 },
    { tileId: 'small-2', tabId: 2, intervalMs: 4000, callDurationMs: 120 },
  ]
  const LARGE: SimTile = { tileId: 'large', tabId: 3, intervalMs: 2000, callDurationMs: 2018 }

  //+_+// 세 타일을 t=0 에 동시 등록하면 selectDueTiles 의 tie 를 삽입 순서가 가른다
  //+_+// 슬롯 2개를 1x1 두 개가 차지하고 2x2 가 큐에 남는다. TASK-P4-03 이 이 조건을 썼다
  it('puts the large tile last when every tile is registered at the same instant', async () => {
    const settled = await run([...SMALLS, LARGE], 12000)
    const window = settled.filter((entry) => entry.at >= 4000 && entry.at < 8000)
    expect(window.map((entry) => entry.tileId)).toEqual(['small-1', 'small-2', 'large'])
  })

  //+_+// 실제로는 타일을 하나씩 바인딩했고 2x2 는 Resize 로 재등록됐다. 위상이 어긋나 있다
  //+_+// 2x2 를 1982ms 늦게 등록하면 정산이 1x1 들의 만기 직전에 떨어져 순서가 역전된다
  it('puts the large tile first when it was registered on a different phase', async () => {
    const settled = await run([...SMALLS, { ...LARGE, registerAtMs: 1982 }], 12000)
    const window = settled.filter((entry) => entry.at >= 4000 && entry.at < 8000)
    expect(window.map((entry) => entry.tileId)).toEqual(['large', 'small-1', 'small-2'])
  })

  //+_+// 실측 로그의 간격이다. 2x2 기준 +0.066 / +0.103 이었다
  it('follows the large tile within about a tenth of a second', async () => {
    const settled = await run([...SMALLS, { ...LARGE, registerAtMs: 1982 }], 12000)
    const window = settled.filter((entry) => entry.at >= 4000 && entry.at < 8000)
    const gaps = window.slice(1).map((entry) => entry.at - window[0].at)
    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(0)
      expect(gap).toBeLessThanOrEqual(150)
    }
  })

  //+_+// 위상 차이는 P4-D16 수정으로 사라지지 않는다. 드리프트가 아니라 등록 시각의 결과다
  it('keeps the inverted order stable across bursts', async () => {
    const settled = await run([...SMALLS, { ...LARGE, registerAtMs: 1982 }], 20000)
    for (const start of [4000, 8000, 12000, 16000]) {
      const window = settled.filter((entry) => entry.at >= start && entry.at < start + 4000)
      expect(window[0].tileId).toBe('large')
    }
  })
})

describe('N2 - what roundDurationMs measures', () => {
  //+_+// 예정 시각이 아니라 실제 실행 시작부터다. 큐에서 슬롯을 기다린 시간은 들어가지 않는다
  it('excludes the wait for a concurrency slot', async () => {
    const settled = await run(
      [
        { tileId: 'block-1', tabId: 1, intervalMs: 2000, callDurationMs: 3000 },
        { tileId: 'block-2', tabId: 2, intervalMs: 2000, callDurationMs: 3000 },
        { tileId: 'queued', tabId: 3, intervalMs: 2000, callDurationMs: 100 },
      ],
      3200,
    )

    const queued = settled.filter((entry) => entry.tileId === 'queued')
    expect(queued).toHaveLength(1)
    //+_+// 만기는 0 이었고 실제 정산은 3100 이다. 그런데 회차 소요는 호출 시간 100 뿐이다
    expect(queued[0].at).toBe(3100)
    expect(queued[0].roundDurationMs).toBe(100)
  })

  //+_+// 리스가 없으면 attach 가 회차 안에 든다. 그때만 roundDuration 과 callDuration 이 갈린다
  it('includes attach in the round but not in the call', async () => {
    const settled = await run(
      [{ tileId: 'a', tabId: 1, intervalMs: 4000, callDurationMs: 100 }],
      12000,
      { attachDurationMs: 700 },
    )

    expect(settled[0].roundDurationMs).toBe(800)
    expect(settled[0].callDurationMs).toBe(100)
    //+_+// 두 번째 회차부터는 리스를 들고 있으므로 둘이 같아진다
    expect(settled[1].roundDurationMs).toBe(100)
    expect(settled[1].callDurationMs).toBe(100)
  })

  //+_+// 리스를 들고 있는 회차에서는 두 값이 같다. 실측 로그의 2015ms 가 그 경우다
  it('makes the round equal to the call once the lease is held', async () => {
    const settled = await run(
      [{ tileId: 'a', tabId: 1, intervalMs: 2000, callDurationMs: 2018 }],
      12000,
    )
    for (const entry of settled.slice(1)) {
      expect(entry.roundDurationMs).toBe(entry.callDurationMs)
      expect(entry.roundDurationMs).toBe(2018)
    }
  })
})
