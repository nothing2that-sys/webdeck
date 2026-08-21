import { dashboardUrl, findTabsByUrl, openDashboard, readDebuggerTargets } from '../dashboard.mjs'
import { sleep } from '../runner.mjs'

//+_+// TASK-P7-21 section 6 의 E-2 다. 그 절은 "부를 자리가 있는가" 를 묻는다
//+_+// 자리가 있는지는 불러 보면 답이 나온다. 제품 코드를 고치지 않고 답하는 유일한 경로다
//+_+// isRestrictedUrl 을 우회하는 것이 아니라 지나가지 않는다. 하네스가 API 를 직접 부른다
//+_+// Dashboard 페이지가 확장 컨텍스트이고 manifest 에 debugger 권한이 있다
//+_+// readDebuggerTargets 가 이미 그 페이지에서 chrome.debugger.getTargets 를 부르고 있다
//+_+// P6-D22 는 그대로다. 서비스 워커 타깃에 붙지 않는다. 대상은 page 타깃 하나다
//+_+// P6-D24. 판정 문장을 쓰지 않는다. Chrome 이 돌려준 문자열을 그대로 낸다
export const description =
  'L48 조사. Dashboard 페이지에서 chrome-extension:// 또는 chrome:// 탭에 chrome.debugger.attach 를 시도한다'

//+_+// TASK-P7-22 section 5.1 의 E 다. chrome:// 도 같은 절차로 잰다
//+_+// chrome://version 을 고른 이유는 정적이고 조작할 UI 가 없어 probe 가 대상 상태를 바꾸지 않는다 (P18)
const CHROME_TARGET = 'chrome://version'

//+_+// Chrome 이 chrome:// 의 url 을 정규화한다. 정확히 일치로는 잡히지 않으므로 접두사로 찾는다
async function findTabsByPrefix(page, prefix) {
  return page.evaluate(async (wanted) => {
    const all = await chrome.tabs.query({})
    return all
      .filter((tab) => (tab.url ?? '').startsWith(wanted))
      .map((tab) => ({ tabId: tab.id ?? null, url: tab.url ?? '', active: tab.active ?? null }))
  }, prefix)
}

//+_+// 성공과 실패를 같은 형태로 담는다. 예외를 삼키지 않고 문자열로 옮긴다
async function tryAttach(page, tabId) {
  return page.evaluate(async (id) => {
    const out = { tabId: id, attach: null, capture: null, detach: null }
    try {
      await chrome.debugger.attach({ tabId: id }, '1.3')
      out.attach = { ok: true, message: null }
    } catch (error) {
      out.attach = { ok: false, message: error instanceof Error ? error.message : String(error) }
      return out
    }
    //+_+// 붙었다면 실제로 캡처까지 되는지가 다음 질문이다. 붙는 것과 찍히는 것은 다른 축이다
    try {
      const shot = await chrome.debugger.sendCommand({ tabId: id }, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 70,
      })
      const data = typeof shot?.data === 'string' ? shot.data : null
      out.capture = { ok: true, bytes: data === null ? null : data.length, message: null }
    } catch (error) {
      out.capture = { ok: false, bytes: null, message: error instanceof Error ? error.message : String(error) }
    }
    try {
      await chrome.debugger.detach({ tabId: id })
      out.detach = { ok: true, message: null }
    } catch (error) {
      out.detach = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    return out
  }, tabId)
}

export async function run({ session, run, extensionId, config }) {
  const settleMs = config.settleMs ?? 10000

  const scheme = config.scheme === 'chrome' ? 'chrome' : 'extension'

  await run.segment(`probe a ${scheme === 'chrome' ? 'chrome://' : 'chrome-extension://'} tab`, async () => {
    const page = await openDashboard(session, extensionId, run)
    const target = scheme === 'chrome' ? CHROME_TARGET : dashboardUrl(extensionId)
    //+_+// 두 번째 Dashboard 탭이다. 우리 확장의 스킴을 가진 탭을 만드는 유일한 수단이다
    //+_+// chrome 스킴에서는 Chrome 이 여는 내부 페이지 하나다. 같은 openBareTab 경로다
    run.dump('opened the probe tab', { scheme, target, ...(await session.openBareTab(target)) })
    run.action('settle', { ms: settleMs })
    await sleep(settleMs)

    const found = (
      scheme === 'chrome' ? await findTabsByPrefix(page, target) : await findTabsByUrl(page, [target])
    ).filter((entry) => entry.tabId !== null)
    run.dump('probe tabs found', found)
    //+_+// 자기 탭을 고르면 자기에게 붙는 것이 된다. 다른 탭 하나를 고른다
    const selfId = await page.evaluate(async () => (await chrome.tabs.getCurrent())?.id ?? null)
    const other = found.find((entry) => entry.tabId !== selfId)
    if (other === undefined) {
      run.dump('not reachable', { reason: 'no probe tab', scheme, target, selfId, found })
      return
    }

    //+_+// targetFilter 가 확장 스킴을 받아들이므로 Puppeteer 가 이 탭에 이미 붙어 있을 수 있다
    //+_+// 그러면 관측이 흐려진다. 붙어 있었는지를 먼저 남긴다
    const before = await readDebuggerTargets(page, [other.tabId])
    run.dump('debugger targets before the probe', before)
    run.dump('probe result', await tryAttach(page, other.tabId))
    run.dump('debugger targets after the probe', await readDebuggerTargets(page, [other.tabId]))
  })
}
