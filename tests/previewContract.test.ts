import { describe, expect, it } from 'vitest'
import type {
  CaptureImageFormat,
  DashboardErrorCode,
  DashboardFailure,
  DashboardResponse,
} from '../src/shared/messages'
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

describe('TASK-P3-01 item 02 - TileStatus after L19 and P6-D3', () => {
  //+_+// 값을 빠뜨리거나 더하면 컴파일이 깨진다. 9개를 타입에서 직접 끌어온다
  //+_+// P6-D3. RESTRICTED 가 9번째다. v1 section 22 의 Restricted URL 이다
  const statuses: Record<TileStatus, true> = {
    LIVE: true,
    LOADING: true,
    STALE: true,
    FROZEN: true,
    DISCARDED: true,
    DETACHED: true,
    DEVTOOLS: true,
    ERROR: true,
    RESTRICTED: true,
  }

  it('holds exactly nine statuses', () => {
    expect(Object.keys(statuses)).toHaveLength(9)
  })

  //+_+// P6-D3. v1 section 22 가 이름을 주지 않았다. L29 와 v1 section 22 가 쓰는 말이 Restricted URL 이다
  it('adds RESTRICTED for v1 section 22', () => {
    expect(Object.hasOwn(statuses, 'RESTRICTED')).toBe(true)
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

describe('P6-D135 - DashboardFailure.errorCode is a thirteen member union', () => {
  //+_+// 값을 빠뜨리거나 더하면 컴파일이 깨진다. 13개를 타입에서 직접 끌어온다
  //+_+// P6-D127 이 좁혔고 P6-D135 가 13 을 12 로 정정했다. 근거는 docs/V1_DEVIATIONS.md 9
  //+_+// TASK-P12-04 (S2) 가 INVALID_CAPTURE_TIMEOUT 을 더해 12 를 13 으로 되돌렸다
  const codes: Record<DashboardErrorCode, true> = {
    TILE_NOT_FOUND: true,
    TAB_NOT_FOUND: true,
    PROJECT_NOT_FOUND: true,
    GRID_FULL: true,
    TILE_NOT_BOUND: true,
    INVALID_LAYOUT: true,
    INVALID_INTERVAL: true,
    INVALID_CAPTURE_TIMEOUT: true,
    NO_LAUNCH_URL: true,
    CAPTURE_FAILED: true,
    NOT_IMPLEMENTED: true,
    HANDLER_THREW: true,
    SEND_FAILED: true,
  }

  it('holds exactly thirteen codes', () => {
    expect(Object.keys(codes)).toHaveLength(13)
  })

  //+_+// AttachResult 에서 나서 TileStatus 로만 흐른다. DashboardFailure 에 담기는 경로가 없다
  it('does not admit the debugger layer code', () => {
    expect(Object.hasOwn(codes, 'DEBUGGER_ATTACH_FAILED')).toBe(false)
  })

  //+_+// 이 지시가 쓸모없어지면 tsc 가 "unused" 로 잡는다. 좁히기가 풀리면 시험이 깨진다
  it('rejects a code outside the union at compile time', () => {
    const rejected: DashboardFailure = {
      ok: false,
      type: 'BIND_TILE',
      // @ts-expect-error UNKNOWN_CODE 는 union 에 없다
      errorCode: 'UNKNOWN_CODE',
      message: 'test',
    }

    expect(rejected.ok).toBe(false)
  })

  //+_+// SEND_FAILED 만 화면 층이 만들고 나머지 11 은 워커가 만든다. docs/V1_DEVIATIONS.md 9.2
  it('keeps the one code the dashboard layer produces', () => {
    expect(Object.hasOwn(codes, 'SEND_FAILED')).toBe(true)
  })
})
