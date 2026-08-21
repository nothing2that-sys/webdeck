import {
  addTileFromTab,
  bringDashboardToForeground,
  createProject,
  dumpStorage,
  findTabsByUrl,
  openDashboard,
  pollTiles,
  readDebuggerTargets,
  readDiagnostics,
  readTiles,
  switchProject,
} from '../dashboard.mjs'
import { observeRounds } from '../roundLines.mjs'
import { sleep } from '../runner.mjs'

//+_+// TASK-P7-21 조건 4. L47 · L24 다. attach 실패를 만들 경로를 찾는다
//+_+// 하네스가 타일 탭의 페이지 타깃에 먼저 CDP 로 붙은 뒤 그 탭에 타일을 건다
//+_+// L47 Phase 6 갱신이 반대 순서를 실측했다 — chrome.debugger 가 먼저면 DevTools 가 뺏지 않는다
//+_+// 이 회차는 그 반대다. 다른 클라이언트가 먼저 붙은 탭에 chrome.debugger.attach 를 시도한다
//+_+// P6-D22 는 그대로다. 여기서 붙는 것은 page 타깃 하나뿐이고 서비스 워커 타깃에는 붙지 않는다
//+_+// decideTarget 은 고치지 않았다. Target.attachToTarget 이 targetFilter 를 지나지 않는다
//+_+// P6-D24 · D45. 판정 문장을 쓰지 않는다. 붙어도 결과이고 안 붙어도 결과다
export const description =
  '조건 4. 하네스가 먼저 붙은 탭에 타일을 건다. 제품의 attach 가 실패하는가 (L47 · L24)'

//+_+// attachFailures 는 GET_DIAGNOSTICS 에 길이만 실린다. 원문 문자열은 응답에 없다
//+_+// 회차 로그의 outcome 이 attachFailed 로 남는 것이 하네스가 볼 수 있는 다른 쪽 축이다
async function measure(page, label, run, tabIds, sinceAt) {
  const diag = await readDiagnostics(page)
  const storage = await dumpStorage(page, { sinceAt })
  const value = {
    label,
    at: Date.now(),
    tiles: await readTiles(page),
    //+_+// recordLogs 의 attachFailures 다. 길이만이다. 실패 사유 원문은 이 경로에 없다
    attachFailures: diag?.recordLogs?.find((log) => log.name === 'attachFailures') ?? null,
    detachEvents: diag?.recordLogs?.find((log) => log.name === 'detachEvents') ?? null,
    diagnostics: diag,
    //+_+// outcome 별 집계다. attachFailed 가 여기 잡힌다
    rounds: observeRounds(storage.rounds),
    roundLines: storage.rounds.map((row) => row.line),
    targets: tabIds.length === 0 ? null : await readDebuggerTargets(page, tabIds),
  }
  run.dump(`measure ${label}`, value)
  return value
}

export async function run({ session, run, extensionId, config }) {
  const settleMs = config.settleMs ?? 20000
  const watchMs = config.watchMs ?? 90000
  const pollMs = config.pollMs ?? 2000
  const pollCount = config.pollCount ?? 10
  const url = config.tileUrls[0]
  if (url === undefined) {
    throw new Error('--tiles 1 이상이 필요하다')
  }

  let page = null
  let held = null
  let tabIds = []
  let gate = null

  try {
    //+_+// 1단계다. 탭을 열고 하네스가 그 페이지 타깃에 세션을 잡는다
    await run.segment('open a tab and hold a CDP session on it', async () => {
      page = await openDashboard(session, extensionId, run)
      run.action('create project', { name: 'CONFLICT' })
      await createProject(page, 'CONFLICT')
      await switchProject(page, 'CONFLICT')

      const bare = await session.openBareTab(url)
      run.dump('opened bare tab', bare)
      //+_+// Target.createTarget 은 그 탭을 활성으로 만든다. 그러면 Dashboard 가 배경이 되고
      //+_+// 화면이 갱신되지 않아 타일이 DOM 에 나타나지 않는다. 1차 실행이 여기서 20초 만료로 죽었다
      //+_+// 이 조건이 묻는 것은 attach 이고 전경 / 배경이 아니다. 되돌려 놓고 잰다
      run.dump('bring dashboard to foreground', await bringDashboardToForeground(page))
      run.action('settle after opening the tab', { ms: settleMs })
      await sleep(settleMs)

      const found = await findTabsByUrl(page, [url])
      run.dump('the tab under conflict', found)
      tabIds = found.map((entry) => entry.tabId).filter((id) => typeof id === 'number')
      if (tabIds.length === 0) {
        throw new Error(`탭 번호를 찾지 못했다: ${url}`)
      }

      //+_+// 게이트의 첫 절반이다. 하네스가 실제로 붙었는지를 확장 쪽에서 확인한다
      const beforeHold = await readDebuggerTargets(page, tabIds)
      run.dump('debugger targets before the harness attaches', beforeHold)
      held = await session.holdBareTarget(bare.targetId)
      run.dump('harness holds the page target', { targetId: held.targetId, sessionId: held.sessionId })
      const afterHold = await readDebuggerTargets(page, tabIds)
      run.dump('debugger targets after the harness attaches', afterHold)
      gate = {
        //+_+// attached 는 그 타깃에 디버거 클라이언트가 붙어 있는지다. 붙인 주체는 말하지 않는다
        harnessSessionId: held.sessionId,
        attachedBeforeHold: beforeHold.tabs.map((tab) => tab.attached),
        attachedAfterHold: afterHold.tabs.map((tab) => tab.attached),
      }
      run.dump('gate first half', gate)
    })

    const boundAt = Date.now()

    //+_+// 2단계다. 그 탭에 타일을 건다. 제품이 이제 같은 탭에 chrome.debugger.attach 를 시도한다
    await run.segment('bind a tile to that tab', async () => {
      const tabId = tabIds[0]
      run.action('add tile from tab', { tabId })
      run.dump('add tile from tab', await addTileFromTab(page, tabId))
      await measure(page, 'right after binding', run, tabIds, boundAt)
    })

    //+_+// 3단계다. 누적 3회에 닿아야 ERROR 로 간다 (MAX_ATTACH_ATTEMPTS). 계단이 있으므로 넉넉히 본다
    await run.segment(`watch ${String(Math.round(watchMs / 1000))}s`, async () => {
      run.dump('tile poll while watching', await pollTiles(page, pollCount, pollMs))
      const remaining = watchMs - pollMs * pollCount
      if (remaining > 0) {
        run.action('watch', { ms: remaining })
        await sleep(remaining)
      }
      await measure(page, 'after watch', run, tabIds, boundAt)
    })
  } finally {
    //+_+// 세션을 놓는다. 놓은 뒤의 상태는 재지 않는다. 이 조건이 묻는 것은 붙어 있는 동안이다
    if (held !== null) {
      await held.release()
      run.log('harness released the page target')
    }
  }
}
