//+_+// v1 section 7 line 523~529 의 7개. 하나도 더하지 않는다
export type TileStatus =
  | 'LIVE'
  | 'LOADING'
  | 'STALE'
  | 'FROZEN'
  | 'DISCARDED'
  | 'DETACHED'
  | 'ERROR'

export type TileMatchMode = 'exact' | 'origin' | 'prefix'

export type TileFitMode = 'contain' | 'cover'

export interface WebTile {
  id: string
  customTitle?: string
  launchUrl: string
  matchMode: TileMatchMode
  x: number
  y: number
  w: number
  h: number
  refreshIntervalMs: number
  fitMode: TileFitMode
  keepAlive: boolean
}

export interface Project {
  id: string
  name: string
  gridColumns: 4
  gridRows: 4
  keepManagedTabsAlive: boolean
  tiles: WebTile[]
}

//+_+// 런타임 탭 식별 필드는 v1 section 4.2 line 254~262 가 정한 다섯 개다
export interface BrowserTabInfo {
  tabId: number
  windowId: number
  currentUrl: string
  title: string
  favIconUrl?: string
}

//+_+// 영구 저장 대상이 아니다. v1 section 8 line 637
export interface TileRuntimeState {
  tileId: string
  tabId?: number
  windowId?: number
  title?: string
  currentUrl?: string
  favIconUrl?: string
  status: TileStatus
  lastCaptureAt?: number
  lastCaptureDurationMs?: number
  consecutiveCaptureFailures: number
}
