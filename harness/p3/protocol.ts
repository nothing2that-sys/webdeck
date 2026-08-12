import type { HarnessReport } from './report'

//+_+// 버릴 코드다. 페이지와 워커 사이의 메시지만 정의한다

export type IdleMode = 'IDLE-A' | 'IDLE-B' | 'IDLE-C'

export type InjectionName =
  | 'missingTab'
  | 'sendAfterDetach'
  | 'forceTimeout'
  | 'forceDetach'
  | 'forceDevtools'

export interface TabSummary {
  tabId: number
  title: string
  url: string
}

export type HarnessRequest =
  | { type: 'LIST_TABS' }
  | { type: 'START_CAPTURE'; tabIds: number[]; intervalMs: number }
  | { type: 'STOP_CAPTURE' }
  | { type: 'ATTACH_STAGE'; stage: number; tabIds: number[] }
  | { type: 'INJECT'; name: InjectionName; tabId: number }
  | { type: 'REENCODE'; tabId: number }
  | { type: 'PROBE' }
  | { type: 'IDLE'; mode: IdleMode }
  | { type: 'SET_OBSERVATION'; key: string; value: string }
  | {
      type: 'BUILD_REPORT'
      chromeFullVersion: string
      round: string
      //+_+// 페이지가 localStorage 에서 읽어 넣는다. 워커는 이 값을 만들지 않는다. P3-D18
      idleTransitionClient: string | null
    }
  | { type: 'RESET_ROUND' }
  | { type: 'SNAPSHOT' }

export interface HarnessSnapshot {
  captureCount: number
  lateArrivalCount: number
  attachedCount: number
  attachOkTotal: number
  attachFailTotal: number
  inFlight: number
  queued: number
  swStarts: string[]
  idleTransition: string | null
  lastFrames: { tileId: string; format: string; bytes: number; imageBase64: string }[]
  detachReasons: string[]
}

export type HarnessResponse =
  | { ok: true; type: 'LIST_TABS'; tabs: TabSummary[] }
  | { ok: true; type: 'SNAPSHOT'; snapshot: HarnessSnapshot }
  | { ok: true; type: 'BUILD_REPORT'; report: HarnessReport }
  | { ok: true; type: 'REENCODE'; q70: string | null; q85: string | null }
  | { ok: true; type: 'ACK' }
  | { ok: false; message: string }
