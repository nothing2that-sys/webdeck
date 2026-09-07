import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/dashboard/App'
import type { DashboardRequest, DashboardResponse } from '../src/shared/messages'
import type { Project, TileRuntimeState, TileStatus, WebTile } from '../src/shared/types'

//+_+// TASK-P9-04 (P9-D8~D13). settingsbar 를 걷어내고 타일마다 자기 톱니·팝오버로 옮긴 뒤의
//+_+// 동작을 고정한다. 톱니는 항상 DOM 에 있고(P9-D11), 팝오버는 그 타일 자신의 값으로 열린다

function tile(overrides: Partial<WebTile> & Pick<WebTile, 'id'>): WebTile {
  return {
    launchUrl: `https://example.com/${overrides.id}`,
    matchMode: 'origin',
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    refreshIntervalMs: 4000,
    fitMode: 'contain',
    keepAlive: false,
    ...overrides,
  }
}

const TILE_A = tile({
  id: 't.a',
  x: 0,
  y: 0,
  customTitle: 'A 별칭',
  matchMode: 'prefix',
  refreshIntervalOverrideMs: 5000,
  //+_+// TASK-P12-04 (S2). 팝오버가 이 값을 채워 보여주는지를 아래 테스트가 확인한다
  captureTimeoutOverrideMs: 3000,
})
const TILE_B = tile({ id: 't.b', x: 1, y: 0 })
//+_+// TASK-P9-04-R1 (P9-D15). x + w >= GRID_COLUMNS(4) 인 맨 오른쪽 열이다. flip 시험 대상
//+_+// STALE 로 둬 P9-D16 의 "LIVE 아니면 tile-foot 이 있다" 도 같은 타일로 시험한다
const TILE_C = tile({ id: 't.c', x: 3, y: 0 })

function project(tiles: WebTile[]): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    gridColumns: 4,
    gridRows: 4,
    keepManagedTabsAlive: false,
    tiles,
  }
}

function runtimeState(tileId: string, status: TileStatus = 'LIVE'): TileRuntimeState {
  return { tileId, status, consecutiveCaptureFailures: 0 }
}

let sent: DashboardRequest[] = []

function answer(request: DashboardRequest): DashboardResponse {
  sent.push(request)
  switch (request.type) {
    case 'GET_PROJECT_STATE':
      return {
        ok: true,
        type: 'GET_PROJECT_STATE',
        project: project([TILE_A, TILE_B, TILE_C]),
        runtimeStates: [runtimeState(TILE_A.id), runtimeState(TILE_B.id), runtimeState(TILE_C.id, 'STALE')],
        frames: [],
        previewPaused: false,
      }
    case 'LIST_BROWSER_TABS':
      return { ok: true, type: 'LIST_BROWSER_TABS', tabs: [] }
    case 'CAPTURE_TILE':
      return { ok: true, type: 'CAPTURE_TILE', imageBase64: '', format: 'jpeg', bytes: 0 }
    case 'RELOAD_TILE':
      return { ok: true, type: 'RELOAD_TILE' }
    case 'SET_TILE_SETTINGS':
      return { ok: true, type: 'SET_TILE_SETTINGS' }
    case 'REMOVE_TILE':
      return { ok: true, type: 'REMOVE_TILE' }
    default:
      return { ok: false, type: request.type, errorCode: 'SEND_FAILED', message: 'not stubbed' }
  }
}

beforeEach(() => {
  sent = []
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: (request: DashboardRequest): Promise<DashboardResponse> =>
        Promise.resolve(answer(request)),
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

//+_+// 톱니가 뜨는 것을 렌더 완료 신호로 쓴다. P9-D11 이 hover 없이도 DOM 에 있기를 요구하므로
//+_+// 이 신호를 기다리는 것 자체가 그 요구를 시험하는 셈이다
async function renderApp(): Promise<HTMLElement[]> {
  render(<App projectId="p1" />)
  return screen.findAllByRole('button', { name: '타일 설정 열기' })
}

function articleFor(launchUrl: string): HTMLElement {
  const titled = screen.getByTitle(launchUrl)
  const article = titled.closest('article')
  if (article === null) {
    throw new Error(`no tile article for ${launchUrl}`)
  }
  return article
}

//+_+// Apply 는 열린 팝오버 안에서 유일하다. 그 조상을 타면 지금 열린 팝오버를 정확히 짚는다
function openPopover(): HTMLElement {
  const popover = screen.getByRole('button', { name: 'Apply' }).closest('.tile-settings-popover')
  if (!(popover instanceof HTMLElement)) {
    throw new Error('no open settings popover')
  }
  return popover
}

describe('TASK-P9-04 - the gear is always in the DOM', () => {
  it('renders one gear per tile without hovering', async () => {
    const gears = await renderApp()
    expect(gears).toHaveLength(3)
  })
})

describe('TASK-P9-04 - opening the popover', () => {
  it('opens the popover for the clicked tile and fills the fields with its stored values', async () => {
    const user = userEvent.setup()
    const gears = await renderApp()
    await user.click(gears[0])
    expect(screen.getByDisplayValue('A 별칭')).not.toBeNull()
    expect(screen.getByDisplayValue('5000')).not.toBeNull()
    //+_+// TASK-P12-04 (S2). captureTimeoutOverrideMs 항목이다. refreshIntervalOverrideMs 바로 아래다
    expect(screen.getByDisplayValue('3000')).not.toBeNull()
  })
})

describe('TASK-P9-04 - Apply targets the exact tile', () => {
  it('sends SET_TILE_SETTINGS for the tile whose popover is open, not the other one', async () => {
    const user = userEvent.setup()
    const gears = await renderApp()
    await user.click(gears[1])
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => {
      expect(
        sent.some((request) => request.type === 'SET_TILE_SETTINGS' && request.tileId === TILE_B.id),
      ).toBe(true)
    })
    expect(
      sent.some((request) => request.type === 'SET_TILE_SETTINGS' && request.tileId === TILE_A.id),
    ).toBe(false)
  })
})

//+_+// TASK-P12-04 (S2). 화면이 이 필드를 있는 그대로 실어 보내는지 -- 프로토콜 값 자체를 확인한다
describe('TASK-P12-04 (S2) - Apply carries the capture timeout override', () => {
  it('carries the stored value unchanged when nothing was edited', async () => {
    const user = userEvent.setup()
    const gears = await renderApp()
    await user.click(gears[0])
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => {
      expect(
        sent.some(
          (request) =>
            request.type === 'SET_TILE_SETTINGS' &&
            request.tileId === TILE_A.id &&
            request.settings.captureTimeoutOverrideMs === 3000,
        ),
      ).toBe(true)
    })
  })

  it('clears the override when the field is emptied', async () => {
    const user = userEvent.setup()
    const gears = await renderApp()
    await user.click(gears[0])
    await user.clear(screen.getByDisplayValue('3000'))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => {
      expect(
        sent.some(
          (request) =>
            request.type === 'SET_TILE_SETTINGS' &&
            request.tileId === TILE_A.id &&
            request.settings.captureTimeoutOverrideMs === null,
        ),
      ).toBe(true)
    })
  })
})

describe('TASK-P9-04 - Remove Tile targets the exact tile', () => {
  it('sends REMOVE_TILE for the tile whose popover is open', async () => {
    const user = userEvent.setup()
    const gears = await renderApp()
    await user.click(gears[1])
    await user.click(screen.getByRole('button', { name: 'Remove Tile' }))
    await waitFor(() => {
      expect(sent.some((request) => request.type === 'REMOVE_TILE' && request.tileId === TILE_B.id)).toBe(
        true,
      )
    })
  })
})

describe('TASK-P9-04 - closing the popover (P9-D12)', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const gears = await renderApp()
    await user.click(gears[0])
    expect(screen.getByRole('button', { name: 'Apply' })).not.toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('closes on an outside click', async () => {
    const user = userEvent.setup()
    const gears = await renderApp()
    await user.click(gears[0])
    expect(screen.getByRole('button', { name: 'Apply' })).not.toBeNull()
    await user.click(screen.getByText('WebDeck'))
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })
})

describe('TASK-P9-04-R1 - the popover flips at the rightmost column (P9-D15)', () => {
  it('does not flip for a tile that is not in the rightmost column', async () => {
    const user = userEvent.setup()
    const gears = await renderApp()
    await user.click(gears[0])
    expect(openPopover().classList.contains('tile-settings-popover--flip')).toBe(false)
  })

  it('flips for a tile whose x + w reaches GRID_COLUMNS', async () => {
    const user = userEvent.setup()
    const gears = await renderApp()
    await user.click(gears[2])
    expect(openPopover().classList.contains('tile-settings-popover--flip')).toBe(true)
  })
})

describe('TASK-P9-04-R1 - tile-foot only shows for non-LIVE tiles (P9-D16)', () => {
  it('hides tile-foot for a LIVE tile', async () => {
    await renderApp()
    //+_+// TILE_A 는 customTitle 이 있어 title 속성이 launchUrl 이 아니라 그 별칭이다
    expect(articleFor('A 별칭').querySelector('.tile-foot')).toBeNull()
  })

  it('shows tile-foot for a non-LIVE tile', async () => {
    await renderApp()
    expect(articleFor(TILE_C.launchUrl).querySelector('.tile-foot')).not.toBeNull()
  })
})
