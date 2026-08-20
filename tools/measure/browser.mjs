import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import { extensionIdForPath } from './extensionId.mjs'

//+_+// 사용자의 실제 Chrome 을 쓴다. 별도 빌드를 내려받으면 실측 대상이 사용자의 Chrome 이 아니게 된다
const CHROME_CANDIDATES = [
  process.env.WEBDECK_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

//+_+// Puppeteer 기본 인자에는 배경 탭의 거동을 바꾸는 것들이 들어 있다
//+_+// 이 하네스가 재려는 것이 바로 그 거동이므로 되돌린다. 계측 도구가 계측 대상을 바꾸지 않는다
export const REMOVED_DEFAULT_ARGS = [
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-infobars',
  '--enable-automation',
]

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

//+_+// P6-D22 를 코드로 강제하는 자리다. 서비스 워커 타깃에는 세션을 잡지 않는다
//+_+// Puppeteer 는 service_worker 를 targetFilter 보다 앞에서 스스로 떼므로 여기까지 오지 않는다
//+_+// 타일 탭에도 붙지 않는다. 붙으면 제품의 chrome.debugger.attach 와 겨루게 된다
export function decideTarget(type, url, extensionPrefix, acceptBlank) {
  if (type !== 'page' && type !== 'tab') {
    return false
  }
  if (url.startsWith(extensionPrefix)) {
    return true
  }
  return acceptBlank && (url === '' || url === 'about:blank')
}

export async function launchMeasured({ extensionPath, userDataDir, windowSize = '1280,900' }) {
  const chromePath = findChrome()
  if (chromePath === null) {
    throw new Error('chrome.exe 를 찾지 못했다. WEBDECK_CHROME 로 경로를 준다')
  }
  const unpackedPath = resolve(extensionPath)
  if (!existsSync(unpackedPath)) {
    throw new Error(`확장 경로가 없다: ${unpackedPath}. npm run build 를 먼저 돌린다`)
  }

  const pathId = extensionIdForPath(unpackedPath)
  const ledger = []
  const state = { acceptBlank: false, prefix: `chrome-extension://${pathId}/` }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    userDataDir: resolve(userDataDir),
    headless: false,
    //+_+// Chrome 137 부터 원격 디버깅이 붙은 상태에서는 --load-extension 이 무시된다
    //+_+// Puppeteer 는 pipe 연결에서 CDP Extensions.loadUnpacked 로 대신 심는다. id 도 그쪽이 돌려준다
    pipe: true,
    enableExtensions: true,
    //+_+// 첫 about:blank 페이지는 걸러진다. 기다리면 실행이 끝나지 않는다
    waitForInitialPage: false,
    defaultViewport: null,
    ignoreDefaultArgs: REMOVED_DEFAULT_ARGS,
    args: ['--no-default-browser-check', `--window-size=${windowSize}`],
    targetFilter: (target) => {
      const type = target.type()
      const url = target.url()
      const accepted = decideTarget(type, url, state.prefix, state.acceptBlank)
      ledger.push({ at: Date.now(), type, url, accepted })
      return accepted
    },
  })

  const version = await browser.version()
  const installedId = await browser.installExtension(unpackedPath)
  state.prefix = `chrome-extension://${installedId}/`

  //+_+// P6-D22 의 자기 검증 기록이다. Puppeteer 는 service_worker 를 targetFilter 보다 앞에서
  //+_+// 스스로 떼므로 세션은 남지 않는다. 그래도 타깃이 나타나고 사라진 시각은 그대로 남긴다
  const workerTargetEvents = []
  const noteWorkerTarget = (phase) => (target) => {
    if (target.type() === 'service_worker') {
      workerTargetEvents.push({ at: Date.now(), phase, url: target.url() })
    }
  }
  browser.on('targetcreated', noteWorkerTarget('created'))
  browser.on('targetdestroyed', noteWorkerTarget('destroyed'))

  return {
    browser,
    chromePath,
    version,
    unpackedPath,
    pathId,
    extensionId: installedId,
    ledger,
    workerTargetEvents,
    //+_+// Puppeteer 가 service_worker 를 붙잡지 않고도 목록에는 남긴다. 세션 없이 url 만 읽는다
    workerTargetUrls: () =>
      browser
        .targets()
        .filter((target) => target.type() === 'service_worker')
        .map((target) => target.url()),
    //+_+// P7-D47. 타일 탭을 다시 여는 자리다. 브라우저 수준 CDP 로 만들고 세션을 잡지 않는다
    //+_+// targetFilter 가 확장 페이지 밖을 거르므로 Puppeteer 는 이 탭에 붙지 않는다
    //+_+// openBlankPage 로 열면 about:blank 에 세션이 붙은 뒤 goto 로 남아 제품의 attach 와 겨룬다
    async openBareTab(url) {
      const cdp = await browser.target().createCDPSession()
      try {
        const created = await cdp.send('Target.createTarget', { url })
        return { targetId: created.targetId, url }
      } finally {
        await cdp.detach().catch(() => undefined)
      }
    },
    //+_+// 새 페이지는 about:blank 로 태어난다. 그 창 안에서만 blank 를 받아들인다
    async openBlankPage() {
      state.acceptBlank = true
      try {
        return await browser.newPage()
      } finally {
        state.acceptBlank = false
      }
    },
  }
}
