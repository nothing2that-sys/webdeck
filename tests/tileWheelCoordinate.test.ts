import { describe, expect, it } from 'vitest'
import { tileWheelTargetPoint } from '../src/dashboard/tileWheelCoordinate'
import type { TileWheelCoordinateInput } from '../src/dashboard/tileWheelCoordinate'

function input(overrides: Partial<TileWheelCoordinateInput>): TileWheelCoordinateInput {
  return {
    offsetX: 0,
    offsetY: 0,
    boxWidth: 200,
    boxHeight: 100,
    naturalWidth: 400,
    naturalHeight: 200,
    fitMode: 'contain',
    scale: 1,
    ...overrides,
  }
}

describe('TASK-P11-01 (§8-6) - tile wheel coordinate conversion', () => {
  it('contain, matching aspect ratio -> no margin, center cursor maps to original center', () => {
    //+_+// box 200x100, natural 400x200. drawScale 0.5. drawnWidth/Height == box, margin 0
    const point = tileWheelTargetPoint(input({ offsetX: 100, offsetY: 50 }))
    expect(point).toEqual({ x: 200, y: 100 })
  })

  it('contain, original wider than box -> top/bottom letterbox, cursor on margin is null', () => {
    //+_+// box 200x200, natural 400x100. widthRatio 0.5, heightRatio 2 -> drawScale 0.5
    //+_+// drawnWidth 200, drawnHeight 50 -> marginY 75 top and bottom
    const point = tileWheelTargetPoint(
      input({ boxWidth: 200, boxHeight: 200, naturalWidth: 400, naturalHeight: 100, offsetX: 100, offsetY: 10 }),
    )
    expect(point).toBeNull()
  })

  it('contain, original taller than box -> left/right letterbox, cursor on margin is null', () => {
    //+_+// box 200x200, natural 100x400. widthRatio 2, heightRatio 0.5 -> drawScale 0.5
    //+_+// drawnWidth 50, drawnHeight 200 -> marginX 75 left and right
    const point = tileWheelTargetPoint(
      input({ boxWidth: 200, boxHeight: 200, naturalWidth: 100, naturalHeight: 400, offsetX: 10, offsetY: 100 }),
    )
    expect(point).toBeNull()
  })

  it('contain, cursor just inside the drawn image boundary is not null (boundary value)', () => {
    //+_+// 같은 배치. drawnWidth 200, drawnHeight 50, marginY 75. 여백 경계(75)는 이미지 쪽이다
    const onBoundary = tileWheelTargetPoint(
      input({ boxWidth: 200, boxHeight: 200, naturalWidth: 400, naturalHeight: 100, offsetX: 100, offsetY: 75 }),
    )
    expect(onBoundary).not.toBeNull()
    const justInsideMargin = tileWheelTargetPoint(
      input({ boxWidth: 200, boxHeight: 200, naturalWidth: 400, naturalHeight: 100, offsetX: 100, offsetY: 74 }),
    )
    expect(justInsideMargin).toBeNull()
  })

  it('cover, original wider than box -> left/right cropped, top-left cursor is inset from original top-left', () => {
    //+_+// box 200x200, natural 400x100. widthRatio 0.5, heightRatio 2 -> drawScale max 2
    //+_+// drawnWidth 800, drawnHeight 200 -> overflowX 300
    const point = tileWheelTargetPoint(
      input({
        fitMode: 'cover',
        boxWidth: 200,
        boxHeight: 200,
        naturalWidth: 400,
        naturalHeight: 100,
        offsetX: 0,
        offsetY: 0,
      }),
    )
    expect(point).not.toBeNull()
    expect(point?.x).toBeGreaterThan(0)
    expect(point?.y).toBe(0)
  })

  it('cover, no cursor inside the box is null', () => {
    const corners: Array<[number, number]> = [
      [0, 0],
      [200, 0],
      [0, 200],
      [200, 200],
      [100, 100],
    ]
    for (const [offsetX, offsetY] of corners) {
      const point = tileWheelTargetPoint(
        input({
          fitMode: 'cover',
          boxWidth: 200,
          boxHeight: 200,
          naturalWidth: 400,
          naturalHeight: 100,
          offsetX,
          offsetY,
        }),
      )
      expect(point).not.toBeNull()
    }
  })

  it('direction - box top-left and bottom-right cursors map to original top-left and bottom-right', () => {
    const topLeft = tileWheelTargetPoint(input({ offsetX: 0, offsetY: 0 }))
    const bottomRight = tileWheelTargetPoint(input({ offsetX: 200, offsetY: 100 }))
    expect(topLeft).toEqual({ x: 0, y: 0 })
    expect(bottomRight).toEqual({ x: 400, y: 200 })
  })

  it('scale 1 leaves the result unchanged; scale 2 halves the coordinates', () => {
    const atScale1 = tileWheelTargetPoint(input({ offsetX: 100, offsetY: 50, scale: 1 }))
    const atScale2 = tileWheelTargetPoint(input({ offsetX: 100, offsetY: 50, scale: 2 }))
    expect(atScale1).toEqual({ x: 200, y: 100 })
    expect(atScale2).toEqual({ x: 100, y: 50 })
  })

  it('naturalWidth or boxWidth of 0 guards against division by zero and returns null', () => {
    expect(tileWheelTargetPoint(input({ naturalWidth: 0 }))).toBeNull()
    expect(tileWheelTargetPoint(input({ boxWidth: 0 }))).toBeNull()
    expect(tileWheelTargetPoint(input({ naturalHeight: 0 }))).toBeNull()
    expect(tileWheelTargetPoint(input({ boxHeight: 0 }))).toBeNull()
  })
})
