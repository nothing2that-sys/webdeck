import {
  addTileFromUrl,
  dumpStorage,
  openDashboard,
  pollTiles,
  readDiagnostics,
  readTiles,
  refreshSelectedPreview,
  selectTile,
  createProject,
  switchProject,
} from '../dashboard.mjs'
import { observeRounds } from '../roundLines.mjs'
import { sleep } from '../runner.mjs'

//+_+// TASK-P7-21 조건 1. L21 · L42 다. 정지 화면 배경 탭에서 회차가 도는가
//+_+// L21 이 "반환되지 않는다" 를 적었으므로 타임아웃 수가 핵심 관측이다
//+_+// L42 는 같은 조건에서 Refresh Preview 가 실패한다고 적었다. 그것을 눌러 본다
//+_+// 픽스처는 --page 로 고른다. 대조는 --page live-counter.html 이다
//+_+// 타일 탭은 워커가 chrome.tabs.create({active:false}) 로 만든다 (serviceWorker.ts)
//+_+// 그래서 Dashboard 를 전경에 둔 채로 타일 탭이 배경이 된다. 조건이 그것이다
//+_+// P6-D24 · D45. 판정 문장을 쓰지 않는다. 관측값만 낸다
export const description =
  '조건 1. 정지 화면 배경 탭의 회차와 Refresh Preview. --page 로 픽스처를 고른다'

//+_+// 회차 로그를 구간으로 잘라 관측만 낸다. 타임아웃은 outcome 별 집계에 들어 있다
function windowOf(label, startedAt, endedAt, dump) {
  return {
    label,
    startedAt,
    endedAt,
    elapsedMs: endedAt - startedAt,
    roundCountTotal: dump.roundCount,
    observed: observeRounds(dump.rounds),
    //+_+// 소요 분포다. 평균을 내지 않는다. L21 · L22 가 이봉형을 적었으므로 값을 늘어놓는다
    durationsMs: dump.rounds
      .map((row) => /took (\d+)ms/.exec(row.line))
      .filter((match) => match !== null)
      .map((match) => Number(match[1])),
    lines: dump.rounds.map((row) => row.line),
  }
}

export async function run({ session, run, extensionId, config }) {
  const settleMs = config.settleMs ?? 20000
  const watchMs = config.watchMs ?? 120000
  const pollMs = config.pollMs ?? 1000
  const pollCount = config.pollCount ?? 10
  const url = config.tileUrls[0]
  if (url === undefined) {
    throw new Error('--tiles 1 이상이 필요하다')
  }
  run.log(`fixture ${String(config.fixturePage)} · watch ${String(Math.round(watchMs / 1000))}s`)

  let page = null
  let watchFrom = 0

  await run.segment('setup one tile, dashboard in the foreground', async () => {
    page = await openDashboard(session, extensionId, run)
    run.action('create project', { name: 'STATIC' })
    await createProject(page, 'STATIC')
    await switchProject(page, 'STATIC')
    run.action('add tile from url', { url })
    await addTileFromUrl(page, url)
    run.action('settle', { ms: settleMs })
    await sleep(settleMs)
    run.dump('tiles after settle', await readTiles(page))
    run.dump('diagnostics after settle', await readDiagnostics(page))
    watchFrom = Date.now()
  })

  //+_+// 2단계다. Dashboard 를 전경에 둔 채 회차만 지켜본다. 배경으로 보내지 않는다
  await run.segment(`watch rounds ${String(Math.round(watchMs / 1000))}s`, async () => {
    run.action('watch with the dashboard in the foreground', { ms: watchMs })
    await sleep(watchMs)
  })
  const watchTo = Date.now()

  await run.segment('read the watch window', async () => {
    const dump = await dumpStorage(page, { sinceAt: watchFrom, untilAt: watchTo })
    run.dump('watch window', windowOf('watch', watchFrom, watchTo, dump))
    run.dump('diagnostics after watch', await readDiagnostics(page))
    //+_+// 배지와 아래 줄 시각이 움직이는지는 열로만 보인다
    run.dump('tile poll during the watch tail', await pollTiles(page, pollCount, pollMs))
  })

  //+_+// 3단계다. L42 가 적은 자리다. Refresh Preview 를 누르고 전후를 나란히 낸다
  await run.segment('refresh preview', async () => {
    await selectTile(page, 0)
    const before = await readTiles(page)
    const beforeDiag = await readDiagnostics(page)
    const pressedAt = Date.now()
    run.action('click Refresh Preview', null)
    await refreshSelectedPreview(page)
    //+_+// 5초 타임아웃보다 넉넉히 기다린다. 실패도 그 안에 정산된다
    const after = await pollTiles(page, pollCount, pollMs)
    const afterDiag = await readDiagnostics(page)
    const dump = await dumpStorage(page, { sinceAt: pressedAt })
    run.dump('refresh preview', {
      pressedAt,
      //+_+// L42 가 previewLength 와 아래 줄 시각으로 드러난다고 적었다. 둘을 함께 낸다
      before: before.map((tile) => ({
        status: tile.status,
        lastCaptureLabel: tile.lastCaptureLabel,
        previewLength: tile.previewLength,
        previewTail: tile.previewTail,
      })),
      after,
      diagnostics: { before: beforeDiag, after: afterDiag },
      roundsAfterPress: windowOf('after refresh', pressedAt, Date.now(), dump),
    })
    //+_+// 하단 상태줄에 CAPTURE_FAILED 가 실리는 자리다. 문구를 그대로 낸다
    run.dump('status line after refresh', await page.$eval('footer.statusbar', (node) => node.textContent ?? ''))
  })
}
