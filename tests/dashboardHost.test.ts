import { describe, expect, it, vi } from 'vitest'
import type { DebuggerBackend } from '../src/background/debuggerSessionManager'
import type { Clock } from '../src/background/previewCaptureManager'
import { ROUND_LOG_PREFIX, formatRoundClock } from '../src/background/roundLog'
import { createDashboardHost } from '../src/background/serviceWorker'
import type { DashboardHost, FocusTab, ListTabs } from '../src/background/serviceWorker'
import type { TabsBackend } from '../src/background/tabManager'
import { DEFAULT_PROJECT_ID } from '../src/shared/messages'
import { CAPTURE_INTERVAL_MS } from '../src/shared/scheduler'
import type { BrowserTabInfo } from '../src/shared/types'

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
  attached: number[] = []
  detached: number[] = []
  data: string | null = 'AAAA'

  attach(tabId: number): Promise<void> {
    this.attached.push(tabId)
    return Promise.resolve()
  }

  detach(tabId: number): Promise<void> {
    this.detached.push(tabId)
    return Promise.resolve()
  }

  sendCommand(): Promise<unknown> {
    if (this.data === null) {
      return Promise.reject(new Error('capture refused'))
    }
    return Promise.resolve({ data: this.data })
  }

  onDetach(): void {
    return undefined
  }
}

class StubTabs implements TabsBackend {
  readonly tabs = new Map<number, BrowserTabInfo>()
  private readonly removedListeners: ((tabId: number) => void)[] = []

  get(tabId: number): Promise<BrowserTabInfo | null> {
    return Promise.resolve(this.tabs.get(tabId) ?? null)
  }

  onRemoved(listener: (tabId: number) => void): void {
    this.removedListeners.push(listener)
  }

  //+_+// F2. 사용자가 탭을 닫은 것을 재현한다. chrome.tabs.onRemoved 다음에 그 탭은 조회되지 않는다
  closeTab(tabId: number): void {
    this.tabs.delete(tabId)
    for (const listener of this.removedListeners) {
      listener(tabId)
    }
  }

  onUpdated(): void {
    return undefined
  }
}

function tabInfo(tabId: number, url: string): BrowserTabInfo {
  return {
    tabId,
    windowId: 1,
    currentUrl: url,
    title: `title ${String(tabId)}`,
    favIconUrl: `${url}/favicon.ico`,
  }
}

interface Fixture {
  host: DashboardHost
  debuggerBackend: StubDebugger
  tabsBackend: StubTabs
  clock: StubClock
  listedWindowIds: (number | undefined)[]
  activated: { tabId: number; windowId: number }[]
}

function fixture(tabIds: number[] = [11, 12]): Fixture {
  const debuggerBackend = new StubDebugger()
  const tabsBackend = new StubTabs()
  const clock = new StubClock()
  const listedWindowIds: (number | undefined)[] = []
  const activated: { tabId: number; windowId: number }[] = []

  for (const tabId of tabIds) {
    tabsBackend.tabs.set(tabId, tabInfo(tabId, `https://example.com/${String(tabId)}`))
  }

  const listTabs: ListTabs = (windowId) => {
    listedWindowIds.push(windowId)
    return Promise.resolve([...tabsBackend.tabs.values()])
  }

  const focusTab: FocusTab = (tabId, windowId) => {
    activated.push({ tabId, windowId })
    return Promise.resolve()
  }

  return {
    host: createDashboardHost(debuggerBackend, tabsBackend, listTabs, focusTab, clock),
    debuggerBackend,
    tabsBackend,
    clock,
    listedWindowIds,
    activated,
  }
}

async function projectState(host: DashboardHost, dashboardVisible = true) {
  const response = await host.handle({
    type: 'GET_PROJECT_STATE',
    projectId: DEFAULT_PROJECT_ID,
    dashboardVisible,
  })
  if (!response.ok || response.type !== 'GET_PROJECT_STATE') {
    throw new Error(`unexpected response ${JSON.stringify(response)}`)
  }
  return response
}

describe('P4-D7 - GET_PROJECT_STATE carries the state and the frames together', () => {
  it('starts with an empty 4x4 project', async () => {
    const state = await projectState(fixture().host)
    expect(state.project).toMatchObject({ id: DEFAULT_PROJECT_ID, gridColumns: 4, gridRows: 4 })
    expect(state.project.tiles).toEqual([])
    expect(state.runtimeStates).toEqual([])
    expect(state.frames).toEqual([])
  })

  it('rejects a projectId it does not own', async () => {
    const response = await fixture().host.handle({
      type: 'GET_PROJECT_STATE',
      projectId: 'someone-else',
      dashboardVisible: true,
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'PROJECT_NOT_FOUND' })
  })

  it('reports the bound tab identity on the runtime state', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })

    const state = await projectState(host)
    expect(state.runtimeStates).toHaveLength(1)
    expect(state.runtimeStates[0]).toMatchObject({
      tileId: 't1',
      tabId: 11,
      windowId: 1,
      title: 'title 11',
      currentUrl: 'https://example.com/11',
      status: 'LOADING',
      consecutiveCaptureFailures: 0,
    })
  })

  it('carries the frame of a tile whose capture succeeded', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    host.engine.captures.tick()
    await Promise.resolve()
    await Promise.resolve()

    const state = await projectState(host)
    expect(state.frames).toEqual([
      { tileId: 't1', imageBase64: 'AAAA', format: 'jpeg', bytes: 3 },
    ])
    expect(state.runtimeStates[0]).toMatchObject({
      status: 'LIVE',
      lastCaptureAt: 0,
      lastRoundDurationMs: 0,
      consecutiveCaptureFailures: 0,
    })
  })

  it('counts a failed round without inventing a frame', async () => {
    const { host, debuggerBackend } = fixture()
    debuggerBackend.data = null
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    host.engine.captures.tick()
    await Promise.resolve()
    await Promise.resolve()

    const state = await projectState(host)
    expect(state.frames).toEqual([])
    expect(state.runtimeStates[0].consecutiveCaptureFailures).toBe(1)
    expect(Object.hasOwn(state.runtimeStates[0], 'lastCaptureAt')).toBe(false)
  })

  it('reports DETACHED once the bound tab is gone', async () => {
    const { host, tabsBackend } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    await host.engine.captures.unregister('t1')
    tabsBackend.tabs.delete(11)

    const state = await projectState(host)
    expect(state.runtimeStates[0]).toMatchObject({ tileId: 't1', tabId: 11, status: 'DETACHED' })
  })
})

describe('P4-D2 - BIND_TILE creates the tile the dev button asks for', () => {
  it('places the first two tiles side by side', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    await host.handle({ type: 'BIND_TILE', tileId: 't2', tabId: 12 })

    const state = await projectState(host)
    expect(state.project.tiles.map((tile) => [tile.x, tile.y])).toEqual([
      [0, 0],
      [1, 0],
    ])
  })

  it('takes the launch url and the interval from the bound tab and the 1x1 default', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })

    const state = await projectState(host)
    expect(state.project.tiles[0]).toMatchObject({
      id: 't1',
      launchUrl: 'https://example.com/11',
      w: 1,
      h: 1,
      refreshIntervalMs: CAPTURE_INTERVAL_MS.spanSmall,
    })
  })

  it('attaches the debugger to the bound tab on the next tick', async () => {
    const { host, debuggerBackend } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    expect(debuggerBackend.attached).toEqual([])

    host.engine.captures.tick()
    await Promise.resolve()
    expect(debuggerBackend.attached).toEqual([11])
  })

  it('refuses a tabId that does not exist', async () => {
    const { host } = fixture()
    const response = await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 999999 })
    expect(response).toMatchObject({ ok: false, type: 'BIND_TILE', errorCode: 'TAB_NOT_FOUND' })
    expect((await projectState(host)).project.tiles).toEqual([])
  })

  it('refuses to add a 17th tile and says the grid is full', async () => {
    const { host, tabsBackend } = fixture([])
    for (let index = 0; index < 17; index += 1) {
      const tabId = 100 + index
      tabsBackend.tabs.set(tabId, tabInfo(tabId, `https://example.com/${String(tabId)}`))
    }

    const responses = []
    for (let index = 0; index < 17; index += 1) {
      responses.push(
        await host.handle({ type: 'BIND_TILE', tileId: `t${String(index)}`, tabId: 100 + index }),
      )
    }

    expect(responses.slice(0, 16).every((response) => response.ok)).toBe(true)
    expect(responses[16]).toMatchObject({ ok: false, errorCode: 'GRID_FULL' })
    expect((await projectState(host)).project.tiles).toHaveLength(16)
  })

  it('rebinds an existing tile without creating a second one', async () => {
    const { host, debuggerBackend } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 12 })

    const state = await projectState(host)
    expect(state.project.tiles).toHaveLength(1)
    expect(state.runtimeStates[0]).toMatchObject({ tileId: 't1', tabId: 12 })
    expect(debuggerBackend.detached).toEqual([])
  })
})

describe('P4 - LIST_BROWSER_TABS follows the window the request came from', () => {
  it('passes the sender window id through', async () => {
    const { host, listedWindowIds } = fixture()
    const response = await host.handle({ type: 'LIST_BROWSER_TABS' }, 7)
    expect(response).toMatchObject({ ok: true, type: 'LIST_BROWSER_TABS' })
    expect(listedWindowIds).toEqual([7])
  })

  it('passes undefined when the sender has no tab', async () => {
    const { host, listedWindowIds } = fixture()
    await host.handle({ type: 'LIST_BROWSER_TABS' })
    expect(listedWindowIds).toEqual([undefined])
  })
})

describe('P4-D8 - the verbs without a Phase 4 handler fail loudly', () => {
  it('refuses CAPTURE_TILE rather than capturing on demand', async () => {
    const response = await fixture().host.handle({ type: 'CAPTURE_TILE', tileId: 't1' })
    expect(response).toMatchObject({
      ok: false,
      type: 'CAPTURE_TILE',
      errorCode: 'NOT_IMPLEMENTED',
    })
  })

  it('refuses the verbs that later stages own', async () => {
    const { host } = fixture()
    const reload = await host.handle({ type: 'RELOAD_TILE', tileId: 't1' })
    const keepAlive = await host.handle({
      type: 'SET_TILE_KEEP_ALIVE',
      tileId: 't1',
      enabled: true,
    })

    for (const response of [reload, keepAlive]) {
      expect(response).toMatchObject({ ok: false, errorCode: 'NOT_IMPLEMENTED' })
    }
  })
})

describe('F4 - every settled round leaves one console line', () => {
  it('names the tile, its span, its interval, the duration and the outcome', async () => {
    const lines: unknown[][] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args)
    })

    try {
      const { host } = fixture()
      await host.handle({ type: 'BIND_TILE', tileId: 'abcdef1234', tabId: 11 })
      host.engine.captures.tick()
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })

      //+_+// 시각은 StubClock 의 0 이다. 로컬 시간대에 따라 달라지므로 같은 함수로 만든다
      expect(lines).toHaveLength(1)
      expect(lines[0][0]).toBe(
        `${ROUND_LOG_PREFIX} ${formatRoundClock(0)} abcdef12 1x1 every ${String(CAPTURE_INTERVAL_MS.spanSmall)}ms took 0ms success 0.0kB`,
      )
    } finally {
      spy.mockRestore()
    }
  })
})

describe('F2 - a tile whose tab was closed stays DETACHED', () => {
  async function flush(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  }

  async function statusOf(host: DashboardHost, dashboardVisible: boolean): Promise<string> {
    const state = await projectState(host, dashboardVisible)
    return state.runtimeStates[0].status
  }

  async function boundTileWithFrame(): Promise<Fixture> {
    const value = fixture()
    await value.host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    value.host.engine.captures.tick()
    await flush()
    return value
  }

  it('reports DETACHED right after the user closed the tab', async () => {
    const value = await boundTileWithFrame()
    value.tabsBackend.closeTab(11)
    await flush()

    expect(await statusOf(value.host, true)).toBe('DETACHED')
  })

  it('stays DETACHED across a visibility flip and does not flash LIVE', async () => {
    const value = await boundTileWithFrame()
    value.tabsBackend.closeTab(11)
    await flush()

    expect(await statusOf(value.host, false)).toBe('DETACHED')
    expect(await statusOf(value.host, true)).toBe('DETACHED')
  })

  it('does not re-attach the debugger to a tab that is gone', async () => {
    const value = await boundTileWithFrame()
    const attachedBefore = value.debuggerBackend.attached.length
    value.tabsBackend.closeTab(11)
    await flush()

    await projectState(value.host, false)
    await projectState(value.host, true)
    value.host.engine.captures.tick()
    await flush()

    expect(value.debuggerBackend.attached).toHaveLength(attachedBefore)
  })

  it('stays DETACHED when a resize re-registers the tile', async () => {
    const value = await boundTileWithFrame()
    value.tabsBackend.closeTab(11)
    await flush()

    const response = await value.host.handle({
      type: 'SET_TILE_RECT',
      tileId: 't1',
      rect: { x: 0, y: 0, w: 2, h: 2 },
    })
    expect(response).toMatchObject({ ok: true })
    expect(await statusOf(value.host, true)).toBe('DETACHED')
  })
})

describe('P4-D11 - GET_PROJECT_STATE carries the dashboard visibility', () => {
  //+_+// attach 와 캡처가 여러 microtask 를 지난다. 회차 수를 세는 시험은 큐가 빈 뒤에 읽어야 한다
  async function settleRound(host: DashboardHost): Promise<number> {
    host.engine.captures.tick()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    return host.engine.captures.captureRecords.length
  }

  async function bindAndCapture(fixtureValue: Fixture): Promise<number> {
    await fixtureValue.host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    return settleRound(fixtureValue.host)
  }

  it('keeps the tile interval while the dashboard stays visible', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)

    value.clock.current = CAPTURE_INTERVAL_MS.spanSmall
    expect(await settleRound(value.host)).toBe(2)
  })

  it('switches to the hidden interval on the poll that changed the value', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)
    await projectState(value.host, false)

    //+_+// 재등록이 만기를 now 로 되돌리므로 그 자리에서 한 회차가 더 돈다
    expect(await settleRound(value.host)).toBe(2)

    value.clock.current = CAPTURE_INTERVAL_MS.spanSmall
    expect(await settleRound(value.host)).toBe(2)

    value.clock.current = CAPTURE_INTERVAL_MS.dashboardHidden
    expect(await settleRound(value.host)).toBe(3)
  })

  it('does not re-register on a poll that repeats the same value', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)

    value.clock.current = 1000
    await projectState(value.host, true)
    expect(await settleRound(value.host)).toBe(1)
  })

  it('goes back to the tile interval when the dashboard is visible again', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)
    await projectState(value.host, false)

    value.clock.current = 1000
    await projectState(value.host, true)
    expect(await settleRound(value.host)).toBe(2)

    value.clock.current = 1000 + CAPTURE_INTERVAL_MS.spanSmall
    expect(await settleRound(value.host)).toBe(3)
  })
})

describe('P4-D12 - SET_TILE_RECT is judged again by the worker', () => {
  it('moves a tile to an empty rect', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })

    const response = await host.handle({
      type: 'SET_TILE_RECT',
      tileId: 't1',
      rect: { x: 2, y: 3, w: 1, h: 1 },
    })
    expect(response).toMatchObject({ ok: true, type: 'SET_TILE_RECT' })
    expect((await projectState(host)).project.tiles[0]).toMatchObject({ x: 2, y: 3, w: 1, h: 1 })
  })

  it('resizes a tile and follows v1 6 for the new span interval', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })

    await host.handle({ type: 'SET_TILE_RECT', tileId: 't1', rect: { x: 0, y: 0, w: 2, h: 2 } })
    expect((await projectState(host)).project.tiles[0]).toMatchObject({
      w: 2,
      h: 2,
      refreshIntervalMs: CAPTURE_INTERVAL_MS.spanLarge,
    })
  })

  it('keeps the interval when only the position changed', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })

    await host.handle({ type: 'SET_TILE_RECT', tileId: 't1', rect: { x: 1, y: 1, w: 1, h: 1 } })
    expect((await projectState(host)).project.tiles[0]).toMatchObject({
      refreshIntervalMs: CAPTURE_INTERVAL_MS.spanSmall,
    })
  })

  it('refuses a rect that overlaps another tile and leaves the layout alone', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    await host.handle({ type: 'BIND_TILE', tileId: 't2', tabId: 12 })

    const response = await host.handle({
      type: 'SET_TILE_RECT',
      tileId: 't1',
      rect: { x: 1, y: 0, w: 1, h: 1 },
    })
    expect(response).toMatchObject({
      ok: false,
      type: 'SET_TILE_RECT',
      errorCode: 'INVALID_LAYOUT',
    })
    expect((await projectState(host)).project.tiles[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('refuses a rect that leaves the 4x4 grid', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })

    const response = await host.handle({
      type: 'SET_TILE_RECT',
      tileId: 't1',
      rect: { x: 3, y: 0, w: 2, h: 1 },
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'INVALID_LAYOUT' })
    expect((await projectState(host)).project.tiles[0]).toMatchObject({ x: 0, w: 1 })
  })

  it('lets a tile grow over the cells it already owns', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })

    const response = await host.handle({
      type: 'SET_TILE_RECT',
      tileId: 't1',
      rect: { x: 0, y: 0, w: 4, h: 4 },
    })
    expect(response).toMatchObject({ ok: true })
  })

  it('refuses a tileId the project does not have', async () => {
    const response = await fixture().host.handle({
      type: 'SET_TILE_RECT',
      tileId: 'ghost',
      rect: { x: 0, y: 0, w: 1, h: 1 },
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'TILE_NOT_FOUND' })
  })
})

describe('S3 - FOCUS_TILE activates the bound tab and its window', () => {
  it('activates the tab the tile is bound to', async () => {
    const { host, activated } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })

    const response = await host.handle({ type: 'FOCUS_TILE', tileId: 't1' })
    expect(response).toMatchObject({ ok: true, type: 'FOCUS_TILE' })
    expect(activated).toEqual([{ tabId: 11, windowId: 1 }])
  })

  it('follows the rebind rather than the first tab', async () => {
    const { host, activated } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 12 })
    await host.handle({ type: 'FOCUS_TILE', tileId: 't1' })
    expect(activated).toEqual([{ tabId: 12, windowId: 1 }])
  })

  it('refuses a tileId that is not bound', async () => {
    const { host, activated } = fixture()
    const response = await host.handle({ type: 'FOCUS_TILE', tileId: 'ghost' })
    expect(response).toMatchObject({
      ok: false,
      type: 'FOCUS_TILE',
      errorCode: 'TILE_NOT_BOUND',
    })
    expect(activated).toEqual([])
  })

  it('refuses once the bound tab is gone', async () => {
    const { host, tabsBackend, activated } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    tabsBackend.tabs.delete(11)

    const response = await host.handle({ type: 'FOCUS_TILE', tileId: 't1' })
    expect(response).toMatchObject({ ok: false, errorCode: 'TAB_NOT_FOUND' })
    expect(activated).toEqual([])
  })
})
