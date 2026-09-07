import { useCallback, useEffect, useRef, useState } from 'react'
import { GRID_COLUMNS, GRID_ROWS } from '../shared/grid'
import type { GridPosition } from '../shared/grid'
import { HUB_PAGE } from '../shared/messages'
import type { DashboardResponse, DiagnosticsSnapshot } from '../shared/messages'
import type { BrowserTabInfo, WebTile } from '../shared/types'
import { TileCard } from './TileCard'
import {
  POLL_INTERVAL_MS,
  addTile,
  bindTile,
  captureTile,
  createVisibilityGate,
  fetchDiagnostics,
  fetchProjectState,
  focusTile,
  isDashboardVisible,
  isStaleTabFailure,
  listBrowserTabs,
  openMissingTabs,
  reloadTile,
  removeTile,
  reopenTile,
  scrollTile,
  setPreviewPaused,
  setTileRect,
  setTileSettings,
} from './dashboardService'
import {
  beginDrag,
  dragClassName,
  dragTo,
  dropIndicator,
  dropRect,
  pointerToCell,
} from './layoutDrag'
import type { DragMode, DragState, GridMetrics } from './layoutDrag'
import {
  NOTICE_BIND_TAB_REQUIRED,
  NOTICE_CAPTURE_TIMEOUT_INVALID,
  NOTICE_INTERVAL_INVALID,
  NOTICE_NONE,
  NOTICE_SCROLL_CAPTURE_INTERVAL_INVALID,
  NOTICE_STALE_TABS,
  NOTICE_TAB_REQUIRED,
  NOTICE_URL_REQUIRED,
  browserTabLabel,
  diagnosticsScopeLabel,
  dropNotice,
  durationSpreadLabel,
  failureNotice,
  gridClassName,
  openedTabsNotice,
  recordLogLabel,
  toggleClassName,
  toggleLabel,
  workerStartsLabel,
} from './screenText'
import { buildTileViews, gridArea, parseTileSettings, tileSettingsDraftError } from './tileView'
import type { TileSettingsDraft, TileViewModel } from './tileView'

//+_+// 4x4 를 항상 보이게 하는 빈 칸이다. 타일과 같은 좌표 계산을 쓴다
const GRID_SLOTS = Array.from({ length: GRID_ROWS * GRID_COLUMNS }, (_unused, index) => {
  const y = Math.floor(index / GRID_COLUMNS)
  const x = index % GRID_COLUMNS
  return { key: `slot-${String(index)}`, area: gridArea({ x, y, w: 1, h: 1 }) }
})

function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

//+_+// gap 과 padding 은 theme.css 의 token 이 정한다. 값을 TS 에 복제하지 않고 계산된 스타일에서 읽는다
//+_+// 셀 계산은 padding 안쪽 상자를 기준으로 한다. getBoundingClientRect 는 padding 을 포함한다
function gridMetrics(element: HTMLElement): GridMetrics {
  const box = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const left = px(style.paddingLeft)
  const top = px(style.paddingTop)
  return {
    left: box.left + left,
    top: box.top + top,
    width: box.width - left - px(style.paddingRight),
    height: box.height - top - px(style.paddingBottom),
    gap: px(style.columnGap),
  }
}

export interface AppProps {
  //+_+// P8-D18. URL 이 정한 프로젝트다. main.tsx 가 읽어 넘긴다. 화면이 전환하지 않는다
  projectId: string
}

export function App({ projectId }: AppProps): React.JSX.Element {
  const [views, setViews] = useState<TileViewModel[]>([])
  const [tiles, setTiles] = useState<WebTile[]>([])
  //+_+// 8-2.3 8번. 어느 프로젝트를 보는 화면인지 툴바가 밝힌다. 값은 폴링 응답에서만 온다
  const [projectName, setProjectName] = useState('')
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([])
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null)
  const [tileUrl, setTileUrl] = useState('')
  const [editing, setEditing] = useState(false)
  //+_+// P9-D17. Edit Layout(editing) 과 다른 개념이다. 같은 변수로 묶지 않는다
  const [isToolbarExpanded, setIsToolbarExpanded] = useState(false)
  //+_+// P6-D47. 정본은 워커다. 화면은 폴링 응답이 알려 준 값을 그린다
  const [paused, setPaused] = useState(false)
  //+_+// P6-D9. 열려 있는 동안만 읽는다. 닫혀 있으면 요청을 보내지 않는다
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  //+_+// P7-D62. v1 section 15.4. 화면에서만 산다. 저장하지 않으므로 다시 열면 꺼져 있다
  const [privacy, setPrivacy] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [notice, setNotice] = useState('')
  const gridRef = useRef<HTMLElement | null>(null)

  //+_+// P4-D7. 폴링 1개가 프로젝트 상태와 프레임을 함께 가져온다
  //+_+// P4-D11. 표시 상태를 같은 요청에 싣는다
  const poll = useCallback(async () => {
    const response = await fetchProjectState(projectId, isDashboardVisible())
    if (!response.ok) {
      //+_+// 8-2.3 4번. 이 탭은 URL 로 프로젝트에 묶여 있어 따라갈 곳이 없다. 허브로 보낸다
      //+_+// 허브에서 지운 프로젝트를 보고 있던 탭이 그 경우다
      if (response.errorCode === 'PROJECT_NOT_FOUND') {
        window.location.replace(`./${HUB_PAGE}`)
        return
      }
      setNotice(failureNotice(response))
      return
    }
    if (response.type !== 'GET_PROJECT_STATE') {
      return
    }
    setTiles(response.project.tiles)
    setPaused(response.previewPaused)
    //+_+// 8-2.3 8번. 탭 이름이 프로젝트를 가른다. 탭이 여럿이면 이것이 유일한 구별 수단이다
    //+_+// 첫 폴링 전에는 dashboard.html 의 <title> 인 WebDeck 이다. 별도 갱신 경로를 만들지 않는다
    setProjectName(response.project.name)
    document.title = `WebDeck - ${response.project.name}`
    setViews(buildTileViews(response.project, response.runtimeStates, response.frames))
  }, [projectId])

  useEffect(() => {
    void poll()
    const handle: ReturnType<typeof setInterval> = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(handle)
    }
  }, [poll])

  //+_+// P5-D9. L35 를 닫는다. 표시 상태가 바뀌면 다음 폴링을 기다리지 않고 즉시 1회 보낸다
  //+_+// 주기 자체는 바꾸지 않는다. P4-D7 의 2000ms 그대로다
  //+_+// 판정 권위는 워커다. 화면은 폴링에 dashboardVisible 을 실어 보낼 뿐이다. P4-D11
  useEffect(() => {
    const gate = createVisibilityGate(isDashboardVisible())
    const notify = (): void => {
      if (gate.changed(isDashboardVisible())) {
        void poll()
      }
    }
    document.addEventListener('visibilitychange', notify)
    return () => {
      document.removeEventListener('visibilitychange', notify)
    }
  }, [poll])

  //+_+// P5-D12. 워커가 모든 창의 탭을 돌려준다. 목록은 시간이 지나면 낡으므로 다시 읽을 수 있게 둔다
  //+_+// 성공 여부를 돌려준다. 안내를 지울지는 부르는 쪽이 정한다
  //+_+// 여기서 지우면 openMissing 이 방금 남긴 N tabs opened 를 뒤따르는 loadTabs 가 지운다. J120
  const loadTabs = useCallback(async (): Promise<boolean> => {
    const response = await listBrowserTabs()
    if (!response.ok) {
      setNotice(failureNotice(response))
      return false
    }
    if (response.type !== 'LIST_BROWSER_TABS') {
      return false
    }
    setTabs(response.tabs)
    setSelectedTabId((current) =>
      response.tabs.some((tab) => tab.tabId === current) ? current : (response.tabs[0]?.tabId ?? null),
    )
    return true
  }, [])

  //+_+// 탭 새로고침 버튼 전용이다. 사용자가 직접 부른 회차만 안내를 지운다
  const refreshTabs = useCallback(async () => {
    if (await loadTabs()) {
      setNotice(NOTICE_NONE)
    }
  }, [loadTabs])

  useEffect(() => {
    void loadTabs()
  }, [loadTabs])

  //+_+// P5-D30. 탭이 사라졌다는 실패는 화면이 아는 목록이 낡았다는 뜻이다. 오류로 표시하지 않는다
  const reportFailure = useCallback(
    async (response: DashboardResponse) => {
      if (isStaleTabFailure(response)) {
        setNotice(NOTICE_STALE_TABS)
        await loadTabs()
        return
      }
      if (!response.ok) {
        setNotice(failureNotice(response))
      }
    },
    [loadTabs],
  )

  //+_+// v1 section 9.1 의 (a) 경로다. 기존 탭을 걸기만 한다. reload 도 창 이동도 하지 않는다
  const addTileFromTab = useCallback(async () => {
    if (selectedTabId === null) {
      setNotice(NOTICE_TAB_REQUIRED)
      return
    }
    //+_+// WEBDECK_PLAN 8-2.3 1번. 대상 프로젝트를 요청에 싣는다
    //+_+// 첫 LIST_PROJECTS 응답 전에는 실을 값이 없다. poll 과 같은 규칙으로 아무것도 하지 않는다
    const response = await addTile(projectId, { kind: 'tab', tabId: selectedTabId })
    if (!response.ok) {
      await reportFailure(response)
      return
    }
    setNotice(NOTICE_NONE)
    await poll()
  }, [poll, projectId, reportFailure, selectedTabId])

  //+_+// v1 section 9.4 의 세 버튼이다. Reopen 과 Bind 가 fault 를 지우는 명시 경로다
  const reopen = useCallback(
    async (tileId: string) => {
      const response = await reopenTile(tileId)
      if (!response.ok) {
        await reportFailure(response)
        return
      }
      setNotice(NOTICE_NONE)
      await poll()
      await loadTabs()
    },
    [loadTabs, poll, reportFailure],
  )

  //+_+// 탭 선택은 툴바의 목록을 그대로 쓴다. 별도 다이얼로그를 만들지 않는다. J86 선례
  const bindExisting = useCallback(
    async (tileId: string) => {
      if (selectedTabId === null) {
        setNotice(NOTICE_BIND_TAB_REQUIRED)
        return
      }
      //+_+// WEBDECK_PLAN 8-2.3 1번. BIND_TILE 은 모르는 tileId 면 타일을 만든다
      //+_+// 그래서 어느 프로젝트에 만들지를 함께 보낸다 (P4-D2)
      const response = await bindTile(projectId, tileId, selectedTabId)
      if (!response.ok) {
        await reportFailure(response)
        return
      }
      setNotice(NOTICE_NONE)
      await poll()
    },
    [poll, projectId, reportFailure, selectedTabId],
  )

  //+_+// P5-D6. v1 section 14 의 Refresh Preview 다. 응답의 프레임을 직접 그리지 않고 폴링에 맡긴다
  //+_+// 워커가 최신 프레임을 이미 들고 있으므로 다음 상태 응답이 같은 것을 나른다. J126
  //+_+// P9-D8. 대상은 팝오버를 연 타일 자신이 넘긴다. 페이지 차원의 selectedTileId 가 없다
  const refreshPreview = useCallback(
    async (tileId: string) => {
      const response = await captureTile(tileId)
      if (!response.ok) {
        await reportFailure(response)
        return
      }
      setNotice(NOTICE_NONE)
      await poll()
    },
    [poll, reportFailure],
  )

  //+_+// v1 section 14 의 Reload Page 다. refreshPreview 와 같은 형태이며 대상도 같다
  //+_+// 캡처를 부르지 않는다. 다음 예정 캡처가 재적재된 화면을 가져온다
  const reloadPage = useCallback(
    async (tileId: string) => {
      const response = await reloadTile(tileId)
      if (!response.ok) {
        await reportFailure(response)
        return
      }
      setNotice(NOTICE_NONE)
    },
    [reportFailure],
  )

  //+_+// v1 section 10 의 6단계다. 열린 탭 수만큼 알리고 0건이면 그것도 알린다
  const openMissing = useCallback(async () => {
    //+_+// WEBDECK_PLAN 8-2.3 1번. 대상 프로젝트를 요청에 싣는다
    //+_+// 첫 LIST_PROJECTS 응답 전에는 실을 값이 없다. poll 과 같은 규칙으로 아무것도 하지 않는다
    const response = await openMissingTabs(projectId)
    if (!response.ok) {
      await reportFailure(response)
      return
    }
    if (response.type !== 'OPEN_MISSING_TABS') {
      return
    }
    setNotice(openedTabsNotice(response.openedTileIds.length))
    await poll()
    await loadTabs()
  }, [loadTabs, poll, projectId, reportFailure])

  const remove = useCallback(
    async (tileId: string) => {
      const response = await removeTile(tileId)
      if (!response.ok) {
        await reportFailure(response)
        return
      }
      setNotice(NOTICE_NONE)
      await poll()
    },
    [poll, reportFailure],
  )

  //+_+// v1 section 9.1 의 (b) 경로다. 탭 생성은 워커가 한다. 화면은 chrome.* 를 부르지 않는다
  const addTileFromUrl = useCallback(async () => {
    const url = tileUrl.trim()
    if (url.length === 0) {
      setNotice(NOTICE_URL_REQUIRED)
      return
    }
    //+_+// WEBDECK_PLAN 8-2.3 1번. 대상 프로젝트를 요청에 싣는다
    //+_+// 첫 LIST_PROJECTS 응답 전에는 실을 값이 없다. poll 과 같은 규칙으로 아무것도 하지 않는다
    const response = await addTile(projectId, { kind: 'url', url })
    if (!response.ok) {
      setNotice(failureNotice(response))
      return
    }
    setTileUrl('')
    setNotice(NOTICE_NONE)
    await poll()
    await loadTabs()
  }, [loadTabs, poll, projectId, tileUrl])

  //+_+// P5-D31. 6필드 전체 교체다. 값이 규칙에 맞지 않으면 보내지 않는다. 판정 권위는 워커다
  //+_+// P9-D8. draft 는 팝오버를 연 타일이 자기 지역 상태로 들고, 여기엔 tileId 와 함께 넘어온다
  const applySettings = useCallback(
    async (tileId: string, draft: TileSettingsDraft) => {
      const parsed = parseTileSettings(draft)
      if (parsed === null) {
        const invalidField = tileSettingsDraftError(draft)
        setNotice(
          invalidField === 'captureTimeout'
            ? NOTICE_CAPTURE_TIMEOUT_INVALID
            : invalidField === 'scrollCaptureInterval'
              ? NOTICE_SCROLL_CAPTURE_INTERVAL_INVALID
              : NOTICE_INTERVAL_INVALID,
        )
        return
      }
      const response = await setTileSettings(tileId, parsed)
      if (!response.ok) {
        setNotice(failureNotice(response))
        return
      }
      setNotice(NOTICE_NONE)
      await poll()
    },
    [poll],
  )

  //+_+// v1 section 7.1. 더블클릭이 실제 탭으로 간다. 활성화는 워커가 한다
  const focus = useCallback(async (tileId: string) => {
    const response = await focusTile(tileId)
    if (!response.ok) {
      setNotice(failureNotice(response))
      return
    }
    setNotice(NOTICE_NONE)
  }, [])

  const cellAt = useCallback((event: React.PointerEvent): GridPosition | null => {
    const element = gridRef.current
    if (element === null) {
      return null
    }
    return pointerToCell(event.clientX, event.clientY, gridMetrics(element))
  }, [])

  //+_+// Pointer Capture 를 잡는다. 그러지 않으면 커서가 타일을 벗어나는 순간 move 가 끊긴다
  const startDrag = useCallback(
    (tileId: string, mode: DragMode, event: React.PointerEvent) => {
      const tile = tiles.find((item) => item.id === tileId)
      const cell = cellAt(event)
      if (tile === undefined || cell === null) {
        return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      setDrag(beginDrag(tile, mode, cell))
    },
    [cellAt, tiles],
  )

  const moveDrag = useCallback(
    (event: React.PointerEvent) => {
      const cell = cellAt(event)
      if (cell === null) {
        return
      }
      setDrag((current) => (current === null ? null : dragTo(current, cell, tiles)))
    },
    [cellAt, tiles],
  )

  //+_+// v1 section 7.2. 무효한 Drop 은 아무것도 요청하지 않는다. 타일은 원래 자리에 그대로 있다
  //+_+// P4-D12. 유효해 보이는 Drop 도 워커가 다시 판정한다. 거절되면 화면은 그대로 되돌아간다
  const endDrag = useCallback(async () => {
    if (drag === null) {
      return
    }
    const rect = dropRect(drag)
    setDrag(null)
    if (rect === null) {
      setNotice(dropNotice(drag.valid))
      return
    }
    const response = await setTileRect(drag.tileId, rect)
    if (!response.ok) {
      setNotice(failureNotice(response))
      return
    }
    setNotice(NOTICE_NONE)
    await poll()
  }, [drag, poll])

  //+_+// F1. 브라우저가 포인터를 가져가면 pointerup 대신 이것이 온다. 이동 상태를 여기서 끝낸다
  //+_+// 아무것도 요청하지 않는다. 취소된 이동은 원래 자리로 되돌아가는 것이 맞다
  const cancelDrag = useCallback(() => {
    setDrag(null)
  }, [])

  const toggleEditing = useCallback(() => {
    setDrag(null)
    setEditing((current) => !current)
  }, [])

  //+_+// P6-D47. 다음 폴링이 워커의 값으로 덮는다. 화면이 상태를 스스로 정하지 않는다
  const togglePaused = useCallback(async () => {
    const response = await setPreviewPaused(!paused)
    if (!response.ok) {
      setNotice(failureNotice(response))
      return
    }
    setNotice(NOTICE_NONE)
    await poll()
  }, [paused, poll])

  //+_+// P6-D9. 값은 워커가 만든다. 화면은 받아 그리기만 한다. 계측 키를 화면이 읽지 않는다
  const loadDiagnostics = useCallback(async () => {
    const response = await fetchDiagnostics()
    if (!response.ok) {
      setNotice(failureNotice(response))
      return
    }
    if (response.type !== 'GET_DIAGNOSTICS') {
      return
    }
    setNotice(NOTICE_NONE)
    setDiagnostics(response.diagnostics)
  }, [])

  //+_+// 열려 있는 동안만 폴링에 얹는다. 닫으면 값을 버려 낡은 수치가 다시 열릴 때 비치지 않게 한다
  useEffect(() => {
    if (!showDiagnostics) {
      setDiagnostics(null)
      return undefined
    }
    void loadDiagnostics()
    const handle: ReturnType<typeof setInterval> = setInterval(() => {
      void loadDiagnostics()
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(handle)
    }
  }, [loadDiagnostics, showDiagnostics])

  const toggleDiagnostics = useCallback(() => {
    setShowDiagnostics((current) => !current)
  }, [])

  //+_+// P7-D62. 캡처를 멈추지 않는다. 워커에 알리지 않으므로 주기도 상태도 그대로다
  const togglePrivacy = useCallback(() => {
    setPrivacy((current) => !current)
  }, [])

  //+_+// P9-D17. 화면에서만 산다. Privacy 와 같은 성질이다. 저장하지 않는다
  const toggleToolbarExpanded = useCallback(() => {
    setIsToolbarExpanded((current) => !current)
  }, [])

  const indicator = dropIndicator(drag)

  return (
    <div className="app">
      <header className="toolbar">
        <span className="toolbar-title">WebDeck</span>
        <span className="toolbar-project">{projectName}</span>
        <span className="toolbar-count">tiles {views.length}</span>
        <span className="toolbar-spacer" />
        <button
          type="button"
          className={toggleClassName(editing)}
          onClick={toggleEditing}
        >
          {toggleLabel('Edit Layout', editing)}
        </button>
        <button
          type="button"
          className={toggleClassName(paused)}
          onClick={() => void togglePaused()}
        >
          {toggleLabel('Pause Preview', paused)}
        </button>
        <button
          type="button"
          className={toggleClassName(privacy)}
          onClick={togglePrivacy}
        >
          {toggleLabel('Privacy', privacy)}
        </button>
        <button
          type="button"
          className={toggleClassName(isToolbarExpanded)}
          aria-expanded={isToolbarExpanded}
          onClick={toggleToolbarExpanded}
        >
          {toggleLabel('More', isToolbarExpanded)}
        </button>
      </header>

      <section className={isToolbarExpanded ? 'toolbar-panel toolbar-panel--open' : 'toolbar-panel'}>
        <button
          type="button"
          className={toggleClassName(showDiagnostics)}
          onClick={toggleDiagnostics}
        >
          {toggleLabel('Diagnostics', showDiagnostics)}
        </button>
        <select
          className="toolbar-select"
          value={selectedTabId === null ? '' : String(selectedTabId)}
          onChange={(event) => {
            setSelectedTabId(event.target.value === '' ? null : Number(event.target.value))
          }}
        >
          <option value="">탭을 고른다</option>
          {tabs.map((tab) => (
            <option key={tab.tabId} value={String(tab.tabId)}>
              {browserTabLabel(tab)}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void refreshTabs()}>
          탭 새로고침
        </button>
        <button type="button" onClick={() => void addTileFromTab()}>
          Add Tab
        </button>
        <input
          className="toolbar-input"
          value={tileUrl}
          placeholder="https://"
          onChange={(event) => {
            setTileUrl(event.target.value)
          }}
        />
        <button type="button" onClick={() => void addTileFromUrl()}>
          Add URL
        </button>
        <button type="button" onClick={() => void openMissing()}>
          Open Missing Tabs
        </button>
      </section>

      {showDiagnostics && diagnostics !== null ? (
        <section className="diagnosticsbar">
          <span className="diagnosticsbar-note">
            {diagnosticsScopeLabel(diagnostics.sampleLimit)}
          </span>
          <span>
            회차 소요 최소 / 중간 / 최대 {durationSpreadLabel(diagnostics.roundDurationMs)}
          </span>
          <span>타임아웃 {diagnostics.timeouts}</span>
          <span>등록 타일 {diagnostics.registeredTiles}</span>
          <span>attach {diagnostics.attachedTabs}</span>
          <span>워커 기동 {workerStartsLabel(diagnostics.workerStarts)}</span>
          {diagnostics.recordLogs.map((log) => (
            <span key={log.name}>{recordLogLabel(log)}</span>
          ))}
        </section>
      ) : null}

      <main
        className={gridClassName(privacy)}
        ref={gridRef}
        style={{
          gridTemplateColumns: `repeat(${String(GRID_COLUMNS)}, 1fr)`,
          gridTemplateRows: `repeat(${String(GRID_ROWS)}, 1fr)`,
        }}
      >
        {GRID_SLOTS.map((slot) => (
          <div key={slot.key} className="grid-slot" style={{ gridArea: slot.area }} />
        ))}
        {views.flatMap((view) => {
          //+_+// P9-D8. 팝오버가 draft 를 채우려면 raw WebTile 이 필요하다. TileViewModel 엔 없다
          const tile = tiles.find((item) => item.id === view.tileId)
          if (tile === undefined) {
            return []
          }
          return [
            <TileCard
              key={view.tileId}
              view={view}
              tile={tile}
              editing={editing}
              dragClassName={dragClassName(drag, view.tileId)}
              onFocus={() => void focus(view.tileId)}
              onDragStart={(mode, event) => {
                startDrag(view.tileId, mode, event)
              }}
              onDragMove={moveDrag}
              onDragEnd={() => void endDrag()}
              onDragCancel={cancelDrag}
              onReopen={() => void reopen(view.tileId)}
              onBindExisting={() => void bindExisting(view.tileId)}
              onRemove={() => void remove(view.tileId)}
              onRefreshPreview={() => refreshPreview(view.tileId)}
              onReloadPage={() => void reloadPage(view.tileId)}
              onApplySettings={(draft) => void applySettings(view.tileId, draft)}
              onScroll={(deltaY, x, y) => void scrollTile(view.tileId, deltaY, x, y)}
            />,
          ]
        })}
        {indicator === null ? null : (
          <div className={indicator.className} style={{ gridArea: indicator.gridArea }} />
        )}
      </main>

      <footer className="statusbar">{notice}</footer>
    </div>
  )
}
