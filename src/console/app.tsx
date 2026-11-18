/**
 * The console's shell: the left menu, the page it shows, and the key the browser holds.
 *
 * The browser restores its tab's connection on reload.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { clearConsoleKey, connectConsole, consoleKey, CONSOLE_KEY_REJECTED, followEvents, messageOf, read,
  type Overview, type StreamStatus } from './api.ts'
import { Icon } from './icons.tsx'
import { MemoryPage } from './memory.tsx'
import { HomePage, NodesPage, ProjectsPage, SchedulesPage, SessionsPage, type PageProps } from './pages.tsx'
import { readPreferences, readSidebarCollapsed, saveSidebarCollapsed } from './preferences.ts'
import { SettingsPage } from './settings.tsx'

/** The pages of the console, in the order of the left menu. */
const PAGES = [
  { key: 'home', label: '控制面', icon: 'home', crumb: '控制面', title: '今天的工作' },
  { key: 'projects', label: '项目', icon: 'project', crumb: '项目', title: '项目' },
  { key: 'sessions', label: 'PM / Worker 会话', icon: 'chat', crumb: 'PM / Worker 会话', title: '执行会话' },
  { key: 'schedules', label: '定时任务', icon: 'clock', crumb: '定时任务', title: '定时任务' },
  { key: 'memory', label: '记忆', icon: 'memory', crumb: '记忆', title: '记忆' },
  { key: 'nodes', label: '节点部署', icon: 'node', crumb: '节点部署', title: '节点部署' },
  { key: 'settings', label: '设置', icon: 'settings', crumb: '设置', title: '设置' },
] as const

/** The page the address bar names, or the home page. */
function readPage(): string {
  const hash = window.location.hash.replace(/^#\/?/, '')
  return PAGES.some(page => page.key === hash) ? hash : readPreferences().startPage
}

/** The console itself. */
export function App(): ReactElement {
  const [key, setKey] = useState(consoleKey)
  const [connectionIssue, setConnectionIssue] = useState('')
  const [page, setPage] = useState(readPage())
  const [revision, setRevision] = useState(0)
  const [stream, setStream] = useState<StreamStatus>('reconnecting')
  const [gap, setGap] = useState(false)
  const [menu, setMenu] = useState(false)
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed)
  const main = useRef<HTMLElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const drawerCloseButton = useRef<HTMLButtonElement>(null)
  const [overview, setOverview] = useState<Overview | undefined>(undefined)
  const [streamFrom, setStreamFrom] = useState<number | undefined>(undefined)
  /** What the page should show first: `failed` leads to the scheduled tasks whose last run failed. */
  const [focus, setFocus] = useState('')
  const timer = useRef<number | undefined>(undefined)

  const signOut = useCallback((): void => {
    clearConsoleKey()
    setKey('')
    setOverview(undefined)
    setStreamFrom(undefined)
    setStream('reconnecting')
    setGap(false)
  }, [])

  useEffect(() => {
    const onRejected = (): void => {
      signOut()
      setConnectionIssue('连接密钥已失效，请重新连接。')
    }
    window.addEventListener(CONSOLE_KEY_REJECTED, onRejected)
    return () => window.removeEventListener(CONSOLE_KEY_REJECTED, onRejected)
  }, [signOut])

  useEffect(() => {
    const onHash = (): void => setPage(readPage())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useLayoutEffect(() => {
    if (main.current) main.current.scrollTop = 0
  }, [page])

  useLayoutEffect(() => {
    if (menu) drawerCloseButton.current?.focus()
  }, [menu])

  const closeMenu = (): void => {
    setMenu(false)
    menuButton.current?.focus()
  }

  // The control plane's own facts: the node's liveness and the counts the menu shows.
  useEffect(() => {
    if (!key) return
    let cancelled = false
    read<Overview>('/v1/overview').then(value => {
      if (!cancelled) setOverview(value)
    }).catch(() => {
      // A failed read leaves the last facts on screen; the next event tries again.
    })
    return () => { cancelled = true }
  }, [revision, key])

  // The sequence the console already knows, read once when it connects: the stream then carries only what follows it,
  // and nothing that happened in between is missed.
  useEffect(() => {
    if (!key) return
    let cancelled = false
    read<Overview>('/v1/overview').then(value => {
      if (!cancelled) setStreamFrom(value.events.seq)
    }).catch(() => {
      // Without the sequence the stream starts from the beginning, which is slower but never wrong.
      if (!cancelled) setStreamFrom(0)
    })
    return () => { cancelled = true }
  }, [key])

  // The event stream keeps the page honest: every recorded fact triggers a new read.
  useEffect(() => {
    if (!key || streamFrom === undefined) return
    const bump = (): void => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => { setRevision(value => value + 1) }, 250)
    }
    const stop = followEvents('/v1/events/stream', {
      from: streamFrom,
      onEvent: bump,
      onStatus: setStream,
      onGap: () => setGap(true),
    })
    return () => {
      stop()
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    }
  }, [key, streamFrom])

  const navigate = (next: string, where?: string): void => {
    window.location.hash = `#/${next}`
    setPage(next)
    // The place a cell points at is remembered for the page it leads to, and dropped by any other navigation.
    setFocus(where ?? '')
    setMenu(false)
  }

  if (!key) return <SignIn notice={connectionIssue} onSignedIn={value => {
    setConnectionIssue('')
    setKey(value)
  }} />

  const current = PAGES.find(item => item.key === page) ?? PAGES[0]
  const online = overview?.nodes[0]?.online
  const nodeStatus = online === undefined ? 'DSH 节点状态未知' : online ? 'DSH 节点在线' : 'DSH 节点离线'
  const sidebarAction = collapsed ? '展开侧边栏' : '收起侧边栏'
  // An action the console carried out reads the page's facts again by itself: not every action leaves an event behind,
  // and a page that waited for the next one would show a state that is already out of date.
  const refresh = (): void => setRevision(value => value + 1)
  const pageProps: PageProps = { revision, refresh, navigate, signOut, focus, overview, stream }

  return (
    <div className="app" data-sidebar-collapsed={collapsed} onKeyDown={event => {
      if (menu && event.key === 'Escape') closeMenu()
    }}>
      <aside className="side" id="side" data-open={menu} aria-label="控制台导航">
        <div className="side-heading">
          <div className="brand"><span className="brand-mark"><Icon name="router" /></span><span className="brand-name">Superagent</span></div>
          <button type="button" className="sidebar-toggle" aria-label={sidebarAction} title={sidebarAction}
            aria-controls="side-navigation" aria-expanded={!collapsed} onClick={() => {
              saveSidebarCollapsed(!collapsed)
              setCollapsed(!collapsed)
            }}><Icon name={collapsed ? 'sidebarOpen' : 'sidebarClose'} /></button>
          <button type="button" className="drawer-close" ref={drawerCloseButton} aria-label="关闭菜单" onClick={closeMenu}><Icon name="fail" /></button>
        </div>
        <nav className="nav" id="side-navigation">
          {PAGES.map(item => (
            <button key={item.key} type="button" aria-current={item.key === page ? 'page' : undefined}
              aria-label={item.label} title={collapsed ? item.label : undefined}
              onClick={() => navigate(item.key)}>
              <Icon name={item.icon} /><span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className={`side-status${online === undefined ? ' unknown' : online ? '' : ' offline'}`} title={collapsed ? nodeStatus : undefined}>
          <span className="dot" />
          <span className="side-status-label">{nodeStatus}</span>
        </div>
      </aside>
      <button type="button" id="scrim" className="scrim" aria-label="关闭菜单" hidden={!menu}
        onClick={closeMenu} />
      <main className="main" ref={main}>
        <div className="top">
          <button type="button" className="action menu" ref={menuButton} aria-label="打开菜单" aria-controls="side"
            aria-expanded={menu} onClick={() => setMenu(value => !value)}>
            <Icon name="menu" />
          </button>
          <span className="crumb">{current.crumb}</span>
          <span className="is-demo">
            {stream === 'connected' ? '实时连接' : '重连中'}
            {gap ? ' · 部分历史事件已过期' : ''}
          </span>
        </div>
        <h1 className="page-title">{current.title}</h1>
        {page === 'home' ? <HomePage {...pageProps} />
          : page === 'projects' ? <ProjectsPage {...pageProps} />
            : page === 'sessions' ? <SessionsPage {...pageProps} />
              : page === 'schedules' ? <SchedulesPage {...pageProps} />
                : page === 'memory' ? <MemoryPage {...pageProps} />
                  : page === 'nodes' ? <NodesPage {...pageProps} />
                    : <SettingsPage {...pageProps} />}
      </main>
    </div>
  )
}

/** The sign-in: the console asks for the control-plane key and checks it before it keeps it. */
function SignIn(props: { notice: string; onSignedIn: (key: string) => void }): ReactElement {
  const [value, setValue] = useState('')
  const [error, setError] = useState(props.notice)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const key = value.trim()
    if (key === '') {
      setError('请输入控制面的连接密钥。')
      return
    }
    setBusy(true)
    try {
      await connectConsole(key)
      setError('')
      props.onSignedIn(key)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="signin">
      <form onSubmit={event => { void submit(event) }}>
        <h1>Superagent 控制台</h1>
        <p>输入控制面的连接密钥。部署时可用 <code>SUPERAGENT_CONTROL_TOKEN</code> 设置。</p>
        <label htmlFor="control-key">连接密钥</label>
        <input id="control-key" type="password" autoComplete="off" value={value} autoFocus
          onChange={event => setValue(event.target.value)} />
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" className="action primary" disabled={busy}>连接</button>
        <p className="status-note">
          当前标签页会记住连接，刷新时自动恢复。
        </p>
      </form>
    </div>
  )
}
