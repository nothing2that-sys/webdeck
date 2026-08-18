import { describe, expect, it } from 'vitest'
import type { CaptureRecord } from '../src/background/previewCaptureManager'
import {
  DEV_TILE_SPAN,
  EMPTY_CAPTURE_SUMMARY,
  applyCaptureRecord,
  buildRuntimeState,
  createProject,
  newTile,
  planReconnect,
  resolveProjects,
  resolveRuntimeStatus,
} from '../src/background/projectState'
import type { ReconnectTarget } from '../src/background/projectState'
import { DEFAULT_PROJECT_ID } from '../src/shared/messages'
import { CAPTURE_INTERVAL_MS } from '../src/shared/scheduler'
import type { BrowserTabInfo, Project, WebTile } from '../src/shared/types'

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
    scheduleIntervalMs: 4000,
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

  //+_+// P5-D28. matchMode 기본값은 exact 다. 오매칭보다 미매칭이 안전한 실패다
  it('creates a tile with the P5-D28 defaults', () => {
    expect(newTile('t1', 'https://example.com/a', [])).toMatchObject({
      keepAlive: false,
      fitMode: 'contain',
      matchMode: 'exact',
    })
  })

  it('leaves the interval override unset so the span assignment applies', () => {
    const created = newTile('t1', 'https://example.com/a', [])
    expect(Object.hasOwn(created as object, 'refreshIntervalOverrideMs')).toBe(false)
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

  //+_+// P5-D38. v1 section 10 의 5단계다. 후보가 없으면 타일은 DETACHED 다
  //+_+// Phase 4 에는 미바인딩 타일이 존재할 수 없어 이 시험이 LOADING 을 고정하고 있었다
  //+_+// S1 이 저장을 붙이면서 저장값에서 올라온 미바인딩 타일이 처음 생겼다
  it('reports DETACHED for a tile that is not bound', () => {
    expect(resolveRuntimeStatus(null, undefined, null, false)).toBe('DETACHED')
  })

  //+_+// LOADING 은 두 경로로 남는다. 엔진이 등록했으나 첫 프레임 전, 그리고 탭은 살아 있으나 미등록
  it('still reports LOADING before the first frame of a registered tile', () => {
    expect(resolveRuntimeStatus('LIVE', 11, tabInfo(11), false)).toBe('LOADING')
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

//+_+// P5-D8. 저장 키 부재와 빈 목록을 구별하는 수단을 만들지 않는다. 비면 기본 프로젝트가 선다
//+_+// P5-D22. 기본 프로젝트의 id 는 DEFAULT_PROJECT_ID 다
describe('P5-D8 - resolveProjects always yields one active project', () => {
  function named(id: string): Project {
    return createProject(id, `project ${id}`)
  }

  it('creates the default project when the list is empty', () => {
    const resolved = resolveProjects([], '')

    expect(resolved.projects).toHaveLength(1)
    expect(resolved.projects[0]).toMatchObject({
      id: DEFAULT_PROJECT_ID,
      gridColumns: 4,
      gridRows: 4,
      tiles: [],
    })
    expect(resolved.activeProjectId).toBe(DEFAULT_PROJECT_ID)
  })

  it('creates the default project again after the last one was deleted', () => {
    const resolved = resolveProjects([], 'p9')
    expect(resolved.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect(resolved.projects.map((project) => project.id)).toEqual([DEFAULT_PROJECT_ID])
  })

  it('keeps the stored list and the stored active id when they agree', () => {
    const projects = [named('p1'), named('p2')]
    const resolved = resolveProjects(projects, 'p2')

    expect(resolved.projects).toBe(projects)
    expect(resolved.activeProjectId).toBe('p2')
  })

  it('falls back to the first project when the active id names none of them', () => {
    const resolved = resolveProjects([named('p1'), named('p2')], 'gone')
    expect(resolved.activeProjectId).toBe('p1')
  })

  it('falls back to the first project when the active id is empty', () => {
    const resolved = resolveProjects([named('p1')], '')
    expect(resolved.activeProjectId).toBe('p1')
  })

  it('does not add a second default project to a list that already has one', () => {
    const resolved = resolveProjects([named(DEFAULT_PROJECT_ID)], DEFAULT_PROJECT_ID)
    expect(resolved.projects).toHaveLength(1)
  })
})

describe('P5-D22 - createProject builds an empty 4x4 project', () => {
  it('uses the id and the name it was given', () => {
    expect(createProject('p1', 'Monitoring')).toEqual({
      id: 'p1',
      name: 'Monitoring',
      gridColumns: 4,
      gridRows: 4,
      keepManagedTabsAlive: false,
      tiles: [],
    })
  })

  //+_+// P5-D3. Keep Alive 를 새로 만들지 않는다. 기존 필드는 기본값으로만 남는다
  it('leaves keepManagedTabsAlive off', () => {
    expect(createProject('p1', 'Monitoring').keepManagedTabsAlive).toBe(false)
  })
})

//+_+// v1 section 10 의 판정이다. 후보 수가 셋으로 갈린다. 자동 선택 규칙을 만들지 않는다. P5-D15
describe('v1 10 - planReconnect decides by candidate count', () => {
  function target(tile: WebTile, boundTabId: number | null = null): ReconnectTarget {
    return { tile, boundTabId }
  }

  function tab(tabId: number, currentUrl: string): BrowserTabInfo {
    return { tabId, windowId: 1, currentUrl, title: `title ${String(tabId)}` }
  }

  function urlTile(id: string, launchUrl: string, matchMode: WebTile['matchMode'] = 'exact'): WebTile {
    return { ...tile(id, 0, 0), launchUrl, matchMode }
  }

  it('binds when exactly one tab matches', () => {
    const tiles = [target(urlTile('t1', 'https://a.com/one'))]
    const tabs = [tab(11, 'https://a.com/one'), tab(12, 'https://a.com/two')]

    expect(planReconnect(tiles, tabs)).toEqual([{ tileId: 't1', kind: 'bind', tabId: 11 }])
  })

  it('leaves the tile alone when no tab matches', () => {
    const tiles = [target(urlTile('t1', 'https://a.com/one'))]
    expect(planReconnect(tiles, [tab(12, 'https://a.com/two')])).toEqual([
      { tileId: 't1', kind: 'none' },
    ])
  })

  //+_+// P5-D15. 가장 적절한 후보의 판정 규칙이 v1 어디에도 없다. 지어내지 않는다
  it('refuses to choose when two tabs match', () => {
    const tiles = [target(urlTile('t1', 'https://a.com/one'))]
    const tabs = [tab(11, 'https://a.com/one'), tab(12, 'https://a.com/one')]

    expect(planReconnect(tiles, tabs)).toEqual([
      { tileId: 't1', kind: 'ambiguous', tabIds: [11, 12] },
    ])
  })

  it('refuses to choose when three tabs match', () => {
    const tiles = [target(urlTile('t1', 'https://a.com/one'))]
    const tabs = [11, 12, 13].map((id) => tab(id, 'https://a.com/one'))

    expect(planReconnect(tiles, tabs)[0]).toMatchObject({ kind: 'ambiguous' })
  })

  it('skips a tile whose binding is still alive', () => {
    const tiles = [target(urlTile('t1', 'https://a.com/one'), 11)]
    expect(planReconnect(tiles, [tab(11, 'https://a.com/one')])).toEqual([])
  })

  //+_+// P5-D36. 살아 있는 바인딩이 점유한 탭은 다른 타일의 후보가 되지 않는다
  it('keeps a tab that another tile already holds out of the candidates', () => {
    const tiles = [
      target(urlTile('held', 'https://a.com/one'), 11),
      target(urlTile('t2', 'https://a.com/one')),
    ]
    const tabs = [tab(11, 'https://a.com/one')]

    expect(planReconnect(tiles, tabs)).toEqual([{ tileId: 't2', kind: 'none' }])
  })

  //+_+// P5-D36. 순서를 정하지 않으면 결과가 비결정적이 된다. 배열 순서가 저장 순서다
  it('lets the earlier tile in the array take a shared candidate', () => {
    const tiles = [target(urlTile('first', 'https://a.com/one')), target(urlTile('second', 'https://a.com/one'))]
    const tabs = [tab(11, 'https://a.com/one')]

    expect(planReconnect(tiles, tabs)).toEqual([
      { tileId: 'first', kind: 'bind', tabId: 11 },
      { tileId: 'second', kind: 'none' },
    ])
  })

  it('does not let an ambiguous tile claim any tab', () => {
    const tiles = [
      target(urlTile('ambiguous', 'https://a.com/one')),
      target(urlTile('later', 'https://a.com/one')),
    ]
    const tabs = [tab(11, 'https://a.com/one'), tab(12, 'https://a.com/one')]

    expect(planReconnect(tiles, tabs)).toEqual([
      { tileId: 'ambiguous', kind: 'ambiguous', tabIds: [11, 12] },
      { tileId: 'later', kind: 'ambiguous', tabIds: [11, 12] },
    ])
  })

  it('matches each tile by its own matchMode', () => {
    const tabs = [tab(11, 'https://a.com/p?a=1'), tab(12, 'https://b.com/p/deep')]

    expect(planReconnect([target(urlTile('t', 'https://a.com/p?a=1', 'exact'))], tabs)).toEqual([
      { tileId: 't', kind: 'bind', tabId: 11 },
    ])
    expect(planReconnect([target(urlTile('t', 'https://a.com/other', 'origin'))], tabs)).toEqual([
      { tileId: 't', kind: 'bind', tabId: 11 },
    ])
    expect(planReconnect([target(urlTile('t', 'https://b.com/p', 'prefix'))], tabs)).toEqual([
      { tileId: 't', kind: 'bind', tabId: 12 },
    ])
  })

  //+_+// 앞 타일이 후보를 가져가면 뒤 타일의 후보 수가 줄어 판정이 달라진다
  it('narrows a later tile candidates by what an earlier tile took', () => {
    const tiles = [
      target(urlTile('exact', 'https://a.com/p?a=1', 'exact')),
      target(urlTile('origin', 'https://a.com/anything', 'origin')),
    ]
    const tabs = [tab(11, 'https://a.com/p?a=1'), tab(12, 'https://a.com/p/deep')]

    expect(planReconnect(tiles, tabs)).toEqual([
      { tileId: 'exact', kind: 'bind', tabId: 11 },
      { tileId: 'origin', kind: 'bind', tabId: 12 },
    ])
  })

  //+_+// launchUrl 이 비면 어떤 탭과도 매치되지 않는다. urlMatches 가 파싱 실패를 false 로 만든다
  it('finds no candidate for a tile with an empty launch url', () => {
    const tiles = [target(urlTile('blank', ''))]
    expect(planReconnect(tiles, [tab(11, 'https://a.com/one')])).toEqual([
      { tileId: 'blank', kind: 'none' },
    ])
  })

  it('returns nothing for an empty tile list', () => {
    expect(planReconnect([], [tab(11, 'https://a.com/one')])).toEqual([])
  })

  it('reports every tile as unmatched when no tab is open', () => {
    const tiles = [target(urlTile('t1', 'https://a.com/one')), target(urlTile('t2', 'https://a.com/two'))]
    expect(planReconnect(tiles, [])).toEqual([
      { tileId: 't1', kind: 'none' },
      { tileId: 't2', kind: 'none' },
    ])
  })
})
