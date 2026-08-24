import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Hub } from './Hub'
import './theme.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('hub root element is missing')
}

//+_+// P8-D17. connectLifetimePort 를 부르지 않는다. 허브는 임차를 만들지 않는 화면이다
//+_+// main.tsx 의 그 호출을 복사하지 않는다. 포트가 열리면 등록이 0 인 조건이 깨진다
createRoot(container).render(
  <StrictMode>
    <Hub />
  </StrictMode>,
)
