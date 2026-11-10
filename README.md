# WebDeck

WebDeck은 Chrome 탭을 프로젝트 단위로 묶고 4×4 그리드에서 미리보는 Manifest V3 확장입니다. 타일을 더블클릭하면 해당 탭으로 전환합니다.

탭 목록과 프로젝트 상태에 `tabs`와 `storage` 권한을 사용합니다. 탭 미리보기를 캡처할 때 Chrome DevTools Protocol 연결에 `debugger` 권한을 사용합니다.

## 로컬 설치

```powershell
npm ci
npm run build
```

Chrome의 확장 프로그램 화면에서 개발자 모드를 켜고 `dist/`를 압축해제된 확장 프로그램으로 로드합니다.

## 프로젝트 만들고 탭 추가하기

1. Chrome 툴바에서 **WebDeck** 아이콘을 눌러 프로젝트 허브를 엽니다. **New**를 누르고 이름을 입력한 뒤 **Save**를 선택합니다.
2. 허브에서 만든 프로젝트를 열고, 탭 목록에서 기존 탭을 고른 뒤 **Add Tab**을 누릅니다. 주소를 직접 입력해 **Add URL**로 추가할 수도 있습니다.
3. 타일을 더블클릭하면 연결된 탭으로 전환합니다. 닫힌 탭을 프로젝트에서 다시 열려면 **Open Missing Tabs**를 사용합니다.

## 개발 확인

`npm run typecheck`, `npm run lint`, `npm test`로 변경을 확인할 수 있습니다.
