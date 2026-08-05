import type { WebTile } from './types'

export const GRID_COLUMNS = 4

export const GRID_ROWS = 4

export interface GridRect {
  x: number
  y: number
  w: number
  h: number
}

export interface GridPosition {
  x: number
  y: number
}

//+_+// v1 section 7.2 line 566~571 의 경계 조건이다. x 0..3 / y 0..3 / w 1..4 / h 1..4 / x+w <= 4 / y+h <= 4
export function isWithinGrid(rect: GridRect): boolean {
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isInteger)) {
    return false
  }
  if (rect.x < 0 || rect.y < 0 || rect.w < 1 || rect.h < 1) {
    return false
  }
  return rect.x + rect.w <= GRID_COLUMNS && rect.y + rect.h <= GRID_ROWS
}

//+_+// 변만 접하는 것은 겹침이 아니다. 그래서 모든 비교가 등호 없는 부등호다
export function rectsOverlap(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

//+_+// excludeTileId 는 자기 자신과의 겹침 오판을 막는다. 이동과 크기 변경이 같은 판정을 쓴다
export function isPlacementValid(
  rect: GridRect,
  tiles: readonly WebTile[],
  excludeTileId?: string,
): boolean {
  if (!isWithinGrid(rect)) {
    return false
  }
  return !tiles.some((tile) => tile.id !== excludeTileId && rectsOverlap(rect, tile))
}

//+_+// 스캔 순서는 행 우선으로 고정한다. y 증가가 바깥, x 증가가 안쪽이다
export function findFirstAvailablePosition(
  w: number,
  h: number,
  tiles: readonly WebTile[],
): GridPosition | null {
  for (let y = 0; y < GRID_ROWS; y += 1) {
    for (let x = 0; x < GRID_COLUMNS; x += 1) {
      if (isPlacementValid({ x, y, w, h }, tiles)) {
        return { x, y }
      }
    }
  }
  return null
}
