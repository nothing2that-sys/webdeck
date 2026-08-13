import { describe, expect, it } from 'vitest'
import type { DebuggerBackend } from '../src/background/debuggerSessionManager'
import type { Clock } from '../src/background/previewCaptureManager'
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

  get(tabId: number): Promise<BrowserTabInfo | null> {
    return Promise.resolve(this.tabs.get(tabId) ?? null)
  }

  onRemoved(): void {
    return undefined
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

async function projectState(host: DashboardHost) {
  const response = await host.handle({ type: 'GET_PROJECT_STATE', projectId: DEFAULT_PROJECT_ID })
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
