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

  for (const tile of tiles) {
    manager.register(tile.tileId, tile.tabId, tile.intervalMs)
  }

  for (let t = 0; t <= horizonMs; t += 1) {
    clock.current = t
    let acted = clock.runDue()

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

describe('N1 - the realized period is not the assigned interval', () => {
  it('turns an assigned 4000ms into a realized 5000ms', async () => {
    const settled = await run([{ tileId: 'a', tabId: 1, intervalMs: 4000, callDurationMs: 100 }], 21000)
    expect(new Set(deltas(settled, 'a'))).toEqual(new Set([5000]))
  })

  it('turns an assigned 2000ms into a realized 3000ms when the round is short', async () => {
    const settled = await run([{ tileId: 'a', tabId: 1, intervalMs: 2000, callDurationMs: 100 }], 13000)
    expect(new Set(deltas(settled, 'a'))).toEqual(new Set([3000]))
  })

  //+_+// 실측의 2x2 타일이다. 배정 2000 에 회차 소요 2018 이면 실현 주기가 5000 이 된다
  it('turns an assigned 2000ms into a realized 5000ms when the round takes 2018ms', async () => {
    const settled = await run(
      [{ tileId: 'a', tabId: 1, intervalMs: 2000, callDurationMs: 2018 }],
      23000,
    )
    expect(new Set(deltas(settled, 'a'))).toEqual(new Set([5000]))
  })

  it('cannot honour an interval shorter than the driver tick', async () => {
    const settled = await run([{ tileId: 'a', tabId: 1, intervalMs: 500, callDurationMs: 100 }], 9000)
    expect(new Set(deltas(settled, 'a'))).toEqual(new Set([1000]))
  })

  //+_+// 실현 주기는 배정 주기와 회차 소요의 합을 tick 격자로 올림한 값이다
  it('follows ceil((interval + round) / tick) * tick', async () => {
    const cases = [
      { intervalMs: 2000, callDurationMs: 100, expected: 3000 },
      { intervalMs: 2000, callDurationMs: 900, expected: 3000 },
      { intervalMs: 2000, callDurationMs: 1100, expected: 4000 },
      { intervalMs: 2000, callDurationMs: 2018, expected: 5000 },
      { intervalMs: 4000, callDurationMs: 100, expected: 5000 },
      { intervalMs: 2500, callDurationMs: 100, expected: 3000 },
    ]
    for (const value of cases) {
      const settled = await run(
        [{ tileId: 'a', tabId: 1, intervalMs: value.intervalMs, callDurationMs: value.callDurationMs }],
        value.expected * 3 + 2000,
      )
      expect(deltas(settled, 'a').slice(0, 2)).toEqual([value.expected, value.expected])
    }
  })
})

describe('N1 - tiles with different intervals collapse onto one period', () => {
  //+_+// 실측 구성이다. 1x1 두 개는 spanSmall 4000, 2x2 하나는 spanLarge 2000 이다
  const OBSERVED: SimTile[] = [
    { tileId: 'small-1', tabId: 1, intervalMs: 4000, callDurationMs: 100 },
    { tileId: 'small-2', tabId: 2, intervalMs: 4000, callDurationMs: 120 },
    { tileId: 'large', tabId: 3, intervalMs: 2000, callDurationMs: 2018 },
  ]

  //+_+// 슬롯이 2개이고 타일이 3개다. 큐 대기가 정산 시각을 밀어 실현 주기에 흔들림을 더한다
  //+_+// 실측의 4.98~5.03초와 같은 성격의 흔들림이다
  it('gives every tile about the same 5000ms period even though the intervals differ', async () => {
    const settled = await run(OBSERVED, 26000)
    for (const tile of OBSERVED) {
      const measured = deltas(settled, tile.tileId)
      expect(measured.length).toBeGreaterThanOrEqual(3)
      for (const delta of measured) {
        expect(delta).toBeGreaterThanOrEqual(4900)
        expect(delta).toBeLessThanOrEqual(5100)
        expect(delta).not.toBe(tile.intervalMs)
      }
    }
  })

  //+_+// 5000 주기 안에서 각 타일이 정확히 한 회차씩 돈다. 세 줄이 한 묶음으로 반복된다
  //+_+// 묶음 안의 순서와 간격은 회차 소요가 만든다. 2x2 는 자기 소요만큼 뒤에 찍힌다
  it('settles every tile once per 5000ms cycle', async () => {
    const settled = await run(OBSERVED, 26000)
    const cycles = new Map<number, string[]>()
    for (const entry of settled) {
      const cycle = Math.floor(entry.at / 5000)
      cycles.set(cycle, [...(cycles.get(cycle) ?? []), entry.tileId])
    }
    const full = [...cycles.values()].filter((tileIds) => tileIds.length === 3)
    expect(full.length).toBeGreaterThanOrEqual(3)
  })

  //+_+// 2x2 의 회차 소요가 배정 주기와 거의 같게 나온 것은 N2 다. 여기서는 그것이 주기에 얹히는 것만 본다
  it('reports the round duration the call took and nothing more', async () => {
    const settled = await run(OBSERVED, 12000)
    const large = settled.filter((entry) => entry.tileId === 'large')
    expect(large.map((entry) => entry.roundDurationMs)).toEqual([2018, 2018])
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
