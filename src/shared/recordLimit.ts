//+_+// P6-D7 · D112. 제품의 기록 배열 5개가 쓰는 상한이다. L26 이 연 항목이다
//+_+//   attachFailures · detachEvents · detachFailures   debuggerSessionManager
//+_+//   captureRecords · lateArrivals                    previewCaptureManager
//+_+// 200 인 이유는 P6-D56 의 재연결 기록과 같은 자리이기 때문이다. Diagnostics 표시가
//+_+// 최소 · 중간 · 최대와 타임아웃 수뿐이므로(P6-D10) 전량 보존이 필요 없다
//+_+// 계측 키(webdeck.diagnostics.*)의 상한과는 다른 값이다. 그쪽은 diagnostics.ts 가 따로 정한다
export const RECORD_LOG_LIMIT = 200

//+_+// 오래된 것을 버린다. 최근 것이 남는다. 다섯 자리가 같은 규칙을 쓰도록 한 곳에만 둔다
//+_+// 제자리에서 자른다. 배열을 새로 만들면 getter 가 돌려준 참조가 갈린다
export function pushBounded<T>(log: T[], entry: T, limit = RECORD_LOG_LIMIT): void {
  log.push(entry)
  if (log.length > limit) {
    log.splice(0, log.length - limit)
  }
}
