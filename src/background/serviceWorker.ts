import { isPlacementValid } from '../shared/grid'
import type { GridRect } from '../shared/grid'
import { DEFAULT_PROJECT_ID, assertNever } from '../shared/messages'
import type {
  DashboardFailure,
  DashboardRequest,
  DashboardRequestType,
  DashboardResponse,
  TileFrame,
} from '../shared/messages'
import { defaultRefreshIntervalMs, effectiveIntervalMs } from '../shared/scheduler'
import type { BrowserTabInfo, Project, TileRuntimeState, WebTile } from '../shared/types'
import { DebuggerSessionManager, errorMessage } from './debuggerSessionManager'
import type { DebuggerBackend } from './debuggerSessionManager'
import { PreviewCaptureManager, systemClock } from './previewCaptureManager'
import type { Clock, PreviewCaptureManagerOptions } from './previewCaptureManager'
import {
  EMPTY_CAPTURE_SUMMARY,
  applyCaptureRecord,
  buildRuntimeState,
  newTile,
  resolveRuntimeStatus,
} from './projectState'
import type { TileCaptureSummary } from './projectState'
import { TabManager } from './tabManager'
import type { TabsBackend } from './tabManager'

//+_+// v1 section 12 가 요구하는 프로토콜 버전이다. POC 도 같은 값을 썼다
export const DEBUGGER_PROTOCOL_VERSION = '1.3'

//+_+// 구동자의 해상도다. 가장 짧은 캡처 주기 2000 보다 촘촘해야 만기를 놓치지 않는다
//+_+// POC 가 500 에서 올려 쓴 값이다. 스케줄 정책 상수가 아니라 tick 간격이다
export const DRIVER_TICK_MS = 1000

export interface PreviewEngine {
  sessions: DebuggerSessionManager
  captures: PreviewCaptureManager
  tabs: TabManager
  registerTile(tile: WebTile, tabId: number, dashboardVisible: boolean): void
}

//+_+// 스케줄 결정은 previewCaptureManager 의 selectDueTiles 가 한다. 여기는 구동자와 배선만이다
export function createPreviewEngine(
  debuggerBackend: DebuggerBackend,
  tabsBackend: TabsBackend,
  clock: Clock = systemClock,
  options: PreviewCaptureManagerOptions = {},
): PreviewEngine {
  const sessions = new DebuggerSessionManager(debuggerBackend)
  const captures = new PreviewCaptureManager(debuggerBackend, sessions, clock, options)
  const tabs = new TabManager(tabsBackend)

  //+_+// 탭이 닫히면 그 탭의 타일 캡처를 멈추고 리스를 놓는다
  tabs.onTabRemoved((tabId) => {
    void captures.releaseTab(tabId)
  })

  return {
    sessions,
    captures,
    tabs,
    //+_+// hidden 여부에 따른 주기 선택은 구동자가 한다. 캡처 엔진은 받은 주기를 그대로 쓴다
    //+_+// 표시 상태가 바뀌면 다시 등록해야 반영된다. 대시보드가 생기는 Phase 4 항목이다
    registerTile: (tile, tabId, dashboardVisible) => {
      captures.register(tile.id, tabId, effectiveIntervalMs(tile, dashboardVisible))
    },
  }
}

//+_+// 구동자다. 스케줄 결정 로직과 분리해 둔다. WEBDECK_PLAN section 3.6 이 보류로 둔 선택지 때문이다
export function startPreviewDriver(engine: PreviewEngine, intervalMs = DRIVER_TICK_MS): () => void {
  const handle: ReturnType<typeof setInterval> = setInterval(() => {
    engine.captures.tick()
  }, intervalMs)
  return () => {
    clearInterval(handle)
  }
}

//+_+// Phase 4 의 프로젝트는 워커 메모리에 1개다. 저장은 WEBDECK_PLAN section 7 이 Phase 5 다
//+_+// 워커가 종료되면 타일이 사라진다. 영구화가 없으므로 복구할 곳이 없다
export function emptyProject(): Project {
  return {
    id: DEFAULT_PROJECT_ID,
    name: 'WebDeck',
    gridColumns: 4,
    gridRows: 4,
    keepManagedTabsAlive: false,
    tiles: [],
  }
}

export interface DashboardHost {
  engine: PreviewEngine
  //+_+// senderWindowId 는 요청을 보낸 Dashboard 탭의 창이다. 없으면 마지막으로 포커스된 창을 쓴다
  handle(request: DashboardRequest, senderWindowId?: number): Promise<DashboardResponse>
}

export type ListTabs = (windowId: number | undefined) => Promise<BrowserTabInfo[]>

//+_+// TabsBackend 에 넣지 않는다. harness/p3 가 그 인터페이스를 구현하고 Phase 3 산출물은 동결이다
//+_+// ListTabs 와 같은 자리다. 캡처 엔진이 쓰지 않는 chrome 호출은 어댑터로 따로 주입한다
export type FocusTab = (tabId: number, windowId: number) => Promise<void>

function failure(
  type: DashboardRequestType,
  errorCode: string,
  message: string,
): DashboardFailure {
  return { ok: false, type, errorCode, message }
}

//+_+// Dashboard 요청 처리기다. chrome 전역을 직접 부르지 않으므로 주입한 backend 로 시험할 수 있다
//+_+// 엔진을 여기서 만든다. 정산 훅이 엔진 생성 시점에 필요하고 요약을 이 안에서 접기 때문이다
export function createDashboardHost(
  debuggerBackend: DebuggerBackend,
  tabsBackend: TabsBackend,
  listTabs: ListTabs,
  focusTab: FocusTab,
  clock: Clock = systemClock,
): DashboardHost {
  const project = emptyProject()
  const bindings = new Map<string, number>()
  const summaries = new Map<string, TileCaptureSummary>()

  //+_+// P4-D11. 대시보드가 보내오는 표시 상태다. 요청이 오기 전에는 보이는 것으로 둔다
  let dashboardVisible = true

  const engine = createPreviewEngine(debuggerBackend, tabsBackend, clock, {
    onCaptureSettled: (record) => {
      summaries.set(
        record.tileId,
        applyCaptureRecord(summaries.get(record.tileId) ?? EMPTY_CAPTURE_SUMMARY, record),
      )
    },
  })

  //+_+// P4-D11. 값이 바뀐 회차에만 재등록한다. 매 폴링마다 재등록하면 만기가 now 로 되돌아 주기가 무너진다
  //+_+// v1 section 6 line 414~417 의 hidden 주기는 타일 값을 무시하는 별도 정책이다
  function applyDashboardVisible(next: boolean): void {
    if (next === dashboardVisible) {
      return
    }
    dashboardVisible = next
    for (const tile of project.tiles) {
      const tabId = bindings.get(tile.id)
      if (tabId !== undefined) {
        engine.registerTile(tile, tabId, dashboardVisible)
      }
    }
  }

  async function projectState(): Promise<DashboardResponse> {
    const runtimeStates: TileRuntimeState[] = []
    const frames: TileFrame[] = []

    for (const tile of project.tiles) {
      const tabId = bindings.get(tile.id)
      const tab = tabId === undefined ? null : await engine.tabs.info(tabId)
      const summary = summaries.get(tile.id) ?? EMPTY_CAPTURE_SUMMARY
      const status = resolveRuntimeStatus(
        engine.captures.statusOf(tile.id),
        tabId,
        tab,
        summary.lastCaptureAt !== undefined,
      )
      runtimeStates.push(buildRuntimeState(tile.id, tabId, tab, status, summary))

      //+_+// 타일당 최신 1장만 싣는다. 이력을 만들지 않는다. v1 section 6.2 는 저장도 금지한다
      const frame = engine.captures.latestFrame(tile.id)
      if (frame !== null) {
        frames.push({
          tileId: tile.id,
          imageBase64: frame.imageBase64,
          format: frame.format,
          bytes: frame.bytes,
        })
      }
    }

    return { ok: true, type: 'GET_PROJECT_STATE', project, runtimeStates, frames }
  }

  //+_+// P4-D12. 화면이 이미 판정했더라도 워커가 다시 판정한다. 같은 isPlacementValid 를 쓴다
  //+_+// 레이아웃은 워커 메모리에만 있다. 영구화는 WEBDECK_PLAN section 7 의 Phase 5 다
  function setTileRect(tileId: string, rect: GridRect): DashboardResponse {
    const tile = project.tiles.find((item) => item.id === tileId)
    if (tile === undefined) {
      return failure('SET_TILE_RECT', 'TILE_NOT_FOUND', `Unknown tileId ${tileId}`)
    }
    if (!isPlacementValid(rect, project.tiles, tileId)) {
      return failure(
        'SET_TILE_RECT',
        'INVALID_LAYOUT',
        `Rect overlaps another tile or leaves the ${String(project.gridColumns)}x${String(project.gridRows)} grid`,
      )
    }

    //+_+// span 이 바뀌면 v1 section 6 의 주기 구간도 바뀐다. P4-D4 는 값을 그대로 두라고 했을 뿐이다
    const resized = rect.w !== tile.w || rect.h !== tile.h
    tile.x = rect.x
    tile.y = rect.y
    tile.w = rect.w
    tile.h = rect.h
    if (!resized) {
      return { ok: true, type: 'SET_TILE_RECT' }
    }

    tile.refreshIntervalMs = defaultRefreshIntervalMs(rect.w, rect.h)
    const tabId = bindings.get(tileId)
    if (tabId !== undefined) {
      engine.registerTile(tile, tabId, dashboardVisible)
    }
    return { ok: true, type: 'SET_TILE_RECT' }
  }

  //+_+// TASK-P4-01 S3. Focus 는 워커 경유다. v1 section 20 이 UI 의 chrome 직접 호출을 금지한다
  //+_+// 바인딩이 없으면 활성화할 탭이 없다. 창은 탭 정보에서 읽는다. 화면이 보낸 값을 믿지 않는다
  async function focusTile(tileId: string): Promise<DashboardResponse> {
    const tabId = bindings.get(tileId)
    if (tabId === undefined) {
      return failure('FOCUS_TILE', 'TILE_NOT_BOUND', `Tile ${tileId} is not bound to a tab`)
    }
    const tab = await engine.tabs.info(tabId)
    if (tab === null) {
      return failure('FOCUS_TILE', 'TAB_NOT_FOUND', `No tab with id ${String(tabId)}`)
    }
    await focusTab(tabId, tab.windowId)
    return { ok: true, type: 'FOCUS_TILE' }
  }

  //+_+// P4-D2. 모르는 tileId 면 첫 빈 자리에 1x1 타일을 만든다. 아는 tileId 면 탭만 다시 건다
  //+_+// 새 메시지 이름을 만들지 않기 위해 v1 section 19 의 BIND_TILE 하나로 둘을 처리한다
  async function bindTile(tileId: string, tabId: number): Promise<DashboardResponse> {
    const tab = await engine.tabs.info(tabId)
    if (tab === null) {
      return failure('BIND_TILE', 'TAB_NOT_FOUND', `No tab with id ${String(tabId)}`)
    }

    const existing = project.tiles.find((tile) => tile.id === tileId)
    const tile = existing ?? newTile(tileId, tab.currentUrl, project.tiles)
    if (tile === null) {
      return failure('BIND_TILE', 'GRID_FULL', 'The 4x4 grid has no empty slot left')
    }

    //+_+// 다른 탭에 걸려 있던 타일이면 먼저 내린다. 그러지 않으면 이전 탭의 리스가 남는다
    if (bindings.get(tileId) !== undefined && bindings.get(tileId) !== tabId) {
      await engine.captures.unregister(tileId)
    }
    if (existing === undefined) {
      project.tiles.push(tile)
    }
    bindings.set(tileId, tabId)
    summaries.delete(tileId)

    //+_+// P4-D11 이후로는 마지막 폴링이 알려 준 표시 상태를 쓴다
    engine.registerTile(tile, tabId, dashboardVisible)
    return { ok: true, type: 'BIND_TILE' }
  }

  return {
    engine,
    handle: async (request, senderWindowId) => {
      switch (request.type) {
        case 'GET_PROJECT_STATE':
          if (request.projectId !== project.id) {
            return failure(
              request.type,
              'PROJECT_NOT_FOUND',
              `Unknown projectId ${request.projectId}`,
            )
          }
          applyDashboardVisible(request.dashboardVisible)
          return projectState()
        case 'LIST_BROWSER_TABS':
          return { ok: true, type: 'LIST_BROWSER_TABS', tabs: await listTabs(senderWindowId) }
        case 'BIND_TILE':
          return bindTile(request.tileId, request.tabId)
        //+_+// P4-D8. 핸들러를 만들지 않는다. 프레임은 GET_PROJECT_STATE 가 나른다. 타입은 남긴다
        case 'CAPTURE_TILE':
          return failure(request.type, 'NOT_IMPLEMENTED', 'CAPTURE_TILE has no handler (P4-D8)')
        case 'FOCUS_TILE':
          return focusTile(request.tileId)
        case 'SET_TILE_RECT':
          return setTileRect(request.tileId, request.rect)
        //+_+// WEBDECK_PLAN section 7 이 Reopen 과 Keep Alive 를 Phase 5 에 배정했다
        case 'RELOAD_TILE':
        case 'SET_TILE_KEEP_ALIVE':
          return failure(request.type, 'NOT_IMPLEMENTED', `${request.type} is Phase 5`)
        default:
          return assertNever(request)
      }
    },
  }
}

export function chromeDebuggerBackend(): DebuggerBackend {
  return {
    attach: (tabId) => chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION),
    detach: (tabId) => chrome.debugger.detach({ tabId }),
    sendCommand: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
    onDetach: (listener) => {
      chrome.debugger.onDetach.addListener((source, reason) => {
        if (source.tabId !== undefined) {
          listener(source.tabId, reason)
        }
      })
    },
  }
}

function toTabInfo(tab: chrome.tabs.Tab): BrowserTabInfo | null {
  if (tab.id === undefined) {
    return null
  }
  const info: BrowserTabInfo = {
    tabId: tab.id,
    windowId: tab.windowId,
    currentUrl: tab.url ?? '',
    title: tab.title ?? '',
  }
  if (tab.favIconUrl !== undefined) {
    info.favIconUrl = tab.favIconUrl
  }
  return info
}

export function chromeTabsBackend(): TabsBackend {
  return {
    //+_+// 없는 탭은 오류가 아니라 null 이다. chrome.tabs.get 은 없는 탭에 reject 한다
    get: async (tabId) => {
      try {
        return toTabInfo(await chrome.tabs.get(tabId))
      } catch {
        return null
      }
    },
    onRemoved: (listener) => {
      chrome.tabs.onRemoved.addListener((tabId) => {
        listener(tabId)
      })
    },
    onUpdated: (listener) => {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.url !== undefined) {
          listener(tabId, changeInfo.url)
        }
      })
    },
  }
}

//+_+// v1 section 13 line 849. 탭을 활성화하고 그 탭이 든 창을 함께 올린다
//+_+// 탭만 활성화하면 다른 창에 있는 탭은 화면에 나타나지 않는다
function chromeFocusTab(): FocusTab {
  return async (tabId, windowId) => {
    await chrome.tabs.update(tabId, { active: true })
    await chrome.windows.update(windowId, { focused: true })
  }
}

export const DASHBOARD_PAGE = 'dashboard.html'

//+_+// 요청을 보낸 창의 탭만 돌려준다. 창을 모르면 마지막으로 포커스된 창을 쓴다
//+_+// 확장 자신의 페이지는 뺀다. Dashboard 를 자기 자신에 걸면 자기 화면을 재귀로 캡처한다
function chromeListTabs(): ListTabs {
  return async (windowId) => {
    const query: chrome.tabs.QueryInfo =
      windowId === undefined ? { currentWindow: true } : { windowId }
    const own = chrome.runtime.getURL('')
    const tabs = await chrome.tabs.query(query)
    return tabs
      .map(toTabInfo)
      .filter((tab): tab is BrowserTabInfo => tab !== null && !tab.currentUrl.startsWith(own))
  }
}

//+_+// P4-D3. 찾아서 활성화하고 없으면 만든다. 중복 생성 방지 강화는 Phase 5 다
//+_+// v1 section 13 line 849 가 탭과 창을 함께 활성화하라고 요구한다
export async function openDashboard(): Promise<void> {
  const url = chrome.runtime.getURL(DASHBOARD_PAGE)
  const existing = await chrome.tabs.query({ url })
  const first = existing[0]
  if (first?.id !== undefined) {
    await chrome.tabs.update(first.id, { active: true })
    await chrome.windows.update(first.windowId, { focused: true })
    return
  }
  await chrome.tabs.create({ url })
}

//+_+// 서비스 워커는 최상위에서 스스로 시작한다. 리스너 등록도 최상위여야 한다
//+_+// chrome 이 없는 환경에서는 아무것도 하지 않는다. 그래서 단위 테스트가 이 파일을 import 할 수 있다
if (typeof chrome !== 'undefined' && typeof chrome.debugger !== 'undefined') {
  const host = createDashboardHost(
    chromeDebuggerBackend(),
    chromeTabsBackend(),
    chromeListTabs(),
    chromeFocusTab(),
  )
  startPreviewDriver(host.engine)

  chrome.runtime.onMessage.addListener((message: DashboardRequest, sender, sendResponse) => {
    host.handle(message, sender.tab?.windowId).then(sendResponse, (error: unknown) => {
      sendResponse(failure(message.type, 'HANDLER_THREW', errorMessage(error)))
    })
    //+_+// 비동기 응답이다. true 를 돌려주지 않으면 채널이 먼저 닫힌다
    return true
  })

  //+_+// v1 section 13 line 855. Action 버튼으로도 Dashboard 를 열거나 활성화한다
  chrome.action.onClicked.addListener(() => {
    void openDashboard().catch((error: unknown) => {
      console.error('[webdeck] openDashboard failed', errorMessage(error))
    })
  })
}
