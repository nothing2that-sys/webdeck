import { describe, expect, it } from 'vitest'
import {
  beginDrag,
  cellPitch,
  dragClassName,
  dragTo,
  dropIndicator,
  dropRect,
  movedRect,
  pointerToCell,
  resizedRect,
} from '../src/dashboard/layoutDrag'
import type { GridMetrics } from '../src/dashboard/layoutDrag'
import type { WebTile } from '../src/shared/types'

//+_+// 셀 100 / gap 8 / 4열이면 폭은 4x100 + 3x8 = 424 이고 피치는 108 이다. 계산식이 아니라 고정값이다
const METRICS: GridMetrics = { left: 20, top: 40, width: 424, height: 424, gap: 8 }

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

describe('S4 - the pointer position becomes a grid cell', () => {
  it('takes the gap out of the pitch', () => {
    expect(cellPitch(METRICS)).toEqual({ x: 108, y: 108 })
  })

  it('reads the top left cell at the grid origin', () => {
    expect(pointerToCell(20, 40, METRICS)).toEqual({ x: 0, y: 0 })
  })

  it('stays in the first cell until the pitch is crossed', () => {
    expect(pointerToCell(20 + 107, 40 + 107, METRICS)).toEqual({ x: 0, y: 0 })
    expect(pointerToCell(20 + 108, 40 + 108, METRICS)).toEqual({ x: 1, y: 1 })
  })

  it('reads x on the horizontal axis and y on the vertical axis', () => {
    expect(pointerToCell(20 + 324, 40 + 108, METRICS)).toEqual({ x: 3, y: 1 })
  })

  it('clamps a pointer that left the grid to the nearest cell', () => {
    expect(pointerToCell(-500, -500, METRICS)).toEqual({ x: 0, y: 0 })
    expect(pointerToCell(5000, 5000, METRICS)).toEqual({ x: 3, y: 3 })
  })

  it('reports the first cell rather than dividing by zero', () => {
    expect(pointerToCell(100, 100, { left: 0, top: 0, width: 0, height: 0, gap: 0 })).toEqual({
      x: 0,
      y: 0,
    })
  })
})

describe('v1 7.2 - a move keeps the span and stays inside the grid', () => {
  it('follows the cell delta rather than the pointer cell', () => {
    expect(movedRect(tile('t1', 1, 1), { x: 1, y: 1 }, { x: 2, y: 3 })).toEqual({
      x: 2,
      y: 3,
      w: 1,
      h: 1,
    })
  })

  it('grabs a wide tile where the pointer went down', () => {
    expect(movedRect(tile('t1', 0, 0, 2, 2), { x: 1, y: 1 }, { x: 2, y: 2 })).toEqual({
      x: 1,
      y: 1,
      w: 2,
      h: 2,
    })
  })

  it('clamps the move so the rect never leaves the 4x4 grid', () => {
    expect(movedRect(tile('t1', 0, 0, 2, 2), { x: 0, y: 0 }, { x: 3, y: 3 })).toEqual({
      x: 2,
      y: 2,
      w: 2,
      h: 2,
    })
  })

  it('clamps a negative move to the origin', () => {
    expect(movedRect(tile('t1', 1, 1), { x: 3, y: 3 }, { x: 0, y: 0 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    })
  })
})

describe('v1 7.2 - a resize keeps the origin and grows to the pointer cell', () => {
  it('makes the pointer cell the last covered cell', () => {
    expect(resizedRect(tile('t1', 1, 1), { x: 2, y: 3 })).toEqual({ x: 1, y: 1, w: 2, h: 3 })
  })

  it('never shrinks below one cell', () => {
    expect(resizedRect(tile('t1', 2, 2), { x: 0, y: 0 })).toEqual({ x: 2, y: 2, w: 1, h: 1 })
  })

  it('clamps the span at the grid edge', () => {
    expect(resizedRect(tile('t1', 2, 0), { x: 3, y: 3 })).toEqual({ x: 2, y: 0, w: 2, h: 4 })
  })
})

describe('S4 - the drop is judged by shared grid.isPlacementValid', () => {
  const tiles = [tile('t1', 0, 0), tile('t2', 2, 2, 2, 2)]

  it('starts valid and unchanged', () => {
    const state = beginDrag(tiles[0], 'move', { x: 0, y: 0 })
    expect(state).toMatchObject({ tileId: 't1', mode: 'move', valid: true })
    expect(state.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('marks a move onto an occupied cell invalid', () => {
    const state = dragTo(beginDrag(tiles[0], 'move', { x: 0, y: 0 }), { x: 2, y: 2 }, tiles)
    expect(state.rect).toEqual({ x: 2, y: 2, w: 1, h: 1 })
    expect(state.valid).toBe(false)
  })

  it('marks a move onto a free cell valid', () => {
    const state = dragTo(beginDrag(tiles[0], 'move', { x: 0, y: 0 }), { x: 1, y: 0 }, tiles)
    expect(state.valid).toBe(true)
  })

  it('excludes the dragged tile from the overlap test', () => {
    const state = dragTo(beginDrag(tiles[1], 'resize', { x: 3, y: 3 }), { x: 3, y: 3 }, tiles)
    expect(state.rect).toEqual({ x: 2, y: 2, w: 2, h: 2 })
    expect(state.valid).toBe(true)
  })

  it('marks a resize that runs into another tile invalid', () => {
    const state = dragTo(beginDrag(tiles[0], 'resize', { x: 0, y: 0 }), { x: 3, y: 3 }, tiles)
    expect(state.rect).toEqual({ x: 0, y: 0, w: 4, h: 4 })
    expect(state.valid).toBe(false)
  })

  it('keeps the origin rect through the whole drag', () => {
    const state = dragTo(beginDrag(tiles[0], 'move', { x: 0, y: 0 }), { x: 3, y: 3 }, tiles)
    expect(state.originRect).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})

describe('v1 7.2 - an invalid drop asks for nothing and the tile goes back', () => {
  const tiles = [tile('t1', 0, 0), tile('t2', 1, 0)]

  it('returns the rect of a valid drop that moved', () => {
    const state = dragTo(beginDrag(tiles[0], 'move', { x: 0, y: 0 }), { x: 0, y: 1 }, tiles)
    expect(dropRect(state)).toEqual({ x: 0, y: 1, w: 1, h: 1 })
  })

  it('returns null for an invalid drop', () => {
    const state = dragTo(beginDrag(tiles[0], 'move', { x: 0, y: 0 }), { x: 1, y: 0 }, tiles)
    expect(dropRect(state)).toBeNull()
  })

  it('returns null when the rect did not change', () => {
    const state = dragTo(beginDrag(tiles[0], 'move', { x: 0, y: 0 }), { x: 0, y: 0 }, tiles)
    expect(dropRect(state)).toBeNull()
  })
})

describe('S4 - the drag state names its own classes', () => {
  const tiles = [tile('t1', 0, 0), tile('t2', 1, 0)]

  it('names nothing while no drag is running', () => {
    expect(dragClassName(null, 't1')).toBe('')
    expect(dropIndicator(null)).toBeNull()
  })

  it('marks only the tile being dragged', () => {
    const state = beginDrag(tiles[0], 'move', { x: 0, y: 0 })
    expect(dragClassName(state, 't1')).toBe('tile--dragging')
    expect(dragClassName(state, 't2')).toBe('')
  })

  it('adds the invalid modifier once the candidate rect is invalid', () => {
    const state = dragTo(beginDrag(tiles[0], 'move', { x: 0, y: 0 }), { x: 1, y: 0 }, tiles)
    expect(dragClassName(state, 't1')).toBe('tile--dragging tile--invalid')
  })

  it('puts the indicator on the candidate rect', () => {
    const state = dragTo(beginDrag(tiles[0], 'move', { x: 0, y: 0 }), { x: 2, y: 1 }, tiles)
    expect(dropIndicator(state)).toEqual({
      gridArea: '2 / 3 / 3 / 4',
      className: 'drop-indicator drop-indicator--valid',
    })
  })

  it('marks the indicator invalid on an occupied rect', () => {
    const state = dragTo(beginDrag(tiles[0], 'move', { x: 0, y: 0 }), { x: 1, y: 0 }, tiles)
    expect(dropIndicator(state)).toEqual({
      gridArea: '1 / 2 / 2 / 3',
      className: 'drop-indicator drop-indicator--invalid',
    })
  })
})
