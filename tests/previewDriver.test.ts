import { describe, expect, it } from 'vitest'
import type { DebuggerBackend } from '../src/background/debuggerSessionManager'
import { selectDueTiles } from '../src/background/previewCaptureManager'
import type { Clock, DueTileInput } from '../src/background/previewCaptureManager'
import {
  DEBUGGER_PROTOCOL_VERSION,
  DRIVER_TICK_MS,
  createPreviewEngine,
  startPreviewDriver,
} from '../src/background/serviceWorker'
import { TabManager } from '../src/background/tabManager'
import type { TabsBackend } from '../src/background/tabManager'
import { CAPTURE_INTERVAL_MS, captureStats, percentile } from '../src/shared/scheduler'
import type { CaptureStats } from '../src/shared/scheduler'
import type { BrowserTabInfo, WebTile } from '../src/shared/types'

function tile(id: string, w: number, h: number, refreshIntervalMs: number): WebTile {
  return {
    id,
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

class StubClock implements Clock {
  current = 0

  now(): number {
    return this.current
  }

  schedule(): () => void {
    return () => undefined
  }
}

class StubDebugger implements DebuggerBackend {
  readonly commands: { tabId: number; method: string }[] = []

  attach(): Promise<void> {
    return Promise.resolve()
  }

  detach(): Promise<void> {
    return Promise.resolve()
  }

  sendCommand(tabId: number, method: string): Promise<unknown> {
    this.commands.push({ tabId, method })
    return Promise.resolve({ data: 'AAAA' })
  }

  onDetach(): void {
    return undefined
  }
}

class StubTabs implements TabsBackend {
  readonly tabs = new Map<number, BrowserTabInfo>()
  private removed: ((tabId: number) => void) | null = null
  private updated: ((tabId: number, url: string) => void) | null = null

  get(tabId: number): Promise<BrowserTabInfo | null> {
    return Promise.resolve(this.tabs.get(tabId) ?? null)
  }

  onRemoved(listener: (tabId: number) => void): void {
    this.removed = listener
  }

  onUpdated(listener: (tabId: number, url: string) => void): void {
    this.updated = listener
  }

  fireRemoved(tabId: number): void {
    this.removed?.(tabId)
  }

  fireUpdated(tabId: number, url: string): void {
    this.updated?.(tabId, url)
  }
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('TASK-P3-01 item 21 - the schedule decision takes no duration statistics', () => {
  it('takes exactly the tile list and the time', () => {
    expect(selectDueTiles.length).toBe(2)
  })

  //+_+// 필드를 더하거나 빼면 컴파일이 깨진다. 지속시간 통계가 입력에 끼어들 자리가 없다
  it('accepts a tile shape of three fields, none of them a statistic', () => {
    const keys: Record<keyof DueTileInput, true> = { tileId: true, tabId: true, nextDueAt: true }

    expect(Object.keys(keys).sort()).toEqual(['nextDueAt', 'tabId', 'tileId'])
  })

  it('decides only from the due time', () => {
    const tiles: DueTileInput[] = [
      { tileId: 'b', tabId: 2, nextDueAt: 500 },
      { tileId: 'a', tabId: 1, nextDueAt: 100 },
    ]

    expect(selectDueTiles(tiles, 500).map((entry) => entry.tileId)).toEqual(['a', 'b'])
    expect(selectDueTiles(tiles, 499).map((entry) => entry.tileId)).toEqual(['a'])
  })
})

describe('TASK-P3-01 item 22 - capture statistics without an average', () => {
  const stats = captureStats({
    successDurationsMs: [45, 47, 49, 52, 763, 800, 1004],
    attempts: 10,
    timeouts: 3,
    lateArrivals: 1,
  })

  it('exposes exactly attempts, p50, p95, timeoutRate and lateArrivalRate', () => {
    const keys: Record<keyof CaptureStats, true> = {
      attempts: true,
      p50: true,
      p95: true,
      timeoutRate: true,
      lateArrivalRate: true,
    }

    expect(Object.keys(stats).sort()).toEqual(Object.keys(keys).sort())
  })

  //+_+// L22. 평균과 중앙값이 6배 차이 나므로 평균 필드를 아예 만들지 않는다
  it('names no average field under any spelling', () => {
    for (const name of ['average', 'avg', 'mean']) {
      expect(Object.hasOwn(stats, name)).toBe(false)
    }
  })

  it('reports percentiles by nearest rank without interpolating', () => {
    expect(stats.p50).toBe(52)
    expect(stats.p95).toBe(1004)
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2)
    expect(percentile([], 0.5)).toBeNull()
  })

  it('reports the timeout rate against every attempt', () => {
    expect(stats.attempts).toBe(10)
    expect(stats.timeoutRate).toBeCloseTo(0.3)
  })

  //+_+// 분모가 타임아웃 수다. 포기한 호출이 나중에라도 돌아왔는지가 L21 의 질문이다
  it('reports the late arrival rate against the timeouts', () => {
    expect(stats.lateArrivalRate).toBeCloseTo(1 / 3)
  })

  it('returns zero rates and null percentiles for an empty round', () => {
    expect(
      captureStats({ successDurationsMs: [], attempts: 0, timeouts: 0, lateArrivals: 0 }),
    ).toEqual({ attempts: 0, p50: null, p95: null, timeoutRate: 0, lateArrivalRate: 0 })
  })
})

describe('TASK-P3-01 section 2.3 - tabManager stays minimal', () => {
  it('reports whether a tab exists and returns its url and title', async () => {
    const tabs = new StubTabs()
    tabs.tabs.set(7, {
      tabId: 7,
      windowId: 1,
      currentUrl: 'https://example.com/a',
      title: 'Example',
    })
    const manager = new TabManager(tabs)

    expect(await manager.exists(7)).toBe(true)
    expect(await manager.exists(8)).toBe(false)
    expect(await manager.info(7)).toMatchObject({
      currentUrl: 'https://example.com/a',
      title: 'Example',
    })
    expect(await manager.info(8)).toBeNull()
  })

  it('fans a removal out to every listener', () => {
    const tabs = new StubTabs()
    const manager = new TabManager(tabs)
    const seen: number[] = []
    manager.onTabRemoved((tabId) => seen.push(tabId))
    manager.onTabRemoved((tabId) => seen.push(tabId * 10))

    tabs.fireRemoved(7)

    expect(seen).toEqual([7, 70])
  })

  it('fans a navigation out with the new url', () => {
    const tabs = new StubTabs()
    const manager = new TabManager(tabs)
    const seen: string[] = []
    manager.onTabNavigated((tabId, url) => seen.push(`${String(tabId)} ${url}`))

    tabs.fireUpdated(7, 'https://example.com/next')

    expect(seen).toEqual(['7 https://example.com/next'])
  })
})

describe('TASK-P3-01 section 3.6 - the driver is separate from the decision', () => {
  //+_+// 첫 회차는 등록 즉시 만기다. 주기는 그 뒤부터 관측된다
  it('picks the tile interval while the dashboard is visible', async () => {
    const clock = new StubClock()
    const engine = createPreviewEngine(new StubDebugger(), new StubTabs(), clock)

    engine.registerTile(tile('a', 1, 1, 4000), 7, true)
    engine.captures.tick()
    await flush()
    expect(engine.captures.inFlightCount).toBe(0)

    clock.current = 3999
    engine.captures.tick()
    expect(engine.captures.inFlightCount).toBe(0)

    clock.current = 4000
    engine.captures.tick()
    expect(engine.captures.inFlightCount).toBe(1)
  })

  //+_+// hidden 주기 선택은 구동자가 한다. 캡처 엔진은 받은 주기를 그대로 쓴다
  it('picks the hidden interval while the dashboard is hidden', async () => {
    const clock = new StubClock()
    const engine = createPreviewEngine(new StubDebugger(), new StubTabs(), clock)

    engine.registerTile(tile('a', 1, 1, 4000), 7, false)
    engine.captures.tick()
    await flush()

    clock.current = CAPTURE_INTERVAL_MS.dashboardHidden - 1
    engine.captures.tick()
    expect(engine.captures.inFlightCount).toBe(0)

    clock.current = CAPTURE_INTERVAL_MS.dashboardHidden
    engine.captures.tick()
    expect(engine.captures.inFlightCount).toBe(1)
  })

  it('stops the tile and releases the lease when the tab is removed', async () => {
    const clock = new StubClock()
    const tabs = new StubTabs()
    const engine = createPreviewEngine(new StubDebugger(), tabs, clock)

    engine.registerTile(tile('a', 1, 1, 4000), 7, true)
    engine.captures.tick()
    await flush()
    expect(engine.captures.statusOf('a')).not.toBeNull()

    tabs.fireRemoved(7)
    await flush()

    expect(engine.captures.statusOf('a')).toBeNull()
    expect(engine.sessions.isAttached(7)).toBe(false)
  })

  //+_+// v1 section 5.2 조건 9. navigation 뒤에도 캡처가 복구되어야 한다
  it('sends Page.enable again after a navigation', async () => {
    const clock = new StubClock()
    const tabs = new StubTabs()
    const backend = new StubDebugger()
    const engine = createPreviewEngine(backend, tabs, clock)

    engine.registerTile(tile('a', 1, 1, 4000), 7, true)
    engine.captures.tick()
    await flush()

    tabs.fireUpdated(7, 'https://example.com/next')
    clock.current = 4000
    engine.captures.tick()
    await flush()

    expect(backend.commands.map((entry) => entry.method)).toEqual([
      'Page.enable',
      'Page.captureScreenshot',
      'Page.enable',
      'Page.captureScreenshot',
    ])
  })

  it('drives ticks on an interval and stops when told to', () => {
    const clock = new StubClock()
    const engine = createPreviewEngine(new StubDebugger(), new StubTabs(), clock)
    const stop = startPreviewDriver(engine, 10_000)

    expect(DRIVER_TICK_MS).toBe(1000)
    expect(DEBUGGER_PROTOCOL_VERSION).toBe('1.3')
    expect(() => stop()).not.toThrow()
  })
})
