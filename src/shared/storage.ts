import type { Project, TileFitMode, TileMatchMode, WebTile } from './types'

//+_+// P5-D17. 1 -> 2 마이그레이션을 만들지 않는다. 제품이 키를 쓴 적이 없어 폐기 비용이 0 이다
export const SCHEMA_VERSION = 2

export const STORAGE_KEY = 'webdeck.state'

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
  return {
    id: project.id,
    name: project.name,
    gridColumns: project.gridColumns,
    gridRows: project.gridRows,
    keepManagedTabsAlive: project.keepManagedTabsAlive,
    tiles: project.tiles.map(pickTile),
  }
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
  if (refreshIntervalOverrideMs !== undefined && typeof refreshIntervalOverrideMs !== 'number') {
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
  const { id, name, gridColumns, gridRows, keepManagedTabsAlive, tiles } = value

  if (typeof id !== 'string' || typeof name !== 'string') {
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

  return { id, name, gridColumns, gridRows, keepManagedTabsAlive, tiles: picked }
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

//+_+// 키가 없는 것은 오류가 아니다. 저장된 적이 없는 상태를 빈 목록으로 본다
//+_+// P5-D8. 부재와 빈 목록을 구별하는 수단을 만들지 않는다. 부르는 쪽이 기본 프로젝트를 세운다
export async function loadState(backend: KeyValueBackend): Promise<LoadResult> {
  const stored = await backend.get(STORAGE_KEY)
  if (stored === undefined || stored === null) {
    return { ok: true, activeProjectId: '', projects: [] }
  }
  return deserializeState(stored)
}
