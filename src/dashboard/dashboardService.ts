import type { GridRect } from '../shared/grid'
import { DEFAULT_PROJECT_ID } from '../shared/messages'
import type { DashboardRequest, DashboardResponse } from '../shared/messages'

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

export async function fetchProjectState(dashboardVisible: boolean): Promise<DashboardResponse> {
  return send({ type: 'GET_PROJECT_STATE', projectId: DEFAULT_PROJECT_ID, dashboardVisible })
}

export async function listBrowserTabs(): Promise<DashboardResponse> {
  return send({ type: 'LIST_BROWSER_TABS' })
}

export async function bindTile(tileId: string, tabId: number): Promise<DashboardResponse> {
  return send({ type: 'BIND_TILE', tileId, tabId })
}

export async function focusTile(tileId: string): Promise<DashboardResponse> {
  return send({ type: 'FOCUS_TILE', tileId })
}

export async function setTileRect(tileId: string, rect: GridRect): Promise<DashboardResponse> {
  return send({ type: 'SET_TILE_RECT', tileId, rect })
}

//+_+// 타일 id 는 요청하는 쪽이 만든다. BIND_TILE 이 tileId 를 받는 형태이기 때문이다
export function newTileId(): string {
  return crypto.randomUUID()
}
