import {
  activateSiblingTab,
  addTileFromTab,
  addTileFromUrl,
  countStoredTiles,
  bringDashboardToForeground,
  closeTabs,
  createProject,
  dumpStorage,
  findTabsByUrl,
  openDashboard,
  readDebuggerTargets,
  readDiagnostics,
  readPauseState,
  readTiles,
  setPreviewPaused,
  switchProject,
  tileOrder,
  tileTabIds,
} from '../dashboard.mjs'
import { sleep } from '../runner.mjs'

//+_+// L49. 같은 탭에 건 타일 둘 중 하나만 복구된다. 1회 관측이고 재현되지 않았다
//+_+// TASK-P7-08 section 5.1 의 T1 ~ T4 를 따로 잰다
//+_+//   T1 저장된 타일 수  ·  T2 reconnect 판정  ·  T3 attach 수  ·  T4 타일 상태
//+_+// P6-D24 · D45 · D63 · D72. 여기서 pass / fail 을 정하지 않는다. 값만 낸다
//+_+// P27. 원 관측은 chrome://extensions 새로고침이고 이것은 워커 재기동이다. 둘을 같다고 쓰지 않는다
//+_+// reconnect() 를 부르는 유일한 경로가 워커 기동이라는 것만 근거로 삼는다 (TASK-P7-07 B-4)
export const description =
  'L49 조건. 같은 탭에 건 타일 둘이 워커 재기동 뒤 어떻게 되는가. --only control 이 대조군이다'

//+_+// 조건마다 프로필을 새로 쓴다. reconnect 는 전 프로젝트의 타일을 한 번에 판정하므로
//+_+// 한 프로세스에서 두 조건을 이어 돌리면 앞 조건의 타일이 뒤 조건의 T1 · T2 에 섞인다 (P6-D53)
//+_+// TASK-P7-10. cross-A · cross-B 가 교차 프로젝트 조건이다
//+_+// 사람 Chrome 이 낸 등록 타일 0 은 비활성 프로젝트 타일이 전역 taken 의 승자였을 때 나온다
//+_+// 두 조건은 P1 과 P2 의 생성 순서만 다르다.  그 차이가 승자를 정하는 축을 가른다
const CONDITIONS = new Set(['same', 'control', 'cross-A', 'cross-B'])
const CROSS = new Set(['cross-A', 'cross-B'])

//+_+// TASK-P7-10 section 5.2. 교차 프로젝트 조건이다. 탭 하나에 타일 셋을 걸고 프로젝트를 둘로 나눈다
//+_+//   P1  타일 하나.  끝에는 비활성이다
//+_+//   P2  같은 탭에 타일 둘.  끝에는 활성이다
//+_+// cross-A 는 P1 을 먼저 만들고 cross-B 는 P2 를 먼저 만든다. 그 순서만 다르다
//+_+// 저장 배열 순서가 곧 워커 reconnect() 의 owners 순서다. 승자를 정하는 축이 그것인지 본다
async function setupCross(page, run, only, url1) {
  const first = only === 'cross-A' ? 'P1' : 'P2'
  const second = only === 'cross-A' ? 'P2' : 'P1'
  run.action('create project', { name: first, note: 'created first' })
  await createProject(page, first)
  await switchProject(page, first)

  //+_+// 탭은 워커가 만든다. 하네스가 타일 탭에 붙지 않는다
  run.action('add tile from url', { url: url1, project: first })
  await addTileFromUrl(page, url1)
  const seeded = tileTabIds(await readTiles(page))
  const tabId = seeded[0]?.tabId
  if (typeof tabId !== 'number') {
    throw new Error(`첫 타일의 탭 번호를 읽지 못했다: ${JSON.stringify(seeded)}`)
  }
  run.dump('seed tile and tab', { project: first, tiles: seeded })

  //+_+// P2 는 타일 둘이고 P1 은 하나다. 먼저 만든 프로젝트가 어느 쪽인지에 따라 채우는 수가 다르다
  if (first === 'P2') {
    run.action('add tile from the same tab', { tabId, project: 'P2' })
    run.dump('add tile from tab', await addTileFromTab(page, tabId))
  }

  run.action('create project', { name: second, note: 'created second' })
  await createProject(page, second)
  await switchProject(page, second)
  const need = second === 'P2' ? 2 : 1
  for (let index = 0; index < need; index += 1) {
    run.action('add tile from the same tab', { tabId, project: second, index })
    run.dump('add tile from tab', await addTileFromTab(page, tabId))
  }

  //+_+// 끝에는 늘 P2 가 활성이다. 조건 정의가 그렇다
  run.action('switch project', { name: 'P2', note: 'active at the end' })
  await switchProject(page, 'P2')
  run.dump('cross setup done', { createdFirst: first, tabId })
}

//+_+// T1 · T3 · T4 를 한 자리에서 읽는다. 판정하지 않고 원값을 그대로 담는다
async function measure(page, label, run, tabIds) {
  const tiles = await readTiles(page)
  const storage = await dumpStorage(page)
  const targets = tabIds === null ? null : await readDebuggerTargets(page, tabIds)
  //+_+// 한 번만 읽는다. 두 번 읽으면 같은 시점의 값이 아니게 된다
  const diag = await readDiagnostics(page)
  const value = {
    label,
    at: Date.now(),
    //+_+// T1. 화면 타일 수와 저장 타일 수는 다른 축이다. 둘 다 낸다
    T1: {
      onScreen: tiles.length,
      stored: countStoredTiles(storage.state),
    },
    //+_+// T2. 워커 기동마다 쌓인다. 구간을 자르지 않고 전량을 낸다
    T2: { reconnect: storage.reconnect },
    //+_+// T3. attached 는 그 타깃에 디버거 클라이언트가 붙어 있는지다. 붙인 주체는 말하지 않는다
    T3:
      targets === null
        ? null
        : {
            totalTargets: targets.totalTargets,
            attachedCount: targets.tabs.filter((tab) => tab.attached).length,
            tabs: targets.tabs,
          },
    //+_+// T4. 배지와 탭 번호를 함께 낸다. 어느 타일이 어느 탭을 잡았는지가 조건의 일부다
    T4: { tiles, tabIds: tileTabIds(tiles) },
    //+_+// Diagnostics 바의 '등록 타일' 과 'attach' 다. 사람이 화면에서 읽는 숫자와 같은 축이다
    //+_+// T1 의 저장 타일 수와 다른 값이므로 둘을 나란히 남긴다
    diagnostics: diag,
    //+_+// T5. 회차가 도는지의 지표다. Diagnostics 의 recordLogs 에서 captureRecords 를 집는다
    T5: {
      captureRecords: diag?.recordLogs?.find((log) => log.name === 'captureRecords') ?? null,
      roundCount: storage.roundCount,
    },
    //+_+// TASK-P7-10. 승자를 정하는 것이 배열 순서인지 보려면 그 순서를 남겨야 한다
    order: tileOrder(storage.state),
    workerStarts: storage.workerStarts,
    pause: await readPauseState(page),
  }
  run.dump(`measure ${label}`, value)
  return value
}

export async function run({ session, run, extensionId, config }) {
  const only = config.only === '' || config.only === undefined || config.only === null ? 'same' : config.only
  if (!CONDITIONS.has(only)) {
    throw new Error(`--only 는 ${[...CONDITIONS].join(' | ')} 중 하나다: ${String(only)}`)
  }
  const deathMs = config.deathWaitMs ?? 300000
  const settleMs = config.settleMs ?? 20000
  const watchMs = config.watchMs ?? 20000
  const [url1, url2] = config.tileUrls
  if (url2 === undefined) {
    throw new Error('--tiles 2 이상이 필요하다. 대조군이 두 URL 을 쓴다')
  }

  const isCross = CROSS.has(only)
  //+_+// P7-D47. 두 사망 경로다. closeTab 이 새 것이고 emptyActive 가 옛 것이다
  //+_+// closeTab 은 공유 탭을 닫아 리스를 푼다. 프로젝트 전환을 안 하므로 활성 프로젝트가 유지된다
  //+_+// emptyActive 는 0타일 프로젝트로 전환한다. 그래서 reconnect 시점에 활성 타일이 하나도 없다
  const closeTabPath = config.closeTab === true
  const emptyPath = !closeTabPath && (config.emptyActive === true || isCross)
  //+_+// 재기동 뒤 활성으로 되돌릴 프로젝트다. cross 는 타일 둘이 든 P2 다
  const mainProject = isCross ? 'P2' : 'L49'
  run.log(`condition ${only} · death ${String(Math.round(deathMs / 1000))}s`)

  let tabIds = null
  let before = null
  let closedUrls = []

  await run.segment(`setup ${only}`, async () => {
    const page = await openDashboard(session, extensionId, run)

    if (isCross) {
      await setupCross(page, run, only, url1)
    } else {
      run.action('create project', { name: 'L49' })
      await createProject(page, 'L49')
      await switchProject(page, 'L49')

      //+_+// 첫 타일은 두 조건 모두 URL 경로다. 탭 생성은 워커가 한다
      run.action('add tile from url', { url: url1 })
      await addTileFromUrl(page, url1)
      const first = tileTabIds(await readTiles(page))
      run.dump('tile 1 tab', first)

      if (only === 'same') {
        //+_+// 같은 탭에 두 번째 타일을 건다. 제품에 중복 탭 검사가 없어 성립한다
        const tabId = first[0]?.tabId
        if (typeof tabId !== 'number') {
          throw new Error(`첫 타일의 탭 번호를 읽지 못했다: ${JSON.stringify(first)}`)
        }
        run.action('add tile from the same tab', { tabId })
        run.dump('add tile from tab', await addTileFromTab(page, tabId))
      } else {
        run.action('add tile from url', { url: url2 })
        await addTileFromUrl(page, url2)
      }
    }

    run.action('settle', { ms: settleMs })
    await sleep(settleMs)

    const settled = tileTabIds(await readTiles(page))
    tabIds = settled.map((entry) => entry.tabId).filter((id) => typeof id === 'number')
    run.dump('tab ids under measure', { tabIds, tiles: settled })
    before = await measure(page, 'before restart', run, tabIds)

    //+_+// ra-repro 가 쓰는 워커 사망 경로다. 활성 프로젝트를 0타일로 두면 attach 가 풀린다
    //+_+// attach 가 남아 있으면 워커가 600초 넘게 산다 (P6-D65). 닫고 기다리는 것만으로는 죽지 않는다
    //+_+// 이 전환은 관측 조건을 바꾼다. reconnect 시점에 L49 타일이 비활성이 되고
    //+_+// 비활성 프로젝트는 bindOnly 라서 attach 를 되돌리지 않는다 (P6-D53)
    if (emptyPath) {
      run.action('create project', { name: 'EMPTY' })
      await createProject(page, 'EMPTY')
      await switchProject(page, 'EMPTY')
      run.dump('tiles in EMPTY', await readTiles(page))
    }

    //+_+// P7-D47 의 1단계다. Dashboard 가 아직 열려 있을 때만 chrome.tabs.remove 를 부를 수 있다
    if (closeTabPath) {
      const wanted = [...new Set(tabIds)]
      run.action('close the shared tabs', { tabIds: wanted })
      const closed = await closeTabs(page, wanted)
      run.dump('closed tabs', closed)
      closedUrls = closed.closed.map((entry) => entry.url)
      run.dump('tiles right after closing the tabs', await readTiles(page))
    }

    run.action('close dashboard', null)
    await page.close()
  })

  const deathFrom = Date.now()

  await run.segment(`wait for worker death ${String(Math.round(deathMs / 1000))}s`, async () => {
    //+_+// P6-D22. 이 구간에는 아무 확장 페이지도 열려 있지 않다. storage 도 읽지 않는다
    run.action('no extension page open, no dump', { ms: deathMs })
    await sleep(deathMs)
  })

  let livePage = null

  //+_+// P7-D47 의 4단계다. 5단계보다 먼저 한다. 탭이 없으면 후보가 없어 전부 none 이 된다
  //+_+// 확장 페이지를 열지 않고 브라우저 수준 CDP 로 만든다. Puppeteer 는 이 탭에 붙지 않는다
  if (closeTabPath && closedUrls.length > 0) {
    await run.segment('reopen the shared tabs before the dashboard', async () => {
      for (const url of closedUrls) {
        run.dump('reopened bare tab', await session.openBareTab(url))
      }
      run.action('settle after reopening the tabs', { ms: settleMs })
      await sleep(settleMs)
    })
  }

  await run.segment('reopen and read', async () => {
    const page = await openDashboard(session, extensionId, run)
    livePage = page
    //+_+// 다시 연 탭은 번호가 바뀐다. 픽스처 URL 로 새 번호를 찾아 T3 의 입력을 갈아 준다
    if (closeTabPath && closedUrls.length > 0) {
      const found = await findTabsByUrl(page, closedUrls)
      run.dump('tab ids after reopening', found)
      const refreshed = found.map((entry) => entry.tabId).filter((id) => typeof id === 'number')
      if (refreshed.length > 0) {
        tabIds = refreshed
      }
    }
    const after = await measure(page, 'after reopen', run, tabIds)

    //+_+// 워커가 실제로 다시 떴는지가 reconnect 가 돌았는지의 유일한 단조 관측점이다
    //+_+// 재기동이 없었으면 reconnect() 가 불리지 않았고 T2 는 앞 회차의 행 그대로다
    run.dump('worker restart across the window', {
      deathFrom,
      startsBefore: before?.workerStarts ?? null,
      startsAfter: after.workerStarts,
    })

    //+_+// 비활성으로 두고 죽인 경우에만 되돌린다. 전환이 reregister 를 부르는 자리다
    if (emptyPath) {
      run.action('switch project', { name: mainProject })
      await switchProject(page, mainProject)
      await measure(page, `after switch to ${mainProject}`, run, tabIds)
    }

    run.action('watch', { ms: watchMs })
    await sleep(watchMs)
    await measure(page, 'after watch', run, tabIds)

    //+_+// L49 본문이 "Pause 를 끄면 LIVE 가 된다" 고 적은 자리다
    run.action('pause off', null)
    run.dump('pause toggle', await setPreviewPaused(page, false))
    run.action('settle after pause off', { ms: settleMs })
    await sleep(settleMs)
    await measure(page, 'after pause off', run, tabIds)
  })

  //+_+// TASK-P7-10 section 5.3. T6 이다. cross-A 에서만 한 번 더 잰다
  //+_+// hidden-reach 가 쓰는 경로다. 같은 창의 다른 탭을 앞으로 가져와 Dashboard 를 배경으로 만든다
  //+_+// hidden 이면 Pause 로 가는 것이 기본값이다 (P6-D6b). 실제로 켜지는지가 이 축이다
  if (only !== 'cross-A' || livePage === null) {
    return
  }
  await run.segment('T6 hidden then pause', async () => {
    const page = livePage
    run.action('settle before backgrounding', { ms: settleMs })
    await sleep(settleMs)

    const activated = await activateSiblingTab(page)
    run.action('activate sibling tab', activated)
    if (activated?.ok !== true) {
      //+_+// 배경으로 못 보냈으면 이 축을 못 잰 것이다. 만들 수 없었다고 남기고 끝낸다
      run.dump('T6 not reachable', { reason: 'activateSiblingTab failed', activated })
      return
    }
    run.action('stay backgrounded, no dump', { ms: settleMs })
    await sleep(settleMs)

    const back = await bringDashboardToForeground(page)
    run.action('bring dashboard to foreground', back)
    const state = await readPauseState(page)
    run.dump('T6 pause after hidden', state)

    if (state.buttonLabel !== 'Pause Preview · on') {
      //+_+// 안 켜졌으면 그 사실만 남기고 10단계를 건너뛴다
      run.dump('T6 pause did not turn on', { buttonLabel: state.buttonLabel, storedPaused: state.storedPaused })
      await measure(page, 'T6 hidden returned, pause off already', run, tabIds)
      return
    }
    await measure(page, 'T6 pause on', run, tabIds)
    run.action('pause off after hidden', null)
    run.dump('T6 pause toggle', await setPreviewPaused(page, false))
    run.action('settle after pause off', { ms: settleMs })
    await sleep(settleMs)
    await measure(page, 'T6 after pause off', run, tabIds)
  })
}
