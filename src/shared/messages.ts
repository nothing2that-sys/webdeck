import type { GridRect } from './grid'
import type { BrowserTabInfo, Project, TileRuntimeState } from './types'

//+_+// P5-D22. 기본 프로젝트의 id 다. 목록이 비었을 때 워커가 세우는 프로젝트가 이 id 를 쓴다
//+_+// 새로 만드는 프로젝트의 id 는 crypto.randomUUID 다. 이 상수는 기본 프로젝트 전용이다
//+_+// Dashboard 는 이 값을 요청에 실어 보내지 않는다. 활성 프로젝트 id 를 워커에서 받아 쓴다
export const DEFAULT_PROJECT_ID = 'webdeck.default'

//+_+// 기본 프로젝트의 이름이다. 사용자가 이름을 바꾸면 저장값이 이긴다
export const DEFAULT_PROJECT_NAME = 'WebDeck'

//+_+// v1 section 19 line 1143~1150 의 7개. WORKSPACE 계열만 PROJECT 로 치환했다
//+_+// P4-D12 의 SET_TILE_RECT 가 8번째다. v1 section 19 에 이름이 없어 새로 지은 유일한 요청이다
//+_+// P5-D23 의 프로젝트 CRUD 5개가 9~13번째다. v1 section 19 에 대응 항목이 없어 명명 규칙만 따랐다
export type DashboardRequest =
  //+_+// P4-D11. dashboardVisible 을 폴링마다 싣는다. 표시 상태 전용 요청을 만들지 않는다. J15
  | { type: 'GET_PROJECT_STATE'; projectId: string; dashboardVisible: boolean }
  | { type: 'LIST_BROWSER_TABS' }
  | { type: 'BIND_TILE'; tileId: string; tabId: number }
  | { type: 'CAPTURE_TILE'; tileId: string }
  | { type: 'FOCUS_TILE'; tileId: string }
  | { type: 'RELOAD_TILE'; tileId: string }
  | { type: 'SET_TILE_KEEP_ALIVE'; tileId: string; enabled: boolean }
  //+_+// P4-D12. 유효성 판정의 권위는 워커다. 화면은 후보 rect 만 보낸다
  | { type: 'SET_TILE_RECT'; tileId: string; rect: GridRect }
  | { type: 'LIST_PROJECTS' }
  | { type: 'CREATE_PROJECT'; name: string }
  | { type: 'RENAME_PROJECT'; projectId: string; name: string }
  | { type: 'DELETE_PROJECT'; projectId: string }
  | { type: 'SET_ACTIVE_PROJECT'; projectId: string }

export type DashboardRequestType = DashboardRequest['type']

//+_+// errorCode 를 union 으로 좁히지 않는다. 오류 분류는 WEBDECK_PLAN section 8 이 Phase 6 으로 배정했다
export interface DashboardFailure {
  ok: false
  type: DashboardRequestType
  errorCode: string
  message: string
}

//+_+// 조회 3개와 CAPTURE_TILE 과 CREATE_PROJECT 가 payload 를 갖는다. 나머지 8개는 성공 여부만이다
export type CaptureImageFormat = 'jpeg' | 'png'

//+_+// 전송은 base64 문자열이다. L12 확정. ArrayBuffer / Blob / ImageBitmap 은 확장 메시징이 나르지 못한다
//+_+// bytes 는 디코드된 이미지의 바이트 수다. base64 문자열 길이가 아니다
export interface TileFrame {
  tileId: string
  imageBase64: string
  format: CaptureImageFormat
  bytes: number
}

//+_+// P4-D7. 프레임은 GET_PROJECT_STATE 응답에 얹는다. union 구성원 수를 늘리지 않는다
//+_+// 타일당 최신 1장만이다. 워커가 보유한 것을 그대로 옮기고 이력을 만들지 않는다
export type DashboardResponse =
  | {
      ok: true
      type: 'GET_PROJECT_STATE'
      project: Project
      runtimeStates: TileRuntimeState[]
      frames: TileFrame[]
    }
  | { ok: true; type: 'LIST_BROWSER_TABS'; tabs: BrowserTabInfo[] }
  | { ok: true; type: 'BIND_TILE' }
  | {
      ok: true
      type: 'CAPTURE_TILE'
      imageBase64: string
      format: CaptureImageFormat
      bytes: number
    }
  | { ok: true; type: 'FOCUS_TILE' }
  | { ok: true; type: 'RELOAD_TILE' }
  | { ok: true; type: 'SET_TILE_KEEP_ALIVE' }
  | { ok: true; type: 'SET_TILE_RECT' }
  //+_+// P5-D22. 화면은 활성 프로젝트 id 를 여기서 받는다. 상수를 하드코딩하지 않는다
  | { ok: true; type: 'LIST_PROJECTS'; projects: Project[]; activeProjectId: string }
  | { ok: true; type: 'CREATE_PROJECT'; project: Project }
  | { ok: true; type: 'RENAME_PROJECT' }
  | { ok: true; type: 'DELETE_PROJECT' }
  | { ok: true; type: 'SET_ACTIVE_PROJECT' }
  | DashboardFailure

type SuccessResponseType = Extract<DashboardResponse, { ok: true }>['type']

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type AssertTrue<T extends true> = T

//+_+// 요청 13개와 성공 응답이 1:1 로 대응하지 않으면 컴파일이 깨진다. 핸들러 없이 망라성을 고정한다
export type RequestsAndResponsesMatch = AssertTrue<
  MutuallyAssignable<DashboardRequestType, SuccessResponseType>
>

//+_+// switch 망라성 검사용. 처리되지 않은 분기가 남으면 컴파일 타임에 깨진다
export function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(value)}`)
}
