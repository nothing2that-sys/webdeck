//+_+// v1 section 7 line 523~529 의 7개에 DEVTOOLS 하나만 더한 8개였다
//+_+// v1 section 12 line 826 이 DevTools 충돌을 ERROR 로 만들지 말라고 요구한다. L19 해소
//+_+// P6-D3. RESTRICTED 가 9번째다. v1 section 22 의 Restricted URL 이며 L29 를 닫는다
//+_+// P6-D102. 이름은 v1 section 22 와 L29 가 쓰는 말 그대로다. 줄임말을 새로 만들지 않는다
//+_+// CAPTURE PAUSED 는 더하지 않는다. 전체 Pause 는 상태가 아니라 억제 플래그다 (P6-D6a · D46)
export type TileStatus =
  | 'LIVE'
  | 'LOADING'
  | 'STALE'
  | 'FROZEN'
  | 'DISCARDED'
  | 'DETACHED'
  | 'DEVTOOLS'
  | 'ERROR'
  | 'RESTRICTED'

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
  //+_+// P5-D21. 사용자 지정 주기다. v1 section 8 에 없는 유일한 추가 필드이며 P5-D16 의 구현 형태다
  //+_+// refreshIntervalMs 의 의미를 바꾸지 않는다. 그쪽은 span 자동 배정이 계속 소유한다
  refreshIntervalOverrideMs?: number
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
  //+_+// P4-D9. 회차 소요다. P3-D9 가 회차와 호출을 나눈 뒤로 이름이 어긋나 있었다
  lastRoundDurationMs?: number
  consecutiveCaptureFailures: number
}
