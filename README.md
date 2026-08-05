# WebDeck

Chrome 탭 여러 개를 프로젝트 단위로 묶어 그리드에서 라이브 미리보기하고, 타일을 더블클릭하면 실제 탭으로 전환하는 Chrome 확장이다.

Load unpacked 전용이다. Chrome Web Store 배포는 범위 밖이다.

## 권한

### debugger 권한이 필요한 이유

웹덱은 background 상태인 탭의 현재 화면을 주기적으로 캡처한다.
chrome.tabs.captureVisibleTab 은 활성 탭만 캡처하므로 이 목적에 맞지 않는다 (v1 §5.1).
따라서 chrome.debugger 로 대상 탭에 attach 하고 CDP Page.captureScreenshot 을 호출한다.
Phase 1 POC 에서 이 방식이 검증되었다.

정직하게 적어둔다: debugger 는 `<all_urls>` host permission 의 상위집합이다.
따라서 이 확장에 대해 "최소 권한"이라는 표현을 쓰지 않는다.
로컬 unpacked 전용이라 실무 문제는 아니지만 문서가 스스로를 속이지 않는다.
(WEBDECK_PLAN.md §9 line 277 원문 취지)

캡처 이미지는 영구 저장하지 않는다. 외부로 전송하지 않는다.
Telemetry 와 Analytics 를 넣지 않는다.
