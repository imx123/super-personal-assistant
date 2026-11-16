/**
 * The console's entry point.
 *
 * It mounts the console into the page the control plane served and injects the stylesheet the bundle carries, so the
 * console loads exactly one file from its own origin and asks nothing of anybody else.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'
import styles from './console.css?raw'

const style = document.createElement('style')
style.textContent = styles
document.head.appendChild(style)

const root = document.getElementById('root')
if (!root) throw new Error('The console page has no root element')
createRoot(root).render(<StrictMode><App /></StrictMode>)
