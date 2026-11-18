/**
 * The console's memory page: what the control plane can see now, and what it cannot.
 *
 * The page has three sibling domains — the live state, the event history and the long-term memory — and it names each of
 * them as it really is. The header says when the facts were read and whether the event stream is still carrying what
 * follows. The live state is a snapshot the control plane read at a known moment, and the node states in it are the
 * control plane's own words: a machine it has never heard of is unknown, not offline. The event history is what the control
 * plane's own files hold today: the Projects and Tickets of the business store, and the console's own short-lived log,
 * which is named as short-lived and never as a history that can be read back in full. The long-term memory is not there
 * yet, so the page says so and points at the manual Project notes that are.
 *
 * Nothing here writes. The page reads the control plane's own API with the key the console already holds, and it never
 * fills a gap with an example: a number the control plane did not report is not shown at all, and a read that has not
 * answered yet is shown as waiting rather than as empty.
 *
 * The wiring place for the rest of Phase 5 is the three panels below. Each one takes its facts as props, so the live
 * snapshots of P5-1, the durable history index of P5-2 and the memory service of P5-3 to P5-5 fill the same three places
 * without the page changing shape.
 */
import { useState, type ReactElement } from 'react'
import { read, type ConsoleProject, type Overview, type StreamStatus } from './api.ts'
import { stampOf, useLoaded, type PageProps } from './pages.tsx'

/** How many of the newest console events the history panel shows. */
const EVENT_TAIL = 12

/** One row of the console's own event log, as the page reads it. */
interface ConsoleEventLine {
  seq: number
  at: string
  type: string
  kind?: string
  sessionId: string
  nodeId: string
  projectId?: string
}

/** What the control plane's event log answers: the rows after a sequence, and whether a hole is in front of them. */
interface ConsoleEventPage {
  events: ConsoleEventLine[]
  gap?: boolean
}

/** The rows of one window of the console's own log, with the window they belong to. */
interface EventWindow {
  /** The sequence the rows start after; an answer of another window is not this one. */
  after: number
  /** The rows themselves. */
  events: ConsoleEventLine[]
  /** Whether the control plane said there is a hole in front of them. */
  gap: boolean
}

/**
 * What the history panel knows about a list it asked for.
 *
 * `pending` is a read that has not answered yet, `unavailable` is a read that could not even be started, `error` is a
 * read that failed and `ready` is an answer. An answer with no rows is `ready` and empty: the panel never shows a list that
 * has not arrived as an empty list.
 */
type ListState = 'pending' | 'unavailable' | 'error' | 'ready'

/** One list of the history, with what the read about it came back with. */
interface ListFacts<T> {
  /** What the read did. */
  state: ListState
  /** The rows it answered with, when it answered. */
  rows?: T[]
  /** Why the read failed, when it failed. */
  error?: string
}

/** The three domains of the memory system, in the order a person reads them. */
const DOMAINS = [
  { key: 'live', label: '实时状态' },
  { key: 'history', label: '事件历史' },
  { key: 'longterm', label: '长期记忆' },
] as const

type DomainKey = (typeof DOMAINS)[number]['key']

/** How the console's own event kinds read. */
const EVENT_KIND: Record<string, string> = {
  message: '会话消息',
  'turn-start': '回合开始',
  'turn-end': '回合结束',
  error: '错误',
  usage: '用量',
  'guard.denial': '权限拒绝',
}

/** How a Project's status reads. */
const PROJECT_STATUS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  ended: '已结束',
  archived: '已归档',
}

/** Whether the event stream that carries the control plane's new facts is connected right now. */
function streamWording(stream: StreamStatus | undefined): string {
  if (stream === 'connected') return '事件流已连接'
  if (stream === 'reconnecting') return '事件流重连中，数字可能不是最新'
  return '事件流状态未知'
}

/** How the console's own event log says how much of it is left. */
function retentionText(retention: Overview['retention'], retained: number): string {
  const age = retention.eventDays > 0 ? ` / ${retention.eventDays} 天` : '（不限天数）'
  return `控制台日志最多保留 ${retention.eventRows} 行${age}，控制面现在保留 ${retained} 行。`
}

/** How the console's own audit trail says how long it keeps. */
function auditText(retention: Overview['retention'] | undefined): string {
  if (retention === undefined) return '操作审计（控制面首页的「近期动向」）的保留规则未知。'
  const keep = retention.auditDays > 0 ? `保留 ${retention.auditDays} 天` : '永久保留，不按天数裁剪'
  return `操作审计（控制面首页的「近期动向」）${keep}。`
}

/**
 * The page's header: when the facts were read, and whether the stream is still carrying what follows.
 *
 * The status may shrink and wrap on a narrow screen; the refresh action never does, so the button keeps its words on one
 * line instead of breaking into two.
 */
export function MemoryHead(props: {
  overview?: Overview
  stream?: StreamStatus
  refresh: () => void
}): ReactElement {
  const at = props.overview === undefined ? '—' : stampOf(props.overview.at)
  return (
    <div className="memory-head">
      <span className="quiet memory-status">{`读取时间 ${at} · ${streamWording(props.stream)}`}</span>
      <button type="button" className="action" onClick={props.refresh}>刷新</button>
    </div>
  )
}

/**
 * The memory page.
 *
 * The live facts are the ones the shell already read, so the page does not ask the control plane a second time. The two
 * lists the history domain shows are read by the history domain itself, when a person opens it.
 */
export function MemoryPage(props: PageProps): ReactElement {
  const [domain, setDomain] = useState<DomainKey>('live')
  return (
    <div className="panel padded">
      <MemoryHead overview={props.overview} stream={props.stream} refresh={props.refresh} />
      <div className="memory-tabs" role="group" aria-label="记忆的三个域">
        {DOMAINS.map(item => (
          <button key={item.key} type="button" aria-pressed={domain === item.key}
            aria-controls={domain === item.key ? `memory-domain-${item.key}` : undefined}
            onClick={() => setDomain(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      {domain === 'live'
        ? <LiveStatePanel overview={props.overview} navigate={props.navigate} />
        : domain === 'history'
          ? <HistoryLoader revision={props.revision} overview={props.overview}
            onOpenProject={(id) => props.navigate('projects', id)} />
          : <LongTermMemoryPanel onOpenProjects={() => props.navigate('projects')} />}
    </div>
  )
}

/**
 * The live state: the control plane's own snapshot, read at a known moment.
 *
 * A node that never registered is not an offline node: the page says the state is unknown rather than showing a red chip
 * for a machine it has never heard of.
 */
export function LiveStatePanel(props: {
  overview?: Overview
  navigate: (page: string, where?: string) => void
}): ReactElement {
  const overview = props.overview
  if (overview === undefined) {
    return (
      <section id="memory-domain-live" className="memory-domain" aria-labelledby="memory-live-heading">
        <h2 id="memory-live-heading">实时状态</h2>
        <p className="empty">尚未读到控制面概况。</p>
      </section>
    )
  }
  const nodes = overview.nodes
  return (
    <section id="memory-domain-live" className="memory-domain" aria-labelledby="memory-live-heading">
      <h2 id="memory-live-heading">实时状态</h2>
      <p className="quiet">
        实时状态是此刻的控制面快照，不是记录。它不写入任何长期存储，也不触发模型。
      </p>

      <h3>执行节点</h3>
      {nodes.length === 0
        ? <p className="empty">控制面还没有登记任何节点，节点状态未知。</p>
        : nodes.map(node => (
          <dl className="detail-list" key={node.nodeId}>
            <div><dt>节点</dt><dd>{node.nodeId} · {node.backend} {node.version}</dd></div>
            <div><dt>连接状态</dt><dd>
              <span className={`chip ${node.online ? 'success' : 'failure'}`}>{node.online ? '在线' : '离线'}</span>
            </dd></div>
            <div><dt>最后心跳</dt><dd>{stampOf(node.at)}</dd></div>
            <div><dt>能力</dt><dd>{node.capabilities?.length ? node.capabilities.join('、') : '—'}</dd></div>
          </dl>
        ))}

      <h3>正在发生的事</h3>
      <div className="metrics">
        <div className="metric">
          <span className="metric-label">执行中的工单</span>
          <span className="metric-value">{overview.runningTickets}</span>
        </div>
        <div className="metric">
          <span className="metric-label">执行中的 Worker</span>
          <span className="metric-value">{overview.runningWorkers}</span>
        </div>
        <div className="metric review">
          <span className="metric-label">待 PM 验收</span>
          <span className="metric-value">{overview.pendingReviews}</span>
        </div>
        <div className="metric">
          <span className="metric-label">项目</span>
          <span className="metric-value">{overview.counts.projects}</span>
        </div>
      </div>
      <dl className="detail-list">
        <div><dt>工单</dt><dd>{overview.counts.tickets}</dd></div>
        <div><dt>会话</dt><dd>{overview.counts.sessions}</dd></div>
        <div><dt>节点</dt><dd>{overview.counts.nodes}</dd></div>
      </dl>
      <div className="detail-actions">
        <button type="button" className="action" onClick={() => props.navigate('projects')}>去项目</button>
        <button type="button" className="action" onClick={() => props.navigate('sessions')}>去 PM / Worker 会话</button>
        <button type="button" className="action" onClick={() => props.navigate('nodes')}>去节点部署</button>
      </div>
    </section>
  )
}

/**
 * The history's own reads.
 *
 * They start when a person opens the history, not when the page opens: the live state needs no request at all, and the
 * long-term memory has none to make. The window asked for is the tail of the control plane's own log, and the control
 * plane says whether there is a hole in front of the rows it answered with.
 */
function HistoryLoader(props: {
  revision: number
  overview?: Overview
  onOpenProject: (projectId: string) => void
}): ReactElement {
  const seq = props.overview?.events.seq
  // The window is the tail of the log: the rows after the sequence just before the newest ones the control plane holds.
  const after = seq === undefined ? undefined : Math.max(0, seq - EVENT_TAIL)
  const projects = useLoaded(() => read<{ projects: ConsoleProject[] }>('/v1/console/projects'), props.revision)
  // Without the control plane's own sequence there is no window to ask for, and a read that has not answered is not an
  // empty log: the panel says so instead of showing a quiet page.
  const events = useLoaded<ConsoleEventPage>(
    () => (after === undefined
      ? Promise.resolve({ events: [] })
      : read<ConsoleEventPage>(`/v1/events?after=${after}`)),
    props.revision, String(after))
  const projectFacts: ListFacts<ConsoleProject> = projects.error !== ''
    ? { state: 'error', error: projects.error }
    : projects.data === undefined
      ? { state: 'pending' }
      : { state: 'ready', rows: projects.data.projects }
  const eventFacts: ListFacts<ConsoleEventLine> = events.error !== ''
    ? { state: 'error', error: events.error }
    : after === undefined
      ? { state: 'unavailable' }
      : events.data === undefined
        ? { state: 'pending' }
        : { state: 'ready', rows: events.data.events }
  return (
    <EventHistoryPanel
      projects={projectFacts}
      events={eventFacts}
      gap={events.data?.gap === true}
      retained={props.overview?.events.retained ?? 0}
      retention={props.overview?.retention}
      onOpenProject={props.onOpenProject} />
  )
}

/**
 * The event history: the records the control plane really keeps, and the ones it does not.
 *
 * The Projects and the Tickets are the business store's own rows and survive a restart. The console's event log is
 * bounded by its own retention rule, so the page says how much of it is left and does not present it as a history that can
 * be read back in full. How many rows are gone is not counted here: only the control plane knows whether there is a hole
 * in front of the rows it answered with.
 */
export function EventHistoryPanel(props: {
  /** The Projects of the business store, with what the read about them came back with. */
  projects: ListFacts<ConsoleProject>
  /** The newest rows of the console's own log, with what the read about them came back with. */
  events: ListFacts<ConsoleEventLine>
  /** Whether the control plane said there is a hole in front of the rows it answered with. */
  gap: boolean
  /** How many rows the control plane's log holds right now. */
  retained: number
  /** The retention rule the control plane reports. */
  retention?: Overview['retention']
  onOpenProject: (projectId: string) => void
}): ReactElement {
  const projects = props.projects.rows ?? []
  const rows = (props.events.rows ?? []).slice(-EVENT_TAIL)
  const retention = props.retention
  return (
    <section id="memory-domain-history" className="memory-domain" aria-labelledby="memory-history-heading">
      <h2 id="memory-history-heading">事件历史</h2>
      <p className="quiet">
        这一页现在能读到的只有两类记录：业务库里的项目与工单当前状态，和控制台自己的短期日志。
        按工单与项目归档的持久事件历史还没有建立。
      </p>

      <div className="memory-block">
        <div className="memory-block-head">
          <h3>项目档案与工单</h3>
          <span className="memory-tag">当前状态</span>
        </div>
        <p className="quiet">
          项目目标、工作区、PM 会话、工单与验收记录保存在控制面的业务库里，随控制面重启保留。
          这里显示的是它们现在的状态——这就是项目档案本身，不是记忆。
        </p>
        {props.projects.state === 'error'
          ? <p className="empty">{props.projects.error}</p>
          : props.projects.state === 'pending'
            ? <p className="empty">正在读取项目……</p>
            : projects.length === 0
              ? <p className="empty">还没有项目。</p>
              : <div className="memory-rows">
                {projects.map(project => (
                  <div className="setting" key={project.id}>
                    <span>
                      <b>{project.title}</b>
                      <span className="quiet">
                        {`${PROJECT_STATUS[project.status] ?? project.status} · ${project.tickets.length} 个工单 · ${stampOf(project.updatedAt)}`}
                      </span>
                    </span>
                    <span>
                      <button type="button" className="action" onClick={() => props.onOpenProject(project.id)}>打开</button>
                    </span>
                  </div>
                ))}
              </div>}
      </div>

      <div className="memory-block is-log">
        <div className="memory-block-head">
          <h3>控制台短期日志</h3>
          <span className="memory-tag">会被裁剪</span>
        </div>
        <p className="quiet">
          这是控制台自己的短期日志，不是持久历史。
          {retention === undefined ? '保留规则未知。' : retentionText(retention, props.retained)}
        </p>
        {props.gap
          ? <p className="notice warning">这段之前的事件已被裁剪，无法补读。</p>
          : null}
        {props.events.state === 'error'
          ? <p className="empty">{props.events.error}</p>
          : props.events.state === 'pending'
            ? <p className="empty">正在读取事件日志……</p>
            : props.events.state === 'unavailable'
              ? <p className="empty">还没有读到控制面的事件序号，暂时读不到这段日志。</p>
              : rows.length === 0
                ? <p className="empty">控制台事件日志暂时没有可读的记录。</p>
                : <div className="memory-rows">
                  {rows.map(event => (
                    <div className="setting" key={event.seq}>
                      <span>
                        <b>{EVENT_KIND[event.kind ?? ''] ?? event.kind ?? event.type}</b>
                        <span className="quiet">
                          {`序号 ${event.seq} · ${event.sessionId || '控制面'} · ${event.nodeId}`}
                        </span>
                      </span>
                      <span className="quiet">{stampOf(event.at)}</span>
                    </div>
                  ))}
                </div>}
        <p className="quiet">
          {auditText(retention)}它记录的是操作事实，不是完整历史。
        </p>
      </div>
    </section>
  )
}

/**
 * The long-term memory: what is not there yet, and what is.
 *
 * The page says plainly that the service and the queue do not exist, and points at the manual Project notes that do. The
 * five objects of the memory system are written down in the contract; repeating them here as a list would only make the
 * console heavier without making it truer.
 */
export function LongTermMemoryPanel(props: { onOpenProjects: () => void }): ReactElement {
  return (
    <section id="memory-domain-longterm" className="memory-domain" aria-labelledby="memory-longterm-heading">
      <h2 id="memory-longterm-heading">长期记忆</h2>
      <p className="notice warning">
        长期记忆服务与候选队列还没有建立：候选的入队、审核与检索都没有开放，这一页没有任何可召回的长期记忆。
      </p>
      <p className="quiet">
        现在能手工留给一个项目的，只有「项目 › 项目备忘」里操作员自己写的便签。它由人维护，不会被模型改写，
        也不会进入候选队列；这一页不保存任何东西，也不发起任何审核。
      </p>
      <div className="detail-actions">
        <button type="button" className="action" onClick={props.onOpenProjects}>去项目页记一笔</button>
      </div>
    </section>
  )
}
