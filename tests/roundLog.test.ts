import { describe, expect, it } from 'vitest'
import { ROUND_LOG_PREFIX, formatCaptureRound, formatRoundClock } from '../src/background/roundLog'
import type { CaptureRoundLog } from '../src/background/roundLog'

function entry(overrides: Partial<CaptureRoundLog> = {}): CaptureRoundLog {
  return {
    at: new Date(2026, 7, 13, 9, 5, 3, 40).getTime(),
    tileId: '3f2a9c11-1234-4321-9999-abcdefabcdef',
    w: 1,
    h: 1,
    intervalMs: 4000,
    roundDurationMs: 812,
    outcome: 'success',
    bytes: 41523,
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
  it('names the prefix, the clock, the tile, the span, the interval, the duration and the outcome', () => {
    expect(formatCaptureRound(entry())).toBe(
      `${ROUND_LOG_PREFIX} 09:05:03.040 3f2a9c11 1x1 every 4000ms took 812ms success 40.5kB`,
    )
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
    expect(line).toContain(' took 812ms timeout')
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
