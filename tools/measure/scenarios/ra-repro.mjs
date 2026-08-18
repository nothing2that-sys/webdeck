import {
  addTileFromUrl,
  createProject,
  dumpStorage,
  openDashboard,
  readTiles,
  switchProject,
} from '../dashboard.mjs'
import { observeRounds } from '../roundLines.mjs'
import { sleep } from '../runner.mjs'

//+_+// P6-D26. 시나리오 1호는 R-a 재현이었다. P6-D45 로 기대를 반전했다
//+_+// TASK-P6-02 의 C 수정 전에는 A 의 두 타일이 DETACHED 로 굳고 전환 뒤 회차가 0 이었다
//+_+// P6-D53 이 reconnect 을 전 프로젝트로 넓힌 뒤에는 두 타일이 복구되고 회차가 돌아야 한다
//+_+// P6-D24 · P6-D45. 여기서 pass / fail 을 정하지 않는다. 관측만 내고 판정은 사람이 한다
export const description =
  'R-a 회귀. 워커 재기동 뒤 비활성 프로젝트 타일이 복구되고 회차가 도는가 (P6-D53 이후)'

export async function run({ session, run, extensionId, config }) {
  const deathMs = config.deathWaitMs ?? 300000
  const watchMs = config.watchMs ?? 120000
  const settleMs = config.settleMs ?? 20000

  await run.segment('setup A(2 tiles) B(0 tiles)', async () => {
    const page = await openDashboard(session, extensionId, run)
    run.action('create project', { name: 'A' })
    await createProject(page, 'A')
    await switchProject(page, 'A')
    for (const url of config.tileUrls) {
      run.action('add tile from url', { url })
      await addTileFromUrl(page, url)
    }
    //+_+// 전환 전에 두 타일이 실제로 LIVE 였다는 것을 남긴다. 재기동 뒤의 상태와 대조할 기준이다
    run.action('settle', { ms: settleMs })
    await sleep(settleMs)
    run.dump('tiles in A after settle', await readTiles(page))

    run.action('create project', { name: 'B' })
    await createProject(page, 'B')
    await switchProject(page, 'B')
    run.dump('tiles in B', await readTiles(page))
    run.dump('storage before close', await dumpStorage(page))

    run.action('close dashboard', null)
    await page.close()
  })

  const deathFrom = Date.now()

  await run.segment(`wait for worker death ${String(Math.round(deathMs / 1000))}s`, async () => {
    //+_+// P6-D22. 이 구간에는 아무 확장 페이지도 열려 있지 않다. storage 도 읽지 않는다
    run.action('no extension page open, no dump', { ms: deathMs })
    await sleep(deathMs)
  })

  await run.segment('reopen dashboard and switch to A', async () => {
    const page = await openDashboard(session, extensionId, run)
    const reopened = await dumpStorage(page, { sinceAt: deathFrom })
    run.dump('storage at reopen', reopened)
    run.dump('rounds while dashboard was closed', observeRounds(reopened.rounds))

    run.action('switch project', { name: 'A' })
    await switchProject(page, 'A')
    const switchedAt = Date.now()
    run.dump('tiles right after switch', await readTiles(page))

    run.action('watch', { ms: watchMs })
    await sleep(watchMs)

    //+_+// 여기가 반전된 자리다. 수정 전에는 DETACHED 두 개와 회차 0 이 재현 성공이었다
    //+_+// 수정 뒤에는 탭이 살아 있는 타일이 복구되고 이 회차 수가 0 보다 커야 회귀 통과다
    run.dump('tiles after watch', await readTiles(page))
    const watched = await dumpStorage(page, { sinceAt: switchedAt })
    run.dump('storage after watch', watched)
    run.dump('rounds after switch', observeRounds(watched.rounds))

    //+_+// D40 의 U1 이다. 재기동 뒤 첫 회차가 rounds 저장값에 이어 붙는지 본다
    //+_+// 1차 실행은 재기동 뒤 회차가 0건이라 이 경로를 밟지 않았다
    run.dump('U1 round count across the restart', {
      atReopen: reopened.roundCount,
      afterWatch: watched.roundCount,
      grew: watched.roundCount > reopened.roundCount,
    })
  })
}
