import type { GridRect } from '../shared/grid'
import type { TileFrame, TileSettings } from '../shared/messages'
import {
  isValidCaptureTimeoutOverride,
  isValidIntervalOverride,
  isValidScrollCaptureIntervalOverride,
} from '../shared/scheduler'
import type {
  Project,
  TileFitMode,
  TileMatchMode,
  TileRuntimeState,
  TileStatus,
  WebTile,
} from '../shared/types'

//+_+// React 를 import 하지 않는다. P4-D6 이 순수 모듈을 node 환경에서 시험하기로 했다
export interface TileViewModel {
  tileId: string
  title: string
  favIconUrl: string | null
  tabId: number | null
  gridArea: string
  status: TileStatus
  statusClassName: string
  previewDataUrl: string | null
  lastCaptureLabel: string
  //+_+// P6-D2 (b). 타일 표시 규칙을 여기로 모은다. TileCard 는 값을 그리기만 한다
  tabLabel: string
  showsRecoveryActions: boolean
  //+_+// v1 section 15.6. CSS object-fit 값 그대로다. 크롭 로직을 직접 쓰지 않는다
  fitMode: TileFitMode
}

//+_+// 설정 폼은 문자열을 다루고 프로토콜은 값을 다룬다. 그 사이 변환을 여기 둔다
export interface TileSettingsDraft {
  customTitle: string
  fitMode: TileFitMode
  matchMode: TileMatchMode
  refreshIntervalOverrideMs: string
  //+_+// TASK-P12-04 (S2). refreshIntervalOverrideMs 와 같은 자리다. P12-D13
  captureTimeoutOverrideMs: string
  //+_+// TASK-P12-06 (S4). 같은 자리다. P12-D20
  scrollCaptureIntervalOverrideMs: string
}

//+_+// 미지정은 빈 문자열이다. 폼이 undefined 를 표시할 수 없기 때문이다
export function tileSettingsDraft(tile: WebTile): TileSettingsDraft {
  return {
    customTitle: tile.customTitle ?? '',
    fitMode: tile.fitMode,
    matchMode: tile.matchMode,
    refreshIntervalOverrideMs:
      tile.refreshIntervalOverrideMs === undefined
        ? ''
        : String(tile.refreshIntervalOverrideMs),
    captureTimeoutOverrideMs:
      tile.captureTimeoutOverrideMs === undefined
        ? ''
        : String(tile.captureTimeoutOverrideMs),
    scrollCaptureIntervalOverrideMs:
      tile.scrollCaptureIntervalOverrideMs === undefined
        ? ''
        : String(tile.scrollCaptureIntervalOverrideMs),
  }
}

//+_+// 빈 문자열은 미지정(null)이다. 값이 있는데 규칙에 안 맞으면 이 자리표로 구분한다
//+_+// parseTileSettings 와 tileSettingsDraftError 가 같은 판정을 쓰도록 한 곳에 둔다
const INVALID_OVERRIDE = Symbol('invalid-override')

function parseOverrideText(
  text: string,
  isValid: (value: unknown) => value is number,
): number | null | typeof INVALID_OVERRIDE {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return null
  }
  //+_+// Number 는 빈 문자열을 0 으로 만든다. 위에서 이미 걸렀으므로 여기 도달하지 않는다
  const parsed = Number(trimmed)
  return isValid(parsed) ? parsed : INVALID_OVERRIDE
}

//+_+// 값이 규칙에 맞지 않으면 null 이다. 판정 권위는 워커이고 여기는 보내기 전 거름망이다
//+_+// P5-D26 의 하한을 워커와 같은 함수로 본다. 규칙을 화면에 복제하지 않는다
//+_+// TASK-P12-04 (S2). captureTimeoutOverrideMs 도 같은 방식(거부, 클램프 아님)으로 거른다
export function parseTileSettings(draft: TileSettingsDraft): TileSettings | null {
  const refreshIntervalOverrideMs = parseOverrideText(
    draft.refreshIntervalOverrideMs,
    isValidIntervalOverride,
  )
  if (refreshIntervalOverrideMs === INVALID_OVERRIDE) {
    return null
  }
  const captureTimeoutOverrideMs = parseOverrideText(
    draft.captureTimeoutOverrideMs,
    isValidCaptureTimeoutOverride,
  )
  if (captureTimeoutOverrideMs === INVALID_OVERRIDE) {
    return null
  }
  const scrollCaptureIntervalOverrideMs = parseOverrideText(
    draft.scrollCaptureIntervalOverrideMs,
    isValidScrollCaptureIntervalOverride,
  )
  if (scrollCaptureIntervalOverrideMs === INVALID_OVERRIDE) {
    return null
  }
  return {
    customTitle: draft.customTitle.trim(),
    fitMode: draft.fitMode,
    matchMode: draft.matchMode,
    refreshIntervalOverrideMs,
    captureTimeoutOverrideMs,
    scrollCaptureIntervalOverrideMs,
  }
}

//+_+// TASK-P12-04 (S2). parseTileSettings 가 null 을 낼 때 어느 입력이 문제인지 화면이 알아야
//+_+// 정확한 안내 문구를 고른다. NOTICE_INTERVAL_INVALID 하나로 여러 필드를 덮으면 엉뚱한 필드를
//+_+// 가리키는 문구가 뜬다. parseOverrideText 를 그대로 재사용해 판정을 두 곳에 두지 않는다
export function tileSettingsDraftError(
  draft: TileSettingsDraft,
): 'interval' | 'captureTimeout' | 'scrollCaptureInterval' | null {
  if (parseOverrideText(draft.refreshIntervalOverrideMs, isValidIntervalOverride) === INVALID_OVERRIDE) {
    return 'interval'
  }
  if (
    parseOverrideText(draft.captureTimeoutOverrideMs, isValidCaptureTimeoutOverride) ===
    INVALID_OVERRIDE
  ) {
    return 'captureTimeout'
  }
  //+_+// TASK-P12-06 (S4)
  if (
    parseOverrideText(draft.scrollCaptureIntervalOverrideMs, isValidScrollCaptureIntervalOverride) ===
    INVALID_OVERRIDE
  ) {
    return 'scrollCaptureInterval'
  }
  return null
}

//+_+// CSS Grid 는 1-based 이고 순서는 row-start / column-start / row-end / column-end 다
//+_+// x 는 열이고 y 는 행이다. 두 축을 바꾸면 3x2 와 2x3 이 뒤집힌다
//+_+// WebTile 과 빈 칸이 같은 계산을 쓴다. 좌표 식을 두 곳에 두지 않는다
export function gridArea(rect: GridRect): string {
  const rowStart = rect.y + 1
  const columnStart = rect.x + 1
  return `${String(rowStart)} / ${String(columnStart)} / ${String(rowStart + rect.h)} / ${String(columnStart + rect.w)}`
}

//+_+// P3-D1. base64 문자열을 data URL 로 만든다. Blob URL 이 아니므로 revoke 대상이 없다
//+_+// 타일당 최신 1장만 들고 있으므로 이전 문자열은 참조가 끊겨 그대로 버려진다
export function previewDataUrl(frame: TileFrame | undefined): string | null {
  if (frame === undefined || frame.imageBase64.length === 0) {
    return null
  }
  return `data:image/${frame.format};base64,${frame.imageBase64}`
}

//+_+// 로케일 표기에 의존하지 않도록 직접 조립한다. 로컬 시각 기준이다
export function formatCaptureTime(at: number | undefined): string {
  if (at === undefined) {
    return '-'
  }
  const time = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
}

//+_+// 색은 theme.css 의 token 에만 있다. 여기서는 클래스 이름만 만든다. v1 section 7 line 532
export function statusClassName(status: TileStatus): string {
  return `tile-badge tile-badge--${status.toLowerCase()}`
}

//+_+// P6-D2 (b). 바인딩이 없으면 탭 번호 자리를 비운다. 0 이나 -1 을 지어내지 않는다
export function tabLabel(tabId: number | null): string {
  return tabId === null ? 'tab -' : `tab ${String(tabId)}`
}

//+_+// P6-D2 (b). v1 section 9.4 의 세 버튼이다. 붙을 탭이 없는 타일에서만 낸다
export function showsRecoveryActions(status: TileStatus): boolean {
  return status === 'DETACHED'
}

//+_+// P6-D2 (b). 빈 조각을 걸러 이어 붙인다. 클래스 조립 규칙을 컴포넌트에 두지 않는다
//+_+// P9-D22. selected 매개변수를 없앴다. 유일한 호출부(TileCard.tsx)가 항상 false 로 불렀다
export function tileClassName(editing: boolean, dragClassName: string): string {
  return ['tile', editing ? 'tile--editing' : '', dragClassName].filter((part) => part.length > 0).join(' ')
}

//+_+// 프로젝트의 타일 목록이 기준이다. 워커가 보낸 런타임 상태와 프레임을 여기에 맞춘다
export function buildTileViews(
  project: Project,
  runtimeStates: readonly TileRuntimeState[],
  frames: readonly TileFrame[],
): TileViewModel[] {
  const stateById = new Map(runtimeStates.map((state) => [state.tileId, state]))
  const frameById = new Map(frames.map((frame) => [frame.tileId, frame]))

  return project.tiles.map((tile) => {
    const state = stateById.get(tile.id)
    //+_+// 워커가 아직 상태를 만들지 않은 타일이다. 없는 것을 LIVE 로 보이게 하지 않는다
    const status = state?.status ?? 'LOADING'
    return {
      tileId: tile.id,
      title: tile.customTitle ?? state?.title ?? tile.launchUrl,
      favIconUrl: state?.favIconUrl ?? null,
      tabId: state?.tabId ?? null,
      gridArea: gridArea(tile),
      status,
      statusClassName: statusClassName(status),
      previewDataUrl: previewDataUrl(frameById.get(tile.id)),
      lastCaptureLabel: formatCaptureTime(state?.lastCaptureAt),
      tabLabel: tabLabel(state?.tabId ?? null),
      showsRecoveryActions: showsRecoveryActions(status),
      fitMode: tile.fitMode,
    }
  })
}
