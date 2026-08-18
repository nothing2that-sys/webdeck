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
  //+_+// N2. roundDurationMs 와 나란히 찍는다. 두 값이 갈리면 attach 가 회차 안에 든 것이다
  //+_+// attach 에서 끝난 회차는 호출이 없었으므로 null 이다
  callDurationMs: number | null
  outcome: CaptureOutcome
  bytes: number | null
  //+_+// N2. 프레임이 그대로인지 바뀌었는지 본다. 바이트 크기로는 구분되지 않는다
  frameHash: string | null
  //+_+// P6-D17. L39 는 이 두 값 없이 판정할 수 없다. K2 가 로그에 없다고 보고했다
  //+_+// 두 값이 갈리면 리스를 놓은 타일이 있다는 뜻이다. 등록 수는 tabGone 타일도 센다
  registeredTiles: number
  attachedTabs: number
}

//+_+// FNV-1a 32비트다. 암호용이 아니고 충돌을 걱정하는 용도도 아니다
//+_+// 연속한 회차가 같은 프레임을 돌려주는지만 눈으로 확인한다
export function frameFingerprint(imageBase64: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < imageBase64.length; index += 1) {
    hash ^= imageBase64.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
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
    `call ${orDash(entry.callDurationMs)}ms`,
    entry.outcome,
  ].join(' ')

  //+_+// P6-D17. 기존 토큰의 순서와 표기를 바꾸지 않고 행 끝에 붙인다
  //+_+// 실패 회차도 L39 의 관측 대상이므로 bytes 가 없어도 이 두 값은 나온다
  const tail = `tiles ${String(entry.registeredTiles)} attached ${String(entry.attachedTabs)}`

  //+_+// 실패 회차에는 바이트가 없다. 0kB 라고 적으면 빈 이미지를 받은 것처럼 읽힌다
  if (entry.bytes === null) {
    return `${head} ${tail}`
  }
  const size = `${head} ${(entry.bytes / 1024).toFixed(1)}kB`
  const framed = entry.frameHash === null ? size : `${size} ${entry.frameHash}`
  return `${framed} ${tail}`
}

//+_+// console 호출은 이 한 곳이다. CLAUDE.md section 8 의 console.log 남발 금지 조항이다
export function logCaptureRound(entry: CaptureRoundLog): void {
  console.log(formatCaptureRound(entry))
}
