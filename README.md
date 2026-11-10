# WebDeck

WebDeck은 Chrome 탭을 프로젝트 단위로 묶고 4×4 그리드에서 미리보는 Manifest V3 확장입니다. 타일을 더블클릭하면 해당 탭으로 전환합니다.

탭 목록과 프로젝트 상태에 `tabs`와 `storage` 권한을 사용합니다. 탭 미리보기를 캡처할 때 Chrome DevTools Protocol 연결에 `debugger` 권한을 사용합니다.

## 로컬 설치

```powershell
npm ci
npm run build
```

Chrome의 확장 프로그램 화면에서 개발자 모드를 켜고 `dist/`를 압축해제된 확장 프로그램으로 로드합니다.

`npm run typecheck`, `npm run lint`, `npm test`로 변경을 확인할 수 있습니다.

