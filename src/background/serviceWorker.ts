import { findFirstAvailablePosition, isPlacementValid } from '../shared/grid'
import type { GridRect } from '../shared/grid'
import { HUB_PAGE, PROJECT_PARAM, assertNever, clientIdOfPortName } from '../shared/messages'
import type {
  AddTileSource,
  DashboardErrorCode,
  DashboardFailure,
  DashboardRequest,
  DashboardRequestType,
  DashboardResponse,
  PortEventRow,
  TileFrame,
  TileSettings,
} from '../shared/messages'
import {
  MIN_TILE_INTERVAL_MS,
  defaultRefreshIntervalMs,
  isValidIntervalOverride,
  tileIntervalMs,
} from '../shared/scheduler'
import { RECORD_LOG_LIMIT } from '../shared/recordLimit'
import { isRestrictedUrl } from '../shared/restrictedUrl'
import { urlMatches } from '../shared/urlMatcher'
import { loadPreviewPaused, loadState, savePreviewPaused, saveState } from '../shared/storage'
import type { KeyValueBackend, LoadResult } from '../shared/storage'
import type { BrowserTabInfo, Project, TileRuntimeState, WebTile } from '../shared/types'
import { DebuggerSessionManager, errorMessage } from './debuggerSessionManager'
import type { DebuggerBackend } from './debuggerSessionManager'
import {
  WORKER_STARTS_KEY,
  buildDiagnostics,
  createRoundLogStore,
  readWorkerStarts,
  recordPortEvent,
  recordReconnectVerdicts,
  recordWorkerStart,
} from './diagnostics'
import type { ReconnectLogRow } from './diagnostics'
import { PreviewCaptureManager, systemClock } from './previewCaptureManager'
import type { Clock, PreviewCaptureManagerOptions } from './previewCaptureManager'
import {
  DEV_TILE_SPAN,
  EMPTY_CAPTURE_SUMMARY,
  applyCaptureRecord,
  buildRuntimeState,
  buildTileOwners,
  createProject,
  formatReconnectVerdict,
  newTile,
  normalizeDescription,
  planReconnect,
  reconnectCandidateCount,
  resolveProjects,
  resolveRuntimeStatus,
} from './projectState'
import type { TileCaptureSummary, TileOwner } from './projectState'
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

//+_+// TASK-P8-07 §1.4. 임차 만료다. 안전망일 뿐이고 정상 경로는 onDisconnect 가 받는다 (P8-D11)
//+_+// 화면 폴링(dashboardService 의 POLL_INTERVAL_MS = 2000)의 60배다
//+_+// 숨은 확장 페이지가 분당 1회까지 스로틀돼도 살아남는 값이다. 그 주기는 미측정이다 (§8-2.4)
//+_+// 넉넉히 잡는 대신 onDisconnect 가 안 난 임차가 최대 이만큼 남는다. J167
export const LEASE_EXPIRY_MS = 120_000

//+_+// P10-D11 (§8-5). dispatchMouseEvent 가 배경 탭에서 반환되지 않는 것은 정상 동작이다.
//+_+// 이 상한을 넘겨도 오류로 세지 않는다. poc-scroll/background.js 의 dispatchTimeoutMs 와 같은 값이다
export const SCROLL_DISPATCH_TIMEOUT_MS = 300

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
//+_+// TASK-P8-07 §1.4. onTick 은 임차 청소다. 새 setInterval 을 만들지 않으려고 여기 얹는다
//+_+// 새 타이머를 만들면 그것이 워커를 깨우는 새 이유가 된다. 이 타이머는 이미 돌고 있다. J168
export function startPreviewDriver(
  engine: PreviewEngine,
  intervalMs = DRIVER_TICK_MS,
  onTick?: () => void,
): () => void {
  const handle: ReturnType<typeof setInterval> = setInterval(() => {
    onTick?.()
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
  //+_+// TASK-P8-05 §1.4. 포트 리스너가 부르는 두 자리다. 장부는 여기 안쪽에 있다
  //+_+// 리스너에 상태를 두면 시험이 못 덮는다. 시험은 host 를 직접 부르고 chrome 스텁이 없다
  portConnected(clientId: string, at: number): Promise<void>
  portDisconnected(clientId: string, at: number): Promise<void>
  //+_+// TASK-P8-07 §1.4. 만료된 임차를 걷는다. 구동자가 부른다. 그 밖에 타이머를 만들지 않는다
  sweepLeases(): Promise<void>
}

//+_+// P5-D12. 창 인자를 받지 않는다. v1 section 9.1 은 "현재 Chrome 에 열린 탭 목록" 이다
export type ListTabs = () => Promise<BrowserTabInfo[]>

//+_+// TabsBackend 에 넣지 않는다. harness/p3 가 그 인터페이스를 구현하고 Phase 3 산출물은 동결이다
//+_+// ListTabs 와 같은 자리다. 캡처 엔진이 쓰지 않는 chrome 호출은 어댑터로 따로 주입한다
export type FocusTab = (tabId: number, windowId: number) => Promise<void>

//+_+// v1 section 14 의 Reload Page 다. FocusTab 과 같은 자리에 둔다
//+_+// TabsBackend 에 얹지 않는다. 그 인터페이스를 구현하는 harness/p3/worker.ts 가
//+_+// 동결이라 메서드를 더하면 Phase 3 산출물을 고쳐야 한다. L41
//+_+// 재적재는 캡처 엔진이 쓰지 않는 호출이므로 엔진 인터페이스에 있을 이유도 없다
export type ReloadTab = (tabId: number) => Promise<void>

//+_+// P5-D27 의 url 경로다. v1 section 20 이 UI 의 chrome 직접 호출을 금지하므로 워커가 만든다
export type CreateTab = (url: string) => Promise<BrowserTabInfo>

//+_+// P8-D16 · P8-D18. 프로젝트 탭의 URL 을 만든다. 호스트는 chrome 도 페이지 이름도 모른다
//+_+// ListTabs 와 같은 자리다. chrome 지식을 어댑터에 두어 호스트가 시험 가능한 채로 남는다
export type ProjectTabUrl = (projectId: string) => string

//+_+// P8-D19. 앞으로 오는 탭을 여는 전용 경로다. CreateTab 과 시그니처를 나눈다
//+_+// CreateTab 을 고치면 openMissingTabs · reopenTile · addTile 세 소비자가 함께 흔들린다
//+_+// 돌려주는 것이 없다. OPEN_PROJECT_TAB 은 만든 탭을 바인딩하지 않는다
export type CreateActiveTab = (url: string) => Promise<void>

function failure(
  type: DashboardRequestType,
  errorCode: DashboardErrorCode,
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
  reloadTab: ReloadTab,
  createTab: CreateTab,
  createActiveTab: CreateActiveTab,
  projectTabUrl: ProjectTabUrl,
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
  //+_+// P10-D23 (§8-5). SCROLL_TILE 좌표용 뷰포트 크기다. 탭별이며 detach·탐색 시 버린다
  const scrollViewportCache = new Map<number, { width: number; height: number }>()

  //+_+// TASK-P8-07 §1.1. 임차 장부다. 폴링이 만들고 갱신하며 포트 끊김이 지운다
  //+_+// 저장하지 않는다 (§8-2.2). 워커가 죽으면 통째로 사라지고 다음 폴링이 다시 쌓는다
  //+_+// at 은 clock.now 다. Date.now 가 아니다 -- 만료 판정이 주입된 시계를 따라야 시험이 된다
  const leases = new Map<string, { projectId: string; visible: boolean; at: number }>()

  //+_+// 지금 등록돼 있다고 아는 프로젝트다. 집합이 실제로 바뀐 회차에만 등록을 갈아 끼운다
  let registeredProjects = new Set<string>()

  //+_+// WEBDECK_PLAN 8-2.3 1번. 타일 요청은 활성 프로젝트가 아니라 소유 프로젝트를 본다
  //+_+// 매 호출에 다시 만든다. projects 는 제자리에서 바뀌므로 한 번 만든 맵은 곧 낡는다. J157
  function ownerOf(tileId: string): TileOwner | null {
    return buildTileOwners(projects).get(tileId) ?? null
  }

  //+_+// 요청이 실어 온 projectId 를 여기서 푼다. 모르는 값은 부르는 쪽이 거절한다
  function projectById(projectId: string): Project | null {
    return projects.find((item) => item.id === projectId) ?? null
  }

  //+_+// P6-D49. 폴링이 알려 주기 전에는 보이지 않는 것으로 둔다. 그 구간이 곧 Pause 다
  //+_+// 전에는 true 였다. Dashboard 가 한 번도 열리지 않은 기동에서 전속 캡처가 돌았다
  let dashboardVisible = false
  //+_+// D6c. 사용자가 누른 Pause 다. 표시 상태와 독립이며 저장에서 읽어 온다
  let manualPaused = false

  const rounds = diagnostics === null ? null : createRoundLogStore(diagnostics)

  //+_+// TASK-P8-05 §1.5. 쓰기를 직렬화한다. 탭 둘이 동시에 끊기면 읽고 쓰는 사이에 서로를 덮는다
  //+_+// 회차 로그가 같은 이유로 체인을 쓴다 (createRoundLogStore). 여기는 버퍼 없이 체인만 둔다. J165
  let portEventChain: Promise<void> = Promise.resolve()

  function notePortEvent(event: PortEventRow['event'], clientId: string, at: number): Promise<void> {
    if (diagnostics === null) {
      return Promise.resolve()
    }
    const backend = diagnostics
    portEventChain = portEventChain.then(() => recordPortEvent(backend, { at, event, clientId }))
    return portEventChain
  }

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
        const tile = ownerOf(record.tileId)?.tile ?? null
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

  //+_+// P10-D23 (§8-5). 좌표 캐시 폐기다. 기존 다중 리스너 자리(addDetachListener · onTabNavigated)에
  //+_+// 별도 리스너로 붙인다. previewCaptureManager 의 리스너를 고치지 않는다
  engine.sessions.addDetachListener((event) => {
    scrollViewportCache.delete(event.tabId)
  })
  engine.tabs.onTabNavigated((tabId) => {
    scrollViewportCache.delete(tabId)
  })

  //+_+// P6-D49. 초기값이 hidden 이므로 엔진도 처음부터 Pause 다. load 를 기다리지 않는다
  //+_+// 여기서 걸지 않으면 첫 폴링 전까지 억제가 없어 D6b 의 요지가 load 호출에 매달린다
  applyPause()

  //+_+// F2 정정 (P8-3-D17). 이 주석의 옛 문안은 재등록이 fault 와 신선도 기준을 초기화한다고
  //+_+// 적었다. 그것은 P5-D20 이 kept 를 넣기 전의 동작이고 P6-D44 가 범위를 더 넓혔다
  //+_+// 지금은 같은 tabId 면 register 가 7필드를 승계한다. 초기화되는 6은 시각과 주기 축이다
  //+_+// 승계  consecutiveFailures 와 demoted (실패 계단) · lastFrameAt (신선도 기준) ·
  //+_+//       fault · tabGone · restricted · holdsLease
  //+_+// 초기화 baseIntervalMs · appliedIntervalMs · touchedAt · nextDueAt · scheduledAt · attemptCount
  //+_+// 그래서 탭이 사라진 타일을 다시 등록해도 DETACHED 가 LIVE 로 뒤집히지 않는다
  //+_+// tabGone 이 승계되고 runDue 가 그 타일을 회차에서 뺀다. 죽은 탭에 다시 attach 하지 않는다
  //+_+// 그럼에도 exists 를 먼저 묻는다. 승계는 이전 상태가 남아 있을 때만 성립한다
  //+_+// unregister 를 지난 타일은 승계할 것이 없어 tabGone 이 false 로 새로 서고
  //+_+// 그러면 죽은 탭에 다시 붙으려 한다. 탭 존재 여부의 권위는 워커의 tabs 층이다
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

  //+_+// TASK-P8-07 §1.2. 살아 있는 임차의 projectId 집합이다. 등록을 가르는 것은 이것이다
  //+_+// activeProjectId 가 아니다. 그쪽은 "마지막으로 연 것" 의 기록으로 남는다 (P8-D9)
  function activeSet(): Set<string> {
    return new Set([...leases.values()].map((lease) => lease.projectId))
  }

  //+_+// 집합에 든 프로젝트만 등록한다. P5-D25 의 전환 배선을 대신한다
  //+_+// reregister 는 bindings 가 있어야 돈다. 그것은 기동 시 reconnect 이 채운다 (§1.2)
  //+_+// 해제는 registeredProjects 가 아니라 알려진 프로젝트 전체를 훑는다
  //+_+// BIND_TILE 과 ADD_TILE 이 집합을 안 보고 바로 등록하므로 그 자국이 여기 남는다
  //+_+// 이미 해제된 타일에 부르는 것은 무해하다. unregister 가 첫 줄에서 되돌아간다. J169
  async function syncRegistrations(): Promise<void> {
    const next = activeSet()
    for (const project of projects) {
      if (next.has(project.id)) {
        continue
      }
      for (const tile of project.tiles) {
        await engine.captures.unregister(tile.id)
      }
    }
    let entered = false
    for (const projectId of next) {
      if (registeredProjects.has(projectId)) {
        continue
      }
      entered = true
      for (const tile of projectById(projectId)?.tiles ?? []) {
        await reregister(tile)
      }
    }
    registeredProjects = next
    //+_+// P8-3-D12. 대시보드를 새로 연 자리다. 2026-08-26 실측의 순서가 이것이다
    //+_+// 워커가 살아 있는 동안 열린 탭은 onTabNavigated 가 가드에 걸려 놓친다
    //+_+// 그 탭을 여기서 집는다. 집합이 실제로 커진 회차에만 돈다. 폴링마다 돌지 않는다
    //+_+// bindings 유무로 걸지 않는다. kind 가 none 인 타일 하나로 영구히 참이 되기 때문이다
    //+_+// "붙을 수 있는 탭이 있는가" 는 reconnect 이 requireBind 로 스스로 판정한다
    if (entered) {
      await reconnectForTrigger()
    }
  }

  //+_+// P6-D52. 전환은 재등록하지 않는다. 재등록할 이유였던 hidden 주기가 사라졌다
  //+_+// P8-D7. 전역 하나를 임차들의 visible 로 OR 한다. 받은 값으로 덮지 않는다
  //+_+// 덮으면 탭 둘이 폴링마다 setPaused 를 토글하고 해제 시프트가 만기를 민다 (P6-D59)
  //+_+// 임차가 없으면 false 다. 그 순간 등록도 0 이라 돌 타일이 없다 (§1.3)
  function applyDashboardVisible(): void {
    const next = [...leases.values()].some((lease) => lease.visible)
    if (next === dashboardVisible) {
      return
    }
    dashboardVisible = next
    applyPause()
  }

  //+_+// TASK-P8-07 §1.1. 폴링이 임차를 만들고 갱신한다. 포트 연결은 만들지 않는다
  //+_+// 그 시점에 어느 프로젝트인지 모르기 때문이다. clientId 가 둘을 잇는다 (P8-D8)
  async function noteLease(clientId: string, projectId: string, visible: boolean): Promise<void> {
    leases.set(clientId, { projectId, visible, at: clock.now() })
    await syncRegistrations()
    applyDashboardVisible()
  }

  //+_+// 끊김과 만료가 같은 자리로 온다. 없는 clientId 면 아무 일도 하지 않는다
  async function dropLease(clientId: string): Promise<void> {
    if (!leases.delete(clientId)) {
      return
    }
    await syncRegistrations()
    applyDashboardVisible()
  }

  //+_+// TASK-P8-07 §1.4. 안전망이다. onDisconnect 가 안 난 임차만 여기로 온다
  async function sweepLeases(): Promise<void> {
    const deadline = clock.now() - LEASE_EXPIRY_MS
    const stale = [...leases.entries()]
      .filter(([, lease]) => lease.at <= deadline)
      .map(([clientId]) => clientId)
    if (stale.length === 0) {
      return
    }
    for (const clientId of stale) {
      leases.delete(clientId)
    }
    await syncRegistrations()
    applyDashboardVisible()
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

  //+_+// TASK-P8-07 §1.2. 등록을 가르는 것은 활성 집합이다. 여기서 activeProjectId 로 가르지 않는다
  //+_+// P5-D25 의 전환 unregister 가 syncRegistrations 로 옮겨 갔다
  //+_+// 목록이 바뀌면 집합 소속 프로젝트의 타일 구성도 바뀔 수 있으므로 한 번 맞춘다
  async function applyProjects(nextProjects: Project[], nextActiveId: string): Promise<void> {
    const resolved = resolveProjects(nextProjects, nextActiveId)
    projects = resolved.projects
    activeProjectId = resolved.activeProjectId
    await syncRegistrations()
  }

  async function projectState(projectId: string): Promise<DashboardResponse> {
    const project = projectById(projectId)
    if (project === null) {
      return failure('GET_PROJECT_STATE', 'PROJECT_NOT_FOUND', `Unknown projectId ${projectId}`)
    }
    const runtimeStates: TileRuntimeState[] = []
    const frames: TileFrame[] = []

    for (const tile of project.tiles) {
      const tabId = bindings.get(tile.id)
      const tab = tabId === undefined ? null : await engine.tabs.info(tabId)
      const summary = summaries.get(tile.id) ?? EMPTY_CAPTURE_SUMMARY
      //+_+// P6-D3. 판정 근거는 바인딩된 탭의 현재 URL 이다. 그것이 attach 대상이기 때문이다
      //+_+// 탭이 없으면 launchUrl 로 본다. 그 타일이 열려고 하는 곳이 그것이다
      //+_+// 폴링마다 다시 본다. 사용자가 탭을 chrome:// 로 옮기면 다음 폴링이 그것을 집는다
      const restricted = isRestrictedUrl(tab?.currentUrl ?? tile.launchUrl)
      //+_+// P6-D104. 표시와 스케줄이 같은 판정을 쓴다. 규칙을 두 곳에 두지 않는다
      engine.captures.setRestricted(tile.id, restricted)
      const status = resolveRuntimeStatus(
        engine.captures.statusOf(tile.id),
        tabId,
        tab,
        summary.lastCaptureAt !== undefined,
        restricted,
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
    const owner = ownerOf(tileId)
    if (owner === null) {
      return failure('SET_TILE_RECT', 'TILE_NOT_FOUND', `Unknown tileId ${tileId}`)
    }
    const { tile, project } = owner
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
    const tile = ownerOf(tileId)?.tile ?? null
    if (tile === null) {
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

  //+_+// v1 section 14. Refresh Preview 는 화면만 다시 찍고 이것은 탭 자체를 다시 읽는다
  //+_+// 여기서 캡처를 부르지 않는다. 두 동작을 가른 것이 그 절의 요구다
  //+_+// RESTRICTED 타일도 막지 않는다. 붙을 수 없는 것은 디버거이고 탭은 실재한다
  //+_+// 실패 판정은 focusTile 과 같다. 창을 쓰지 않으므로 windowId 만 읽지 않는다
  async function reloadTile(tileId: string): Promise<DashboardResponse> {
    const tabId = bindings.get(tileId)
    if (tabId === undefined) {
      return failure('RELOAD_TILE', 'TILE_NOT_BOUND', `Tile ${tileId} is not bound to a tab`)
    }
    if (!(await engine.tabs.exists(tabId))) {
      return failure('RELOAD_TILE', 'TAB_NOT_FOUND', `No tab with id ${String(tabId)}`)
    }
    await reloadTab(tabId)
    return { ok: true, type: 'RELOAD_TILE' }
  }

  //+_+// P10-D23 (§8-5). 휠은 스로틀하지 않으므로(P10-D11) 캐시가 없으면 휠 1회마다 CDP 왕복이 붙는다
  //+_+// 캐시 없을 때만 읽는다. 읽기 실패는 오류로 올리지 않고 좌표를 못 구한 것으로 다룬다
  async function tileViewportSize(tabId: number): Promise<{ width: number; height: number } | null> {
    const cached = scrollViewportCache.get(tabId)
    if (cached !== undefined) {
      return cached
    }
    try {
      const result = (await debuggerBackend.sendCommand(tabId, 'Runtime.evaluate', {
        expression: '({ width: window.innerWidth, height: window.innerHeight })',
        returnByValue: true,
      })) as { result?: { value?: unknown } }
      const value = result.result?.value as { width?: unknown; height?: unknown } | undefined
      if (typeof value?.width !== 'number' || typeof value.height !== 'number') {
        return null
      }
      const size = { width: value.width, height: value.height }
      scrollViewportCache.set(tabId, size)
      return size
    } catch (error) {
      console.error('[webdeck] SCROLL_TILE viewport read failed', tabId, errorMessage(error))
      return null
    }
  }

  //+_+// P10-D11. await 하지 않는다는 것은 dispatch 완료까지 기다리지 않는다는 뜻이다.
  //+_+// SCROLL_DISPATCH_TIMEOUT_MS 상한만 던지고 진행한다. poc-scroll/background.js dispatchWheel 과 같은 형태다
  //+_+// catch 가 rejection 을 resolve 로 바꾸므로 race 가 unhandled rejection 을 남기지 않는다
  async function dispatchWheel(tabId: number, x: number, y: number, deltaY: number): Promise<void> {
    const commandPromise = debuggerBackend
      .sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
      .catch((error: unknown) => {
        console.error('[webdeck] SCROLL_TILE dispatch failed', tabId, errorMessage(error))
      })
    const guard = new Promise<void>((resolve) => {
      setTimeout(resolve, SCROLL_DISPATCH_TIMEOUT_MS)
    })
    await Promise.race([commandPromise, guard])
  }

  //+_+// v1 section 17 경계를 넘는 결정이다 (P10-D2). 휠만이다. tabId 가 없으면 조용히 아무것도
  //+_+// 하지 않고 정상 응답한다 (P10-D21) - status 이름으로 분기하지 않는다
  async function scrollTile(tileId: string, deltaY: number): Promise<DashboardResponse> {
    const tabId = bindings.get(tileId)
    if (tabId === undefined) {
      return { ok: true, type: 'SCROLL_TILE' }
    }
    const viewport = await tileViewportSize(tabId)
    if (viewport === null) {
      return { ok: true, type: 'SCROLL_TILE' }
    }
    await dispatchWheel(tabId, Math.round(viewport.width / 2), Math.round(viewport.height / 2), deltaY)
    return { ok: true, type: 'SCROLL_TILE' }
  }

  //+_+// P4-D2. 모르는 tileId 면 첫 빈 자리에 1x1 타일을 만든다. 아는 tileId 면 탭만 다시 건다
  //+_+// 새 메시지 이름을 만들지 않기 위해 v1 section 19 의 BIND_TILE 하나로 둘을 처리한다
  async function bindTile(
    projectId: string,
    tileId: string,
    tabId: number,
  ): Promise<DashboardResponse> {
    const project = projectById(projectId)
    if (project === null) {
      return failure('BIND_TILE', 'PROJECT_NOT_FOUND', `Unknown projectId ${projectId}`)
    }
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
    //+_+// P6-D104. 첫 폴링을 기다리면 그 사이에 회차가 돈다. 탭을 이미 읽었으므로 여기서 정한다
    //+_+// 기존 타일을 다른 탭에 다시 걸 때 launchUrl 은 낡았다. 탭의 현재 URL 만이 옳다
    engine.captures.setRestricted(tile.id, isRestrictedUrl(tab.currentUrl))
    //+_+// P5-D29. ADD_TILE 과 같다. 타일이 늘거나 바뀌었으면 저장한다
    await persist()
    return { ok: true, type: 'BIND_TILE' }
  }

  //+_+// P5-D27. v1 section 9.1 의 두 경로다. 자리를 먼저 확인하고 그 뒤에 탭을 만든다
  //+_+// 순서를 뒤집으면 GRID_FULL 로 실패한 뒤에도 사용자 탭이 남는다
  //+_+// 기존 탭은 reload 하지 않고 창도 옮기지 않는다. Link Only 다. v1 section 9.1, 9.2
  async function addTile(projectId: string, source: AddTileSource): Promise<DashboardResponse> {
    const project = projectById(projectId)
    if (project === null) {
      return failure('ADD_TILE', 'PROJECT_NOT_FOUND', `Unknown projectId ${projectId}`)
    }
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
    //+_+// P6-D104. tab 경로의 launchUrl 은 탭의 현재 URL 이고 url 경로의 그것은 사용자가 준 값이다
    //+_+// 두 경로 모두 이 시점에 아는 가장 정확한 URL 이다
    engine.captures.setRestricted(tileId, isRestrictedUrl(launchUrl))
    await persist()
    return { ok: true, type: 'ADD_TILE', tileId }
  }

  //+_+// P8-3-D11. P5-D37 전용 정의다. reconnect 은 더 이상 이것을 쓰지 않는다
  //+_+// 기동 1회 시절에만 두 물음의 답이 같았다. reconnect 이 폴링과 탭 이벤트로도 돌게 되면서
  //+_+// "이 타일이 이미 쥐고 있는 탭이 무엇인가" 와 "이 타일이 지금 캡처되고 있는가" 가 갈렸다
  //+_+// 뜻이 둘이면 정의도 둘이다. reconnect 쪽 정의는 boundToLiveTab 이다
  function liveBoundTabId(tileId: string): number | null {
    const tabId = bindings.get(tileId)
    if (tabId === undefined || !engine.captures.isScheduled(tileId)) {
      return null
    }
    return tabId
  }

  //+_+// P8-3-D11. P5-D37 정본이 tabGone 이라 적은 것을 reconnect 쪽에서 복원한다
  //+_+// 탭 존재 여부를 listTabs 결과로 판정한다. exists 를 타일마다 await 하지 않으므로
  //+_+// 새 chrome.* 호출이 0 이고 targets 조립이 동기로 남는다
  //+_+// chromeListTabs 가 확장 자기 페이지를 뺀다. 그 탭에 걸린 타일은 "없는 탭" 으로 읽힌다
  //+_+// ADD_TILE 이 그 목록에서만 고르므로 그런 타일은 실제로 생기지 않는다
  function boundToLiveTab(tileId: string, liveTabIds: ReadonlySet<number>): number | null {
    const tabId = bindings.get(tileId)
    if (tabId === undefined || !liveTabIds.has(tabId)) {
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

  //+_+// P5-D35 (개정 · P8-3-D12). v1 section 10 이다. 전용 메시지를 만들지 않는다
  //+_+// 기동 시 1회이던 것에 트리거 둘이 더해졌다. 부르는 자리는 load 와 reconnectForTrigger 다
  //+_+// tabId 를 저장하지 않으므로 URL 로 다시 찾는다. 살아 있는 바인딩은 건드리지 않는다
  //+_+// P6-D53. 전 프로젝트를 한 번에 판정한다. 활성만 훑으면 다른 프로젝트 타일이 영영 굳는다
  //+_+// 그 타일은 bindings 가 비어 있어 전환해도 reregister 가 첫 줄에서 되돌아간다
  //+_+// P5-D36 의 한 탭 한 타일은 프로젝트 경계를 넘어 성립해야 하므로 targets 를 통째로 넘긴다
  //+_+// P8-3-D14. requireBind 는 트리거 경로다. 붙을 것이 하나도 없으면 아무것도 남기지 않는다
  //+_+// 그것이 없으면 none 과 ambiguous 만 남은 상태에서 트리거마다 P6-D56 쓰기가 돈다
  async function reconnect(requireBind = false): Promise<void> {
    const owners = buildTileOwners(projects)
    //+_+// P8-3-D11. targets 조립보다 앞이다. boundTabId 판정이 이 목록을 본다
    const tabs = await listTabs()
    const liveTabIds = new Set(tabs.map((tab) => tab.tabId))
    //+_+// P7-D41. 활성 프로젝트 타일을 앞에 둔다. taken 이 배열 순서로 탭을 주므로 순서가 승자를 정한다
    //+_+// 앞에 두지 않으면 비활성 타일이 탭을 가져가고 bindOnly 라 활성 프로젝트가 통째로 굶는다 (L49)
    //+_+// 정렬이 아니라 분할이다. 두 그룹 안의 저장 순서가 그대로 남아야 결정성이 유지된다 (P5-D36)
    const owned = [...owners.values()]
    const targets = [
      ...owned.filter((entry) => entry.project.id === activeProjectId),
      ...owned.filter((entry) => entry.project.id !== activeProjectId),
    ].map(({ tile }) => ({
      tile,
      boundTabId: boundToLiveTab(tile.id, liveTabIds),
    }))
    const verdicts = planReconnect(targets, tabs)
    if (requireBind && !verdicts.some((verdict) => verdict.kind === 'bind')) {
      return
    }

    //+_+// TASK-P8-07 §1.2. 등록 여부는 활성 집합이 가른다. 기동 직후에는 비어 있어 전부 bindOnly 다
    //+_+// 위 P7-D41 분할은 activeProjectId 를 그대로 쓴다. 기동 시점에 집합은 아직 비어 있고
    //+_+// 저장된 "마지막으로 연 것" 이 그때 쓸 수 있는 유일한 순서 근거다. L49 를 그대로 지킨다
    const active = activeSet()

    //+_+// P6-D56. 콘솔과 같은 판정을 storage 에도 남긴다. 콘솔은 워커가 죽으면 함께 사라진다
    const rows: ReconnectLogRow[] = []
    const at = Date.now()

    let bound = 0
    for (const verdict of verdicts) {
      const owner = owners.get(verdict.tileId)
      if (owner === undefined) {
        continue
      }
      //+_+// C-e2. 붙였든 못 붙였든 한 줄씩 남긴다. 무음이던 것이 결함 추적을 14분 막았다
      console.log(formatReconnectVerdict(verdict, owner.project.id, activeProjectId))
      rows.push({
        at,
        tileId: verdict.tileId,
        projectId: owner.project.id,
        kind: verdict.kind,
        candidates: reconnectCandidateCount(verdict),
        //+_+// P6-D56 이 정한 뜻 그대로 "마지막으로 연 프로젝트인가" 다. 집합 소속이 아니다
        //+_+// 기동 시점에 집합은 비어 있어 전부 false 가 되고 그러면 이 행이 아무것도 안 가른다
        //+_+// 아래 attach 분기와 갈리므로 여기 적어 둔다. J170
        active: owner.project.id === activeProjectId,
      })
      if (verdict.kind !== 'bind') {
        continue
      }
      //+_+// 집합 밖 프로젝트는 바인딩만 되돌린다. 폴링이 집합에 넣으면 syncRegistrations 가 등록한다
      if (active.has(owner.project.id)) {
        attachTile(owner.tile, verdict.tabId)
      } else {
        bindOnly(verdict.tileId, verdict.tabId)
      }
      bound += 1
    }
    if (diagnostics !== null) {
      await recordReconnectVerdicts(diagnostics, rows)
    }
    if (bound > 0) {
      await persist()
    }
  }

  //+_+// P8-3-D13. 어댑터의 url 검사를 지난 발화가 전부 재연결 대상은 아니다
  //+_+// 2026-08-26 실측. 무관한 탭의 favIconUrl 변경만으로도 onUpdated 가 온다 (L53)
  //+_+// 새 탭 하나에 chrome://newtab/ 과 최종 URL 둘이 실려 오고 앞의 것은 urlMatches 가 떨군다
  //+_+// 그래서 발화를 묶는 디바운스를 새로 만들지 않는다. 새 타이머를 만들지 않는다 (J168)
  function isBindableNavigation(tabId: number, url: string): boolean {
    for (const boundTabId of bindings.values()) {
      if (boundTabId === tabId) {
        return false
      }
    }
    for (const { tile } of buildTileOwners(projects).values()) {
      if (urlMatches(tile.launchUrl, url, tile.matchMode)) {
        return true
      }
    }
    return false
  }

  //+_+// P8-3-D13. 트리거 둘이 함께 쓰는 자리다. 가드를 두 곳에 두지 않는다
  //+_+// 2026-08-26 실측. 탭 이벤트가 비활성 워커를 깨운다. 대시보드가 하나도 없는 상태에서
  //+_+// 탭을 열자 워커가 활성으로 돌아왔다. 가드가 없으면 그 워커가 재연결까지 돌고
  //+_+// 그것이 L1 용의자 1 을 제품으로 재현한다. 활성 집합이 비면 아무것도 하지 않는다
  //+_+// 리스너가 동기라 여기서 던지면 처리되지 않는 거부가 된다. P5-D39 와 같은 이유로 삼킨다
  async function reconnectForTrigger(): Promise<void> {
    if (activeSet().size === 0) {
      return
    }
    try {
      await reconnect(true)
    } catch (error: unknown) {
      console.error('[webdeck] reconnect failed', errorMessage(error))
    }
  }

  //+_+// P8-3-D12. 대시보드가 열려 있는 동안 사용자가 연 탭을 여기서 집는다
  //+_+// 2026-08-26 실측. 새 탭은 changeInfo.url 이 실린 onUpdated 로 온다. about:blank 를 거치지 않는다
  //+_+// onCreated 어댑터를 만들지 않는다. TabManager 가 이미 그 발화를 나른다 (J8)
  engine.tabs.onTabNavigated((tabId, url) => {
    if (!isBindableNavigation(tabId, url)) {
      return
    }
    void reconnectForTrigger()
  })

  //+_+// P5-D37. v1 section 10 의 6단계다. 버튼으로만 돈다. 브라우저 시작과 동시에 돌지 않는다
  //+_+// 한 건이 실패해도 앞의 성공을 되돌리지 않는다. 성공한 것만 응답에 싣는다
  async function openMissingTabs(projectId: string): Promise<DashboardResponse> {
    const project = projectById(projectId)
    if (project === null) {
      return failure('OPEN_MISSING_TABS', 'PROJECT_NOT_FOUND', `Unknown projectId ${projectId}`)
    }
    const openedTileIds: string[] = []
    for (const tile of project.tiles) {
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
    const tile = ownerOf(tileId)?.tile ?? null
    if (tile === null) {
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
    const owner = ownerOf(tileId)
    if (owner === null) {
      return failure('REMOVE_TILE', 'TILE_NOT_FOUND', `Unknown tileId ${tileId}`)
    }

    //+_+// 조회가 준 것과 같은 객체다. id 로 배열을 다시 훑지 않는다
    const { tile, project } = owner
    project.tiles.splice(project.tiles.indexOf(tile), 1)
    await engine.captures.unregister(tileId)
    bindings.delete(tileId)
    summaries.delete(tileId)
    await persist()
    return { ok: true, type: 'REMOVE_TILE' }
  }

  //+_+// P5-D23. 생성은 생성만 한다. 전환은 SET_ACTIVE_PROJECT 가 따로 맡는다. J82
  async function createNewProject(name: string, description?: string): Promise<DashboardResponse> {
    const created = createProject(crypto.randomUUID(), name, description)
    await applyProjects([...projects, created], activeProjectId)
    await persist()
    return { ok: true, type: 'CREATE_PROJECT', project: created }
  }

  //+_+// J173. description 이 없는 요청은 설명을 건드리지 않는다. 허브는 둘을 함께 보낸다
  //+_+// 빈 문자열은 지우라는 뜻이다. normalizeDescription 이 그것을 필드 부재로 만든다 (P8-D13)
  async function renameProject(
    projectId: string,
    name: string,
    description?: string,
  ): Promise<DashboardResponse> {
    const target = projects.find((item) => item.id === projectId)
    if (target === undefined) {
      return failure('RENAME_PROJECT', 'PROJECT_NOT_FOUND', `Unknown projectId ${projectId}`)
    }
    target.name = name
    if (description !== undefined) {
      const normalized = normalizeDescription(description)
      if (normalized === undefined) {
        delete target.description
      } else {
        target.description = normalized
      }
    }
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

  //+_+// P8-D16. 허브가 프로젝트 탭을 연다. 기존 탭을 찾아 재사용하지 않는다 (§8-2.2)
  //+_+// URL 은 어댑터가 만든다. 여기서 chrome.runtime.getURL 을 부르지 않는다
  //+_+// P8-D19. 이 탭만 앞으로 온다. 사용자가 그 탭으로 가려고 누른 버튼이기 때문이다
  //+_+// createTab 을 쓰지 않는다. 그쪽은 타일 탭 경로이고 뒤에서 열어야 한다
  async function openProjectTab(projectId: string): Promise<DashboardResponse> {
    if (projectById(projectId) === null) {
      return failure('OPEN_PROJECT_TAB', 'PROJECT_NOT_FOUND', `Unknown projectId ${projectId}`)
    }
    await createActiveTab(projectTabUrl(projectId))
    return { ok: true, type: 'OPEN_PROJECT_TAB' }
  }

  //+_+// P6-D9 · D113. v1 section 15.5 다. 값은 전부 엔진이 이미 들고 있는 것이다
  //+_+// 워커 기동 수만 계측 배선에서 읽는다. 배선이 없으면 null 이다. 0 과 구별한다
  //+_+// 회차 로그도 재연결 판정도 포트 기록도 응답에 싣지 않는다. 그것은 실측 도구다
  async function diagnosticsSnapshot(): Promise<DashboardResponse> {
    let workerStarts: number | null = null
    if (diagnostics !== null) {
      try {
        workerStarts = readWorkerStarts(await diagnostics.get(WORKER_STARTS_KEY)).starts
      } catch {
        //+_+// 계측 읽기 실패가 Diagnostics 조회를 깨지 않는다. 모르는 것은 null 로 둔다
        workerStarts = null
      }
    }
    return {
      ok: true,
      type: 'GET_DIAGNOSTICS',
      diagnostics: buildDiagnostics({
        captureRecords: engine.captures.captureRecords,
        registeredTiles: engine.captures.registeredTileCount,
        attachedTabs: engine.sessions.attachedCount,
        workerStarts,
        //+_+// P6-D7 의 다섯 배열이다. 이름은 화면에 그대로 나온다
        recordLogs: [
          {
            name: 'captureRecords',
            length: engine.captures.captureRecords.length,
            limit: RECORD_LOG_LIMIT,
          },
          {
            name: 'lateArrivals',
            length: engine.captures.lateArrivals.length,
            limit: RECORD_LOG_LIMIT,
          },
          {
            name: 'attachFailures',
            length: engine.sessions.attachFailures.length,
            limit: RECORD_LOG_LIMIT,
          },
          {
            name: 'detachEvents',
            length: engine.sessions.detachEvents.length,
            limit: RECORD_LOG_LIMIT,
          },
          {
            name: 'detachFailures',
            length: engine.sessions.detachFailures.length,
            limit: RECORD_LOG_LIMIT,
          },
        ],
      }),
    }
  }

  //+_+// 거부된 저장값을 덮어쓰지 않는다. 씨앗 상태를 그대로 두고 실패를 부르는 쪽에 돌려준다
  //+_+// P5-D35 (개정 · P8-3-D12). 기동 시 재연결은 여기 안에 둔다. 그 회차만 판정을 전부 남긴다
  //+_+// 트리거 둘은 requireBind 로 돌므로 붙을 것이 없으면 아무것도 남기지 않는다
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
    portConnected: (clientId, at) => notePortEvent('connect', clientId, at),
    //+_+// TASK-P8-07 §1.6. 기록에 더해 임차까지 지운다. 이것이 닫힘의 정상 경로다 (P8-D11)
    portDisconnected: async (clientId, at) => {
      await notePortEvent('disconnect', clientId, at)
      await dropLease(clientId)
    },
    sweepLeases,
    handle: async (request) => {
      switch (request.type) {
        case 'GET_PROJECT_STATE':
          //+_+// TASK-P8-07 §1.5. 활성값과 대조하지 않는다. 아는 프로젝트면 임차를 만든다
          //+_+// 모르는 값은 거절하고 임차를 만들지 않는다
          if (projectById(request.projectId) === null) {
            return failure(
              request.type,
              'PROJECT_NOT_FOUND',
              `Unknown projectId ${request.projectId}`,
            )
          }
          await noteLease(request.clientId, request.projectId, request.dashboardVisible)
          return projectState(request.projectId)
        case 'LIST_BROWSER_TABS':
          return { ok: true, type: 'LIST_BROWSER_TABS', tabs: await listTabs() }
        case 'ADD_TILE':
          return addTile(request.projectId, request.source)
        case 'REOPEN_TILE':
          return reopenTile(request.tileId)
        case 'REMOVE_TILE':
          return removeTile(request.tileId)
        case 'OPEN_MISSING_TABS':
          return openMissingTabs(request.projectId)
        case 'BIND_TILE':
          return bindTile(request.projectId, request.tileId, request.tabId)
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
          return createNewProject(request.name, request.description)
        case 'RENAME_PROJECT':
          return renameProject(request.projectId, request.name, request.description)
        case 'DELETE_PROJECT':
          return deleteProject(request.projectId)
        case 'SET_ACTIVE_PROJECT':
          return setActiveProject(request.projectId)
        case 'OPEN_PROJECT_TAB':
          return openProjectTab(request.projectId)
        case 'SET_PREVIEW_PAUSED':
          return setPreviewPaused(request.paused)
        case 'GET_DIAGNOSTICS':
          return diagnosticsSnapshot()
        case 'RELOAD_TILE':
          return reloadTile(request.tileId)
        case 'SCROLL_TILE':
          return scrollTile(request.tileId, request.deltaY)
        //+_+// P5-D3 이 Keep Alive 를 Phase 6 으로 두었다. V1_DEVIATIONS 3 이 그 편차다
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

//+_+// bypassCache 를 넘기지 않는다. 캐시를 건너뛰는 재적재는 요청되지 않았다
//+_+// 탭을 앞으로 가져오지 않는다. Reload Page 는 보고 있는 화면을 바꾸지 않는다
function chromeReloadTab(): ReloadTab {
  return async (tabId) => {
    await chrome.tabs.reload(tabId)
  }
}

//+_+// 8-2.3 3번. 값은 그대로다. OPEN_PROJECT_TAB 이 여기에 ?project= 를 붙여 쓴다
//+_+// 툴바 아이콘과 단축키가 여는 것은 HUB_PAGE 다. 그쪽은 화면도 쓰므로 shared 에 있다
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

//+_+// P8-D19. 앞으로 오는 탭이다. 탭 id 를 쓰지 않으므로 toTabInfo 를 지나지 않는다
function chromeCreateActiveTab(): CreateActiveTab {
  return async (url) => {
    await chrome.tabs.create({ url, active: true })
  }
}

//+_+// P8-D16 · P8-D18. 파라미터를 붙이는 자리다. 화면은 chrome.runtime.getURL 을 부르지 않는다
//+_+// 값은 DASHBOARD_PAGE 그대로다. 허브를 여는 것은 openHub 이고 이쪽은 프로젝트 화면이다
function chromeProjectTabUrl(): ProjectTabUrl {
  return (projectId) =>
    chrome.runtime.getURL(`${DASHBOARD_PAGE}?${PROJECT_PARAM}=${encodeURIComponent(projectId)}`)
}

//+_+// P5-D27. active 로 열지 않는다. Dashboard 를 보는 중에 새 탭이 화면을 가로채면 안 된다
//+_+// P8-D19. 예외가 하나 생겼다. 허브의 Open 이 여는 탭은 chromeCreateActiveTab 으로 간다
//+_+// 그쪽은 사용자가 그 탭으로 가려고 누른 것이라 이 근거가 걸리지 않는다. 이 경로는 그대로다
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
//+_+// 8-2.3 3번. 여는 것이 허브로 바뀌었으므로 이름도 바꾼다. 프로젝트 탭은 openProjectTab 이다
export async function openHub(): Promise<void> {
  const url = chrome.runtime.getURL(HUB_PAGE)
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
    chromeReloadTab(),
    chromeCreateTab(),
    chromeCreateActiveTab(),
    chromeProjectTabUrl(),
    storageBackend,
    systemClock,
    storageBackend,
  )
  //+_+// TASK-P8-07 §1.4. 임차 청소를 이미 도는 구동자에 얹는다. 새 타이머를 만들지 않는다
  startPreviewDriver(host.engine, DRIVER_TICK_MS, () => {
    void host.sweepLeases().catch((error: unknown) => {
      console.error('[webdeck] lease sweep failed', errorMessage(error))
    })
  })

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

  //+_+// TASK-P8-05 §1.4. 이름을 풀어 host 를 부르는 것뿐이다. 여기에 상태를 두지 않는다
  //+_+// 포트로 아무것도 보내지 않는다. postMessage 도 onMessage 도 걸지 않는다 (§1.1)
  //+_+// 접두사가 다른 포트는 무시한다. measure/transport 가 port.name 을 거르는 것과 같다
  chrome.runtime.onConnect.addListener((port) => {
    const clientId = clientIdOfPortName(port.name)
    if (clientId === null) {
      return
    }
    void host.portConnected(clientId, Date.now()).catch((error: unknown) => {
      console.error('[webdeck] port connect record failed', errorMessage(error))
    })
    port.onDisconnect.addListener(() => {
      //+_+// 이 시점에 페이지가 이미 없다. await 하지 않는다
      void host.portDisconnected(clientId, Date.now()).catch((error: unknown) => {
        console.error('[webdeck] port disconnect record failed', errorMessage(error))
      })
    })
  })

  //+_+// v1 section 13 line 855. Action 버튼으로도 허브를 열거나 활성화한다
  chrome.action.onClicked.addListener(() => {
    void openHub().catch((error: unknown) => {
      console.error('[webdeck] openHub failed', errorMessage(error))
    })
  })

  //+_+// L20. Alt+Shift+D 다. Action 클릭과 같은 openHub 를 쓴다
  //+_+// 중복 생성 방지 강화는 P4-D3 이 Phase 5 에 두었다. 여기서 만들지 않는다
  //+_+// FOCUS_DASHBOARD_COMMAND 와 manifest 의 commands 키는 그대로다 (§8-2.2)
  chrome.commands.onCommand.addListener((command) => {
    if (command !== FOCUS_DASHBOARD_COMMAND) {
      return
    }
    void openHub().catch((error: unknown) => {
      console.error('[webdeck] openHub failed', errorMessage(error))
    })
  })
}
