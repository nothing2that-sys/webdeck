import { describe, expect, it } from 'vitest'
import {
  buildTileViews,
  formatCaptureTime,
  gridArea,
  parseTileSettings,
  previewDataUrl,
  statusClassName,
  tileSettingsDraft,
} from '../src/dashboard/tileView'
import type { TileFrame } from '../src/shared/messages'
import type { Project, TileRuntimeState, TileStatus, WebTile } from '../src/shared/types'

const ALL_STATUSES: readonly TileStatus[] = [
  'LIVE',
  'LOADING',
  'STALE',
  'FROZEN',
  'DISCARDED',
  'DETACHED',
  'DEVTOOLS',
  'ERROR',
]

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

function project(tiles: WebTile[]): Project {
  return {
    id: 'webdeck.default',
    name: 'WebDeck',
    gridColumns: 4,
    gridRows: 4,
    keepManagedTabsAlive: false,
    tiles,
  }
}

function runtime(tileId: string, status: TileStatus, extra: Partial<TileRuntimeState> = {}): TileRuntimeState {
  return { tileId, status, consecutiveCaptureFailures: 0, ...extra }
}

function frame(tileId: string, imageBase64: string): TileFrame {
  return { tileId, imageBase64, format: 'jpeg', bytes: 3 }
}

describe('v1 7.2 - the grid area is the 1 based css grid span', () => {
  it('places a 1x1 tile at the origin on row 1 column 1', () => {
    expect(gridArea(tile('t1', 0, 0))).toBe('1 / 1 / 2 / 2')
  })

  it('offsets x to the column and y to the row', () => {
    expect(gridArea(tile('t1', 2, 1))).toBe('2 / 3 / 3 / 4')
  })

  it('spans the whole grid for a 4x4 tile', () => {
    expect(gridArea(tile('t1', 0, 0, 4, 4))).toBe('1 / 1 / 5 / 5')
  })

  it('keeps width on the column axis and height on the row axis', () => {
    expect(gridArea(tile('t1', 0, 0, 3, 2))).toBe('1 / 1 / 3 / 4')
  })
})

describe('P3-D1 - the preview is a data url built from the base64 string', () => {
  it('builds a jpeg data url', () => {
    expect(previewDataUrl(frame('t1', 'AAAA'))).toBe('data:image/jpeg;base64,AAAA')
  })

  it('follows the format the worker reported', () => {
    expect(previewDataUrl({ tileId: 't1', imageBase64: 'AAAA', format: 'png', bytes: 3 })).toBe(
      'data:image/png;base64,AAAA',
    )
  })

  it('returns null when the tile has no frame yet', () => {
    expect(previewDataUrl(undefined)).toBeNull()
  })

  it('returns null rather than an empty data url', () => {
    expect(previewDataUrl(frame('t1', ''))).toBeNull()
  })
})

describe('v1 7 - the last preview time', () => {
  it('renders a dash before the first capture', () => {
    expect(formatCaptureTime(undefined)).toBe('-')
  })

  it('zero pads to hh mm ss in local time', () => {
    const at = new Date(2026, 7, 12, 9, 5, 3).getTime()
    expect(formatCaptureTime(at)).toBe('09:05:03')
  })

  it('renders a two digit hour past noon', () => {
    const at = new Date(2026, 7, 12, 21, 45, 59).getTime()
    expect(formatCaptureTime(at)).toBe('21:45:59')
  })
})

describe('P3-D-L19 - every one of the eight statuses has a badge class', () => {
  it('produces a distinct class for all eight statuses', () => {
    const classes = ALL_STATUSES.map(statusClassName)
    expect(new Set(classes).size).toBe(8)
  })

  it('keeps the shared badge class and adds a lowercase modifier', () => {
    expect(statusClassName('LIVE')).toBe('tile-badge tile-badge--live')
    expect(statusClassName('DEVTOOLS')).toBe('tile-badge tile-badge--devtools')
  })

  it('names no status outside the eight', () => {
    expect(ALL_STATUSES).toHaveLength(8)
  })
})

describe('P4-D7 - the view model merges tiles, runtime states and frames', () => {
  it('keeps the order of the project tiles', () => {
    const views = buildTileViews(project([tile('t3', 0, 0), tile('t1', 1, 0)]), [], [])
    expect(views.map((view) => view.tileId)).toEqual(['t3', 't1'])
  })

  it('reports LOADING for a tile the worker sent no runtime state for', () => {
    const views = buildTileViews(project([tile('t1', 0, 0)]), [], [])
    expect(views[0]).toMatchObject({ status: 'LOADING', previewDataUrl: null, lastCaptureLabel: '-' })
  })

  it('takes the page title from the runtime state', () => {
    const views = buildTileViews(
      project([tile('t1', 0, 0)]),
      [runtime('t1', 'LIVE', { title: 'Example page' })],
      [],
    )
    expect(views[0].title).toBe('Example page')
  })

  it('prefers the custom title over the page title', () => {
    const custom = { ...tile('t1', 0, 0), customTitle: 'My tile' }
    const views = buildTileViews(project([custom]), [runtime('t1', 'LIVE', { title: 'Example page' })], [])
    expect(views[0].title).toBe('My tile')
  })

  it('falls back to the launch url when no title is known', () => {
    const views = buildTileViews(project([tile('t1', 0, 0)]), [], [])
    expect(views[0].title).toBe('https://example.com/t1')
  })

  it('attaches the frame that belongs to the tile', () => {
    const views = buildTileViews(
      project([tile('t1', 0, 0), tile('t2', 1, 0)]),
      [runtime('t1', 'LIVE'), runtime('t2', 'LIVE')],
      [frame('t2', 'BBBB')],
    )
    expect(views[0].previewDataUrl).toBeNull()
    expect(views[1].previewDataUrl).toBe('data:image/jpeg;base64,BBBB')
  })

  it('renders the capture time and the badge class from the runtime state', () => {
    const at = new Date(2026, 7, 12, 9, 5, 3).getTime()
    const views = buildTileViews(
      project([tile('t1', 0, 0)]),
      [runtime('t1', 'STALE', { lastCaptureAt: at })],
      [],
    )
    expect(views[0].lastCaptureLabel).toBe('09:05:03')
    expect(views[0].statusClassName).toBe('tile-badge tile-badge--stale')
  })

  it('carries the favicon only when the runtime state has one', () => {
    const views = buildTileViews(
      project([tile('t1', 0, 0), tile('t2', 1, 0)]),
      [
        runtime('t1', 'LIVE', { favIconUrl: 'https://example.com/i.png' }),
        runtime('t2', 'LIVE'),
      ],
      [],
    )
    expect(views[0].favIconUrl).toBe('https://example.com/i.png')
    expect(views[1].favIconUrl).toBeNull()
  })

  it('carries the tabId so the view can show what a tile is bound to', () => {
    const views = buildTileViews(project([tile('t1', 0, 0)]), [runtime('t1', 'LIVE', { tabId: 42 })], [])
    expect(views[0].tabId).toBe(42)
  })

  it('ignores runtime states and frames for tiles that are not in the project', () => {
    const views = buildTileViews(
      project([tile('t1', 0, 0)]),
      [runtime('t1', 'LIVE'), runtime('ghost', 'ERROR')],
      [frame('ghost', 'CCCC')],
    )
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ tileId: 't1', status: 'LIVE', previewDataUrl: null })
  })

  it('gives every view its css grid area', () => {
    const views = buildTileViews(project([tile('t1', 1, 2)]), [], [])
    expect(views[0].gridArea).toBe('3 / 2 / 4 / 3')
  })
})

//+_+// S3. 설정 폼은 문자열을 다루고 프로토콜은 값을 다룬다. 그 사이 변환을 순수 함수로 분리한다
describe('P5-D31 - the settings draft round trips a tile', () => {
  it('reads the four fields off the tile', () => {
    const source: WebTile = {
      ...tile('t1', 0, 0),
      customTitle: 'Named',
      fitMode: 'cover',
      matchMode: 'prefix',
      refreshIntervalOverrideMs: 9000,
    }
    expect(tileSettingsDraft(source)).toEqual({
      customTitle: 'Named',
      fitMode: 'cover',
      matchMode: 'prefix',
      refreshIntervalOverrideMs: '9000',
    })
  })

  //+_+// 미지정의 표현은 customTitle 이 빈 문자열, override 가 빈 문자열이다. P5-D31
  it('shows an unset custom title and an unset override as empty text', () => {
    expect(tileSettingsDraft(tile('t1', 0, 0))).toEqual({
      customTitle: '',
      fitMode: 'contain',
      matchMode: 'origin',
      refreshIntervalOverrideMs: '',
    })
  })

  it('survives a draft to settings to draft trip', () => {
    const source: WebTile = { ...tile('t1', 0, 0), customTitle: 'Named' }
    const settings = parseTileSettings(tileSettingsDraft(source))
    expect(settings).toEqual({
      customTitle: 'Named',
      fitMode: 'contain',
      matchMode: 'origin',
      refreshIntervalOverrideMs: null,
    })
  })
})

describe('P5-D31 - parsing the settings draft', () => {
  function draft(overrideText: string) {
    return {
      customTitle: '',
      fitMode: 'contain' as const,
      matchMode: 'exact' as const,
      refreshIntervalOverrideMs: overrideText,
    }
  }

  //+_+// P5-D16. 비어 있으면 span 배정으로 떨어진다. null 이 그 뜻이다
  it('turns empty override text into null', () => {
    expect(parseTileSettings(draft(''))?.refreshIntervalOverrideMs).toBeNull()
  })

  it('turns blank override text into null', () => {
    expect(parseTileSettings(draft('   '))?.refreshIntervalOverrideMs).toBeNull()
  })

  it('parses a valid override', () => {
    expect(parseTileSettings(draft('9000'))?.refreshIntervalOverrideMs).toBe(9000)
  })

  it('accepts the floor itself', () => {
    expect(parseTileSettings(draft('250'))?.refreshIntervalOverrideMs).toBe(250)
  })

  it('rejects an override below the floor', () => {
    expect(parseTileSettings(draft('249'))).toBeNull()
    expect(parseTileSettings(draft('0'))).toBeNull()
    expect(parseTileSettings(draft('-1'))).toBeNull()
  })

  it('rejects text that is not an integer', () => {
    expect(parseTileSettings(draft('250.5'))).toBeNull()
    expect(parseTileSettings(draft('fast'))).toBeNull()
  })

  //+_+// customTitle 은 양끝 공백만 다듬는다. 빈 값이 미지정이다
  it('trims the custom title', () => {
    const trimmed = parseTileSettings({ ...draft(''), customTitle: '  Named  ' })
    expect(trimmed?.customTitle).toBe('Named')
  })
})

describe('v1 15.6 - fitMode reaches the view model', () => {
  it('carries contain through', () => {
    const views = buildTileViews(project([tile('t1', 0, 0)]), [], [])
    expect(views[0].fitMode).toBe('contain')
  })

  it('carries cover through', () => {
    const covered = { ...tile('t1', 0, 0), fitMode: 'cover' as const }
    const views = buildTileViews(project([covered]), [], [])
    expect(views[0].fitMode).toBe('cover')
  })
})
