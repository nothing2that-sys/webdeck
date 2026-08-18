import { findFirstAvailablePosition, isPlacementValid } from '../shared/grid'
import type { GridRect } from '../shared/grid'
import { assertNever } from '../shared/messages'
import type {
  AddTileSource,
  DashboardFailure,
  DashboardRequest,
  DashboardRequestType,
  DashboardResponse,
  TileFrame,
  TileSettings,
} from '../shared/messages'
import {
  MIN_TILE_INTERVAL_MS,
  defaultRefreshIntervalMs,
  isValidIntervalOverride,
  tileIntervalMs,
} from '../shared/scheduler'
import { loadPreviewPaused, loadState, savePreviewPaused, saveState } from '../shared/storage'
import type { KeyValueBackend, LoadResult } from '../shared/storage'
import type { BrowserTabInfo, Project, TileRuntimeState, WebTile } from '../shared/types'
import { DebuggerSessionManager, errorMessage } from './debuggerSessionManager'
import type { DebuggerBackend } from './debuggerSessionManager'
import { createRoundLogStore, recordWorkerStart } from './diagnostics'
import { PreviewCaptureManager, systemClock } from './previewCaptureManager'
import type { Clock, PreviewCaptureManagerOptions } from './previewCaptureManager'
import {
  DEV_TILE_SPAN,
  EMPTY_CAPTURE_SUMMARY,
  applyCaptureRecord,
  buildRuntimeState,
  createProject,
  formatReconnectVerdict,
  newTile,
  planReconnect,
  resolveProjects,
  resolveRuntimeStatus,
} from './projectState'
import type { TileCaptureSummary } from './projectState'
import { frameFingerprint, logCaptureRound } from './roundLog'
import type { CaptureRoundLog } from './roundLog'
import { TabManager } from './tabManager'
import type { TabsBackend } from './tabManager'

//+_+// v1 section 12 가 요구하는 프로토콜 버전이다. POC 도 같은 값을 썼다
export const DEBUGGER_PROTOCOL_VERSION = '1.3'

//+_+// 구동자의 해상도다. 스케줄 정책 상수가 아니라 tick 간격이다
//+_+// P4-D16 (N1-c). 1000 에서 250 으로 내렸다. 실현 주기가 tick 격자로 올림되기 때문이다
//+_+// 1000 에서는 spanLarge 2000 과 spanMedium 2500 의 500 차이가 같은 격자에 접혀 사라졌다
//+_+// 250 은 2000 / 2500 / 4000 / 45000 을 모두 나누므로 그 네 주기에서 올림 오차가 0 이다
//+_+// 워커 부하 영향은 L34 가 미상이므로 여기서 판단하지 않는다. Chrome 실측 항목이다
export const DRIVER_TICK_MS = 250

export interface PreviewEngine {
  sessions: DebuggerSessionManager
  captures: PreviewCaptureManager
  tabs: TabManager
  registerTile(tile: WebTile, tabId: number): void
}

//+_+// 스케줄 결정은 previewCaptureManager 의 selectDueTiles 가 한다. 여기는 구동자와 배선만이다
export function createPreviewEngine(
  debuggerBackend: DebuggerBackend,
  tabsBackend: TabsBackend,
  clock: Clock = systemClock,
  options: PreviewCaptureManagerOptions = {},
): PreviewEngine {
  const sessions = new DebuggerSessionManager(debuggerBackend)
  const captures = new PreviewCaptureManager(debuggerBackend, sessions, clock, options)
  const tabs = new TabManager(tabsBackend)

  //+_+// 탭이 닫히면 그 탭의 타일 캡처를 멈추고 리스를 놓는다
  tabs.onTabRemoved((tabId) => {
    void captures.releaseTab(tabId)
  })

  return {
    sessions,
    captures,
    tabs,
    //+_+// P6-D52. 표시 상태는 더 이상 주기를 고르지 않는다. hidden 은 주기가 아니라 Pause 다
    //+_+// 그래서 등록은 타일이 정한 주기 하나만 본다. 전환이 만기를 흔들지 않는다
    registerTile: (tile, tabId) => {
      captures.register(tile.id, tabId, tileIntervalMs(tile))
    },
  }
}

//+_+// 구동자다. 스케줄 결정 로직과 분리해 둔다. WEBDECK_PLAN section 3.6 이 보류로 둔 선택지 때문이다
export function startPreviewDriver(engine: PreviewEngine, intervalMs = DRIVER_TICK_MS): () => void {
  const handle: ReturnType<typeof setInterval> = setInterval(() => {
    engine.captures.tick()
  }, intervalMs)
  return () => {
    clearInterval(handle)
  }
}

export interface DashboardHost {
  engine: PreviewEngine
  handle(request: DashboardRequest): Promise<DashboardResponse>
  //+_+// S1. 워커 기동 시 1회다. 실패해도 던지지 않고 결과를 그대로 돌려준다
  load(): Promise<LoadResult>
}

//+_+// P5-D12. 창 인자를 받지 않는다. v1 section 9.1 은 "현재 Chrome 에 열린 탭 목록" 이다
export type ListTabs = () => Promise<BrowserTabInfo[]>

//+_+// TabsBackend 에 넣지 않는다. harness/p3 가 그 인터페이스를 구현하고 Phase 3 산출물은 동결이다
//+_+// ListTabs 와 같은 자리다. 캡처 엔진이 쓰지 않는 chrome 호출은 어댑터로 따로 주입한다
export type FocusTab = (tabId: number, windowId: number) => Promise<void>

//+_+// P5-D27 의 url 경로다. v1 section 20 이 UI 의 chrome 직접 호출을 금지하므로 워커가 만든다
export type CreateTab = (url: string) => Promise<BrowserTabInfo>

function failure(
  type: DashboardRequestType,
  errorCode: string,
  message: string,
): DashboardFailure {
  return { ok: false, type, errorCode, message }
}

//+_+// Dashboard 요청 처리기다. chrome 전역을 직접 부르지 않으므로 주입한 backend 로 시험할 수 있다
//+_+// 엔진을 여기서 만든다. 정산 훅이 엔진 생성 시점에 필요하고 요약을 이 안에서 접기 때문이다
export function createDashboardHost(
  debuggerBackend: DebuggerBackend,
  tabsBackend: TabsBackend,
  listTabs: ListTabs,
  focusTab: FocusTab,
  createTab: CreateTab,
  storage: KeyValueBackend,
  clock: Clock = systemClock,
  //+_+// P6-D18. 계측 전용 자리다. null 이면 링버퍼를 쓰지 않는다
  //+_+// storage 와 같은 인자를 쓰지 않는 이유는 계측 쓰기와 상태 저장 쓰기를 갈라 세기 위해서다
  diagnostics: KeyValueBackend | null = null,
): DashboardHost {
  //+_+// P5-D8. 저장값을 읽기 전에도 활성 프로젝트가 하나 있다. load 가 있으면 그것으로 갈아 끼운다
  const seeded = resolveProjects([], '')
  let projects = seeded.projects
  let activeProjectId = seeded.activeProjectId
  const bindings = new Map<string, number>()
  const summaries = new Map<string, TileCaptureSummary>()

  //+_+// resolveProjects 가 활성 없음 상태를 만들지 않는다. 도달하면 배선이 깨진 것이다
  function activeProject(): Project {
    const found = projects.find((item) => item.id === activeProjectId)
    if (found === undefined) {
      throw new Error(`active project ${activeProjectId} is missing`)
    }
    return found
  }

  //+_+// P6-D49. 폴링이 알려 주기 전에는 보이지 않는 것으로 둔다. 그 구간이 곧 Pause 다
  //+_+// 전에는 true 였다. Dashboard 가 한 번도 열리지 않은 기동에서 전속 캡처가 돌았다
  let dashboardVisible = false
  //+_+// D6c. 사용자가 누른 Pause 다. 표시 상태와 독립이며 저장에서 읽어 온다
  let manualPaused = false

  const rounds = diagnostics === null ? null : createRoundLogStore(diagnostics)

  const engine = createPreviewEngine(debuggerBackend, tabsBackend, clock, {
    onCaptureSettled: (record, frame) => {
      summaries.set(
        record.tileId,
        applyCaptureRecord(summaries.get(record.tileId) ?? EMPTY_CAPTURE_SUMMARY, record),
      )

      //+_+// F4. 계측 로그다. 정산이 끝난 뒤에 읽기만 한다. 캡처 경로의 판단에 참여하지 않는다
      //+_+// N2. 해시는 여기서 만든다. write 가 roundDurationMs 와 callDurationMs 를 이미 계산한 뒤이고
      //+_+// settle 이 nextDueAt 도 이미 정한 뒤다. 그래서 해시 비용이 측정값과 다음 만기에 섞이지 않는다
      //+_+// 로그가 던져도 정산이 달라지지 않아야 한다. 그래서 여기서 삼킨다
      try {
        const tile = activeProject().tiles.find((item) => item.id === record.tileId) ?? null
        const entry: CaptureRoundLog = {
          at: record.startedAt + record.roundDurationMs,
          tileId: record.tileId,
          w: tile?.w ?? null,
          h: tile?.h ?? null,
          intervalMs: tile === null ? null : tileIntervalMs(tile),
          roundDurationMs: record.roundDurationMs,
          callDurationMs: record.callDurationMs,
          outcome: record.outcome,
          bytes: record.bytes,
          frameHash: frame === null ? null : frameFingerprint(frame.imageBase64),
          //+_+// P6-D17. 이 회차 시점의 값이다. 정산이 끝난 뒤에 읽으므로 슬롯은 이미 반납됐다
          registeredTiles: engine.captures.registeredTileCount,
          attachedTabs: engine.sessions.attachedCount,
          //+_+// P6-D51. 이 회차의 만기를 정할 때 실제로 더해진 주기다. 회차가 시작될 때 읽힌 값이다
          scheduleIntervalMs: record.scheduleIntervalMs,
        }
        logCaptureRound(entry)
        //+_+// S3. 콘솔과 같은 정보를 저장에도 남긴다. append 는 거부하지 않는다
        void rounds?.append(entry)
      } catch {
        //+_+// 계측이 제품 동작을 바꾸지 않는다는 것이 F4 의 조건이다
      }
    },
  })

  //+_+// P6-D49. 초기값이 hidden 이므로 엔진도 처음부터 Pause 다. load 를 기다리지 않는다
  //+_+// 여기서 걸지 않으면 첫 폴링 전까지 억제가 없어 D6b 의 요지가 load 호출에 매달린다
  applyPause()

  //+_+// F2. 재등록은 TileState 를 새로 만들어 fault 와 신선도 기준을 초기화한다
  //+_+// 탭이 사라진 타일을 다시 등록하면 DETACHED 가 LIVE 로 뒤집히고 죽은 탭에 다시 attach 한다
  //+_+// 탭 존재 여부의 권위는 워커의 tabs 층이다. 등록 전에 그 층에 물어본다
  async function reregister(tile: WebTile): Promise<void> {
    const tabId = bindings.get(tile.id)
    if (tabId === undefined) {
      return
    }
    if (!(await engine.tabs.exists(tabId))) {
      return
    }
    engine.registerTile(tile, tabId)
  }

  //+_+// D6a · D6b. hidden 은 Pause 다. 수동 Pause 와 OR 로 묶어 한 자리에서 엔진에 전한다
  //+_+// 억제만 한다. unregister 하지 않으므로 리스가 유지되고 타일이 DETACHED 로 바뀌지 않는다
  function applyPause(): void {
    engine.captures.setPaused(manualPaused || !dashboardVisible)
  }

  //+_+// P6-D52. 전환은 재등록하지 않는다. 재등록할 이유였던 hidden 주기가 사라졌다
  //+_+// 전에는 전환 1회가 활성 전 타일의 만기를 now 로 되돌려 타일 수만큼 회차를 즉시 만들었다
  function applyDashboardVisible(next: boolean): void {
    if (next === dashboardVisible) {
      return
    }
    dashboardVisible = next
    applyPause()
  }

  //+_+// P6-D47. v1 section 15.1 의 전체 Pause 다. D6c 로 별도 키에 남겨 워커 재기동을 넘긴다
  async function setPreviewPaused(paused: boolean): Promise<DashboardResponse> {
    manualPaused = paused
    applyPause()
    await savePreviewPaused(storage, paused)
    return { ok: true, type: 'SET_PREVIEW_PAUSED', paused }
  }

  async function persist(): Promise<void> {
    await saveState(storage, projects, activeProjectId)
  }

  //+_+// 활성이 아닌 프로젝트의 타일은 캡처하지 않는다. 활성이 실제로 바뀐 회차에만 등록을 갈아 끼운다
  //+_+// 이름 변경과 다른 프로젝트 삭제는 활성 객체를 그대로 두므로 만기가 흔들리지 않는다
  async function applyProjects(nextProjects: Project[], nextActiveId: string): Promise<void> {
    const resolved = resolveProjects(nextProjects, nextActiveId)
    const previous = projects.find((item) => item.id === activeProjectId) ?? null
    const next = resolved.projects.find((item) => item.id === resolved.activeProjectId) ?? null

    projects = resolved.projects
    activeProjectId = resolved.activeProjectId
    if (previous === next) {
      return
    }
    if (previous !== null) {
      for (const tile of previous.tiles) {
        await engine.captures.unregister(tile.id)
      }
    }
    if (next !== null) {
      for (const tile of next.tiles) {
        await reregister(tile)
      }
    }
  }

  async function projectState(): Promise<DashboardResponse> {
    const project = activeProject()
    const runtimeStates: TileRuntimeState[] = []
    const frames: TileFrame[] = []

    for (const tile of project.tiles) {
      const tabId = bindings.get(tile.id)
      const tab = tabId === undefined ? null : await engine.tabs.info(tabId)
      const summary = summaries.get(tile.id) ?? EMPTY_CAPTURE_SUMMARY
      const status = resolveRuntimeStatus(
        engine.captures.statusOf(tile.id),
        tabId,
        tab,
        summary.lastCaptureAt !== undefined,
      )
      runtimeStates.push(buildRuntimeState(tile.id, tabId, tab, status, summary))

      //+_+// 타일당 최신 1장만 싣는다. 이력을 만들지 않는다. v1 section 6.2 는 저장도 금지한다
      const frame = engine.captures.latestFrame(tile.id)
      if (frame !== null) {
        frames.push({
          tileId: tile.id,
          imageBase64: frame.imageBase64,
          format: frame.format,
          bytes: frame.bytes,
        })
      }
    }

    return {
      ok: true,
      type: 'GET_PROJECT_STATE',
      project,
      runtimeStates,
      frames,
      previewPaused: manualPaused,
    }
  }

  //+_+// P4-D12. 화면이 이미 판정했더라도 워커가 다시 판정한다. 같은 isPlacementValid 를 쓴다
  //+_+// P5-D14. Drop 성공 1회에 저장한다. Edit Layout 종료를 기다리지 않는다
  //+_+// 거부된 요청은 아무것도 쓰지 않으므로 저장에도 도달하지 않는다
  async function setTileRect(tileId: string, rect: GridRect): Promise<DashboardResponse> {
    const project = activeProject()
    const tile = project.tiles.find((item) => item.id === tileId)
    if (tile === undefined) {
      return failure('SET_TILE_RECT', 'TILE_NOT_FOUND', `Unknown tileId ${tileId}`)
    }
    if (!isPlacementValid(rect, project.tiles, tileId)) {
      return failure(
        'SET_TILE_RECT',
        'INVALID_LAYOUT',
        `Rect overlaps another tile or leaves the ${String(project.gridColumns)}x${String(project.gridRows)} grid`,
      )
    }

    //+_+// span 이 바뀌면 v1 section 6 의 주기 구간도 바뀐다. P4-D4 는 값을 그대로 두라고 했을 뿐이다
    const resized = rect.w !== tile.w || rect.h !== tile.h
    const before = tileIntervalMs(tile)
    tile.x = rect.x
    tile.y = rect.y
    tile.w = rect.w
    tile.h = rect.h
    if (resized) {
      tile.refreshIntervalMs = defaultRefreshIntervalMs(rect.w, rect.h)
    }

    //+_+// J102. 판정 기준은 실효 주기다. J96 과 같다. override 가 있으면 span 이 바뀌어도 그대로다
    if (tileIntervalMs(tile) !== before) {
      await reregister(tile)
    }
    await persist()
    return { ok: true, type: 'SET_TILE_RECT' }
  }

  //+_+// P5-D31. 4필드 전체 교체다. 미지정은 필드를 지운다. undefined 를 써 넣지 않는다
  //+_+// 주기가 바뀐 회차에만 재등록한다. J27 의 Resize 배선과 같은 성질이다
  //+_+// matchMode / customTitle / fitMode 는 캡처 주기를 건드리지 않으므로 만기를 흔들지 않는다
  async function setTileSettings(
    tileId: string,
    settings: TileSettings,
  ): Promise<DashboardResponse> {
    const tile = activeProject().tiles.find((item) => item.id === tileId)
    if (tile === undefined) {
      return failure('SET_TILE_SETTINGS', 'TILE_NOT_FOUND', `Unknown tileId ${tileId}`)
    }
    //+_+// P4-D12 선례다. 화면이 이미 판정했더라도 워커가 다시 판정한다
    const override = settings.refreshIntervalOverrideMs
    if (override !== null && !isValidIntervalOverride(override)) {
      return failure(
        'SET_TILE_SETTINGS',
        'INVALID_INTERVAL',
        `Interval override must be an integer of at least ${String(MIN_TILE_INTERVAL_MS)} ms`,
      )
    }

    const before = tileIntervalMs(tile)
    if (settings.customTitle.length === 0) {
      delete tile.customTitle
    } else {
      tile.customTitle = settings.customTitle
    }
    tile.fitMode = settings.fitMode
    tile.matchMode = settings.matchMode
    if (override === null) {
      delete tile.refreshIntervalOverrideMs
    } else {
      tile.refreshIntervalOverrideMs = override
    }

    if (tileIntervalMs(tile) !== before) {
      await reregister(tile)
    }
    await persist()
    return { ok: true, type: 'SET_TILE_SETTINGS' }
  }

  //+_+// TASK-P4-01 S3. Focus 는 워커 경유다. v1 section 20 이 UI 의 chrome 직접 호출을 금지한다
  //+_+// 바인딩이 없으면 활성화할 탭이 없다. 창은 탭 정보에서 읽는다. 화면이 보낸 값을 믿지 않는다
  async function focusTile(tileId: string): Promise<DashboardResponse> {
    const tabId = bindings.get(tileId)
    if (tabId === undefined) {
      return failure('FOCUS_TILE', 'TILE_NOT_BOUND', `Tile ${tileId} is not bound to a tab`)
    }
    const tab = await engine.tabs.info(tabId)
    if (tab === null) {
      return failure('FOCUS_TILE', 'TAB_NOT_FOUND', `No tab with id ${String(tabId)}`)
    }
    await focusTab(tabId, tab.windowId)
    return { ok: true, type: 'FOCUS_TILE' }
  }

  //+_+// P4-D2. 모르는 tileId 면 첫 빈 자리에 1x1 타일을 만든다. 아는 tileId 면 탭만 다시 건다
  //+_+// 새 메시지 이름을 만들지 않기 위해 v1 section 19 의 BIND_TILE 하나로 둘을 처리한다
  async function bindTile(tileId: string, tabId: number): Promise<DashboardResponse> {
    const project = activeProject()
    const tab = await engine.tabs.info(tabId)
    if (tab === null) {
      return failure('BIND_TILE', 'TAB_NOT_FOUND', `No tab with id ${String(tabId)}`)
    }

    const existing = project.tiles.find((tile) => tile.id === tileId)
    const tile = existing ?? newTile(tileId, tab.currentUrl, project.tiles)
    if (tile === null) {
      return failure('BIND_TILE', 'GRID_FULL', 'The 4x4 grid has no empty slot left')
    }

    //+_+// 다른 탭에 걸려 있던 타일이면 먼저 내린다. 그러지 않으면 이전 탭의 리스가 남는다
    if (bindings.get(tileId) !== undefined && bindings.get(tileId) !== tabId) {
      await engine.captures.unregister(tileId)
    }
    if (existing === undefined) {
      project.tiles.push(tile)
    }
    bindings.set(tileId, tabId)
    summaries.delete(tileId)

    engine.registerTile(tile, tabId)
    //+_+// P5-D29. ADD_TILE 과 같다. 타일이 늘거나 바뀌었으면 저장한다
    await persist()
    return { ok: true, type: 'BIND_TILE' }
  }

  //+_+// P5-D27. v1 section 9.1 의 두 경로다. 자리를 먼저 확인하고 그 뒤에 탭을 만든다
  //+_+// 순서를 뒤집으면 GRID_FULL 로 실패한 뒤에도 사용자 탭이 남는다
  //+_+// 기존 탭은 reload 하지 않고 창도 옮기지 않는다. Link Only 다. v1 section 9.1, 9.2
  async function addTile(source: AddTileSource): Promise<DashboardResponse> {
    const project = activeProject()
    if (findFirstAvailablePosition(DEV_TILE_SPAN, DEV_TILE_SPAN, project.tiles) === null) {
      return failure('ADD_TILE', 'GRID_FULL', 'The 4x4 grid has no empty slot left')
    }

    //+_+// launchUrl 은 S6 의 URL 기반 재연결 입력이다. tab 경로는 현재 URL, url 경로는 입력값이다
    let tabId: number
    let launchUrl: string
    if (source.kind === 'tab') {
      const tab = await engine.tabs.info(source.tabId)
      if (tab === null) {
        return failure('ADD_TILE', 'TAB_NOT_FOUND', `No tab with id ${String(source.tabId)}`)
      }
      tabId = tab.tabId
      launchUrl = tab.currentUrl
    } else {
      const created = await createTab(source.url)
      tabId = created.tabId
      launchUrl = source.url
    }

    const tileId = crypto.randomUUID()
    const tile = newTile(tileId, launchUrl, project.tiles)
    if (tile === null) {
      return failure('ADD_TILE', 'GRID_FULL', 'The 4x4 grid has no empty slot left')
    }

    project.tiles.push(tile)
    bindings.set(tileId, tabId)
    summaries.delete(tileId)
    engine.registerTile(tile, tabId)
    await persist()
    return { ok: true, type: 'ADD_TILE', tileId }
  }

  //+_+// P5-D35 · P5-D37 이 같은 정의를 쓴다. 두 곳에 규칙을 두지 않는다
  //+_+// 바인딩이 없거나 엔진이 스케줄에서 뺀 타일이 재연결 대상이다
  function liveBoundTabId(tileId: string): number | null {
    const tabId = bindings.get(tileId)
    if (tabId === undefined || !engine.captures.isScheduled(tileId)) {
      return null
    }
    return tabId
  }

  //+_+// 타일을 탭에 건다. bindTile 과 달리 타일 생성도 검증도 하지 않는다. 이미 있는 타일만이다
  function attachTile(tile: WebTile, tabId: number): void {
    bindings.set(tile.id, tabId)
    summaries.delete(tile.id)
    engine.registerTile(tile, tabId)
  }

  //+_+// P6-D53. 비활성 프로젝트는 바인딩만 되돌린다. 등록하면 활성이 아닌 타일을 캡처하게 된다
  function bindOnly(tileId: string, tabId: number): void {
    bindings.set(tileId, tabId)
    summaries.delete(tileId)
  }

  //+_+// P5-D35. v1 section 10 이다. 워커 기동 시 1회이며 전용 메시지를 만들지 않는다
  //+_+// tabId 를 저장하지 않으므로 URL 로 다시 찾는다. 살아 있는 바인딩은 건드리지 않는다
  //+_+// P6-D53. 전 프로젝트를 한 번에 판정한다. 활성만 훑으면 다른 프로젝트 타일이 영영 굳는다
  //+_+// 그 타일은 bindings 가 비어 있어 전환해도 reregister 가 첫 줄에서 되돌아간다
  //+_+// P5-D36 의 한 탭 한 타일은 프로젝트 경계를 넘어 성립해야 하므로 targets 를 통째로 넘긴다
  async function reconnect(): Promise<void> {
    const owners = new Map<string, { tile: WebTile; projectId: string }>()
    for (const project of projects) {
      for (const tile of project.tiles) {
        owners.set(tile.id, { tile, projectId: project.id })
      }
    }
    const targets = [...owners.values()].map(({ tile }) => ({
      tile,
      boundTabId: liveBoundTabId(tile.id),
    }))
    const verdicts = planReconnect(targets, await listTabs())

    let bound = 0
    for (const verdict of verdicts) {
      const owner = owners.get(verdict.tileId)
      if (owner === undefined) {
        continue
      }
      //+_+// C-e2. 붙였든 못 붙였든 한 줄씩 남긴다. 무음이던 것이 결함 추적을 14분 막았다
      console.log(formatReconnectVerdict(verdict, owner.projectId, activeProjectId))
      if (verdict.kind !== 'bind') {
        continue
      }
      //+_+// 비활성 프로젝트는 바인딩만 되돌린다. 전환이 오면 reregister 가 그것을 집어 등록한다
      if (owner.projectId === activeProjectId) {
        attachTile(owner.tile, verdict.tabId)
      } else {
        bindOnly(verdict.tileId, verdict.tabId)
      }
      bound += 1
    }
    if (bound > 0) {
      await persist()
    }
  }

  //+_+// P5-D37. v1 section 10 의 6단계다. 버튼으로만 돈다. 브라우저 시작과 동시에 돌지 않는다
  //+_+// 한 건이 실패해도 앞의 성공을 되돌리지 않는다. 성공한 것만 응답에 싣는다
  async function openMissingTabs(): Promise<DashboardResponse> {
    const openedTileIds: string[] = []
    for (const tile of activeProject().tiles) {
      if (liveBoundTabId(tile.id) !== null || tile.launchUrl.length === 0) {
        continue
      }
      try {
        const created = await createTab(tile.launchUrl)
        await engine.captures.unregister(tile.id)
        attachTile(tile, created.tabId)
        openedTileIds.push(tile.id)
      } catch (error: unknown) {
        console.error('[webdeck] openMissingTabs failed', tile.id, errorMessage(error))
      }
    }
    if (openedTileIds.length > 0) {
      await persist()
    }
    return { ok: true, type: 'OPEN_MISSING_TABS', openedTileIds }
  }

  //+_+// P5-D32. v1 section 9.4 의 Reopen 이다. 자리와 설정과 tileId 를 그대로 두고 탭만 새로 만든다
  //+_+// 새 탭에 걸므로 엔진이 새 TileState 를 만든다. 그것이 fault 를 지우는 명시 경로다
  async function reopenTile(tileId: string): Promise<DashboardResponse> {
    const tile = activeProject().tiles.find((item) => item.id === tileId)
    if (tile === undefined) {
      return failure('REOPEN_TILE', 'TILE_NOT_FOUND', `Unknown tileId ${tileId}`)
    }
    //+_+// S2 이전에 만들어진 저장값은 launchUrl 이 비어 있을 수 있다. 탭을 만들기 전에 막는다
    if (tile.launchUrl.length === 0) {
      return failure('REOPEN_TILE', 'NO_LAUNCH_URL', `Tile ${tileId} has no launch url to reopen`)
    }

    const created = await createTab(tile.launchUrl)
    await engine.captures.unregister(tileId)
    attachTile(tile, created.tabId)
    await persist()
    return { ok: true, type: 'REOPEN_TILE', tabId: created.tabId }
  }

  //+_+// P5-D6. v1 section 14 의 Refresh Preview 다. P4-D8 이 미결로 둔 의미를 이것으로 닫는다
  //+_+// 페이지를 reload 하지 않는다. Reload Page 는 P5-D5 가 Phase 6 에 두었다
  async function captureTile(tileId: string): Promise<DashboardResponse> {
    if (bindings.get(tileId) === undefined) {
      return failure('CAPTURE_TILE', 'TILE_NOT_BOUND', `Tile ${tileId} is not bound to a tab`)
    }
    if (!engine.captures.isScheduled(tileId)) {
      return failure('CAPTURE_TILE', 'TAB_NOT_FOUND', `The tab of tile ${tileId} is gone`)
    }

    const frame = await engine.captures.captureOnce(tileId)
    if (frame === null) {
      return failure('CAPTURE_TILE', 'CAPTURE_FAILED', `The round for tile ${tileId} returned no frame`)
    }
    return {
      ok: true,
      type: 'CAPTURE_TILE',
      imageBase64: frame.imageBase64,
      format: frame.format,
      bytes: frame.bytes,
    }
  }

  //+_+// P5-D33. v1 section 9.4 의 Remove Tile 이다. 사용자의 탭은 닫지 않는다
  async function removeTile(tileId: string): Promise<DashboardResponse> {
    const project = activeProject()
    const index = project.tiles.findIndex((item) => item.id === tileId)
    if (index < 0) {
      return failure('REMOVE_TILE', 'TILE_NOT_FOUND', `Unknown tileId ${tileId}`)
    }

    project.tiles.splice(index, 1)
    await engine.captures.unregister(tileId)
    bindings.delete(tileId)
    summaries.delete(tileId)
    await persist()
    return { ok: true, type: 'REMOVE_TILE' }
  }

  //+_+// P5-D23. 생성은 생성만 한다. 전환은 SET_ACTIVE_PROJECT 가 따로 맡는다. J82
  async function createNewProject(name: string): Promise<DashboardResponse> {
    const created = createProject(crypto.randomUUID(), name)
    await applyProjects([...projects, created], activeProjectId)
    await persist()
    return { ok: true, type: 'CREATE_PROJECT', project: created }
  }

  async function renameProject(projectId: string, name: string): Promise<DashboardResponse> {
    const target = projects.find((item) => item.id === projectId)
    if (target === undefined) {
      return failure('RENAME_PROJECT', 'PROJECT_NOT_FOUND', `Unknown projectId ${projectId}`)
    }
    target.name = name
    await persist()
    return { ok: true, type: 'RENAME_PROJECT' }
  }

  //+_+// P5-D23. 마지막 하나여도 거부하지 않는다. 목록이 비면 resolveProjects 가 기본을 다시 세운다
  //+_+// 지워지는 프로젝트의 타일은 활성 여부와 무관하게 캡처를 멈춘다
  async function deleteProject(projectId: string): Promise<DashboardResponse> {
    const target = projects.find((item) => item.id === projectId)
    if (target === undefined) {
      return failure('DELETE_PROJECT', 'PROJECT_NOT_FOUND', `Unknown projectId ${projectId}`)
    }
    for (const tile of target.tiles) {
      await engine.captures.unregister(tile.id)
    }
    await applyProjects(
      projects.filter((item) => item.id !== projectId),
      activeProjectId,
    )
    await persist()
    return { ok: true, type: 'DELETE_PROJECT' }
  }

  async function setActiveProject(projectId: string): Promise<DashboardResponse> {
    if (!projects.some((item) => item.id === projectId)) {
      return failure('SET_ACTIVE_PROJECT', 'PROJECT_NOT_FOUND', `Unknown projectId ${projectId}`)
    }
    await applyProjects(projects, projectId)
    await persist()
    return { ok: true, type: 'SET_ACTIVE_PROJECT' }
  }

  //+_+// 거부된 저장값을 덮어쓰지 않는다. 씨앗 상태를 그대로 두고 실패를 부르는 쪽에 돌려준다
  //+_+// P5-D35. 재연결은 여기 안에 둔다. 기동 시 1회라는 조건을 한 자리에서 보장한다
  async function load(): Promise<LoadResult> {
    //+_+// A-e5 · D6c. 수동 Pause 는 워커보다 오래 산다. 저장값을 먼저 읽어 엔진에 반영한다
    manualPaused = await loadPreviewPaused(storage)
    applyPause()

    const result = await loadState(storage)
    if (result.ok) {
      await applyProjects(result.projects, result.activeProjectId)
    }
    //+_+// P5-D39. 재연결은 부가 동작이다. 그것이 던져도 저장된 프로젝트는 돌려줘야 한다
    //+_+// P5-D35 가 수동 재시도를 금지했으므로 여기서 던지면 복구 수단이 없다
    try {
      await reconnect()
    } catch (error: unknown) {
      console.error('[webdeck] reconnect failed', errorMessage(error))
    }
    return result
  }

  return {
    engine,
    load,
    handle: async (request) => {
      switch (request.type) {
        case 'GET_PROJECT_STATE':
          if (request.projectId !== activeProjectId) {
            return failure(
              request.type,
              'PROJECT_NOT_FOUND',
              `Unknown projectId ${request.projectId}`,
            )
          }
          applyDashboardVisible(request.dashboardVisible)
          return projectState()
        case 'LIST_BROWSER_TABS':
          return { ok: true, type: 'LIST_BROWSER_TABS', tabs: await listTabs() }
        case 'ADD_TILE':
          return addTile(request.source)
        case 'REOPEN_TILE':
          return reopenTile(request.tileId)
        case 'REMOVE_TILE':
          return removeTile(request.tileId)
        case 'OPEN_MISSING_TABS':
          return openMissingTabs()
        case 'BIND_TILE':
          return bindTile(request.tileId, request.tabId)
        case 'CAPTURE_TILE':
          return captureTile(request.tileId)
        case 'FOCUS_TILE':
          return focusTile(request.tileId)
        case 'SET_TILE_RECT':
          return setTileRect(request.tileId, request.rect)
        case 'SET_TILE_SETTINGS':
          return setTileSettings(request.tileId, request.settings)
        case 'LIST_PROJECTS':
          return { ok: true, type: 'LIST_PROJECTS', projects, activeProjectId }
        case 'CREATE_PROJECT':
          return createNewProject(request.name)
        case 'RENAME_PROJECT':
          return renameProject(request.projectId, request.name)
        case 'DELETE_PROJECT':
          return deleteProject(request.projectId)
        case 'SET_ACTIVE_PROJECT':
          return setActiveProject(request.projectId)
        case 'SET_PREVIEW_PAUSED':
          return setPreviewPaused(request.paused)
        //+_+// P5-D5 가 Reload Page 를, P5-D3 이 Keep Alive 를 Phase 6 으로 두었다
        case 'RELOAD_TILE':
        case 'SET_TILE_KEEP_ALIVE':
          return failure(request.type, 'NOT_IMPLEMENTED', `${request.type} is Phase 6`)
        default:
          return assertNever(request)
      }
    },
  }
}

export function chromeDebuggerBackend(): DebuggerBackend {
  return {
    attach: (tabId) => chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION),
    detach: (tabId) => chrome.debugger.detach({ tabId }),
    sendCommand: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
    onDetach: (listener) => {
      chrome.debugger.onDetach.addListener((source, reason) => {
        if (source.tabId !== undefined) {
          listener(source.tabId, reason)
        }
      })
    },
  }
}

//+_+// J78. local 이다. session 은 브라우저를 닫으면 사라져 v1 section 10 의 재시작 복원을 못 만족한다
//+_+// sync 를 쓰지 않는다. 프로젝트 목록은 기기별 창 배치이고 v1 어디에도 동기화 요구가 없다
export function chromeStorageBackend(): KeyValueBackend {
  return {
    get: async (key) => (await chrome.storage.local.get(key))[key],
    set: async (key, value) => {
      await chrome.storage.local.set({ [key]: value })
    },
    remove: async (key) => {
      await chrome.storage.local.remove(key)
    },
  }
}

function toTabInfo(tab: chrome.tabs.Tab): BrowserTabInfo | null {
  if (tab.id === undefined) {
    return null
  }
  const info: BrowserTabInfo = {
    tabId: tab.id,
    windowId: tab.windowId,
    currentUrl: tab.url ?? '',
    title: tab.title ?? '',
  }
  if (tab.favIconUrl !== undefined) {
    info.favIconUrl = tab.favIconUrl
  }
  return info
}

export function chromeTabsBackend(): TabsBackend {
  return {
    //+_+// 없는 탭은 오류가 아니라 null 이다. chrome.tabs.get 은 없는 탭에 reject 한다
    get: async (tabId) => {
      try {
        return toTabInfo(await chrome.tabs.get(tabId))
      } catch {
        return null
      }
    },
    onRemoved: (listener) => {
      chrome.tabs.onRemoved.addListener((tabId) => {
        listener(tabId)
      })
    },
    onUpdated: (listener) => {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.url !== undefined) {
          listener(tabId, changeInfo.url)
        }
      })
    },
  }
}

//+_+// v1 section 13 line 849. 탭을 활성화하고 그 탭이 든 창을 함께 올린다
//+_+// 탭만 활성화하면 다른 창에 있는 탭은 화면에 나타나지 않는다
function chromeFocusTab(): FocusTab {
  return async (tabId, windowId) => {
    await chrome.tabs.update(tabId, { active: true })
    await chrome.windows.update(windowId, { focused: true })
  }
}

export const DASHBOARD_PAGE = 'dashboard.html'

//+_+// manifest.json 의 commands 키와 같은 이름이어야 한다. 다르면 조용히 아무 일도 일어나지 않는다
export const FOCUS_DASHBOARD_COMMAND = 'focus-dashboard'

//+_+// J16 의 나머지 절반이다. 확장 자신의 페이지를 뺀다. 자기 화면을 재귀로 캡처하지 않기 위해서다
//+_+// 다른 확장의 페이지는 남긴다. 재귀가 되는 것은 자기 자신뿐이다
export function excludeOwnPages(
  tabs: readonly BrowserTabInfo[],
  ownUrlPrefix: string,
): BrowserTabInfo[] {
  return tabs.filter((tab) => !tab.currentUrl.startsWith(ownUrlPrefix))
}

//+_+// P5-D12. 창을 제한하지 않는다. v1 section 9.1 은 "현재 Chrome 에 열린 탭 목록" 이다
function chromeListTabs(): ListTabs {
  return async () => {
    const tabs = await chrome.tabs.query({})
    const known = tabs.map(toTabInfo).filter((tab): tab is BrowserTabInfo => tab !== null)
    return excludeOwnPages(known, chrome.runtime.getURL(''))
  }
}

//+_+// P5-D27. active 로 열지 않는다. Dashboard 를 보는 중에 새 탭이 화면을 가로채면 안 된다
//+_+// id 가 없는 탭은 바인딩할 수 없다. 조용히 통과시키지 않고 던진다
function chromeCreateTab(): CreateTab {
  return async (url) => {
    const info = toTabInfo(await chrome.tabs.create({ url, active: false }))
    if (info === null) {
      throw new Error(`chrome.tabs.create returned no tab id for ${url}`)
    }
    return info
  }
}

//+_+// P4-D3. 찾아서 활성화하고 없으면 만든다. 중복 생성 방지 강화는 Phase 5 다
//+_+// v1 section 13 line 849 가 탭과 창을 함께 활성화하라고 요구한다
export async function openDashboard(): Promise<void> {
  const url = chrome.runtime.getURL(DASHBOARD_PAGE)
  const existing = await chrome.tabs.query({ url })
  const first = existing[0]
  if (first?.id !== undefined) {
    await chrome.tabs.update(first.id, { active: true })
    await chrome.windows.update(first.windowId, { focused: true })
    return
  }
  await chrome.tabs.create({ url })
}

//+_+// 서비스 워커는 최상위에서 스스로 시작한다. 리스너 등록도 최상위여야 한다
//+_+// chrome 이 없는 환경에서는 아무것도 하지 않는다. 그래서 단위 테스트가 이 파일을 import 할 수 있다
if (typeof chrome !== 'undefined' && typeof chrome.debugger !== 'undefined') {
  //+_+// P6-D16 · P6-D18. 계측 키는 상태 키와 다르므로 어댑터 하나를 두 자리에 그대로 넣는다
  const storageBackend = chromeStorageBackend()
  const host = createDashboardHost(
    chromeDebuggerBackend(),
    chromeTabsBackend(),
    chromeListTabs(),
    chromeFocusTab(),
    chromeCreateTab(),
    storageBackend,
    systemClock,
    storageBackend,
  )
  startPreviewDriver(host.engine)

  //+_+// S1. 기동 1회당 1회다. await 하지 않는다. 아래 리스너 등록이 늦어지면 요청을 놓친다
  void recordWorkerStart(storageBackend, Date.now())

  //+_+// S1. 기동 시 1회다. 실패해도 씨앗 상태로 계속 돈다. 조용히 삼키지 않고 콘솔에 남긴다
  host.load().then(
    (result) => {
      if (!result.ok) {
        console.error('[webdeck] load failed', result.errorCode, result.message)
      }
    },
    (error: unknown) => {
      console.error('[webdeck] load threw', errorMessage(error))
    },
  )

  chrome.runtime.onMessage.addListener((message: DashboardRequest, _sender, sendResponse) => {
    host.handle(message).then(sendResponse, (error: unknown) => {
      sendResponse(failure(message.type, 'HANDLER_THREW', errorMessage(error)))
    })
    //+_+// 비동기 응답이다. true 를 돌려주지 않으면 채널이 먼저 닫힌다
    return true
  })

  //+_+// v1 section 13 line 855. Action 버튼으로도 Dashboard 를 열거나 활성화한다
  chrome.action.onClicked.addListener(() => {
    void openDashboard().catch((error: unknown) => {
      console.error('[webdeck] openDashboard failed', errorMessage(error))
    })
  })

  //+_+// L20. Alt+Shift+D 다. Action 클릭과 같은 openDashboard 를 쓴다
  //+_+// 중복 생성 방지 강화는 P4-D3 이 Phase 5 에 두었다. 여기서 만들지 않는다
  chrome.commands.onCommand.addListener((command) => {
    if (command !== FOCUS_DASHBOARD_COMMAND) {
      return
    }
    void openDashboard().catch((error: unknown) => {
      console.error('[webdeck] openDashboard failed', errorMessage(error))
    })
  })
}
