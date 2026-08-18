import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchMeasured } from './browser.mjs'
import { createRun, writeReport } from './runner.mjs'

//+_+// S3 의 시나리오 러너다. 선언한 시나리오를 골라 돌리고 리포트 파일 하나를 남긴다
const SCENARIOS = {
  's1-gate': () => import('./scenarios/s1-gate.mjs'),
  'ra-repro': () => import('./scenarios/ra-repro.mjs'),
  //+_+// P6-D55. 활성 프로젝트에 타일을 둔 채 hidden 을 만든다. ra-repro 가 못 재는 자리다
  'hidden-reach': () => import('./scenarios/hidden-reach.mjs'),
  //+_+// P6-D5 · D25. --tiles N 으로 조건을 만든다
  'tile-load': () => import('./scenarios/tile-load.mjs'),
}

function parseArgs(argv) {
  const args = { scenario: argv[0] ?? '', flags: {} }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      continue
    }
    //+_+// 값 없는 스위치를 허용한다. 다음 토큰이 또 플래그면 그것을 값으로 삼키지 않는다
    //+_+// 삼키면 뒤 플래그가 조용히 사라진다. 관측 조건이 말없이 달라지는 자리다
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      args.flags[token.slice(2)] = ''
      continue
    }
    args.flags[token.slice(2)] = next
    index += 1
  }
  return args
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

//+_+// 움직이는 화면이라야 프레임 해시가 바뀌는지 볼 수 있다. 저장소의 test-pages 를 쓴다
function defaultTileUrls(count) {
  const page = resolve('test-pages/live-counter.html')
  if (!existsSync(page)) {
    throw new Error(`test-pages/live-counter.html 이 없다: ${page}`)
  }
  const base = pathToFileURL(page).href
  return Array.from({ length: count }, (_unused, index) => `${base}?tile=${String(index + 1)}`)
}

//+_+// 확장 id 는 CDP Extensions.loadUnpacked 가 돌려준 값이다. 서비스 워커 타깃에 붙지 않는다 (P6-D22)
//+_+// 경로에서 계산한 값과 대조해 둔다. 두 값이 갈려도 판정하지 않고 그대로 리포트에 남긴다
function resolveExtensionId(session) {
  return {
    id: session.extensionId,
    source: 'browser.installExtension',
    pathDerivedId: session.pathId,
    agreesWithPathDerived: session.extensionId === session.pathId,
    workerTargetUrls: session.workerTargetUrls(),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const load = SCENARIOS[args.scenario]
  if (load === undefined) {
    process.stderr.write(`사용법: node tools/measure/run.mjs <${Object.keys(SCENARIOS).join('|')}> [--flag value]\n`)
    process.exitCode = 2
    return
  }

  const scenario = await load()
  const extensionPath = resolve(args.flags.extension ?? 'dist')
  const profileDir = resolve(args.flags.profile ?? 'tools/measure/.profile')
  const outPath = resolve(args.flags.out ?? `tools/measure/reports/${args.scenario}-${stamp()}.json`)
  const config = {
    tileUrls: defaultTileUrls(Number(args.flags.tiles ?? '2')),
    waitMs: args.flags.wait === undefined ? undefined : Number(args.flags.wait) * 1000,
    deathWaitMs: args.flags.death === undefined ? undefined : Number(args.flags.death) * 1000,
    watchMs: args.flags.watch === undefined ? undefined : Number(args.flags.watch) * 1000,
    settleMs: args.flags.settle === undefined ? undefined : Number(args.flags.settle) * 1000,
    //+_+// P6-D61. 타일마다 주기 override 를 걸어 과포화 조건을 만든다. ms 단위 그대로다
    intervalMs: args.flags.interval === undefined ? undefined : Number(args.flags.interval),
    //+_+// P6-D60 S2-2 의 대조군이다. 활성 프로젝트를 타일 0개로 둔다
    noTiles: args.flags.noTiles !== undefined,
    //+_+// S2-1 · S2-2 는 P1 만 쓴다
    skipP2: args.flags.skipP2 !== undefined,
  }

  //+_+// 회차마다 새 프로필이다. 앞 회차의 상태가 다음 회차의 관측에 섞이지 않게 한다
  if (args.flags.keepProfile === undefined) {
    rmSync(profileDir, { recursive: true, force: true })
  }

  const run = createRun(args.scenario)
  let session = null
  let failure = null
  let extension = null

  try {
    session = await launchMeasured({ extensionPath, userDataDir: profileDir })
    run.log(`chrome ${session.version} · ${session.chromePath}`)
    extension = resolveExtensionId(session)
    run.log(`extension id ${extension.id} (${extension.source})`)
    await scenario.run({ session, run, extensionId: extension.id, config })
  } catch (error) {
    failure = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    }
    run.log(`실패: ${failure.message}`)
  } finally {
    const report = run.report(session, {
      description: scenario.description ?? null,
      config: { extensionPath, profileDir, ...config },
      extensionId: extension,
      //+_+// 사람 화면에 창이 뜬다. headless 로 확장을 로드하지 않는다 (S0-3)
      headless: false,
      failure,
    })
    writeReport(outPath, report)
    if (session !== null) {
      await session.browser.close().catch(() => undefined)
    }
    if (failure !== null) {
      process.exitCode = 1
    }
  }
}

await main()
