import { describe, expect, it } from 'vitest'
import { RECORD_LOG_LIMIT, pushBounded } from '../src/shared/recordLimit'

//+_+// P6-D7 · D112. L26 이 연 항목이다. 다섯 배열이 이 규칙 하나를 쓴다
describe('P6-D112 - the record log limit', () => {
  it('is 200, the same place as the reconnect log', () => {
    expect(RECORD_LOG_LIMIT).toBe(200)
  })
})

describe('P6-D7 - pushBounded keeps the recent entries', () => {
  it('appends while the log is under the limit', () => {
    const log: number[] = []
    pushBounded(log, 1, 3)
    pushBounded(log, 2, 3)
    expect(log).toEqual([1, 2])
  })

  //+_+// B-e2. 넘칠 때 앞을 버린다
  it('drops the oldest entry once the limit is passed', () => {
    const log: number[] = []
    for (const value of [1, 2, 3, 4, 5]) {
      pushBounded(log, value, 3)
    }
    expect(log).toEqual([3, 4, 5])
  })

  //+_+// B-e1. 상한을 넘지 않는다
  it('never grows past the limit', () => {
    const log: number[] = []
    for (let index = 0; index < 1000; index += 1) {
      pushBounded(log, index, RECORD_LOG_LIMIT)
    }
    expect(log).toHaveLength(RECORD_LOG_LIMIT)
    expect(log[0]).toBe(1000 - RECORD_LOG_LIMIT)
    expect(log[log.length - 1]).toBe(999)
  })

  //+_+// getter 가 돌려준 참조가 갈리면 안 된다. 제자리에서 자른다
  it('trims in place so the array identity survives', () => {
    const log: number[] = []
    const same = log
    for (let index = 0; index < 5; index += 1) {
      pushBounded(log, index, 2)
    }
    expect(same).toBe(log)
    expect(same).toEqual([3, 4])
  })

  it('defaults to the shared limit', () => {
    const log: number[] = []
    for (let index = 0; index < RECORD_LOG_LIMIT + 10; index += 1) {
      pushBounded(log, index)
    }
    expect(log).toHaveLength(RECORD_LOG_LIMIT)
  })
})
