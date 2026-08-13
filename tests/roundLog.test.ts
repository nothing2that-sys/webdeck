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
      `${ROUND_LOG_PREFIX} ${formatRoundClock(entry().at)} 3f2a9c11 1x1 every 4000ms took 812ms call 790ms success 40.5kB f3a91c22`,
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

  it('prints the frame hash after the size so equal frames are visible', () => {
    expect(formatCaptureRound(entry({ frameHash: 'deadbeef' }))).toMatch(/40\.5kB deadbeef$/)
  })

  it('drops the hash when the round produced no frame', () => {
    expect(formatCaptureRound(entry({ frameHash: null }))).toMatch(/40\.5kB$/)
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
