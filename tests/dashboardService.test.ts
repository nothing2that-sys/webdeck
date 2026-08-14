import { describe, expect, it } from 'vitest'
import {
  POLL_INTERVAL_MS,
  createVisibilityGate,
  isStaleTabFailure,
} from '../src/dashboard/dashboardService'
import type { DashboardResponse } from '../src/shared/messages'

//+_+// chrome 을 부르는 것은 send 안이며 이 파일은 그것을 import 하지 않는다
//+_+// 순수 판정만 시험한다. sendMessage 자체는 Chrome 실측 항목이다
describe('P5-D30 - a stale tab list is refreshed rather than reported', () => {
  function failure(errorCode: string): DashboardResponse {
    return { ok: false, type: 'BIND_TILE', errorCode, message: 'test' }
  }

  it('treats TAB_NOT_FOUND as a stale list', () => {
    expect(isStaleTabFailure(failure('TAB_NOT_FOUND'))).toBe(true)
  })

  it('leaves the other failures to the notice line', () => {
    for (const code of ['GRID_FULL', 'TILE_NOT_FOUND', 'INVALID_LAYOUT', 'SEND_FAILED']) {
      expect(isStaleTabFailure(failure(code))).toBe(false)
    }
  })

  it('says nothing about a successful response', () => {
    expect(isStaleTabFailure({ ok: true, type: 'BIND_TILE' })).toBe(false)
    expect(isStaleTabFailure({ ok: true, type: 'ADD_TILE', tileId: 't1' })).toBe(false)
  })

  //+_+// P4-D7 이 정한 값이다. 워커의 캡처 주기와 별개이며 서로를 참조하지 않는다
  it('keeps the poll interval the dashboard was built around', () => {
    expect(POLL_INTERVAL_MS).toBe(2000)
  })
})

//+_+// P5-D9. visibilitychange 는 같은 상태로도 발화할 수 있다. 바뀐 회차만 폴링을 부른다
describe('P5-D9 - the visibility gate only passes a change', () => {
  it('passes the first change away from the initial state', () => {
    const gate = createVisibilityGate(true)
    expect(gate.changed(false)).toBe(true)
  })

  it('blocks a notification that repeats the current state', () => {
    const gate = createVisibilityGate(true)
    expect(gate.changed(true)).toBe(false)
  })

  it('blocks the second of two identical notifications', () => {
    const gate = createVisibilityGate(true)
    expect(gate.changed(false)).toBe(true)
    expect(gate.changed(false)).toBe(false)
  })

  it('passes a flip back to the earlier state', () => {
    const gate = createVisibilityGate(true)
    gate.changed(false)
    expect(gate.changed(true)).toBe(true)
  })

  it('follows the initial value it was given', () => {
    expect(createVisibilityGate(false).changed(false)).toBe(false)
    expect(createVisibilityGate(false).changed(true)).toBe(true)
  })
})
