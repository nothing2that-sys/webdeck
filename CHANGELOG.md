# CHANGELOG

**Phase 단위로 적는다** (`P6-D132`). 커밋 단위로 적지 않는다. 이 저장소가 일하는 단위는
Phase 이고 커밋은 그 안의 절차다.

각 Phase 에 **들어간 것 · 세운 제약 · 닫은 제약 · 마지막 커밋**을 적는다. 제약 번호는
`docs/LIMITATIONS.md` 의 것이고 그 파일이 정본이다. 결정 번호는 `docs/DECISIONS_P*.md` 다.

경계를 넘나드는 문서 커밋은 **커밋 시각이 아니라 그 문서가 다루는 Phase 쪽에 넣었다**
(`P6-D139`).

---

## Phase 6 · 계측과 마무리 (2026-08-18 ~ 진행 중)

들어간 것

```
Puppeteer 계측 하네스 (tools/measure).  시나리오 다섯과 리포트 JSON
Dashboard hidden 시 Preview 자동 Pause, 스케줄 일관성, 교차 프로젝트 재연결
전체 Pause 토글 (SET_PREVIEW_PAUSED) 과 Diagnostics 조회 (GET_DIAGNOSTICS)
Restricted URL 처리.  chrome:// 와 chrome-extension:// 에 RESTRICTED 상태
App.tsx 의 표시 규칙을 순수 함수로 분리 (screenText / tileView)
기록 배열 전체에 상한 (src/shared/recordLimit.ts)
alarms 권한 제거
DashboardFailure.errorCode 를 12종 union 으로 좁힘
docs/V1_DEVIATIONS.md · README.md · docs/TEST_PLAN.md · CHANGELOG.md
```

세운 제약

```
L44  타일별 Pause 가 없다
L45  워커 기동 이후에 열린 탭이 전환 시점에 잡히지 않는다
L46  dist 의 Dashboard 페이지가 preload 경고를 반복한다
L47  ERROR 표시 경로에 재현 수단이 없다
L48  Restricted URL 지원 범위가 두 스킴뿐이다
```

닫은 제약

```
L9   해소.  attach 는 배경 탭 타이머 스로틀을 억제하지 못한다
L10  해소.  vite build 가 src/shared/* 를 검증한다
L26  해소.  기록 배열에 상한이 생겼다
L29  해소.  영구 포기 상태가 생겼다
L5   부분 해소.  16타일 포화를 실측했다.  슬롯 점유율 99.6%
L39  부분 해소
L43  부분 해소.  표시 규칙이 기계 검증된다
L16  편차 확정.  4조합 주기 배정은 v1 미근거로 남긴다
L41  배정을 Phase 7 로 옮겼다.  하네스 재실행이 Phase 6 에서 일어나지 않았다
```

마지막 커밋 — **진행 중이다.** 이 문서를 쓴 시점의 HEAD 는 `b730144` 다.

---

## Phase 5 · 프로젝트와 타일 관리 (2026-08-13 ~ 2026-08-14)

들어간 것

```
저장 스키마 2.  타일별 주기 override
프로젝트 CRUD 다섯과 활성 전환, 툴바의 프로젝트 선택기
ADD_TILE.  기존 탭과 URL 두 경로
타일 설정 4필드 일괄 교체 (customTitle / fitMode / matchMode / 주기)
REOPEN_TILE · REMOVE_TILE 과 타일 안의 복구 버튼 셋
URL 재연결을 순수 함수로.  워커 기동 시 재연결과 OPEN_MISSING_TABS
CAPTURE_TILE 을 Refresh Preview 로.  visibilitychange 반응
```

세운 제약

```
L40  load 실패 후 첫 저장이 거부된 저장값을 덮어쓴다
L41  releaseTab 의 의미 변경이 harness/p3 에 파급된다
L42  Refresh Preview 가 배경 탭 스로틀 구간에서 실패한다
L43  App.tsx 안의 표시 규칙이 기계 검증되지 않는다
```

닫은 제약

```
L14  해소.  목록이 비면 기본 프로젝트가 선다
L36  해소.  상태 소유를 캡처 엔진 층으로 모았다
L11  처분 확정.  정규화하지 않고 matchMode 노출로 회피한다 (P5-D7)
L35  부분 해소.  리스너는 붙었고 즉시성은 측정되지 않았다
```

마지막 커밋 `22ad880 docs: fold the Phase 5 outcome into LIMITATIONS`

`4c21b59` 는 시각이 Phase 4 구간에 있으나 Phase 5 작업 지시서라 여기에 넣었다.

---

## Phase 4 · Dashboard UI (2026-08-12 ~ 2026-08-13)

들어간 것

```
서비스 워커 번들과 manifest 등록
워커의 Dashboard 요청 처리기
4x4 그리드 렌더.  미리보기와 상태 배지
FOCUS_TILE.  타일 더블클릭으로 탭 전환
SET_TILE_RECT 와 포인터 드래그 레이아웃 편집
폴링에 dashboardVisible 을 실음
Alt+Shift+D 로 Dashboard 열기
회차 로그와 프레임 지문
```

세운 제약

```
L35  hidden 전환이 최대 한 폴링 주기만큼 늦는다
L36  층별 상태 판정이 이원화돼 있다
L37  Preview 가 타일을 채우지 못한다
L38  L21~L24 의 원시 리포트가 저장소에 없다
L39  타일 수와 캡처 타임아웃의 관계가 미상이다
```

닫은 제약

```
L2   해소.  두 표시 경로가 제품 UI 에서 실행됐다
L20  해소.  단축키에 처리기를 붙였고 실측으로 동작이 확인됐다
L32  해소.  회피 불가 판정이 뒤집혔다
```

마지막 커밋 `20824bf docs: resolve the four self-referential line-number citations`

`46b2c8b` 는 Phase 3 구간 끝에 찍혔으나 Phase 4 인계 문서라 여기에 넣었다.

---

## Phase 3 · 캡처 엔진 (2026-08-06 ~ 2026-08-12)

`TASK-P3-PRE-01` · `TASK-P3-PRE-02` (2026-08-06) 는 **Phase 로 세지 않는다.** Phase 3 안의
선행 계측 구간이다 (`P6-D139`). 그 구간이 `L21` ~ `L24` 를 세웠다.

들어간 것

```
선행 구간  전송 방식 아홉 가지의 비용 실측.  T1 (base64 + sendMessage) 확정
           워커 측 페이로드 비용과 타이머 해상도 측정
본 구간    캡처 페이로드 · DEVTOOLS 상태 · 타임아웃 상수
           리스 기반 debugger 세션 매니저
           하드 타임아웃과 STALE 전이를 갖는 캡처 큐
           스케줄러 구동자와 background 배선
           Phase 3 계측 하네스 (harness/p3)
           세션 유실 후 재attach, 회차 경계
```

세운 제약

```
L21  정지 화면 배경 탭에서 captureScreenshot 이 반환되지 않는다   선행 구간
L22  캡처 지속시간 분포가 이봉형이다                              선행 구간
L23  타임아웃 행에 startedAt / durationMs 가 없다                 선행 구간
L24  단계별 attach 전부 실패, 오류 미기록                          선행 구간
L25  onDetach reason 으로 DEVTOOLS 를 판별할 수 없다
L26  기록 배열에 상한이 없다
L27  Page.enable 은 필요하지 않다                                 같은 Phase 안에서 닫혔다
L28  회차 소요와 호출 소요는 다른 값이다
L29  영구 포기 상태가 없다
L30  하네스 리포트가 워커 메모리에만 있다
L31  배경 탭의 문서 타이머가 60초로 스로틀되는 것으로 보인다
L32  실효 주기가 지정 주기와 어긋난다
L33  측정 도중 Chrome 이 두 번 갱신됐다
L34  캡처 중 워커가 죽지 않는 이유가 미상이다
```

닫은 제약

```
L1   해소.  제품에 내재된 keepalive 는 없다
L3   해소.  detach 재연결 경로가 처음 실행됐다
L7   해소.  기본 포맷은 jpeg q70 을 유지한다
L12  해소.  전송은 base64 + sendMessage 다
L23  해소.  타임아웃 행에 시각이 남는다
L27  해소.  Page.enable 을 캡처 경로에서 뺐다.  이 Phase 가 세우고 이 Phase 가 닫았다
```

마지막 커밋 `656acf9 docs: track phase 3 measurement reports`

---

## Phase 2 · 순수 로직 (2026-08-05)

들어간 것

```
빌드 툴체인 (TypeScript strict · Vite · ESLint · Vitest)
프로젝트와 타일 도메인 타입
Dashboard 메시지 프로토콜
4x4 그리드 경계와 충돌 판정
URL 매칭 세 모드 (exact / origin / prefix)
프로젝트 저장 직렬화
캡처 스케줄링 정책
```

세운 제약 — `L10` ~ `L20` 열한 개. `docs/LIMITATIONS.md` 를 본다.

닫은 제약 — 없다.

마지막 커밋 `a89d368 docs: remove leaked instruction text and unify phase emphasis`

`c5cd681` 과 `ae10d19` 는 `CLAUDE.md` 를 세운 커밋이다. Phase 산출물이 아니라 **Phase 2
이후 전 구간을 지배하는 협업 규칙이므로** 규칙이 선 자리인 여기에 적어 둔다.

---

## Phase 1 · POC (2026-08-04 ~ 2026-08-05)

**이 Phase 의 목적은 기능이 아니라 판정이었다.** `chrome.debugger` + `Page.captureScreenshot`
으로 배경 탭을 캡처할 수 있는가. 불합격이면 웹덱을 중단하기로 되어 있었다.

들어간 것

```
poc/ 아래의 배경 캡처 프로브.  이후 동결이다
타임아웃된 debugger 명령의 늦은 reject 흡수
docs/POC_RESULT.md
```

세운 제약 — `L1` ~ `L9` 아홉 개. 출처는 `docs/POC_RESULT.md` 다.

닫은 제약 — 없다. 첫 Phase 다.

마지막 커밋 `73e6bef docs(poc): fix report preservation status as both rounds unpreserved`
