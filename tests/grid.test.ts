import { describe, expect, it } from 'vitest'
import {
  findFirstAvailablePosition,
  isPlacementValid,
  isWithinGrid,
  rectsOverlap,
} from '../src/shared/grid'
import type { WebTile } from '../src/shared/types'

function tile(id: string, x: number, y: number, w: number, h: number): WebTile {
  return {
    id,
    launchUrl: 'https://example.com/',
    matchMode: 'origin',
    x,
    y,
    w,
    h,
    refreshIntervalMs: 2000,
    fitMode: 'contain',
    keepAlive: false,
  }
}

describe('v1 25.1 item 1 - grid collision', () => {
  it('reports overlap when a 1x1 sits fully inside a 2x2', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 1, h: 1 })).toBe(true)
  })

  it('reports overlap when only one cell is shared', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true)
  })

  it('does not report overlap when only edges touch', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 1 }, { x: 2, y: 0, w: 1, h: 1 })).toBe(false)
  })

  it('does not report overlap when only corners touch diagonally', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 1, h: 1 }, { x: 1, y: 1, w: 1, h: 1 })).toBe(false)
  })

  it('reports overlap for identical position and size', () => {
    expect(rectsOverlap({ x: 1, y: 1, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true)
  })

  it('treats a tile own position as free when that tile is excluded', () => {
    const tiles = [tile('a', 1, 1, 2, 2)]
    expect(isPlacementValid({ x: 1, y: 1, w: 2, h: 2 }, tiles, 'a')).toBe(true)
    expect(isPlacementValid({ x: 1, y: 1, w: 2, h: 2 }, tiles)).toBe(false)
  })
})

describe('v1 25.1 item 2 - grid boundary', () => {
  it('accepts x=3 w=1 and rejects x=3 w=2', () => {
    expect(isWithinGrid({ x: 3, y: 0, w: 1, h: 1 })).toBe(true)
    expect(isWithinGrid({ x: 3, y: 0, w: 2, h: 1 })).toBe(false)
  })

  it('accepts y=0 h=4 and rejects y=1 h=4', () => {
    expect(isWithinGrid({ x: 0, y: 0, w: 1, h: 4 })).toBe(true)
    expect(isWithinGrid({ x: 0, y: 1, w: 1, h: 4 })).toBe(false)
  })

  it('accepts the whole grid', () => {
    expect(isWithinGrid({ x: 0, y: 0, w: 4, h: 4 })).toBe(true)
  })

  it('rejects negative and out of range origins', () => {
    expect(isWithinGrid({ x: -1, y: 0, w: 1, h: 1 })).toBe(false)
    expect(isWithinGrid({ x: 0, y: -1, w: 1, h: 1 })).toBe(false)
    expect(isWithinGrid({ x: 4, y: 0, w: 1, h: 1 })).toBe(false)
  })

  it('rejects out of range spans', () => {
    expect(isWithinGrid({ x: 0, y: 0, w: 0, h: 1 })).toBe(false)
    expect(isWithinGrid({ x: 0, y: 0, w: 5, h: 1 })).toBe(false)
    expect(isWithinGrid({ x: 0, y: 0, w: 1, h: 0 })).toBe(false)
    expect(isWithinGrid({ x: 0, y: 0, w: 1, h: 5 })).toBe(false)
  })

  it('rejects non integer values', () => {
    expect(isWithinGrid({ x: 1.5, y: 0, w: 1, h: 1 })).toBe(false)
    expect(isWithinGrid({ x: 0, y: 1.5, w: 1, h: 1 })).toBe(false)
    expect(isWithinGrid({ x: 0, y: 0, w: 1.5, h: 1 })).toBe(false)
    expect(isWithinGrid({ x: 0, y: 0, w: 1, h: 1.5 })).toBe(false)
  })
})

describe('v1 25.1 item 3 - resize validation', () => {
  it('accepts a shrink that clears both boundary and collision', () => {
    const tiles = [tile('a', 0, 0, 2, 2), tile('b', 2, 0, 1, 1)]
    expect(isPlacementValid({ x: 0, y: 0, w: 1, h: 1 }, tiles, 'a')).toBe(true)
  })

  it('rejects a grow that leaves the grid', () => {
    const tiles = [tile('a', 3, 3, 1, 1)]
    expect(isPlacementValid({ x: 3, y: 3, w: 2, h: 1 }, tiles, 'a')).toBe(false)
  })

  it('rejects a grow that overlaps a neighbour', () => {
    const tiles = [tile('a', 0, 0, 1, 1), tile('b', 1, 0, 1, 1)]
    expect(isPlacementValid({ x: 0, y: 0, w: 2, h: 1 }, tiles, 'a')).toBe(false)
  })

  it('accepts a grow into empty space', () => {
    const tiles = [tile('a', 0, 0, 1, 1), tile('b', 3, 3, 1, 1)]
    expect(isPlacementValid({ x: 0, y: 0, w: 2, h: 2 }, tiles, 'a')).toBe(true)
  })

  it('does not mistake the resized tile itself for a collision', () => {
    const tiles = [tile('a', 1, 1, 1, 1)]
    expect(isPlacementValid({ x: 1, y: 1, w: 2, h: 2 }, tiles, 'a')).toBe(true)
  })

  it('does not mutate its inputs when the placement is invalid', () => {
    const tiles = [tile('a', 0, 0, 1, 1), tile('b', 1, 0, 1, 1)]
    const snapshot = structuredClone(tiles)
    const rect = { x: 0, y: 0, w: 2, h: 1 }
    const rectSnapshot = structuredClone(rect)

    expect(isPlacementValid(rect, tiles, 'a')).toBe(false)
    expect(tiles).toEqual(snapshot)
    expect(rect).toEqual(rectSnapshot)
  })
})

describe('v1 25.1 item 4 - first available position', () => {
  it('places a 1x1 at the origin of an empty grid', () => {
    expect(findFirstAvailablePosition(1, 1, [])).toEqual({ x: 0, y: 0 })
  })

  it('places a 4x4 at the origin of an empty grid', () => {
    expect(findFirstAvailablePosition(4, 4, [])).toEqual({ x: 0, y: 0 })
  })

  it('scans rows first so a 1x1 lands right of a 2x2 at the origin', () => {
    expect(findFirstAvailablePosition(1, 1, [tile('a', 0, 0, 2, 2)])).toEqual({ x: 2, y: 0 })
  })

  it('returns null when a 3x3 cannot fit beside a 2x2 at the origin', () => {
    expect(findFirstAvailablePosition(3, 3, [tile('a', 0, 0, 2, 2)])).toBeNull()
  })

  it('returns null when the grid is fully occupied', () => {
    expect(findFirstAvailablePosition(1, 1, [tile('a', 0, 0, 4, 4)])).toBeNull()
  })

  it('is deterministic when free cells are scattered', () => {
    const tiles = [tile('a', 0, 0, 1, 1), tile('b', 2, 0, 1, 1), tile('c', 1, 1, 1, 1)]
    expect(findFirstAvailablePosition(1, 1, tiles)).toEqual({ x: 1, y: 0 })
    expect(findFirstAvailablePosition(1, 1, tiles)).toEqual(findFirstAvailablePosition(1, 1, tiles))
  })

  it('returns null without throwing when the requested span exceeds the grid', () => {
    expect(findFirstAvailablePosition(5, 1, [])).toBeNull()
    expect(findFirstAvailablePosition(1, 5, [])).toBeNull()
    expect(findFirstAvailablePosition(0, 1, [])).toBeNull()
    expect(findFirstAvailablePosition(1.5, 1, [])).toBeNull()
  })
})
