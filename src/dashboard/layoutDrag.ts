import { GRID_COLUMNS, GRID_ROWS, isPlacementValid } from '../shared/grid'
import type { GridPosition, GridRect } from '../shared/grid'
import type { WebTile } from '../shared/types'
import { gridArea } from './tileView'

//+_+// React 도 DOM 도 import 하지 않는다. P4-D6 이 순수 모듈을 node 환경에서 시험하기로 했다
//+_+// 픽셀을 읽는 것은 App 이 한다. 여기는 읽어 온 수치만 받는다
export interface GridMetrics {
  left: number
  top: number
  width: number
  height: number
  gap: number
}

export type DragMode = 'move' | 'resize'

//+_+// originRect 는 drag 를 시작한 시점의 자리다. 무효한 Drop 은 여기로 되돌아간다. v1 section 7.2
//+_+// startCell 은 pointerdown 이 가리킨 셀이다. 이동량은 이 셀과의 차이므로 타일을 잡은 위치가 유지된다
export interface DragState {
  tileId: string
  mode: DragMode
  originRect: GridRect
  startCell: GridPosition
  rect: GridRect
  valid: boolean
}

export interface DropIndicator {
  gridArea: string
  className: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function sameRect(a: GridRect, b: GridRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

function toRect(tile: WebTile): GridRect {
  return { x: tile.x, y: tile.y, w: tile.w, h: tile.h }
}

//+_+// 폭에는 gap 이 columns - 1 개 들어 있다. 그래서 피치는 (폭 + gap) / columns 다
export function cellPitch(metrics: GridMetrics): { x: number; y: number } {
  return {
    x: (metrics.width + metrics.gap) / GRID_COLUMNS,
    y: (metrics.height + metrics.gap) / GRID_ROWS,
  }
}

//+_+// gap 구간은 그 앞 셀에 속한다. 셀 사이에 좌표 없는 띠를 만들지 않는다
//+_+// 그리드 밖을 가리켜도 셀 좌표는 그리드 안이다. 밖으로 나간 rect 를 CSS Grid 에 넘기지 않는다
export function pointerToCell(
  clientX: number,
  clientY: number,
  metrics: GridMetrics,
): GridPosition {
  const pitch = cellPitch(metrics)
  if (pitch.x <= 0 || pitch.y <= 0) {
    return { x: 0, y: 0 }
  }
  return {
    x: clamp(Math.floor((clientX - metrics.left) / pitch.x), 0, GRID_COLUMNS - 1),
    y: clamp(Math.floor((clientY - metrics.top) / pitch.y), 0, GRID_ROWS - 1),
  }
}

//+_+// span 은 그대로다. 이동으로 그리드를 벗어나지 않도록 자른다
export function movedRect(
  origin: GridRect,
  startCell: GridPosition,
  cell: GridPosition,
): GridRect {
  return {
    x: clamp(origin.x + (cell.x - startCell.x), 0, GRID_COLUMNS - origin.w),
    y: clamp(origin.y + (cell.y - startCell.y), 0, GRID_ROWS - origin.h),
    w: origin.w,
    h: origin.h,
  }
}

//+_+// Resize Handle 은 오른쪽 아래다. 포인터가 가리킨 셀이 마지막으로 덮이는 셀이다
//+_+// 왼쪽 위로 끌어도 x 와 y 는 움직이지 않는다. 1 칸 밑으로는 줄지 않는다
export function resizedRect(origin: GridRect, cell: GridPosition): GridRect {
  return {
    x: origin.x,
    y: origin.y,
    w: clamp(cell.x - origin.x + 1, 1, GRID_COLUMNS - origin.x),
    h: clamp(cell.y - origin.y + 1, 1, GRID_ROWS - origin.y),
  }
}

export function beginDrag(tile: WebTile, mode: DragMode, startCell: GridPosition): DragState {
  return {
    tileId: tile.id,
    mode,
    originRect: toRect(tile),
    startCell,
    rect: toRect(tile),
    valid: true,
  }
}

//+_+// 판정은 shared/grid 의 isPlacementValid 하나다. excludeTileId 로 자기 자신을 뺀다
//+_+// 자동 밀어내기를 만들지 않는다. 남의 자리를 침범한 rect 는 무효로 표시만 한다. v1 section 7.2
//+_+// 기하의 기준은 originRect 다. drag 중에 폴링이 새 목록을 가져와도 잡은 자리가 흔들리지 않는다
export function dragTo(
  state: DragState,
  cell: GridPosition,
  tiles: readonly WebTile[],
): DragState {
  const rect =
    state.mode === 'move'
      ? movedRect(state.originRect, state.startCell, cell)
      : resizedRect(state.originRect, cell)
  return { ...state, rect, valid: isPlacementValid(rect, tiles, state.tileId) }
}

//+_+// 워커에 보낼 rect 다. 무효하거나 제자리면 아무것도 요청하지 않는다
export function dropRect(state: DragState): GridRect | null {
  if (!state.valid || sameRect(state.rect, state.originRect)) {
    return null
  }
  return state.rect
}

//+_+// 색은 theme.css 의 token 에만 있다. 여기서는 클래스 이름만 만든다. v1 section 7 line 532
export function dragClassName(state: DragState | null, tileId: string): string {
  if (state === null || state.tileId !== tileId) {
    return ''
  }
  return state.valid ? 'tile--dragging' : 'tile--dragging tile--invalid'
}

//+_+// 후보 자리를 덧그리는 사각이다. 무효한 자리를 사용자가 볼 수 있어야 한다. v1 section 7.2
export function dropIndicator(state: DragState | null): DropIndicator | null {
  if (state === null) {
    return null
  }
  return {
    gridArea: gridArea(state.rect),
    className: `drop-indicator drop-indicator--${state.valid ? 'valid' : 'invalid'}`,
  }
}
