import {
  addTileFromUrl,
  dumpStorage,
  createProject,
  openDashboard,
  readTiles,
  switchProject,
} from '../dashboard.mjs'
import { observeRounds } from '../roundLines.mjs'
import { sleep } from '../runner.mjs'

//+_+// S1. 충돌 확인 게이트다 (P6-D23). Puppeteer 로 띄운 Chrome 에서 제품 캡처가 평소처럼 도는가
//+_+// 여기서 실패하면 이 하네스로는 아무것도 잴 수 없다. 그 사실을 확인하는 것이 첫 산출이다
export const description = 'Puppeteer 로 띄운 Chrome 에서 제품 캡처가 도는지 본다'

export async function run({ session, run, extensionId, config }) {
  const idleMs = config.waitMs ?? 120000

  const page = await run.segment('setup', async () => {
    run.action('open dashboard', { extensionId })
    const opened = await openDashboard(session, extensionId, run)
    run.action('create project', { name: 'S1' })
    await createProject(opened, 'S1')
    await switchProject(opened, 'S1')
    for (const url of config.tileUrls) {
      run.action('add tile from url', { url })
      await addTileFromUrl(opened, url)
    }
    run.dump('tiles after setup', await readTiles(opened))
    return opened
  })

  const idleFrom = Date.now()

  await run.segment(`idle ${String(Math.round(idleMs / 1000))}s`, async () => {
    run.dump('storage at idle start', await dumpStorage(page, { sinceAt: idleFrom }))
    run.action('wait', { ms: idleMs })
    await sleep(idleMs)
    run.dump('tiles at idle end', await readTiles(page))
    const dumped = await dumpStorage(page, { sinceAt: idleFrom })
    run.dump('storage at idle end', dumped)
    run.dump('rounds observed in idle window', observeRounds(dumped.rounds))
  })

  return { dashboardPage: page }
}
