import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { connectLifetimePort } from './dashboardService'
import './theme.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('dashboard root element is missing')
}

//+_+// TASK-P8-05 §1.3. 모듈 최상위가 문서 수명과 같은 층이다. harness/p3/main.ts 와 같은 자리다
//+_+// App 의 useEffect 에 두지 않는다. poll 의 deps 가 바뀌면 정리되고 StrictMode 가 두 번 돈다
connectLifetimePort()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
