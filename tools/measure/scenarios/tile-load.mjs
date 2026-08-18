import {
  addTileFromUrl,
  countRoundsByTile,
  countTiles,
  createProject,
  dumpStorage,
  openDashboard,
  readTiles,
  selectTile,
  setSelectedTileIntervalMs,
  switchProject,
} from '../dashboard.mjs'
import { observeRounds, parseRoundLine } from '../roundLines.mjs'
import { sleep } from '../runner.mjs'

//+_+// P6-D5 · D25. 타일 수 조건이다. --tiles 4 / 8 / 16 으로 조건을 하나씩 만든다
//+_+// 배너 관측은 하지 않는다. 사람 눈이다 (P6-D58)
//+_+// P6-D24 · D45. 판정 문장을 쓰지 않는다
export const description = '타일 수 조건. --tiles N 으로 만들고 방치한 뒤 회차와 소요를 센다'

//+_+// P6-D10. 평균을 쓰지 않는다. 분포가 이봉형이라 평균이 대표값이 아니다 (L22)
function spread(values) {
  if (values.length === 0) {
    return { count: 0, min: null, mid: null, max: null }
  }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    min: sorted[0],
    mid: sorted[Math.ceil(sorted.length / 2) - 1],
    max: sorted[sorted.length - 1],
  }
}

export async function run({ session, run, extensionId, config }) {
  const idleMs = config.watchMs ?? 60000
  const settleMs = config.settleMs ?? 20000
  const wanted = config.tileUrls.length

  let page = null
  let placed = 0

  await run.segment(`setup ${String(wanted)} tiles`, async () => {
    page = await openDashboard(session, extensionId, run)
    run.action('create project', { name: 'L' })
    await createProject(page, 'L')
    await switchProject(page, 'L')

    //+_+// 4x4 는 1x1 타일 16장이 상한이다. 그 위는 GRID_FULL 로 거절된다
    //+_+// 거절도 관측이다. 몇 장에서 멈췄는지를 그대로 싣는다
    for (const url of config.tileUrls) {
      try {
        await addTileFromUrl(page, url)
      } catch (error) {
        run.dump('add tile refused', {
          url,
          placedSoFar: await countTiles(page),
          message: error instanceof Error ? error.message : String(error),
        })
        break
      }
    }
    placed = await countTiles(page)
    run.dump('tiles placed', { wanted, placed })

    //+_+// P6-D61. 주기를 주면 타일마다 override 를 건다. 하한은 MIN_TILE_INTERVAL_MS 250 이다
    if (config.intervalMs !== undefined) {
      for (let index = 0; index < placed; index += 1) {
        await selectTile(page, index)
        await setSelectedTileIntervalMs(page, config.intervalMs)
      }
      run.action('interval override applied to every tile', { intervalMs: config.intervalMs })
    }
  })

  const from = Date.now()
  await run.segment(`idle ${String(Math.round(idleMs / 1000))}s`, async () => {
    run.action('settle', { ms: settleMs })
    await sleep(settleMs)
    run.action('idle with dashboard in the foreground', { ms: idleMs })
    await sleep(idleMs)
  })
  const to = Date.now()

  await run.segment('count', async () => {
    const dump = await dumpStorage(page, { sinceAt: from, untilAt: to })
    const parsed = dump.rounds
      .map((row) => parseRoundLine(row.line))
      .filter((item) => item !== null)

    run.dump('tile load window', {
      wanted,
      placed,
      intervalMs: config.intervalMs ?? null,
      startedAt: from,
      endedAt: to,
      elapsedMs: to - from,
      workerStarts: dump.workerStarts,
      inWindow: countRoundsByTile(dump.rounds),
      observed: observeRounds(dump.rounds),
      //+_+// 행 끝의 tiles N attached N 이다. 등록 수와 attach 수가 갈리면 리스를 놓은 타일이 있다
      registeredTiles: spread(parsed.map((item) => item.registeredTiles)),
      attachedTabs: spread(parsed.map((item) => item.attachedTabs)),
      //+_+// P6-D10. 최소 · 중간 · 최대다
      roundDurationMs: spread(parsed.map((item) => item.roundDurationMs)),
      callDurationMs: spread(
        parsed.map((item) => item.callDurationMs).filter((value) => value !== null),
      ),
      //+_+// P6-D61. 굶는 타일이 있는지를 본다. 타일별 회차 수의 최소 · 중간 · 최대다
      roundsPerTile: spread(Object.values(countRoundsByTile(dump.rounds).byTile)),
      sampleLines: dump.rounds.slice(0, 3).map((row) => row.line),
    })
    run.dump('tiles at the end', await readTiles(page))
  })
}
