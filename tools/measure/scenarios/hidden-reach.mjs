import {
  activateSiblingTab,
  addTileFromUrl,
  bringDashboardToForeground,
  countRoundsByTile,
  createProject,
  dumpStorage,
  openDashboard,
  readTiles,
  switchProject,
} from '../dashboard.mjs'
import { observeRounds } from '../roundLines.mjs'
import { sleep } from '../runner.mjs'

//+_+// P6-D55. 시나리오 2호는 hidden 도달 실측이다
//+_+// ra-repro 는 활성 프로젝트가 타일 0개라 A-e1 을 검증하지 못한다
//+_+// 회차가 0 인 것이 Pause 때문인지 등록 타일이 없어서인지 그 관측으로 가를 수 없었다
//+_+// 여기서는 활성 프로젝트에 타일을 두고 hidden 을 만든다. 그것이 유일한 차이다
//+_+// P6-D24 · D45. 판정 문장을 쓰지 않는다. 구간 내 회차 행 수를 세어 그대로 싣는다
export const description =
  'hidden 도달. 활성 프로젝트에 타일을 둔 채 Dashboard 를 닫거나 배경으로 보낸다'

//+_+// 구간 경계를 양쪽으로 건다. 재개 뒤에 찍힌 행이 구간 안으로 섞이지 않게 한다
function windowOf(startedAt, endedAt, dump) {
  return {
    startedAt,
    endedAt,
    elapsedMs: endedAt - startedAt,
    workerStarts: dump.workerStarts,
    roundCountTotal: dump.roundCount,
    inWindow: countRoundsByTile(dump.rounds),
    observed: observeRounds(dump.rounds),
    //+_+// sched 토큰이 실린 형태를 보이기 위해 원문을 몇 줄 남긴다
    sampleLines: dump.rounds.slice(0, 3).map((row) => row.line),
  }
}

export async function run({ session, run, extensionId, config }) {
  const idleMs = config.watchMs ?? 120000
  const settleMs = config.settleMs ?? 20000
  //+_+// P6-D60 S2-2. 대조군은 활성 프로젝트에 타일을 두지 않는다. 그 밖은 같은 절차다
  const tileUrls = config.noTiles === true ? [] : config.tileUrls
  //+_+// S2-1 · S2-2 는 P1 만 쓴다. 긴 구간을 두 번 돌 이유가 없다
  const skipP2 = config.skipP2 === true

  let page = null
  let startsBefore = null

  await run.segment('setup A with tiles, active', async () => {
    page = await openDashboard(session, extensionId, run)
    run.action('create project', { name: 'A' })
    await createProject(page, 'A')
    await switchProject(page, 'A')
    for (const url of tileUrls) {
      run.action('add tile from url', { url })
      await addTileFromUrl(page, url)
    }
    run.dump('active tiles before the window', { count: tileUrls.length })
    run.action('settle', { ms: settleMs })
    await sleep(settleMs)

    //+_+// 구간에 들어가기 전에 회차가 실제로 돌고 있었다는 것을 남긴다. 대비가 없으면 0 을 읽을 수 없다
    run.dump('tiles after settle', await readTiles(page))
    const settled = await dumpStorage(page)
    startsBefore = settled.workerStarts
    run.dump('storage after settle', {
      roundCount: settled.roundCount,
      workerStarts: settled.workerStarts,
      reconnect: settled.reconnect,
      lastLines: settled.rounds.slice(-3).map((row) => row.line),
    })
  })

  //+_+// 구간 P1. Dashboard 페이지만 닫는다. 타일 탭은 열어 둔다
  //+_+// 구간 시작을 닫기 직전이 아니라 닫은 직후로 잡는다. 닫기 전의 회차가 구간 안으로 섞이면 0 을 읽을 수 없다
  let p1From = 0
  await run.segment(`P1 close dashboard, idle ${String(Math.round(idleMs / 1000))}s`, async () => {
    run.action('close dashboard', null)
    await page.close()
    p1From = Date.now()
    //+_+// P6-D22 · section 4. 이 구간에는 확장 페이지를 열지 않는다. 덤프도 하지 않는다
    run.action('no extension page open, no dump', { ms: idleMs })
    await sleep(idleMs)
  })
  const p1To = Date.now()

  await run.segment('P1 reopen and count', async () => {
    page = await openDashboard(session, extensionId, run)
    const dump = await dumpStorage(page, { sinceAt: p1From, untilAt: p1To })
    run.dump('P1 window', windowOf(p1From, p1To, dump))
    run.dump('P1 workerStarts delta', {
      before: startsBefore,
      after: dump.workerStarts,
    })
    run.dump('P1 tiles at reopen', await readTiles(page))
    run.dump('P1 reconnect rows', dump.reconnect)
  })

  if (skipP2) {
    return
  }

  //+_+// 구간 P2. Dashboard 는 열어 둔 채 다른 탭을 앞으로 가져온다. 탭 닫기와 다른 경로다
  let p2From = 0
  await run.segment(`P2 send to background, idle ${String(Math.round(idleMs / 1000))}s`, async () => {
    //+_+// 재개 직후의 회차가 P2 구간에 섞이지 않도록 구간 시작 전에 다시 돌게 둔다
    run.action('settle before backgrounding', { ms: settleMs })
    await sleep(settleMs)

    const activated = await activateSiblingTab(page)
    p2From = Date.now()
    run.action('activate sibling tab', activated)
    run.action('no dump while backgrounded', { ms: idleMs })
    await sleep(idleMs)
  })
  const p2To = Date.now()

  await run.segment('P2 foreground and count', async () => {
    const back = await bringDashboardToForeground(page)
    run.action('bring dashboard to foreground', back)
    const dump = await dumpStorage(page, { sinceAt: p2From, untilAt: p2To })
    run.dump('P2 window', windowOf(p2From, p2To, dump))
    run.dump('P2 tiles after foreground', await readTiles(page))
  })
}
