import type { GridRect } from '../shared/grid'
import { portName } from '../shared/messages'
import type {
  AddTileSource,
  DashboardRequest,
  DashboardResponse,
  TileSettings,
} from '../shared/messages'

//+_+// P4-D7 이 정한 폴링 주기다. 워커의 캡처 주기와 별개이며 서로를 참조하지 않는다
export const POLL_INTERVAL_MS = 2000

//+_+// P8-D8. 화면이 만드는 탭 식별자다. 모듈 최상위라 문서 수명과 같다
//+_+// fetchProjectState 가 이 값을 GET_PROJECT_STATE 에 싣는다 (WEBDECK_PLAN 8-2.3 2번)
const clientId = crypto.randomUUID()

export function dashboardClientId(): string {
  return clientId
}

//+_+// TASK-P8-05 §1.1. 수명 신호 전용이다. 포트로 아무것도 보내지 않는다
//+_+// 참조를 모듈에 붙든다. 놓았을 때 수거되어 워커가 끊김으로 읽는지는 확인되지 않았다
//+_+// harness/p3/main.ts 와 measure/transport/measure.js 도 참조를 든다. 그 형태를 따른다
let lifetimePort: chrome.runtime.Port | null = null

//+_+// 두 번 불러도 포트를 둘 만들지 않는다. main.tsx 가 한 번만 부르지만 규칙을 여기 둔다
export function connectLifetimePort(): void {
  if (lifetimePort !== null) {
    return
  }
  lifetimePort = chrome.runtime.connect({ name: portName(clientId) })
}

//+_+// v1 section 20. UI 컴포넌트는 chrome.* 를 부르지 않는다. 이 파일이 유일한 호출 지점이다
//+_+// 워커가 없거나 응답 전에 죽으면 sendMessage 가 reject 한다. 실패도 union 으로 돌려준다
async function send(request: DashboardRequest): Promise<DashboardResponse> {
  try {
    return (await chrome.runtime.sendMessage(request)) as DashboardResponse
  } catch (error) {
    return {
      ok: false,
      type: request.type,
      errorCode: 'SEND_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

//+_+// P4-D11. 표시 상태는 폴링에 얹어 보낸다. 이 값을 판정하는 곳은 워커다
export function isDashboardVisible(): boolean {
  return document.visibilityState === 'visible'
}

//+_+// P5-D9. visibilitychange 는 같은 상태로도 발화할 수 있다. 바뀐 회차만 통과시킨다
//+_+// 폴링 주기 자체는 건드리지 않는다. 이것은 그 사이의 즉시 통보 1회를 위한 문이다. L35
export function createVisibilityGate(initial: boolean): { changed(next: boolean): boolean } {
  let current = initial
  return {
    changed(next: boolean): boolean {
      if (next === current) {
        return false
      }
      current = next
      return true
    },
  }
}

//+_+// P5-D30. 화면이 아는 탭 목록이 낡았다는 뜻이다. 오류로 표시하지 않고 목록을 다시 읽는다
//+_+// J85 와 같은 원칙이다. 워커가 정본이고 화면이 따라간다
export function isStaleTabFailure(response: DashboardResponse): boolean {
  return !response.ok && response.errorCode === 'TAB_NOT_FOUND'
}

//+_+// P6-D47. v1 section 15.1 의 전체 Pause 다. 워커가 상태를 들고 화면은 요청만 보낸다
export async function setPreviewPaused(paused: boolean): Promise<DashboardResponse> {
  return send({ type: 'SET_PREVIEW_PAUSED', paused })
}

//+_+// P6-D9. v1 section 15.5 의 Diagnostics 다. 값은 전부 워커가 만든다. 화면은 받아 그리기만 한다
export async function fetchDiagnostics(): Promise<DashboardResponse> {
  return send({ type: 'GET_DIAGNOSTICS' })
}

//+_+// P5-D22. 활성 프로젝트 id 는 워커가 알려 준 값이다. 상수를 하드코딩하지 않는다
//+_+// P8-D8 · TASK-P8-07 §1.5. 이 탭의 clientId 를 함께 싣는다. 워커가 그것으로 임차를 가른다
//+_+// 화면 층은 이 값을 모른다. App.tsx 를 건드리지 않으려고 여기서 붙인다
export async function fetchProjectState(
  projectId: string,
  dashboardVisible: boolean,
): Promise<DashboardResponse> {
  return send({
    type: 'GET_PROJECT_STATE',
    projectId,
    clientId: dashboardClientId(),
    dashboardVisible,
  })
}

export async function listProjects(): Promise<DashboardResponse> {
  return send({ type: 'LIST_PROJECTS' })
}

//+_+// J171. 허브가 이름과 설명을 함께 보낸다. 설명을 안 넘기면 워커가 건드리지 않는다
export async function createProject(
  name: string,
  description?: string,
): Promise<DashboardResponse> {
  return send({ type: 'CREATE_PROJECT', name, description })
}

export async function renameProject(
  projectId: string,
  name: string,
  description?: string,
): Promise<DashboardResponse> {
  return send({ type: 'RENAME_PROJECT', projectId, name, description })
}

export async function deleteProject(projectId: string): Promise<DashboardResponse> {
  return send({ type: 'DELETE_PROJECT', projectId })
}

export async function setActiveProject(projectId: string): Promise<DashboardResponse> {
  return send({ type: 'SET_ACTIVE_PROJECT', projectId })
}

//+_+// P8-D16. 허브만 쓴다. 탭 생성은 워커가 한다. 화면은 chrome.tabs.* 를 부르지 않는다
export async function openProjectTab(projectId: string): Promise<DashboardResponse> {
  return send({ type: 'OPEN_PROJECT_TAB', projectId })
}

export async function listBrowserTabs(): Promise<DashboardResponse> {
  return send({ type: 'LIST_BROWSER_TABS' })
}

//+_+// P5-D27. 타일 id 는 워커가 만들어 응답에 싣는다. 화면이 미리 만들지 않는다
export async function addTile(
  projectId: string,
  source: AddTileSource,
): Promise<DashboardResponse> {
  return send({ type: 'ADD_TILE', projectId, source })
}

//+_+// S5 의 Bind Existing Tab 이 쓴다. 이미 있는 타일을 다른 탭에 다시 거는 저수준 수단이다
export async function bindTile(
  projectId: string,
  tileId: string,
  tabId: number,
): Promise<DashboardResponse> {
  return send({ type: 'BIND_TILE', projectId, tileId, tabId })
}

export async function focusTile(tileId: string): Promise<DashboardResponse> {
  return send({ type: 'FOCUS_TILE', tileId })
}

export async function setTileRect(tileId: string, rect: GridRect): Promise<DashboardResponse> {
  return send({ type: 'SET_TILE_RECT', tileId, rect })
}

export async function reopenTile(tileId: string): Promise<DashboardResponse> {
  return send({ type: 'REOPEN_TILE', tileId })
}

export async function removeTile(tileId: string): Promise<DashboardResponse> {
  return send({ type: 'REMOVE_TILE', tileId })
}

//+_+// v1 section 10 의 6단계다. 버튼으로만 돈다. 브라우저 시작과 동시에 돌지 않는다
export async function openMissingTabs(projectId: string): Promise<DashboardResponse> {
  return send({ type: 'OPEN_MISSING_TABS', projectId })
}

//+_+// v1 section 14 의 Refresh Preview 다. 페이지를 reload 하지 않는다
export async function captureTile(tileId: string): Promise<DashboardResponse> {
  return send({ type: 'CAPTURE_TILE', tileId })
}

//+_+// v1 section 14 의 Reload Page 다. 위와 짝이며 이쪽만 탭을 다시 읽는다
export async function reloadTile(tileId: string): Promise<DashboardResponse> {
  return send({ type: 'RELOAD_TILE', tileId })
}

export async function setTileSettings(
  tileId: string,
  settings: TileSettings,
): Promise<DashboardResponse> {
  return send({ type: 'SET_TILE_SETTINGS', tileId, settings })
}
