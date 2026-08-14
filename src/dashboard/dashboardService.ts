import type { GridRect } from '../shared/grid'
import type {
  AddTileSource,
  DashboardRequest,
  DashboardResponse,
  TileSettings,
} from '../shared/messages'

//+_+// P4-D7 이 정한 폴링 주기다. 워커의 캡처 주기와 별개이며 서로를 참조하지 않는다
export const POLL_INTERVAL_MS = 2000

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

//+_+// P5-D22. 활성 프로젝트 id 는 워커가 알려 준 값이다. 상수를 하드코딩하지 않는다
export async function fetchProjectState(
  projectId: string,
  dashboardVisible: boolean,
): Promise<DashboardResponse> {
  return send({ type: 'GET_PROJECT_STATE', projectId, dashboardVisible })
}

export async function listProjects(): Promise<DashboardResponse> {
  return send({ type: 'LIST_PROJECTS' })
}

export async function createProject(name: string): Promise<DashboardResponse> {
  return send({ type: 'CREATE_PROJECT', name })
}

export async function renameProject(projectId: string, name: string): Promise<DashboardResponse> {
  return send({ type: 'RENAME_PROJECT', projectId, name })
}

export async function deleteProject(projectId: string): Promise<DashboardResponse> {
  return send({ type: 'DELETE_PROJECT', projectId })
}

export async function setActiveProject(projectId: string): Promise<DashboardResponse> {
  return send({ type: 'SET_ACTIVE_PROJECT', projectId })
}

export async function listBrowserTabs(): Promise<DashboardResponse> {
  return send({ type: 'LIST_BROWSER_TABS' })
}

//+_+// P5-D27. 타일 id 는 워커가 만들어 응답에 싣는다. 화면이 미리 만들지 않는다
export async function addTile(source: AddTileSource): Promise<DashboardResponse> {
  return send({ type: 'ADD_TILE', source })
}

//+_+// S5 의 Bind Existing Tab 이 쓴다. 이미 있는 타일을 다른 탭에 다시 거는 저수준 수단이다
export async function bindTile(tileId: string, tabId: number): Promise<DashboardResponse> {
  return send({ type: 'BIND_TILE', tileId, tabId })
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
export async function openMissingTabs(): Promise<DashboardResponse> {
  return send({ type: 'OPEN_MISSING_TABS' })
}

//+_+// v1 section 14 의 Refresh Preview 다. 페이지를 reload 하지 않는다
export async function captureTile(tileId: string): Promise<DashboardResponse> {
  return send({ type: 'CAPTURE_TILE', tileId })
}

export async function setTileSettings(
  tileId: string,
  settings: TileSettings,
): Promise<DashboardResponse> {
  return send({ type: 'SET_TILE_SETTINGS', tileId, settings })
}
