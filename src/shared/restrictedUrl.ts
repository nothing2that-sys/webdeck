//+_+// v1 section 22. Chrome 내부 페이지와 보호 페이지는 debugger / capture 가 제한될 수 있다
//+_+// P6-D103. 목록을 상수 한 곳에 세운다. 분기문에 흩지 않고 기억으로 채우지도 않는다
//+_+// 근거가 있는 것만 넣는다
//+_+//   chrome://            v1 section 22 가 명시한다.  Phase 4 에서 attach 3회 실패가 실측됐다 (L2 · L29)
//+_+// P7-D80. chrome-extension:// 을 뺐다. 그 스킴에 attach 3/3 과 캡처 3/3 이 실측됐다 (L48)
//+_+// v1 section 22 의 "Chrome Web Store 등" 은 넣지 않았다. 스킴이 아니라 사이트 이름이고
//+_+// 그 URL 을 정한 근거가 저장소에 없다. 넣으면 기억으로 채우는 것이 된다
export const RESTRICTED_URL_PREFIXES: readonly string[] = ['chrome://']

//+_+// 접두사 일치다. 문자열 어디에나 나타나는 것을 잡지 않는다. 질의 문자열에 실린 URL 이 걸리면 안 된다
export function isRestrictedUrl(url: string): boolean {
  return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))
}
