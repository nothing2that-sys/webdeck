import type { BrowserTabInfo } from '../shared/types'
import type { DashboardFailure } from '../shared/messages'

//+_+// P6-D2. (a) 응답 -> 문구다. React state 를 만지지 않으므로 node 에서 시험할 수 있다. L43
//+_+// App.tsx 는 여기서 만든 문자열을 setNotice 에 넘기기만 한다. 문구를 화면 층에서 조립하지 않는다
//+_+// 효과는 옮기지 않는다. 목록 다시 읽기 같은 부수효과는 App.tsx 에 남는다. 여기는 순수하다

//+_+// 성공한 동작은 앞선 안내를 지운다. TASK-P5-03 이 고친 6곳이 이 규칙이다
export const NOTICE_NONE = ''

//+_+// P5-D30. 탭 목록이 낡았다는 실패다. 오류로 표시하지 않는다
export const NOTICE_STALE_TABS = '탭 목록이 낡았다. 다시 읽었다'

export const NOTICE_PROJECT_NAME_REQUIRED = '프로젝트 이름을 입력한다'
export const NOTICE_RENAME_REQUIRED = '바꿀 이름을 입력한다'
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

//+_+// 툴바 토글 두 개가 같은 규칙을 쓴다. Edit Layout 과 Pause Preview 다
export function toggleLabel(name: string, on: boolean): string {
  return on ? `${name} · on` : name
}

export function toggleClassName(on: boolean): string {
  return on ? 'toolbar-toggle toolbar-toggle--on' : 'toolbar-toggle'
}

//+_+// 타일을 고르기 전에는 설정 폼이 비어 있고 라벨이 안내문이다
export function tileSettingsLabel(open: boolean): string {
  return open ? 'Tile' : '타일을 고르면 설정이 열린다'
}

//+_+// 제목이 비어 있는 탭은 URL 로 보인다. 빈 줄이 목록에 남지 않게 한다
export function browserTabLabel(tab: BrowserTabInfo): string {
  return `${String(tab.tabId)} · ${tab.title.length === 0 ? tab.currentUrl : tab.title}`
}
