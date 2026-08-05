import type { Project, TileRuntimeState } from './types'

//+_+// v1 section 19 line 1143~1150 의 7개. WORKSPACE 계열만 PROJECT 로 치환했다
export type DashboardRequest =
  | { type: 'GET_PROJECT_STATE'; projectId: string }
  | { type: 'LIST_BROWSER_TABS' }
  | { type: 'BIND_TILE'; tileId: string; tabId: number }
  | { type: 'CAPTURE_TILE'; tileId: string }
  | { type: 'FOCUS_TILE'; tileId: string }
  | { type: 'RELOAD_TILE'; tileId: string }
  | { type: 'SET_TILE_KEEP_ALIVE'; tileId: string; enabled: boolean }

export type DashboardRequestType = DashboardRequest['type']

//+_+// 런타임 탭 식별 필드는 v1 section 4.2 line 254~262 가 정한 다섯 개다
export interface BrowserTabInfo {
  tabId: number
  windowId: number
  currentUrl: string
  title: string
  favIconUrl?: string
}

//+_+// errorCode 를 union 으로 좁히지 않는다. 오류 분류는 WEBDECK_PLAN section 8 이 Phase 6 으로 배정했다
export interface DashboardFailure {
  ok: false
  type: DashboardRequestType
  errorCode: string
  message: string
}

//+_+// 조회 2개만 payload 를 갖는다. 명령 5개는 성공 여부만 돌려준다
//+_+// CAPTURE_TILE 의 이미지 전달 형식은 Phase 3 미결 사항이다. WEBDECK_PLAN section 5 line 208
export type DashboardResponse =
  | { ok: true; type: 'GET_PROJECT_STATE'; project: Project; runtimeStates: TileRuntimeState[] }
  | { ok: true; type: 'LIST_BROWSER_TABS'; tabs: BrowserTabInfo[] }
  | { ok: true; type: 'BIND_TILE' }
  | { ok: true; type: 'CAPTURE_TILE' }
  | { ok: true; type: 'FOCUS_TILE' }
  | { ok: true; type: 'RELOAD_TILE' }
  | { ok: true; type: 'SET_TILE_KEEP_ALIVE' }
  | DashboardFailure

type SuccessResponseType = Extract<DashboardResponse, { ok: true }>['type']

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type AssertTrue<T extends true> = T

//+_+// 요청 7개와 성공 응답이 1:1 로 대응하지 않으면 컴파일이 깨진다. 핸들러 없이 망라성을 고정한다
export type RequestsAndResponsesMatch = AssertTrue<
  MutuallyAssignable<DashboardRequestType, SuccessResponseType>
>

//+_+// switch 망라성 검사용. 처리되지 않은 분기가 남으면 컴파일 타임에 깨진다
export function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(value)}`)
}
