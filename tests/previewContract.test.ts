import { describe, expect, it } from 'vitest'
import type { CaptureImageFormat, DashboardResponse } from '../src/shared/messages'
import type { TileStatus } from '../src/shared/types'

type CaptureSuccess = Extract<DashboardResponse, { ok: true; type: 'CAPTURE_TILE' }>

describe('TASK-P3-01 item 01 - CAPTURE_TILE success payload', () => {
  it('carries a base64 string, a format and a byte count', () => {
    const response: CaptureSuccess = {
      ok: true,
      type: 'CAPTURE_TILE',
      imageBase64: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD',
      format: 'jpeg',
      bytes: 82986,
    }

    expect(typeof response.imageBase64).toBe('string')
    expect(response.format).toBe('jpeg')
    expect(response.bytes).toBe(82986)
  })

  //+_+// 키를 빠뜨리거나 더하면 컴파일이 깨진다. 응답 모양을 타입에서 직접 끌어온다
  it('has exactly the five keys and no image field beyond them', () => {
    const keys: Record<keyof CaptureSuccess, true> = {
      ok: true,
      type: true,
      imageBase64: true,
      format: true,
      bytes: true,
    }

    expect(Object.keys(keys).sort()).toEqual(['bytes', 'format', 'imageBase64', 'ok', 'type'])
  })

  it('admits jpeg and png as the only formats', () => {
    const formats: Record<CaptureImageFormat, true> = { jpeg: true, png: true }
    expect(Object.keys(formats).sort()).toEqual(['jpeg', 'png'])
  })
})

describe('TASK-P3-01 item 02 - TileStatus after L19', () => {
  //+_+// 값을 빠뜨리거나 더하면 컴파일이 깨진다. 8개를 타입에서 직접 끌어온다
  const statuses: Record<TileStatus, true> = {
    LIVE: true,
    LOADING: true,
    STALE: true,
    FROZEN: true,
    DISCARDED: true,
    DETACHED: true,
    DEVTOOLS: true,
    ERROR: true,
  }

  it('holds exactly eight statuses', () => {
    expect(Object.keys(statuses)).toHaveLength(8)
  })

  it('keeps all seven statuses that v1 section 7 line 523~529 listed', () => {
    const v1Seven = ['LIVE', 'LOADING', 'STALE', 'FROZEN', 'DISCARDED', 'DETACHED', 'ERROR']

    expect(v1Seven).toHaveLength(7)
    for (const name of v1Seven) {
      expect(Object.hasOwn(statuses, name)).toBe(true)
    }
  })

  it('adds DEVTOOLS and does not add CAPTURE PAUSED', () => {
    expect(Object.hasOwn(statuses, 'DEVTOOLS')).toBe(true)
    expect(Object.hasOwn(statuses, 'CAPTURE PAUSED')).toBe(false)
    expect(Object.hasOwn(statuses, 'CAPTURE_PAUSED')).toBe(false)
  })
})
