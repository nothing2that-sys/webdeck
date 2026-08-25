import type {
  DiagnosticsSnapshot,
  DurationSpread,
  PortEventRow,
  RecordLogSize,
} from '../shared/messages'
import { RECORD_LOG_LIMIT } from '../shared/recordLimit'
import type { KeyValueBackend } from '../shared/storage'
import { errorMessage } from './debuggerSessionManager'
import { formatCaptureRound } from './roundLog'
import type { CaptureRoundLog } from './roundLog'

//+_+// P6-D16. PersistedState 와 다른 키다. schemaVersion 과 deserializeState 경로를 지나지 않는다
export const WORKER_STARTS_KEY = 'webdeck.diagnostics.workerStarts'

//+_+// P6-D18. 상한이 있는 링버퍼다. 상한 없는 배열을 새로 만들지 않는다. H2
export const ROUND_LOG_KEY = 'webdeck.diagnostics.rounds'

//+_+// 누적 횟수는 절단되지 않는다. 최근 목록이 잘려도 총계는 남는다
export const WORKER_START_LIMIT = 50

//+_+// P6-D20. P6-D7 이 기존 기록 배열의 상한을 정하면 이 값과 같은 체계로 맞춘다
export const ROUND_LOG_LIMIT = 2000

//+_+// P6-D56. 재연결 판정을 사후에 읽기 위한 키다. 콘솔은 워커가 죽으면 함께 사라진다
//+_+// P6-D22 가 워커 타깃 부착을 금지하므로 하네스도 그 콘솔을 읽지 못한다
export const RECONNECT_LOG_KEY = 'webdeck.diagnostics.reconnect'

//+_+// 워커 기동당 타일 수만큼이다. 회차 로그와 달리 주기적으로 늘지 않는다
export const RECONNECT_LOG_LIMIT = 200

//+_+// TASK-P8-05 §1.5. 포트 수명 신호를 사후에 읽는 키다. P6-D16 과 같은 방식이다
//+_+// 콘솔에 남기지 않는다. TASK-P8-04 가 콘솔을 못 읽어 막혔고 P6-D22 가 워커 부착을 금지한다
export const PORT_EVENT_KEY = 'webdeck.diagnostics.portEvents'

//+_+// 재연결 판정과 같은 상한이다. 탭 하나가 열고 닫을 때 두 줄이므로 주기적으로 늘지 않는다
export const PORT_EVENT_LIMIT = 200


//+_+// 누적 둘은 절단되지 않는다. 최근 목록이 잘려도 총계는 남는다. workerStarts 와 같은 규칙이다
export interface PortEventRecord {
  connects: number
  disconnects: number
  recent: PortEventRow[]
}

export interface WorkerStartRecord {
  starts: number
  recentAt: number[]
}

//+_+// at 은 epoch ms 다. line 의 시각은 로컬 hh:mm:ss.mmm 뿐이라 기동 시각과 대조할 수 없다
export interface RoundLogRow {
  at: number
  line: string
}

//+_+// P6-D56. 판정 1건이다. at 이 epoch ms 이므로 workerStarts.recentAt 과 그대로 대조된다
//+_+// kind 는 판정이고 active 는 그 타일이 활성 프로젝트에 있었는지다. 둘은 다른 축이다
//+_+// candidates 는 후보 탭 수다. none 은 0, bind 는 1, ambiguous 는 2 이상이다
export interface ReconnectLogRow {
  at: number
  tileId: string
  projectId: string
  kind: 'bind' | 'none' | 'ambiguous'
  candidates: number
  active: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

//+_+// 계측이 자기가 쓴 값을 읽어도 형태를 다시 검증한다. 손상된 값에 이어 쓰지 않는다
export function readWorkerStarts(stored: unknown): WorkerStartRecord {
  if (!isRecord(stored) || typeof stored.starts !== 'number' || !Array.isArray(stored.recentAt)) {
    return { starts: 0, recentAt: [] }
  }
  return {
    starts: stored.starts,
    recentAt: stored.recentAt.filter((at): at is number => typeof at === 'number'),
  }
}

export function nextWorkerStarts(
  stored: unknown,
  at: number,
  limit = WORKER_START_LIMIT,
): WorkerStartRecord {
  const previous = readWorkerStarts(stored)
  return { starts: previous.starts + 1, recentAt: [...previous.recentAt, at].slice(-limit) }
}

//+_+// 계측이 자기가 쓴 값을 읽어도 형태를 다시 검증한다. readWorkerStarts 와 같은 규칙이다
function isPortEventRow(value: unknown): value is PortEventRow {
  return (
    isRecord(value) &&
    typeof value.at === 'number' &&
    typeof value.clientId === 'string' &&
    (value.event === 'connect' || value.event === 'disconnect')
  )
}

export function readPortEvents(stored: unknown): PortEventRecord {
  if (
    !isRecord(stored) ||
    typeof stored.connects !== 'number' ||
    typeof stored.disconnects !== 'number' ||
    !Array.isArray(stored.recent)
  ) {
    return { connects: 0, disconnects: 0, recent: [] }
  }
  return {
    connects: stored.connects,
    disconnects: stored.disconnects,
    recent: stored.recent.filter(isPortEventRow),
  }
}

export function nextPortEvents(
  stored: unknown,
  row: PortEventRow,
  limit = PORT_EVENT_LIMIT,
): PortEventRecord {
  const previous = readPortEvents(stored)
  return {
    connects: previous.connects + (row.event === 'connect' ? 1 : 0),
    disconnects: previous.disconnects + (row.event === 'disconnect' ? 1 : 0),
    recent: [...previous.recent, row].slice(-limit),
  }
}

//+_+// 실패해도 아무것도 막지 않는다. 삼키되 콘솔에 1줄 남긴다. recordWorkerStart 와 같은 규칙이다
//+_+// 읽고 쓰는 사이의 경합은 부르는 쪽이 직렬화한다. 이 함수는 그것을 하지 않는다
export async function recordPortEvent(
  backend: KeyValueBackend,
  row: PortEventRow,
): Promise<void> {
  try {
    const stored = await backend.get(PORT_EVENT_KEY)
    await backend.set(PORT_EVENT_KEY, nextPortEvents(stored, row))
  } catch (error: unknown) {
    console.error('[webdeck] port event record failed', errorMessage(error))
  }
}

export function readRoundRows(stored: unknown): RoundLogRow[] {
  if (!Array.isArray(stored)) {
    return []
  }
  return stored.filter(
    (row): row is RoundLogRow =>
      isRecord(row) && typeof row.at === 'number' && typeof row.line === 'string',
  )
}

//+_+// 오래된 것을 버린다. 상한을 넘는 순간 앞에서 잘린다
export function appendRoundRow(
  stored: unknown,
  row: RoundLogRow,
  limit = ROUND_LOG_LIMIT,
): RoundLogRow[] {
  return [...readRoundRows(stored), row].slice(-limit)
}

//+_+// S1. 기동 직후 1회다. 실패해도 기동을 막지 않는다. 삼키되 콘솔에 1줄 남긴다
export async function recordWorkerStart(backend: KeyValueBackend, at: number): Promise<void> {
  try {
    const stored = await backend.get(WORKER_STARTS_KEY)
    await backend.set(WORKER_STARTS_KEY, nextWorkerStarts(stored, at))
  } catch (error: unknown) {
    console.error('[webdeck] worker start record failed', errorMessage(error))
  }
}

const RECONNECT_KINDS: readonly ReconnectLogRow['kind'][] = ['bind', 'none', 'ambiguous']

export function readReconnectRows(stored: unknown): ReconnectLogRow[] {
  if (!Array.isArray(stored)) {
    return []
  }
  return stored.filter(
    (row): row is ReconnectLogRow =>
      isRecord(row) &&
      typeof row.at === 'number' &&
      typeof row.tileId === 'string' &&
      typeof row.projectId === 'string' &&
      typeof row.candidates === 'number' &&
      typeof row.active === 'boolean' &&
      RECONNECT_KINDS.includes(row.kind as ReconnectLogRow['kind']),
  )
}

//+_+// 오래된 것을 버린다. 회차 로그와 같은 체계다
export function appendReconnectRows(
  stored: unknown,
  rows: readonly ReconnectLogRow[],
  limit = RECONNECT_LOG_LIMIT,
): ReconnectLogRow[] {
  return [...readReconnectRows(stored), ...rows].slice(-limit)
}

//+_+// P6-D56. 워커 기동당 1회다. 한 기동의 판정 전부를 한 번에 이어 붙인다
//+_+// 실패해도 재연결을 막지 않는다. 삼키되 콘솔에 1줄 남긴다. recordWorkerStart 와 같은 규칙이다
export async function recordReconnectVerdicts(
  backend: KeyValueBackend,
  rows: readonly ReconnectLogRow[],
): Promise<void> {
  if (rows.length === 0) {
    return
  }
  try {
    const stored = await backend.get(RECONNECT_LOG_KEY)
    await backend.set(RECONNECT_LOG_KEY, appendReconnectRows(stored, rows))
  } catch (error: unknown) {
    console.error('[webdeck] reconnect record failed', errorMessage(error))
  }
}

export interface RoundLogStore {
  append(entry: CaptureRoundLog): Promise<void>
}

//+_+// S3. 회차 2개가 동시에 정산될 수 있다. 읽고 쓰는 사이에 서로를 덮으면 행이 조용히 사라진다
//+_+// 그래서 쓰기를 직렬화하고 저장값은 첫 회차에서만 읽는다. 그 뒤로는 메모리 버퍼가 정본이다
//+_+// 워커가 죽으면 버퍼가 사라지고 다음 기동의 첫 회차가 저장값을 다시 읽어 이어 붙인다
export function createRoundLogStore(
  backend: KeyValueBackend,
  limit = ROUND_LOG_LIMIT,
): RoundLogStore {
  let rows: RoundLogRow[] | null = null
  let chain: Promise<void> = Promise.resolve()

  return {
    append(entry: CaptureRoundLog): Promise<void> {
      chain = chain
        .then(async () => {
          const stored = rows ?? (await backend.get(ROUND_LOG_KEY))
          const next = appendRoundRow(
            stored,
            { at: entry.at, line: formatCaptureRound(entry) },
            limit,
          )
          rows = next
          await backend.set(ROUND_LOG_KEY, next)
        })
        .catch(() => {
          //+_+// 쓰기 실패가 캡처를 막지 않는다. 버퍼를 버려 다음 회차가 저장값을 다시 읽게 한다
          rows = null
        })
      return chain
    },
  }
}

//+_+// P6-D10 · D113. 순수 함수다. 평균을 내지 않는다. 최소 · 중간 · 최대뿐이다
//+_+// 중간은 nearest-rank 다. src/shared/scheduler.ts 의 percentile 과 같은 규칙이고 보간하지 않는다
export function durationSpread(values: readonly number[]): DurationSpread {
  if (values.length === 0) {
    return { count: 0, min: null, mid: null, max: null }
  }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    min: sorted[0],
    mid: sorted[Math.ceil(sorted.length / 2) - 1],
    max: sorted[sorted.length - 1],
  }
}

//+_+// P6-D9 · D113. Diagnostics 응답을 만드는 유일한 자리다. 순수하다. chrome 도 storage 도 만지지 않는다
//+_+// 회차 소요와 타임아웃 수는 captureRecords 에서 나오고 그 배열은 상한 200 이다 (P6-D7)
//+_+// 그래서 sampleLimit 를 함께 싣는다. 전체 누적으로 읽히면 안 된다 (P6-D112)
export function buildDiagnostics(input: {
  captureRecords: readonly { roundDurationMs: number; outcome: string }[]
  registeredTiles: number
  attachedTabs: number
  workerStarts: number | null
  recordLogs: readonly RecordLogSize[]
}): DiagnosticsSnapshot {
  return {
    sampleLimit: RECORD_LOG_LIMIT,
    roundDurationMs: durationSpread(input.captureRecords.map((record) => record.roundDurationMs)),
    timeouts: input.captureRecords.filter((record) => record.outcome === 'timeout').length,
    registeredTiles: input.registeredTiles,
    attachedTabs: input.attachedTabs,
    workerStarts: input.workerStarts,
    recordLogs: [...input.recordLogs],
  }
}
