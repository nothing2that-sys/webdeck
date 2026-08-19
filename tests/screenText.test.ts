import { describe, expect, it } from 'vitest'
import {
  NOTICE_DROP_REJECTED,
  NOTICE_NONE,
  browserTabLabel,
  dropNotice,
  failureNotice,
  openedTabsNotice,
  tileSettingsLabel,
  toggleClassName,
  toggleLabel,
} from '../src/dashboard/screenText'
import type { DashboardFailure } from '../src/shared/messages'
import type { BrowserTabInfo } from '../src/shared/types'

function failure(errorCode: string, message: string): DashboardFailure {
  return { ok: false, type: 'GET_PROJECT_STATE', errorCode, message }
}

function tab(tabId: number, title: string, currentUrl: string): BrowserTabInfo {
  return { tabId, windowId: 1, currentUrl, title }
}

//+_+// P6-D2. L43 이 지적한 자리다. App.tsx 안에서만 성립하던 규칙을 node 에서 고정한다
describe('P6-D2 - the response to notice mapping is pure', () => {
  it('carries the error code and the message', () => {
    expect(failureNotice(failure('TAB_NOT_FOUND', 'No tab with id 7'))).toBe(
      'TAB_NOT_FOUND: No tab with id 7',
    )
  })

  it('does not invent text for an empty message', () => {
    expect(failureNotice(failure('SEND_FAILED', ''))).toBe('SEND_FAILED: ')
  })

  //+_+// TASK-P5-03 이 고친 6곳의 규칙이다. 성공은 앞선 안내를 지운다
  it('clears the notice with an empty string', () => {
    expect(NOTICE_NONE).toBe('')
  })
})

describe('P6-D2 - counted notices', () => {
  it('reports zero opened tabs as zero', () => {
    expect(openedTabsNotice(0)).toBe('0 tabs opened')
  })

  it('reports the opened count', () => {
    expect(openedTabsNotice(3)).toBe('3 tabs opened')
  })
})

//+_+// v1 section 7.2. 무효한 Drop 만 문구를 남긴다. 유효한 Drop 은 앞선 안내를 지운다
describe('P6-D2 - the drop notice', () => {
  it('says nothing when the drop was valid', () => {
    expect(dropNotice(true)).toBe(NOTICE_NONE)
  })

  it('explains the revert when the drop was rejected', () => {
    expect(dropNotice(false)).toBe(NOTICE_DROP_REJECTED)
  })
})

describe('P6-D2 - toolbar toggles share one rule', () => {
  it('appends the on marker only when the toggle is on', () => {
    expect(toggleLabel('Edit Layout', false)).toBe('Edit Layout')
    expect(toggleLabel('Edit Layout', true)).toBe('Edit Layout · on')
    expect(toggleLabel('Pause Preview', true)).toBe('Pause Preview · on')
  })

  it('adds the on modifier class only when the toggle is on', () => {
    expect(toggleClassName(false)).toBe('toolbar-toggle')
    expect(toggleClassName(true)).toBe('toolbar-toggle toolbar-toggle--on')
  })
})

describe('P6-D2 - the settings bar label', () => {
  it('guides the user before a tile is picked', () => {
    expect(tileSettingsLabel(false)).toBe('타일을 고르면 설정이 열린다')
  })

  it('names the section once a tile is picked', () => {
    expect(tileSettingsLabel(true)).toBe('Tile')
  })
})

describe('P6-D2 - the browser tab option label', () => {
  it('shows the title when the tab has one', () => {
    expect(browserTabLabel(tab(7, 'Example', 'https://example.com/'))).toBe('7 · Example')
  })

  //+_+// 제목이 비어 있으면 빈 줄이 목록에 남는다. URL 로 대신한다
  it('falls back to the url when the title is empty', () => {
    expect(browserTabLabel(tab(7, '', 'https://example.com/'))).toBe('7 · https://example.com/')
  })
})
