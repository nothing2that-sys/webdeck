import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hub } from '../src/dashboard/Hub'
import type { DashboardRequest, DashboardResponse } from '../src/shared/messages'
import type { Project } from '../src/shared/types'

//+_+// TASK-P83-01-a 2. 완료 조건 22 · 23 과 J175 를 고정한다. 대상은 Hub.tsx 하나다
//+_+// 완료 조건 20 · 21 은 App.tsx 조건이라 이 파일이 열지 않는다 (TASK-P83-01-a 1.4)

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

//+_+// TASK-P83-01-a 1.3. LIST_PROJECTS 1회 응답이다. 폴링을 흉내 내지 않는다
//+_+// 허브는 GET_PROJECT_STATE 를 보내지 않으므로 그 분기를 두지 않는다 (P8-D17)
function answer(request: DashboardRequest): DashboardResponse {
  if (request.type === 'LIST_PROJECTS') {
    return { ok: true, type: 'LIST_PROJECTS', projects: [ALPHA, BETA], activeProjectId: ALPHA.id }
  }
  return { ok: false, type: request.type, errorCode: 'SEND_FAILED', message: 'not stubbed' }
}

beforeEach(() => {
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

async function renderHub(): Promise<HTMLElement> {
  const view = render(<Hub />)
  await screen.findByText(ALPHA.name)
  return view.container
}

function row(container: HTMLElement, name: string): HTMLElement {
  const pick = Array.from(container.querySelectorAll('.hub-pick')).find(
    (node) => node.textContent === name,
  )
  const found = pick?.closest('li')
  if (found === null || found === undefined) {
    throw new Error(`no hub row for ${name}`)
  }
  return found
}

function child(parent: HTMLElement, selector: string): HTMLElement {
  const found = parent.querySelector(selector)
  if (!(found instanceof HTMLElement)) {
    throw new Error(`no ${selector} under the given element`)
  }
  return found
}

function isSelected(element: HTMLElement): boolean {
  return element.className === 'hub-row hub-row--on'
}

describe('WEBDECK_PLAN 22 - any part of the highlight box selects the row', () => {
  it('selects the row from the description text', async () => {
    const user = userEvent.setup()
    const container = await renderHub()
    await user.click(child(row(container, ALPHA.name), '.hub-description'))
    expect(isSelected(row(container, ALPHA.name))).toBe(true)
  })

  it('selects the row from the launch url list', async () => {
    const user = userEvent.setup()
    const container = await renderHub()
    await user.click(child(row(container, ALPHA.name), '.hub-urls'))
    expect(isSelected(row(container, ALPHA.name))).toBe(true)
  })

  //+_+// 이름 글자가 아닌 자리다. 1ce19fe 가 button 을 span 으로 바꾼 이유가 이것이다
  it('selects the row from the row padding', async () => {
    const user = userEvent.setup()
    const container = await renderHub()
    await user.click(row(container, ALPHA.name))
    expect(isSelected(row(container, ALPHA.name))).toBe(true)
  })

  //+_+// J177 이 남긴 유일한 stopPropagation 이다. 눌린 행이 선택 대상이 됐기 때문이다
  it('keeps the selection when Open is pressed', async () => {
    const user = userEvent.setup()
    const container = await renderHub()
    await user.click(row(container, ALPHA.name))
    await user.click(child(row(container, BETA.name), 'button'))
    expect(isSelected(row(container, ALPHA.name))).toBe(true)
    expect(isSelected(row(container, BETA.name))).toBe(false)
  })
})

describe('WEBDECK_PLAN 23 - the selection is released', () => {
  //+_+// J177. 눌린 것이 목록 자신일 때만 푼다. document 에 리스너를 붙이지 않는다
  it('clears the selection when the list background is pressed', async () => {
    const user = userEvent.setup()
    const container = await renderHub()
    await user.click(row(container, ALPHA.name))
    await user.click(child(container, '.hub-list'))
    expect(isSelected(row(container, ALPHA.name))).toBe(false)
  })

  it('clears the selection when the selected row is pressed again', async () => {
    const user = userEvent.setup()
    const container = await renderHub()
    await user.click(row(container, ALPHA.name))
    await user.click(row(container, ALPHA.name))
    expect(isSelected(row(container, ALPHA.name))).toBe(false)
  })

  it('empties the name and description inputs when the selection goes away', async () => {
    const user = userEvent.setup()
    const container = await renderHub()
    await user.click(row(container, ALPHA.name))
    const [name, description] = screen.getAllByRole('textbox') as HTMLInputElement[]
    expect([name.value, description.value]).toEqual([ALPHA.name, ALPHA.description])
    await user.click(child(container, '.hub-list'))
    expect([name.value, description.value]).toEqual(['', ''])
  })
})

describe('J175 - the hub row is reachable by keyboard', () => {
  it('carries a tab stop', async () => {
    const container = await renderHub()
    const target = row(container, ALPHA.name)
    expect(target.tabIndex).toBe(0)
    target.focus()
    expect(document.activeElement).toBe(target)
  })

  it('selects on Enter', async () => {
    const user = userEvent.setup()
    const container = await renderHub()
    row(container, ALPHA.name).focus()
    await user.keyboard('{Enter}')
    expect(isSelected(row(container, ALPHA.name))).toBe(true)
  })

  //+_+// role="button" 을 달면 Space 가 서지 않는 것이 더 어긋난다 (TASK-P83-01-a 1.1)
  it('selects on Space', async () => {
    const user = userEvent.setup()
    const container = await renderHub()
    row(container, ALPHA.name).focus()
    await user.keyboard(' ')
    expect(isSelected(row(container, ALPHA.name))).toBe(true)
  })
})
