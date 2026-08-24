import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HUB_PAGE, PROJECT_PARAM } from '../shared/messages'
import { App } from './App'
import { connectLifetimePort } from './dashboardService'
import './theme.css'

//+_+// P8-D18. URL 은 여기서 읽는다. App 안에서 읽지 않는다. 그쪽이 브라우저 전역에 묶이면 시험이 어렵다
const projectId = new URLSearchParams(window.location.search).get(PROJECT_PARAM)

//+_+// 파라미터가 없으면 React 를 띄우지 않고 허브로 보낸다. 포트도 열지 않는다
//+_+// base 가 './' 이므로 상대 경로가 확장 스킴에서 그대로 선다. chrome.runtime.getURL 을 부르지 않는다
//+_+// 모르는 id 는 여기서 판정할 수 없다. 첫 폴링의 PROJECT_NOT_FOUND 가 App 에서 허브로 보낸다
if (projectId === null || projectId.length === 0) {
  window.location.replace(`./${HUB_PAGE}`)
} else {
  const container = document.getElementById('root')
  if (container === null) {
    throw new Error('dashboard root element is missing')
  }

  //+_+// TASK-P8-05 §1.3. 모듈 최상위가 문서 수명과 같은 층이다. harness/p3/main.ts 와 같은 자리다
  //+_+// App 의 useEffect 에 두지 않는다. poll 의 deps 가 바뀌면 정리되고 StrictMode 가 두 번 돈다
  connectLifetimePort()

  createRoot(container).render(
    <StrictMode>
      <App projectId={projectId} />
    </StrictMode>,
  )
}
