import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  addTileFromUrl,
  countRoundsByTile,
  createProject,
  createUnmanagedTab,
  dumpStorage,
  openDashboard,
  readTickTitles,
  readTiles,
  switchProject,
} from '../dashboard.mjs'
import { sleep } from '../runner.mjs'

//+_+// P6-D71. L9 다. attach 가 배경 탭의 타이머 스로틀을 억제하는가
//+_+// 같은 픽스처를 두 탭에 열고 하나만 타일로 등록한다. 등록된 쪽만 워커가 attach 한다
//+_+// 두 탭 다 배경이다. Dashboard 가 전경이어야 캡처가 도므로(D6b) 그 조건이 곧 두 탭의 배경이다
//+_+// P6-D72. 판정 문장을 쓰지 않는다. tick / 경과초 를 그대로 낸다
export const description =
  'L9. 같은 픽스처를 두 탭에 열고 하나만 타일로 등록해 배경 tick 속도를 비교한다'

//+_+// live-counter 를 쓰지 않는다. 그쪽은 주기가 1000ms 라 배경 클램프와 구분되지 않는다
function fixtureUrl(tile) {
  const page = resolve('test-pages/tick-title.html')
  if (!existsSync(page)) {
    throw new Error(`test-pages/tick-title.html 이 없다: ${page}`)
  }
  return `${pathToFileURL(page).href}?tile=${String(tile)}`
}

//+_+// 두 탭의 시작 시각이 다르므로 절대값을 비교하지 않는다. 구간 내 증분만 본다 (P6-D71)
function rateOf(before, after) {
  if (before.ticks === null || after.ticks === null) {
    return { ticks: null, elapsedMs: null, ticksPerSecond: null, note: 'title did not parse' }
  }
  const ticks = after.ticks - before.ticks
  const elapsedMs = after.pageElapsedMs - before.pageElapsedMs
  return {
    ticks,
    elapsedMs,
    ticksPerSecond: elapsedMs === 0 ? null : Number(((ticks * 1000) / elapsedMs).toFixed(3)),
  }
}

export async function run({ session, run, extensionId, config }) {
  const idleMs = config.watchMs ?? 180000
  const settleMs = config.settleMs ?? 20000

  const controlUrl = fixtureUrl(1)
  const attachUrl = fixtureUrl(2)

  let page = null
  let controlTabId = null
  let attachTabId = null
  let before = null

  await run.segment('open one unmanaged tab and one tile tab', async () => {
    page = await openDashboard(session, extensionId, run)
    run.action('create project', { name: 'L9' })
    await createProject(page, 'L9')
    await switchProject(page, 'L9')

    //+_+// 대조군이다. 타일로 등록하지 않으므로 워커가 attach 하지 않는다
    const control = await createUnmanagedTab(page, controlUrl)
    controlTabId = control.tabId
    run.action('control tab created, not registered', control)

    //+_+// 처치군이다. 탭 생성은 워커가 한다. 등록과 동시에 attach 대상이 된다
    run.action('add tile from url', { url: attachUrl })
    await addTileFromUrl(page, attachUrl)

    run.action('settle', { ms: settleMs })
    await sleep(settleMs)

    //+_+// 탐색을 안정화 뒤로 둔다. 생성 직후에는 url 이 비어 있고 pendingUrl 에만 값이 있다
    //+_+// 두 필드를 모두 본다. 커밋 전후 어느 쪽이든 같은 탭을 집는다
    attachTabId = await page.evaluate(async (target) => {
      const tabs = await chrome.tabs.query({})
      const hit = tabs.find((tab) => tab.url === target || tab.pendingUrl === target)
      return hit?.id ?? null
    }, attachUrl)
    run.action('tile tab located', { tabId: attachTabId, url: attachUrl })
    if (attachTabId === null) {
      throw new Error(`타일 탭을 찾지 못했다: ${attachUrl}`)
    }

    //+_+// 구간 진입 전에 캡처가 실제로 돌고 있었다는 것을 남긴다
    run.dump('tiles after settle', await readTiles(page))
    const settled = await dumpStorage(page)
    run.dump('storage after settle', {
      roundCount: settled.roundCount,
      workerStarts: settled.workerStarts,
      lastLines: settled.rounds.slice(-2).map((row) => row.line),
    })
  })

  const from = Date.now()
  await run.segment(`idle ${String(Math.round(idleMs / 1000))}s`, async () => {
    //+_+// 구간 경계에서만 읽는다. 구간 중에는 두 탭을 앞으로 가져오지도 읽지도 않는다
    before = await readTickTitles(page, [controlTabId, attachTabId])
    run.dump('tick titles at the window start', before)
    run.action('idle, dashboard in the foreground, both tabs in the background', { ms: idleMs })
    await sleep(idleMs)
  })
  const to = Date.now()

  await run.segment('read both tabs before closing anything', async () => {
    //+_+// Phase 3 은 라운드가 끝난 뒤 탭을 닫아 값을 잃었다. 닫기 전에 읽는 것이 이 절의 전부다
    const after = await readTickTitles(page, [controlTabId, attachTabId])
    run.dump('tick titles at the window end', after)

    const dump = await dumpStorage(page, { sinceAt: from, untilAt: to })
    const rounds = countRoundsByTile(dump.rounds)

    run.dump('L9 window', {
      startedAt: from,
      endedAt: to,
      elapsedMs: to - from,
      workerStarts: dump.workerStarts,
      //+_+// attach 여부는 회차 로그의 attached N 과 등록 여부로 읽는다. 하네스가 판정하지 않는다
      roundsInWindow: rounds,
      sampleLines: dump.rounds.slice(0, 2).map((row) => row.line),
      tabs: [
        {
          role: 'control',
          tabId: controlTabId,
          url: controlUrl,
          registeredAsTile: false,
          ...rateOf(before[0], after[0]),
        },
        {
          role: 'tile',
          tabId: attachTabId,
          url: attachUrl,
          registeredAsTile: true,
          ...rateOf(before[1], after[1]),
        },
      ],
    })
    run.dump('tiles at the end', await readTiles(page))
  })
}
