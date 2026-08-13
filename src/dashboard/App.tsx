import { useCallback, useEffect, useRef, useState } from 'react'
import { GRID_COLUMNS, GRID_ROWS } from '../shared/grid'
import type { GridPosition } from '../shared/grid'
import type { BrowserTabInfo, Project, WebTile } from '../shared/types'
import { TileCard } from './TileCard'
import {
  POLL_INTERVAL_MS,
  bindTile,
  createProject,
  deleteProject,
  fetchProjectState,
  focusTile,
  isDashboardVisible,
  listBrowserTabs,
  listProjects,
  newTileId,
  renameProject,
  setActiveProject,
  setTileRect,
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
import { buildTileViews, gridArea } from './tileView'
import type { TileViewModel } from './tileView'

//+_+// 4x4 를 항상 보이게 하는 빈 칸이다. 타일과 같은 좌표 계산을 쓴다
const GRID_SLOTS = Array.from({ length: GRID_ROWS * GRID_COLUMNS }, (_unused, index) => {
  const y = Math.floor(index / GRID_COLUMNS)
  const x = index % GRID_COLUMNS
  return { key: `slot-${String(index)}`, area: gridArea({ x, y, w: 1, h: 1 }) }
})

function tabLabel(tab: BrowserTabInfo): string {
  return `${String(tab.tabId)} · ${tab.title.length === 0 ? tab.currentUrl : tab.title}`
}

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

export function App(): React.JSX.Element {
  const [views, setViews] = useState<TileViewModel[]>([])
  const [tiles, setTiles] = useState<WebTile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([])
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null)
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [notice, setNotice] = useState('')
  const gridRef = useRef<HTMLElement | null>(null)

  //+_+// P5-D22. 활성 프로젝트 id 는 워커가 정본이다. 화면은 목록을 읽어 따라간다
  const loadProjects = useCallback(async () => {
    const response = await listProjects()
    if (!response.ok) {
      setNotice(`${response.errorCode}: ${response.message}`)
      return
    }
    if (response.type !== 'LIST_PROJECTS') {
      return
    }
    setProjects(response.projects)
    setActiveProjectId(response.activeProjectId)
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  //+_+// P4-D7. 폴링 1개가 프로젝트 상태와 프레임을 함께 가져온다
  //+_+// P4-D11. 표시 상태를 같은 요청에 싣는다
  const poll = useCallback(async () => {
    if (activeProjectId === null) {
      return
    }
    const response = await fetchProjectState(activeProjectId, isDashboardVisible())
    if (!response.ok) {
      //+_+// 워커의 활성 프로젝트가 화면이 아는 것과 다르다. 목록을 다시 읽어 따라간다
      if (response.errorCode === 'PROJECT_NOT_FOUND') {
        await loadProjects()
        return
      }
      setNotice(`${response.errorCode}: ${response.message}`)
      return
    }
    if (response.type !== 'GET_PROJECT_STATE') {
      return
    }
    setTiles(response.project.tiles)
    setViews(buildTileViews(response.project, response.runtimeStates, response.frames))
  }, [activeProjectId, loadProjects])

  useEffect(() => {
    void poll()
    const handle: ReturnType<typeof setInterval> = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(handle)
    }
  }, [poll])

  //+_+// 전환 직후의 한 폴링 동안 이전 프로젝트의 타일이 남지 않게 비운다
  const switchProject = useCallback(
    async (projectId: string) => {
      const response = await setActiveProject(projectId)
      if (!response.ok) {
        setNotice(`${response.errorCode}: ${response.message}`)
        return
      }
      setTiles([])
      setViews([])
      await loadProjects()
    },
    [loadProjects],
  )

  //+_+// J82. 생성은 생성만 한다. 만든 프로젝트로 옮기는 것은 화면이 이어서 요청한다
  const addProject = useCallback(async () => {
    const name = projectName.trim()
    if (name.length === 0) {
      setNotice('프로젝트 이름을 입력한다')
      return
    }
    const response = await createProject(name)
    if (!response.ok) {
      setNotice(`${response.errorCode}: ${response.message}`)
      return
    }
    if (response.type !== 'CREATE_PROJECT') {
      return
    }
    setProjectName('')
    await switchProject(response.project.id)
  }, [projectName, switchProject])

  const renameActiveProject = useCallback(async () => {
    const name = projectName.trim()
    if (activeProjectId === null || name.length === 0) {
      setNotice('바꿀 이름을 입력한다')
      return
    }
    const response = await renameProject(activeProjectId, name)
    if (!response.ok) {
      setNotice(`${response.errorCode}: ${response.message}`)
      return
    }
    setProjectName('')
    await loadProjects()
  }, [activeProjectId, loadProjects, projectName])

  //+_+// P5-D23. 마지막 하나여도 워커가 거부하지 않는다. 기본 프로젝트가 다시 선다
  const removeActiveProject = useCallback(async () => {
    if (activeProjectId === null) {
      return
    }
    const response = await deleteProject(activeProjectId)
    if (!response.ok) {
      setNotice(`${response.errorCode}: ${response.message}`)
      return
    }
    setTiles([])
    setViews([])
    await loadProjects()
  }, [activeProjectId, loadProjects])

  const loadTabs = useCallback(async () => {
    const response = await listBrowserTabs()
    if (!response.ok) {
      setNotice(`${response.errorCode}: ${response.message}`)
      return
    }
    if (response.type !== 'LIST_BROWSER_TABS') {
      return
    }
    setTabs(response.tabs)
    setSelectedTabId(response.tabs[0]?.tabId ?? null)
    setNotice(`${String(response.tabs.length)} tabs listed`)
  }, [])

  //+_+// P4-D2 의 개발 전용 바인딩이다. Phase 5 에서 v1 section 9.1 구현과 함께 지운다
  const addTile = useCallback(async () => {
    if (selectedTabId === null) {
      setNotice('먼저 dev 탭 목록에서 탭을 고른다')
      return
    }
    const response = await bindTile(newTileId(), selectedTabId)
    if (!response.ok) {
      setNotice(`${response.errorCode}: ${response.message}`)
      return
    }
    setNotice(`tab ${String(selectedTabId)} bound`)
    await poll()
  }, [poll, selectedTabId])

  //+_+// v1 section 7.1. 더블클릭이 실제 탭으로 간다. 활성화는 워커가 한다
  const focus = useCallback(async (tileId: string) => {
    const response = await focusTile(tileId)
    if (!response.ok) {
      setNotice(`${response.errorCode}: ${response.message}`)
    }
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
      setNotice(drag.valid ? '' : '그 자리에는 놓을 수 없다. 원래 자리로 되돌린다')
      return
    }
    const response = await setTileRect(drag.tileId, rect)
    if (!response.ok) {
      setNotice(`${response.errorCode}: ${response.message}`)
      return
    }
    setNotice('')
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

  const indicator = dropIndicator(drag)

  return (
    <div className="app">
      <header className="toolbar">
        <span className="toolbar-title">WebDeck</span>
        <select
          className="toolbar-select"
          value={activeProjectId ?? ''}
          onChange={(event) => void switchProject(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <input
          className="toolbar-input"
          value={projectName}
          placeholder="프로젝트 이름"
          onChange={(event) => {
            setProjectName(event.target.value)
          }}
        />
        <button type="button" onClick={() => void addProject()}>
          New
        </button>
        <button type="button" onClick={() => void renameActiveProject()}>
          Rename
        </button>
        <button type="button" onClick={() => void removeActiveProject()}>
          Delete
        </button>
        <span className="toolbar-count">tiles {views.length}</span>
        <span className="toolbar-spacer" />
        <button
          type="button"
          className={editing ? 'toolbar-toggle toolbar-toggle--on' : 'toolbar-toggle'}
          onClick={toggleEditing}
        >
          {editing ? 'Edit Layout · on' : 'Edit Layout'}
        </button>
        <button type="button" onClick={() => void loadTabs()}>
          dev · list tabs
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
              {tabLabel(tab)}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void addTile()}>
          dev · add tile
        </button>
      </header>

      <main
        className="grid"
        ref={gridRef}
        style={{
          gridTemplateColumns: `repeat(${String(GRID_COLUMNS)}, 1fr)`,
          gridTemplateRows: `repeat(${String(GRID_ROWS)}, 1fr)`,
        }}
      >
        {GRID_SLOTS.map((slot) => (
          <div key={slot.key} className="grid-slot" style={{ gridArea: slot.area }} />
        ))}
        {views.map((view) => (
          <TileCard
            key={view.tileId}
            view={view}
            selected={view.tileId === selectedTileId}
            editing={editing}
            dragClassName={dragClassName(drag, view.tileId)}
            onSelect={() => {
              setSelectedTileId(view.tileId)
            }}
            onFocus={() => void focus(view.tileId)}
            onDragStart={(mode, event) => {
              startDrag(view.tileId, mode, event)
            }}
            onDragMove={moveDrag}
            onDragEnd={() => void endDrag()}
            onDragCancel={cancelDrag}
          />
        ))}
        {indicator === null ? null : (
          <div className={indicator.className} style={{ gridArea: indicator.gridArea }} />
        )}
      </main>

      <footer className="statusbar">{notice}</footer>
    </div>
  )
}
