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

//+_+// TASK-P7-21. 배지와 아래 줄 시각이 어떻게 움직였는지는 한 장의 사진으로 알 수 없다
//+_+// 같은 간격으로 여러 번 집어 열로 낸다. 판정하지 않는다. 집은 값을 그대로 담는다
//+_+// 조건 3 의 "돌아온 뒤 LOADING 을 거치는가" 는 이 열이 아니면 답할 수 없다
export async function pollTiles(page, count, everyMs) {
  const samples = []
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      await new Promise((done) => {
        setTimeout(done, everyMs)
      })
    }
    samples.push({ seq: index, at: Date.now(), tiles: await readTiles(page) })
  }
  return { count, everyMs, samples }
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

//+_+// L49. 같은 탭에 타일 둘을 걸려면 ADD_TILE {kind:'tab'} 경로가 필요하다
//+_+// addTileFromUrl 은 호출마다 워커가 탭을 새로 만들므로 같은 탭이 되지 않는다
//+_+// UI 문구 근거는 App.tsx 의 '탭 새로고침' / 'Add Tab' 이다
export async function refreshBrowserTabs(page) {
  await clickButton(page, TOOLBAR, '탭 새로고침')
}

//+_+// 탭 목록 select 는 툴바의 두 번째다. 첫 번째는 프로젝트 목록이다 (switchProject 가 쓴다)
export async function readBrowserTabs(page) {
  return readSelectOptions(page, selectIn(TOOLBAR, 2))
}

//+_+// 이미 열려 있는 탭에 타일을 하나 더 건다. 탭을 만들지 않는다
//+_+// 중복 탭 검사는 제품에 없다 (serviceWorker.addTile). 그래서 이 조작이 성립한다
export async function addTileFromTab(page, tabId) {
  const before = await countTiles(page)
  await refreshBrowserTabs(page)
  await page.waitForFunction(
    (selector, value) => {
      const element = document.querySelector(selector)
      return element !== null && Array.from(element.options).some((o) => o.value === value)
    },
    { timeout: 15000 },
    selectIn(TOOLBAR, 2),
    String(tabId),
  )
  await page.select(selectIn(TOOLBAR, 2), String(tabId))
  await clickButton(page, TOOLBAR, 'Add Tab')
  await page.waitForFunction(
    (expected) => document.querySelectorAll('article.tile').length >= expected,
    { timeout: 20000 },
    before + 1,
  )
  return { tabId, tilesBefore: before, tilesAfter: await countTiles(page) }
}

//+_+// T1. 저장된 타일 수다. 화면 타일 수와 다른 축이다
//+_+// dumpStorage().state 가 PersistedState 다 (src/shared/storage.ts). 판정하지 않고 센다
export function countStoredTiles(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : null
  if (projects === null) {
    return { total: null, byProject: null, reason: 'state.projects is not an array' }
  }
  const byProject = {}
  let total = 0
  for (const project of projects) {
    const tiles = Array.isArray(project?.tiles) ? project.tiles : []
    const key = typeof project?.id === 'string' ? project.id.slice(0, 8) : '?'
    byProject[key] = { name: project?.name ?? null, tiles: tiles.length }
    total += tiles.length
  }
  return { total, byProject, activeProjectId: state?.activeProjectId ?? null }
}

//+_+// T3 의 입력이다. readTiles 의 tabLabel 은 tileView.tabLabel 이 만든 'tab N' 또는 'tab -' 이다
//+_+// 판정하지 않는다. 파싱해서 그대로 낸다
export function tileTabIds(tiles) {
  return tiles.map((tile, index) => {
    const match = /^tab (\d+)$/.exec(tile.tabLabel ?? '')
    return { index, title: tile.title, status: tile.status, tabId: match === null ? null : Number(match[1]) }
  })
}

//+_+// Diagnostics 바가 화면에 내는 값 그대로다. 사람이 읽는 숫자와 같은 축을 잰다
//+_+// '등록 타일' 은 registeredTiles 이고 저장된 타일 수와 다른 축이다 (countStoredTiles 를 함께 본다)
//+_+// 'attach' 는 attachedTabs 다. 요청 이름은 src/shared/messages.ts 의 GET_DIAGNOSTICS 다
export async function readDiagnostics(page) {
  return page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' })
    return response?.ok === true ? response.diagnostics : { error: response ?? null }
  })
}

//+_+// 워커의 reconnect() 는 projects 를 돌고 그 안의 tiles 를 돌아 owners 를 만든다
//+_+// 전역 taken 이 그 순서로 탭을 배정하므로 배열 순서가 승자를 정한다
//+_+// 저장된 순서를 평평하게 펴서 그대로 낸다. 판정하지 않는다
export function tileOrder(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : null
  if (projects === null) {
    return { order: null, reason: 'state.projects is not an array' }
  }
  const order = []
  for (const [projectIndex, project] of projects.entries()) {
    const tiles = Array.isArray(project?.tiles) ? project.tiles : []
    for (const [tileIndex, tile] of tiles.entries()) {
      order.push({
        seq: order.length,
        projectIndex,
        projectId: typeof project?.id === 'string' ? project.id.slice(0, 8) : null,
        projectName: project?.name ?? null,
        active: project?.id === state?.activeProjectId,
        tileIndex,
        tileId: typeof tile?.id === 'string' ? tile.id.slice(0, 8) : null,
        launchUrl: tile?.launchUrl ?? null,
        matchMode: tile?.matchMode ?? null,
      })
    }
  }
  return { order, activeProjectId: state?.activeProjectId ?? null }
}

//+_+// P7-D47. 공유 탭을 닫아 리스를 푼다. 프로젝트 전환을 쓰지 않으므로 활성 프로젝트가 유지된다
//+_+// 0타일 전환 경로는 활성 프로젝트를 비우고 그래서 활성 우선 배정을 가르지 못한다
//+_+// 닫은 탭의 URL 을 함께 낸다. 같은 URL 로 다시 열어야 재연결 후보가 생긴다
export async function closeTabs(page, tabIds) {
  return page.evaluate(async (ids) => {
    const all = await chrome.tabs.query({})
    const closing = all
      .filter((tab) => ids.includes(tab.id ?? -1))
      .map((tab) => ({ tabId: tab.id ?? null, url: tab.url ?? '' }))
    const removable = closing.map((tab) => tab.tabId).filter((id) => typeof id === 'number')
    await chrome.tabs.remove(removable)
    return { closed: closing, tabsBefore: all.length, tabsAfter: (await chrome.tabs.query({})).length }
  }, tabIds)
}

//+_+// P7-D47. 다시 연 탭은 번호가 바뀐다. 픽스처 URL 로 새 번호를 찾는다
//+_+// 판정하지 않는다. chrome.tabs.query 의 값을 그대로 낸다
export async function findTabsByUrl(page, urls) {
  return page.evaluate(async (wanted) => {
    const all = await chrome.tabs.query({})
    return all
      .filter((tab) => wanted.includes(tab.url ?? ''))
      .map((tab) => ({ tabId: tab.id ?? null, url: tab.url ?? '', active: tab.active ?? null }))
  }, urls)
}
