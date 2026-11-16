import type { RouterModel } from '../shared/protocol.ts'

export const CONSOLE_PAGES = {
  home: '控制面',
  projects: '项目',
  sessions: 'PM / Worker 会话',
  schedules: '定时任务',
  nodes: '节点部署',
  settings: '设置',
} as const

export interface ConsolePreferences {
  startPage: keyof typeof CONSOLE_PAGES
  enterToSend: boolean
  routerModel?: RouterModel
}

const STORAGE_KEY = 'superagent.console.preferences'
const SIDEBAR_KEY = 'superagent.console.sidebar-collapsed'

export function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === 'true' } catch { return false }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(SIDEBAR_KEY, String(collapsed)) } catch { /* The current page still updates. */ }
}

export function readPreferences(): ConsolePreferences {
  const defaults: ConsolePreferences = { startPage: 'home', enterToSend: true }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const data = JSON.parse(raw) as Partial<ConsolePreferences>
    const model = data.routerModel
    return {
      startPage: data.startPage && Object.hasOwn(CONSOLE_PAGES, data.startPage) ? data.startPage : defaults.startPage,
      enterToSend: typeof data.enterToSend === 'boolean' ? data.enterToSend : defaults.enterToSend,
      ...(typeof model?.provider === 'string' && typeof model.model === 'string' ? { routerModel: model } : {}),
    }
  } catch {
    return defaults
  }
}

export function savePreferences(preferences: ConsolePreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}

export function modelKey(model: RouterModel): string {
  return JSON.stringify([model.provider, model.model])
}
