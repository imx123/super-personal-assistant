import { useState, type ReactElement } from 'react'
import type { ConsoleRuntimeSettings, RouterOptions } from '../shared/protocol.ts'
import type { DeploymentField, DeploymentScope, DeploymentView } from '../shared/deployment.ts'
import { messageOf, put, read, remove, type Overview } from './api.ts'
import { ActionLine, useAction, useLoaded, type PageProps } from './pages.tsx'
import { CONSOLE_PAGES, modelKey, readPreferences, savePreferences } from './preferences.ts'

interface RuntimeView {
  values: ConsoleRuntimeSettings
  startup: ConsoleRuntimeSettings
  schedulerOffsetMinutes: number
}

const SECTIONS = [
  ['settings-browser', '界面与连接'],
  ['settings-router', 'Router'],
  ['settings-runtime', '运行与调度'],
  ['settings-storage', '存储与诊断'],
  ['settings-deployment', '部署与凭据'],
] as const

const RUNTIME_FIELDS = [
  { key: 'schedulerTickMs', label: '定时任务检查间隔', unit: '毫秒',
    help: '例如，5000 表示每 5 秒检查一次。填 0 后只能手动运行定时任务，已经开始的任务会继续。' },
  { key: 'reconcileIntervalMs', label: '自动清理残留会话的间隔', unit: '毫秒',
    help: '定期检查已结束的任务或项目，停止并归档仍在运行的会话。填 0 后只能在「节点部署」页手动检查。' },
  { key: 'tokenRefreshGraceSeconds', label: '会话令牌过期宽限', unit: '秒',
    help: '会话令牌过期后，还能在这段时间内更新。填 0 后，令牌一旦过期就无法更新。浏览器的连接密钥单独管理。' },
] as const satisfies readonly { key: keyof ConsoleRuntimeSettings; label: string; unit: string; help: string }[]

const CONTROL_FIELDS = [
  {
    title: '控制面网络与凭据',
    items: [
      ['SUPERAGENT_CONTROL_HOST', '监听地址', '默认 127.0.0.1，仅本机访问。0.0.0.0 会监听所有网卡。'],
      ['SUPERAGENT_CONTROL_PORT', '监听端口', '0 由系统分配。重启后用新端口打开控制台，同时更新节点配置里的控制面地址。'],
      ['SUPERAGENT_CONTROL_TOKEN', '控制台连接密钥', '至少 16 个字符，只能用英文字母、数字和英文符号。等工作结束再更换密钥，重启后用新密钥连接。', 'password'],
      ['SUPERAGENT_CONTROL_VIEWER_TOKEN', '可选的只读密钥', '只允许读取运行数据。至少 16 个字符，只能用英文字母、数字和英文符号。', 'password'],
    ],
  },
  {
    title: '记忆与每日巡检',
    items: [
      ['SUPERAGENT_MEMORY_MAINTENANCE', '每日记忆巡检', 'on 或 off。填 off 后每日巡检不自动运行；巡检记录里会如实写明它被关掉了，不会写成已完成。'],
      ['SUPERAGENT_MEMORY_MAINTENANCE_AT', '每日记忆巡检时刻（UTC）', 'HH:MM，默认 03:00。控制面停机期间错过的时间窗不补跑，只跑当天这一格。'],
    ],
  },
  {
    title: '目录、数据库与日志保留',
    items: [
      ['SUPERAGENT_CONTROL_DB', '业务数据库', '项目、工单和会话的 SQLite 文件。填写绝对路径，切换路径会打开目标库，历史数据需自行迁移。'],
      ['SUPERAGENT_CONSOLE_DB', '控制台数据库', '保存事件、操作日志、定时任务和运行设置。填写独立的 SQLite 绝对路径。'],
      ['SUPERAGENT_CONSOLE_DIR', '控制台构建目录', '必须是包含 console.js 的绝对路径。'],
      ['SUPERAGENT_WORKSPACE_ROOT', '工作区根目录', '使用绝对路径，位于执行节点根目录内。已有会话需要先迁移。'],
      ['SUPERAGENT_CONSOLE_EVENT_ROWS', '事件保留条数', '至少保留 1 条。降低上限会清理更早的事件。'],
      ['SUPERAGENT_CONSOLE_EVENT_DAYS', '事件保留天数', '0 只按条数限制。降低天数会清理到期事件。'],
      ['SUPERAGENT_CONSOLE_AUDIT_DAYS', '操作日志保留天数', '0 表示长期保留。缩短保留时间会清理到期的操作日志。'],
      ['SUPERAGENT_SCHEDULER_OFFSET_MINUTES', '定时任务时区（UTC 偏移分钟数）', '北京时间填 480。修改后重启控制面生效，再到「定时任务」里重新保存已有的任务，它们的下次运行时间会按新时区重新计算。'],
    ],
  },
] as const

const NODE_FIELDS = [
  {
    title: '节点网络与身份',
    items: [
      ['SUPERAGENT_NODE_URL', '节点访问地址', '控制面访问节点的 HTTP(S) 地址。端口变更时一并更新。'],
      ['SUPERAGENT_CONTROL_URL', '控制面地址（供节点使用）', 'Router、PM 和 Worker 的工具请求发到此地址。'],
      ['SUPERAGENT_NODE_HOST', '节点监听地址', '默认 127.0.0.1。控制面和节点在不同机器时，填写节点机器上的监听地址。'],
      ['SUPERAGENT_NODE_PORT', '节点监听端口', '填 0 由系统分配端口。填写固定端口时，也要更新上面的节点访问地址。'],
      ['SUPERAGENT_NODE_ID', '节点标识', '两端使用同一标识。已有会话需要先迁移。'],
      ['SUPERAGENT_NODE_ROOT', '节点根目录', '节点允许创建会话的绝对路径。已有会话需要先迁移。'],
      ['SUPERAGENT_NODE_TOKEN', '节点连接密钥', '控制面和节点共用一个密钥。至少 16 个字符，只能用英文字母、数字和英文符号。更换后先重启节点，再重启控制面。', 'password'],
    ],
  },
  {
    title: '节点默认模型',
    items: [
      ['SUPERAGENT_NODE_MODEL_PROVIDER', '默认供应商 ID', '填写该节点 DSH 已配置的供应商。供应商密钥继续由 DSH 管理。'],
      ['SUPERAGENT_NODE_MODEL', '默认模型 ID', '用于还没选定模型的会话。清空供应商、模型和推理强度后，使用 DSH 配置里的默认值。'],
      ['SUPERAGENT_NODE_REASONING_EFFORT', '默认推理强度', '选填，填写该模型接受的值，例如 high。'],
    ],
  },
] as const

interface DeploymentGroup {
  title: string
  items: readonly (readonly [DeploymentField, string, string, 'password'?])[]
}

export function SettingsPage(props: PageProps): ReactElement {
  const overview = useLoaded(() => read<Overview>('/v1/overview'), props.revision)
  const data = overview.data
  return (
    <div className="settings-layout">
      <nav className="panel settings-index" aria-label="设置分类">
        {SECTIONS.map(([id, title]) => <button key={id} type="button"
          onClick={() => document.getElementById(id)?.scrollIntoView({ block: 'start' })}>{title}</button>)}
      </nav>
      <div className="settings-content">
        <BrowserSettings signOut={props.signOut} />
        <RuntimeSettings refresh={props.refresh} />
        <section className="panel padded settings-section" id="settings-storage">
          <h2>存储与诊断</h2>
          {overview.error ? <p className="notice failure">{overview.error}</p> : null}
          <dl className="settings-facts">
            <div><dt>事件序号</dt><dd>{data?.events.seq ?? '—'}</dd></div>
            <div><dt>保留的事件条数</dt><dd>{data?.events.retained ?? '—'}</dd></div>
            <div><dt>操作日志条数</dt><dd>{data?.audit?.entries ?? '—'}</dd></div>
            <div><dt>事件保留</dt><dd>{data?.retention
              ? `${data.retention.eventRows} 条${data.retention.eventDays ? ` / ${data.retention.eventDays} 天` : ''}` : '—'}</dd></div>
            <div><dt>操作日志保留</dt><dd>{data?.retention ? (data.retention.auditDays || '长期') + (data.retention.auditDays ? ' 天' : '') : '—'}</dd></div>
          </dl>
          <p className="settings-description">在部署与凭据中更改保留上限。降低上限会清理超过限制的历史记录。</p>
        </section>
        <section className="panel padded settings-section" id="settings-deployment">
          <h2>部署与凭据</h2>
          <p className="settings-description">保存后，重启相应的进程即可生效。更换地址或密钥前，等正在运行的工作结束，并记下新地址或新密钥。</p>
          <DeploymentSettings scope="control" groups={CONTROL_FIELDS} />
          <DeploymentSettings scope="node" groups={NODE_FIELDS} />
          <p className="settings-description">DSH 的数据目录和 Agent 配置目录由节点启动器设置。模型供应商的 API 密钥在 DSH 中管理。</p>
        </section>
      </div>
    </div>
  )
}

function DeploymentSettings(props: { scope: DeploymentScope; groups: readonly DeploymentGroup[] }): ReactElement {
  const endpoint = `/v1/console/deployment/${props.scope}`
  const [reload, setReload] = useState(0)
  const loaded = useLoaded(() => read<DeploymentView>(endpoint), reload)
  const [saved, setSaved] = useState<DeploymentView>()
  const [draft, setDraft] = useState<DeploymentView['values']>({})
  const [disableViewer, setDisableViewer] = useState(false)
  const action = useAction()
  const current = saved ?? loaded.data
  const isNode = props.scope === 'node'
  const target = isNode ? '执行节点' : '控制面'
  const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) =>
    value !== (current?.values[key as DeploymentField] ?? '')))
  if (disableViewer) changes.SUPERAGENT_CONTROL_VIEWER_TOKEN = ''

  return <details className="settings-env">
    <summary>{target}配置{current?.pending.length ? ' · 待重启' : ''}</summary>
    {loaded.error ? <p role="status" className="notice failure">{loaded.error}</p> : null}
    {!current && !loaded.error ? <p className="settings-description">正在读取部署配置…</p> : null}
    {current ? <form onSubmit={event => {
      event.preventDefault()
      if (!Object.keys(changes).length || action.state.busy) return
      action.run(async () => {
        setSaved(await put<DeploymentView>(endpoint, { revision: current.revision, changes }))
        setDraft({})
        setDisableViewer(false)
      }, isNode ? '已保存。涉及两端的改动，请先重启节点，再重启控制面。' : '已保存。重启控制面后生效。')
    }}>
      <p className="settings-description settings-file">配置文件 <code>{current.file}</code></p>
      {isNode ? <p className="settings-description">请在节点启动器中将 <code>SUPERAGENT_NODE_DEPLOYMENT_FILE</code> 设为上面的文件路径。
        {current.sharedNodeFile ? '控制面已配置此路径，请核对节点端的设置。' : '控制面目前使用默认路径。'}</p> : null}
      {props.groups.map(group => <div key={group.title} className="deployment-group">
        <h3>{group.title}</h3>
        {group.items.map(([key, label, help, type = 'text']) => {
          const id = `deployment-${key}`
          const secret = type === 'password'
          const viewer = key === 'SUPERAGENT_CONTROL_VIEWER_TOKEN'
          return <div className="settings-row" key={key}>
            <div><label htmlFor={id}>{label}</label>{current.pending.includes(key) ? <span className="settings-pending">待重启</span> : null}
              <p id={`${id}-help`}>{help}</p></div>
            <div className="deployment-input">
              <input id={id} name={id} type={type} autoComplete={secret ? 'new-password' : 'off'} spellCheck={false}
                aria-describedby={`${id}-help`} disabled={action.state.busy || (viewer && disableViewer)}
                placeholder={secret ? (current.credentials[key] ? '已设置，留空保持原值' : '未设置') : undefined}
                value={draft[key] ?? current.values[key] ?? ''}
                onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))} />
              {viewer && current.credentials[key] ? <label className="deployment-disable">
                <input type="checkbox" checked={disableViewer} disabled={action.state.busy}
                  onChange={event => setDisableViewer(event.target.checked)} />移除只读密钥</label> : null}
            </div>
          </div>
        })}
      </div>)}
      <div className="detail-actions">
        <button type="submit" className="action primary" disabled={action.state.busy || !Object.keys(changes).length}>
          保存{target}配置</button>
        <button type="button" className="action" disabled={action.state.busy} onClick={() => {
          setSaved(undefined)
          setDraft({})
          setDisableViewer(false)
          setReload(value => value + 1)
        }}>重新读取</button>
      </div>
      <ActionLine state={action.state} />
    </form> : null}
  </details>
}

function BrowserSettings(props: { signOut: () => void }): ReactElement {
  const [preferences, setPreferences] = useState(readPreferences)
  const [feedback, setFeedback] = useState<{ group: 'browser' | 'router'; error: boolean; text: string }>()
  const options = useLoaded(() => read<RouterOptions>('/v1/console/router/options'), 0)
  const models = options.data?.models ?? []
  const selected = preferences.routerModel && modelKey(preferences.routerModel)
  const configured = selected && models.some(model => modelKey(model) === selected)

  const save = (group: 'browser' | 'router'): void => {
    const persisted = readPreferences()
    const { routerModel: previousModel, ...browser } = persisted
    try {
      savePreferences(group === 'browser'
        ? { startPage: preferences.startPage, enterToSend: preferences.enterToSend,
          ...(previousModel ? { routerModel: previousModel } : {}) }
        : { ...browser, ...(preferences.routerModel ? { routerModel: preferences.routerModel } : {}) })
      setFeedback({ group, error: false, text: '已保存到当前浏览器' })
    } catch (error) {
      setFeedback({ group, error: true, text: `无法保存偏好：${messageOf(error)}` })
    }
  }
  const update = (next: typeof preferences): void => {
    setPreferences(next)
    setFeedback(undefined)
  }
  const result = feedback ? <p role="status" className={`notice ${feedback.error ? 'failure' : 'success'}`}>{feedback.text}</p> : null
  return (
    <>
      <section className="panel padded settings-section" id="settings-browser">
        <h2>界面与连接</h2>
        <div className="settings-row">
          <div><label htmlFor="settings-start-page">默认打开页面</label>
            <p id="settings-start-help">打开控制台时生效。打开包含页面地址的链接时，会直接进入该页面。</p></div>
          <select id="settings-start-page" value={preferences.startPage} aria-describedby="settings-start-help"
            onChange={event => update({ ...preferences, startPage: event.target.value as typeof preferences.startPage })}>
            {Object.entries(CONSOLE_PAGES).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select>
        </div>
        <div className="settings-row">
          <div><label htmlFor="settings-enter-send">按 Enter 发送消息</label>
            <p id="settings-enter-help">适用于 Router、PM 和 Worker 的对话。关闭后按 Enter 换行，点发送按钮发出消息。</p></div>
          <input type="checkbox" id="settings-enter-send" checked={preferences.enterToSend} aria-describedby="settings-enter-help"
            onChange={event => update({ ...preferences, enterToSend: event.target.checked })} />
        </div>
        <div className="settings-row">
          <div><b>当前标签页的连接</b><p>刷新时自动恢复。断开会清除这个标签页保存的连接密钥。</p></div>
          <button type="button" className="action" onClick={props.signOut}>断开连接</button>
        </div>
        <button type="button" className="action primary" onClick={() => save('browser')}>保存浏览器偏好</button>
        {feedback?.group === 'browser' ? result : null}
      </section>
      <section className="panel padded settings-section" id="settings-router">
        <h2>Router</h2>
        <div className="settings-row">
          <div><label htmlFor="settings-router-model">首选模型</label>
            <p id="settings-model-help">浏览器会记住你的选择。聊天框里也可以为下一条消息另选模型。</p></div>
          <select id="settings-router-model" value={selected ?? ''} aria-describedby="settings-model-help"
            disabled={!options.data && !options.error}
            onChange={event => {
              const model = models.find(item => modelKey(item) === event.target.value)
              const { routerModel: _old, ...rest } = preferences
              update(model ? { ...rest, routerModel: { provider: model.provider, model: model.model } } : rest)
            }}>
            <option value="">沿用 Router 当前模型</option>
            {selected && !configured ? <option value={selected}>{preferences.routerModel?.model}（当前不可用）</option> : null}
            {models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.name} ({model.provider})</option>)}
          </select>
        </div>
        {options.error || (options.data && models.length === 0)
          ? <p className="settings-description">暂时无法获取节点上的模型列表。</p> : null}
        <button type="button" className="action primary" onClick={() => save('router')}>保存 Router 偏好</button>
        {feedback?.group === 'router' ? result : null}
      </section>
    </>
  )
}

function RuntimeSettings(props: { refresh: () => void }): ReactElement {
  const endpoint = '/v1/console/settings'
  const loaded = useLoaded(() => read<RuntimeView>(endpoint), 0)
  const [saved, setSaved] = useState<RuntimeView>()
  const [draft, setDraft] = useState<Partial<Record<keyof ConsoleRuntimeSettings, string>>>({})
  const action = useAction(props.refresh)
  const current = saved ?? loaded.data

  return (
    <section className="panel padded settings-section" id="settings-runtime">
      <h2>运行与调度</h2>
      <p className="settings-description">保存后立即生效。点「恢复启动设置」可恢复本次启动时的值。</p>
      {loaded.error ? <p className="notice failure">{loaded.error}</p> : null}
      {!current && !loaded.error ? <p className="settings-description">正在读取运行设置…</p> : null}
      {current ? <form onSubmit={event => {
        event.preventDefault()
        const next = { ...current.values }
        for (const { key } of RUNTIME_FIELDS) if (draft[key] !== undefined) next[key] = Number(draft[key])
        action.run(async () => {
          setSaved(await put<RuntimeView>(endpoint, next))
          setDraft({})
        }, '已保存，设置立即生效')
      }}>
        {RUNTIME_FIELDS.map(({ key, label, unit, help }) => <div className="settings-row" key={key}>
          <div><label htmlFor={`settings-${key}`}>{label}</label><p id={`settings-${key}-help`}>{help}</p></div>
          <div className="settings-number">
            <input id={`settings-${key}`} type="number" min="0" step="1" required
              max={unit === '毫秒' ? 2_147_483_647 : Number.MAX_SAFE_INTEGER}
              aria-describedby={`settings-${key}-help`} disabled={action.state.busy}
              value={draft[key] ?? current.values[key]} onChange={event =>
                setDraft(value => ({ ...value, [key]: event.target.value }))} />
            <span>{unit}</span>
          </div>
        </div>)}
        <div className="settings-row">
          <div><b>定时任务时区</b><p>在「部署与凭据」中修改，重启控制面后生效。改完后到「定时任务」里重新保存已有的任务，它们会按新时区重新计算下次运行时间。</p></div>
          <span>UTC 偏移 {current.schedulerOffsetMinutes} 分钟</span>
        </div>
        <div className="detail-actions">
          <button type="submit" className="action primary"
            disabled={action.state.busy || Object.keys(draft).length === 0}>保存运行设置</button>
          <button type="button" className="action" disabled={action.state.busy} onClick={() => action.run(async () => {
            setSaved(await remove<RuntimeView>(endpoint))
            setDraft({})
          }, '已恢复本次启动时的设置')}>恢复启动设置</button>
        </div>
        <ActionLine state={action.state} />
      </form> : null}
    </section>
  )
}
