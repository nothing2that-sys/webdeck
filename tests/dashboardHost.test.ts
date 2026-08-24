import { describe, expect, it, vi } from 'vitest'
import type { DebuggerBackend } from '../src/background/debuggerSessionManager'
import {
  PORT_EVENT_KEY,
  PORT_EVENT_VIEW,
  RECONNECT_LOG_KEY,
  ROUND_LOG_KEY,
  WORKER_STARTS_KEY,
  readPortEvents,
  readReconnectRows,
  readRoundRows,
} from '../src/background/diagnostics'
import type { Clock } from '../src/background/previewCaptureManager'
import { ROUND_LOG_PREFIX, formatRoundClock, frameFingerprint } from '../src/background/roundLog'
import {
  LEASE_EXPIRY_MS,
  createDashboardHost,
  excludeOwnPages,
} from '../src/background/serviceWorker'
import type {
  CreateActiveTab,
  CreateTab,
  DashboardHost,
  FocusTab,
  ListTabs,
  ProjectTabUrl,
} from '../src/background/serviceWorker'
import type { TabsBackend } from '../src/background/tabManager'
import {
  DEFAULT_PROJECT_ID,
  PORT_NAME_PREFIX,
  PROJECT_PARAM,
  clientIdOfPortName,
  portName,
} from '../src/shared/messages'
import type { TileSettings } from '../src/shared/messages'
import { RECORD_LOG_LIMIT } from '../src/shared/recordLimit'
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
  //+_+// S3. 링버퍼 쓰기가 실패해도 캡처가 계속되는 것을 시험하려면 실패를 만들 수 있어야 한다
  failSet = false

  get(key: string): Promise<unknown> {
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

interface Fixture {
  host: DashboardHost
  debuggerBackend: StubDebugger
  tabsBackend: StubTabs
  clock: StubClock
  storage: StubStorage
  //+_+// P6-D18. 계측 쓰기를 상태 저장 쓰기와 갈라 센다. null 이면 링버퍼가 꺼진 배선이다
  diagnostics: StubStorage | null
  createdUrls: string[]
  //+_+// P8-D19. 앞으로 오는 탭만 여기 쌓인다. createdUrls 와 갈라 두어 어느 경로인지 가른다
  frontUrls: string[]
  //+_+// P5-D37. 일부 실패가 성공한 것들을 되돌리지 않는 것을 시험하려면 실패를 만들 수 있어야 한다
  failCreateUrls: Set<string>
  //+_+// P5-D39. 재연결이 던지는 상황을 만든다
  failListTabs: boolean
  activated: { tabId: number; windowId: number }[]
}

function fixture(
  tabIds: number[] = [11, 12],
  storage = new StubStorage(),
  diagnostics: StubStorage | null = null,
): Fixture {
  const debuggerBackend = new StubDebugger()
  const tabsBackend = new StubTabs()
  const clock = new StubClock()
  const createdUrls: string[] = []
  const frontUrls: string[] = []
  const activated: { tabId: number; windowId: number }[] = []

  for (const tabId of tabIds) {
    tabsBackend.tabs.set(tabId, tabInfo(tabId, `https://example.com/${String(tabId)}`))
  }

  //+_+// P5-D12. 창 인자가 사라졌다. 창 제한은 chromeListTabs 안의 query 로만 남는다
  const listTabs: ListTabs = () =>
    value.failListTabs
      ? Promise.reject(new Error('tab listing refused'))
      : Promise.resolve([...tabsBackend.tabs.values()])

  const focusTab: FocusTab = (tabId, windowId) => {
    activated.push({ tabId, windowId })
    return Promise.resolve()
  }

  //+_+// P5-D27 의 url 경로다. 워커가 탭을 만든다. 새 탭 id 는 기존과 겹치지 않게 고른다
  const failCreateUrls = new Set<string>()
  const createTab: CreateTab = (url) => {
    if (failCreateUrls.has(url)) {
      return Promise.reject(new Error(`refused to create a tab for ${url}`))
    }
    createdUrls.push(url)
    const created = { ...tabInfo(900 + createdUrls.length, url), currentUrl: url }
    tabsBackend.tabs.set(created.tabId, created)
    return Promise.resolve(created)
  }

  //+_+// P8-D19. 제품 어댑터가 active: true 로 여는 경로다. 여기서는 url 만 기록한다
  const createActiveTab: CreateActiveTab = (url) => {
    frontUrls.push(url)
    return Promise.resolve()
  }

  //+_+// P8-D16. 제품에서는 chrome.runtime.getURL 이 만든다. 시험은 상대 경로로 둔다
  const projectTabUrl: ProjectTabUrl = (projectId) =>
    `dashboard.html?${PROJECT_PARAM}=${encodeURIComponent(projectId)}`

  const value: Fixture = {
    host: createDashboardHost(
      debuggerBackend,
      tabsBackend,
      listTabs,
      focusTab,
      createTab,
      createActiveTab,
      projectTabUrl,
      storage,
      clock,
      diagnostics,
    ),
    debuggerBackend,
    tabsBackend,
    clock,
    storage,
    diagnostics,
    createdUrls,
    frontUrls,
    failCreateUrls,
    failListTabs: false,
    activated,
  }
  return value
}

//+_+// P6-D49. 워커는 Pause 로 시작한다. 제품 경로에서는 첫 GET_PROJECT_STATE 폴링이 그것을 푼다
//+_+// 엔진을 직접 구동하는 시험은 폴링을 흉내내지 않으므로 여기서 푼다. 이미 풀려 있으면 아무 일도 없다
function driveTick(host: DashboardHost): void {
  host.engine.captures.setPaused(false)
  host.engine.captures.tick()
}

async function projectStateOf(
  host: DashboardHost,
  projectId: string,
  dashboardVisible = true,
  clientId = 'client-1',
) {
  const response = await host.handle({
    type: 'GET_PROJECT_STATE',
    projectId,
    clientId,
    dashboardVisible,
  })
  if (!response.ok || response.type !== 'GET_PROJECT_STATE') {
    throw new Error(`unexpected response ${JSON.stringify(response)}`)
  }
  return response
}

async function projectState(host: DashboardHost, dashboardVisible = true) {
  return projectStateOf(host, DEFAULT_PROJECT_ID, dashboardVisible)
}

//+_+// 타일 1개짜리 시험이 쓴다. 폴링이 표시 상태를 나르므로 상태 조회에 그 값을 함께 넘긴다
async function statusOfTile(host: DashboardHost, dashboardVisible: boolean): Promise<string> {
  const state = await projectState(host, dashboardVisible)
  const runtime = state.runtimeStates[0]
  if (runtime === undefined) {
    throw new Error('no runtime state')
  }
  return runtime.status
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
      clientId: 'client-1',
      projectId: 'someone-else',
      dashboardVisible: true,
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'PROJECT_NOT_FOUND' })
  })

  it('reports the bound tab identity on the runtime state', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })

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
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    driveTick(host)
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
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    driveTick(host)
    await Promise.resolve()
    await Promise.resolve()

    const state = await projectState(host)
    expect(state.frames).toEqual([])
    expect(state.runtimeStates[0].consecutiveCaptureFailures).toBe(1)
    expect(Object.hasOwn(state.runtimeStates[0], 'lastCaptureAt')).toBe(false)
  })

  it('reports DETACHED once the bound tab is gone', async () => {
    const { host, tabsBackend } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    await host.engine.captures.unregister('t1')
    tabsBackend.tabs.delete(11)

    const state = await projectState(host)
    expect(state.runtimeStates[0]).toMatchObject({ tileId: 't1', tabId: 11, status: 'DETACHED' })
  })
})

describe('P4-D2 - BIND_TILE creates the tile the dev button asks for', () => {
  it('places the first two tiles side by side', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't2', tabId: 12 })

    const state = await projectState(host)
    expect(state.project.tiles.map((tile) => [tile.x, tile.y])).toEqual([
      [0, 0],
      [1, 0],
    ])
  })

  it('takes the launch url and the interval from the bound tab and the 1x1 default', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })

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
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    expect(debuggerBackend.attached).toEqual([])

    driveTick(host)
    await Promise.resolve()
    expect(debuggerBackend.attached).toEqual([11])
  })

  it('refuses a tabId that does not exist', async () => {
    const { host } = fixture()
    const response = await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 999999 })
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
        await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: `t${String(index)}`, tabId: 100 + index }),
      )
    }

    expect(responses.slice(0, 16).every((response) => response.ok)).toBe(true)
    expect(responses[16]).toMatchObject({ ok: false, errorCode: 'GRID_FULL' })
    expect((await projectState(host)).project.tiles).toHaveLength(16)
  })

  it('rebinds an existing tile without creating a second one', async () => {
    const { host, debuggerBackend } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 12 })

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

describe('P5-D4 - the verbs Phase 6 owns fail loudly', () => {
  it('refuses the verbs that later phases own', async () => {
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
      await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'abcdef1234', tabId: 11 })
      driveTick(host)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })

      //+_+// 시각은 StubClock 의 0 이다. 로컬 시간대에 따라 달라지므로 같은 함수로 만든다
      //+_+// N2. 해시는 응답 본문 AAAA 에서 나온다. 값을 손으로 적지 않고 같은 함수로 만든다
      //+_+// P6-D17. 타일 1개를 등록하고 탭 1개에 붙은 회차다
      expect(lines).toHaveLength(1)
      expect(lines[0][0]).toBe(
        `${ROUND_LOG_PREFIX} ${formatRoundClock(0)} abcdef12 1x1 every ${String(CAPTURE_INTERVAL_MS.spanSmall)}ms took 0ms call 0ms success 0.0kB ${frameFingerprint('AAAA')} tiles 1 attached 1 sched ${String(CAPTURE_INTERVAL_MS.spanSmall)}ms`,
      )
    } finally {
      spy.mockRestore()
    }
  })
})

//+_+// S3. 콘솔 출력과 같은 정보를 저장에도 남긴다. 관측 뒤에 콘솔을 한 번 열어 덤프한다
describe('P6-D18 - a settled round also reaches the storage ring buffer', () => {
  //+_+// 링버퍼 쓰기는 정산 뒤의 비동기 사슬이다. 매크로태스크 두 번으로 그 사슬을 비운다
  async function settleOneRound(value: Fixture): Promise<string> {
    const lines: unknown[][] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args)
    })

    try {
      await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'abcdef1234', tabId: 11 })
      driveTick(value.host)
      for (let turn = 0; turn < 2; turn += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0)
        })
      }
      return String(lines[0]?.[0] ?? '')
    } finally {
      spy.mockRestore()
    }
  }

  it('stores the same line the console got', async () => {
    const diagnostics = new StubStorage()
    const value = fixture([11, 12], new StubStorage(), diagnostics)

    const line = await settleOneRound(value)
    const rows = readRoundRows(diagnostics.store.get(ROUND_LOG_KEY))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.line).toBe(line)
  })

  //+_+// P6-D16. 계측 키는 상태 키와 다르다. schemaVersion 경로를 지나지 않는다
  it('never writes the state key', async () => {
    const diagnostics = new StubStorage()
    await settleOneRound(fixture([11, 12], new StubStorage(), diagnostics))

    expect([...diagnostics.store.keys()]).toEqual([ROUND_LOG_KEY])
  })

  it('writes nothing when no diagnostics backend is wired', async () => {
    const storage = new StubStorage()
    const value = fixture([11, 12], storage)

    await settleOneRound(value)

    expect(value.diagnostics).toBeNull()
    expect([...storage.store.keys()]).toEqual([STORAGE_KEY])
  })

  //+_+// S3. 쓰기 실패가 캡처를 막지 않는다
  it('settles the round even when the ring buffer write fails', async () => {
    const diagnostics = new StubStorage()
    diagnostics.failSet = true
    const value = fixture([11, 12], new StubStorage(), diagnostics)

    const line = await settleOneRound(value)

    expect(line).toContain('success')
    expect(value.host.engine.captures.captureRecords).toHaveLength(1)
    expect(diagnostics.store.size).toBe(0)
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
    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    driveTick(value.host)
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
    driveTick(value.host)
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

  //+_+// P6-D49. 워커는 보이지 않는 것으로 시작한다. 폴링 1회가 있어야 억제가 풀린다
  async function bindAndCapture(fixtureValue: Fixture): Promise<number> {
    await fixtureValue.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    await projectState(fixtureValue.host, true)
    return settleRound(fixtureValue.host)
  }

  it('keeps the tile interval while the dashboard stays visible', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)

    value.clock.current = CAPTURE_INTERVAL_MS.spanSmall
    expect(await settleRound(value.host)).toBe(2)
  })

  //+_+// A-e1. hidden 은 저주기가 아니라 Pause 다. 45000 회차가 남지 않는다
  it('runs no round at all once the poll reports the dashboard hidden', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)
    await projectState(value.host, false)

    expect(await settleRound(value.host)).toBe(1)

    value.clock.current = CAPTURE_INTERVAL_MS.spanSmall
    expect(await settleRound(value.host)).toBe(1)

    //+_+// 예전 hidden 주기를 한참 넘겨도 회차가 없다
    value.clock.current = 200_000
    expect(await settleRound(value.host)).toBe(1)
  })

  //+_+// A-e2 · D6a. Pause 는 억제 플래그다. 리스를 놓지 않으므로 타일이 DETACHED 로 바뀌지 않는다
  it('keeps the debugger attached and the tile out of DETACHED while hidden', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)
    await projectState(value.host, false)

    expect(value.debuggerBackend.detached).toEqual([])
    expect(value.host.engine.sessions.isAttached(11)).toBe(true)
    expect(await statusOfTile(value.host, false)).not.toBe('DETACHED')
  })

  it('does not re-register on a poll that repeats the same value', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)

    value.clock.current = 1000
    await projectState(value.host, true)
    expect(await settleRound(value.host)).toBe(1)
  })

  //+_+// B-e1 · A-e3 · P6-D52. 전환 1회가 만기를 now 로 되돌리던 것이 몰림의 원인이었다
  it('does not make every tile round the moment the dashboard comes back', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)
    await projectState(value.host, false)

    //+_+// Pause 구간 길이만큼 만기가 밀린다. 해제 시각이 아니라 남은 시간이 보존된다
    value.clock.current = 100_000
    await projectState(value.host, true)
    expect(await settleRound(value.host)).toBe(1)

    value.clock.current = 100_000 + CAPTURE_INTERVAL_MS.spanSmall - 1
    expect(await settleRound(value.host)).toBe(1)

    value.clock.current = 100_000 + CAPTURE_INTERVAL_MS.spanSmall
    expect(await settleRound(value.host)).toBe(2)
  })

  //+_+// A-e4 · D38. Pause 구간의 경과가 신선도 판정에 들어가면 해제 직후 전 타일이 STALE 로 보인다
  it('does not show the tile as STALE right after a long pause', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)
    await projectState(value.host, false)

    //+_+// 기본 주기 4000 의 STALE 임계는 12000 이다. Pause 구간이 그것을 한참 넘는다
    value.clock.current = 500_000
    expect(await statusOfTile(value.host, true)).not.toBe('STALE')
  })

  //+_+// 같은 임계가 Pause 중에도 성립해야 한다. 수동 Pause 는 화면을 켠 채로 걸 수 있다
  it('does not show the tile as STALE while the pause is still on', async () => {
    const value = fixture()
    expect(await bindAndCapture(value)).toBe(1)
    await projectState(value.host, false)

    value.clock.current = 500_000
    expect(await statusOfTile(value.host, false)).not.toBe('STALE')
  })
})

describe('P4-D12 - SET_TILE_RECT is judged again by the worker', () => {
  it('moves a tile to an empty rect', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })

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
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })

    await host.handle({ type: 'SET_TILE_RECT', tileId: 't1', rect: { x: 0, y: 0, w: 2, h: 2 } })
    expect((await projectState(host)).project.tiles[0]).toMatchObject({
      w: 2,
      h: 2,
      refreshIntervalMs: CAPTURE_INTERVAL_MS.spanLarge,
    })
  })

  it('keeps the interval when only the position changed', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })

    await host.handle({ type: 'SET_TILE_RECT', tileId: 't1', rect: { x: 1, y: 1, w: 1, h: 1 } })
    expect((await projectState(host)).project.tiles[0]).toMatchObject({
      refreshIntervalMs: CAPTURE_INTERVAL_MS.spanSmall,
    })
  })

  it('refuses a rect that overlaps another tile and leaves the layout alone', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't2', tabId: 12 })

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
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })

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
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })

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
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })

    const response = await host.handle({ type: 'FOCUS_TILE', tileId: 't1' })
    expect(response).toMatchObject({ ok: true, type: 'FOCUS_TILE' })
    expect(activated).toEqual([{ tabId: 11, windowId: 1 }])
  })

  it('follows the rebind rather than the first tab', async () => {
    const { host, activated } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 12 })
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
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
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

  //+_+// TASK-P8-07 §1.5 이 이 시험의 전제를 뒤집었다. 전에는 활성이 아닌 프로젝트를 거절했다
  //+_+// 다중 활성이 그것을 못 하게 한다. 탭마다 다른 프로젝트를 폴링하는 것이 이 절의 목적이다
  //+_+// 모르는 projectId 를 거절하는 것은 그대로다
  it('lets GET_PROJECT_STATE poll a project that is not the active one', async () => {
    const { host } = fixture()
    const created = await addProject(host, 'Monitoring')
    await host.handle({ type: 'SET_ACTIVE_PROJECT', projectId: created })

    const other = await host.handle({
      type: 'GET_PROJECT_STATE',
      clientId: 'client-1',
      projectId: DEFAULT_PROJECT_ID,
      dashboardVisible: true,
    })
    expect(other).toMatchObject({ ok: true, type: 'GET_PROJECT_STATE' })

    const active = await host.handle({
      type: 'GET_PROJECT_STATE',
      clientId: 'client-2',
      projectId: created,
      dashboardVisible: true,
    })
    expect(active).toMatchObject({ ok: true, type: 'GET_PROJECT_STATE' })
  })

  it('still refuses a projectId no project holds', async () => {
    const { host } = fixture()
    const response = await host.handle({
      type: 'GET_PROJECT_STATE',
      clientId: 'client-1',
      projectId: 'no-such-project',
      dashboardVisible: true,
    })

    expect(response).toMatchObject({ ok: false, errorCode: 'PROJECT_NOT_FOUND' })
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

  //+_+// TASK-P8-07 §1.2. 전환을 SET_ACTIVE_PROJECT 가 아니라 임차가 나른다
  //+_+// 그 탭의 다음 폴링이 새 projectId 를 실어 오고 그때 집합이 바뀐다
  it('unregisters the tiles of the project a tab left', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    await projectStateOf(host, DEFAULT_PROJECT_ID)
    expect(host.engine.captures.statusOf('t1')).not.toBeNull()

    const other = await switchTo(host, 'Monitoring')
    await projectStateOf(host, other)

    expect(host.engine.captures.statusOf('t1')).toBeNull()
  })

  it('registers the tiles of the project a tab came back to', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    const other = await switchTo(host, 'Monitoring')
    await projectStateOf(host, other)
    expect(host.engine.captures.statusOf('t1')).toBeNull()

    await projectStateOf(host, DEFAULT_PROJECT_ID)

    expect(host.engine.captures.statusOf('t1')).not.toBeNull()
  })

  it('unregisters the tiles of a project that was deleted', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })

    await host.handle({ type: 'DELETE_PROJECT', projectId: DEFAULT_PROJECT_ID })
    expect(host.engine.captures.statusOf('t1')).toBeNull()
  })
})

//+_+// P8-D16. 허브가 프로젝트 탭을 여는 요청이다. 화면이 chrome.tabs.* 를 부르지 않는다
describe('P8-D16 - OPEN_PROJECT_TAB opens a tab for a project', () => {
  it('asks for a tab whose url carries the projectId', async () => {
    const value = fixture()
    const created = await value.host.handle({ type: 'CREATE_PROJECT', name: 'Monitoring' })
    if (!created.ok || created.type !== 'CREATE_PROJECT') {
      throw new Error('create failed')
    }

    const response = await value.host.handle({
      type: 'OPEN_PROJECT_TAB',
      projectId: created.project.id,
    })

    expect(response).toMatchObject({ ok: true, type: 'OPEN_PROJECT_TAB' })
    expect(value.frontUrls).toEqual([
      `dashboard.html?${PROJECT_PARAM}=${encodeURIComponent(created.project.id)}`,
    ])
  })

  //+_+// 기존 탭을 찾아 재사용하지 않는다. 두 번 고르면 둘 열린다 (P8-D16 · §8-2.2)
  it('opens a second tab for the same project', async () => {
    const value = fixture()
    await value.host.handle({ type: 'OPEN_PROJECT_TAB', projectId: DEFAULT_PROJECT_ID })
    await value.host.handle({ type: 'OPEN_PROJECT_TAB', projectId: DEFAULT_PROJECT_ID })

    expect(value.frontUrls).toHaveLength(2)
  })

  it('refuses a projectId no project holds', async () => {
    const value = fixture()

    const response = await value.host.handle({ type: 'OPEN_PROJECT_TAB', projectId: 'no-such' })

    expect(response).toMatchObject({ ok: false, errorCode: 'PROJECT_NOT_FOUND' })
    expect(value.frontUrls).toEqual([])
    expect(value.createdUrls).toEqual([])
  })

  //+_+// 요청 하나가 임차를 만들지 않는다. 허브는 등록을 만들지 않는 화면이다 (P8-D17)
  //+_+// 임차를 만들었다면 유일한 폴링 탭이 끊긴 뒤에도 집합에 남아 등록이 살아 있을 것이다
  it('does not open a lease of its own', async () => {
    const { host } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    await projectStateOf(host, DEFAULT_PROJECT_ID, true, 'client-1')

    await host.handle({ type: 'OPEN_PROJECT_TAB', projectId: DEFAULT_PROJECT_ID })
    await host.portDisconnected('client-1', 1000)

    expect(host.engine.captures.statusOf('t1')).toBeNull()
  })
})

//+_+// P8-D19. Open 이 연 탭은 앞으로 온다. 타일 탭은 그대로 뒤에서 열린다
describe('P8-D19 - only the project tab comes to the front', () => {
  it('sends the project tab through the front path, not the tile path', async () => {
    const value = fixture()

    await value.host.handle({ type: 'OPEN_PROJECT_TAB', projectId: DEFAULT_PROJECT_ID })

    expect(value.frontUrls).toHaveLength(1)
    expect(value.createdUrls).toEqual([])
  })

  //+_+// P5-D27 을 뒤집지 않는다. url 로 타일을 만드는 경로는 뒤에서 여는 쪽 그대로다
  it('leaves ADD_TILE on the background path', async () => {
    const value = fixture()

    await value.host.handle({
      type: 'ADD_TILE',
      projectId: DEFAULT_PROJECT_ID,
      source: { kind: 'url', url: 'https://example.com/added' },
    })

    expect(value.createdUrls).toEqual(['https://example.com/added'])
    expect(value.frontUrls).toEqual([])
  })

  it('leaves OPEN_MISSING_TABS on the background path', async () => {
    const value = fixture()
    await value.host.handle({
      type: 'ADD_TILE',
      projectId: DEFAULT_PROJECT_ID,
      source: { kind: 'url', url: 'https://example.com/missing' },
    })
    value.createdUrls.length = 0

    await value.host.handle({ type: 'OPEN_MISSING_TABS', projectId: DEFAULT_PROJECT_ID })

    expect(value.frontUrls).toEqual([])
  })
})

//+_+// J171. 허브의 New 와 Rename 이 설명을 함께 보낸다. 워커가 그것을 프로젝트에 싣는다
describe('J171 - the project description travels with CREATE and RENAME', () => {
  async function listed(host: DashboardHost, projectId: string) {
    const response = await host.handle({ type: 'LIST_PROJECTS' })
    if (!response.ok || response.type !== 'LIST_PROJECTS') {
      throw new Error('list failed')
    }
    return response.projects.find((project) => project.id === projectId)
  }

  it('carries a description given at creation', async () => {
    const { host } = fixture()
    const created = await host.handle({
      type: 'CREATE_PROJECT',
      name: 'Monitoring',
      description: 'the wall of graphs',
    })
    if (!created.ok || created.type !== 'CREATE_PROJECT') {
      throw new Error('create failed')
    }

    expect(created.project.description).toBe('the wall of graphs')
    expect((await listed(host, created.project.id))?.description).toBe('the wall of graphs')
  })

  //+_+// J172. 공백만인 설명은 없는 것으로 다룬다. P8-D13 이 저장 층에서 같은 판정을 한다
  it('drops a description that is whitespace only', async () => {
    const { host } = fixture()
    const created = await host.handle({ type: 'CREATE_PROJECT', name: 'Monitoring', description: '  ' })
    if (!created.ok || created.type !== 'CREATE_PROJECT') {
      throw new Error('create failed')
    }

    expect(created.project.description).toBeUndefined()
  })

  it('replaces the description on rename', async () => {
    const { host } = fixture()
    await host.handle({
      type: 'RENAME_PROJECT',
      projectId: DEFAULT_PROJECT_ID,
      name: 'Renamed',
      description: 'first',
    })
    await host.handle({
      type: 'RENAME_PROJECT',
      projectId: DEFAULT_PROJECT_ID,
      name: 'Renamed',
      description: 'second',
    })

    expect((await listed(host, DEFAULT_PROJECT_ID))?.description).toBe('second')
  })

  //+_+// J173. 설명을 안 실은 요청은 설명을 건드리지 않는다
  it('leaves the description alone when the request omits it', async () => {
    const { host } = fixture()
    await host.handle({
      type: 'RENAME_PROJECT',
      projectId: DEFAULT_PROJECT_ID,
      name: 'Renamed',
      description: 'kept',
    })

    await host.handle({ type: 'RENAME_PROJECT', projectId: DEFAULT_PROJECT_ID, name: 'Again' })

    expect((await listed(host, DEFAULT_PROJECT_ID))?.description).toBe('kept')
  })

  //+_+// 빈 문자열은 지우라는 뜻이다. 안 실은 것과 가른다
  it('clears the description when the request carries an empty one', async () => {
    const { host } = fixture()
    await host.handle({
      type: 'RENAME_PROJECT',
      projectId: DEFAULT_PROJECT_ID,
      name: 'Renamed',
      description: 'kept',
    })

    await host.handle({
      type: 'RENAME_PROJECT',
      projectId: DEFAULT_PROJECT_ID,
      name: 'Renamed',
      description: '',
    })

    expect((await listed(host, DEFAULT_PROJECT_ID))?.description).toBeUndefined()
  })
})

//+_+// P5-D27. v1 section 9.1 의 두 경로다. BIND_TILE 을 확장하지 않고 별도 요청으로 둔다
describe('P5-D27 - ADD_TILE covers the two v1 9.1 paths', () => {
  async function addTile(
    host: DashboardHost,
    source: { kind: 'tab'; tabId: number } | { kind: 'url'; url: string },
    projectId: string = DEFAULT_PROJECT_ID,
  ): Promise<string> {
    const response = await host.handle({ type: 'ADD_TILE', projectId, source })
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

    const response = await host.handle({ type: 'ADD_TILE', projectId: DEFAULT_PROJECT_ID, source: { kind: 'tab', tabId: 200 } })
    expect(response).toMatchObject({ ok: false, type: 'ADD_TILE', errorCode: 'GRID_FULL' })
  })

  it('refuses a tabId that does not exist', async () => {
    const { host } = fixture()
    const response = await host.handle({
      type: 'ADD_TILE',
      projectId: DEFAULT_PROJECT_ID,
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
      projectId: DEFAULT_PROJECT_ID,
      source: { kind: 'url', url: 'https://example.org/dash' },
    })
    expect(response).toMatchObject({ ok: false, errorCode: 'GRID_FULL' })
    expect(createdUrls).toEqual([])
  })

  it('attaches the debugger to the new tile on the next tick', async () => {
    const { host, debuggerBackend } = fixture()
    await addTile(host, { kind: 'tab', tabId: 11 })

    driveTick(host)
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
    await addTile(host, { kind: 'tab', tabId: 11 }, created.project.id)

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
      projectId: DEFAULT_PROJECT_ID,
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
    driveTick(value.host)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    return value.host.engine.captures.captureRecords.length
  }

  async function tileWithOneRound(): Promise<{ value: Fixture; tileId: string }> {
    const value = fixture()
    const response = await value.host.handle({
      type: 'ADD_TILE',
      projectId: DEFAULT_PROJECT_ID,
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
      projectId: DEFAULT_PROJECT_ID,
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
    await value.host.handle({ type: 'ADD_TILE', projectId: DEFAULT_PROJECT_ID, source: { kind: 'tab', tabId: 12 } })
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

    driveTick(value.host)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(value.host.engine.captures.captureRecords).toHaveLength(1)

    value.clock.current = 1000
    await value.host.handle({ type: 'SET_TILE_RECT', tileId, rect: { x: 0, y: 0, w: 2, h: 2 } })
    driveTick(value.host)
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

    const response = await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    expect(response).toMatchObject({ ok: true })
    expect(storage.writes).toBe(before + 1)
  })

  it('writes when an existing tile is rebound', async () => {
    const { host, storage } = fixture()
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    const before = storage.writes

    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 12 })
    expect(storage.writes).toBe(before + 1)
  })

  it('writes nothing when the tab is gone', async () => {
    const { host, storage } = fixture()
    const before = storage.writes

    const response = await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 999999 })
    expect(response).toMatchObject({ ok: false, errorCode: 'TAB_NOT_FOUND' })
    expect(storage.writes).toBe(before)
  })

  it('writes nothing when the grid is full', async () => {
    const { host, storage, tabsBackend } = fixture([])
    for (let index = 0; index < 16; index += 1) {
      const tabId = 100 + index
      tabsBackend.tabs.set(tabId, tabInfo(tabId, `https://example.com/${String(tabId)}`))
      await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: `t${String(index)}`, tabId })
    }
    tabsBackend.tabs.set(200, tabInfo(200, 'https://example.com/200'))
    const before = storage.writes

    const response = await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'overflow', tabId: 200 })
    expect(response).toMatchObject({ ok: false, errorCode: 'GRID_FULL' })
    expect(storage.writes).toBe(before)
  })
})

//+_+// v1 section 9.4. 탭이 닫혀도 타일을 지우지 않는다. Reopen / Bind / Remove 가 그 위에 얹힌다
describe('P5-D32 - REOPEN_TILE puts the tile back on a fresh tab', () => {
  async function detachedTile(): Promise<{ value: Fixture; tileId: string }> {
    const value = fixture()
    const added = await value.host.handle({
      type: 'ADD_TILE',
      projectId: DEFAULT_PROJECT_ID,
      source: { kind: 'tab', tabId: 11 },
    })
    if (!added.ok || added.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }
    value.tabsBackend.closeTab(11)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    return { value, tileId: added.tileId }
  }

  async function statusOf(value: Fixture, tileId: string): Promise<string> {
    const state = (await projectState(value.host)).runtimeStates.find(
      (item) => item.tileId === tileId,
    )
    if (state === undefined) {
      throw new Error(`no runtime state for ${tileId}`)
    }
    return state.status
  }

  it('shows the tile as DETACHED once its tab is gone', async () => {
    const { value, tileId } = await detachedTile()
    expect(await statusOf(value, tileId)).toBe('DETACHED')
  })

  //+_+// J102 의 결과다. resize 는 fault 를 지우는 경로가 아니다
  it('does not let a resize clear the detached state', async () => {
    const { value, tileId } = await detachedTile()
    await value.host.handle({ type: 'SET_TILE_RECT', tileId, rect: { x: 0, y: 0, w: 2, h: 2 } })

    expect(await statusOf(value, tileId)).toBe('DETACHED')
  })

  it('does not let a settings change clear the detached state', async () => {
    const { value, tileId } = await detachedTile()
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: {
        customTitle: 'Named',
        fitMode: 'contain',
        matchMode: 'exact',
        refreshIntervalOverrideMs: 9000,
      },
    })

    expect(await statusOf(value, tileId)).toBe('DETACHED')
  })

  it('opens the launch url on a new tab and rebinds the tile', async () => {
    const { value, tileId } = await detachedTile()
    const response = await value.host.handle({ type: 'REOPEN_TILE', tileId })

    expect(response).toMatchObject({ ok: true, type: 'REOPEN_TILE' })
    expect(value.createdUrls).toEqual(['https://example.com/11'])
  })

  //+_+// Reopen 은 fault 를 지우는 명시 경로다. 새 탭에 걸므로 엔진이 새 상태를 만든다
  it('clears the detached state', async () => {
    const { value, tileId } = await detachedTile()
    await value.host.handle({ type: 'REOPEN_TILE', tileId })

    expect(await statusOf(value, tileId)).not.toBe('DETACHED')
  })

  it('keeps the tileId, the rect and the settings', async () => {
    const { value, tileId } = await detachedTile()
    await value.host.handle({ type: 'SET_TILE_RECT', tileId, rect: { x: 2, y: 3, w: 1, h: 1 } })
    await value.host.handle({
      type: 'SET_TILE_SETTINGS',
      tileId,
      settings: {
        customTitle: 'Named',
        fitMode: 'cover',
        matchMode: 'prefix',
        refreshIntervalOverrideMs: 9000,
      },
    })
    await value.host.handle({ type: 'REOPEN_TILE', tileId })

    const tiles = (await projectState(value.host)).project.tiles
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toMatchObject({
      id: tileId,
      x: 2,
      y: 3,
      customTitle: 'Named',
      fitMode: 'cover',
      matchMode: 'prefix',
      refreshIntervalOverrideMs: 9000,
    })
  })

  it('reports the tab it created', async () => {
    const { value, tileId } = await detachedTile()
    const response = await value.host.handle({ type: 'REOPEN_TILE', tileId })
    if (!response.ok || response.type !== 'REOPEN_TILE') {
      throw new Error('reopen failed')
    }

    const state = (await projectState(value.host)).runtimeStates[0]
    expect(state.tabId).toBe(response.tabId)
  })

  it('captures the new tab on the next tick', async () => {
    const { value, tileId } = await detachedTile()
    await value.host.handle({ type: 'REOPEN_TILE', tileId })

    driveTick(value.host)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(value.debuggerBackend.attached.at(-1)).toBe(901)
  })

  it('persists the rebind', async () => {
    const { value, tileId } = await detachedTile()
    const before = value.storage.writes
    await value.host.handle({ type: 'REOPEN_TILE', tileId })
    expect(value.storage.writes).toBeGreaterThan(before)
  })

  it('refuses a tileId the project does not have', async () => {
    const response = await fixture().host.handle({ type: 'REOPEN_TILE', tileId: 'ghost' })
    expect(response).toMatchObject({ ok: false, errorCode: 'TILE_NOT_FOUND' })
  })

  //+_+// S2 이전에 만들어진 저장값은 launchUrl 이 비어 있을 수 있다. 탭을 만들지 않고 실패한다
  it('refuses a tile whose launch url is empty and creates no tab', async () => {
    const value = fixture([])
    value.tabsBackend.tabs.set(30, { ...tabInfo(30, ''), currentUrl: '' })
    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'blank', tabId: 30 })
    const before = value.storage.writes

    const response = await value.host.handle({ type: 'REOPEN_TILE', tileId: 'blank' })
    expect(response).toMatchObject({ ok: false, errorCode: 'NO_LAUNCH_URL' })
    expect(value.createdUrls).toEqual([])
    expect(value.storage.writes).toBe(before)
  })
})

//+_+// v1 section 9.4 의 Bind Existing Tab 이다. BIND_TILE 을 그대로 쓴다
describe('S5 - binding a detached tile to another tab clears the fault', () => {
  it('clears the detached state', async () => {
    const value = fixture()
    const added = await value.host.handle({
      type: 'ADD_TILE',
      projectId: DEFAULT_PROJECT_ID,
      source: { kind: 'tab', tabId: 11 },
    })
    if (!added.ok || added.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }
    value.tabsBackend.closeTab(11)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: added.tileId, tabId: 12 })
    const state = (await projectState(value.host)).runtimeStates[0]
    expect(state.status).not.toBe('DETACHED')
    expect(state.tabId).toBe(12)
  })
})

//+_+// v1 section 9.4 의 Remove Tile 이다. 사용자의 탭은 닫지 않는다. CLAUDE.md section 5.2
describe('P5-D33 - REMOVE_TILE drops the tile and leaves the tab open', () => {
  async function tiled(): Promise<{ value: Fixture; tileId: string }> {
    const value = fixture()
    const added = await value.host.handle({
      type: 'ADD_TILE',
      projectId: DEFAULT_PROJECT_ID,
      source: { kind: 'tab', tabId: 11 },
    })
    if (!added.ok || added.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }
    return { value, tileId: added.tileId }
  }

  it('removes the tile from the project', async () => {
    const { value, tileId } = await tiled()
    const response = await value.host.handle({ type: 'REMOVE_TILE', tileId })

    expect(response).toMatchObject({ ok: true, type: 'REMOVE_TILE' })
    expect((await projectState(value.host)).project.tiles).toEqual([])
  })

  it('stops capturing the tile', async () => {
    const { value, tileId } = await tiled()
    await value.host.handle({ type: 'REMOVE_TILE', tileId })

    expect(value.host.engine.captures.statusOf(tileId)).toBeNull()
  })

  it('leaves the tab open', async () => {
    const { value, tileId } = await tiled()
    await value.host.handle({ type: 'REMOVE_TILE', tileId })

    expect(value.tabsBackend.tabs.has(11)).toBe(true)
  })

  it('persists the removal', async () => {
    const { value, tileId } = await tiled()
    const before = value.storage.writes
    await value.host.handle({ type: 'REMOVE_TILE', tileId })
    expect(value.storage.writes).toBe(before + 1)
  })

  it('frees the slot for a new tile', async () => {
    const { value, tileId } = await tiled()
    await value.host.handle({ type: 'REMOVE_TILE', tileId })

    const added = await value.host.handle({
      type: 'ADD_TILE',
      projectId: DEFAULT_PROJECT_ID,
      source: { kind: 'tab', tabId: 12 },
    })
    expect(added).toMatchObject({ ok: true })
    expect((await projectState(value.host)).project.tiles[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('refuses a tileId the project does not have', async () => {
    const value = fixture()
    const before = value.storage.writes

    const response = await value.host.handle({ type: 'REMOVE_TILE', tileId: 'ghost' })
    expect(response).toMatchObject({ ok: false, errorCode: 'TILE_NOT_FOUND' })
    expect(value.storage.writes).toBe(before)
  })

  it('lets the tile be removed while it is detached', async () => {
    const { value, tileId } = await tiled()
    value.tabsBackend.closeTab(11)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    const response = await value.host.handle({ type: 'REMOVE_TILE', tileId })
    expect(response).toMatchObject({ ok: true })
    expect((await projectState(value.host)).project.tiles).toEqual([])
  })
})

//+_+// P5-D35. 워커 기동 시 1회다. 재연결 전용 메시지를 만들지 않는다. v1 section 10
describe('P5-D35 - the worker reconnects once when it starts', () => {
  //+_+// tabId 를 저장하지 않는다. 저장값에는 launchUrl 과 matchMode 만 있다. v1 section 10 첫 문장
  function seeded(tiles: WebTile[]): StubStorage {
    const storage = new StubStorage()
    storage.store.set(STORAGE_KEY, {
      schemaVersion: 2,
      activeProjectId: DEFAULT_PROJECT_ID,
      projects: [
        {
          id: DEFAULT_PROJECT_ID,
          name: 'WebDeck',
          gridColumns: 4,
          gridRows: 4,
          keepManagedTabsAlive: false,
          tiles,
        },
      ],
    })
    return storage
  }

  function storedTile(id: string, launchUrl: string, x = 0, matchMode: WebTile['matchMode'] = 'exact'): WebTile {
    return {
      id,
      launchUrl,
      matchMode,
      x,
      y: 0,
      w: 1,
      h: 1,
      refreshIntervalMs: 4000,
      fitMode: 'contain',
      keepAlive: false,
    }
  }

  it('binds a tile whose url matches exactly one open tab', async () => {
    const value = fixture([11, 12], seeded([storedTile('t1', 'https://example.com/11')]))
    await value.host.load()

    const state = (await projectState(value.host)).runtimeStates[0]
    expect(state).toMatchObject({ tileId: 't1', tabId: 11 })
  })

  //+_+// TASK-P8-07 §1.2. 기동 직후에는 활성 집합이 비어 있어 등록이 0 이다
  //+_+// 첫 폴링이 임차를 만들어야 reconnect 이 채운 bindings 가 등록으로 이어진다
  it('captures the reconnected tab on the next tick after a poll', async () => {
    const value = fixture([11, 12], seeded([storedTile('t1', 'https://example.com/11')]))
    await value.host.load()
    await projectState(value.host)

    driveTick(value.host)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(value.debuggerBackend.attached).toEqual([11])
  })

  it('persists the binding it made', async () => {
    const value = fixture([11, 12], seeded([storedTile('t1', 'https://example.com/11')]))
    const before = value.storage.writes
    await value.host.load()

    expect(value.storage.writes).toBeGreaterThan(before)
  })

  //+_+// 배지 문자열을 여기서 고정하지 않는다. v1 section 10 의 5단계는 DETACHED 를 요구하나
  //+_+// resolveRuntimeStatus 는 바인딩이 없는 타일을 LOADING 으로 낸다. 보고에 올린 미결이다
  it('writes nothing when no tile matches', async () => {
    const value = fixture([11, 12], seeded([storedTile('t1', 'https://elsewhere.test/gone')]))
    const before = value.storage.writes
    await value.host.load()

    expect(value.storage.writes).toBe(before)
    expect(Object.hasOwn((await projectState(value.host)).runtimeStates[0], 'tabId')).toBe(false)
  })

  //+_+// P5-D15. 후보가 둘이면 고르지 않는다. 사용자가 Bind Existing Tab 으로 고른다
  it('leaves a tile with two candidates unbound', async () => {
    const value = fixture([], seeded([storedTile('t1', 'https://example.com/same')]))
    value.tabsBackend.tabs.set(11, tabInfo(11, 'https://example.com/same'))
    value.tabsBackend.tabs.set(12, tabInfo(12, 'https://example.com/same'))
    await value.host.load()

    const state = (await projectState(value.host)).runtimeStates[0]
    expect(Object.hasOwn(state, 'tabId')).toBe(false)
  })

  //+_+// P5-D36. 한 탭이 두 타일에 붙지 않는다. 배열 순서가 먼저인 타일이 잡는다
  it('gives a shared candidate to the earlier tile only', async () => {
    const value = fixture(
      [11],
      seeded([
        storedTile('first', 'https://example.com/11', 0),
        storedTile('second', 'https://example.com/11', 1),
      ]),
    )
    await value.host.load()

    const states = (await projectState(value.host)).runtimeStates
    expect(states[0]).toMatchObject({ tileId: 'first', tabId: 11 })
    expect(Object.hasOwn(states[1], 'tabId')).toBe(false)
  })

  it('does not create any tab while reconnecting', async () => {
    const value = fixture([11], seeded([storedTile('t1', 'https://elsewhere.test/gone')]))
    await value.host.load()

    expect(value.createdUrls).toEqual([])
  })

  //+_+// L11 이 실제로 걸리는 자리다. exact 는 query 순서를 구분한다. P5-D7
  it('does not reconnect an exact tile to a tab whose query order differs', async () => {
    const value = fixture([], seeded([storedTile('t1', 'https://example.com/p?a=1&b=2')]))
    value.tabsBackend.tabs.set(11, tabInfo(11, 'https://example.com/p?b=2&a=1'))
    await value.host.load()

    const state = (await projectState(value.host)).runtimeStates[0]
    expect(Object.hasOwn(state, 'tabId')).toBe(false)
  })

  it('reconnects the same tile once matchMode is origin', async () => {
    const value = fixture(
      [],
      seeded([storedTile('t1', 'https://example.com/p?a=1&b=2', 0, 'origin')]),
    )
    value.tabsBackend.tabs.set(11, tabInfo(11, 'https://example.com/p?b=2&a=1'))
    await value.host.load()

    expect((await projectState(value.host)).runtimeStates[0]).toMatchObject({ tabId: 11 })
  })
})

//+_+// P5-D37. v1 section 10 의 6단계다. 버튼으로만이고 브라우저 시작과 동시에 돌지 않는다
describe('P5-D37 - OPEN_MISSING_TABS opens the tabs a tile is waiting for', () => {
  async function detachedFixture(): Promise<{ value: Fixture; tileId: string }> {
    const value = fixture()
    const added = await value.host.handle({
      type: 'ADD_TILE',
      projectId: DEFAULT_PROJECT_ID,
      source: { kind: 'tab', tabId: 11 },
    })
    if (!added.ok || added.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }
    value.tabsBackend.closeTab(11)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    return { value, tileId: added.tileId }
  }

  async function openMissing(value: Fixture): Promise<string[]> {
    const response = await value.host.handle({ type: 'OPEN_MISSING_TABS', projectId: DEFAULT_PROJECT_ID })
    if (!response.ok || response.type !== 'OPEN_MISSING_TABS') {
      throw new Error(`unexpected response ${JSON.stringify(response)}`)
    }
    return response.openedTileIds
  }

  it('opens the launch url of a tile whose tab is gone', async () => {
    const { value, tileId } = await detachedFixture()
    expect(await openMissing(value)).toEqual([tileId])
    expect(value.createdUrls).toEqual(['https://example.com/11'])
  })

  it('binds the tile it opened', async () => {
    const { value, tileId } = await detachedFixture()
    await openMissing(value)

    const state = (await projectState(value.host)).runtimeStates[0]
    expect(state).toMatchObject({ tileId, tabId: 901 })
    expect(state.status).not.toBe('DETACHED')
  })

  it('leaves a tile whose tab is alive alone', async () => {
    const value = fixture()
    await value.host.handle({ type: 'ADD_TILE', projectId: DEFAULT_PROJECT_ID, source: { kind: 'tab', tabId: 11 } })

    expect(await openMissing(value)).toEqual([])
    expect(value.createdUrls).toEqual([])
  })

  it('reports nothing and writes nothing when there is no missing tile', async () => {
    const value = fixture()
    await value.host.handle({ type: 'ADD_TILE', projectId: DEFAULT_PROJECT_ID, source: { kind: 'tab', tabId: 11 } })
    const before = value.storage.writes

    expect(await openMissing(value)).toEqual([])
    expect(value.storage.writes).toBe(before)
  })

  it('persists once at least one tab was opened', async () => {
    const { value } = await detachedFixture()
    const before = value.storage.writes
    await openMissing(value)
    expect(value.storage.writes).toBeGreaterThan(before)
  })

  //+_+// launchUrl 이 빈 타일은 건너뛴다. 응답에 실리지 않는 것이 그 사실이다
  it('skips a tile with no launch url', async () => {
    const value = fixture([])
    value.tabsBackend.tabs.set(30, { ...tabInfo(30, ''), currentUrl: '' })
    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'blank', tabId: 30 })
    value.tabsBackend.closeTab(30)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    expect(await openMissing(value)).toEqual([])
    expect(value.createdUrls).toEqual([])
  })

  //+_+// 일부 실패가 성공한 것들을 되돌리지 않는다
  it('keeps the tabs it managed to open when one of them fails', async () => {
    const value = fixture([])
    value.tabsBackend.tabs.set(21, tabInfo(21, 'https://example.com/ok'))
    value.tabsBackend.tabs.set(22, tabInfo(22, 'https://example.com/broken'))
    const first = await value.host.handle({ type: 'ADD_TILE', projectId: DEFAULT_PROJECT_ID, source: { kind: 'tab', tabId: 21 } })
    const second = await value.host.handle({ type: 'ADD_TILE', projectId: DEFAULT_PROJECT_ID, source: { kind: 'tab', tabId: 22 } })
    if (!first.ok || first.type !== 'ADD_TILE' || !second.ok || second.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }
    value.tabsBackend.closeTab(21)
    value.tabsBackend.closeTab(22)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    value.failCreateUrls.add('https://example.com/broken')

    expect(await openMissing(value)).toEqual([first.tileId])
    expect((await projectState(value.host)).runtimeStates[0]).toMatchObject({ tabId: 901 })
  })
})

//+_+// P5-D39. 재연결은 부가 동작이다. 그것 때문에 저장된 프로젝트를 못 보게 하지 않는다
describe('P5-D39 - a reconnect failure does not sink the load', () => {
  it('still returns the stored projects when listing tabs throws', async () => {
    const value = fixture()
    const created = await value.host.handle({ type: 'CREATE_PROJECT', name: 'Monitoring' })
    if (!created.ok || created.type !== 'CREATE_PROJECT') {
      throw new Error('create failed')
    }

    const restored = fixture([11, 12], value.storage)
    restored.failListTabs = true
    const result = await restored.host.load()

    expect(result.ok).toBe(true)
    const listed = await restored.host.handle({ type: 'LIST_PROJECTS' })
    if (!listed.ok || listed.type !== 'LIST_PROJECTS') {
      throw new Error('list failed')
    }
    expect(listed.projects.map((project) => project.name)).toEqual(['WebDeck', 'Monitoring'])
  })

  it('does not reject', async () => {
    const value = fixture()
    value.failListTabs = true
    await expect(value.host.load()).resolves.toMatchObject({ ok: true })
  })
})

//+_+// P5-D6. v1 section 14 의 Refresh Preview 다. 페이지 reload 없이 그 타일만 즉시 1회 캡처한다
describe('P5-D6 - CAPTURE_TILE refreshes one preview on demand', () => {
  async function tiled(): Promise<{ value: Fixture; tileId: string }> {
    const value = fixture()
    const added = await value.host.handle({
      type: 'ADD_TILE',
      projectId: DEFAULT_PROJECT_ID,
      source: { kind: 'tab', tabId: 11 },
    })
    if (!added.ok || added.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }
    return { value, tileId: added.tileId }
  }

  it('returns the frame it captured', async () => {
    const { value, tileId } = await tiled()
    const response = await value.host.handle({ type: 'CAPTURE_TILE', tileId })

    expect(response).toMatchObject({
      ok: true,
      type: 'CAPTURE_TILE',
      imageBase64: 'AAAA',
      format: 'jpeg',
      bytes: 3,
    })
  })

  it('sends only captureScreenshot and never a reload', async () => {
    const { value, tileId } = await tiled()
    await value.host.handle({ type: 'CAPTURE_TILE', tileId })

    expect(value.debuggerBackend.attached).toEqual([11])
  })

  //+_+// v1 section 6.1. 큐를 우회하지 않는다. 회차 기록에 정상 회차로 남는다
  it('records the round like any other', async () => {
    const { value, tileId } = await tiled()
    await value.host.handle({ type: 'CAPTURE_TILE', tileId })

    const records = value.host.engine.captures.captureRecords
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tileId, outcome: 'success' })
  })

  it('refuses a tile that is not bound', async () => {
    const value = fixture()
    const response = await value.host.handle({ type: 'CAPTURE_TILE', tileId: 'ghost' })
    expect(response).toMatchObject({ ok: false, errorCode: 'TILE_NOT_BOUND' })
  })

  //+_+// tabGone 타일은 붙을 탭이 없다. 기존 실패 코드를 쓴다
  it('refuses a tile whose tab is gone', async () => {
    const { value, tileId } = await tiled()
    value.tabsBackend.closeTab(11)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    const response = await value.host.handle({ type: 'CAPTURE_TILE', tileId })
    expect(response).toMatchObject({ ok: false, errorCode: 'TAB_NOT_FOUND' })
  })

  it('reports a failed round rather than inventing a frame', async () => {
    const { value, tileId } = await tiled()
    value.debuggerBackend.data = null

    const response = await value.host.handle({ type: 'CAPTURE_TILE', tileId })
    expect(response).toMatchObject({ ok: false, errorCode: 'CAPTURE_FAILED' })
  })

  //+_+// J124. 만기를 당기므로 정기 회차의 위상이 요청 시각으로 옮겨간다. 숨기지 않는다
  it('moves the regular cadence to the moment it was asked', async () => {
    const { value, tileId } = await tiled()

    async function settleRound(): Promise<number> {
      driveTick(value.host)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
      return value.host.engine.captures.captureRecords.length
    }

    expect(await settleRound()).toBe(1)

    value.clock.current = 1000
    await value.host.handle({ type: 'CAPTURE_TILE', tileId })
    expect(value.host.engine.captures.captureRecords).toHaveLength(2)

    //+_+// 요청이 없었으면 4000 에 세 번째 회차가 돌았을 자리다
    value.clock.current = CAPTURE_INTERVAL_MS.spanSmall
    expect(await settleRound()).toBe(2)

    value.clock.current = 1000 + CAPTURE_INTERVAL_MS.spanSmall
    expect(await settleRound()).toBe(3)
  })

  //+_+// J125. captureOnce 가 tick 을 부르므로 만기가 지난 다른 타일도 그 자리에서 돈다
  //+_+// 그 타일의 위상은 자기 만기 기준으로 남는다. 정기 주기가 흔들리지 않는다
  it('leaves the cadence of another tile where it was', async () => {
    const { value, tileId } = await tiled()
    const other = await value.host.handle({ type: 'ADD_TILE', projectId: DEFAULT_PROJECT_ID, source: { kind: 'tab', tabId: 12 } })
    if (!other.ok || other.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }
    //+_+// J125 는 Pause 와 무관한 성질이다. 형제 시험이 첫 settleRound 로 억제를 푸는 것과 같은 자리다
    //+_+// 여기서 풀지 않으면 P6-D59 의 해제 시프트가 섞여 무엇을 재는 시험인지 흐려진다
    value.host.engine.captures.setPaused(false)

    value.clock.current = 1000
    await value.host.handle({ type: 'CAPTURE_TILE', tileId })
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    const roundsOf = (id: string): number =>
      value.host.engine.captures.captureRecords.filter((record) => record.tileId === id).length
    expect(roundsOf(other.tileId)).toBe(1)

    //+_+// 다른 타일의 다음 만기는 0 + 4000 이다. 요청 시각 1000 이 그것을 밀지 않았다
    value.clock.current = CAPTURE_INTERVAL_MS.spanSmall
    driveTick(value.host)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(roundsOf(other.tileId)).toBe(2)
  })
})

//+_+// P6-D53. HANDOFF_P6_MID section 3.1 의 결함이다. 워커 재기동 뒤 비활성 프로젝트 타일이 굳는다
//+_+// P5-D35 의 시험 9건이 전부 프로젝트를 하나만 저장한다. 프로젝트 경계는 어느 층에서도 시험되지 않았다
describe('P6-D53 - the worker reconnects the tiles of every stored project', () => {
  const OTHER_PROJECT_ID = 'project-a'

  //+_+// 활성은 타일 0개짜리 기본 프로젝트다. 실측에서 워커가 죽을 때의 배치가 그것이었다
  function seededTwoProjects(tiles: WebTile[]): StubStorage {
    const storage = new StubStorage()
    storage.store.set(STORAGE_KEY, {
      schemaVersion: 2,
      activeProjectId: DEFAULT_PROJECT_ID,
      projects: [
        {
          id: DEFAULT_PROJECT_ID,
          name: 'WebDeck',
          gridColumns: 4,
          gridRows: 4,
          keepManagedTabsAlive: false,
          tiles: [],
        },
        {
          id: OTHER_PROJECT_ID,
          name: 'A',
          gridColumns: 4,
          gridRows: 4,
          keepManagedTabsAlive: false,
          tiles,
        },
      ],
    })
    return storage
  }

  function inactiveTile(id: string, launchUrl: string, x = 0): WebTile {
    return {
      id,
      launchUrl,
      matchMode: 'exact',
      x,
      y: 0,
      w: 1,
      h: 1,
      refreshIntervalMs: CAPTURE_INTERVAL_MS.spanSmall,
      fitMode: 'contain',
      keepAlive: false,
    }
  }

  async function switched(value: Fixture) {
    const response = await value.host.handle({
      type: 'SET_ACTIVE_PROJECT',
      projectId: OTHER_PROJECT_ID,
    })
    if (!response.ok) {
      throw new Error(`switch failed ${JSON.stringify(response)}`)
    }
    return projectStateOf(value.host, OTHER_PROJECT_ID)
  }

  //+_+// C-e1. 탭이 살아 있는데도 굳는 것이 결함이다. 전환 뒤 바인딩이 돌아와야 한다
  it('rebinds a tile that was stored under a project that was not active', async () => {
    const value = fixture(
      [11],
      seededTwoProjects([inactiveTile('t1', 'https://example.com/11')]),
    )
    await value.host.load()

    const state = await switched(value)
    expect(state.runtimeStates[0]).toMatchObject({ tileId: 't1', tabId: 11 })
  })

  //+_+// C-e1 의 나머지 절반이다. 바인딩만 돌아오고 회차가 돌지 않으면 화면은 여전히 굳어 있다
  it('runs rounds for the rebound tiles once the project becomes active', async () => {
    const value = fixture(
      [11, 12],
      seededTwoProjects([
        inactiveTile('t1', 'https://example.com/11', 0),
        inactiveTile('t2', 'https://example.com/12', 1),
      ]),
    )
    await value.host.load()
    await switched(value)

    value.host.engine.captures.tick()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(value.debuggerBackend.attached.slice().sort((a, b) => a - b)).toEqual([11, 12])
  })

  //+_+// 활성이 아닌 동안에는 캡처하지 않는다. 바인딩 복구가 그 규칙을 깨면 안 된다
  it('does not capture the inactive project while it stays inactive', async () => {
    const value = fixture(
      [11],
      seededTwoProjects([inactiveTile('t1', 'https://example.com/11')]),
    )
    await value.host.load()

    value.host.engine.captures.tick()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(value.debuggerBackend.attached).toEqual([])
  })

  //+_+// P5-D36 의 한 탭 한 타일은 프로젝트 경계를 넘어 성립해야 한다
  it('gives a shared candidate to one tile only across projects', async () => {
    const storage = new StubStorage()
    storage.store.set(STORAGE_KEY, {
      schemaVersion: 2,
      activeProjectId: DEFAULT_PROJECT_ID,
      projects: [
        {
          id: DEFAULT_PROJECT_ID,
          name: 'WebDeck',
          gridColumns: 4,
          gridRows: 4,
          keepManagedTabsAlive: false,
          tiles: [inactiveTile('active-tile', 'https://example.com/11')],
        },
        {
          id: OTHER_PROJECT_ID,
          name: 'A',
          gridColumns: 4,
          gridRows: 4,
          keepManagedTabsAlive: false,
          tiles: [inactiveTile('other-tile', 'https://example.com/11')],
        },
      ],
    })
    const value = fixture([11], storage)
    await value.host.load()

    expect((await projectState(value.host)).runtimeStates[0]).toMatchObject({ tabId: 11 })
    const state = await switched(value)
    expect(Object.hasOwn(state.runtimeStates[0], 'tabId')).toBe(false)
  })

  //+_+// C-e2. "14분간 단서가 없었다" 를 재발시키지 않는 것이 목적이다
  it('logs the verdict of every tile it could not bind', async () => {
    const value = fixture(
      [],
      seededTwoProjects([inactiveTile('t1', 'https://elsewhere.test/gone')]),
    )
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await value.host.load()
    const lines = logged.mock.calls.map((call) => String(call[0]))
    logged.mockRestore()

    expect(lines.some((line) => line.includes('none') && line.includes('t1'))).toBe(true)
  })

  it('distinguishes an ambiguous verdict from a missing one', async () => {
    const value = fixture(
      [],
      seededTwoProjects([inactiveTile('t1', 'https://example.com/same')]),
    )
    value.tabsBackend.tabs.set(11, tabInfo(11, 'https://example.com/same'))
    value.tabsBackend.tabs.set(12, tabInfo(12, 'https://example.com/same'))
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await value.host.load()
    const lines = logged.mock.calls.map((call) => String(call[0]))
    logged.mockRestore()

    expect(lines.some((line) => line.includes('ambiguous') && line.includes('t1'))).toBe(true)
  })

  it('marks a bind that landed on a project that is not the active one', async () => {
    const value = fixture(
      [11],
      seededTwoProjects([inactiveTile('t1', 'https://example.com/11')]),
    )
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await value.host.load()
    const lines = logged.mock.calls.map((call) => String(call[0]))
    logged.mockRestore()

    expect(lines.some((line) => line.includes('inactive') && line.includes('t1'))).toBe(true)
  })
})

//+_+// P7-D41. L49 의 처분이다. reconnect 이 targets 를 만들 때 활성 프로젝트 타일을 앞에 둔다
//+_+// 전역 taken 이 배열 순서로 탭을 주므로 순서가 승자를 정한다 (P5-D36)
//+_+// 앞에 두지 않으면 비활성 타일이 탭을 가져가고 bindOnly 라 활성 프로젝트가 통째로 굶는다
describe('P7-D41 - reconnect gives the shared tab to the active project first', () => {
  const LATER_PROJECT_ID = 'project-later'

  function tile(id: string, launchUrl: string, x = 0): WebTile {
    return {
      id,
      launchUrl,
      matchMode: 'exact',
      x,
      y: 0,
      w: 1,
      h: 1,
      refreshIntervalMs: CAPTURE_INTERVAL_MS.spanSmall,
      fitMode: 'contain',
      keepAlive: false,
    }
  }

  //+_+// 비활성 프로젝트는 GET_PROJECT_STATE 가 거부한다. 판정은 reconnect 로그로 읽는다
  function rowsOf(value: Fixture) {
    return readReconnectRows(value.diagnostics?.store.get(RECONNECT_LOG_KEY))
  }

  //+_+// 활성 프로젝트를 배열 뒤에 둔다. 저장 순서만 보면 앞 프로젝트가 이기는 배치다
  function activeStoredLast(firstTiles: WebTile[], laterTiles: WebTile[]): StubStorage {
    const storage = new StubStorage()
    storage.store.set(STORAGE_KEY, {
      schemaVersion: 2,
      activeProjectId: LATER_PROJECT_ID,
      projects: [
        {
          id: DEFAULT_PROJECT_ID,
          name: 'WebDeck',
          gridColumns: 4,
          gridRows: 4,
          keepManagedTabsAlive: false,
          tiles: firstTiles,
        },
        {
          id: LATER_PROJECT_ID,
          name: 'Later',
          gridColumns: 4,
          gridRows: 4,
          keepManagedTabsAlive: false,
          tiles: laterTiles,
        },
      ],
    })
    return storage
  }

  //+_+// L49 의 핵심이다. 저장 배열 뒤에 있어도 활성 타일이 탭을 받는다
  it('binds the active tile even when its project is stored after the other one', async () => {
    const value = fixture(
      [11],
      activeStoredLast([tile('stored-first', 'https://example.com/11')], [tile('active-tile', 'https://example.com/11')]),
      new StubStorage(),
    )
    await value.host.load()

    const active = await projectStateOf(value.host, LATER_PROJECT_ID)
    expect(active.runtimeStates[0]).toMatchObject({ tileId: 'active-tile', tabId: 11 })
    expect(rowsOf(value)).toEqual([
      expect.objectContaining({ tileId: 'active-tile', kind: 'bind', candidates: 1, active: true }),
      expect.objectContaining({ tileId: 'stored-first', kind: 'none', candidates: 0, active: false }),
    ])
  })

  //+_+// 같은 프로젝트 안에서는 종전과 같다. 저장 순서가 먼저인 타일이 잡는다 (P5-D36)
  it('still lets the earlier tile of one project take a shared candidate', async () => {
    const value = fixture(
      [11],
      activeStoredLast([], [tile('first', 'https://example.com/11'), tile('second', 'https://example.com/11', 1)]),
    )
    await value.host.load()

    const active = await projectStateOf(value.host, LATER_PROJECT_ID)
    expect(active.runtimeStates[0]).toMatchObject({ tileId: 'first', tabId: 11 })
    expect(Object.hasOwn(active.runtimeStates[1], 'tabId')).toBe(false)
  })

  //+_+// 분할이 안정적이다. 활성 타일 둘 사이의 저장 순서가 유지되므로 앞 타일이 잡는다
  it('keeps the order of the active tiles among themselves', async () => {
    const value = fixture(
      [11],
      activeStoredLast(
        [tile('stored-first', 'https://example.com/11')],
        [tile('active-first', 'https://example.com/11'), tile('active-second', 'https://example.com/11', 1)],
      ),
      new StubStorage(),
    )
    await value.host.load()

    const active = await projectStateOf(value.host, LATER_PROJECT_ID)
    expect(active.runtimeStates[0]).toMatchObject({ tileId: 'active-first', tabId: 11 })
    expect(Object.hasOwn(active.runtimeStates[1], 'tabId')).toBe(false)
    //+_+// 판정 순서가 곧 배정 순서다. 활성 둘이 앞에 붙고 그 사이 저장 순서가 유지된다
    expect(rowsOf(value).map((row) => row.tileId)).toEqual(['active-first', 'active-second', 'stored-first'])
  })
})

//+_+// P6-D47. v1 section 15.1 의 전체 Pause 다. P5-D4 가 Phase 6 으로 넘긴 넷 중 하나다
describe('P6-D47 - SET_PREVIEW_PAUSED is the manual whole-dashboard pause', () => {
  async function boundAndVisible(value: Fixture): Promise<void> {
    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    await projectState(value.host, true)
  }

  async function rounds(value: Fixture): Promise<number> {
    value.host.engine.captures.tick()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    return value.host.engine.captures.captureRecords.length
  }

  it('stops the rounds while the dashboard stays visible', async () => {
    const value = fixture()
    await boundAndVisible(value)
    expect(await rounds(value)).toBe(1)

    await value.host.handle({ type: 'SET_PREVIEW_PAUSED', paused: true })
    value.clock.current = 100_000
    await projectState(value.host, true)
    expect(await rounds(value)).toBe(1)
  })

  it('lets the rounds start again when it is turned off', async () => {
    const value = fixture()
    await boundAndVisible(value)
    expect(await rounds(value)).toBe(1)

    await value.host.handle({ type: 'SET_PREVIEW_PAUSED', paused: true })
    value.clock.current = 100_000
    await value.host.handle({ type: 'SET_PREVIEW_PAUSED', paused: false })

    //+_+// 남은 시간이 보존되므로 해제 그 자리가 아니라 주기 뒤에 돈다
    value.clock.current = 100_000 + CAPTURE_INTERVAL_MS.spanSmall
    expect(await rounds(value)).toBe(2)
  })

  //+_+// D6a. 억제만 한다. 리스를 놓으면 타일이 DETACHED 로 바뀐다
  it('keeps the debugger attached while it is on', async () => {
    const value = fixture()
    await boundAndVisible(value)
    await rounds(value)

    await value.host.handle({ type: 'SET_PREVIEW_PAUSED', paused: true })
    expect(value.debuggerBackend.detached).toEqual([])
    expect(value.host.engine.sessions.isAttached(11)).toBe(true)
    expect(await statusOfTile(value.host, true)).not.toBe('DETACHED')
  })

  it('carries the state back on the poll so a reopened dashboard draws it', async () => {
    const value = fixture()
    await boundAndVisible(value)

    expect((await projectState(value.host)).previewPaused).toBe(false)
    await value.host.handle({ type: 'SET_PREVIEW_PAUSED', paused: true })
    expect((await projectState(value.host)).previewPaused).toBe(true)
  })

  //+_+// A-e5 · D6c. 워커가 죽었다 살아나도 유지된다. 새 host 가 같은 저장을 읽는다
  it('survives a worker restart', async () => {
    const value = fixture()
    await value.host.handle({ type: 'SET_PREVIEW_PAUSED', paused: true })

    const restarted = fixture([11, 12], value.storage)
    await restarted.host.load()
    expect((await projectState(restarted.host)).previewPaused).toBe(true)
  })

  it('does not pause a fresh worker that never had the toggle turned on', async () => {
    const value = fixture()
    await value.host.load()
    expect((await projectState(value.host)).previewPaused).toBe(false)
  })

  //+_+// P6-D46. Refresh Preview 는 사용자가 지금 보겠다고 누른 것이다. Pause 가 막지 않는다
  it('still answers CAPTURE_TILE while it is on', async () => {
    const value = fixture()
    await boundAndVisible(value)
    await value.host.handle({ type: 'SET_PREVIEW_PAUSED', paused: true })

    const response = await value.host.handle({ type: 'CAPTURE_TILE', tileId: 't1' })
    expect(response).toMatchObject({ ok: true, type: 'CAPTURE_TILE', format: 'jpeg' })
  })
})

//+_+// P6-D56. C-e2 가 메우려던 단서는 사후에 필요하다. 워커 콘솔은 워커가 죽으면 함께 사라진다
describe('P6-D56 - the reconnect verdicts are readable after the fact', () => {
  function seeded(projects: unknown[]): StubStorage {
    const storage = new StubStorage()
    storage.store.set(STORAGE_KEY, {
      schemaVersion: 2,
      activeProjectId: DEFAULT_PROJECT_ID,
      projects,
    })
    return storage
  }

  function project(id: string, name: string, tiles: WebTile[]): unknown {
    return { id, name, gridColumns: 4, gridRows: 4, keepManagedTabsAlive: false, tiles }
  }

  function tile(id: string, launchUrl: string, x = 0): WebTile {
    return {
      id,
      launchUrl,
      matchMode: 'exact',
      x,
      y: 0,
      w: 1,
      h: 1,
      refreshIntervalMs: CAPTURE_INTERVAL_MS.spanSmall,
      fitMode: 'contain',
      keepAlive: false,
    }
  }

  function rowsOf(value: Fixture) {
    return readReconnectRows(value.diagnostics?.store.get(RECONNECT_LOG_KEY))
  }

  it('records a bind with its candidate count and the active flag', async () => {
    const value = fixture(
      [11],
      seeded([project(DEFAULT_PROJECT_ID, 'WebDeck', [tile('t1', 'https://example.com/11')])]),
      new StubStorage(),
    )
    await value.host.load()

    expect(rowsOf(value)).toEqual([
      expect.objectContaining({
        tileId: 't1',
        projectId: DEFAULT_PROJECT_ID,
        kind: 'bind',
        candidates: 1,
        active: true,
      }),
    ])
  })

  it('records a tile that found no candidate', async () => {
    const value = fixture(
      [11],
      seeded([project(DEFAULT_PROJECT_ID, 'WebDeck', [tile('t1', 'https://elsewhere.test/gone')])]),
      new StubStorage(),
    )
    await value.host.load()

    expect(rowsOf(value)[0]).toMatchObject({ kind: 'none', candidates: 0 })
  })

  //+_+// 후보 수가 판정을 가른다. ambiguous 는 몇 개였는지가 사후 조사의 핵심이다
  it('records how many candidates an ambiguous tile had', async () => {
    const value = fixture(
      [],
      seeded([project(DEFAULT_PROJECT_ID, 'WebDeck', [tile('t1', 'https://example.com/same')])]),
      new StubStorage(),
    )
    value.tabsBackend.tabs.set(11, tabInfo(11, 'https://example.com/same'))
    value.tabsBackend.tabs.set(12, tabInfo(12, 'https://example.com/same'))
    value.tabsBackend.tabs.set(13, tabInfo(13, 'https://example.com/same'))
    await value.host.load()

    expect(rowsOf(value)[0]).toMatchObject({ kind: 'ambiguous', candidates: 3 })
  })

  //+_+// 비활성 프로젝트의 타일이 이 계측의 출발점이었다. active 로 갈린다
  it('marks a tile that belongs to a project that was not active', async () => {
    const value = fixture(
      [11],
      seeded([
        project(DEFAULT_PROJECT_ID, 'WebDeck', []),
        project('project-a', 'A', [tile('t1', 'https://example.com/11')]),
      ]),
      new StubStorage(),
    )
    await value.host.load()

    expect(rowsOf(value)[0]).toMatchObject({
      tileId: 't1',
      projectId: 'project-a',
      kind: 'bind',
      active: false,
    })
  })

  //+_+// P6-D16 · D18 과 같은 자리다. 상태 봉투를 지나지 않는다
  it('never writes the state key with its rows', async () => {
    const value = fixture(
      [11],
      seeded([project(DEFAULT_PROJECT_ID, 'WebDeck', [tile('t1', 'https://example.com/11')])]),
      new StubStorage(),
    )
    await value.host.load()

    expect(value.diagnostics?.store.has(STORAGE_KEY)).toBe(false)
    expect(Object.hasOwn(value.storage.store.get(STORAGE_KEY) as object, 'schemaVersion')).toBe(true)
  })

  it('writes nothing when no diagnostics backend is wired', async () => {
    const value = fixture(
      [11],
      seeded([project(DEFAULT_PROJECT_ID, 'WebDeck', [tile('t1', 'https://example.com/11')])]),
    )
    await expect(value.host.load()).resolves.toMatchObject({ ok: true })
    expect(value.diagnostics).toBeNull()
  })
})

//+_+// P6-D3 · D104. v1 section 22 의 Restricted URL 이 제품 경로에서 어떻게 보이고 어떻게 도는가
//+_+// L29 를 닫는 자리다. 표시와 재시도 중단이 같은 판정을 쓴다
describe('P6-D3 - a restricted url tile', () => {
  async function boundToChromePage() {
    const value = fixture([11])
    value.tabsBackend.tabs.set(11, tabInfo(11, 'chrome://extensions'))
    const bound = await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'restricted', tabId: 11 })
    expect(bound.ok).toBe(true)
    return value
  }

  //+_+// B-e1
  it('reports RESTRICTED', async () => {
    const { host } = await boundToChromePage()
    const state = await projectState(host)
    expect(state.runtimeStates[0]?.status).toBe('RESTRICTED')
  })

  //+_+// B-e2. L29 의 "영원히 붙을 수 없는 탭도 계속 재시도한다" 가 끝나는 자리다
  it('never attaches even after many ticks', async () => {
    const { host, debuggerBackend, clock } = await boundToChromePage()
    for (let round = 0; round < 20; round += 1) {
      clock.current += 4000
      driveTick(host)
      await Promise.resolve()
    }
    expect(debuggerBackend.attached).toEqual([])
  })

  //+_+// 재시도를 멈춰도 재연결 대상이 되지는 않는다. 그러면 Open Missing Tabs 가 탭을 또 연다
  it('is not treated as a tile that lost its tab', async () => {
    const { host } = await boundToChromePage()
    const opened = await host.handle({ type: 'OPEN_MISSING_TABS', projectId: DEFAULT_PROJECT_ID })
    if (!opened.ok || opened.type !== 'OPEN_MISSING_TABS') {
      throw new Error('unexpected response')
    }
    expect(opened.openedTileIds).toEqual([])
  })

  //+_+// P5-D6. Refresh Preview 도 회차를 만들지 않는다
  it('refuses Refresh Preview', async () => {
    const { host, debuggerBackend } = await boundToChromePage()
    const captured = await host.handle({ type: 'CAPTURE_TILE', tileId: 'restricted' })
    expect(captured.ok).toBe(false)
    expect(debuggerBackend.attached).toEqual([])
  })

  //+_+// B-e5. 같은 배선에서 제한이 아닌 타일은 그대로 돈다
  it('leaves an ordinary tile capturing', async () => {
    const value = await boundToChromePage()
    value.tabsBackend.tabs.set(12, tabInfo(12, 'https://example.com/12'))
    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'ordinary', tabId: 12 })
    await projectState(value.host)

    value.clock.current += 4000
    driveTick(value.host)
    await Promise.resolve()

    expect(value.debuggerBackend.attached).toEqual([12])
  })

  //+_+// 사용자가 타일 탭을 chrome:// 로 옮기면 다음 폴링이 그것을 집는다
  it('picks up a tab that navigates into a restricted url', async () => {
    const value = fixture([11])
    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'drifting', tabId: 11 })
    expect((await projectState(value.host)).runtimeStates[0]?.status).not.toBe('RESTRICTED')

    value.tabsBackend.tabs.set(11, tabInfo(11, 'chrome://version'))
    const after = await projectState(value.host)
    expect(after.runtimeStates[0]?.status).toBe('RESTRICTED')

    value.debuggerBackend.attached.length = 0
    value.clock.current += 4000
    driveTick(value.host)
    await Promise.resolve()
    expect(value.debuggerBackend.attached).toEqual([])
  })
})

//+_+// P6-D9 · D113. v1 section 15.5 다. 조회 1종만 더했고 표시 항목이 한정돼 있다
describe('P6-D9 - GET_DIAGNOSTICS', () => {
  //+_+// 회차가 정산될 때까지 마이크로태스크를 비운다. F2 절의 flush 와 같은 방식이다
  async function flush(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  }

  async function diagnosticsOf(host: DashboardHost) {
    const response = await host.handle({ type: 'GET_DIAGNOSTICS' })
    if (!response.ok || response.type !== 'GET_DIAGNOSTICS') {
      throw new Error(`unexpected response ${JSON.stringify(response)}`)
    }
    return response.diagnostics
  }

  //+_+// A-e2
  it('answers on an empty project without inventing numbers', async () => {
    const snapshot = await diagnosticsOf(fixture().host)
    expect(snapshot.roundDurationMs).toEqual({ count: 0, min: null, mid: null, max: null })
    expect(snapshot.timeouts).toBe(0)
    expect(snapshot.registeredTiles).toBe(0)
    expect(snapshot.attachedTabs).toBe(0)
  })

  it('counts the registered tiles and the attached tabs', async () => {
    const value = fixture([11, 12])
    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'a', tabId: 11 })
    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'b', tabId: 12 })
    driveTick(value.host)
    await flush()

    const snapshot = await diagnosticsOf(value.host)
    expect(snapshot.registeredTiles).toBe(2)
    expect(snapshot.attachedTabs).toBe(2)
  })

  it('spreads the round durations of the rounds that ran', async () => {
    const value = fixture([11])
    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'a', tabId: 11 })
    driveTick(value.host)
    await flush()

    const snapshot = await diagnosticsOf(value.host)
    expect(snapshot.roundDurationMs.count).toBeGreaterThan(0)
    expect(snapshot.roundDurationMs.min).not.toBeNull()
  })

  //+_+// B-e4. 최근 몇 개 기준인지를 응답이 밝힌다
  it('states the sample limit and the five record log sizes', async () => {
    const snapshot = await diagnosticsOf(fixture().host)
    expect(snapshot.sampleLimit).toBe(RECORD_LOG_LIMIT)
    expect(snapshot.recordLogs.map((log) => log.name)).toEqual([
      'captureRecords',
      'lateArrivals',
      'attachFailures',
      'detachEvents',
      'detachFailures',
    ])
    for (const log of snapshot.recordLogs) {
      expect(log.limit).toBe(RECORD_LOG_LIMIT)
    }
  })

  //+_+// B-e3. 누적 카운터는 상한과 무관하게 는다. 워커 기동 수가 그것이다
  it('reads the cumulative worker start count from the diagnostics wiring', async () => {
    const diagnostics = new StubStorage()
    diagnostics.store.set(WORKER_STARTS_KEY, { starts: 42, recentAt: [1, 2] })
    const value = fixture([11], new StubStorage(), diagnostics)
    expect((await diagnosticsOf(value.host)).workerStarts).toBe(42)
  })

  //+_+// 모르는 것은 null 이다. 0 으로 적으면 관측했다는 뜻이 된다
  it('reports an unknown worker start count as null when nothing is wired', async () => {
    expect((await diagnosticsOf(fixture().host)).workerStarts).toBeNull()
  })

  //+_+// A-e4. 계측 키를 응답에 싣지 않는다. 그것은 실측 도구다
  it('carries no diagnostics storage key and no round log', async () => {
    const diagnostics = new StubStorage()
    const value = fixture([11], new StubStorage(), diagnostics)
    await value.host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 'a', tabId: 11 })
    driveTick(value.host)
    await flush()

    const text = JSON.stringify(await diagnosticsOf(value.host))
    expect(text).not.toContain('webdeck.diagnostics')
    expect(text).not.toContain(ROUND_LOG_KEY)
    expect(text).not.toContain(RECONNECT_LOG_KEY)
    expect(text).not.toContain('[webdeck]')
  })

  //+_+// P6-D10. 평균도 분위수도 없다
  it('carries no average and no percentile', async () => {
    const text = JSON.stringify(await diagnosticsOf(fixture().host))
    for (const forbidden of ['average', 'mean', 'p50', 'p95', 'p99']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

//+_+// WEBDECK_PLAN 8-2.3 1번. tileId 가 없거나 타일을 만드는 셋은 projectId 를 싣는다
//+_+// 워커가 그 값을 다시 판정한다. 화면이 이미 판정했더라도다 (P4-D12 선례)
describe('8-2.3 1 - the three project-scoped requests reject an unknown projectId', () => {
  it('refuses ADD_TILE', async () => {
    const { host } = fixture()
    const response = await host.handle({
      type: 'ADD_TILE',
      projectId: 'no-such-project',
      source: { kind: 'tab', tabId: 11 },
    })

    expect(response).toMatchObject({
      ok: false,
      type: 'ADD_TILE',
      errorCode: 'PROJECT_NOT_FOUND',
    })
  })

  it('refuses OPEN_MISSING_TABS', async () => {
    const { host } = fixture()
    const response = await host.handle({
      type: 'OPEN_MISSING_TABS',
      projectId: 'no-such-project',
    })

    expect(response).toMatchObject({
      ok: false,
      type: 'OPEN_MISSING_TABS',
      errorCode: 'PROJECT_NOT_FOUND',
    })
  })

  it('refuses BIND_TILE', async () => {
    const { host } = fixture()
    const response = await host.handle({
      type: 'BIND_TILE',
      projectId: 'no-such-project',
      tileId: 't1',
      tabId: 11,
    })

    expect(response).toMatchObject({
      ok: false,
      type: 'BIND_TILE',
      errorCode: 'PROJECT_NOT_FOUND',
    })
  })

  //+_+// ADD_TILE 은 url 경로에서 탭을 먼저 만든다. 거절이 그보다 앞서야 탭이 남지 않는다
  it('refuses ADD_TILE before it creates a tab', async () => {
    const value = fixture()
    await value.host.handle({
      type: 'ADD_TILE',
      projectId: 'no-such-project',
      source: { kind: 'url', url: 'https://example.org/dash' },
    })

    expect(value.createdUrls).toEqual([])
  })
})

//+_+// J158. 아홉 자리가 실제로 조회로 바뀌었는지는 순수 함수 시험이 증명하지 못한다
//+_+// 비활성 프로젝트의 타일에 tileId 로 닿는 것이 그 배선의 증거다
describe('8-2.3 1 - a tileId request reaches a tile outside the active project', () => {
  it('removes a tile that belongs to an inactive project', async () => {
    const { host } = fixture()
    const created = await host.handle({ type: 'CREATE_PROJECT', name: 'Monitoring' })
    if (!created.ok || created.type !== 'CREATE_PROJECT') {
      throw new Error('create failed')
    }
    const other = created.project.id

    const added = await host.handle({
      type: 'ADD_TILE',
      projectId: other,
      source: { kind: 'tab', tabId: 11 },
    })
    if (!added.ok || added.type !== 'ADD_TILE') {
      throw new Error('add failed')
    }

    //+_+// 활성은 여전히 기본 프로젝트다. 전환하지 않는다
    const removed = await host.handle({ type: 'REMOVE_TILE', tileId: added.tileId })

    expect(removed).toMatchObject({ ok: true, type: 'REMOVE_TILE' })
    const listed = await host.handle({ type: 'LIST_PROJECTS' })
    if (!listed.ok || listed.type !== 'LIST_PROJECTS') {
      throw new Error('list failed')
    }
    expect(listed.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(listed.projects.find((item) => item.id === other)?.tiles).toEqual([])
  })
})

//+_+// TASK-P8-05 §1.2. 포트 이름이 화면과 워커를 잇는 유일한 자료다
describe('8-2 port lifetime - the port name carries the clientId', () => {
  it('round trips a clientId', () => {
    expect(clientIdOfPortName(portName('abc'))).toBe('abc')
  })

  it('refuses a name with another prefix', () => {
    expect(clientIdOfPortName('measure')).toBeNull()
    expect(clientIdOfPortName('harness')).toBeNull()
  })

  it('refuses the prefix with nothing after it', () => {
    expect(clientIdOfPortName(PORT_NAME_PREFIX)).toBeNull()
  })
})

//+_+// TASK-P8-05 §1.4. 장부는 host 안이다. 리스너는 이름을 풀어 이 둘을 부르기만 한다
//+_+// 그래서 chrome 스텁 없이 여기서 직접 부를 수 있다
describe('8-2 port lifetime - the host records connect and disconnect', () => {
  async function diagnosticsOf(host: DashboardHost) {
    const response = await host.handle({ type: 'GET_DIAGNOSTICS' })
    if (!response.ok || response.type !== 'GET_DIAGNOSTICS') {
      throw new Error('diagnostics failed')
    }
    return response.diagnostics
  }

  it('records both events in order', async () => {
    const diagnostics = new StubStorage()
    const { host } = fixture([11, 12], new StubStorage(), diagnostics)

    await host.portConnected('c1', 1000)
    await host.portConnected('c2', 1100)
    await host.portDisconnected('c1', 1200)

    expect((await diagnosticsOf(host)).portEvents).toEqual([
      { at: 1000, event: 'connect', clientId: 'c1' },
      { at: 1100, event: 'connect', clientId: 'c2' },
      { at: 1200, event: 'disconnect', clientId: 'c1' },
    ])
  })

  it('writes to the port event key and leaves the state envelope alone', async () => {
    const diagnostics = new StubStorage()
    const { host } = fixture([11, 12], new StubStorage(), diagnostics)

    await host.portConnected('c1', 1000)

    expect([...diagnostics.store.keys()]).toEqual([PORT_EVENT_KEY])
    expect(readPortEvents(diagnostics.store.get(PORT_EVENT_KEY))).toMatchObject({
      connects: 1,
      disconnects: 0,
    })
  })

  //+_+// 탭 둘이 동시에 끊기는 경우다. 직렬화하지 않으면 읽고 쓰는 사이에 서로를 덮는다
  it('keeps both rows when two events are not awaited apart', async () => {
    const diagnostics = new StubStorage()
    const { host } = fixture([11, 12], new StubStorage(), diagnostics)

    await Promise.all([host.portDisconnected('c1', 2000), host.portDisconnected('c2', 2001)])

    expect((await diagnosticsOf(host)).portEvents).toHaveLength(2)
    expect(readPortEvents(diagnostics.store.get(PORT_EVENT_KEY)).disconnects).toBe(2)
  })

  //+_+// 화면에 나르는 것은 꼬리뿐이다. 저장 상한 200 을 2초마다 응답에 싣지 않는다
  it('carries only the tail to the screen', async () => {
    const diagnostics = new StubStorage()
    const { host } = fixture([11, 12], new StubStorage(), diagnostics)

    for (let index = 0; index < PORT_EVENT_VIEW + 3; index += 1) {
      await host.portConnected('c1', index)
    }

    const shown = (await diagnosticsOf(host)).portEvents
    expect(shown).toHaveLength(PORT_EVENT_VIEW)
    expect(shown[0]?.at).toBe(3)
    expect(readPortEvents(diagnostics.store.get(PORT_EVENT_KEY)).connects).toBe(PORT_EVENT_VIEW + 3)
  })

  //+_+// 계측 배선이 없으면 아무것도 쓰지 않는다. rounds 와 같은 규칙이다
  it('does nothing when there is no diagnostics backend', async () => {
    const { host } = fixture()

    await host.portConnected('c1', 1000)

    expect((await diagnosticsOf(host)).portEvents).toEqual([])
  })
})

//+_+// TASK-P8-07 §1.1 · §1.2. 임차 장부가 활성 집합을 만들고 그것이 등록을 가른다
//+_+// 장부가 host 안이므로 chrome 스텁 없이 진입점으로 직접 덮는다
describe('8-2.3 2 - the lease ledger drives the active set', () => {
  async function twoProjects(host: DashboardHost): Promise<string> {
    await host.handle({ type: 'BIND_TILE', projectId: DEFAULT_PROJECT_ID, tileId: 't1', tabId: 11 })
    const created = await host.handle({ type: 'CREATE_PROJECT', name: 'Monitoring' })
    if (!created.ok || created.type !== 'CREATE_PROJECT') {
      throw new Error('create failed')
    }
    const other = created.project.id
    await host.handle({ type: 'BIND_TILE', projectId: other, tileId: 't2', tabId: 12 })
    return other
  }

  it('holds both projects when two leases name different ones', async () => {
    const { host } = fixture()
    const other = await twoProjects(host)

    await projectStateOf(host, DEFAULT_PROJECT_ID, true, 'client-1')
    await projectStateOf(host, other, true, 'client-2')

    expect(host.engine.captures.statusOf('t1')).not.toBeNull()
    expect(host.engine.captures.statusOf('t2')).not.toBeNull()
    expect(host.engine.captures.registeredTileCount).toBe(2)
  })

  //+_+// 포트 끊김이 정상 경로다 (P8-D11). 그 clientId 의 임차만 지운다
  it('drops a project from the set when its lease goes', async () => {
    const { host } = fixture()
    const other = await twoProjects(host)
    await projectStateOf(host, DEFAULT_PROJECT_ID, true, 'client-1')
    await projectStateOf(host, other, true, 'client-2')

    await host.portDisconnected('client-2', 1000)

    expect(host.engine.captures.statusOf('t1')).not.toBeNull()
    expect(host.engine.captures.statusOf('t2')).toBeNull()
    expect(host.engine.captures.registeredTileCount).toBe(1)
  })

  //+_+// P8-D7. 하나라도 보이면 캡처가 돈다. 받은 값으로 전역을 덮지 않는다
  it('keeps the engine running while one lease is visible', async () => {
    const { host } = fixture()
    const other = await twoProjects(host)

    await projectStateOf(host, DEFAULT_PROJECT_ID, true, 'client-1')
    await projectStateOf(host, other, false, 'client-2')

    expect(host.engine.captures.paused).toBe(false)
  })

  //+_+// 덮는 배선이면 뒤 폴링의 false 가 앞 폴링의 true 를 지워 여기서 true 가 된다
  it('does not let the last poll overwrite the global', async () => {
    const { host } = fixture()
    const other = await twoProjects(host)

    await projectStateOf(host, DEFAULT_PROJECT_ID, true, 'client-1')
    await projectStateOf(host, other, false, 'client-2')
    await projectStateOf(host, other, false, 'client-2')

    expect(host.engine.captures.paused).toBe(false)
  })

  it('pauses when no lease is left', async () => {
    const { host } = fixture()
    await twoProjects(host)
    await projectStateOf(host, DEFAULT_PROJECT_ID, true, 'client-1')
    expect(host.engine.captures.paused).toBe(false)

    await host.portDisconnected('client-1', 1000)

    expect(host.engine.captures.paused).toBe(true)
  })

  //+_+// §1.4. 안전망이다. onDisconnect 가 안 난 임차만 여기로 온다
  it('sweeps a lease that stopped polling', async () => {
    const value = fixture()
    await twoProjects(value.host)
    await projectStateOf(value.host, DEFAULT_PROJECT_ID, true, 'client-1')
    expect(value.host.engine.captures.statusOf('t1')).not.toBeNull()

    value.clock.current += LEASE_EXPIRY_MS
    await value.host.sweepLeases()

    expect(value.host.engine.captures.statusOf('t1')).toBeNull()
    expect(value.host.engine.captures.paused).toBe(true)
  })

  it('leaves a lease that is still polling', async () => {
    const value = fixture()
    await twoProjects(value.host)
    await projectStateOf(value.host, DEFAULT_PROJECT_ID, true, 'client-1')

    value.clock.current += LEASE_EXPIRY_MS - 1
    await value.host.sweepLeases()

    expect(value.host.engine.captures.statusOf('t1')).not.toBeNull()
  })

  //+_+// 폴링이 마지막 시각을 덮으므로 계속 도는 탭은 만료되지 않는다
  it('renews the lease on every poll', async () => {
    const value = fixture()
    await twoProjects(value.host)
    await projectStateOf(value.host, DEFAULT_PROJECT_ID, true, 'client-1')

    value.clock.current += LEASE_EXPIRY_MS - 1
    await projectStateOf(value.host, DEFAULT_PROJECT_ID, true, 'client-1')
    value.clock.current += LEASE_EXPIRY_MS - 1
    await value.host.sweepLeases()

    expect(value.host.engine.captures.statusOf('t1')).not.toBeNull()
  })

  //+_+// §1.5. 거절할 때 임차를 만들지 않는다
  //+_+// 임차가 생겼다면 visible true 하나가 있어 전역이 풀렸을 것이다
  it('does not open a lease for a projectId it refuses', async () => {
    const { host } = fixture()
    await twoProjects(host)

    const response = await host.handle({
      type: 'GET_PROJECT_STATE',
      clientId: 'client-1',
      projectId: 'no-such-project',
      dashboardVisible: true,
    })

    expect(response).toMatchObject({ ok: false, errorCode: 'PROJECT_NOT_FOUND' })
    expect(host.engine.captures.paused).toBe(true)
  })
})
