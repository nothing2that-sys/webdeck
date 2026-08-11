import { describe, expect, it } from 'vitest'
import {
  DEVTOOLS_DETACH_REASONS,
  DebuggerSessionManager,
  MAX_ATTACH_ATTEMPTS,
  classifyDetachReason,
  errorMessage,
  tileStatusForDebuggerError,
} from '../src/background/debuggerSessionManager'
import type { DebuggerBackend } from '../src/background/debuggerSessionManager'

//+_+// chrome.debugger 를 부르지 않는다. 호출을 세고 실패를 주입하는 대역이다
class FakeDebugger implements DebuggerBackend {
  readonly attachCalls: number[] = []
  readonly detachCalls: number[] = []
  readonly attachRejections: unknown[] = []
  detachRejection: unknown = null
  private listener: ((tabId: number, reason: string) => void) | null = null

  attach(tabId: number): Promise<void> {
    this.attachCalls.push(tabId)
    if (this.attachRejections.length > 0) {
      return Promise.reject(this.attachRejections.shift())
    }
    return Promise.resolve()
  }

  detach(tabId: number): Promise<void> {
    this.detachCalls.push(tabId)
    if (this.detachRejection !== null) {
      return Promise.reject(this.detachRejection)
    }
    return Promise.resolve()
  }

  sendCommand(): Promise<unknown> {
    return Promise.resolve({})
  }

  onDetach(listener: (tabId: number, reason: string) => void): void {
    this.listener = listener
  }

  fireDetach(tabId: number, reason: string): void {
    this.listener?.(tabId, reason)
  }
}

function makeManager(fake: FakeDebugger, devtoolsReasons?: readonly string[]) {
  return new DebuggerSessionManager(
    fake,
    devtoolsReasons === undefined ? {} : { devtoolsDetachReasons: devtoolsReasons },
  )
}

describe('TASK-P3-01 item 04 - ensureAttached reuses the session', () => {
  it('attaches once and reports the second call as a reuse', async () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake)

    expect(await manager.ensureAttached(42)).toEqual({ ok: true, reused: false })
    expect(await manager.ensureAttached(42)).toEqual({ ok: true, reused: true })

    expect(fake.attachCalls).toEqual([42])
    expect(manager.refCount(42)).toBe(2)
  })

  it('attaches each distinct tab separately', async () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake)

    await manager.ensureAttached(1)
    await manager.ensureAttached(2)

    expect(fake.attachCalls).toEqual([1, 2])
    expect(manager.refCount(1)).toBe(1)
    expect(manager.refCount(2)).toBe(1)
  })

  it('attaches again after the last lease has been released', async () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake)

    await manager.ensureAttached(42)
    await manager.release(42)
    await manager.ensureAttached(42)

    expect(fake.attachCalls).toEqual([42, 42])
  })
})

describe('TASK-P3-01 item 05 - detach only at reference count zero', () => {
  it('does not detach while a second lease is still held', async () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake)

    await manager.ensureAttached(42)
    await manager.ensureAttached(42)
    await manager.release(42)

    expect(fake.detachCalls).toEqual([])
    expect(manager.refCount(42)).toBe(1)
    expect(manager.isAttached(42)).toBe(true)
  })

  it('detaches once when the last lease is released', async () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake)

    await manager.ensureAttached(42)
    await manager.ensureAttached(42)
    await manager.release(42)
    await manager.release(42)

    expect(fake.detachCalls).toEqual([42])
    expect(manager.refCount(42)).toBe(0)
    expect(manager.isAttached(42)).toBe(false)
  })

  it('does not detach a tab it never attached', async () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake)

    await manager.release(99)

    expect(fake.detachCalls).toEqual([])
    expect(manager.refCount(99)).toBe(0)
  })

  it('does not go negative when released more often than attached', async () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake)

    await manager.ensureAttached(42)
    await manager.release(42)
    await manager.release(42)

    expect(fake.detachCalls).toEqual([42])
    expect(manager.refCount(42)).toBe(0)
  })
})

describe('TASK-P3-01 item 06 - attach failure keeps the reason string', () => {
  //+_+// 회차당 한 번만 시도한다. 세 번의 기록은 세 회차에서 나온다. D6
  it('records one verbatim message per failed attempt', async () => {
    const fake = new FakeDebugger()
    const failure = new Error('Cannot access a chrome:// URL')
    fake.attachRejections.push(failure, failure, failure)
    const manager = makeManager(fake)

    await manager.ensureAttached(42)
    await manager.ensureAttached(42)
    await manager.ensureAttached(42)

    expect(fake.attachCalls).toEqual([42, 42, 42])
    expect(manager.attachFailures).toHaveLength(3)
    expect(manager.attachFailures.map((entry) => entry.attempt)).toEqual([1, 2, 3])
    for (const entry of manager.attachFailures) {
      expect(entry.tabId).toBe(42)
      expect(entry.message).toBe('Cannot access a chrome:// URL')
    }
  })

  //+_+// L24 는 실패 15건이 전부 사유 없이 사라진 사건이다. 빈 문자열로 만들지 않는다
  it('never leaves the recorded message empty', async () => {
    const fake = new FakeDebugger()
    fake.attachRejections.push('rejected with a bare string', { code: 7 }, new Error('boom'))
    const manager = makeManager(fake)

    await manager.ensureAttached(42)
    await manager.ensureAttached(42)
    const result = await manager.ensureAttached(42)

    expect(manager.attachFailures.map((entry) => entry.message)).toEqual([
      'rejected with a bare string',
      '[object Object]',
      'boom',
    ])
    for (const entry of manager.attachFailures) {
      expect(entry.message.length).toBeGreaterThan(0)
    }
    expect(result).toMatchObject({ ok: false, message: 'boom' })
  })

  it('stringifies a non Error rejection instead of dropping it', () => {
    expect(errorMessage(new Error('failed'))).toBe('failed')
    expect(errorMessage('failed')).toBe('failed')
    expect(errorMessage(undefined)).toBe('undefined')
  })

  it('records nothing when the attach succeeds', async () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake)

    await manager.ensureAttached(42)

    expect(manager.attachFailures).toEqual([])
  })
})

describe('TASK-P3-01 item 07 - attach failure classification', () => {
  //+_+// 중복 attach 계열은 DEBUGGER_ATTACH_FAILED 다. 문자열로 하위 분류하지 않는다
  it('classifies a duplicate attach failure as DEBUGGER_ATTACH_FAILED', async () => {
    const fake = new FakeDebugger()
    const duplicate = new Error('Another debugger is already attached to the tab with id: 42')
    fake.attachRejections.push(duplicate, duplicate, duplicate)
    const manager = makeManager(fake)

    const result = await manager.ensureAttached(42)

    expect(result).toEqual({
      ok: false,
      errorCode: 'DEBUGGER_ATTACH_FAILED',
      message: 'Another debugger is already attached to the tab with id: 42',
      attempts: 1,
      exhausted: false,
    })
  })

  it('leaves the tab unattached after a failed attach', async () => {
    const fake = new FakeDebugger()
    fake.attachRejections.push(new Error('a'), new Error('b'), new Error('c'))
    const manager = makeManager(fake)

    await manager.ensureAttached(42)

    expect(manager.isAttached(42)).toBe(false)
    expect(fake.detachCalls).toEqual([])
  })

  //+_+// onDetach 의 reason 은 아직 관측되지 않았다. 목록이 비어 있으면 전부 DEBUGGER_DETACHED 다
  it('classifies an unobserved detach reason as DEBUGGER_DETACHED', () => {
    expect(DEVTOOLS_DETACH_REASONS).toEqual([])
    expect(classifyDetachReason('canceled_by_user', DEVTOOLS_DETACH_REASONS)).toBe(
      'DEBUGGER_DETACHED',
    )
    expect(classifyDetachReason('target_closed', DEVTOOLS_DETACH_REASONS)).toBe('DEBUGGER_DETACHED')
    expect(classifyDetachReason('', DEVTOOLS_DETACH_REASONS)).toBe('DEBUGGER_DETACHED')
  })

  it('classifies a reason as DEVTOOLS_CONFLICT only when it is on the observed list', () => {
    expect(classifyDetachReason('observed_devtools_reason', ['observed_devtools_reason'])).toBe(
      'DEVTOOLS_CONFLICT',
    )
    expect(classifyDetachReason('something_else', ['observed_devtools_reason'])).toBe(
      'DEBUGGER_DETACHED',
    )
  })

  it('keeps the raw detach reason and drops the lease', () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake)

    fake.fireDetach(42, 'target_closed')

    expect(manager.detachEvents).toEqual([
      { tabId: 42, reason: 'target_closed', errorCode: 'DEBUGGER_DETACHED' },
    ])
    expect(manager.isAttached(42)).toBe(false)
  })

  it('routes a listed reason to the DEVTOOLS tile status', () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake, ['observed_devtools_reason'])

    fake.fireDetach(42, 'observed_devtools_reason')

    expect(manager.detachEvents[0]?.errorCode).toBe('DEVTOOLS_CONFLICT')
    expect(tileStatusForDebuggerError('DEVTOOLS_CONFLICT')).toBe('DEVTOOLS')
  })
})

describe('TASK-P3-01 item 08 - detach failure is swallowed but recorded', () => {
  it('does not throw when the backend rejects the detach', async () => {
    const fake = new FakeDebugger()
    fake.detachRejection = new Error('No debugger attached to the tab with id: 42')
    const manager = makeManager(fake)

    await manager.ensureAttached(42)

    await expect(manager.release(42)).resolves.toBeUndefined()
  })

  it('records the failed detach and releases the lease anyway', async () => {
    const fake = new FakeDebugger()
    fake.detachRejection = new Error('No debugger attached to the tab with id: 42')
    const manager = makeManager(fake)

    await manager.ensureAttached(42)
    await manager.release(42)

    expect(manager.detachFailures).toEqual([
      { tabId: 42, message: 'No debugger attached to the tab with id: 42' },
    ])
    expect(manager.isAttached(42)).toBe(false)
  })

  it('records nothing when the detach succeeds', async () => {
    const fake = new FakeDebugger()
    const manager = makeManager(fake)

    await manager.ensureAttached(42)
    await manager.release(42)

    expect(manager.detachFailures).toEqual([])
  })
})

describe('TASK-P3-01 item 09 - three exhausted attempts go to ERROR', () => {
  //+_+// 한 회차에 한 번만 시도한다. 누적이 3 에 닿는 회차에서 exhausted 가 선다. D6
  it('reports exhausted only on the third accumulated attempt', async () => {
    const fake = new FakeDebugger()
    fake.attachRejections.push(new Error('a'), new Error('b'), new Error('c'))
    const manager = makeManager(fake)

    expect(await manager.ensureAttached(42)).toMatchObject({ attempts: 1, exhausted: false })
    expect(await manager.ensureAttached(42)).toMatchObject({ attempts: 2, exhausted: false })
    expect(await manager.ensureAttached(42)).toMatchObject({ attempts: 3, exhausted: true })

    expect(MAX_ATTACH_ATTEMPTS).toBe(3)
    expect(fake.attachCalls).toEqual([42, 42, 42])
  })

  //+_+// 재시도 간격은 호출자의 캡처 backoff 가 만든다. 여기서 재우면 슬롯이 5000 을 넘겨 잡힌다
  it('calls attach exactly once per round and never sleeps', async () => {
    const fake = new FakeDebugger()
    fake.attachRejections.push(new Error('a'))
    const manager = makeManager(fake)

    const before = Date.now()
    await manager.ensureAttached(42)

    expect(fake.attachCalls).toEqual([42])
    expect(Date.now() - before).toBeLessThan(1000)
  })

  it('resets the accumulated count once an attach succeeds', async () => {
    const fake = new FakeDebugger()
    fake.attachRejections.push(new Error('a'), new Error('b'))
    const manager = makeManager(fake)

    await manager.ensureAttached(42)
    await manager.ensureAttached(42)
    expect(await manager.ensureAttached(42)).toEqual({ ok: true, reused: false })
    await manager.release(42)

    fake.attachRejections.push(new Error('again'))
    expect(await manager.ensureAttached(42)).toMatchObject({ attempts: 1, exhausted: false })
    expect(manager.attachFailures).toHaveLength(3)
  })

  it('maps the exhausted attach to the ERROR tile status', () => {
    expect(tileStatusForDebuggerError('DEBUGGER_ATTACH_FAILED')).toBe('ERROR')
    expect(tileStatusForDebuggerError('RESTRICTED_URL')).toBe('ERROR')
  })

  //+_+// TASK-P3-01 section 3.4 의 전이표를 그대로 고정한다
  it('maps a detach and a lost tab to DETACHED, never to ERROR', () => {
    expect(tileStatusForDebuggerError('DEBUGGER_DETACHED')).toBe('DETACHED')
    expect(tileStatusForDebuggerError('TAB_NOT_FOUND')).toBe('DETACHED')
    expect(tileStatusForDebuggerError('TAB_CLOSED')).toBe('DETACHED')
  })
})
