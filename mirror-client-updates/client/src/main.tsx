import { createRoot } from 'react-dom/client'
import {BrowserRouter} from 'react-router-dom'

import './index.css'
import './styles/glass.css';
import './styles/chat-glass.css';

import App from './App.tsx'
import { initPWA } from './pwa'
import { installIOSResizeBridge } from './utils/iosResizeBridge'

createRoot(document.getElementById('root')!).render(
     <BrowserRouter basename="/Mirror">
         <App />
     </BrowserRouter>,
)

initPWA()
installIOSResizeBridge()
