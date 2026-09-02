import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hub } from '../src/dashboard/Hub'
import type { DashboardRequest, DashboardResponse } from '../src/shared/messages'
import type { Project } from '../src/shared/types'

//+_+// TASK-P9-02. 선택 스캐폴딩(P8-3-D3, J175)을 없앤 뒤의 행 인라인 편집을 고정한다
//+_+// Open/Edit/Delete/Save/Cancel/예/아니오 는 실제 button 이라 role 로 찾는다. 우회 장치가 없다

function project(id: string, name: string, description: string, launchUrl: string): Project {
  return {
    id,
    name,
    description,
    gridColumns: 4,
    gridRows: 4,
    keepManagedTabsAlive: false,
    tiles: [
      {
        id: `${id}.t1`,
        launchUrl,
        matchMode: 'origin',
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        refreshIntervalMs: 4000,
        fitMode: 'contain',
        keepAlive: false,
      },
    ],
  }
}

const ALPHA = project('p.alpha', '알파', '첫 설명', 'https://example.com/alpha')
const BETA = project('p.beta', '베타', '둘 설명', 'https://example.com/beta')

//+_+// 워커를 흉내 낸다. CREATE/RENAME/DELETE 가 다음 LIST_PROJECTS 응답에 반영되게
//+_+// projectsState 를 들고 있다. sent 는 각 시험이 실제 보낸 요청을 들여다보는 자리다
let projectsState: Project[] = []
let sent: DashboardRequest[] = []

function answer(request: DashboardRequest): DashboardResponse {
  sent.push(request)
  switch (request.type) {
    case 'LIST_PROJECTS':
      return {
        ok: true,
        type: 'LIST_PROJECTS',
        projects: projectsState,
        activeProjectId: projectsState[0]?.id ?? '',
      }
    case 'CREATE_PROJECT': {
      const created = project(
        `p.created-${String(projectsState.length)}`,
        request.name,
        request.description ?? '',
        'https://example.com/created',
      )
      projectsState = [...projectsState, created]
      return { ok: true, type: 'CREATE_PROJECT', project: created }
    }
    case 'RENAME_PROJECT': {
      projectsState = projectsState.map((item) =>
        item.id === request.projectId
          ? { ...item, name: request.name, description: request.description }
          : item,
      )
      return { ok: true, type: 'RENAME_PROJECT' }
    }
    case 'DELETE_PROJECT': {
      projectsState = projectsState.filter((item) => item.id !== request.projectId)
      return { ok: true, type: 'DELETE_PROJECT' }
    }
    default:
      return { ok: false, type: request.type, errorCode: 'SEND_FAILED', message: 'not stubbed' }
  }
}

beforeEach(() => {
  projectsState = [
    project('p.alpha', ALPHA.name, ALPHA.description ?? '', 'https://example.com/alpha'),
    project('p.beta', BETA.name, BETA.description ?? '', 'https://example.com/beta'),
  ]
  sent = []
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: (request: DashboardRequest): Promise<DashboardResponse> =>
        Promise.resolve(answer(request)),
    },
  })
})

//+_+// vitest globals 를 켜지 않았으므로 RTL 의 자동 정리가 걸리지 않는다. 직접 부른다
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderHub(): Promise<void> {
  render(<Hub />)
  await screen.findByText(ALPHA.name)
}

//+_+// userEvent.hover 는 hover 뒤의 user.click 호출에서 별개의 포인터 이동으로 계산돼
//+_+// li 의 mouseleave 를 먼저 쏘고 Edit·Delete 버튼을 지운다 (jsdom 환경 한정 관찰).
//+_+// fireEvent 로 직접 mouseenter 를 쏘아 그 문제를 피한다
function hoverRow(name: string): void {
  const pick = screen.getByText(name)
  const row = pick.closest('li')
  if (row === null) {
    throw new Error(`no hub row for ${name}`)
  }
  fireEvent.mouseEnter(row)
}

describe('TASK-P9-02 - inline edit', () => {
  it('edits a project name and description inline, then saves', async () => {
    const user = userEvent.setup()
    await renderHub()
    hoverRow(ALPHA.name)
    await user.click(screen.getByRole('button', { name: `Edit ${ALPHA.name}` }))
    const nameInput = screen.getByDisplayValue(ALPHA.name)
    await user.clear(nameInput)
    await user.type(nameInput, '알파-수정')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('알파-수정')
    expect(
      sent.some((request) => request.type === 'RENAME_PROJECT' && request.name === '알파-수정'),
    ).toBe(true)
  })

  it('cancels inline edit and keeps the original values', async () => {
    const user = userEvent.setup()
    await renderHub()
    hoverRow(ALPHA.name)
    await user.click(screen.getByRole('button', { name: `Edit ${ALPHA.name}` }))
    const nameInput = screen.getByDisplayValue(ALPHA.name)
    await user.clear(nameInput)
    await user.type(nameInput, '지워질 이름')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(ALPHA.name)).not.toBeNull()
    expect(screen.queryByText('지워질 이름')).toBeNull()
    expect(sent.some((request) => request.type === 'RENAME_PROJECT')).toBe(false)
  })
})

describe('TASK-P9-02 - delete confirmation', () => {
  it('deletes a project after the two-step confirmation', async () => {
    const user = userEvent.setup()
    await renderHub()
    hoverRow(BETA.name)
    await user.click(screen.getByRole('button', { name: `Delete ${BETA.name}` }))
    await user.click(screen.getByRole('button', { name: '예' }))
    await waitFor(() => {
      expect(screen.queryByText(BETA.name)).toBeNull()
    })
    expect(
      sent.some((request) => request.type === 'DELETE_PROJECT' && request.projectId === BETA.id),
    ).toBe(true)
  })

  it('keeps the project when delete confirmation is declined', async () => {
    const user = userEvent.setup()
    await renderHub()
    hoverRow(BETA.name)
    await user.click(screen.getByRole('button', { name: `Delete ${BETA.name}` }))
    await user.click(screen.getByRole('button', { name: '아니오' }))
    expect(screen.queryByText(BETA.name)).not.toBeNull()
    expect(sent.some((request) => request.type === 'DELETE_PROJECT')).toBe(false)
  })
})

describe('TASK-P9-02 - New opens a blank row at the top', () => {
  it('creates a new project from the blank row', async () => {
    const user = userEvent.setup()
    await renderHub()
    await user.click(screen.getByRole('button', { name: 'New' }))
    const nameInput = screen.getByPlaceholderText('프로젝트 이름')
    await user.type(nameInput, '감마')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('감마')
    expect(
      sent.some((request) => request.type === 'CREATE_PROJECT' && request.name === '감마'),
    ).toBe(true)
  })

  it('discards the blank row on cancel without creating a project', async () => {
    const user = userEvent.setup()
    await renderHub()
    await user.click(screen.getByRole('button', { name: 'New' }))
    const nameInput = screen.getByPlaceholderText('프로젝트 이름')
    await user.type(nameInput, '버릴 이름')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByPlaceholderText('프로젝트 이름')).toBeNull()
    expect(sent.some((request) => request.type === 'CREATE_PROJECT')).toBe(false)
  })
})
