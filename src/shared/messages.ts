import type { GridRect } from './grid'
import type {
  BrowserTabInfo,
  Project,
  TileFitMode,
  TileMatchMode,
  TileRuntimeState,
} from './types'

//+_+// P5-D22. 기본 프로젝트의 id 다. 목록이 비었을 때 워커가 세우는 프로젝트가 이 id 를 쓴다
//+_+// 새로 만드는 프로젝트의 id 는 crypto.randomUUID 다. 이 상수는 기본 프로젝트 전용이다
//+_+// Dashboard 는 이 값을 요청에 실어 보내지 않는다. 활성 프로젝트 id 를 워커에서 받아 쓴다
export const DEFAULT_PROJECT_ID = 'webdeck.default'

//+_+// 기본 프로젝트의 이름이다. 사용자가 이름을 바꾸면 저장값이 이긴다
export const DEFAULT_PROJECT_NAME = 'WebDeck'

//+_+// v1 section 9.1 의 두 경로다. tab 은 기존 탭을 걸고 url 은 워커가 새 탭을 만든다
export type AddTileSource = { kind: 'tab'; tabId: number } | { kind: 'url'; url: string }

//+_+// P5-D31. 부분 갱신을 만들지 않는다. 4필드 전체 교체다
//+_+// 부분 갱신은 "필드 부재" 와 "값 비우기" 를 구별할 수 없다. customTitle 을 지우는 경로가 필요하다
//+_+// 미지정의 표현은 customTitle 이 빈 문자열, refreshIntervalOverrideMs 가 null 이다
export interface TileSettings {
  customTitle: string
  fitMode: TileFitMode
  matchMode: TileMatchMode
  refreshIntervalOverrideMs: number | null
}

//+_+// v1 section 19 line 1143~1150 의 7개. WORKSPACE 계열만 PROJECT 로 치환했다
//+_+// P4-D12 의 SET_TILE_RECT 가 8번째다. v1 section 19 에 이름이 없어 새로 지은 유일한 요청이다
//+_+// P5-D23 의 프로젝트 CRUD 5개가 9~13번째다. v1 section 19 에 대응 항목이 없어 명명 규칙만 따랐다
//+_+// P5-D27 의 ADD_TILE 이 14번째다. v1 section 9.1 의 두 경로를 한 요청 아래 둔다
//+_+// P6-D47 의 SET_PREVIEW_PAUSED 가 19번째다. v1 section 15.1 이 이름을 주지 않아 명명 규칙만 따랐다
//+_+// P6-D9 의 GET_DIAGNOSTICS 가 20번째다. v1 section 15.5 도 화면만 말하고 요청 이름을 주지 않았다
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
  //+_+// P5-D31. 같은 원칙이다. 화면이 검증했더라도 워커가 override 하한을 다시 본다
  | { type: 'SET_TILE_SETTINGS'; tileId: string; settings: TileSettings }
  //+_+// P5-D27. BIND_TILE 을 확장하지 않는다. 그쪽은 저수준 재바인딩 수단으로 남는다. J9
  | { type: 'ADD_TILE'; source: AddTileSource }
  //+_+// P5-D32. ADD_TILE 은 새 타일을 만들고 이것은 기존 타일의 자리와 설정을 지킨다. 둘을 묶지 않는다
  | { type: 'REOPEN_TILE'; tileId: string }
  //+_+// P5-D33. 타일만 지운다. 사용자의 탭은 닫지 않는다. CLAUDE.md section 5.2
  | { type: 'REMOVE_TILE'; tileId: string }
  //+_+// P5-D37. v1 section 10 의 6단계다. REOPEN_TILE 의 일괄판이며 메시지를 합치지 않는다
  | { type: 'OPEN_MISSING_TABS' }
  | { type: 'LIST_PROJECTS' }
  | { type: 'CREATE_PROJECT'; name: string }
  | { type: 'RENAME_PROJECT'; projectId: string; name: string }
  | { type: 'DELETE_PROJECT'; projectId: string }
  | { type: 'SET_ACTIVE_PROJECT'; projectId: string }
  //+_+// P6-D47. v1 section 15.1 의 전체 Pause 다. P5-D4 가 Phase 6 으로 넘긴 넷 중 하나다
  //+_+// P6-D48. 타일별 Pause 는 만들지 않는다. 이것은 대시보드 전체를 멈춘다
  | { type: 'SET_PREVIEW_PAUSED'; paused: boolean }
  //+_+// P6-D9. v1 section 15.5 의 Diagnostics 다. 조회 1종만 더한다. 20번째다
  | { type: 'GET_DIAGNOSTICS' }

export type DashboardRequestType = DashboardRequest['type']

//+_+// errorCode 를 union 으로 좁히지 않는다. 오류 분류는 WEBDECK_PLAN section 8 이 Phase 6 으로 배정했다
export interface DashboardFailure {
  ok: false
  type: DashboardRequestType
  errorCode: string
  message: string
}

//+_+// 조회 3개와 CAPTURE_TILE / CREATE_PROJECT / ADD_TILE 이 payload 를 갖는다. 나머지 8개는 성공 여부만이다
export type CaptureImageFormat = 'jpeg' | 'png'

//+_+// 전송은 base64 문자열이다. L12 확정. ArrayBuffer / Blob / ImageBitmap 은 확장 메시징이 나르지 못한다
//+_+// bytes 는 디코드된 이미지의 바이트 수다. base64 문자열 길이가 아니다
export interface TileFrame {
  tileId: string
  imageBase64: string
  format: CaptureImageFormat
  bytes: number
}

//+_+// P6-D10 · D113. 최소 · 중간 · 최대다. 평균을 넣지 않는다. 분포가 이봉형이라 대표값이 아니다 (L22)
//+_+// 중간은 nearest-rank 중앙값이다. 보간하지 않으므로 관측되지 않은 수를 만들지 않는다
//+_+// 분위수도 넣지 않는다. P6-D113 이 표시 항목을 여기 적힌 것으로 한정했다
export interface DurationSpread {
  count: number
  min: number | null
  mid: number | null
  max: number | null
}

//+_+// P6-D112. 기록 배열 하나의 현재 길이와 상한이다. 이름이 화면에 그대로 나온다
export interface RecordLogSize {
  name: string
  length: number
  limit: number
}

//+_+// P6-D113. Diagnostics 가 나르는 전부다. 계측 키(webdeck.diagnostics.*)를 여기에 싣지 않는다
//+_+// 그것은 실측 도구이고 사용자 화면의 것이 아니다
export interface DiagnosticsSnapshot {
  //+_+// P6-D112. 소요와 타임아웃 수가 최근 몇 개를 기준으로 한 값인지다. 전체 누적이 아니다
  sampleLimit: number
  roundDurationMs: DurationSpread
  timeouts: number
  registeredTiles: number
  attachedTabs: number
  //+_+// 누적이다. 상한과 무관하게 는다. 계측 배선이 없으면 null 이다. 0 과 구별한다
  workerStarts: number | null
  recordLogs: RecordLogSize[]
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
      //+_+// P6-D47. 화면이 새로 열려도 토글이 실제 상태를 그린다. 전용 조회를 만들지 않는다
      previewPaused: boolean
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
  | { ok: true; type: 'SET_TILE_SETTINGS' }
  //+_+// 타일 id 는 워커가 만든다. BIND_TILE 과 다른 점이며 화면이 그것을 응답에서 받는다
  | { ok: true; type: 'ADD_TILE'; tileId: string }
  | { ok: true; type: 'REOPEN_TILE'; tabId: number }
  | { ok: true; type: 'REMOVE_TILE' }
  //+_+// 성공한 것만 싣는다. 일부 실패가 전체를 되돌리지 않는다
  | { ok: true; type: 'OPEN_MISSING_TABS'; openedTileIds: string[] }
  //+_+// P5-D22. 화면은 활성 프로젝트 id 를 여기서 받는다. 상수를 하드코딩하지 않는다
  | { ok: true; type: 'LIST_PROJECTS'; projects: Project[]; activeProjectId: string }
  | { ok: true; type: 'CREATE_PROJECT'; project: Project }
  | { ok: true; type: 'RENAME_PROJECT' }
  | { ok: true; type: 'DELETE_PROJECT' }
  | { ok: true; type: 'SET_ACTIVE_PROJECT' }
  | { ok: true; type: 'SET_PREVIEW_PAUSED'; paused: boolean }
  | { ok: true; type: 'GET_DIAGNOSTICS'; diagnostics: DiagnosticsSnapshot }
  | DashboardFailure

type SuccessResponseType = Extract<DashboardResponse, { ok: true }>['type']

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type AssertTrue<T extends true> = T

//+_+// P6-D9 로 20개가 됐다. 요청과 성공 응답이 1:1 로 대응하지 않으면 컴파일이 깨진다
//+_+// 핸들러 없이 망라성을 고정한다
export type RequestsAndResponsesMatch = AssertTrue<
  MutuallyAssignable<DashboardRequestType, SuccessResponseType>
>

//+_+// switch 망라성 검사용. 처리되지 않은 분기가 남으면 컴파일 타임에 깨진다
export function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(value)}`)
}
