import { useCallback, useEffect, useState } from 'react'
import { GRID_COLUMNS, GRID_ROWS } from '../shared/grid'
import type { BrowserTabInfo } from '../shared/types'
import { TileCard } from './TileCard'
import {
  POLL_INTERVAL_MS,
  bindTile,
  fetchProjectState,
  isDashboardVisible,
  listBrowserTabs,
  newTileId,
} from './dashboardService'
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

export function App(): React.JSX.Element {
  const [views, setViews] = useState<TileViewModel[]>([])
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([])
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null)
  const [notice, setNotice] = useState('')

  //+_+// P4-D7. 폴링 1개가 프로젝트 상태와 프레임을 함께 가져온다
  const poll = useCallback(async () => {
    const response = await fetchProjectState(isDashboardVisible())
    if (!response.ok) {
      setNotice(`${response.errorCode}: ${response.message}`)
      return
    }
    if (response.type !== 'GET_PROJECT_STATE') {
      return
    }
    setViews(buildTileViews(response.project, response.runtimeStates, response.frames))
  }, [])

  useEffect(() => {
    void poll()
    const handle: ReturnType<typeof setInterval> = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(handle)
    }
  }, [poll])

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

  return (
    <div className="app">
      <header className="toolbar">
        <span className="toolbar-title">WebDeck</span>
        <span className="toolbar-count">tiles {views.length}</span>
        <span className="toolbar-spacer" />
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
        style={{
          gridTemplateColumns: `repeat(${String(GRID_COLUMNS)}, 1fr)`,
          gridTemplateRows: `repeat(${String(GRID_ROWS)}, 1fr)`,
        }}
      >
        {GRID_SLOTS.map((slot) => (
          <div key={slot.key} className="grid-slot" style={{ gridArea: slot.area }} />
        ))}
        {views.map((view) => (
          <TileCard key={view.tileId} view={view} />
        ))}
      </main>

      <footer className="statusbar">{notice}</footer>
    </div>
  )
}
