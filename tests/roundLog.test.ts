import { describe, expect, it } from 'vitest'
import {
  ROUND_LOG_PREFIX,
  formatCaptureRound,
  formatRoundClock,
  frameFingerprint,
} from '../src/background/roundLog'
import type { CaptureRoundLog } from '../src/background/roundLog'

function entry(overrides: Partial<CaptureRoundLog> = {}): CaptureRoundLog {
  return {
    at: new Date(2026, 7, 13, 9, 5, 3, 40).getTime(),
    tileId: '3f2a9c11-1234-4321-9999-abcdefabcdef',
    w: 1,
    h: 1,
    intervalMs: 4000,
    roundDurationMs: 812,
    callDurationMs: 790,
    outcome: 'success',
    bytes: 41523,
    frameHash: 'f3a91c22',
    scheduleIntervalMs: 4000,
    registeredTiles: 3,
    attachedTabs: 2,
    ...overrides,
  }
}

describe('F4 - the round clock carries milliseconds', () => {
  it('zero pads to hh mm ss and three digit milliseconds', () => {
    expect(formatRoundClock(new Date(2026, 7, 13, 9, 5, 3, 40).getTime())).toBe('09:05:03.040')
  })

  it('keeps a two digit hour past noon', () => {
    expect(formatRoundClock(new Date(2026, 7, 13, 21, 45, 59, 700).getTime())).toBe('21:45:59.700')
  })
})

describe('F4 - a round line carries what the period needs to be read by eye', () => {
  it('names the prefix, the clock, the tile, the span, the interval, both durations and the outcome', () => {
    expect(formatCaptureRound(entry())).toBe(
      `${ROUND_LOG_PREFIX} ${formatRoundClock(entry().at)} 3f2a9c11 1x1 every 4000ms took 812ms call 790ms success 40.5kB f3a91c22 tiles 3 attached 2 sched 4000ms`,
    )
  })

  //+_+// N2. 두 값이 갈리면 attach 가 회차 안에 든 것이다. 로그만으로 가릴 수 있어야 한다
  it('puts the call duration next to the round duration', () => {
    expect(formatCaptureRound(entry())).toContain(' took 812ms call 790ms ')
  })

  it('marks a round that ended in attach with no call duration', () => {
    expect(
      formatCaptureRound(
        entry({ outcome: 'attachFailed', callDurationMs: null, bytes: null, frameHash: null }),
      ),
    ).toContain(' took 812ms call -ms attachFailed')
  })

  //+_+// P6-D17 이 행 끝에 두 값을 붙였다. 해시는 여전히 크기 바로 뒤다
  it('prints the frame hash after the size so equal frames are visible', () => {
    expect(formatCaptureRound(entry({ frameHash: 'deadbeef' }))).toMatch(
      / 40\.5kB deadbeef tiles 3 attached 2 sched 4000ms$/,
    )
  })

  it('drops the hash when the round produced no frame', () => {
    expect(formatCaptureRound(entry({ frameHash: null }))).toMatch(/ 40\.5kB tiles 3 attached 2 sched 4000ms$/)
  })

  it('shortens the tile id to the first eight characters', () => {
    expect(formatCaptureRound(entry())).toContain(' 3f2a9c11 ')
  })

  it('reports the span the tile actually has', () => {
    expect(formatCaptureRound(entry({ w: 2, h: 3 }))).toContain(' 2x3 ')
  })

  it('reports the interval the tile was registered with', () => {
    expect(formatCaptureRound(entry({ intervalMs: 45000 }))).toContain(' every 45000ms ')
  })

  it('names the outcome of a failed round and drops the byte count', () => {
    const line = formatCaptureRound(entry({ outcome: 'timeout', bytes: null }))
    expect(line).toContain(' call 790ms timeout')
    expect(line).not.toContain('kB')
  })

  it('names each failure outcome as the capture manager reported it', () => {
    expect(formatCaptureRound(entry({ outcome: 'attachFailed', bytes: null }))).toContain(
      'attachFailed',
    )
    expect(formatCaptureRound(entry({ outcome: 'tabGone', bytes: null }))).toContain('tabGone')
  })

  it('marks an unknown span and interval rather than inventing numbers', () => {
    const line = formatCaptureRound(entry({ w: null, h: null, intervalMs: null }))
    expect(line).toContain(' -x- every -ms ')
  })

  it('rounds the byte count to one decimal', () => {
    expect(formatCaptureRound(entry({ bytes: 1024 }))).toContain(' 1.0kB')
    expect(formatCaptureRound(entry({ bytes: 0 }))).toContain(' 0.0kB')
  })
})

//+_+// P6-D17. L39 는 회차 시점의 타일 수 없이 판정할 수 없다
describe('P6-D17 - the round line carries the tile count and the attach count', () => {
  it('names both counts at the end of a successful round', () => {
    expect(formatCaptureRound(entry({ registeredTiles: 16, attachedTabs: 15 }))).toMatch(
      / tiles 16 attached 15 sched 4000ms$/,
    )
  })

  //+_+// 실패 회차가 L39 의 관측 대상이다. 여기서 두 값이 빠지면 항목을 닫을 수 없다
  it('keeps both counts on a failed round that has no byte count', () => {
    const line = formatCaptureRound(entry({ outcome: 'timeout', bytes: null, frameHash: null }))
    expect(line).toMatch(/ timeout tiles 3 attached 2 sched 4000ms$/)
    expect(line).not.toContain('kB')
  })

  it('does not disturb the tokens that came before it', () => {
    expect(formatCaptureRound(entry())).toContain(
      ' 3f2a9c11 1x1 every 4000ms took 812ms call 790ms success ',
    )
  })

  //+_+// 0 을 대시로 적지 않는다. 등록 0 은 모르는 값이 아니라 관측값이다
  it('writes a zero count as zero', () => {
    expect(formatCaptureRound(entry({ registeredTiles: 0, attachedTabs: 0 }))).toMatch(
      / tiles 0 attached 0 sched 4000ms$/,
    )
  })
})

describe('N2 - the frame fingerprint tells equal frames from similar ones', () => {
  it('gives the same fingerprint to the same payload', () => {
    expect(frameFingerprint('AAAABBBB')).toBe(frameFingerprint('AAAABBBB'))
  })

  //+_+// 0.1kB 해상도로는 구분되지 않는 차이다. 해시는 구분해야 한다
  it('gives a different fingerprint to a payload that differs by one character', () => {
    expect(frameFingerprint('AAAABBBB')).not.toBe(frameFingerprint('AAAABBBC'))
  })

  it('is order sensitive', () => {
    expect(frameFingerprint('AB')).not.toBe(frameFingerprint('BA'))
  })

  it('is always eight hex characters', () => {
    for (const payload of ['', 'A', 'AAAA', 'x'.repeat(5000)]) {
      expect(frameFingerprint(payload)).toMatch(/^[0-9a-f]{8}$/)
    }
  })
})

//+_+// P6-D51 · B-e3. 회차 로그 한 줄만 보고 그 회차를 부른 주기를 알 수 있어야 한다
describe('P6-D51 - the line names the interval that scheduled the round', () => {
  it('puts the scheduling interval at the end of the line', () => {
    expect(formatCaptureRound(entry())).toMatch(/ sched 4000ms$/)
  })

  //+_+// every 는 타일 설정이고 sched 는 그 회차를 실제로 부른 주기다. 갈릴 수 있어야 의미가 있다
  it('lets the scheduling interval differ from the tile interval', () => {
    const line = formatCaptureRound(
      entry({ intervalMs: 4000, scheduleIntervalMs: 45000, outcome: 'timeout', bytes: null }),
    )
    expect(line).toContain(' every 4000ms ')
    expect(line).toMatch(/ sched 45000ms$/)
  })

  //+_+// 실패 회차에도 나온다. 강등된 타일이 왜 드물게 도는지가 실패 행에서 읽혀야 한다
  it('is present on a round that produced no frame', () => {
    expect(
      formatCaptureRound(entry({ outcome: 'attachFailed', bytes: null, frameHash: null })),
    ).toMatch(/ sched 4000ms$/)
  })

  //+_+// P6-D17 이 붙인 두 값보다 뒤다. 기존 토큰의 순서를 바꾸지 않았다는 뜻이다
  it('comes after the tile and attach counts', () => {
    expect(formatCaptureRound(entry())).toMatch(/ tiles 3 attached 2 sched 4000ms$/)
  })
})
