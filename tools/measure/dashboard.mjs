//+_+// S2. Dashboard 를 조작하는 기본 API 다. 제품 코드에 셀렉터용 속성을 넣지 않고 화면 문구로 집는다
//+_+// 문구 근거는 App.tsx 와 TileCard.tsx 다. 문구가 바뀌면 여기가 먼저 깨진다

export const TOOLBAR = 'header.toolbar'
export const SETTINGSBAR = 'section.settingsbar'

export function dashboardUrl(extensionId) {
  return `chrome-extension://${extensionId}/dashboard.html`
}

export async function clickButton(page, scope, label) {
  const clicked = await page.evaluate(
    (scopeSelector, text) => {
      const root = scopeSelector === null ? document : document.querySelector(scopeSelector)
      if (root === null) {
        return false
      }
      const button = Array.from(root.querySelectorAll('button')).find(
        (element) => element.textContent?.trim() === text,
      )
      if (button === undefined || button.disabled) {
        return false
      }
      button.click()
      return true
    },
    scope,
    label,
  )
  if (!clicked) {
    throw new Error(`버튼을 누르지 못했다: ${label} (scope ${String(scope)})`)
  }
}

//+_+// React 제어 입력이다. value 를 직접 넣으면 상태가 따라오지 않는다. 실제 타이핑으로 바꾼다
export async function fillInput(page, selector, text) {
  await page.click(selector, { clickCount: 3 })
  await page.keyboard.press('Backspace')
  if (text.length > 0) {
    await page.keyboard.type(text)
  }
}

export function selectIn(scope, index) {
  return `${scope} select.toolbar-select:nth-of-type(${String(index)})`
}

export async function readSelectOptions(page, selector) {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel)
    if (element === null) {
      return null
    }
    return {
      value: element.value,
      options: Array.from(element.options).map((option) => ({
        value: option.value,
        label: option.textContent ?? '',
      })),
    }
  }, selector)
}

//+_+// 워커 콘솔은 붙지 않으므로 읽지 않는다 (P6-D22). 화면 쪽 콘솔과 예외만 모은다
export async function openDashboard(session, extensionId, sink = null) {
  const page = await session.openBlankPage()
  if (sink !== null) {
    //+_+// 같은 줄이 폴링마다 되풀이된다. 처음 1건만 싣고 나머지는 세기만 한다
    const seen = new Map()
    page.on('console', (message) => {
      const key = `${message.type()}::${message.text()}`
      const known = seen.get(key)
      if (known !== undefined) {
        known.count += 1
        return
      }
      const value = { type: message.type(), text: message.text(), count: 1 }
      seen.set(key, value)
      sink.dump('dashboard console', value)
    })
    page.on('pageerror', (error) => {
      sink.dump('dashboard pageerror', { message: String(error) })
    })
  }
  await page.goto(dashboardUrl(extensionId), { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(TOOLBAR, { timeout: 15000 })
  await page.waitForSelector('main.grid', { timeout: 15000 })
  return page
}

export async function createProject(page, name) {
  await fillInput(page, `${TOOLBAR} input.toolbar-input`, name)
  await clickButton(page, TOOLBAR, 'New')
  await page.waitForFunction(
    (text) => {
      const select = document.querySelector('header.toolbar select.toolbar-select')
      return select !== null && Array.from(select.options).some((o) => o.textContent === text)
    },
    { timeout: 10000 },
    name,
  )
}

export async function listProjects(page) {
  return readSelectOptions(page, selectIn(TOOLBAR, 1))
}

export async function switchProject(page, name) {
  const state = await listProjects(page)
  const option = state?.options.find((entry) => entry.label === name)
  if (option === undefined) {
    throw new Error(`프로젝트를 찾지 못했다: ${name}`)
  }
  await page.select(selectIn(TOOLBAR, 1), option.value)
  return option.value
}

//+_+// v1 section 9.1 의 (b) 경로다. 탭 생성은 워커가 한다. 하네스가 탭을 직접 열지 않는다
//+_+// 그래야 Puppeteer 가 타일 탭에 붙지 않고 제품의 attach 와 겨루지 않는다
export async function addTileFromUrl(page, url) {
  const before = await countTiles(page)
  await fillInput(page, `${TOOLBAR} input.toolbar-input:nth-of-type(2)`, url)
  await clickButton(page, TOOLBAR, 'Add URL')
  await page.waitForFunction(
    (expected) => document.querySelectorAll('article.tile').length >= expected,
    { timeout: 20000 },
    before + 1,
  )
}

export async function countTiles(page) {
  return page.$$eval('article.tile', (nodes) => nodes.length)
}

export async function selectTile(page, index) {
  const tiles = await page.$$('article.tile')
  const tile = tiles[index]
  if (tile === undefined) {
    throw new Error(`타일이 없다: index ${String(index)}`)
  }
  await tile.click()
  await page.waitForSelector(`${SETTINGSBAR} input.toolbar-input:not([disabled])`, {
    timeout: 5000,
  })
}

export async function setSelectedTileIntervalMs(page, intervalMs) {
  const text = intervalMs === null ? '' : String(intervalMs)
  await fillInput(page, `${SETTINGSBAR} input.toolbar-input:nth-of-type(2)`, text)
  await clickButton(page, SETTINGSBAR, 'Apply')
}

export async function removeSelectedTile(page) {
  const before = await countTiles(page)
  await clickButton(page, SETTINGSBAR, 'Remove Tile')
  await page.waitForFunction(
    (expected) => document.querySelectorAll('article.tile').length <= expected,
    { timeout: 10000 },
    before - 1,
  )
}

export async function refreshSelectedPreview(page) {
  await clickButton(page, SETTINGSBAR, 'Refresh Preview')
}

export async function openMissingTabs(page) {
  await clickButton(page, TOOLBAR, 'Open Missing Tabs')
}

export async function readStatusLine(page) {
  return page.$eval('footer.statusbar', (node) => node.textContent ?? '')
}

//+_+// 프레임이 바뀌는지 보려면 미리보기 자체를 봐야 한다. data URL 의 길이와 꼬리를 지문으로 쓴다
export async function readTiles(page) {
  return page.$$eval('article.tile', (nodes) =>
    nodes.map((node) => {
      const feet = Array.from(node.querySelectorAll('.tile-foot span')).map(
        (span) => span.textContent ?? '',
      )
      const image = node.querySelector('img.tile-preview-image')
      return {
        title: node.querySelector('.tile-title')?.textContent ?? '',
        status: node.querySelector('.tile-badge')?.textContent ?? '',
        lastCaptureLabel: feet[0] ?? '',
        tabLabel: feet[1] ?? '',
        previewLength: image === null ? null : image.src.length,
        previewTail: image === null ? null : image.src.slice(-24),
      }
    }),
  )
}

//+_+// 전경 / 배경 전환이다. 같은 창의 다른 탭을 활성으로 만든다
export async function sendDashboardToBackground(page) {
  return page.evaluate(async () => {
    const self = await chrome.tabs.getCurrent()
    if (self === undefined) {
      return { ok: false, reason: 'no current tab' }
    }
    const siblings = await chrome.tabs.query({ windowId: self.windowId })
    const other = siblings.find((tab) => tab.id !== self.id)
    if (other === undefined || other.id === undefined) {
      const created = await chrome.tabs.create({ url: 'about:blank', active: true })
      return { ok: true, activatedTabId: created.id ?? null, created: true }
    }
    await chrome.tabs.update(other.id, { active: true })
    return { ok: true, activatedTabId: other.id, created: false }
  })
}

export async function bringDashboardToForeground(page) {
  return page.evaluate(async () => {
    const self = await chrome.tabs.getCurrent()
    if (self === undefined || self.id === undefined) {
      return { ok: false, reason: 'no current tab' }
    }
    await chrome.tabs.update(self.id, { active: true })
    return { ok: true, activatedTabId: self.id }
  })
}

//+_+// P6-D71. 확장 페이지에서 탭을 하나 연다. 하네스가 그 탭에 CDP 로 붙지 않는 것이 핵심이다
//+_+// browser.mjs 의 decideTarget 이 확장 페이지가 아닌 타깃을 전부 거른다. 그래서 붙을 수도 없다
export async function createUnmanagedTab(page, url) {
  return page.evaluate(async (target) => {
    const created = await chrome.tabs.create({ url: target, active: false })
    return { tabId: created.id ?? null, url: target }
  }, url)
}

//+_+// P6-D71. tabs 권한만으로 읽을 수 있는 것은 title 과 url 뿐이다. 픽스처가 누적 tick 을 title 에 싣는다
//+_+// 판정하지 않는다. 파싱해서 그대로 낸다
export async function readTickTitles(page, tabIds) {
  return page.evaluate(async (ids) => {
    const tabs = await chrome.tabs.query({})
    const at = Date.now()
    return ids.map((tabId) => {
      const found = tabs.find((tab) => tab.id === tabId)
      const title = found?.title ?? ''
      const match = /^tick (\d+) (\d+)$/.exec(title)
      return {
        tabId,
        readAt: at,
        url: found?.url ?? null,
        active: found?.active ?? null,
        title,
        ticks: match === null ? null : Number(match[1]),
        pageElapsedMs: match === null ? null : Number(match[2]),
      }
    })
  }, tabIds)
}

//+_+// P6-D22. 서비스 워커 타깃에 붙지 않고 확장 페이지에서 chrome.storage 를 읽는다
//+_+// 진단 키는 chrome.storage.local 에 있다 (src/background/diagnostics.ts)
//+_+// P6-D55. 구간 경계를 양쪽으로 건다. 재개 뒤에 찍힌 행이 구간 안으로 섞이면 관측이 무너진다
//+_+// untilAt 을 주지 않으면 종전대로 한쪽만 건다
export async function dumpStorage(page, { sinceAt = 0, untilAt = null } = {}) {
  return page.evaluate(
    async (since, until) => {
      const all = await chrome.storage.local.get(null)
      const rounds = Array.isArray(all['webdeck.diagnostics.rounds'])
        ? all['webdeck.diagnostics.rounds']
        : []
      const within = (row) =>
        typeof row?.at === 'number' && row.at >= since && (until === null || row.at <= until)
      return {
        readAt: Date.now(),
        keys: Object.keys(all),
        state: all['webdeck.state'] ?? null,
        workerStarts: all['webdeck.diagnostics.workerStarts'] ?? null,
        //+_+// P6-D56. 재연결 판정이다. 콘솔이 사라져도 여기 남는다
        reconnect: all['webdeck.diagnostics.reconnect'] ?? null,
        roundCount: rounds.length,
        window: { sinceAt: since, untilAt: until },
        rounds: rounds.filter(within),
      }
    },
    sinceAt,
    untilAt,
  )
}

//+_+// P6-D55. 구간 내 회차를 타일별로 센다. 판정하지 않는다. 세는 일만 한다
export function countRoundsByTile(rows) {
  const byTile = {}
  let unparsed = 0
  for (const row of rows) {
    const line = typeof row?.line === 'string' ? row.line : ''
    const match = /^\[webdeck\] \S+ (\S+) /.exec(line)
    if (match === null) {
      unparsed += 1
      continue
    }
    byTile[match[1]] = (byTile[match[1]] ?? 0) + 1
  }
  return { total: rows.length, byTile, unparsed }
}

//+_+// 창을 앞으로 가져오는 대상이 무엇이었는지 기록에 남긴다. 어떤 탭이 앞에 왔는지가 관측의 일부다
export async function activateSiblingTab(page) {
  return page.evaluate(async () => {
    const self = await chrome.tabs.getCurrent()
    if (self === undefined || self.id === undefined) {
      return { ok: false, reason: 'no current tab' }
    }
    const siblings = await chrome.tabs.query({ windowId: self.windowId })
    const other = siblings.find((tab) => tab.id !== self.id)
    if (other === undefined || other.id === undefined) {
      return { ok: false, reason: 'no sibling tab' }
    }
    await chrome.tabs.update(other.id, { active: true })
    return { ok: true, activatedTabId: other.id, url: other.url ?? '', title: other.title ?? '' }
  })
}

//+_+// P6-D79. Pause Preview 토글이다. 문구는 App.tsx 의 'Pause Preview' / 'Pause Preview · on' 이다
//+_+// 켜진 상태와 꺼진 상태가 같은 버튼이므로 라벨로 현재 상태를 읽는다
export async function readPauseButtonLabel(page) {
  return page.evaluate((scope) => {
    const root = document.querySelector(scope)
    if (root === null) {
      return null
    }
    const button = Array.from(root.querySelectorAll('button')).find((element) =>
      (element.textContent ?? '').startsWith('Pause Preview'),
    )
    return button === undefined ? null : (button.textContent ?? '')
  }, TOOLBAR)
}

//+_+// P6-D79. 화면 라벨과 저장 키를 함께 낸다. 둘이 갈리면 그 사실이 관측이다
//+_+// 키는 src/shared/storage.ts 의 PAUSE_KEY 다
export async function readPauseState(page) {
  const label = await readPauseButtonLabel(page)
  const stored = await page.evaluate(async () => {
    const all = await chrome.storage.local.get('webdeck.previewPaused')
    return all['webdeck.previewPaused'] ?? null
  })
  return { buttonLabel: label, storedPaused: stored }
}

//+_+// 원하는 상태가 될 때까지 한 번만 누른다. 이미 그 상태면 누르지 않는다
export async function setPreviewPaused(page, want) {
  const before = await readPauseState(page)
  const isOn = before.buttonLabel === 'Pause Preview · on'
  if (isOn !== want) {
    await clickButton(page, TOOLBAR, isOn ? 'Pause Preview · on' : 'Pause Preview')
    await page.waitForFunction(
      (scope, text) => {
        const root = document.querySelector(scope)
        if (root === null) {
          return false
        }
        return Array.from(root.querySelectorAll('button')).some(
          (element) => (element.textContent ?? '') === text,
        )
      },
      { timeout: 10000 },
      TOOLBAR,
      want ? 'Pause Preview · on' : 'Pause Preview',
    )
  }
  return { before, after: await readPauseState(page) }
}

//+_+// P6-D79. Pause 구간에는 회차가 없으므로 회차 로그로 attach 를 볼 수 없다
//+_+// chrome.debugger.getTargets 는 목록을 읽기만 한다. 어느 타깃에도 붙지 않는다 (P6-D22)
//+_+// attached 는 그 타깃에 디버거 클라이언트가 붙어 있는지다. 붙인 주체가 누구인지는 말하지 않는다
export async function readDebuggerTargets(page, tabIds) {
  return page.evaluate(async (ids) => {
    const targets = await chrome.debugger.getTargets()
    const wanted = targets.filter((target) => ids.includes(target.tabId ?? -1))
    return {
      readAt: Date.now(),
      totalTargets: targets.length,
      tabs: wanted.map((target) => ({
        tabId: target.tabId ?? null,
        type: target.type,
        attached: target.attached,
        title: target.title,
        url: target.url,
      })),
    }
  }, tabIds)
}
