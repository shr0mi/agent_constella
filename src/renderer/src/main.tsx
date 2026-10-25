import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { App } from './App'
import '@xyflow/react/dist/style.css'
import './styles.css'
import './projects.css'
import './catalogs.css'
import './graphs.css'
import './nodes.css'
import './workflows.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
