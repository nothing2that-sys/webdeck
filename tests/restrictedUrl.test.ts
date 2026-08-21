import { describe, expect, it } from 'vitest'
import { resolveRuntimeStatus } from '../src/background/projectState'
import { RESTRICTED_URL_PREFIXES, isRestrictedUrl } from '../src/shared/restrictedUrl'
import type { BrowserTabInfo } from '../src/shared/types'

function tabInfo(tabId: number, currentUrl = 'https://example.com/'): BrowserTabInfo {
  return { tabId, windowId: 1, currentUrl, title: 'example' }
}

//+_+// P6-D103. 목록이 상수 한 곳에 있다. 분기문에 흩어져 있지 않다
describe('P6-D103 - the restricted url list is one constant', () => {
  //+_+// P7-D80. chrome-extension:// 이 빠져 목록이 한 개다
  it('holds only the chrome scheme after P7-D80', () => {
    expect([...RESTRICTED_URL_PREFIXES]).toEqual(['chrome://'])
  })

  it('matches the chrome scheme that Phase 4 measured', () => {
    expect(isRestrictedUrl('chrome://extensions')).toBe(true)
    expect(isRestrictedUrl('chrome://version')).toBe(true)
  })

  //+_+// P7-D80. v1 section 22 가 명시한 스킴이지만 실측이 보수 판정을 뒤집었다
  it('no longer matches the extension scheme v1 section 22 names', () => {
    expect(isRestrictedUrl('chrome-extension://abcdef/dashboard.html')).toBe(false)
  })

  it('leaves ordinary pages alone', () => {
    expect(isRestrictedUrl('https://example.com/')).toBe(false)
    expect(isRestrictedUrl('http://localhost:5173/')).toBe(false)
    expect(isRestrictedUrl('file:///D:/page.html')).toBe(false)
  })

  //+_+// 근거가 없는 스킴은 목록에 없다. 넣지 않은 것을 시험이 고정한다
  it('does not guess at schemes no evidence names', () => {
    expect(isRestrictedUrl('devtools://devtools/bundled/inspector.html')).toBe(false)
    expect(isRestrictedUrl('about:blank')).toBe(false)
    expect(isRestrictedUrl('view-source:https://example.com/')).toBe(false)
    expect(isRestrictedUrl('https://chromewebstore.google.com/')).toBe(false)
  })

  it('does not match a prefix that only appears in the middle', () => {
    expect(isRestrictedUrl('https://example.com/?next=chrome://version')).toBe(false)
  })

  it('treats an empty url as unrestricted', () => {
    expect(isRestrictedUrl('')).toBe(false)
  })

  //+_+// P7-D80. 뺀 스킴이다. 우리 확장의 페이지와 다른 확장의 페이지가 둘 다 통과한다
  it('leaves every extension page unrestricted', () => {
    expect(isRestrictedUrl('chrome-extension://')).toBe(false)
    expect(isRestrictedUrl('chrome-extension://zzzzzz/panel.html')).toBe(false)
  })

  //+_+// P7-D80. 남긴 스킴이다. 뺀 것은 하나뿐이고 chrome:// 는 그대로 제한이다
  it('keeps the chrome scheme restricted after P7-D80', () => {
    expect(isRestrictedUrl('chrome://')).toBe(true)
    expect(isRestrictedUrl('chrome://settings/')).toBe(true)
  })
})

//+_+// P6-D3. RESTRICTED 가 다른 어떤 상태보다 앞선다. 붙을 수 없는 탭에 다른 사유를 씌우지 않는다
describe('P6-D3 - RESTRICTED wins over every other status', () => {
  it('reports RESTRICTED even while the engine says LIVE', () => {
    expect(resolveRuntimeStatus('LIVE', 11, tabInfo(11), true, true)).toBe('RESTRICTED')
  })

  it('reports RESTRICTED instead of the ERROR the retries used to produce', () => {
    expect(resolveRuntimeStatus('ERROR', 11, tabInfo(11), false, true)).toBe('RESTRICTED')
  })

  it('reports RESTRICTED instead of LOADING before any frame', () => {
    expect(resolveRuntimeStatus(null, 11, tabInfo(11), false, true)).toBe('RESTRICTED')
  })

  //+_+// B-e5. 제한이 아닌 타일의 판정은 그대로다
  it('changes nothing for a tile that is not restricted', () => {
    expect(resolveRuntimeStatus('LIVE', 11, tabInfo(11), true, false)).toBe('LIVE')
    expect(resolveRuntimeStatus(null, undefined, null, false, false)).toBe('DETACHED')
  })
})
