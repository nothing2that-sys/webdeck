import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/dashboard/App'
import type { DashboardRequest, DashboardResponse } from '../src/shared/messages'
import type { Project } from '../src/shared/types'

//+_+// TASK-P9-05 (P9-D17~D20). 상시 바 여섯 개 + 펼침 패널로 나눈 뒤의 접힘/펼침을 고정한다
//+_+// 가로 스크롤 자체는 jsdom 이 레이아웃을 안 재므로 시험 대상이 아니다. §3 의 명시적 주의사항이다

function project(): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    gridColumns: 4,
    gridRows: 4,
    keepManagedTabsAlive: false,
    tiles: [],
  }
}

function answer(request: DashboardRequest): DashboardResponse {
  switch (request.type) {
    case 'GET_PROJECT_STATE':
      return {
        ok: true,
        type: 'GET_PROJECT_STATE',
        project: project(),
        runtimeStates: [],
        frames: [],
        previewPaused: false,
      }
    case 'LIST_BROWSER_TABS':
      return { ok: true, type: 'LIST_BROWSER_TABS', tabs: [] }
    default:
      return { ok: false, type: request.type, errorCode: 'SEND_FAILED', message: 'not stubbed' }
  }
}

beforeEach(() => {
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

async function renderApp(): Promise<void> {
  render(<App projectId="p1" />)
  await screen.findByText('Test Project')
}

//+_+// display:none/flex 는 theme.css 가 정하고 이 렌더 시험엔 스타일시트가 안 걸린다
//+_+// 열림 여부의 시험 가능한 신호는 toolbar-panel--open 클래스의 유무다
function panelElement(): Element {
  const panel = document.querySelector('.toolbar-panel')
  if (panel === null) {
    throw new Error('no .toolbar-panel in the document')
  }
  return panel
}

describe('TASK-P9-05 - the panel starts collapsed', () => {
  it('has no open modifier before the toggle is pressed', async () => {
    await renderApp()
    expect(panelElement().classList.contains('toolbar-panel--open')).toBe(false)
  })
})

describe('TASK-P9-05 - the More toggle opens and closes the panel', () => {
  it('opens on the first click and closes on the second', async () => {
    const user = userEvent.setup()
    await renderApp()
    const toggle = screen.getByRole('button', { name: 'More' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await user.click(toggle)
    expect(panelElement().classList.contains('toolbar-panel--open')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    await user.click(toggle)
    expect(panelElement().classList.contains('toolbar-panel--open')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('TASK-P9-05 - the always-visible six stay present regardless of the panel', () => {
  it('shows project name, tile count, Edit Layout, Pause Preview, Privacy and the toggle before expanding', async () => {
    await renderApp()
    expect(screen.getByText('Test Project')).not.toBeNull()
    expect(screen.getByText('tiles 0')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Edit Layout' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Pause Preview' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Privacy' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'More' })).not.toBeNull()
  })

  it('keeps the same six visible after expanding the panel', async () => {
    const user = userEvent.setup()
    await renderApp()
    await user.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByText('Test Project')).not.toBeNull()
    expect(screen.getByText('tiles 0')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Edit Layout' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Pause Preview' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Privacy' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'More · on' })).not.toBeNull()
  })
})
