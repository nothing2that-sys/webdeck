import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/dashboard/App'
import type { DashboardRequest, DashboardResponse } from '../src/shared/messages'
import type { Project, TileRuntimeState, WebTile } from '../src/shared/types'

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
})
const TILE_B = tile({ id: 't.b', x: 1, y: 0 })

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

function runtimeState(tileId: string): TileRuntimeState {
  return { tileId, status: 'LIVE', consecutiveCaptureFailures: 0 }
}

let sent: DashboardRequest[] = []

function answer(request: DashboardRequest): DashboardResponse {
  sent.push(request)
  switch (request.type) {
    case 'GET_PROJECT_STATE':
      return {
        ok: true,
        type: 'GET_PROJECT_STATE',
        project: project([TILE_A, TILE_B]),
        runtimeStates: [runtimeState(TILE_A.id), runtimeState(TILE_B.id)],
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

describe('TASK-P9-04 - the gear is always in the DOM', () => {
  it('renders one gear per tile without hovering', async () => {
    const gears = await renderApp()
    expect(gears).toHaveLength(2)
  })
})

describe('TASK-P9-04 - opening the popover', () => {
  it('opens the popover for the clicked tile and fills the fields with its stored values', async () => {
    const user = userEvent.setup()
    const gears = await renderApp()
    await user.click(gears[0])
    expect(screen.getByDisplayValue('A 별칭')).not.toBeNull()
    expect(screen.getByDisplayValue('5000')).not.toBeNull()
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
