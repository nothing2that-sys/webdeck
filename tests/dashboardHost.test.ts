import { describe, expect, it, vi } from 'vitest'
import type { DebuggerBackend } from '../src/background/debuggerSessionManager'
import type { Clock } from '../src/background/previewCaptureManager'
import { ROUND_LOG_PREFIX, formatRoundClock, frameFingerprint } from '../src/background/roundLog'
import { createDashboardHost, excludeOwnPages } from '../src/background/serviceWorker'
import type { CreateTab, DashboardHost, FocusTab, ListTabs } from '../src/background/serviceWorker'
import type { TabsBackend } from '../src/background/tabManager'
import { DEFAULT_PROJECT_ID } from '../src/shared/messages'
import type { TileSettings } from '../src/shared/messages'
import { CAPTURE_INTERVAL_MS, tileIntervalMs } from '../src/shared/scheduler'
import { STORAGE_KEY } from '../src/shared/storage'
import type { KeyValueBackend } from '../src/shared/storage'
import type { BrowserTabInfo, WebTile } from '../src/shared/types'

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

//+_+// S1. 워커의 영구화 배선을 시험한다. chrome.storage 어댑터 자체는 Chrome 실측 항목이다
class StubStorage implements KeyValueBackend {
  readonly store = new Map<string, unknown>()
  writes = 0

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.store.has(key) ? this.store.get(key) : undefined)
  }

  set(key: string, value: unknown): Promise<void> {
    this.writes += 1
    this.store.set(key, value)
    return Promise.resolve()
  }

  remove(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }
}

interface Fixture {
  host: DashboardHost
  debuggerBackend: StubDebugger
  tabsBackend: StubTabs
  clock: StubClock
  storage: StubStorage
  createdUrls: string[]
  activated: { tabId: number; windowId: number }[]
}

function fixture(tabIds: number[] = [11, 12], storage = new StubStorage()): Fixture {
  const debuggerBackend = new StubDebugger()
  const tabsBackend = new StubTabs()
  const clock = new StubClock()
  const createdUrls: string[] = []
  const activated: { tabId: number; windowId: number }[] = []

  for (const tabId of tabIds) {
    tabsBackend.tabs.set(tabId, tabInfo(tabId, `https://example.com/${String(tabId)}`))
  }

  //+_+// P5-D12. 창 인자가 사라졌다. 창 제한은 chromeListTabs 안의 query 로만 남는다
  const listTabs: ListTabs = () => Promise.resolve([...tabsBackend.tabs.values()])

  const focusTab: FocusTab = (tabId, windowId) => {
    activated.push({ tabId, windowId })
    return Promise.resolve()
  }

  //+_+// P5-D27 의 url 경로다. 워커가 탭을 만든다. 새 탭 id 는 기존과 겹치지 않게 고른다
  const createTab: CreateTab = (url) => {
    createdUrls.push(url)
    const created = { ...tabInfo(900 + createdUrls.length, url), currentUrl: url }
    tabsBackend.tabs.set(created.tabId, created)
    return Promise.resolve(created)
  }

  return {
    host: createDashboardHost(
      debuggerBackend,
      tabsBackend,
      listTabs,
      focusTab,
      createTab,
      storage,
      clock,
    ),
    debuggerBackend,
    tabsBackend,
    clock,
    storage,
    createdUrls,
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

//+_+// P5-D12. J16 의 창 제한을 걷어냈다. 확장 자신의 페이지를 빼는 나머지 절반은 남는다
describe('P5-D12 - LIST_BROWSER_TABS no longer narrows by window', () => {
  it('returns every tab the adapter reports', async () => {
    const { host } = fixture()
    const response = await host.handle({ type: 'LIST_BROWSER_TABS' })
    expect(response).toMatchObject({ ok: true, type: 'LIST_BROWSER_TABS' })
    if (!response.ok || response.type !== 'LIST_BROWSER_TABS') {
      throw new Error('unexpected response')
    }
    expect(response.tabs.map((tab) => tab.tabId)).toEqual([11, 12])
  })

  it('carries tabs from more than one window', async () => {
    const { host, tabsBackend } = fixture()
    tabsBackend.tabs.set(21, { ...tabInfo(21, 'https://example.com/21'), windowId: 5 })

    const response = await host.handle({ type: 'LIST_BROWSER_TABS' })
    if (!response.ok || response.type !== 'LIST_BROWSER_TABS') {
      throw new Error('unexpected response')
    }
    expect(response.tabs.map((tab) => tab.windowId)).toEqual([1, 1, 5])
  })
})

describe('J16 - the extension keeps its own pages out of the tab list', () => {
  const own = 'chrome-extension://abcdef/'

  it('drops a tab whose url starts with the extension origin', () => {
    const tabs = [tabInfo(11, 'https://example.com/11'), tabInfo(12, `${own}dashboard.html`)]
    expect(excludeOwnPages(tabs, own).map((tab) => tab.tabId)).toEqual([11])
  })

  it('keeps every tab when none of them is the extension', () => {
    const tabs = [tabInfo(11, 'https://example.com/11'), tabInfo(12, 'https://example.com/12')]
    expect(excludeOwnPages(tabs, own)).toHaveLength(2)
  })

  //+_+// 다른 확장의 페이지는 남긴다. 재귀 캡처가 되는 것은 자기 자신뿐이다
  it('keeps a page that belongs to a different extension', () => {
    const tabs = [tabInfo(11, 'chrome-extension://zzzzzz/panel.html')]
    expect(excludeOwnPages(tabs, own)).toHaveLength(1)
  })

  it('drops nothing from an empty list', () => {
    expect(excludeOwnPages([], own)).toEqual([])
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
      //+_+// N2. 해시는 응답 본문 AAAA 에서 나온다. 값을 손으로 적지 않고 같은 함수로 만든다
      expect(lines).toHaveLength(1)
      expect(lines[0][0]).toBe(
        `${ROUND_LOG_PREFIX} ${formatRoundClock(0)} abcdef12 1x1 every ${String(CAPTURE_INTERVAL_MS.spanSmall)}ms took 0ms call 0ms success 0.0kB ${frameFingerprint('AAAA')}`,
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

//+_+// P5-D23. v1 section 19 에 대응 항목이 없는 5개다. 명명 규칙만 따랐다
describe('P5-D23 - project CRUD and switching', () => {
  async function listProjects(host: DashboardHost) {
    const response = await host.handle({ type: 'LIST_PROJECTS' })
    if (!response.ok || response.type !== 'LIST_PROJECTS') {
      throw new Error(`unexpected response ${JSON.stringify(response)}`)
    }
    return response
  }

  async function addProject(host: DashboardHost, name: string): Promise<string> {
    const response = await host.handle({ type: 'CREATE_PROJECT', name })
    if (!response.ok || response.type !== 'CREATE_PROJECT') {
      throw new Error(`unexpected response ${JSON.stringify(response)}`)
    }
    return response.project.id
  }

  it('starts with the default project active', async () => {
    const listed = await listProjects(fixture().host)
    expect(listed.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(listed.projects.map((project) => project.id)).toEqual([DEFAULT_PROJECT_ID])
  })

  //+_+// 생성은 생성만 한다. 전환은 SET_ACTIVE_PROJECT 다. J82
  it('creates a project without switching to it', async () => {
    const { host } = fixture()
    const created = await addProject(host, 'Monitoring')

    const listed = await listProjects(host)
    expect(listed.projects.map((project) => project.name)).toEqual(['WebDeck', 'Monitoring'])
    expect(created).not.toBe(DEFAULT_PROJECT_ID)
    expect(listed.activeProjectId).toBe(DEFAULT_PROJECT_ID)
  })

  it('renames a project', async () => {
    const { host } = fixture()
    const response = await host.handle({
      type: 'RENAME_PROJECT',
      projectId: DEFAULT_PROJECT_ID,
      name: 'Renamed',
    })

    expect(response).toMatchObject({ ok: true, type: 'RENAME_PROJECT' })
    expect((await listProjects(host)).projects[0].name).toBe('Renamed')
  })

  it('refuses to rename a project it does not have', async () => {
    const response = await fixture().host.handle({
      type: 'RENAME_PROJECT',
      projectId: 'ghost',
      name: 'Renamed',
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'PROJECT_NOT_FOUND' })
  })

  it('switches the active project', async () => {
    const { host } = fixture()
    const created = await addProject(host, 'Monitoring')

    const response = await host.handle({ type: 'SET_ACTIVE_PROJECT', projectId: created })
    expect(response).toMatchObject({ ok: true, type: 'SET_ACTIVE_PROJECT' })
    expect((await listProjects(host)).activeProjectId).toBe(created)
  })

  it('refuses to switch to a project it does not have', async () => {
    const response = await fixture().host.handle({
      type: 'SET_ACTIVE_PROJECT',
      projectId: 'ghost',
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'PROJECT_NOT_FOUND' })
  })

  it('lets GET_PROJECT_STATE follow the project that is active', async () => {
    const { host } = fixture()
    const created = await addProject(host, 'Monitoring')
    await host.handle({ type: 'SET_ACTIVE_PROJECT', projectId: created })

    const stale = await host.handle({
      type: 'GET_PROJECT_STATE',
      projectId: DEFAULT_PROJECT_ID,
      dashboardVisible: true,
    })
    expect(stale).toMatchObject({ ok: false, errorCode: 'PROJECT_NOT_FOUND' })

    const fresh = await host.handle({
      type: 'GET_PROJECT_STATE',
      projectId: created,
      dashboardVisible: true,
    })
    expect(fresh).toMatchObject({ ok: true, type: 'GET_PROJECT_STATE' })
  })

  it('deletes a project', async () => {
    const { host } = fixture()
    const created = await addProject(host, 'Monitoring')

    const response = await host.handle({ type: 'DELETE_PROJECT', projectId: created })
    expect(response).toMatchObject({ ok: true, type: 'DELETE_PROJECT' })
    expect((await listProjects(host)).projects.map((project) => project.id)).toEqual([
      DEFAULT_PROJECT_ID,
    ])
  })

  //+_+// P5-D23. DELETE 를 거부하지 않는다. 목록이 비면 기본 프로젝트가 다시 선다. P5-D8
  it('stands a fresh default project up after the last one is deleted', async () => {
    const { host } = fixture()
    const response = await host.handle({ type: 'DELETE_PROJECT', projectId: DEFAULT_PROJECT_ID })

    expect(response).toMatchObject({ ok: true })
    const listed = await listProjects(host)
    expect(listed.projects.map((project) => project.id)).toEqual([DEFAULT_PROJECT_ID])
    expect(listed.projects[0].tiles).toEqual([])
    expect(listed.activeProjectId).toBe(DEFAULT_PROJECT_ID)
  })

  it('moves the active project when the active one was deleted', async () => {
    const { host } = fixture()
    const created = await addProject(host, 'Monitoring')
    await host.handle({ type: 'DELETE_PROJECT', projectId: DEFAULT_PROJECT_ID })

    expect((await listProjects(host)).activeProjectId).toBe(created)
  })

  it('refuses to delete a project it does not have', async () => {
    const response = await fixture().host.handle({ type: 'DELETE_PROJECT', projectId: 'ghost' })
    expect(response).toMatchObject({ ok: false, errorCode: 'PROJECT_NOT_FOUND' })
  })
})

describe('S1 - the worker persists the project list', () => {
  it('writes the state when a project is created', async () => {
    const { host, storage } = fixture()
    await host.handle({ type: 'CREATE_PROJECT', name: 'Monitoring' })

    expect(storage.writes).toBeGreaterThan(0)
    expect(storage.store.get(STORAGE_KEY)).toMatchObject({ schemaVersion: 2 })
  })

  it('restores the stored projects on load', async () => {
    const storage = new StubStorage()
    const seeded = fixture([11, 12], storage)
    const created = await seeded.host.handle({ type: 'CREATE_PROJECT', name: 'Monitoring' })
    if (!created.ok || created.type !== 'CREATE_PROJECT') {
      throw new Error('create failed')
    }
    await seeded.host.handle({ type: 'SET_ACTIVE_PROJECT', projectId: created.project.id })

    const restored = fixture([11, 12], storage)
    await restored.host.load()

    const response = await restored.host.handle({ type: 'LIST_PROJECTS' })
    expect(response).toMatchObject({ ok: true, activeProjectId: created.project.id })
  })

  //+_+// P5-D8. 저장된 적이 없는 상태에서도 기본 프로젝트 1개가 선다
  it('stands the default project up when storage is empty', async () => {
    const { host } = fixture()
    await host.load()

    const response = await host.handle({ type: 'LIST_PROJECTS' })
    expect(response).toMatchObject({ ok: true, activeProjectId: DEFAULT_PROJECT_ID })
  })

  //+_+// P5-D17. 거부된 저장값을 조용히 덮어쓰지 않는다. 기본 프로젝트로 서고 사실을 남긴다
  it('falls back to the default project when the stored envelope is rejected', async () => {
    const storage = new StubStorage()
    storage.store.set(STORAGE_KEY, { schemaVersion: 1, projects: [] })

    const { host } = fixture([11, 12], storage)
    const result = await host.load()

    expect(result).toMatchObject({ ok: false, errorCode: 'SCHEMA_VERSION_MISMATCH' })
    const response = await host.handle({ type: 'LIST_PROJECTS' })
    expect(response).toMatchObject({ ok: true, activeProjectId: DEFAULT_PROJECT_ID })
  })

})

describe('S1 - switching a project stops capturing the one that left', () => {
  async function switchTo(host: DashboardHost, name: string): Promise<string> {
    const created = await host.handle({ type: 'CREATE_PROJECT', name })
    if (!created.ok || created.type !== 'CREATE_PROJECT') {
      throw new Error('create failed')
    }
    await host.handle({ type: 'SET_ACTIVE_PROJECT', projectId: created.project.id })
    return created.project.id
  }

  it('unregisters the tiles of the outgoing project', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    expect(host.engine.captures.statusOf('t1')).not.toBeNull()

    await switchTo(host, 'Monitoring')
    expect(host.engine.captures.statusOf('t1')).toBeNull()
  })

  it('registers the tiles of the incoming project again', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })

    await switchTo(host, 'Monitoring')
    await host.handle({ type: 'SET_ACTIVE_PROJECT', projectId: DEFAULT_PROJECT_ID })

    expect(host.engine.captures.statusOf('t1')).not.toBeNull()
  })

  it('unregisters the tiles of a project that was deleted', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })

    await host.handle({ type: 'DELETE_PROJECT', projectId: DEFAULT_PROJECT_ID })
    expect(host.engine.captures.statusOf('t1')).toBeNull()
  })
})

//+_+// P5-D27. v1 section 9.1 의 두 경로다. BIND_TILE 을 확장하지 않고 별도 요청으로 둔다
describe('P5-D27 - ADD_TILE covers the two v1 9.1 paths', () => {
  async function addTile(
    host: DashboardHost,
    source: { kind: 'tab'; tabId: number } | { kind: 'url'; url: string },
  ): Promise<string> {
    const response = await host.handle({ type: 'ADD_TILE', source })
    if (!response.ok || response.type !== 'ADD_TILE') {
      throw new Error(`unexpected response ${JSON.stringify(response)}`)
    }
    return response.tileId
  }

  async function tilesOf(host: DashboardHost) {
    return (await projectState(host)).project.tiles
  }

  //+_+// launchUrl 이 비면 S6 의 URL 기반 재연결이 성립하지 않는다. 이 단계의 조용한 핵심이다
  it('fills launchUrl from the current url of the chosen tab', async () => {
    const { host } = fixture()
    const tileId = await addTile(host, { kind: 'tab', tabId: 11 })

    const tiles = await tilesOf(host)
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toMatchObject({ id: tileId, launchUrl: 'https://example.com/11' })
  })

  it('fills launchUrl from the url that was typed', async () => {
    const { host, createdUrls } = fixture()
    const tileId = await addTile(host, { kind: 'url', url: 'https://example.org/dash' })

    expect(createdUrls).toEqual(['https://example.org/dash'])
    const tiles = await tilesOf(host)
    expect(tiles[0]).toMatchObject({ id: tileId, launchUrl: 'https://example.org/dash' })
  })

  it('binds the tile to the tab it was given', async () => {
    const { host } = fixture()
    const tileId = await addTile(host, { kind: 'tab', tabId: 12 })

    const state = await projectState(host)
    expect(state.runtimeStates[0]).toMatchObject({ tileId, tabId: 12 })
  })

  it('binds the tile to the tab the worker created', async () => {
    const { host } = fixture()
    const tileId = await addTile(host, { kind: 'url', url: 'https://example.org/dash' })

    const state = await projectState(host)
    expect(state.runtimeStates[0]).toMatchObject({ tileId, tabId: 901 })
  })

  //+_+// P5-D28. 오매칭보다 미매칭이 안전한 실패다
  it('uses exact as the matchMode default', async () => {
    const { host } = fixture()
    await addTile(host, { kind: 'tab', tabId: 11 })
    expect((await tilesOf(host))[0].matchMode).toBe('exact')
  })

  it('places the tile in the first free 1x1 slot', async () => {
    const { host } = fixture()
    await addTile(host, { kind: 'tab', tabId: 11 })
    await addTile(host, { kind: 'tab', tabId: 12 })

    expect((await tilesOf(host)).map((tile) => [tile.x, tile.y, tile.w, tile.h])).toEqual([
      [0, 0, 1, 1],
      [1, 0, 1, 1],
    ])
  })

  it('gives every tile its own id', async () => {
    const { host } = fixture()
    const first = await addTile(host, { kind: 'tab', tabId: 11 })
    const second = await addTile(host, { kind: 'tab', tabId: 12 })
    expect(first).not.toBe(second)
  })

  it('refuses a 17th tile and says the grid is full', async () => {
    const { host, tabsBackend } = fixture([])
    for (let index = 0; index < 16; index += 1) {
      const tabId = 100 + index
      tabsBackend.tabs.set(tabId, tabInfo(tabId, `https://example.com/${String(tabId)}`))
      await addTile(host, { kind: 'tab', tabId })
    }

    const response = await host.handle({ type: 'ADD_TILE', source: { kind: 'tab', tabId: 200 } })
    expect(response).toMatchObject({ ok: false, type: 'ADD_TILE', errorCode: 'GRID_FULL' })
  })

  it('refuses a tabId that does not exist', async () => {
    const { host } = fixture()
    const response = await host.handle({
      type: 'ADD_TILE',
      source: { kind: 'tab', tabId: 999999 },
    })
    expect(response).toMatchObject({ ok: false, type: 'ADD_TILE', errorCode: 'TAB_NOT_FOUND' })
    expect(await tilesOf(host)).toEqual([])
  })

  //+_+// 자리가 없으면 탭을 만들지 않는다. 만들고 버리면 사용자 탭이 남는다
  it('does not create a tab when the grid is already full', async () => {
    const { host, tabsBackend, createdUrls } = fixture([])
    for (let index = 0; index < 16; index += 1) {
      const tabId = 100 + index
      tabsBackend.tabs.set(tabId, tabInfo(tabId, `https://example.com/${String(tabId)}`))
      await addTile(host, { kind: 'tab', tabId })
    }

    const response = await host.handle({
      type: 'ADD_TILE',
      source: { kind: 'url', url: 'https://example.org/dash' },
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'GRID_FULL' })
    expect(createdUrls).toEqual([])
  })

  it('attaches the debugger to the new tile on the next tick', async () => {
    const { host, debuggerBackend } = fixture()
    await addTile(host, { kind: 'tab', tabId: 11 })

    host.engine.captures.tick()
    await Promise.resolve()
    expect(debuggerBackend.attached).toEqual([11])
  })

  //+_+// J88. 타일의 존재는 프로젝트 내용이다. 레이아웃 저장(S4)과 다른 것으로 본다
  it('persists the new tile', async () => {
    const { host, storage } = fixture()
    const before = storage.writes
    await addTile(host, { kind: 'tab', tabId: 11 })
    expect(storage.writes).toBeGreaterThan(before)
  })

  it('adds the tile to the project that is active', async () => {
    const { host } = fixture()
    const created = await host.handle({ type: 'CREATE_PROJECT', name: 'Monitoring' })
    if (!created.ok || created.type !== 'CREATE_PROJECT') {
      throw new Error('create failed')
    }
    await host.handle({ type: 'SET_ACTIVE_PROJECT', projectId: created.project.id })
    await addTile(host, { kind: 'tab', tabId: 11 })

    const listed = await host.handle({ type: 'LIST_PROJECTS' })
    if (!listed.ok || listed.type !== 'LIST_PROJECTS') {
      throw new Error('list failed')
    }
    expect(listed.projects[0].tiles).toEqual([])
    expect(listed.projects[1].tiles).toHaveLength(1)
  })
})

//+_+// P5-D31. 부분 갱신을 만들지 않는다. 4필드를 전부 싣는 전체 교체다
describe('P5-D31 - SET_TILE_SETTINGS replaces all four fields', () => {
  const DEFAULTS: TileSettings = {
    customTitle: '',
    fitMode: 'contain',
    matchMode: 'exact',
    refreshIntervalOverrideMs: null,
  }

  async function boundTile(value = fixture()): Promise<{ value: Fixture; tileId: string }> {
    const response = await value.host.handle({
      type: 'ADD_TILE',
      source: { kind: 'tab', tabId: 11 },
    })
    if (!response.ok || response.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }
    return { value, tileId: response.tileId }
  }

  async function settingsOf(host: DashboardHost, tileId: string) {
    const tile = (await projectState(host)).project.tiles.find((item) => item.id === tileId)
    if (tile === undefined) {
      throw new Error(`no tile ${tileId}`)
    }
    return tile
  }

  it('writes all four fields onto the tile', async () => {
    const { value, tileId } = await boundTile()
    const response = await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: {
        customTitle: 'Named',
        fitMode: 'cover',
        matchMode: 'prefix',
        refreshIntervalOverrideMs: 9000,
      },
    })

    expect(response).toMatchObject({ ok: true, type: 'SET_TILE_SETTINGS' })
    expect(await settingsOf(value.host, tileId)).toMatchObject({
      customTitle: 'Named',
      fitMode: 'cover',
      matchMode: 'prefix',
      refreshIntervalOverrideMs: 9000,
    })
  })

  //+_+// P5-D31. 빈 문자열이 미지정이다. v1 section 15.7 이 비면 페이지 title 을 쓰라고 한다
  it('drops the custom title rather than storing an empty string', async () => {
    const { value, tileId } = await boundTile()
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, customTitle: 'Named' },
    })
    await value.host.handle({ type: 'SET_TILE_SETTINGS', tileId, settings: DEFAULTS })

    const tile = await settingsOf(value.host, tileId)
    expect(Object.hasOwn(tile, 'customTitle')).toBe(false)
  })

  //+_+// P5-D16. null 이면 span 배정으로 돌아간다
  it('drops the override rather than storing null', async () => {
    const { value, tileId } = await boundTile()
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, refreshIntervalOverrideMs: 9000 },
    })
    await value.host.handle({ type: 'SET_TILE_SETTINGS', tileId, settings: DEFAULTS })

    const tile = await settingsOf(value.host, tileId)
    expect(Object.hasOwn(tile, 'refreshIntervalOverrideMs')).toBe(false)
    expect(tile.refreshIntervalMs).toBe(CAPTURE_INTERVAL_MS.spanSmall)
  })

  it('leaves the span assigned refreshIntervalMs alone', async () => {
    const { value, tileId } = await boundTile()
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, refreshIntervalOverrideMs: 9000 },
    })
    expect((await settingsOf(value.host, tileId)).refreshIntervalMs).toBe(
      CAPTURE_INTERVAL_MS.spanSmall,
    )
  })

  //+_+// P5-D26. 화면 검증을 신뢰하지 않는다. 워커가 다시 판정한다. P4-D12 선례다
  it('refuses an override below the floor', async () => {
    const { value, tileId } = await boundTile()
    for (const bad of [249, 0, -1, 250.5]) {
      const response = await value.host.handle({
        type: 'SET_TILE_SETTINGS',
        tileId,
        settings: { ...DEFAULTS, refreshIntervalOverrideMs: bad },
      })
      expect(response).toMatchObject({ ok: false, errorCode: 'INVALID_INTERVAL' })
    }
    expect(Object.hasOwn(await settingsOf(value.host, tileId), 'refreshIntervalOverrideMs')).toBe(
      false,
    )
  })

  it('accepts the floor itself', async () => {
    const { value, tileId } = await boundTile()
    const response = await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, refreshIntervalOverrideMs: 250 },
    })
    expect(response).toMatchObject({ ok: true })
  })

  it('refuses a tileId the project does not have', async () => {
    const response = await fixture().host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId: 'ghost',
      settings: DEFAULTS,
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'TILE_NOT_FOUND' })
  })

  it('persists the change', async () => {
    const { value, tileId } = await boundTile()
    const before = value.storage.writes
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, customTitle: 'Named' },
    })
    expect(value.storage.writes).toBeGreaterThan(before)
  })

  it('does not persist a rejected change', async () => {
    const { value, tileId } = await boundTile()
    const before = value.storage.writes
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, refreshIntervalOverrideMs: 10 },
    })
    expect(value.storage.writes).toBe(before)
  })
})

//+_+// J27 의 Resize 배선과 같은 성질이다. 주기를 바꾼 것만 재등록한다
describe('S3 - only an interval change re-registers the tile', () => {
  const DEFAULTS: TileSettings = {
    customTitle: '',
    fitMode: 'contain',
    matchMode: 'exact',
    refreshIntervalOverrideMs: null,
  }

  async function settleRound(value: Fixture): Promise<number> {
    value.host.engine.captures.tick()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    return value.host.engine.captures.captureRecords.length
  }

  async function tileWithOneRound(): Promise<{ value: Fixture; tileId: string }> {
    const value = fixture()
    const response = await value.host.handle({
      type: 'ADD_TILE',
      source: { kind: 'tab', tabId: 11 },
    })
    if (!response.ok || response.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }
    expect(await settleRound(value)).toBe(1)
    return { value, tileId: response.tileId }
  }

  //+_+// 재등록은 만기를 now 로 되돌린다. 그 자리에서 한 회차가 더 도는 것으로 관측한다
  it('re-registers when the override changes', async () => {
    const { value, tileId } = await tileWithOneRound()
    value.clock.current = 1000

    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, refreshIntervalOverrideMs: 9000 },
    })
    expect(await settleRound(value)).toBe(2)
  })

  it('runs on the new interval after the change', async () => {
    const { value, tileId } = await tileWithOneRound()
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, refreshIntervalOverrideMs: 9000 },
    })
    expect(await settleRound(value)).toBe(2)

    value.clock.current = CAPTURE_INTERVAL_MS.spanSmall
    expect(await settleRound(value)).toBe(2)

    value.clock.current = 9000
    expect(await settleRound(value)).toBe(3)
  })

  it('does not re-register when only matchMode changed', async () => {
    const { value, tileId } = await tileWithOneRound()
    value.clock.current = 1000

    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, matchMode: 'prefix' },
    })
    expect(await settleRound(value)).toBe(1)
  })

  it('does not re-register when only the title and the fit mode changed', async () => {
    const { value, tileId } = await tileWithOneRound()
    value.clock.current = 1000

    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, customTitle: 'Named', fitMode: 'cover' },
    })
    expect(await settleRound(value)).toBe(1)
  })

  it('re-registers when the override is cleared', async () => {
    const { value, tileId } = await tileWithOneRound()
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: { ...DEFAULTS, refreshIntervalOverrideMs: 9000 },
    })
    expect(await settleRound(value)).toBe(2)

    value.clock.current = 1000
    await value.host.handle({ type: 'SET_TILE_SETTINGS', tileId, settings: DEFAULTS })
    expect(await settleRound(value)).toBe(3)
  })
})

//+_+// P5-D14. Drop 성공 시점이다. Edit Layout 종료를 기다리지 않는다
//+_+// P5-D29. 프로젝트 내용이 바뀌면 저장한다. 실패한 요청은 아무것도 남기지 않는다
describe('P5-D14 - a successful drop is persisted at once', () => {
  async function tiledFixture(): Promise<{ value: Fixture; tileId: string }> {
    const value = fixture()
    const response = await value.host.handle({
      type: 'ADD_TILE',
      source: { kind: 'tab', tabId: 11 },
    })
    if (!response.ok || response.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }
    return { value, tileId: response.tileId }
  }

  function storedTiles(value: Fixture) {
    const stored = value.storage.store.get(STORAGE_KEY) as {
      projects: { id: string; tiles: WebTile[] }[]
    }
    const project = stored.projects.find((item) => item.id === DEFAULT_PROJECT_ID)
    if (project === undefined) {
      throw new Error('the default project was not stored')
    }
    return project.tiles
  }

  it('writes exactly once when a move succeeds', async () => {
    const { value, tileId } = await tiledFixture()
    const before = value.storage.writes

    const response = await value.host.handle({
      type: 'SET_TILE_RECT',
      tileId,
      rect: { x: 2, y: 3, w: 1, h: 1 },
    })
    expect(response).toMatchObject({ ok: true })
    expect(value.storage.writes).toBe(before + 1)
  })

  it('stores the new position', async () => {
    const { value, tileId } = await tiledFixture()
    await value.host.handle({ type: 'SET_TILE_RECT', tileId, rect: { x: 2, y: 3, w: 1, h: 1 } })

    expect(storedTiles(value)[0]).toMatchObject({ x: 2, y: 3, w: 1, h: 1 })
  })

  //+_+// J35 가 무효 Drop 을 화면에서 이미 걸러낸다. 이것은 워커가 재판정에서 거부하는 경로다
  it('writes nothing when the worker refuses the rect', async () => {
    const { value, tileId } = await tiledFixture()
    await value.host.handle({ type: 'ADD_TILE', source: { kind: 'tab', tabId: 12 } })
    const before = value.storage.writes

    const response = await value.host.handle({
      type: 'SET_TILE_RECT',
      tileId,
      rect: { x: 1, y: 0, w: 1, h: 1 },
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'INVALID_LAYOUT' })
    expect(value.storage.writes).toBe(before)
  })

  it('writes nothing when the rect leaves the grid', async () => {
    const { value, tileId } = await tiledFixture()
    const before = value.storage.writes

    const response = await value.host.handle({
      type: 'SET_TILE_RECT',
      tileId,
      rect: { x: 3, y: 0, w: 2, h: 1 },
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'INVALID_LAYOUT' })
    expect(value.storage.writes).toBe(before)
  })

  it('writes nothing for a tileId the project does not have', async () => {
    const value = fixture()
    const before = value.storage.writes

    const response = await value.host.handle({
      type: 'SET_TILE_RECT',
      tileId: 'ghost',
      rect: { x: 0, y: 0, w: 1, h: 1 },
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'TILE_NOT_FOUND' })
    expect(value.storage.writes).toBe(before)
  })

  //+_+// resize 는 span 배정값을 덮어쓴다. 그 값도 같은 저장에 실린다
  it('stores the span assigned interval a resize wrote', async () => {
    const { value, tileId } = await tiledFixture()
    await value.host.handle({ type: 'SET_TILE_RECT', tileId, rect: { x: 0, y: 0, w: 2, h: 2 } })

    expect(storedTiles(value)[0]).toMatchObject({
      w: 2,
      h: 2,
      refreshIntervalMs: CAPTURE_INTERVAL_MS.spanLarge,
    })
  })

  //+_+// P5-D21. override 가 있으면 span 배정이 바뀌어도 실효 주기는 그대로다
  it('keeps the override winning after a resize', async () => {
    const { value, tileId } = await tiledFixture()
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: {
        customTitle: '',
        fitMode: 'contain',
        matchMode: 'exact',
        refreshIntervalOverrideMs: 9000,
      },
    })
    await value.host.handle({ type: 'SET_TILE_RECT', tileId, rect: { x: 0, y: 0, w: 2, h: 2 } })

    const stored = storedTiles(value)[0]
    expect(stored).toMatchObject({
      refreshIntervalMs: CAPTURE_INTERVAL_MS.spanLarge,
      refreshIntervalOverrideMs: 9000,
    })
    expect(tileIntervalMs(stored)).toBe(9000)
  })

  //+_+// J102. 실효 주기가 그대로면 재등록하지 않는다. J96 과 같은 판정이다
  it('does not re-register a resize that leaves the effective interval alone', async () => {
    const { value, tileId } = await tiledFixture()
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: {
        customTitle: '',
        fitMode: 'contain',
        matchMode: 'exact',
        refreshIntervalOverrideMs: 9000,
      },
    })

    value.host.engine.captures.tick()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(value.host.engine.captures.captureRecords).toHaveLength(1)

    value.clock.current = 1000
    await value.host.handle({ type: 'SET_TILE_RECT', tileId, rect: { x: 0, y: 0, w: 2, h: 2 } })
    value.host.engine.captures.tick()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(value.host.engine.captures.captureRecords).toHaveLength(1)
  })
})

//+_+// P5-D29. S5 에서 앞당긴 항목이다. ADD_TILE 과의 비대칭을 닫는다
describe('P5-D29 - BIND_TILE persists too', () => {
  it('writes when a bind succeeds', async () => {
    const { host, storage } = fixture()
    const before = storage.writes

    const response = await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    expect(response).toMatchObject({ ok: true })
    expect(storage.writes).toBe(before + 1)
  })

  it('writes when an existing tile is rebound', async () => {
    const { host, storage } = fixture()
    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 11 })
    const before = storage.writes

    await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 12 })
    expect(storage.writes).toBe(before + 1)
  })

  it('writes nothing when the tab is gone', async () => {
    const { host, storage } = fixture()
    const before = storage.writes

    const response = await host.handle({ type: 'BIND_TILE', tileId: 't1', tabId: 999999 })
    expect(response).toMatchObject({ ok: false, errorCode: 'TAB_NOT_FOUND' })
    expect(storage.writes).toBe(before)
  })

  it('writes nothing when the grid is full', async () => {
    const { host, storage, tabsBackend } = fixture([])
    for (let index = 0; index < 16; index += 1) {
      const tabId = 100 + index
      tabsBackend.tabs.set(tabId, tabInfo(tabId, `https://example.com/${String(tabId)}`))
      await host.handle({ type: 'BIND_TILE', tileId: `t${String(index)}`, tabId })
    }
    tabsBackend.tabs.set(200, tabInfo(200, 'https://example.com/200'))
    const before = storage.writes

    const response = await host.handle({ type: 'BIND_TILE', tileId: 'overflow', tabId: 200 })
    expect(response).toMatchObject({ ok: false, errorCode: 'GRID_FULL' })
    expect(storage.writes).toBe(before)
  })
})
