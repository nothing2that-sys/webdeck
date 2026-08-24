import type { BrowserTabInfo } from '../shared/types'
import type {
  DashboardFailure,
  DurationSpread,
  PortEventRow,
  RecordLogSize,
} from '../shared/messages'

//+_+// P6-D2. (a) 응답 -> 문구다. React state 를 만지지 않으므로 node 에서 시험할 수 있다. L43
//+_+// App.tsx 는 여기서 만든 문자열을 setNotice 에 넘기기만 한다. 문구를 화면 층에서 조립하지 않는다
//+_+// 효과는 옮기지 않는다. 목록 다시 읽기 같은 부수효과는 App.tsx 에 남는다. 여기는 순수하다

//+_+// 성공한 동작은 앞선 안내를 지운다. TASK-P5-03 이 고친 6곳이 이 규칙이다
export const NOTICE_NONE = ''

//+_+// P5-D30. 탭 목록이 낡았다는 실패다. 오류로 표시하지 않는다
export const NOTICE_STALE_TABS = '탭 목록이 낡았다. 다시 읽었다'

export const NOTICE_PROJECT_NAME_REQUIRED = '프로젝트 이름을 입력한다'
export const NOTICE_RENAME_REQUIRED = '바꿀 이름을 입력한다'
//+_+// 8-2.3 6번. 허브의 Rename 과 Delete 는 고른 행을 대상으로 한다. 활성 프로젝트가 아니다
export const NOTICE_PROJECT_REQUIRED = '목록에서 프로젝트를 고른다'
export const NOTICE_TAB_REQUIRED = '탭 목록에서 탭을 고른다'
export const NOTICE_BIND_TAB_REQUIRED = '먼저 탭 목록에서 붙일 탭을 고른다'
export const NOTICE_URL_REQUIRED = 'URL 을 입력한다'
export const NOTICE_INTERVAL_INVALID = '주기는 250 이상의 정수이거나 비어 있어야 한다'
export const NOTICE_DROP_REJECTED = '그 자리에는 놓을 수 없다. 원래 자리로 되돌린다'

//+_+// 실패 1건의 문구다. 코드와 사유를 그대로 싣는다. v1 section 21 이 내부 stack trace 노출을 금지한다
export function failureNotice(failure: DashboardFailure): string {
  return `${failure.errorCode}: ${failure.message}`
}

//+_+// v1 section 10 의 6단계다. 0건이면 0건이라고 알린다
export function openedTabsNotice(openedCount: number): string {
  return `${String(openedCount)} tabs opened`
}

//+_+// v1 section 7.2. 무효한 Drop 은 되돌린다는 것을 알리고 유효한 Drop 은 앞선 안내를 지운다
export function dropNotice(valid: boolean): string {
  return valid ? NOTICE_NONE : NOTICE_DROP_REJECTED
}

//+_+// 8-2.3 6번. 타일이 없는 프로젝트는 목록 자리를 비우지 않고 그 사실을 적는다
export const HUB_NO_TILES = '타일이 없다'

//+_+// 허브에서 고른 행이다. toggleClassName 과 같은 규칙이며 색은 CSS 가 정한다
export function hubRowClassName(selected: boolean): string {
  return selected ? 'hub-row hub-row--on' : 'hub-row'
}

//+_+// 툴바 토글 두 개가 같은 규칙을 쓴다. Edit Layout 과 Pause Preview 다
export function toggleLabel(name: string, on: boolean): string {
  return on ? `${name} · on` : name
}

export function toggleClassName(on: boolean): string {
  return on ? 'toolbar-toggle toolbar-toggle--on' : 'toolbar-toggle'
}

//+_+// P7-D62. Privacy Mode. 켜진 동안만 그리드에 표식을 붙이고 가리기는 CSS 가 한다
//+_+// 워커에 닿지 않는다. dataUrl 을 지우지 않으므로 끄면 그대로 돌아온다
export function gridClassName(privacy: boolean): string {
  return privacy ? 'grid grid--privacy' : 'grid'
}

//+_+// 타일을 고르기 전에는 설정 폼이 비어 있고 라벨이 안내문이다
export function tileSettingsLabel(open: boolean): string {
  return open ? 'Tile' : '타일을 고르면 설정이 열린다'
}

//+_+// P6-D112. 표시가 최근 N개 기준이라는 것을 화면이 밝힌다. 전체 누적으로 읽히면 안 된다
export function diagnosticsScopeLabel(sampleLimit: number): string {
  return `회차 소요와 타임아웃은 최근 ${String(sampleLimit)}개 기준`
}

//+_+// P6-D10 · D113. 최소 · 중간 · 최대다. 평균을 만들지 않는다. 표본이 없으면 값을 지어내지 않는다
export function durationSpreadLabel(spread: DurationSpread): string {
  if (spread.count === 0 || spread.min === null || spread.mid === null || spread.max === null) {
    return '표본 없음'
  }
  return `${String(spread.min)} / ${String(spread.mid)} / ${String(spread.max)} ms · n ${String(spread.count)}`
}

//+_+// 계측 배선이 없으면 모르는 것이다. 0 으로 적으면 관측했다는 뜻이 된다
export function workerStartsLabel(starts: number | null): string {
  return starts === null ? '모름' : String(starts)
}

//+_+// P6-D112. 배열 하나의 현재 길이와 상한이다. 상한에 닿았는지가 한눈에 보여야 한다
export function recordLogLabel(log: RecordLogSize): string {
  return `${log.name} ${String(log.length)} / ${String(log.limit)}`
}

//+_+// TASK-P8-05 §1.6. 관측용 한 줄이다. 로컬 시:분:초다. roundLog 의 시계와 같은 규칙이고
//+_+// 밀리초는 뺐다 -- 관측이 재는 것은 초 단위다 (TASK-P8-05 §3 6번)
//+_+// clientId 는 앞 8자만 보인다. 전부 보이면 줄이 길어져 여러 줄을 한눈에 못 본다. J164
export function portEventLabel(row: PortEventRow): string {
  const time = new Date(row.at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const hms = [time.getHours(), time.getMinutes(), time.getSeconds()].map(pad).join(':')
  return `${hms} ${row.event} ${row.clientId.slice(0, 8)}`
}

//+_+// 제목이 비어 있는 탭은 URL 로 보인다. 빈 줄이 목록에 남지 않게 한다
export function browserTabLabel(tab: BrowserTabInfo): string {
  return `${String(tab.tabId)} · ${tab.title.length === 0 ? tab.currentUrl : tab.title}`
}
