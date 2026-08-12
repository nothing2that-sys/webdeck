import { describe, expect, it } from 'vitest'
import type { CaptureRecord } from '../src/background/previewCaptureManager'
import {
  DEV_TILE_SPAN,
  EMPTY_CAPTURE_SUMMARY,
  applyCaptureRecord,
  buildRuntimeState,
  newTile,
  resolveRuntimeStatus,
} from '../src/background/projectState'
import { CAPTURE_INTERVAL_MS } from '../src/shared/scheduler'
import type { BrowserTabInfo, WebTile } from '../src/shared/types'

function tile(id: string, x: number, y: number, w = 1, h = 1): WebTile {
  return {
    id,
    launchUrl: `https://example.com/${id}`,
    matchMode: 'origin',
    x,
    y,
    w,
    h,
    refreshIntervalMs: 4000,
    fitMode: 'contain',
    keepAlive: false,
  }
}

function record(outcome: CaptureRecord['outcome'], startedAt: number, roundDurationMs: number): CaptureRecord {
  return {
    tileId: 't1',
    tabId: 11,
    attemptToken: 1,
    attemptIndex: 0,
    startedAt,
    calledAt: outcome === 'attachFailed' ? null : startedAt + 5,
    roundDurationMs,
    callDurationMs: outcome === 'attachFailed' ? null : roundDurationMs - 5,
    outcome,
    bytes: outcome === 'success' ? 1024 : null,
    message: null,
  }
}

function tabInfo(tabId: number): BrowserTabInfo {
  return {
    tabId,
    windowId: 3,
    currentUrl: 'https://example.com/live',
    title: 'live title',
    favIconUrl: 'https://example.com/icon.png',
  }
}

describe('P4-D2 - the dev binding places a 1x1 tile in the first empty slot', () => {
  it('places the first tile at the origin', () => {
    expect(newTile('t1', 'https://example.com/a', [])).toMatchObject({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('skips occupied slots in row major order', () => {
    const existing = [tile('t1', 0, 0), tile('t2', 1, 0)]
    expect(newTile('t3', 'https://example.com/c', existing)).toMatchObject({ x: 2, y: 0 })
  })

  it('wraps to the next row when the first row is full', () => {
    const existing = [tile('a', 0, 0), tile('b', 1, 0), tile('c', 2, 0), tile('d', 3, 0)]
    expect(newTile('e', 'https://example.com/e', existing)).toMatchObject({ x: 0, y: 1 })
  })

  it('returns null when the grid has no empty slot', () => {
    const full: WebTile[] = []
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        full.push(tile(`t${String(y)}${String(x)}`, x, y))
      }
    }
    expect(full).toHaveLength(16)
    expect(newTile('overflow', 'https://example.com/x', full)).toBeNull()
  })

  it('carries the id and the launch url unchanged', () => {
    const created = newTile('given-id', 'https://example.com/page?q=1', [])
    expect(created?.id).toBe('given-id')
    expect(created?.launchUrl).toBe('https://example.com/page?q=1')
  })

  it('uses the 1x1 default interval from the scheduler rather than a literal', () => {
    expect(DEV_TILE_SPAN).toBe(1)
    expect(newTile('t1', 'https://example.com/a', [])?.refreshIntervalMs).toBe(
      CAPTURE_INTERVAL_MS.spanSmall,
    )
  })

  it('creates a tile that keepAlive and fit mode defaults leave to Phase 5', () => {
    expect(newTile('t1', 'https://example.com/a', [])).toMatchObject({
      keepAlive: false,
      fitMode: 'contain',
      matchMode: 'origin',
    })
  })
})

describe('P4-D9 - the capture summary carries the round duration', () => {
  it('starts with no capture and no failures', () => {
    expect(EMPTY_CAPTURE_SUMMARY).toEqual({ consecutiveCaptureFailures: 0 })
  })

  it('takes the settle time of a successful round as lastCaptureAt', () => {
    const next = applyCaptureRecord(EMPTY_CAPTURE_SUMMARY, record('success', 1000, 250))
    expect(next).toEqual({
      lastCaptureAt: 1250,
      lastRoundDurationMs: 250,
      consecutiveCaptureFailures: 0,
    })
  })

  it('names no lastCaptureDurationMs field', () => {
    const next = applyCaptureRecord(EMPTY_CAPTURE_SUMMARY, record('success', 1000, 250))
    expect(Object.hasOwn(next, 'lastCaptureDurationMs')).toBe(false)
  })

  it('counts a failure without moving the last successful capture', () => {
    const success = applyCaptureRecord(EMPTY_CAPTURE_SUMMARY, record('success', 1000, 250))
    const failed = applyCaptureRecord(success, record('timeout', 4000, 5000))
    expect(failed).toEqual({
      lastCaptureAt: 1250,
      lastRoundDurationMs: 250,
      consecutiveCaptureFailures: 1,
    })
  })

  it('accumulates consecutive failures', () => {
    let summary = EMPTY_CAPTURE_SUMMARY
    for (const outcome of ['timeout', 'attachFailed', 'captureFailed'] as const) {
      summary = applyCaptureRecord(summary, record(outcome, 0, 10))
    }
    expect(summary.consecutiveCaptureFailures).toBe(3)
  })

  it('resets the failure count on the next success', () => {
    const failed = applyCaptureRecord(EMPTY_CAPTURE_SUMMARY, record('timeout', 0, 5000))
    const recovered = applyCaptureRecord(failed, record('success', 6000, 100))
    expect(recovered.consecutiveCaptureFailures).toBe(0)
  })

  it('does not mutate the summary it was given', () => {
    const before = { ...EMPTY_CAPTURE_SUMMARY }
    applyCaptureRecord(before, record('success', 1000, 250))
    expect(before).toEqual({ consecutiveCaptureFailures: 0 })
  })
})

describe('P4 runtime status - the capture engine decides first', () => {
  it('takes the capture engine status when the engine knows the tile', () => {
    expect(resolveRuntimeStatus('STALE', 11, tabInfo(11), true)).toBe('STALE')
    expect(resolveRuntimeStatus('ERROR', 11, null, true)).toBe('ERROR')
  })

  it('reports LOADING for a tile that is not bound yet', () => {
    expect(resolveRuntimeStatus(null, undefined, null, false)).toBe('LOADING')
  })

  it('reports DETACHED for a bound tile whose tab is gone', () => {
    expect(resolveRuntimeStatus(null, 11, null, false)).toBe('DETACHED')
  })

  it('reports LOADING while the tab exists but no round has settled', () => {
    expect(resolveRuntimeStatus(null, 11, tabInfo(11), false)).toBe('LOADING')
  })

  it('does not report LIVE before the first frame has arrived', () => {
    expect(resolveRuntimeStatus('LIVE', 11, tabInfo(11), false)).toBe('LOADING')
  })

  it('reports LIVE once a frame has arrived', () => {
    expect(resolveRuntimeStatus('LIVE', 11, tabInfo(11), true)).toBe('LIVE')
  })

  it('keeps STALE even when no frame has ever arrived', () => {
    expect(resolveRuntimeStatus('STALE', 11, tabInfo(11), false)).toBe('STALE')
  })
})

describe('P4 runtime state - optional fields stay absent when unknown', () => {
  it('carries the tab identity fields when the tab is present', () => {
    const state = buildRuntimeState('t1', 11, tabInfo(11), 'LIVE', {
      lastCaptureAt: 1250,
      lastRoundDurationMs: 250,
      consecutiveCaptureFailures: 0,
    })
    expect(state).toEqual({
      tileId: 't1',
      tabId: 11,
      windowId: 3,
      title: 'live title',
      currentUrl: 'https://example.com/live',
      favIconUrl: 'https://example.com/icon.png',
      status: 'LIVE',
      lastCaptureAt: 1250,
      lastRoundDurationMs: 250,
      consecutiveCaptureFailures: 0,
    })
  })

  it('omits the tab fields rather than writing undefined', () => {
    const state = buildRuntimeState('t1', undefined, null, 'LOADING', EMPTY_CAPTURE_SUMMARY)
    for (const key of ['tabId', 'windowId', 'title', 'currentUrl', 'favIconUrl']) {
      expect(Object.hasOwn(state, key)).toBe(false)
    }
    expect(state).toEqual({ tileId: 't1', status: 'LOADING', consecutiveCaptureFailures: 0 })
  })

  it('keeps the tabId of a bound tile whose tab has gone', () => {
    const state = buildRuntimeState('t1', 11, null, 'DETACHED', EMPTY_CAPTURE_SUMMARY)
    expect(state).toMatchObject({ tileId: 't1', tabId: 11, status: 'DETACHED' })
    expect(Object.hasOwn(state, 'title')).toBe(false)
  })

  it('omits the capture fields before the first successful round', () => {
    const state = buildRuntimeState('t1', 11, tabInfo(11), 'LOADING', EMPTY_CAPTURE_SUMMARY)
    expect(Object.hasOwn(state, 'lastCaptureAt')).toBe(false)
    expect(Object.hasOwn(state, 'lastRoundDurationMs')).toBe(false)
    expect(state.consecutiveCaptureFailures).toBe(0)
  })
})
