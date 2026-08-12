import { effectiveIntervalMs } from '../shared/scheduler'
import type { BrowserTabInfo, WebTile } from '../shared/types'
import { DebuggerSessionManager } from './debuggerSessionManager'
import type { DebuggerBackend } from './debuggerSessionManager'
import { PreviewCaptureManager, systemClock } from './previewCaptureManager'
import type { Clock, PreviewCaptureManagerOptions } from './previewCaptureManager'
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

//+_+// 서비스 워커는 최상위에서 스스로 시작한다. 아직 manifest 에 등록돼 있지 않다
//+_+// 등록은 dashboard 가 생기는 Phase 4 다. 그때까지 이 파일은 조립만 검증된다
if (typeof chrome !== 'undefined' && typeof chrome.debugger !== 'undefined') {
  startPreviewDriver(createPreviewEngine(chromeDebuggerBackend(), chromeTabsBackend()))
}
