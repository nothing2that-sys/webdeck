import { describe, expect, it } from 'vitest'
import {
  PAUSE_KEY,
  REJECTED_KEY,
  STORAGE_KEY,
  deserializeProject,
  deserializeState,
  loadPreviewPaused,
  loadState,
  readPreviewPaused,
  savePreviewPaused,
  saveState,
  serializeProject,
  serializeState,
} from '../src/shared/storage'
import type { KeyValueBackend } from '../src/shared/storage'
import { MIN_TILE_INTERVAL_MS } from '../src/shared/scheduler'
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

//+_+// P7-D88. 거부된 저장값을 백업 키로 옮긴다. J84 가 막으려던 소실을 메운다
describe('P7-D88 - a rejected envelope is moved to the backup key', () => {
  const rejected = { schemaVersion: 1, activeProjectId: 'p1', projects: [] }

  it('keeps the rejected original under the backup key', async () => {
    const backend = inMemoryBackend({ [STORAGE_KEY]: rejected })

    const result = await loadState(backend)

    expect(result).toMatchObject({ ok: false, errorCode: 'SCHEMA_VERSION_MISMATCH' })
    expect(await backend.get(REJECTED_KEY)).toEqual(rejected)
  })

  //+_+// 첫 거부의 원본이 진짜 사용자 데이터다. 그 뒤의 값은 우리가 쓴 것일 수 있다
  it('does not let a second rejection overwrite the backup', async () => {
    const backend = inMemoryBackend({ [STORAGE_KEY]: rejected })
    await loadState(backend)

    const second = { schemaVersion: 1, activeProjectId: 'p2', projects: [] }
    await backend.set(STORAGE_KEY, second)
    await loadState(backend)

    expect(await backend.get(REJECTED_KEY)).toEqual(rejected)
  })

  it('writes nothing to the backup key when the envelope loads', async () => {
    const backend = inMemoryBackend()
    await saveState(backend, [project([tile('t1', 0, 0)])], 'p1')

    expect(await loadState(backend)).toMatchObject({ ok: true })
    expect(await backend.get(REJECTED_KEY)).toBeUndefined()
  })

  //+_+// 키 부재는 거부가 아니다. P5-D8 대로 빈 목록으로 서고 백업도 만들지 않는다
  it('writes nothing to the backup key when the state key is absent', async () => {
    const backend = inMemoryBackend()

    expect(await loadState(backend)).toEqual({ ok: true, activeProjectId: '', projects: [] })
    expect(await backend.get(REJECTED_KEY)).toBeUndefined()
  })

  //+_+// 거부 시 반환값과 씨앗 폴백은 종전과 같다. 백업이 그 축을 건드리지 않는다
  it('leaves the rejection result and the stored state untouched', async () => {
    const backend = inMemoryBackend({ [STORAGE_KEY]: rejected })

    const result = await loadState(backend)

    expect(result).toEqual({
      ok: false,
      errorCode: 'SCHEMA_VERSION_MISMATCH',
      message: 'Expected schemaVersion 2, found 1',
    })
    expect(await backend.get(STORAGE_KEY)).toEqual(rejected)
  })

  it('names the backup key apart from the state key', () => {
    expect(REJECTED_KEY).not.toBe(STORAGE_KEY)
    expect(REJECTED_KEY.startsWith('webdeck.')).toBe(true)
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

//+_+// P5-D26. 구동자 격자보다 짧은 주기는 표현할 수 없다. 저장 경로에서 먼저 막는다
describe('P5-D26 - the override floor is the driver tick', () => {
  function withOverride(value: unknown) {
    return {
      ...project([]),
      tiles: [{ ...tile('t1', 0, 0), refreshIntervalOverrideMs: value }],
    }
  }

  it('accepts the floor itself', () => {
    expect(MIN_TILE_INTERVAL_MS).toBe(250)
    expect(deserializeProject(withOverride(250))?.tiles[0].refreshIntervalOverrideMs).toBe(250)
  })

  it('accepts a value above the floor', () => {
    expect(deserializeProject(withOverride(9000))?.tiles[0].refreshIntervalOverrideMs).toBe(9000)
  })

  it('rejects a value one below the floor', () => {
    expect(deserializeProject(withOverride(249))).toBeNull()
  })

  it('rejects zero and a negative value', () => {
    expect(deserializeProject(withOverride(0))).toBeNull()
    expect(deserializeProject(withOverride(-1))).toBeNull()
  })

  it('rejects a value that is not an integer', () => {
    expect(deserializeProject(withOverride(250.5))).toBeNull()
    expect(deserializeProject(withOverride(Number.NaN))).toBeNull()
  })

  //+_+// 기존 refreshIntervalMs 의 검증 규칙은 바꾸지 않는다. 하한은 사용자 지정값에만 건다
  it('leaves the span assigned refreshIntervalMs rule alone', () => {
    const belowFloor = { ...project([]), tiles: [{ ...tile('t1', 0, 0), refreshIntervalMs: 1 }] }
    expect(deserializeProject(belowFloor)).not.toBeNull()
  })
})


//+_+// D6c. Pause 는 상태 봉투 밖의 별도 키다. schemaVersion 과 deserializeState 를 지나지 않는다
describe('D6c - the pause flag lives in a key of its own', () => {
  class Store implements KeyValueBackend {
    readonly store = new Map<string, unknown>()

    get(key: string): Promise<unknown> {
      return Promise.resolve(this.store.get(key))
    }

    set(key: string, value: unknown): Promise<void> {
      this.store.set(key, value)
      return Promise.resolve()
    }

    remove(key: string): Promise<void> {
      this.store.delete(key)
      return Promise.resolve()
    }
  }

  it('does not use the state key', () => {
    expect(PAUSE_KEY).not.toBe(STORAGE_KEY)
  })

  //+_+// A-e5. 워커가 죽었다 살아나도 수동 Pause 가 유지된다는 뜻이 이 왕복이다
  it('reads back what it wrote', async () => {
    const backend = new Store()
    await savePreviewPaused(backend, true)
    expect(await loadPreviewPaused(backend)).toBe(true)

    await savePreviewPaused(backend, false)
    expect(await loadPreviewPaused(backend)).toBe(false)
  })

  it('reads a missing key as not paused', async () => {
    expect(await loadPreviewPaused(new Store())).toBe(false)
  })

  //+_+// 손상된 값 때문에 캡처가 영영 멈추면 안 된다. 참이 아닌 것은 전부 Pause 아님이다
  it('reads anything that is not the boolean true as not paused', () => {
    expect(readPreviewPaused('true')).toBe(false)
    expect(readPreviewPaused(1)).toBe(false)
    expect(readPreviewPaused(null)).toBe(false)
    expect(readPreviewPaused({ paused: true })).toBe(false)
  })

  //+_+// 저장 봉투를 건드리지 않는다는 것이 D6c 의 조건이다
  it('leaves the state envelope untouched', async () => {
    const backend = new Store()
    await saveState(backend, [], 'p1')
    await savePreviewPaused(backend, true)

    const stored = backend.store.get(STORAGE_KEY)
    expect(stored).toMatchObject({ schemaVersion: 2 })
    expect(Object.hasOwn(stored as object, 'previewPaused')).toBe(false)
  })
})
