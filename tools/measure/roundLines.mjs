//+_+// 회차 로그 한 줄을 토큰으로 되돌린다. 형식은 src/background/roundLog.ts 의 formatCaptureRound 다
//+_+// 판정하지 않는다. 원문 줄은 리포트에 그대로 남고 여기서는 세는 일만 한다. P6-D24

const LINE = new RegExp(
  [
    '^\\[webdeck\\] (?<clock>\\S+) (?<tile>\\S+) (?<w>[\\d-]+)x(?<h>[\\d-]+)',
    ' every (?<interval>[\\d-]+)ms took (?<round>\\d+)ms call (?<call>[\\d-]+)ms',
    ' (?<outcome>\\S+)(?: (?<kb>[\\d.]+)kB(?: (?<hash>[0-9a-f]{8}))?)?',
    ' tiles (?<tiles>\\d+) attached (?<attached>\\d+) sched (?<sched>\\d+)ms$',
  ].join(''),
)

export function parseRoundLine(line) {
  const match = LINE.exec(line)
  if (match === null || match.groups === undefined) {
    return null
  }
  const g = match.groups
  const num = (value) => (value === undefined || value === '-' ? null : Number(value))
  return {
    clock: g.clock,
    tile: g.tile,
    w: num(g.w),
    h: num(g.h),
    intervalMs: num(g.interval),
    roundDurationMs: num(g.round),
    callDurationMs: num(g.call),
    outcome: g.outcome,
    kB: num(g.kb),
    frameHash: g.hash ?? null,
    registeredTiles: num(g.tiles),
    attachedTabs: num(g.attached),
    //+_+// P6-D51. 그 회차를 부른 주기다. every 와 갈리면 계단이나 강등 주기로 불린 것이다
    scheduleIntervalMs: num(g.sched),
  }
}

//+_+// 관측만 낸다. 회차 수 · 결과별 수 · 타일별 프레임 해시의 순서다
export function observeRounds(rows) {
  const parsed = []
  const unparsed = []
  for (const row of rows) {
    const line = typeof row?.line === 'string' ? row.line : ''
    const item = parseRoundLine(line)
    if (item === null) {
      unparsed.push(line)
    } else {
      parsed.push({ at: row.at, ...item })
    }
  }

  const outcomes = {}
  const byTile = {}
  for (const item of parsed) {
    outcomes[item.outcome] = (outcomes[item.outcome] ?? 0) + 1
    const bucket = (byTile[item.tile] ??= { rounds: 0, outcomes: {}, frameHashes: [] })
    bucket.rounds += 1
    bucket.outcomes[item.outcome] = (bucket.outcomes[item.outcome] ?? 0) + 1
    if (item.frameHash !== null) {
      bucket.frameHashes.push(item.frameHash)
    }
  }
  for (const bucket of Object.values(byTile)) {
    bucket.distinctFrameHashes = new Set(bucket.frameHashes).size
  }

  return { total: parsed.length, outcomes, byTile, unparsedCount: unparsed.length, unparsed }
}
