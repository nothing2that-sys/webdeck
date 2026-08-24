import { isValidIntervalOverride } from './scheduler'
import type { Project, TileFitMode, TileMatchMode, WebTile } from './types'

//+_+// P5-D17. 1 -> 2 마이그레이션을 만들지 않는다. 제품이 키를 쓴 적이 없어 폐기 비용이 0 이다
export const SCHEMA_VERSION = 2

export const STORAGE_KEY = 'webdeck.state'

//+_+// D6c. Pause 는 별도 키다. schemaVersion 과 deserializeState 경로를 지나지 않는다
//+_+// 계측 키 두 개가 이미 같은 형태다. 상태 봉투를 건드리지 않으려고 그 형태를 따른다
export const PAUSE_KEY = 'webdeck.previewPaused'

//+_+// P7-D88. 거부된 저장값을 여기로 옮긴다. J84 가 막으려던 소실을 메운다
export const REJECTED_KEY = 'webdeck.state.rejected'

//+_+// P5-D19. 1키 전체 상태다. 활성 프로젝트도 같은 봉투에 싣고 별도 키를 만들지 않는다
export interface PersistedState {
  schemaVersion: typeof SCHEMA_VERSION
  activeProjectId: string
  projects: Project[]
}

//+_+// chrome.storage 를 직접 호출하지 않는다. Chrome 어댑터는 Phase 3 에서 붙인다
export interface KeyValueBackend {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export type LoadResult =
  | { ok: true; activeProjectId: string; projects: Project[] }
  | { ok: false; errorCode: string; message: string }

const MATCH_MODES: readonly TileMatchMode[] = ['exact', 'origin', 'prefix']

const FIT_MODES: readonly TileFitMode[] = ['contain', 'cover']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

//+_+// 허용 필드만 골라 새 객체를 만든다. 입력에서 delete 하면 입력을 변형한다
function pickTile(tile: WebTile): WebTile {
  const picked: WebTile = {
    id: tile.id,
    launchUrl: tile.launchUrl,
    matchMode: tile.matchMode,
    x: tile.x,
    y: tile.y,
    w: tile.w,
    h: tile.h,
    refreshIntervalMs: tile.refreshIntervalMs,
    fitMode: tile.fitMode,
    keepAlive: tile.keepAlive,
  }
  if (tile.customTitle !== undefined) {
    picked.customTitle = tile.customTitle
  }
  if (tile.refreshIntervalOverrideMs !== undefined) {
    picked.refreshIntervalOverrideMs = tile.refreshIntervalOverrideMs
  }
  return picked
}

export function serializeProject(project: Project): Project {
  const picked: Project = {
    id: project.id,
    name: project.name,
    gridColumns: project.gridColumns,
    gridRows: project.gridRows,
    keepManagedTabsAlive: project.keepManagedTabsAlive,
    tiles: project.tiles.map(pickTile),
  }
  //+_+// P8-D13. trim 은 저장 여부 판정에만 쓴다. 싣는 값은 원문이며 앞뒤 여백을 지우지 않는다
  if (project.description !== undefined && project.description.trim() !== '') {
    picked.description = project.description
  }
  return picked
}

function deserializeTile(value: unknown): WebTile | null {
  if (!isRecord(value)) {
    return null
  }
  const {
    id,
    customTitle,
    launchUrl,
    matchMode,
    x,
    y,
    w,
    h,
    refreshIntervalMs,
    refreshIntervalOverrideMs,
    fitMode,
    keepAlive,
  } = value

  if (typeof id !== 'string' || typeof launchUrl !== 'string') {
    return null
  }
  if (!MATCH_MODES.includes(matchMode as TileMatchMode)) {
    return null
  }
  if (!FIT_MODES.includes(fitMode as TileFitMode)) {
    return null
  }
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number' ||
    typeof refreshIntervalMs !== 'number'
  ) {
    return null
  }
  if (typeof keepAlive !== 'boolean') {
    return null
  }
  if (customTitle !== undefined && typeof customTitle !== 'string') {
    return null
  }
  //+_+// P5-D26. 하한은 구동자 격자다. 상한은 두지 않는다. 긴 주기는 표현할 수 있다
  //+_+// 기존 refreshIntervalMs 의 검증 규칙은 바꾸지 않는다. 하한은 사용자 지정값에만 건다
  if (refreshIntervalOverrideMs !== undefined && !isValidIntervalOverride(refreshIntervalOverrideMs)) {
    return null
  }

  const tile: WebTile = {
    id,
    launchUrl,
    matchMode: matchMode as TileMatchMode,
    x,
    y,
    w,
    h,
    refreshIntervalMs,
    fitMode: fitMode as TileFitMode,
    keepAlive,
  }
  if (customTitle !== undefined) {
    tile.customTitle = customTitle
  }
  if (refreshIntervalOverrideMs !== undefined) {
    tile.refreshIntervalOverrideMs = refreshIntervalOverrideMs
  }
  return tile
}

export function deserializeProject(value: unknown): Project | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, name, description, gridColumns, gridRows, keepManagedTabsAlive, tiles } = value

  if (typeof id !== 'string' || typeof name !== 'string') {
    return null
  }
  //+_+// P8-D14. customTitle 과 같은 쪽에 선다. 타입이 틀리면 봉투를 거부한다
  if (description !== undefined && typeof description !== 'string') {
    return null
  }
  if (gridColumns !== 4 || gridRows !== 4) {
    return null
  }
  if (typeof keepManagedTabsAlive !== 'boolean') {
    return null
  }
  if (!Array.isArray(tiles)) {
    return null
  }

  const picked: WebTile[] = []
  for (const entry of tiles) {
    const tile = deserializeTile(entry)
    if (tile === null) {
      return null
    }
    picked.push(tile)
  }

  const project: Project = { id, name, gridColumns, gridRows, keepManagedTabsAlive, tiles: picked }
  if (description !== undefined) {
    project.description = description
  }
  return project
}

export function serializeState(projects: Project[], activeProjectId: string): PersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProjectId,
    projects: projects.map(serializeProject),
  }
}

//+_+// schemaVersion 불일치는 거부한다. 조용히 마이그레이션하지 않는다
export function deserializeState(value: unknown): LoadResult {
  if (!isRecord(value)) {
    return { ok: false, errorCode: 'INVALID_STATE_SHAPE', message: 'Stored state is not an object' }
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      errorCode: 'SCHEMA_VERSION_MISMATCH',
      message: `Expected schemaVersion ${SCHEMA_VERSION}, found ${String(value.schemaVersion)}`,
    }
  }
  if (typeof value.activeProjectId !== 'string') {
    return {
      ok: false,
      errorCode: 'INVALID_STATE_SHAPE',
      message: 'activeProjectId is not a string',
    }
  }
  if (!Array.isArray(value.projects)) {
    return { ok: false, errorCode: 'INVALID_STATE_SHAPE', message: 'projects is not an array' }
  }

  const projects: Project[] = []
  for (const entry of value.projects) {
    const project = deserializeProject(entry)
    if (project === null) {
      return { ok: false, errorCode: 'INVALID_PROJECT', message: 'A stored project was rejected' }
    }
    projects.push(project)
  }

  return { ok: true, activeProjectId: value.activeProjectId, projects }
}

export async function saveState(
  backend: KeyValueBackend,
  projects: Project[],
  activeProjectId: string,
): Promise<void> {
  await backend.set(STORAGE_KEY, serializeState(projects, activeProjectId))
}

//+_+// A-e5. 워커가 죽었다 살아나도 수동 Pause 가 유지되려면 이 값이 저장에 남아야 한다
//+_+// boolean 이 아닌 값은 Pause 아님으로 읽는다. 손상된 값 때문에 캡처가 영영 멈추면 안 된다
export function readPreviewPaused(stored: unknown): boolean {
  return stored === true
}

export async function loadPreviewPaused(backend: KeyValueBackend): Promise<boolean> {
  return readPreviewPaused(await backend.get(PAUSE_KEY))
}

export async function savePreviewPaused(
  backend: KeyValueBackend,
  paused: boolean,
): Promise<void> {
  await backend.set(PAUSE_KEY, paused)
}

//+_+// P7-D88. 거부된 원본을 백업 키로 옮긴다. 이미 값이 있으면 그대로 둔다
//+_+// 첫 거부의 원본이 진짜 사용자 데이터이고 그 뒤의 값은 우리가 쓴 것일 수 있다
//+_+// 백엔드 실패를 삼키지 않는다. 이 모듈의 기존 계약이 그렇고 loadState 와 saveState 가 같다
async function backupRejected(backend: KeyValueBackend, stored: unknown): Promise<void> {
  //+_+// 부재 판정은 loadState 와 같은 규칙이다. 두 곳에서 다르게 읽지 않는다
  const existing = await backend.get(REJECTED_KEY)
  if (existing !== undefined && existing !== null) {
    return
  }
  await backend.set(REJECTED_KEY, stored)
}

//+_+// 키가 없는 것은 오류가 아니다. 저장된 적이 없는 상태를 빈 목록으로 본다
//+_+// P5-D8. 부재와 빈 목록을 구별하는 수단을 만들지 않는다. 부르는 쪽이 기본 프로젝트를 세운다
export async function loadState(backend: KeyValueBackend): Promise<LoadResult> {
  const stored = await backend.get(STORAGE_KEY)
  if (stored === undefined || stored === null) {
    return { ok: true, activeProjectId: '', projects: [] }
  }
  const result = deserializeState(stored)
  //+_+// P7-D88. 거부일 때만이다. 반환값과 씨앗 폴백은 그대로 둔다
  if (!result.ok) {
    await backupRejected(backend, stored)
  }
  return result
}
