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

export interface WorkerStartRecord {
  starts: number
  recentAt: number[]
}

//+_+// at 은 epoch ms 다. line 의 시각은 로컬 hh:mm:ss.mmm 뿐이라 기동 시각과 대조할 수 없다
export interface RoundLogRow {
  at: number
  line: string
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
