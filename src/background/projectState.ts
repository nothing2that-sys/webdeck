import { findFirstAvailablePosition } from '../shared/grid'
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from '../shared/messages'
import { defaultRefreshIntervalMs } from '../shared/scheduler'
import type { BrowserTabInfo, Project, TileRuntimeState, TileStatus, WebTile } from '../shared/types'
import type { CaptureRecord } from './previewCaptureManager'

//+_+// 빈 4x4 프로젝트 1개다. v1 section 8 의 Workspace 모델이며 이름만 Project 다. P5-D1
//+_+// P5-D3. keepManagedTabsAlive 는 기존 필드이므로 기본값으로만 둔다. 동작을 만들지 않는다
export function createProject(id: string, name: string): Project {
  return {
    id,
    name,
    gridColumns: 4,
    gridRows: 4,
    keepManagedTabsAlive: false,
    tiles: [],
  }
}

//+_+// P5-D8. 목록이 비면 기본 프로젝트 1개를 만든다. 저장 키 부재와 빈 목록을 구별하지 않는다
//+_+// 활성 id 가 어느 프로젝트도 가리키지 않으면 첫 프로젝트로 되돌린다. 활성 없음 상태를 만들지 않는다
export function resolveProjects(
  projects: Project[],
  activeProjectId: string,
): { projects: Project[]; activeProjectId: string } {
  const first = projects[0]
  if (first === undefined) {
    return {
      projects: [createProject(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME)],
      activeProjectId: DEFAULT_PROJECT_ID,
    }
  }
  if (projects.some((project) => project.id === activeProjectId)) {
    return { projects, activeProjectId }
  }
  return { projects, activeProjectId: first.id }
}

//+_+// P5-D27 의 ADD_TILE 이 만드는 타일이다. span 은 1x1 고정이다
//+_+// 사용자 지정 span 은 Resize 가 만든다. 생성 시점에 고르게 하지 않는다
//+_+// 이름은 P4-D2 의 개발 전용 바인딩에서 왔다. 그 UI 는 P5-D13 으로 사라졌고 상수는 계승됐다
export const DEV_TILE_SPAN = 1

//+_+// 자리가 없으면 null 이다. v1 section 7.2 line 589 가 사용자에게 알리라고 요구한다
export function newTile(
  tileId: string,
  launchUrl: string,
  tiles: readonly WebTile[],
): WebTile | null {
  const position = findFirstAvailablePosition(DEV_TILE_SPAN, DEV_TILE_SPAN, tiles)
  if (position === null) {
    return null
  }
  return {
    id: tileId,
    launchUrl,
    //+_+// P5-D28. 기본값은 exact 다. 오매칭은 사용자가 눈치채기 어렵고 미매칭은 DETACHED 로 보인다
    //+_+// 소비자는 S6 의 v1 section 10 재연결이다. 회피 수단은 S3 의 matchMode 노출이다
    matchMode: 'exact',
    x: position.x,
    y: position.y,
    w: DEV_TILE_SPAN,
    h: DEV_TILE_SPAN,
    refreshIntervalMs: defaultRefreshIntervalMs(DEV_TILE_SPAN, DEV_TILE_SPAN),
    fitMode: 'contain',
    keepAlive: false,
  }
}

//+_+// previewCaptureManager 는 타일별 마지막 회차를 공개하지 않는다. 정산 훅으로 따로 접는다
//+_+// 기록 배열을 매 폴링마다 훑지 않는다. L26 이 상한 없는 배열을 이미 지적했다
export interface TileCaptureSummary {
  lastCaptureAt?: number
  lastRoundDurationMs?: number
  consecutiveCaptureFailures: number
}

export const EMPTY_CAPTURE_SUMMARY: TileCaptureSummary = { consecutiveCaptureFailures: 0 }

//+_+// 성공 회차만 시각과 소요를 옮긴다. 실패가 마지막 갱신 시각을 덮으면 화면이 거짓을 말한다
//+_+// 회차 정산 시각은 startedAt + roundDurationMs 다. 여기서 시계를 다시 읽지 않는다
export function applyCaptureRecord(
  prev: TileCaptureSummary,
  record: CaptureRecord,
): TileCaptureSummary {
  if (record.outcome !== 'success') {
    return { ...prev, consecutiveCaptureFailures: prev.consecutiveCaptureFailures + 1 }
  }
  return {
    lastCaptureAt: record.startedAt + record.roundDurationMs,
    lastRoundDurationMs: record.roundDurationMs,
    consecutiveCaptureFailures: 0,
  }
}

//+_+// 캡처 엔진이 아는 타일은 엔진의 판정을 그대로 쓴다. 우선순위는 resolveTileStatus 가 이미 정했다
//+_+// FROZEN / DISCARDED 는 v1 section 11 의 탭 상태이고 Phase 4 에 구현이 없다
//+_+// DEVTOOLS 는 L25 로 도달 불가다. 배지는 만들지만 여기서 만들어 내지 않는다
//+_+// 예외가 하나다. 엔진은 등록 시각을 신선도 기준으로 삼으므로 첫 프레임 전에도 LIVE 를 낸다
//+_+// 화면에 프레임이 없는데 LIVE 라고 적으면 거짓이다. 그 구간은 v1 section 7 의 LOADING 이다
//+_+// STALE 은 덮지 않는다. 한 번도 오지 않은 것도 신선하지 않은 것이 맞다
export function resolveRuntimeStatus(
  captureStatus: TileStatus | null,
  tabId: number | undefined,
  tab: BrowserTabInfo | null,
  hasCapture: boolean,
): TileStatus {
  if (captureStatus === 'LIVE' && !hasCapture) {
    return 'LOADING'
  }
  if (captureStatus !== null) {
    return captureStatus
  }
  if (tabId === undefined) {
    return 'LOADING'
  }
  return tab === null ? 'DETACHED' : 'LOADING'
}

//+_+// 모르는 값에 undefined 를 넣지 않는다. storage.ts 의 pickTile 과 같은 규칙이다
export function buildRuntimeState(
  tileId: string,
  tabId: number | undefined,
  tab: BrowserTabInfo | null,
  status: TileStatus,
  summary: TileCaptureSummary,
): TileRuntimeState {
  const state: TileRuntimeState = {
    tileId,
    status,
    consecutiveCaptureFailures: summary.consecutiveCaptureFailures,
  }
  if (tabId !== undefined) {
    state.tabId = tabId
  }
  if (tab !== null) {
    state.windowId = tab.windowId
    state.title = tab.title
    state.currentUrl = tab.currentUrl
    if (tab.favIconUrl !== undefined) {
      state.favIconUrl = tab.favIconUrl
    }
  }
  if (summary.lastCaptureAt !== undefined) {
    state.lastCaptureAt = summary.lastCaptureAt
  }
  if (summary.lastRoundDurationMs !== undefined) {
    state.lastRoundDurationMs = summary.lastRoundDurationMs
  }
  return state
}
