import type { HarnessRequest, HarnessResponse, InjectionName, TabSummary } from './protocol'
import { reportFileName } from './report'

//+_+// 버릴 코드다. 제품에 남기지 않는다

const ATTACH_STAGES = [3, 6, 9, 12, 16]

const OBSERVATION_KEYS = [
  'bannerAtStage',
  'previewUpdatesInBackground',
  'devtoolsOpenedBehaviour',
  'readabilityQ70VsQ85',
  'liveCounterTickComparison',
  'anythingElse',
]

//+_+// 전이 사실을 페이지 메모리 밖에 남긴다. 페이지를 다시 열어도 재연결하지 않아야 한다
//+_+// localStorage 는 확장 API 가 아니므로 이 쓰기가 워커를 깨우지 않는다
const IDLE_KEY = 'harnessIdleTransition'

let tabList: TabSummary[] = []
let port: chrome.runtime.Port | null = null
let idleReached = false
let pollHandle: ReturnType<typeof setInterval> | null = null

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) {
    throw new Error(`missing element ${id}`)
  }
  return node as T
}

function storedIdle(): string | null {
  try {
    return localStorage.getItem(IDLE_KEY)
  } catch {
    return null
  }
}

//+_+// 눌렀는지 사용자가 알 수 없다는 신고에 대한 표시다
function renderIdleState(): void {
  const host = el('idleState')
  const value = storedIdle()
  if (value === null) {
    host.textContent = 'idle 전이 없음 · 포트 연결됨'
    host.className = ''
    return
  }
  const [mode, iso] = value.split(' at ')
  const clock =
    iso === undefined ? '시각 불명' : new Date(iso).toLocaleTimeString('ko-KR', { hour12: false })
  host.textContent =
    `${mode ?? 'IDLE'} 전이됨 ${clock} · 포트를 연결하지 않는다. 워커를 깨우지 않는다. ` +
    '리포트를 받으려면 아래 해제 버튼을 누른다'
  host.className = 'warn'
}

function log(text: string): void {
  const box = el('log')
  box.textContent = `${new Date().toISOString()}  ${text}\n${box.textContent ?? ''}`
}

//+_+// 전이 이후에는 어떤 통신도 하지 않는다. 워커를 깨우면 L1 관측이 오염된다
async function send(request: HarnessRequest): Promise<HarnessResponse> {
  if (idleReached) {
    return { ok: false, message: 'idle transition reached. the page no longer talks to the worker' }
  }
  const response = (await chrome.runtime.sendMessage(request)) as HarnessResponse
  if (!response.ok) {
    log(`error: ${response.message}`)
  }
  return response
}

function selectedTabIds(): number[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[data-tab]')]
    .filter((box) => box.checked)
    .map((box) => Number(box.dataset.tab))
}

function renderTabs(): void {
  const host = el('tabs')
  host.textContent = ''
  const table = document.createElement('table')
  for (const tab of tabList) {
    const row = table.insertRow()
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.dataset.tab = String(tab.tabId)
    row.insertCell().append(box)
    row.insertCell().textContent = String(tab.tabId)
    row.insertCell().textContent = tab.title.slice(0, 60)
    row.insertCell().textContent = tab.url.slice(0, 70)
  }
  host.append(table)
}

function renderStages(): void {
  const host = el('stages')
  host.textContent = ''
  const table = document.createElement('table')
  const head = table.insertRow()
  for (const label of ['stage', '실행', '배너 관측 (ok 수와 같은 행)']) {
    const cell = document.createElement('th')
    cell.textContent = label
    head.append(cell)
  }
  for (const stage of ATTACH_STAGES) {
    const row = table.insertRow()
    row.insertCell().textContent = String(stage)

    const run = document.createElement('button')
    run.textContent = `attach ${String(stage)}`
    run.addEventListener('click', () => {
      void (async () => {
        const ids = tabList.slice(0, stage).map((tab) => tab.tabId)
        await send({ type: 'ATTACH_STAGE', stage, tabIds: ids })
        log(`attach stage ${String(stage)} requested ${String(ids.length)} tabs`)
        await refresh()
      })()
    })
    row.insertCell().append(run)

    const note = document.createElement('input')
    note.type = 'text'
    note.placeholder = '배너 보였는가'
    note.addEventListener('change', () => {
      void send({
        type: 'SET_OBSERVATION',
        key: `bannerAtStage${String(stage)}`,
        value: note.value,
      })
    })
    row.insertCell().append(note)
  }
  host.append(table)
}

function renderObservations(): void {
  const host = el('observations')
  for (const key of OBSERVATION_KEYS) {
    const label = document.createElement('div')
    label.textContent = key
    const area = document.createElement('textarea')
    area.addEventListener('change', () => {
      void send({ type: 'SET_OBSERVATION', key, value: area.value })
    })
    host.append(label, area)
  }
}

async function refresh(): Promise<void> {
  if (idleReached) {
    return
  }
  const response = await send({ type: 'SNAPSHOT' })
  if (!response.ok || response.type !== 'SNAPSHOT') {
    return
  }
  const snapshot = response.snapshot
  //+_+// attached 는 지금 리스를 든 탭 수이고 attachOk 는 누적 성공 호출 수다. 둘은 다르다
  el('status').textContent =
    `captures ${String(snapshot.captureCount)} · lateArrivals ${String(snapshot.lateArrivalCount)} · ` +
    `inFlight ${String(snapshot.inFlight)} · queued ${String(snapshot.queued)} · ` +
    `attached ${String(snapshot.attachedCount)} · ` +
    `attachOk ${String(snapshot.attachOkTotal)} / fail ${String(snapshot.attachFailTotal)} · ` +
    `swStarts ${String(snapshot.swStarts.length)}`
  el('detachReasons').textContent =
    snapshot.detachReasons.length === 0
      ? 'detach reason 관측 없음'
      : `detach reason 원문: ${snapshot.detachReasons.join(' | ')}`
}

async function goIdle(mode: 'IDLE-A' | 'IDLE-B' | 'IDLE-C'): Promise<void> {
  await send({ type: 'IDLE', mode })
  idleReached = true
  try {
    localStorage.setItem(IDLE_KEY, `${mode} at ${new Date().toISOString()}`)
  } catch {
    log('localStorage 에 전이 기록을 남기지 못했다. 페이지를 다시 열면 재연결된다')
  }
  if (pollHandle !== null) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  port?.disconnect()
  port = null
  renderIdleState()
  el('status').textContent = `${mode} 전이 완료. 이 페이지는 더 이상 워커와 통신하지 않는다`
  log(`${mode} 전이. 포트를 끊었다`)
}

function download(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

function wire(): void {
  el('listTabs').addEventListener('click', () => {
    void (async () => {
      const response = await send({ type: 'LIST_TABS' })
      if (response.ok && response.type === 'LIST_TABS') {
        tabList = response.tabs
        renderTabs()
        renderStages()
        log(`탭 ${String(tabList.length)}개`)
      }
    })()
  })

  el('start').addEventListener('click', () => {
    void (async () => {
      const tabIds = selectedTabIds()
      if (tabIds.length === 0) {
        log('탭을 하나 이상 선택해라')
        return
      }
      await send({
        type: 'START_CAPTURE',
        tabIds,
        intervalMs: Number(el<HTMLInputElement>('interval').value),
        pageEnable: el<HTMLInputElement>('pageEnable').checked,
      })
      log(`캡처 시작. 탭 ${String(tabIds.length)}개`)
    })()
  })

  el('stop').addEventListener('click', () => {
    void send({ type: 'STOP_CAPTURE' }).then(() => {
      log('캡처 정지')
    })
  })

  el('idleA').addEventListener('click', () => void goIdle('IDLE-A'))
  el('idleB').addEventListener('click', () => void goIdle('IDLE-B'))
  el('idleC').addEventListener('click', () => void goIdle('IDLE-C'))

  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-inject]')) {
    button.addEventListener('click', () => {
      void (async () => {
        const name = button.dataset.inject as InjectionName
        const tabId = selectedTabIds()[0] ?? tabList[0]?.tabId ?? -1
        await send({ type: 'INJECT', name, tabId })
        log(`injection ${name} on tab ${String(tabId)}`)
        await refresh()
      })()
    })
  }

  el('reencode').addEventListener('click', () => {
    void (async () => {
      const tabId = selectedTabIds()[0] ?? tabList[0]?.tabId ?? -1
      const response = await send({ type: 'REENCODE', tabId })
      if (!response.ok || response.type !== 'REENCODE') {
        return
      }
      const host = el('reencodeOut')
      host.textContent = ''
      for (const [label, data] of [
        ['q70', response.q70],
        ['q85', response.q85],
      ] as const) {
        const figure = document.createElement('figure')
        const caption = document.createElement('figcaption')
        caption.textContent = data === null ? `${label} 실패` : `${label} · ${String(data.length)} base64 chars`
        if (data !== null) {
          const image = document.createElement('img')
          image.src = `data:image/jpeg;base64,${data}`
          figure.append(image)
        }
        figure.append(caption)
        host.append(figure)
      }
      log('재인코딩 완료. 바이트 수는 리포트의 reencode 에 있다')
    })()
  })

  el('probe').addEventListener('click', () => {
    void send({ type: 'PROBE' }).then(() => {
      log('프로브 실행. 결과는 리포트의 environment 에 있다')
    })
  })

  //+_+// 워커를 깨우는 것은 여기서만 일어난다. 자동 재연결 경로를 두지 않는다
  el('releaseIdle').addEventListener('click', () => {
    try {
      localStorage.removeItem(IDLE_KEY)
    } catch {
      log('localStorage 를 비우지 못했다')
    }
    location.reload()
  })

  el('resetRound').addEventListener('click', () => {
    void (async () => {
      await send({ type: 'RESET_ROUND' })
      el('reencodeOut').textContent = ''
      log('라운드 초기화. 캡처가 멈췄다. 새 라운드를 시작해라')
      await refresh()
    })()
  })

  el('download').addEventListener('click', () => {
    void (async () => {
      const version = el<HTMLInputElement>('chromeVersion').value.trim()
      if (version === '') {
        el('versionWarn').textContent = 'chromeFullVersion 을 채워야 저장할 수 있다'
        return
      }
      el('versionWarn').textContent = ''
      const round = el<HTMLInputElement>('round').value.trim()
      const response = await send({ type: 'BUILD_REPORT', chromeFullVersion: version, round })
      if (!response.ok || response.type !== 'BUILD_REPORT') {
        return
      }
      download(JSON.stringify(response.report, null, 2), reportFileName(round))
      log(`${reportFileName(round)} 내려받았다. docs/ 아래로 옮겨 커밋해라`)
    })()
  })
}

wire()
renderObservations()

//+_+// 전이 기록이 남아 있으면 연결도 폴링도 하지 않는다. 폴링 자체가 워커를 2초마다 깨운다
idleReached = storedIdle() !== null
renderIdleState()
if (!idleReached) {
  port = chrome.runtime.connect({ name: 'harness' })
  pollHandle = setInterval(() => {
    void refresh()
  }, 2000)
  void refresh()
}
