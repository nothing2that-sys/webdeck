import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './theme.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('dashboard root element is missing')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
