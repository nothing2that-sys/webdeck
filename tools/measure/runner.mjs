import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

//+_+// P6-D24. 하네스는 관측만 낸다. 판정 문장을 쓰지 않는다
//+_+// 그래서 이 파일에는 pass / fail 을 정하는 분기가 없다. 실패도 기록으로만 남는다

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

export function iso(at) {
  return new Date(at).toISOString()
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function createRun(scenarioName) {
  const startedAt = Date.now()
  const segments = []
  const notes = []
  let current = null

  const run = {
    scenario: scenarioName,
    startedAt,
    segments,
    notes,

    log(message) {
      const entry = { at: Date.now(), message }
      notes.push(entry)
      process.stdout.write(`[${iso(entry.at)}] ${message}\n`)
    },

    //+_+// 구간이다. 이름 · 시작 / 종료 시각 · 조작 내역 · 덤프 · 예외를 함께 담는다
    async segment(name, body) {
      const segment = { name, startedAt: Date.now(), endedAt: null, actions: [], dumps: [], errors: [] }
      segments.push(segment)
      current = segment
      run.log(`구간 시작 ${name}`)
      try {
        return await body(segment)
      } catch (error) {
        //+_+// 예외를 삼키지 않는다. 기록하고 다시 던진다. 시나리오가 멈출지는 부르는 쪽이 정한다
        segment.errors.push({
          at: Date.now(),
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? (error.stack ?? null) : null,
        })
        throw error
      } finally {
        segment.endedAt = Date.now()
        run.log(`구간 종료 ${name} (${String(segment.endedAt - segment.startedAt)}ms)`)
        current = null
      }
    },

    action(what, detail = null) {
      const entry = { at: Date.now(), what, detail }
      if (current === null) {
        notes.push(entry)
      } else {
        current.actions.push(entry)
      }
      return entry
    },

    dump(label, value) {
      const entry = { at: Date.now(), label, value }
      if (current === null) {
        notes.push(entry)
      } else {
        current.dumps.push(entry)
      }
      return entry
    },

    //+_+// 시나리오가 죽어도 여기까지 온 것은 남긴다
    report(session, extra = {}) {
      const finishedAt = Date.now()
      return {
        scenario: scenarioName,
        harness: {
          commit: git(['rev-parse', '--short', 'HEAD']),
          dirty: git(['status', '--porcelain']) !== '',
          node: process.version,
        },
        chrome: session === null ? null : { version: session.version, path: session.chromePath },
        extension:
          session === null
            ? null
            : { unpackedPath: session.unpackedPath, pathDerivedId: session.pathId },
        startedAt: iso(startedAt),
        finishedAt: iso(finishedAt),
        durationMs: finishedAt - startedAt,
        //+_+// P6-D22 의 자기 검증이다. 세션을 잡은 적이 있으면 여기 accepted true 로 남는다
        workerTargets:
          session === null
            ? null
            : {
                acceptedByFilter: session.ledger.filter(
                  (row) => row.accepted && row.type !== 'page' && row.type !== 'tab',
                ),
                events: session.workerTargetEvents.map((row) => ({ ...row, atIso: iso(row.at) })),
              },
        targetLedger: session === null ? null : session.ledger.map((row) => ({ ...row, atIso: iso(row.at) })),
        segments: segments.map((segment) => ({
          ...segment,
          startedAtIso: iso(segment.startedAt),
          endedAtIso: segment.endedAt === null ? null : iso(segment.endedAt),
        })),
        notes,
        ...extra,
      }
    },
  }

  return run
}

export function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`report -> ${path}\n`)
}
