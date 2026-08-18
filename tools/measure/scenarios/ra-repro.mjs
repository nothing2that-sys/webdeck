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

//+_+// P6-D26. 시나리오 1호는 R-a 재현이다
//+_+// 비활성 프로젝트의 타일이 워커 재기동 뒤 복구되지 않는 것을 관측한다
//+_+// 고치기 전이므로 실패하는 관측이 나오는 것이 정상이다. TASK-P6-02 의 수정 대상이다
export const description = 'R-a 재현. 워커 재기동 뒤 비활성 프로젝트 타일이 복구되는가'

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
    //+_+// 전환 전에 두 타일이 실제로 LIVE 였다는 것을 남긴다. 그래야 뒤의 DETACHED 가 대비된다
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

    run.dump('tiles after watch', await readTiles(page))
    const watched = await dumpStorage(page, { sinceAt: switchedAt })
    run.dump('storage after watch', watched)
    run.dump('rounds after switch', observeRounds(watched.rounds))
  })
}
