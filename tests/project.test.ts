import { describe, expect, it } from 'vitest'
import {
  STORAGE_KEY,
  deserializeProject,
  deserializeState,
  loadState,
  saveState,
  serializeProject,
  serializeState,
} from '../src/shared/storage'
import type { KeyValueBackend } from '../src/shared/storage'
import type { Project, WebTile } from '../src/shared/types'

function tile(id: string, x: number, y: number): WebTile {
  return {
    id,
    launchUrl: 'https://example.com/',
    matchMode: 'origin',
    x,
    y,
    w: 1,
    h: 1,
    refreshIntervalMs: 2000,
    fitMode: 'contain',
    keepAlive: false,
  }
}

function project(tiles: WebTile[]): Project {
  return {
    id: 'p1',
    name: 'Development',
    gridColumns: 4,
    gridRows: 4,
    keepManagedTabsAlive: true,
    tiles,
  }
}

const RUNTIME_KEYS = [
  'tileId',
  'tabId',
  'windowId',
  'title',
  'currentUrl',
  'favIconUrl',
  'status',
  'lastCaptureAt',
  'lastRoundDurationMs',
  'consecutiveCaptureFailures',
]

function inMemoryBackend(initial: Record<string, unknown> = {}): KeyValueBackend {
  const store = new Map<string, unknown>(Object.entries(initial))
  return {
    get: (key) => Promise.resolve(store.has(key) ? store.get(key) : undefined),
    set: (key, value) => {
      store.set(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      store.delete(key)
      return Promise.resolve()
    },
  }
}

describe('v1 25.1 item 5 - project serialization', () => {
  it('round trips a project to a deeply equal value', () => {
    const original = project([tile('t1', 0, 0), tile('t2', 1, 0)])
    expect(deserializeProject(serializeProject(original))).toEqual(original)
  })

  it('preserves the order of the tiles array', () => {
    const original = project([tile('t3', 0, 0), tile('t1', 1, 0), tile('t2', 2, 0)])
    const restored = deserializeProject(serializeProject(original))
    expect(restored?.tiles.map((entry) => entry.id)).toEqual(['t3', 't1', 't2'])
  })

  it('includes schemaVersion in the serialized envelope', () => {
    expect(serializeState([project([])], 'p1').schemaVersion).toBe(2)
  })

  it('rejects an envelope whose schemaVersion does not match', () => {
    const result = deserializeState({ schemaVersion: 3, projects: [], activeProjectId: 'p1' })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, errorCode: 'SCHEMA_VERSION_MISMATCH' })
  })

  //+_+// P5-D17. 1 -> 2 마이그레이션을 만들지 않기로 했다. 그 의도를 시험으로 고정한다
  it('rejects a schemaVersion 1 envelope rather than migrating it', () => {
    const result = deserializeState({ schemaVersion: 1, projects: [] })
    expect(result).toMatchObject({ ok: false, errorCode: 'SCHEMA_VERSION_MISMATCH' })
  })

  it('drops every TileRuntimeState field', () => {
    const dirtyTile = {
      ...tile('t1', 0, 0),
      tileId: 't1',
      tabId: 42,
      windowId: 7,
      title: 'runtime title',
      currentUrl: 'https://example.com/live',
      favIconUrl: 'https://example.com/icon.png',
      status: 'LIVE',
      lastCaptureAt: 1234,
      lastRoundDurationMs: 56,
      consecutiveCaptureFailures: 3,
    }
    const dirty = { ...project([]), tiles: [dirtyTile] }

    const serialized = serializeProject(dirty)

    for (const key of RUNTIME_KEYS) {
      expect(Object.hasOwn(serialized.tiles[0] as object, key)).toBe(false)
    }
  })

  it('drops tabId so a stale tab id can never be restored', () => {
    const dirty = { ...project([]), tiles: [{ ...tile('t1', 0, 0), tabId: 42 }] }
    const serialized = serializeProject(dirty)

    expect(Object.hasOwn(serialized.tiles[0] as object, 'tabId')).toBe(false)
    expect(JSON.stringify(serialized)).not.toContain('tabId')
  })

  it('drops unknown fields on the way in', () => {
    const input = {
      ...project([{ ...tile('t1', 0, 0), somethingElse: 'x' } as WebTile]),
      futureFlag: true,
    }
    const restored = deserializeProject(input)

    expect(restored).not.toBeNull()
    expect(Object.hasOwn(restored as object, 'futureFlag')).toBe(false)
    expect(Object.hasOwn(restored?.tiles[0] as object, 'somethingElse')).toBe(false)
  })

  it('rejects input that is missing a required field', () => {
    const withoutRequired = {
      id: 'p1',
      name: 'Development',
      gridColumns: 4,
      gridRows: 4,
      tiles: [],
    }
    expect(deserializeProject(withoutRequired)).toBeNull()
    expect(deserializeProject({ ...project([]), tiles: [{ id: 'only-an-id' }] })).toBeNull()
  })

  it('round trips an empty tiles array', () => {
    const original = project([])
    const restored = deserializeProject(serializeProject(original))

    expect(restored).toEqual(original)
    expect(restored?.tiles).toEqual([])
  })

  it('round trips a tile that leaves optional fields unspecified', () => {
    const withOptional: WebTile = { ...tile('t1', 0, 0), customTitle: 'Named' }
    const original = project([tile('t2', 1, 0), withOptional])
    const restored = deserializeProject(serializeProject(original))

    expect(restored).toEqual(original)
    expect(Object.hasOwn(restored?.tiles[0] as object, 'customTitle')).toBe(false)
    expect(restored?.tiles[1]?.customTitle).toBe('Named')
  })
})

describe('storage backend round trip - TASK-P2-01 section 8, outside v1 25.1', () => {
  it('round trips state through an injected backend', async () => {
    const backend = inMemoryBackend()
    const projects = [project([tile('t1', 0, 0)]), project([])]

    await saveState(backend, projects, 'p1')
    const result = await loadState(backend)

    expect(result).toEqual({ ok: true, activeProjectId: 'p1', projects })
  })

  //+_+// P5-D19. 활성 프로젝트는 같은 봉투에 실린다. 별도 키를 만들지 않는다
  it('round trips the active project id', async () => {
    const backend = inMemoryBackend()
    await saveState(backend, [project([]), { ...project([]), id: 'p2' }], 'p2')

    expect(await loadState(backend)).toMatchObject({ ok: true, activeProjectId: 'p2' })
  })

  it('rejects an envelope whose activeProjectId is not a string', () => {
    const result = deserializeState({ schemaVersion: 2, activeProjectId: 7, projects: [] })
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_STATE_SHAPE' })
  })

  it('reports an empty project list when the key is absent', async () => {
    const result = await loadState(inMemoryBackend())
    expect(result).toEqual({ ok: true, activeProjectId: '', projects: [] })
  })

  it('propagates a backend failure instead of swallowing it', async () => {
    const failing: KeyValueBackend = {
      get: () => Promise.reject(new Error('backend get failed')),
      set: () => Promise.reject(new Error('backend set failed')),
      remove: () => Promise.resolve(),
    }

    await expect(loadState(failing)).rejects.toThrow('backend get failed')
    await expect(saveState(failing, [], 'p1')).rejects.toThrow('backend set failed')
    expect(STORAGE_KEY.length).toBeGreaterThan(0)
  })
})

//+_+// P5-D21. 기존 refreshIntervalMs 의 의미를 바꾸지 않는다. 사용자 지정값은 별도 필드다
describe('P5-D21 - refreshIntervalOverrideMs survives the round trip', () => {
  it('round trips a tile that carries an override', () => {
    const withOverride: WebTile = { ...tile('t1', 0, 0), refreshIntervalOverrideMs: 9000 }
    const original = project([withOverride])

    expect(deserializeProject(serializeProject(original))).toEqual(original)
  })

  it('leaves the field absent when the tile has no override', () => {
    const restored = deserializeProject(serializeProject(project([tile('t1', 0, 0)])))
    expect(Object.hasOwn(restored?.tiles[0] as object, 'refreshIntervalOverrideMs')).toBe(false)
  })

  it('rejects an override that is not a number', () => {
    const dirty = {
      ...project([]),
      tiles: [{ ...tile('t1', 0, 0), refreshIntervalOverrideMs: 'fast' }],
    }
    expect(deserializeProject(dirty)).toBeNull()
  })
})
