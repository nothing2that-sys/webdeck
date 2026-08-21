import {
  addTileFromUrl,
  bringDashboardToForeground,
  closeTabs,
  countStoredTiles,
  createProject,
  dumpStorage,
  findTabsByUrl,
  openDashboard,
  readDebuggerTargets,
  readDiagnostics,
  readTiles,
  switchProject,
  tileOrder,
  tileTabIds,
} from '../dashboard.mjs'
import { sleep } from '../runner.mjs'

//+_+// TASK-P7-21 조건 2. L45 다. 워커 기동 이후에 열린 탭이 프로젝트 전환 시점에 잡히는가
//+_+// L45 는 reconnect 이 워커 기동당 1회만 돌고 reregister 가 bindings 부재로 되돌아간다고 적었다
//+_+// 그것이 코드 근거이고 이 회차가 재는 것은 전환이 재판정을 부르는지 아닌지다
//+_+// P1 을 0타일 활성으로 둔다. attach 가 남으면 워커가 600초 넘게 산다 (P6-D65)
//+_+// P2 타일의 탭은 죽기 전에 닫는다. 그래야 기동 시점에 후보가 없어 none 이 된다
//+_+// P6-D22. 사망 구간에는 확장 페이지를 열지 않는다
//+_+// P6-D24 · D45. 판정 문장을 쓰지 않는다
export const description =
  '조건 2. 워커 기동 이후에 열린 탭이 프로젝트 전환 시점에 잡히는가 (L45)'

//+_+// 한 자리에서 읽는다. same-tab-tiles 의 measure 와 같은 축이고 이 조건에 필요한 것만 담는다
async function measure(page, label, run, tabIds) {
  const tiles = await readTiles(page)
  const storage = await dumpStorage(page)
  const diag = await readDiagnostics(page)
  const value = {
    label,
    at: Date.now(),
    tiles,
    tabIds: tileTabIds(tiles),
    stored: countStoredTiles(storage.state),
    order: tileOrder(storage.state),
    //+_+// reconnect 행이다. 워커 기동마다 쌓인다. 전량을 낸다
    reconnect: storage.reconnect,
    workerStarts: storage.workerStarts,
    //+_+// 화면의 '등록 타일' 과 'attach' 다. 붙었는지의 지표다
    diagnostics: diag,
    roundCount: storage.roundCount,
    //+_+// 그 탭에 디버거 클라이언트가 붙어 있는지다. 붙인 주체는 말하지 않는다
    targets: tabIds === null || tabIds.length === 0 ? null : await readDebuggerTargets(page, tabIds),
  }
  run.dump(`measure ${label}`, value)
  return value
}

export async function run({ session, run, extensionId, config }) {
  const deathMs = config.deathWaitMs ?? 300000
  const settleMs = config.settleMs ?? 20000
  const watchMs = config.watchMs ?? 30000
  const url = config.tileUrls[0]
  if (url === undefined) {
    throw new Error('--tiles 1 이상이 필요하다')
  }
  run.log(`death ${String(Math.round(deathMs / 1000))}s · watch ${String(Math.round(watchMs / 1000))}s`)

  let closedUrls = []

  //+_+// 1 · 2단계다. P1 을 활성으로 두고 P2 에 타일 하나를 건다
  await run.segment('setup P1 active with no tiles, P2 with one tile', async () => {
    const page = await openDashboard(session, extensionId, run)
    run.action('create project', { name: 'P1' })
    await createProject(page, 'P1')
    run.action('create project', { name: 'P2' })
    await createProject(page, 'P2')

    await switchProject(page, 'P2')
    run.action('add tile from url', { url, project: 'P2' })
    await addTileFromUrl(page, url)
    run.action('settle', { ms: settleMs })
    await sleep(settleMs)
    const seeded = tileTabIds(await readTiles(page))
    run.dump('P2 tile after settle', seeded)
    const tabIds = seeded.map((entry) => entry.tabId).filter((id) => typeof id === 'number')
    await measure(page, 'P2 before the death', run, tabIds)

    //+_+// launchUrl 이 열려 있지 않은 상태를 만든다. 탭을 닫는 것이 리스를 푸는 경로이기도 하다
    run.action('close the tile tab', { tabIds })
    const closed = await closeTabs(page, tabIds)
    run.dump('closed the tile tab', closed)
    closedUrls = closed.closed.map((entry) => entry.url)

    //+_+// P1 을 활성으로 둔다. 0타일이라 attach 가 남지 않는다
    run.action('switch project', { name: 'P1', note: 'active with no tiles' })
    await switchProject(page, 'P1')
    run.dump('tiles in P1', await readTiles(page))
    run.action('close dashboard', null)
    await page.close()
  })

  //+_+// 3단계 전반이다. 워커가 죽는다
  await run.segment(`wait for worker death ${String(Math.round(deathMs / 1000))}s`, async () => {
    run.action('no extension page open, no dump', { ms: deathMs })
    await sleep(deathMs)
  })

  let livePage = null
  let lateTabIds = []

  //+_+// 3단계 후반이다. Dashboard 를 열면 워커가 뜨고 reconnect 이 1회 돈다
  //+_+// 그 시점에 P2 타일의 URL 은 열려 있지 않으므로 none 이 나올 자리다
  await run.segment('reopen the dashboard, worker starts, reconnect runs', async () => {
    const page = await openDashboard(session, extensionId, run)
    livePage = page
    await measure(page, 'right after the worker started', run, [])
  })

  //+_+// 4단계다. 워커가 이미 살아 있는 시점에 그 URL 로 탭을 연다
  //+_+// 확장 페이지를 쓰지 않고 브라우저 수준 CDP 로 만든다. 하네스가 그 탭에 붙지 않는다
  await run.segment('open the tab while the worker is already alive', async () => {
    for (const closed of closedUrls) {
      run.dump('reopened bare tab', await session.openBareTab(closed))
    }
    //+_+// Target.createTarget 은 그 탭을 활성으로 만든다. Dashboard 가 배경이면 화면이 갱신되지 않는다
    //+_+// 이 조건이 묻는 것은 전환 시점의 재판정이므로 Dashboard 를 전경으로 되돌려 놓고 잰다
    run.dump('bring dashboard to foreground', await bringDashboardToForeground(livePage))
    run.action('settle after opening the tab', { ms: settleMs })
    await sleep(settleMs)
    const found = await findTabsByUrl(livePage, closedUrls)
    run.dump('the late tab', found)
    lateTabIds = found.map((entry) => entry.tabId).filter((id) => typeof id === 'number')
    //+_+// 전환 전이다. 아직 P1 이 활성이므로 P2 타일은 화면에 없다
    await measure(livePage, 'late tab open, still on P1', run, lateTabIds)
  })

  //+_+// 5단계다. 이것이 이 조건의 핵심이다. 전환이 재판정을 부르는가
  await run.segment('switch to P2', async () => {
    run.action('switch project', { name: 'P2' })
    await switchProject(livePage, 'P2')
    await measure(livePage, 'right after switching to P2', run, lateTabIds)
    run.action('watch', { ms: watchMs })
    await sleep(watchMs)
    await measure(livePage, 'after watch on P2', run, lateTabIds)
  })
}
