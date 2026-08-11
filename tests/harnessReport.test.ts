import { describe, expect, it } from 'vitest'
import {
  FRAME_HASH_BASIS,
  buildReport,
  countOutcomes,
  durationSamples,
  fnv1a,
  reportFileName,
} from '../harness/p3/report'
import type { CaptureRow, ReportInput } from '../harness/p3/report'
import { TICK_MS as HARNESS_TICK_MS } from '../harness/p3/config'
import { DRIVER_TICK_MS } from '../src/background/serviceWorker'
import { CAPTURE_INTERVAL_MS, captureStats } from '../src/shared/scheduler'

function row(overrides: Partial<CaptureRow>): CaptureRow {
  return {
    tileId: 't1',
    tabId: 1,
    attemptIndex: 0,
    startedAt: 0,
    calledAt: 0,
    roundDurationMs: 100,
    callDurationMs: 90,
    outcome: 'success',
    bytes: 1000,
    frameHash: 'abc',
    pageEnableSent: true,
    message: null,
    ...overrides,
  }
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    chromeFullVersion: '150.0.7871.187',
    round: 'roundA',
    measuredAt: '2026-08-11T00:00:00.000Z',
    reportSavedAt: '2026-08-11T00:10:00.000Z',
    harnessCommit: null,
    captures: [],
    lateArrivals: [],
    attach: [],
    detachEvents: [],
    injections: [],
    reencode: null,
    swStarts: [],
    portLog: [],
    environment: null,
    userObservations: {},
    idleTransition: null,
    idleTransitionClient: null,
    ...overrides,
  }
}

describe('TASK-P3-01-S5 - report assembly', () => {
  it('carries every top level section the schema requires', () => {
    const report = buildReport(input(), captureStats)

    expect(Object.keys(report).sort()).toEqual([
      'attach',
      'capture',
      'detachEvents',
      'environment',
      'frameHashBasis',
      'idleTransition',
      'idleTransitionClient',
      'injections',
      'lateArrivals',
      'meta',
      'portLog',
      'reencode',
      'stats',
      'swStarts',
      'userObservations',
    ])
  })

  it('separates measuredAt from reportSavedAt', () => {
    const report = buildReport(input(), captureStats)

    expect(report.meta.measuredAt).toBe('2026-08-11T00:00:00.000Z')
    expect(report.meta.reportSavedAt).toBe('2026-08-11T00:10:00.000Z')
    expect(report.meta.measuredAt).not.toBe(report.meta.reportSavedAt)
  })

  //+_+// 값이 없으면 필드를 만들지 않는다
  it('omits harnessCommit when there is no hash', () => {
    expect(Object.hasOwn(buildReport(input(), captureStats).meta, 'harnessCommit')).toBe(false)
    expect(buildReport(input({ harnessCommit: 'abc1234' }), captureStats).meta.harnessCommit).toBe(
      'abc1234',
    )
  })

  //+_+// 픽셀 해시가 아니다. 판독을 위해 근거를 리포트에 남긴다
  it('states the frame hash basis', () => {
    expect(buildReport(input(), captureStats).frameHashBasis).toBe(FRAME_HASH_BASIS)
    expect(fnv1a('abc')).toBe(fnv1a('abc'))
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'))
  })

  //+_+// 타임아웃은 상수 5000 이라 분포를 오염시킨다. 성공 회차만 표본에 넣는다
  it('samples durations from successful rounds only', () => {
    const captures = [
      row({ roundDurationMs: 50, callDurationMs: 45 }),
      row({ outcome: 'timeout', roundDurationMs: 5000, callDurationMs: null }),
      row({ outcome: 'attachFailed', roundDurationMs: 3, callDurationMs: null }),
      row({ roundDurationMs: 900, callDurationMs: 880 }),
    ]

    expect(durationSamples(captures)).toEqual({ round: [50, 900], call: [45, 880] })
    expect(countOutcomes(captures)).toEqual({ attempts: 4, successes: 2, timeouts: 1 })
  })

  //+_+// P3-D10. 모든 비율이 원시 개수로부터 재계산 가능해야 한다
  it('lets every rate be recomputed from the raw counts', () => {
    const captures = [
      row({}),
      row({ outcome: 'timeout', callDurationMs: null }),
      row({ outcome: 'timeout', callDurationMs: null }),
      row({ outcome: 'captureFailed', callDurationMs: null }),
    ]
    const report = buildReport(
      input({
        captures,
        lateArrivals: [
          { tileId: 't1', tabId: 1, attemptIndex: 1, lateByMs: 1200, roundDurationMs: 6200, settledAs: 'success' },
        ],
      }),
      captureStats,
    )

    expect(report.stats.attempts).toBe(4)
    expect(report.stats.successes).toBe(1)
    expect(report.stats.timeouts).toBe(2)
    expect(report.stats.lateArrivals).toBe(1)
    expect(report.stats.timeoutRate).toBeCloseTo(2 / 4)
    expect(report.stats.lateArrivalRate).toBeCloseTo(1 / 2)
  })

  it('names no durationMs anywhere in a serialized report', () => {
    const report = buildReport(input({ captures: [row({})] }), captureStats)
    const text = JSON.stringify(report)

    expect(text).not.toContain('"durationMs"')
    expect(text).toContain('"roundDurationMs"')
    expect(text).toContain('"callDurationMs"')
    for (const name of ['average', 'avg', 'mean']) {
      expect(text).not.toContain(`"${name}"`)
    }
  })

  //+_+// P3-D15. 파일명은 phase3-report-<라운드>.json 이다
  it('builds the report file name from the round', () => {
    expect(reportFileName('roundA')).toBe('phase3-report-roundA.json')
    expect(reportFileName(' round B ')).toBe('phase3-report-round-B.json')
    expect(reportFileName('')).toBe('phase3-report-unnamed.json')
  })
})

describe('TASK-P3-01-S5 - runtime attach is recorded too', () => {
  //+_+// r1a 는 캡처 315건이 성공했는데 attach[] 가 비어 있었다. 런타임 attach 가 기록되지 않았다
  it('keeps a runtime row apart from the numbered stages', () => {
    const report = buildReport(
      input({
        attach: [
          { stage: 3, requested: 3, ok: 3, fail: 0, errors: [] },
          {
            stage: 'runtime',
            requested: 4,
            ok: 3,
            fail: 1,
            errors: ['tab 9: Another debugger is already attached to the tab with id: 9'],
          },
        ],
      }),
      captureStats,
    )

    const runtime = report.attach.find((entry) => entry.stage === 'runtime')
    expect(runtime).toBeDefined()
    expect(runtime?.ok).toBe(3)
    expect(runtime?.fail).toBe(1)
    //+_+// L24. 사유 원문이 단계별 시험 밖에서도 남아야 한다
    expect(runtime?.errors[0]).toContain('Another debugger is already attached')
    expect(report.attach.filter((entry) => typeof entry.stage === 'number')).toHaveLength(1)
  })
})

describe('P3-D16 - the tick constant is duplicated on purpose', () => {
  //+_+// 상수를 합치거나 옮기지 않는다. 값이 같은지만 테스트로 묶는다
  it('keeps the harness tick equal to the product driver tick', () => {
    expect(HARNESS_TICK_MS).toBe(DRIVER_TICK_MS)
  })

  //+_+// tick 은 가장 짧은 캡처 주기보다 촘촘해야 만기를 놓치지 않는다. P3-D11
  it('stays finer than the shortest capture interval', () => {
    expect(HARNESS_TICK_MS).toBeLessThan(CAPTURE_INTERVAL_MS.spanLarge)
    expect(DRIVER_TICK_MS).toBeLessThan(CAPTURE_INTERVAL_MS.spanLarge)
  })
})

describe('P3-D18 - the idle transition is recorded on both sides', () => {
  //+_+// 워커 기록은 워커가 죽으면 사라진다. 페이지 기록은 살아남는다. 둘을 함께 실어 판정한다
  it('carries the worker record and the client record separately', () => {
    const report = buildReport(
      input({
        idleTransition: 'IDLE-C at 2026-08-11T09:09:24.023Z',
        idleTransitionClient: 'IDLE-C at 2026-08-11T09:09:24.020Z',
      }),
      captureStats,
    )

    expect(report.idleTransition).toBe('IDLE-C at 2026-08-11T09:09:24.023Z')
    expect(report.idleTransitionClient).toBe('IDLE-C at 2026-08-11T09:09:24.020Z')
  })

  //+_+// 판정표를 그대로 고정한다
  it('distinguishes worker survival from worker death and from no transition', () => {
    const survived = buildReport(
      input({ idleTransition: 'IDLE-A at t', idleTransitionClient: 'IDLE-A at t' }),
      captureStats,
    )
    const died = buildReport(
      input({ idleTransition: null, idleTransitionClient: 'IDLE-C at t' }),
      captureStats,
    )
    const notPressed = buildReport(
      input({ idleTransition: null, idleTransitionClient: null }),
      captureStats,
    )

    expect(survived.idleTransitionClient).not.toBeNull()
    expect(survived.idleTransition).not.toBeNull()

    expect(died.idleTransitionClient).not.toBeNull()
    expect(died.idleTransition).toBeNull()

    expect(notPressed.idleTransitionClient).toBeNull()
    expect(notPressed.idleTransition).toBeNull()
  })
})
