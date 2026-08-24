# WebDeck

Chrome 탭 여러 개를 프로젝트 단위로 묶어 4x4 그리드에서 라이브 미리보기하고, 타일을
더블클릭하면 그 탭으로 전환하는 Chrome 확장이다. 배경에 있는 탭도 계속 캡처하므로 탭을
하나씩 눌러 보지 않고도 여러 화면의 현재 상태를 한자리에서 본다. Load unpacked 전용이다.

## 설치와 실행

Node 와 npm 이 있어야 한다.

```
npm install
npm run build
```

산출물은 `dist/` 다. 그 안에 `manifest.json` 이 함께 들어간다.

```
chrome://extensions 를 연다
Developer mode 를 켠다
Load unpacked 를 누른다
dist 폴더를 고른다
```

### 디버깅 배너 끄기 (선택)

`debugger` 를 쓰는 동안 Chrome 이 주소창 아래에 배너를 띄운다. Chrome 실행 플래그로 끌 수
있다. 바로가기 속성의 대상 끝에 붙인다.

```
--silent-debugger-extension-api
```

이 플래그는 브라우저 프로세스 전역이다. 웹덱만 골라 가릴 수 없고, 같은 Chrome 에 붙는 다른
확장의 디버깅도 함께 가려진다. **디버거를 붙이는 다른 확장이 없다는 것을 확인하고 쓴다** —
웹덱을 끈 상태에서 배너가 한 번도 뜨지 않으면 없는 것이다.

`--user-data-dir` 로 프로필을 가르지 않는다. 프로필을 가르면 `chrome.storage.local` 이
달라져 저장된 프로젝트·레이아웃·Pause 상태가 그 프로필에 없다.

Dashboard 는 두 가지로 연다.

```
툴바의 WebDeck 아이콘을 누른다
Alt+Shift+D 를 누른다
```

둘 다 같은 동작이다. 이미 열려 있으면 새로 만들지 않고 그 탭을 활성화한다.

개발용 명령은 여섯 개다.

```
npm run typecheck      tsc --noEmit
npm run lint           eslint .
npm run test           vitest run
npm run build          dist/
npm run build:harness  dist-harness/    Phase 3 계측 하네스. 제품이 아니다
npm run measure        tools/measure 의 Chrome 계측 시나리오
```

## 화면 구성

### Toolbar

```
프로젝트 선택 · 이름 입력 · New · Rename · Delete
tiles N              현재 프로젝트의 타일 수
Edit Layout          켜면 타일을 끌어 옮기고 크기를 바꾼다.  끄면 더블클릭이 탭 전환이다
Pause Preview        캡처를 멈춘다.  attach 는 풀지 않는다
Diagnostics          회차 소요 · 타임아웃 · 등록 타일 · attach 수 · 워커 기동 수를 편다
Privacy              모든 타일의 미리보기를 가린다.  캡처는 멈추지 않는다.  저장하지 않는다
탭 선택 · 탭 새로고침 · Add Tab
URL 입력 · Add URL
Open Missing Tabs    탭이 사라진 타일들의 탭을 한 번에 다시 연다
```

v1 §14 의 네 항목 중 `Refresh All` 과 `Settings` 는 없다. `docs/V1_DEVIATIONS.md` §4 를 본다.

### 타일 설정 바

타일을 고르면 켜진다.

```
Custom Tile Name     비우면 탭 제목을 쓴다
fit                  contain / cover
match                exact / origin / prefix.  탭을 다시 찾을 때 URL 을 어디까지 맞출지다
주기 ms              비우면 타일 크기에 따라 자동이다.  최소 250
Apply · Refresh Preview · Remove Tile
```

탭이 사라진 타일에는 `Reopen` · `Bind Existing Tab` · `Remove Tile` 세 버튼이 타일 안에 뜬다.

### 타일 상태 아홉 개

```
LIVE        캡처가 제때 오고 있다
LOADING     타일은 섰고 첫 프레임이 아직 없다
STALE       마지막 프레임이 기본 주기의 3배를 넘겼다.  Pause 구간은 세지 않는다
DETACHED    붙을 탭이 없다.  탭이 닫혔거나 아직 못 찾았다
DEVTOOLS    같은 탭에 DevTools 가 붙었다는 판정이다.  지금은 도달하지 않는다 (L25)
ERROR       attach 가 상한까지 실패했다
RESTRICTED  chrome:// 이라 캡처하지 않는다.  chrome-extension:// 은 실측 뒤 목록에서 뺐다
FROZEN      v1 section 11 의 탭 상태다.  만들지 않았다
DISCARDED   같다
```

`FROZEN` 과 `DISCARDED` 는 배지 이름만 있고 생산자가 없다. `docs/V1_DEVIATIONS.md` §3 을 본다.

## 권한

이 확장은 `tabs` · `storage` · `debugger` 세 권한을 쓴다.

```
tabs       탭 목록과 제목 · URL 을 읽는다
storage    프로젝트 · 레이아웃 · Pause 상태 · 진단 기록을 로컬에 저장한다
debugger   Chrome DevTools Protocol 로 탭 화면을 캡처한다
```

**`debugger` 는 `<all_urls>` 의 상위집합이다. "최소 권한" 이라는 표현을 쓰지 않는다.**

이 권한으로 할 수 있는 것은 host permission 으로 할 수 있는 것을 포함한다. 실제로 쓰는
CDP 명령은 `Page.captureScreenshot` 하나지만, 권한 자체는 그 범위로 제한되지 않는다.

```
외부 서버로 URL · 화면 · 탭 제목 · 브라우징 정보를 전송하지 않는다
Telemetry 없음.  Analytics 없음.  화면 영구 저장 없음
Chrome Web Store 배포는 범위 밖이다.  Load unpacked 로만 쓴다
```

`debugger` 를 쓰는 동안 Chrome 이 **디버깅 배너를 띄운다.** 확장 코드로는 끌 수 없다.
Preview 를 Pause 해도 배너는 남는다 — Pause 는 캡처를 멈출 뿐 attach 를 풀지 않기 때문이다.
Chrome 실행 플래그로는 끌 수 있다. 「설치와 실행」의 디버깅 배너 끄기를 본다.

### debugger 권한이 필요한 이유

웹덱은 background 상태인 탭의 현재 화면을 주기적으로 캡처한다.
`chrome.tabs.captureVisibleTab` 은 활성 탭만 캡처하므로 이 목적에 맞지 않는다 (v1 §5.1).
따라서 `chrome.debugger` 로 대상 탭에 attach 하고 CDP `Page.captureScreenshot` 을 호출한다.
Phase 1 POC 에서 이 방식이 검증되었다. (`WEBDECK_PLAN.md` §9 원문 취지)

## 실측으로 확인한 것

Phase 6 이 자동화 하네스로 잰 것들이다. **전부 하네스 Chrome 에서 로컬 픽스처를 대상으로
난 값이다.** 일반 Chrome 과 실제 웹페이지에서 같은 값이 나온다고 보장하지 않는다.

```
1  서비스 워커는 attach 가 있으면 산다
   attach 2 · 캡처 없음 · 600초  ->  워커가 죽지 않았다
   attach 0 · 캡처 없음 · 600초  ->  600초 안에 죽었다
   캡처가 아니라 attach 가 워커를 붙든다

2  배경 탭의 페이지 타이머는 스로틀된다.  attach 는 그것을 억제하지 못한다
   100ms 주기 페이지가 배경에서 초당 0.9 회 안팎으로 돈다.  기대치는 10 이다
   붙인 탭도 마찬가지다.  캡처가 도는 동안 조금 올라갈 뿐이다
   즉 웹덱은 사용자 탭의 동작을 바꾸지 못한다.  페이지가 그린 것 이상을 가져올 수 없다

3  16타일 포화에서 굶는 타일이 생기지 않는다
   16타일에 주기 250ms 를 주면 수요가 초당 64회, 실현이 초당 26.6회다
   슬롯 점유율 99.6%.  타임아웃 0, 강등 0, 타일별 회차 폭 1회
   초과 수요가 16타일에 고르게 나뉜다
```

**주기를 자동으로 조절하는 기능은 없다.** 큐의 배압이 그 역할을 대신한다
(`docs/V1_DEVIATIONS.md` §11).

## 알려진 제한

### 지원 Chrome 버전

**하한을 정하지 않았다.** 실측은 `Chrome/151.0.7922.109` 와 `Chrome/151.0.7922.138`
두 빌드에서만 났다. 그보다 낮은 버전에서 어디까지 되는지 재지 않았으므로 숫자를 적지
않는다.

Manifest V3 서비스 워커와 `chrome.debugger` 를 쓴다. 확장을 CDP 로 심는 계측 하네스는
Chrome 137 이상을 요구한다 — 그 아래에서는 `--load-extension` 이 무시된다.

### DevTools 와의 충돌

같은 탭에 DevTools 가 열려 있으면 `chrome.debugger.attach` 가 거절될 것으로 보인다.
**확인하지 않았다.** 코드에 `DEVTOOLS_CONFLICT` 라는 분류가 있으나 지금은 도달하지 않는다 —
`onDetach` 의 reason 으로 DevTools 를 판별할 수 없다는 것이 실측으로 확인됐다
(`docs/LIMITATIONS.md` L25).

### 배경 탭의 화면 갱신

배경 탭의 페이지 타이머는 Chrome 이 스로틀한다. 웹덱이 attach 해도 그것을 억제하지
못한다. **미리보기가 실시간이 아니라 그 페이지가 그린 것을 따라간다.** 애니메이션이나
초 단위 갱신이 있는 페이지는 배경에서 느리게 보인다.

정지 화면인 배경 탭에서는 캡처 자체가 반환되지 않는 경우가 있다 (`L21`). 5초 타임아웃이
슬롯을 반납하고 그 사이사이에 성공 회차가 끼므로 **배지는 `LIVE` 그대로이고 타일 아래
줄의 시각만 멈춘다.** 실측 3회에서 타임아웃이 0 · 5 · 10 으로 갈렸고 `STALE` 로 간
회차는 없었다.

### Troubleshooting

```
타일이 DETACHED 로 굳었다
  워커가 죽었다 살아난 뒤일 수 있다.  프로젝트를 전환하면 복구된다
  워커 기동 이후에 새로 연 탭은 잡히지 않는다 (L45)
  그 탭을 그대로 쓰려면 툴바에서 탭을 고른 뒤 타일의 Bind Existing Tab 을 누른다
  Open Missing Tabs 는 붙지만 같은 URL 의 탭을 하나 더 만든다

미리보기가 안 바뀐다
  배경 탭 스로틀일 수 있다.  위의 "배경 탭의 화면 갱신" 을 본다
  Diagnostics 를 열어 타임아웃 수를 본다

chrome:// 탭이 RESTRICTED 로 나온다
  의도한 동작이다.  그 탭은 캡처하지 않는다 (L48)

디버깅 배너가 안 사라진다
  Pause 는 캡처를 멈출 뿐 attach 를 풀지 않는다.  배너는 남는다
  확장을 끄거나 타일을 지우면 사라진다
  계속 안 뜨게 하려면 --silent-debugger-extension-api 로 Chrome 을 띄운다
  「설치와 실행」의 디버깅 배너 끄기를 본다
```

## 문서

```
docs/LIMITATIONS.md      못 한 것과 모르는 것.  번호로 보존한다
docs/V1_DEVIATIONS.md    알고서 v1 과 다르게 한 것
docs/DECISIONS_P*.md     Phase 별 결정 레지스트리.  철회된 것도 지우지 않는다
docs/TEST_PLAN.md        시험이 덮는 것과 덮지 않는 것
docs/tasks/              작업 지시서와 실측 절차서
CHANGELOG.md             Phase 단위 변경 기록
```

**세 규칙이 이 문서들을 관통한다.**

```
실측하지 않은 것을 실측했다고 쓰지 않는다
추론으로 얻은 결론을 Chrome 실측 전에 단정하지 않는다
틀린 것을 지우지 않는다.  철회 표시를 붙이고 원문을 남긴다
```
