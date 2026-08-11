import { DebuggerSessionManager } from '../../src/background/debuggerSessionManager'
import type { DebuggerBackend } from '../../src/background/debuggerSessionManager'
import { PreviewCaptureManager, systemClock } from '../../src/background/previewCaptureManager'
import { TabManager } from '../../src/background/tabManager'
import type { TabsBackend } from '../../src/background/tabManager'
import { captureStats } from '../../src/shared/scheduler'
import type { BrowserTabInfo } from '../../src/shared/types'
import type {
  HarnessRequest,
  HarnessResponse,
  HarnessSnapshot,
  IdleMode,
  TabSummary,
} from './protocol'
import { buildReport, fnv1a } from './report'
import type {
  AttachStageRow,
  CaptureRow,
  DetachEventRow,
  InjectionRow,
  LateArrivalRow,
  PortLogRow,
  ProbeResult,
  ReencodeResult,
} from './report'

//+_+// 버릴 코드다. 제품에 남기지 않는다
//+_+// 제품 serviceWorker.ts 를 import 하지 않는다. 그 파일은 최상위에서 스스로 시작하고
//+_+// chrome.tabs 리스너를 해제할 수단이 없다. IDLE-B 가 성립하지 않는다
//+_+// 로직은 전부 제품 모듈에서 온다. 여기서 만드는 것은 어댑터와 배선뿐이다

declare const __HARNESS_COMMIT__: string | null

const SW_KEY = 'harnessSwStarts'
const DEBUGGER_PROTOCOL_VERSION = '1.3'
const TICK_MS = 1000
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const measuredAt = new Date().toISOString()
const captures: CaptureRow[] = []
const lateArrivalRows: LateArrivalRow[] = []
const attachStages: AttachStageRow[] = []
const detachRows: DetachEventRow[] = []
const injections: InjectionRow[] = []
const portLog: PortLogRow[] = []
const observations: Record<string, string> = {}
const frames = new Map<string, { format: string; bytes: number; imageBase64: string }>()

let swStarts: string[] = []
let probeResult: ProbeResult | null = null
let reencodeResult: ReencodeResult | null = null
let idleTransition: string | null = null
let stopDriver: (() => void) | null = null
const registeredTiles = new Set<string>()

function nowIso(): string {
  return new Date().toISOString()
}

//+_+// 리스너를 해제할 수 있어야 한다. 제품 어댑터에는 그 수단이 없다
function harnessTabsBackend(): TabsBackend & { removeListeners: () => void } {
  const removed: ((tabId: number) => void)[] = []
  const updated: ((tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => void)[] = []

  return {
    get: async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId)
        if (tab.id === undefined) {
          return null
        }
        const info: BrowserTabInfo = {
          tabId: tab.id,
          windowId: tab.windowId,
          currentUrl: tab.url ?? '',
          title: tab.title ?? '',
        }
        return info
      } catch {
        return null
      }
    },
    onRemoved: (listener) => {
      const wrapped = (tabId: number): void => {
        listener(tabId)
      }
      removed.push(wrapped)
      chrome.tabs.onRemoved.addListener(wrapped)
    },
    onUpdated: (listener) => {
      const wrapped = (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo): void => {
        if (changeInfo.url !== undefined) {
          listener(tabId, changeInfo.url)
        }
      }
      updated.push(wrapped)
      chrome.tabs.onUpdated.addListener(wrapped)
    },
    removeListeners: () => {
      for (const listener of removed) {
        chrome.tabs.onRemoved.removeListener(listener)
      }
      for (const listener of updated) {
        chrome.tabs.onUpdated.removeListener(listener)
      }
      removed.length = 0
      updated.length = 0
    },
  }
}

const debuggerBackend: DebuggerBackend = {
  attach: (tabId) => chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION),
  detach: (tabId) => chrome.debugger.detach({ tabId }),
  sendCommand: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
  onDetach: (listener) => {
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== undefined) {
        listener(source.tabId, reason)
      }
    })
  },
}

const tabsBackend = harnessTabsBackend()
const sessions = new DebuggerSessionManager(debuggerBackend)
const tabs = new TabManager(tabsBackend)

let captureManager = makeCaptureManager(true)

function makeCaptureManager(pageEnable: boolean): PreviewCaptureManager {
  return new PreviewCaptureManager(debuggerBackend, sessions, systemClock, {
    pageEnable,
    onCaptureSettled: (record, frame) => {
      captures.push({
        tileId: record.tileId,
        tabId: record.tabId,
        attemptIndex: record.attemptIndex,
        startedAt: record.startedAt,
        calledAt: record.calledAt,
        roundDurationMs: record.roundDurationMs,
        callDurationMs: record.callDurationMs,
        outcome: record.outcome,
        bytes: record.bytes,
        frameHash: frame === null ? null : fnv1a(frame.imageBase64),
        pageEnableSent: record.pageEnableSent,
        message: record.message,
      })
      if (frame !== null) {
        frames.set(record.tileId, {
          format: frame.format,
          bytes: frame.bytes,
          imageBase64: frame.imageBase64,
        })
      }
    },
  })
}

sessions.addDetachListener((event) => {
  detachRows.push({
    at: nowIso(),
    tabId: event.tabId,
    reason: event.reason,
    errorCode: event.errorCode,
  })
})

tabs.onTabRemoved((tabId) => {
  void captureManager.releaseTab(tabId)
})

tabs.onTabNavigated((tabId) => {
  captureManager.noteNavigation(tabId)
})

//+_+// 유일한 storage 쓰기다. 워커 시작당 1회. Phase 1 은 초당 0.547회를 썼고 그것이 L1 용의자 1 이다
async function recordWorkerStart(): Promise<void> {
  const stored = await chrome.storage.session.get(SW_KEY)
  const previous = Array.isArray(stored[SW_KEY]) ? (stored[SW_KEY] as string[]) : []
  swStarts = [...previous, nowIso()]
  await chrome.storage.session.set({ [SW_KEY]: swStarts })
}

void recordWorkerStart()

function collectLateArrivals(): void {
  lateArrivalRows.length = 0
  for (const entry of captureManager.lateArrivals) {
    lateArrivalRows.push({
      tileId: entry.tileId,
      tabId: entry.tabId,
      attemptIndex: entry.attemptIndex,
      lateByMs: entry.lateByMs,
      roundDurationMs: entry.roundDurationMs,
      settledAs: entry.settledAs,
    })
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

//+_+// 두 프로브를 독립시킨다. L12 의 결함은 createImageBitmap 이 실패한 blob 에 의존한 것이었다
async function runProbes(): Promise<ProbeResult> {
  const result: ProbeResult = {
    offscreenCanvas: false,
    offscreenCanvasError: null,
    createImageBitmap: false,
    createImageBitmapError: null,
    createObjectURL: typeof URL.createObjectURL === 'function',
  }

  try {
    const canvas = new OffscreenCanvas(4, 4)
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('getContext 2d returned null')
    }
    context.fillStyle = '#123456'
    context.fillRect(0, 0, 4, 4)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
    result.offscreenCanvas = blob.size > 0
  } catch (error) {
    result.offscreenCanvasError = error instanceof Error ? error.message : String(error)
  }

  //+_+// OffscreenCanvas 결과를 쓰지 않는다. 자체 PNG 로 시험한다
  try {
    const blob = new Blob([base64ToBytes(ONE_PIXEL_PNG)], { type: 'image/png' })
    const bitmap = await createImageBitmap(blob)
    result.createImageBitmap = bitmap.width === 1 && bitmap.height === 1
    bitmap.close()
  } catch (error) {
    result.createImageBitmapError = error instanceof Error ? error.message : String(error)
  }

  return result
}

async function encodeAt(bitmap: ImageBitmap, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('getContext 2d returned null')
  }
  context.drawImage(bitmap, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return new Uint8Array(await blob.arrayBuffer())
}

//+_+// 같은 캡처 1회를 png 로 받아 두 품질로 재인코딩한다. 회차가 다르면 비교가 성립하지 않는다. L7
async function reencodeOneFrame(
  tabId: number,
): Promise<{ q70: string | null; q85: string | null }> {
  const attached = await sessions.ensureAttached(tabId)
  if (!attached.ok) {
    reencodeResult = {
      path: 'failed',
      sourceFormat: 'png',
      sourceBytes: 0,
      q70Bytes: null,
      q85Bytes: null,
      error: attached.message,
    }
    return { q70: null, q85: null }
  }

  const raw = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
    format: 'png',
  })
  const data = (raw as { data?: unknown } | undefined)?.data
  if (typeof data !== 'string') {
    reencodeResult = {
      path: 'failed',
      sourceFormat: 'png',
      sourceBytes: 0,
      q70Bytes: null,
      q85Bytes: null,
      error: 'no png payload',
    }
    return { q70: null, q85: null }
  }

  const sourceBytes = base64ToBytes(data)
  try {
    const bitmap = await createImageBitmap(new Blob([sourceBytes], { type: 'image/png' }))
    const q70 = await encodeAt(bitmap, 0.7)
    const q85 = await encodeAt(bitmap, 0.85)
    bitmap.close()
    reencodeResult = {
      path: 'worker',
      sourceFormat: 'png',
      sourceBytes: sourceBytes.length,
      q70Bytes: q70.length,
      q85Bytes: q85.length,
      error: null,
    }
    return { q70: bytesToBase64(q70), q85: bytesToBase64(q85) }
  } catch (error) {
    //+_+// 워커에서 실패하면 문서 canvas 로 내려간다. 어느 경로를 썼는지 리포트에 남는다
    reencodeResult = {
      path: 'document',
      sourceFormat: 'png',
      sourceBytes: sourceBytes.length,
      q70Bytes: null,
      q85Bytes: null,
      error: error instanceof Error ? error.message : String(error),
    }
    return { q70: data, q85: null }
  }
}

async function runAttachStage(stage: number, tabIds: number[]): Promise<void> {
  const row: AttachStageRow = { stage, requested: tabIds.length, ok: 0, fail: 0, errors: [] }
  for (const tabId of tabIds) {
    const result = await sessions.ensureAttached(tabId)
    if (result.ok) {
      row.ok += 1
    } else {
      row.fail += 1
      //+_+// L24 재발 방지. 사유 원문을 반드시 남긴다
      row.errors.push(`tab ${String(tabId)}: ${result.message}`)
    }
  }
  attachStages.push(row)
}

function noteInjection(name: string, outcome: string, detail: string): void {
  injections.push({ at: nowIso(), name, outcome, detail })
}

async function runInjection(name: string, tabId: number): Promise<void> {
  if (name === 'missingTab') {
    //+_+// 기대 코드를 미리 적지 않는다. 원문을 남기고 분류는 관측 후에 정한다
    const result = await sessions.ensureAttached(999999)
    noteInjection(name, result.ok ? 'attached' : 'attachFailed', result.ok ? '' : result.message)
    return
  }

  if (name === 'sendAfterDetach') {
    await sessions.ensureAttached(tabId)
    await sessions.release(tabId)
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'jpeg' })
      noteInjection(name, 'resolved', 'command succeeded after detach')
    } catch (error) {
      noteInjection(name, 'rejected', error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (name === 'forceTimeout') {
    const before = captureManager.inFlightCount
    captureManager.register('inject-timeout', tabId, 2000)
    registeredTiles.add('inject-timeout')
    captureManager.tick()
    noteInjection(name, 'started', `inFlight ${String(before)} -> ${String(captureManager.inFlightCount)}`)
    return
  }

  if (name === 'forceDetach') {
    await sessions.ensureAttached(tabId)
    try {
      await chrome.debugger.detach({ tabId })
      noteInjection(name, 'detached', 'see detachEvents for the raw reason')
    } catch (error) {
      noteInjection(name, 'failed', error instanceof Error ? error.message : String(error))
    }
    return
  }

  //+_+// DEVTOOLS 전이는 S2 의 주입구로만 만든다. reason 문자열을 추측해 코드에 넣지 않는다
  const observed = detachRows.map((row) => row.reason).find((reason) => reason.length > 0) ?? ''
  if (observed === '') {
    noteInjection(name, 'skipped', 'no detach reason observed yet. run forceDetach first')
    return
  }
  const probe = new DebuggerSessionManager(debuggerBackend, { devtoolsDetachReasons: [observed] })
  noteInjection(
    name,
    'ready',
    `a manager built with devtoolsDetachReasons=["${observed}"] classifies it as DEVTOOLS_CONFLICT (${String(probe.detachEvents.length)} events so far)`,
  )
}

//+_+// 되돌아오지 않는 일방 전이다. 세 조건이 누적된다
//+_+// IDLE-A 캡처만 정지. tick 과 tabs 리스너 유지
//+_+// IDLE-B 여기에 tabs 리스너 해제를 더한다
//+_+// IDLE-C 여기에 clearInterval 을 더한다. 완전 유휴
async function applyIdle(mode: IdleMode): Promise<void> {
  await stopCapture()

  if (mode === 'IDLE-B' || mode === 'IDLE-C') {
    tabsBackend.removeListeners()
  }
  if (mode === 'IDLE-C' && stopDriver !== null) {
    stopDriver()
    stopDriver = null
  }
  idleTransition = `${mode} at ${nowIso()}`
}

//+_+// 타일을 전부 내린다. 구동자는 건드리지 않는다. tick 은 빈 목록을 훑는다
async function stopCapture(): Promise<void> {
  for (const tileId of [...registeredTiles]) {
    await captureManager.unregister(tileId)
  }
  registeredTiles.clear()
}

function startDriver(): void {
  if (stopDriver !== null) {
    return
  }
  const handle: ReturnType<typeof setInterval> = setInterval(() => {
    captureManager.tick()
    collectLateArrivals()
  }, TICK_MS)
  stopDriver = () => {
    clearInterval(handle)
  }
}

function snapshot(): HarnessSnapshot {
  collectLateArrivals()
  return {
    captureCount: captures.length,
    lateArrivalCount: lateArrivalRows.length,
    attachedCount: attachStages.reduce((sum, row) => sum + row.ok, 0),
    inFlight: captureManager.inFlightCount,
    queued: captureManager.queueLength,
    swStarts,
    idleTransition,
    lastFrames: [...frames.entries()].map(([tileId, frame]) => ({ tileId, ...frame })),
    detachReasons: detachRows.map((row) => row.reason),
  }
}

async function handle(request: HarnessRequest): Promise<HarnessResponse> {
  if (request.type === 'LIST_TABS') {
    const all = await chrome.tabs.query({})
    const summaries: TabSummary[] = all
      .filter((tab) => tab.id !== undefined && (tab.url ?? '').startsWith('http'))
      .map((tab) => ({
        tabId: tab.id ?? -1,
        title: tab.title ?? '',
        url: tab.url ?? '',
      }))
    return { ok: true, type: 'LIST_TABS', tabs: summaries }
  }

  if (request.type === 'START_CAPTURE') {
    await stopCapture()
    captureManager = makeCaptureManager(request.pageEnable)
    request.tabIds.forEach((tabId, index) => {
      const tileId = `t${String(index + 1)}`
      captureManager.register(tileId, tabId, request.intervalMs)
      registeredTiles.add(tileId)
    })
    startDriver()
    return { ok: true, type: 'ACK' }
  }

  if (request.type === 'STOP_CAPTURE') {
    await stopCapture()
    return { ok: true, type: 'ACK' }
  }

  if (request.type === 'ATTACH_STAGE') {
    await runAttachStage(request.stage, request.tabIds)
    return { ok: true, type: 'ACK' }
  }

  if (request.type === 'INJECT') {
    await runInjection(request.name, request.tabId)
    return { ok: true, type: 'ACK' }
  }

  if (request.type === 'REENCODE') {
    const encoded = await reencodeOneFrame(request.tabId)
    return { ok: true, type: 'REENCODE', q70: encoded.q70, q85: encoded.q85 }
  }

  if (request.type === 'PROBE') {
    probeResult = await runProbes()
    return { ok: true, type: 'ACK' }
  }

  if (request.type === 'IDLE') {
    await applyIdle(request.mode)
    return { ok: true, type: 'ACK' }
  }

  if (request.type === 'SET_OBSERVATION') {
    observations[request.key] = request.value
    return { ok: true, type: 'ACK' }
  }

  if (request.type === 'SNAPSHOT') {
    return { ok: true, type: 'SNAPSHOT', snapshot: snapshot() }
  }

  collectLateArrivals()
  const report = buildReport(
    {
      chromeFullVersion: request.chromeFullVersion,
      round: request.round,
      measuredAt,
      reportSavedAt: nowIso(),
      harnessCommit: __HARNESS_COMMIT__,
      captures,
      lateArrivals: lateArrivalRows,
      attach: attachStages,
      detachEvents: detachRows,
      injections,
      reencode: reencodeResult,
      swStarts,
      portLog,
      environment: probeResult,
      userObservations: observations,
      idleTransition,
    },
    captureStats,
  )
  return { ok: true, type: 'BUILD_REPORT', report }
}

//+_+// 툴바 아이콘으로 하네스 페이지를 연다. 주소를 손으로 치지 않게 한다
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('harness.html') })
})

chrome.runtime.onConnect.addListener((port) => {
  portLog.push({ at: nowIso(), event: 'connect' })
  port.onDisconnect.addListener(() => {
    portLog.push({ at: nowIso(), event: 'disconnect' })
  })
})

chrome.runtime.onMessage.addListener((message: HarnessRequest, _sender, sendResponse) => {
  handle(message).then(sendResponse, (error: unknown) => {
    sendResponse({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    } satisfies HarnessResponse)
  })
  return true
})
