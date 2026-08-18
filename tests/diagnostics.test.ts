import { describe, expect, it, vi } from 'vitest'
import {
  ROUND_LOG_KEY,
  WORKER_STARTS_KEY,
  appendRoundRow,
  createRoundLogStore,
  nextWorkerStarts,
  readRoundRows,
  readWorkerStarts,
  recordWorkerStart,
} from '../src/background/diagnostics'
import type { RoundLogRow } from '../src/background/diagnostics'
import { formatCaptureRound } from '../src/background/roundLog'
import type { CaptureRoundLog } from '../src/background/roundLog'
import type { KeyValueBackend } from '../src/shared/storage'

//+_+// dashboardHost.test.ts 의 StubStorage 와 달리 읽기 횟수도 센다
//+_+// 링버퍼가 저장값을 몇 번 읽는지가 S3 의 직렬화 조건이다
class CountingStorage implements KeyValueBackend {
  readonly store = new Map<string, unknown>()
  reads = 0
  writes = 0
  failSet = false
  failGet = false

  get(key: string): Promise<unknown> {
    this.reads += 1
    if (this.failGet) {
      return Promise.reject(new Error('get refused'))
    }
    return Promise.resolve(this.store.has(key) ? this.store.get(key) : undefined)
  }

  set(key: string, value: unknown): Promise<void> {
    if (this.failSet) {
      return Promise.reject(new Error('set refused'))
    }
    this.writes += 1
    this.store.set(key, value)
    return Promise.resolve()
  }

  remove(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }
}

function entry(overrides: Partial<CaptureRoundLog> = {}): CaptureRoundLog {
  return {
    at: 1_000,
    tileId: 'aaaaaaaa-1111-2222-3333-444444444444',
    w: 1,
    h: 1,
    intervalMs: 4000,
    roundDurationMs: 100,
    callDurationMs: 90,
    outcome: 'success',
    bytes: 2048,
    frameHash: 'aabbccdd',
    scheduleIntervalMs: 4000,
    registeredTiles: 1,
    attachedTabs: 1,
    ...overrides,
  }
}

function row(at: number): RoundLogRow {
  return { at, line: `line ${String(at)}` }
}

describe('P6-D16 - the worker start record accumulates across worker lives', () => {
  it('counts the first start as one', () => {
    expect(nextWorkerStarts(undefined, 500)).toEqual({ starts: 1, recentAt: [500] })
  })

  it('adds to the stored count and keeps the times in order', () => {
    const first = nextWorkerStarts(undefined, 500)
    const second = nextWorkerStarts(first, 900)

    expect(second).toEqual({ starts: 2, recentAt: [500, 900] })
  })

  //+_+// 누적 횟수는 절단되지 않는다. 목록만 잘린다
  it('keeps only the most recent N times and never loses the total', () => {
    let record = nextWorkerStarts(undefined, 0, 3)
    for (const at of [1, 2, 3, 4]) {
      record = nextWorkerStarts(record, at, 3)
    }

    expect(record).toEqual({ starts: 5, recentAt: [2, 3, 4] })
  })

  it('starts over rather than trusting a damaged value', () => {
    for (const damaged of [null, 42, 'text', [], { starts: 'many' }, { starts: 1 }]) {
      expect(readWorkerStarts(damaged)).toEqual({ starts: 0, recentAt: [] })
    }
  })

  it('drops non numeric times out of a stored list', () => {
    expect(readWorkerStarts({ starts: 2, recentAt: [1, 'x', 3] })).toEqual({
      starts: 2,
      recentAt: [1, 3],
    })
  })
})

describe('P6-D16 - recording a worker start never blocks the start', () => {
  it('writes the record under its own key', async () => {
    const storage = new CountingStorage()
    await recordWorkerStart(storage, 777)

    expect(storage.store.get(WORKER_STARTS_KEY)).toEqual({ starts: 1, recentAt: [777] })
  })

  it('does not touch the state key', async () => {
    const storage = new CountingStorage()
    await recordWorkerStart(storage, 777)

    expect([...storage.store.keys()]).toEqual([WORKER_STARTS_KEY])
  })

  //+_+// S1. 삼키되 콘솔에 1줄 남긴다. 던지면 기동이 막힌다
  it('swallows a write failure and leaves one console line', async () => {
    const storage = new CountingStorage()
    storage.failSet = true
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await expect(recordWorkerStart(storage, 1)).resolves.toBeUndefined()
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('swallows a read failure too', async () => {
    const storage = new CountingStorage()
    storage.failGet = true
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await expect(recordWorkerStart(storage, 1)).resolves.toBeUndefined()
      expect(storage.writes).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('P6-D18 - the round ring buffer has an upper bound', () => {
  it('appends in arrival order', () => {
    expect(appendRoundRow([row(1)], row(2), 10)).toEqual([row(1), row(2)])
  })

  //+_+// 경계다. 상한과 같은 수까지는 아무것도 버리지 않는다
  it('keeps every row up to the limit', () => {
    const filled = [row(1), row(2)]
    expect(appendRoundRow(filled, row(3), 3)).toEqual([row(1), row(2), row(3)])
  })

  it('drops the oldest row once the limit is passed', () => {
    const filled = [row(1), row(2), row(3)]
    expect(appendRoundRow(filled, row(4), 3)).toEqual([row(2), row(3), row(4)])
  })

  it('ignores a stored value that is not an array', () => {
    for (const damaged of [undefined, null, 5, 'text', { rows: [] }]) {
      expect(readRoundRows(damaged)).toEqual([])
    }
  })

  it('drops rows that do not carry both a time and a line', () => {
    expect(readRoundRows([row(1), { at: 2 }, { line: 'x' }, 7, null, row(3)])).toEqual([
      row(1),
      row(3),
    ])
  })
})

describe('P6-D18 - the round store writes the console line under its own key', () => {
  it('stores the same line the console gets', async () => {
    const storage = new CountingStorage()
    const store = createRoundLogStore(storage)
    const settled = entry()

    await store.append(settled)

    expect(storage.store.get(ROUND_LOG_KEY)).toEqual([
      { at: settled.at, line: formatCaptureRound(settled) },
    ])
  })

  it('continues a list that an earlier worker life left behind', async () => {
    const storage = new CountingStorage()
    storage.store.set(ROUND_LOG_KEY, [row(1)])

    await createRoundLogStore(storage).append(entry({ at: 2 }))

    expect(readRoundRows(storage.store.get(ROUND_LOG_KEY))).toHaveLength(2)
  })

  //+_+// 저장값은 첫 회차에서만 읽는다. 그 뒤로는 메모리 버퍼가 정본이다
  it('reads the stored value once and then keeps the buffer in memory', async () => {
    const storage = new CountingStorage()
    const store = createRoundLogStore(storage)

    await store.append(entry({ at: 1 }))
    await store.append(entry({ at: 2 }))
    await store.append(entry({ at: 3 }))

    expect(storage.reads).toBe(1)
    expect(readRoundRows(storage.store.get(ROUND_LOG_KEY))).toHaveLength(3)
  })

  //+_+// 회차 2개가 동시에 정산될 수 있다. 읽고 쓰는 사이에 서로를 덮으면 행이 조용히 사라진다
  it('loses no row when two rounds settle at the same time', async () => {
    const storage = new CountingStorage()
    const store = createRoundLogStore(storage)

    await Promise.all([store.append(entry({ at: 1 })), store.append(entry({ at: 2 }))])

    expect(readRoundRows(storage.store.get(ROUND_LOG_KEY)).map((stored) => stored.at)).toEqual([
      1, 2,
    ])
  })

  it('drops the oldest row at the limit', async () => {
    const storage = new CountingStorage()
    const store = createRoundLogStore(storage, 2)

    for (const at of [1, 2, 3]) {
      await store.append(entry({ at }))
    }

    expect(readRoundRows(storage.store.get(ROUND_LOG_KEY)).map((stored) => stored.at)).toEqual([
      2, 3,
    ])
  })
})

describe('P6-D18 - a failing ring buffer write does not reject', () => {
  it('resolves even when the backend refuses the write', async () => {
    const storage = new CountingStorage()
    storage.failSet = true

    await expect(createRoundLogStore(storage).append(entry())).resolves.toBeUndefined()
  })

  //+_+// 실패 회차의 버퍼를 버리므로 다음 회차가 저장값을 다시 읽는다
  it('rereads the stored value after a failed write', async () => {
    const storage = new CountingStorage()
    const store = createRoundLogStore(storage)
    storage.failSet = true
    await store.append(entry({ at: 1 }))

    storage.failSet = false
    await store.append(entry({ at: 2 }))

    expect(storage.reads).toBe(2)
    expect(readRoundRows(storage.store.get(ROUND_LOG_KEY)).map((stored) => stored.at)).toEqual([2])
  })

  it('keeps recording after a failure', async () => {
    const storage = new CountingStorage()
    const store = createRoundLogStore(storage)
    storage.failSet = true
    await store.append(entry({ at: 1 }))
    storage.failSet = false

    await store.append(entry({ at: 2 }))
    await store.append(entry({ at: 3 }))

    expect(readRoundRows(storage.store.get(ROUND_LOG_KEY)).map((stored) => stored.at)).toEqual([
      2, 3,
    ])
  })
})
