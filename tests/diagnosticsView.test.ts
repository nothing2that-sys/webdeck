import { describe, expect, it } from 'vitest'
import { buildDiagnostics, durationSpread } from '../src/background/diagnostics'
import { RECORD_LOG_LIMIT } from '../src/shared/recordLimit'

function record(roundDurationMs: number, outcome = 'success') {
  return { roundDurationMs, outcome }
}

//+_+// P6-D10 · D113. 평균을 내지 않는다. 최소 · 중간 · 최대뿐이다
describe('P6-D10 - the duration spread has no average', () => {
  it('reports nothing for an empty sample', () => {
    expect(durationSpread([])).toEqual({ count: 0, min: null, mid: null, max: null })
  })

  it('reports the min, the nearest rank median and the max', () => {
    expect(durationSpread([50, 90, 70])).toEqual({ count: 3, min: 50, mid: 70, max: 90 })
  })

  //+_+// 보간하지 않는다. 관측되지 않은 수를 만들지 않는다
  it('does not interpolate the median of an even sample', () => {
    expect(durationSpread([10, 20, 30, 40]).mid).toBe(20)
  })

  //+_+// 평균이면 대표값이 꼬리에 끌려간다. L22 가 그것을 금지한 이유다
  it('does not let one long round move the middle', () => {
    expect(durationSpread([50, 60, 70, 5000]).mid).toBe(60)
  })
})

describe('P6-D113 - the diagnostics snapshot holds only the named items', () => {
  const snapshot = buildDiagnostics({
    captureRecords: [record(50), record(90, 'timeout'), record(70), record(80, 'timeout')],
    registeredTiles: 4,
    attachedTabs: 3,
    workerStarts: 7,
    recordLogs: [{ name: 'captureRecords', length: 4, limit: RECORD_LOG_LIMIT }],
  })

  it('names exactly the seven fields P6-D113 lists', () => {
    expect(Object.keys(snapshot).sort()).toEqual([
      'attachedTabs',
      'recordLogs',
      'registeredTiles',
      'roundDurationMs',
      'sampleLimit',
      'timeouts',
      'workerStarts',
    ])
  })

  //+_+// P6-D10. 평균도 분위수도 없다
  it('carries no average and no percentile', () => {
    const text = JSON.stringify(snapshot)
    expect(text).not.toContain('average')
    expect(text).not.toContain('mean')
    expect(text).not.toContain('p50')
    expect(text).not.toContain('p95')
    expect(text).not.toContain('p99')
  })

  //+_+// A-e4. 계측 키 이름이 응답에 실리지 않는다
  it('carries no diagnostics storage key', () => {
    expect(JSON.stringify(snapshot)).not.toContain('webdeck.diagnostics')
  })

  it('counts the timeouts', () => {
    expect(snapshot.timeouts).toBe(2)
  })

  it('spreads the round durations', () => {
    expect(snapshot.roundDurationMs).toEqual({ count: 4, min: 50, mid: 70, max: 90 })
  })

  //+_+// B-e4. 최근 몇 개 기준인지를 응답이 밝힌다
  it('states the sample limit', () => {
    expect(snapshot.sampleLimit).toBe(RECORD_LOG_LIMIT)
  })

  it('carries the tile and attach counts', () => {
    expect(snapshot.registeredTiles).toBe(4)
    expect(snapshot.attachedTabs).toBe(3)
  })

  //+_+// 계측 배선이 없으면 모르는 것이다. 0 으로 적으면 관측했다는 뜻이 된다
  it('keeps an unknown worker start count as null', () => {
    const unknown = buildDiagnostics({
      captureRecords: [],
      registeredTiles: 0,
      attachedTabs: 0,
      workerStarts: null,
      recordLogs: [],
    })
    expect(unknown.workerStarts).toBeNull()
  })
})
