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
  'lastCaptureDurationMs',
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
    expect(serializeState([project([])]).schemaVersion).toBe(1)
  })

  it('rejects an envelope whose schemaVersion does not match', () => {
    const result = deserializeState({ schemaVersion: 2, projects: [] })
    expect(result.ok).toBe(false)
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
      lastCaptureDurationMs: 56,
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

    await saveState(backend, projects)
    const result = await loadState(backend)

    expect(result).toEqual({ ok: true, projects })
  })

  it('reports an empty project list when the key is absent', async () => {
    const result = await loadState(inMemoryBackend())
    expect(result).toEqual({ ok: true, projects: [] })
  })

  it('propagates a backend failure instead of swallowing it', async () => {
    const failing: KeyValueBackend = {
      get: () => Promise.reject(new Error('backend get failed')),
      set: () => Promise.reject(new Error('backend set failed')),
      remove: () => Promise.resolve(),
    }

    await expect(loadState(failing)).rejects.toThrow('backend get failed')
    await expect(saveState(failing, [])).rejects.toThrow('backend set failed')
    expect(STORAGE_KEY.length).toBeGreaterThan(0)
  })
})
