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
 * The live state is now the control plane's own live snapshot (`P5-1`): the page asks for it when the domain is opened,
 * says the moment it was taken, and shows what the control plane may see right now. A read that failed is said out loud
 * and never leaves an old value looking like the present one. The wiring place for the rest of Phase 5 is the three panels
 * below: the durable history index of P5-2 and the memory service of P5-3 to P5-5 fill the other two places without the
 * page changing shape.
 */
import { useState, type ReactElement } from 'react'
import { read, readLiveState, type ConsoleProject, type LiveStateList, type LiveStateNode,
  type LiveStateSnapshot, type Overview, type StreamStatus } from './api.ts'
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
 * The live state is read by the live domain itself, when a person opens it; the two lists the history domain shows are
 * read by that domain, too, when a person opens it. Nothing is read twice and nothing is read before it is needed.
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
        ? <LiveStateLoader revision={props.revision} stream={props.stream} navigate={props.navigate} />
        : domain === 'history'
          ? <HistoryLoader revision={props.revision} overview={props.overview}
            onOpenProject={(id) => props.navigate('projects', id)} />
          : <LongTermMemoryPanel onOpenProjects={() => props.navigate('projects')} />}
    </div>
  )
}

/**
 * The live state's own read.
 *
 * It starts when a person opens the live state and is read again whenever the control plane recorded something or the
 * person asked for a refresh. The read is the control plane's own: it returns a snapshot with the moment it was taken,
 * and it writes nothing.
 */
function LiveStateLoader(props: {
  revision: number
  stream?: StreamStatus
  navigate: (page: string, where?: string) => void
}): ReactElement {
  const live = useLoaded(() => readLiveState(), props.revision)
  return <LiveStatePanel snapshot={live.data} error={live.error} stream={props.stream} navigate={props.navigate} />
}

/** How a node's connection reads in the console. */
function connectionWording(connection: LiveStateNode['connection']): string {
  if (connection === 'online') return '在线'
  if (connection === 'offline') return '离线'
  return '状态未知'
}

/** The chip a node's connection is shown as. */
function connectionChip(connection: LiveStateNode['connection']): string {
  if (connection === 'online') return 'success'
  if (connection === 'offline') return 'failure'
  return 'muted'
}

/** How a backend's availability reads in the console. */
function availabilityWording(availability: LiveStateNode['backends'][number]['availability']): string {
  if (availability === 'available') return '可用'
  if (availability === 'unavailable') return '不可用'
  return '未知'
}

/** How a Project's status reads in the console. */
const PROJECT_LIVE_STATUS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  ended: '已结束',
  archived: '已归档',
}

/** How a Ticket's status reads in the console. */
const TICKET_LIVE_STATUS: Record<string, string> = {
  open: '待开始',
  running: '进行中',
  waiting: '等待审阅',
  blocked: '已阻塞',
  failed: '失败',
  completed: '已完成',
  stopped: '已停止',
  archived: '已归档',
}

/** How a Session's role reads in the console. */
const SESSION_LIVE_ROLE: Record<string, string> = {
  router: 'Router',
  pm: 'PM',
  worker: 'Worker',
  scout: 'Scout',
}

/**
 * The live state: the control plane's own snapshot, read at a known moment.
 *
 * A node that never registered is not an offline node: the panel says the state is unknown rather than showing a red chip
 * for a machine it has never heard of. A read that failed never leaves an old value looking live: the failure is said
 * out loud, and whatever is on the screen below it is marked as the last read rather than as now.
 */
export function LiveStatePanel(props: {
  /** The snapshot, when a read answered. */
  snapshot?: LiveStateSnapshot
  /** Why the read failed, when it failed. */
  error?: string
  /** Whether the event stream is still carrying what follows. */
  stream?: StreamStatus
  navigate: (page: string, where?: string) => void
}): ReactElement {
  const snapshot = props.snapshot
  const failed = props.error !== undefined && props.error !== ''
  return (
    <section id="memory-domain-live" className="memory-domain" aria-labelledby="memory-live-heading">
      <h2 id="memory-live-heading">实时状态</h2>
      <p className="quiet">
        实时状态是此刻的控制面快照，不是记录。它不写入任何长期存储，也不触发模型。
      </p>
      {failed
        ? <p className="notice warning">
          {`读取实时状态失败：${props.error}。下面的数据是上一次读到的，不是现在的状态；用上方的「刷新」重试。`}
        </p>
        : null}
      {!failed && props.stream === 'reconnecting'
        ? <p className="notice warning">事件流未连接，下面的数据可能不是最新的。</p>
        : null}
      {snapshot === undefined
        ? failed
          ? <p className="empty">还没有读到过实时状态。</p>
          : <p className="empty">正在读取实时状态……</p>
        : <>
          <dl className="detail-list">
            <div><dt>取样时间</dt><dd>{stampOf(snapshot.at)}</dd></div>
            <div><dt>读取范围</dt><dd>{snapshot.audience === 'operator' ? '控制台可见的全部' : snapshot.audience}</dd></div>
          </dl>

          <h3>执行节点</h3>
          {snapshot.nodes.rows.length === 0
            ? <p className="empty">控制面还没有登记任何节点，节点状态未知。</p>
            : snapshot.nodes.rows.map(node => (
              <dl className="detail-list" key={node.nodeId}>
                <div><dt>节点</dt><dd>{node.nodeId}{node.displayName === undefined ? '' : ` · ${node.displayName}`}</dd></div>
                <div><dt>连接状态</dt><dd>
                  <span className={`chip ${connectionChip(node.connection)}`}>{connectionWording(node.connection)}</span>
                </dd></div>
                <div><dt>后端</dt><dd>
                  {node.backends.length === 0
                    ? '—'
                    : node.backends.map(backend =>
                      `${backend.backendId}（${availabilityWording(backend.availability)}）`).join('、')}
                </dd></div>
                <div><dt>最后心跳</dt><dd>{node.lastSeenAt === undefined ? '—' : stampOf(node.lastSeenAt)}</dd></div>
              </dl>
            ))}

          <h3>正在发生的事</h3>
          <dl className="detail-list">
            <div><dt>项目</dt><dd>{snapshot.projects.total}</dd></div>
            <div><dt>工单</dt><dd>{snapshot.tickets.total}</dd></div>
            <div><dt>Assignment</dt><dd>{snapshot.assignments.total}</dd></div>
            <div><dt>会话</dt><dd>{snapshot.sessions.total}</dd></div>
            <div><dt>定时计划</dt><dd>{snapshot.schedules.total}</dd></div>
          </dl>

          <h3>项目</h3>
          <LiveList
            list={snapshot.projects}
            empty="没有项目。"
            render={project => (
              <>
                <b>{project.title}</b>
                <span className="quiet">
                  {`${PROJECT_LIVE_STATUS[project.status] ?? project.status} · ${project.projectId}`}
                </span>
              </>
            )}
            link={project => ({ label: '打开', onClick: () => props.navigate('projects', project.projectId) })} />

          <h3>工单</h3>
          <LiveList
            list={snapshot.tickets}
            empty="没有工单。"
            render={ticket => (
              <>
                <b>{ticket.title}</b>
                <span className="quiet">
                  {`${TICKET_LIVE_STATUS[ticket.status] ?? ticket.status}${ticket.stopped === true ? ' · 已人工停止' : ''}`}
                </span>
              </>
            )}
            link={ticket => {
              const projectId = ticket.projectId
              if (projectId === undefined) return undefined
              return { label: '打开', onClick: () => props.navigate('projects', projectId) }
            }} />

          <h3>会话</h3>
          <LiveList
            list={snapshot.sessions}
            empty="没有会话。"
            render={session => (
              <>
                <b>{SESSION_LIVE_ROLE[session.role] ?? session.role}</b>
                <span className="quiet">
                  {`${session.status}${session.stopped === true ? ' · 已人工停止' : ''} · ${session.sessionId}`}
                </span>
              </>
            )}
            link={session => ({ label: '打开', onClick: () => props.navigate('sessions', session.sessionId) })} />

          <h3>定时计划</h3>
          <LiveList
            list={snapshot.schedules}
            empty="没有定时计划。"
            render={plan => (
              <>
                <b>{plan.name}</b>
                <span className="quiet">
                  {`${plan.enabled ? '已启用' : '已暂停'} · ${plan.rule} · ${stampOf(plan.nextAt)}`}
                </span>
              </>
            )} />

          <div className="detail-actions">
            <button type="button" className="action" onClick={() => props.navigate('projects')}>去项目</button>
            <button type="button" className="action" onClick={() => props.navigate('sessions')}>去 PM / Worker 会话</button>
            <button type="button" className="action" onClick={() => props.navigate('nodes')}>去节点部署</button>
          </div>
        </>}
    </section>
  )
}

/**
 * One bounded list of the live state.
 *
 * A list that was cut says so: the panel never lets a reader believe it saw every row when the control plane held more.
 * A row that leads somewhere carries the way there, so the list is a way into the work and not only a picture of it.
 */
function LiveList<T>(props: {
  list: LiveStateList<T>
  empty: string
  render: (row: T) => ReactElement
  /** The way into the row, when the row leads somewhere. */
  link?: (row: T) => { label: string; onClick: () => void } | undefined
}): ReactElement {
  if (props.list.rows.length === 0) return <p className="empty">{props.empty}</p>
  return (
    <>
      <div className="memory-rows">
        {props.list.rows.map((row, index) => {
          const link = props.link?.(row)
          return (
            <div className="setting" key={index}>
              <span>{props.render(row)}</span>
              {link === undefined
                ? null
                : <span><button type="button" className="action" onClick={link.onClick}>{link.label}</button></span>}
            </div>
          )
        })}
      </div>
      {props.list.omitted > 0
        ? <p className="quiet">{`另有 ${props.list.omitted} 条没有显示（共 ${props.list.total} 条）。`}</p>
        : null}
    </>
  )
}

/**
 * The history's own reads.
 *
 * They start when a person opens the history, not when the page opens: every domain reads on its own, when a person opens
 * it. The window asked for is the tail of the control plane's own log, and the control plane says whether there is a hole in
 * front of the rows it answered with.
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
