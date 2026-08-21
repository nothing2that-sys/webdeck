import {
  activateSiblingTab,
  addTileFromUrl,
  bringDashboardToForeground,
  countRoundsByTile,
  createProject,
  dumpStorage,
  openDashboard,
  pollTiles,
  readDiagnostics,
  readPauseState,
  readTiles,
  switchProject,
} from '../dashboard.mjs'
import { observeRounds } from '../roundLines.mjs'
import { sleep } from '../runner.mjs'

//+_+// TASK-P7-21 조건 3. L50 이다. hidden 이 켜진 상태의 타일 표시를 잰다
//+_+// TASK-P7-10 의 T6 는 그때 등록 타일이 0 이었다. 그래서 볼 것이 없었다
//+_+// 여기서는 타일 둘을 서로 다른 탭에 걸고 둘 다 LIVE 로 만든 뒤 배경으로 보낸다
//+_+// 그것이 T6 와 다른 유일한 점이다
//+_+// P6-D22 · P6-D55. 배경 구간에는 덤프하지 않는다. 구간 경계를 양쪽으로 걸어 뒤에 센다
//+_+// P6-D24 · D45. 판정 문장을 쓰지 않는다
export const description =
  '조건 3. 등록 타일이 0 이 아닌 상태에서 hidden 을 만든다. 표시와 회차를 잰다 (L50)'

export async function run({ session, run, extensionId, config }) {
  const settleMs = config.settleMs ?? 20000
  const hiddenMs = config.watchMs ?? 60000
  const pollMs = config.pollMs ?? 500
  const pollCount = config.pollCount ?? 20
  if (config.tileUrls.length < 2) {
    throw new Error('--tiles 2 이상이 필요하다. 타일 둘을 서로 다른 탭에 건다')
  }

  let page = null
  let beforeDiag = null

  //+_+// 1단계다. 타일 둘을 각각 다른 탭에 건다. addTileFromUrl 은 호출마다 워커가 탭을 새로 만든다
  await run.segment('setup two tiles on two tabs, both live', async () => {
    page = await openDashboard(session, extensionId, run)
    run.action('create project', { name: 'HIDDEN' })
    await createProject(page, 'HIDDEN')
    await switchProject(page, 'HIDDEN')
    for (const url of config.tileUrls) {
      run.action('add tile from url', { url })
      await addTileFromUrl(page, url)
    }
    run.action('settle', { ms: settleMs })
    await sleep(settleMs)
    //+_+// 등록 타일이 0 이 아니었다는 것을 남긴다. 그것이 T6 와 갈리는 자리다
    beforeDiag = await readDiagnostics(page)
    run.dump('tiles before backgrounding', await readTiles(page))
    run.dump('diagnostics before backgrounding', beforeDiag)
    run.dump('pause state before backgrounding', await readPauseState(page))
    const settled = await dumpStorage(page)
    run.dump('storage before backgrounding', {
      roundCount: settled.roundCount,
      workerStarts: settled.workerStarts,
      lastLines: settled.rounds.slice(-3).map((row) => row.line),
    })
  })

  //+_+// 2단계다. 형제 탭을 활성으로 만들어 Dashboard 를 배경으로 보낸다
  let hiddenFrom = 0
  await run.segment(`hidden for ${String(Math.round(hiddenMs / 1000))}s`, async () => {
    const activated = await activateSiblingTab(page)
    hiddenFrom = Date.now()
    run.action('activate sibling tab', activated)
    if (activated?.ok !== true) {
      run.dump('not reachable', { reason: 'activateSiblingTab failed', activated })
      return
    }
    run.action('stay backgrounded, no dump', { ms: hiddenMs })
    await sleep(hiddenMs)
  })
  const hiddenTo = Date.now()

  //+_+// 3단계다. 돌아온 즉시부터 배지 열을 집는다. LOADING 을 거치는지는 열로만 보인다
  await run.segment('foreground and read', async () => {
    const back = await bringDashboardToForeground(page)
    const backAt = Date.now()
    run.action('bring dashboard to foreground', back)
    //+_+// 먼저 배지를 집는다. Pause 상태 읽기가 앞서면 첫 표본이 늦어진다
    const poll = await pollTiles(page, pollCount, pollMs)
    run.dump('tile poll right after foreground', { backAt, ...poll })
    run.dump('pause state after foreground', await readPauseState(page))
    run.dump('diagnostics after foreground', await readDiagnostics(page))

    //+_+// 배경 구간의 회차다. 경계를 양쪽으로 건다. 재개 뒤의 행이 구간 안으로 섞이면 0 을 읽을 수 없다
    const dump = await dumpStorage(page, { sinceAt: hiddenFrom, untilAt: hiddenTo })
    run.dump('hidden window', {
      startedAt: hiddenFrom,
      endedAt: hiddenTo,
      elapsedMs: hiddenTo - hiddenFrom,
      roundCountTotal: dump.roundCount,
      inWindow: countRoundsByTile(dump.rounds),
      observed: observeRounds(dump.rounds),
      sampleLines: dump.rounds.slice(0, 3).map((row) => row.line),
    })
    //+_+// captureRecords 의 증가다. 배열 상한이 200 이므로 길이만으로 누적을 읽지 않는다 (P6-D112)
    run.dump('captureRecords across the window', {
      before: beforeDiag?.recordLogs?.find((log) => log.name === 'captureRecords') ?? null,
      after:
        (await readDiagnostics(page))?.recordLogs?.find((log) => log.name === 'captureRecords') ??
        null,
      sampleLimit: beforeDiag?.sampleLimit ?? null,
    })
  })
}
