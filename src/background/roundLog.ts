import type { CaptureOutcome } from './previewCaptureManager'

//+_+// F4 계측 로그다. 갱신 주기를 콘솔에서 눈으로 읽기 위한 것이다
//+_+// Phase 5 에서 이 파일과 createDashboardHost 의 호출 1곳을 지우면 전부 사라진다
//+_+// 캡처 경로의 판단에 참여하지 않는다. 읽기만 하고 아무것도 돌려주지 않는다
export const ROUND_LOG_PREFIX = '[webdeck]'

export interface CaptureRoundLog {
  at: number
  tileId: string
  //+_+// 프로젝트에서 타일이 이미 사라진 회차가 있다. 모르는 값을 0 으로 적지 않는다
  w: number | null
  h: number | null
  intervalMs: number | null
  roundDurationMs: number
  outcome: CaptureOutcome
  bytes: number | null
}

//+_+// 회차 간격을 눈으로 재려면 밀리초가 있어야 한다. 로컬 시각이다
export function formatRoundClock(at: number): string {
  const time = new Date(at)
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  const hms = [time.getHours(), time.getMinutes(), time.getSeconds()]
    .map((part) => pad(part, 2))
    .join(':')
  return `${hms}.${pad(time.getMilliseconds(), 3)}`
}

function orDash(value: number | null): string {
  return value === null ? '-' : String(value)
}

export function formatCaptureRound(entry: CaptureRoundLog): string {
  const head = [
    ROUND_LOG_PREFIX,
    formatRoundClock(entry.at),
    entry.tileId.slice(0, 8),
    `${orDash(entry.w)}x${orDash(entry.h)}`,
    `every ${orDash(entry.intervalMs)}ms`,
    `took ${String(entry.roundDurationMs)}ms`,
    entry.outcome,
  ].join(' ')

  //+_+// 실패 회차에는 바이트가 없다. 0kB 라고 적으면 빈 이미지를 받은 것처럼 읽힌다
  if (entry.bytes === null) {
    return head
  }
  return `${head} ${(entry.bytes / 1024).toFixed(1)}kB`
}

//+_+// console 호출은 이 한 곳이다. CLAUDE.md section 8 의 console.log 남발 금지 조항이다
export function logCaptureRound(entry: CaptureRoundLog): void {
  console.log(formatCaptureRound(entry))
}
