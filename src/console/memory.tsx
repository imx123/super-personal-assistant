/**
 * The console's memory page: what the control plane can see now, and what it cannot.
 *
 * The page has three sibling domains — the live state, the event history and the long-term memory — and it names each of
 * them as it really is. The header says when the facts were read and whether the event stream is still carrying what
 * follows. The live state is a snapshot the control plane read at a known moment, and the node states in it are the
 * control plane's own words: a machine it has never heard of is unknown, not offline. The event history is what the control
 * plane's own files hold today: the Projects and Tickets of the business store, the durable event history of key facts
 * filed by Ticket and Project, and the console's own short-lived log, which is named as short-lived and never as a
 * history that can be read back in full. The long-term memory is the control plane's own queue of proposals and the
 * memories a decision made of them.
 *
 * The live state and the event history are read-only. The long-term memory is where a person may act: a proposal may be
 * offered, and a proposal may be approved or sent back. Neither writes a memory directly — a memory is written when a
 * decision about a candidate says so, and the panel names that order instead of hiding it.
 *
 * Nothing here fills a gap with an example: a number the control plane did not report is not shown at all, and a read
 * that has not answered yet is shown as waiting rather than as empty.
 *
 * The live state is now the control plane's own live snapshot (`P5-1`): the page asks for it when the domain is opened,
 * says the moment it was taken, and shows what the control plane may see right now. A read that failed is said out loud
 * and never leaves an old value looking like the present one. The durable event history is now the control plane's own
 * index of key facts (`P5-2`), read by the exact key of a Ticket or a Project and told apart from the console's own
 * short-lived log. Its pages belong to the range they were read for: a page that answers after the person changed the
 * range is dropped, so one Project's facts never land in another's list. The long-term memory is now the control plane's
 * own service (`P5-3`): the queue of proposals, the memories that are in force, and the decision a person takes about a
 * proposal. The memory manager of `P5-4` fills the same panel: the queue of reviews it was woken for, the candidates that
 * wait for a person, and the daily inspection with its real result and the next time it is due. The wiring place for the
 * rest of Phase 5 is the same panel: the retrieval of `P5-5` fills it without the page changing shape.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { decideMemoryCandidate, messageOf, read, readEventHistory, readLiveState, readLongTermMemories,
  readMemoryCandidates, readMemoryMaintenance, readMemoryReviews, runMemoryMaintenance, submitMemoryCandidate,
  type ConsoleProject, type ConsoleTicket, type EventHistoryCoverage, type EventHistoryEntry, type LiveStateList,
  type LiveStateNode, type LiveStateSnapshot, type MemoryCandidateView, type MemoryMaintenanceRunView,
  type MemoryRecordView, type MemoryReviewRunView, type Overview, type StreamStatus } from './api.ts'
import { stampOf, useAction, useLoaded, type PageProps } from './pages.tsx'

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

/** What the durable history's own read knows: it waits, it answers, or it failed. */
type DurableState = 'pending' | 'error' | 'ready'

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

/** How the durable event history's kinds read. */
const HISTORY_KIND: Record<string, string> = {
  trigger: '触发',
  dispatch: '派工',
  handoff: '交接',
  report: '报告',
  review: '评审',
  manual_stop: '人工停止',
  denial: '权限拒绝',
  schedule: '定时计划',
  error: '失败',
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
          : <LongTermMemoryPanel revision={props.revision} refresh={props.refresh}
            onOpenProjects={() => props.navigate('projects')} />}
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
  manager: '记忆管理员',
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
            <div><dt>派工</dt><dd>{snapshot.assignments.total}</dd></div>
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
                : <span className="memory-action">
                  <button type="button" className="action" onClick={link.onClick}>{link.label}</button>
                </span>}
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
  const projects = useLoaded(
    () => read<{ projects: ConsoleProject[]; standaloneTickets?: ConsoleTicket[] }>('/v1/console/projects'), props.revision)
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
      onOpenProject={props.onOpenProject}
      durable={<PersistentHistoryPanel projects={projects.data?.projects ?? []}
        standaloneTickets={projects.data?.standaloneTickets ?? []} revision={props.revision} />} />
  )
}

/**
 * The event history: the records the control plane really keeps, and the ones it does not.
 *
 * The Projects and the Tickets are the business store's own rows and survive a restart. The durable event history is the
 * control plane's own index of key facts, filed by Ticket, Project, Session and Assignment; it is handed in as its own
 * element, because it reads by its exact keys and its own loader owns that read. The console's event log is bounded by its
 * own retention rule, so the page says how much of it is left and does not present it as a history that can be read back in
 * full. How many rows are gone is not counted here: only the control plane knows whether there is a hole in front of the
 * rows it answered with.
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
  /** The durable event history, read by its own loader and shown here. */
  durable: ReactElement
}): ReactElement {
  const projects = props.projects.rows ?? []
  const rows = (props.events.rows ?? []).slice(-EVENT_TAIL)
  const retention = props.retention
  return (
    <section id="memory-domain-history" className="memory-domain" aria-labelledby="memory-history-heading">
      <h2 id="memory-history-heading">事件历史</h2>
      <p className="quiet">
        这一页有三块记录：业务库里的项目与工单当前状态，按工单与项目归档的持久事件历史，和控制台自己的短期日志。
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
                    <span className="memory-action">
                      <button type="button" className="action" onClick={() => props.onOpenProject(project.id)}>打开</button>
                    </span>
                  </div>
                ))}
              </div>}
      </div>

      <div className="memory-block">
        <div className="memory-block-head">
          <h3>持久事件历史</h3>
          <span className="memory-tag">不按天数裁剪</span>
        </div>
        <p className="quiet">
          这是控制面自己的库里按工单、项目、会话与派工归档的关键事实：触发、派工、交接、报告状态、评审、人工停止、
          权限拒绝、定时计划与失败。每条只有一句已脱敏的摘要和它的出处——报告原文、差异、提示词与路径都不在这里。
        </p>
        {props.durable}
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
 * The durable event history: the key facts of what this control plane did, read by their exact keys.
 *
 * The loader reads; the view beside it shows. The loader holds the rows, the cursor and the flags of the read, and the
 * view turns them into the panel a person reads: the filters are the control plane's own facts — the Projects it holds
 * and the Tickets under them — a key that names nothing reads nothing, and the panel says that this range holds no record
 * instead of showing an empty list as if it were the answer. The pages are cut by a keyset, so "load more" continues where
 * the last page ended and never shows a row twice.
 *
 * A page belongs to the range it was asked for. A change of the filter or of the control plane's own facts opens a new
 * generation, and an aborted read opens one as well: a page that answers late is dropped instead of landing in another
 * range's rows, and it may not touch the cursor, the error or the busy flag either.
 */
export function PersistentHistoryPanel(props: {
  /** The Projects the person may pick from. */
  projects: ConsoleProject[]
  /** The Tickets that belong to no Project. */
  standaloneTickets: ConsoleTicket[]
  /** The revision of the control plane's own facts: a new fact is read again. */
  revision: number
}): ReactElement {
  const [projectId, setProjectId] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [rows, setRows] = useState<EventHistoryEntry[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [total, setTotal] = useState(0)
  const [coverage, setCoverage] = useState<EventHistoryCoverage | undefined>(undefined)
  const [state, setState] = useState<DurableState>('pending')
  const [error, setError] = useState('')
  const [moreError, setMoreError] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * The generation of the range on the screen.
   *
   * A range is the filter and the revision of the control plane's own facts. Every read carries the generation it was
   * asked for, and a page that answers for a generation that is no longer the current one belongs to a range the person
   * has already left: it is dropped, and it changes neither the rows, nor the cursor, nor the total, nor the error, nor the
   * busy flag.
   */
  const generation = useRef(0)
  /**
   * The generation whose next page is on its way.
   *
   * It is a fact of the read, not of the render: two clicks that arrive before the panel redraws would otherwise ask for
   * the same page twice and show its rows twice.
   */
  const loading = useRef<number | undefined>(undefined)
  const filter = { ...(projectId === '' ? {} : { projectId }), ...(ticketId === '' ? {} : { ticketId }) }

  /**
   * Leave the range that is on the screen.
   *
   * The generation ends at once, so a page that is still on its way belongs to a range that is gone and is dropped before
   * it can answer. The rows of the range that is left go with it: they are not the rows of the range that is chosen now,
   * and the panel waits for the new range instead of showing the old one under the new filter.
   */
  const leave = (): void => {
    generation.current += 1
    loading.current = undefined
    setState('pending')
    setRows([])
    setCursor(undefined)
    setTotal(0)
    setCoverage(undefined)
    setError('')
    setMoreError('')
    setBusy(true)
  }

  // The first page is read when the panel is opened, when the control plane recorded something, and when the filter
  // changed. A read that has not answered is waiting, not empty.
  useEffect(() => {
    let cancelled = false
    // The read claims a generation of its own, so the page it asks for belongs to the range on the screen.
    const mine = ++generation.current
    loading.current = undefined
    setState('pending')
    setBusy(true)
    setMoreError('')
    readEventHistory(filter).then(answer => {
      if (cancelled || generation.current !== mine) return
      setRows(answer.rows)
      setCursor(answer.nextCursor)
      setTotal(answer.total)
      setCoverage(answer.coverage)
      setState('ready')
      setError('')
    }).catch((reason: unknown) => {
      if (cancelled || generation.current !== mine) return
      setRows([])
      setCursor(undefined)
      setState('error')
      setError(messageOf(reason))
    }).finally(() => { if (!cancelled && generation.current === mine) setBusy(false) })
    // The read is over, one way or another: whatever it was reading belongs to a range that may be gone.
    return () => { cancelled = true; generation.current += 1 }
  }, [projectId, ticketId, props.revision])

  /** Read the page after the one on the screen. */
  const loadMore = (): void => {
    if (cursor === undefined || busy || loading.current !== undefined) return
    const mine = generation.current
    loading.current = mine
    setBusy(true)
    setMoreError('')
    readEventHistory({ ...filter, cursor }).then(answer => {
      if (generation.current !== mine) return
      setRows(current => [...current, ...answer.rows])
      setCursor(answer.nextCursor)
      setTotal(answer.total)
      setCoverage(answer.coverage)
    }).catch((reason: unknown) => {
      // The page that failed is the one the person asked for: the rows on the screen stay, and the failure is said out
      // loud so the person may ask for it again.
      if (generation.current !== mine) return
      setMoreError(messageOf(reason))
    }).finally(() => {
      // The marker is ours only while it still names our generation: a newer page owns it now.
      if (loading.current === mine) loading.current = undefined
      if (generation.current !== mine) return
      setBusy(false)
    })
  }

  return (
    <PersistentHistoryView
      projects={props.projects}
      standaloneTickets={props.standaloneTickets}
      projectId={projectId}
      ticketId={ticketId}
      state={state}
      rows={rows}
      total={total}
      coverage={coverage}
      error={error}
      moreError={moreError}
      busy={busy}
      hasMore={cursor !== undefined}
      onProjectChange={value => {
        if (value === projectId) return
        leave()
        setProjectId(value)
        setTicketId('')
      }}
      onTicketChange={value => {
        if (value === ticketId) return
        leave()
        setTicketId(value)
      }}
      onClear={() => {
        if (projectId === '' && ticketId === '') return
        leave()
        setProjectId('')
        setTicketId('')
      }}
      onLoadMore={loadMore} />
  )
}

/**
 * The durable event history's own view: the rows it holds and the filters that choose them.
 *
 * It reads nothing and starts nothing: the rows, the counts, the filters and the flags are given to it. A range that has
 * not answered yet is shown as waiting, a failed read as the failure it was, and the rows that are on the screen are never
 * taken away by a page that failed to arrive.
 */
export function PersistentHistoryView(props: {
  /** The Projects the person may pick from. */
  projects: ConsoleProject[]
  /** The Tickets that belong to no Project. */
  standaloneTickets: ConsoleTicket[]
  /** The Project the person chose. */
  projectId: string
  /** The Ticket the person chose. */
  ticketId: string
  /** What the read about the rows came back with. */
  state: DurableState
  /** The rows on the screen. */
  rows: EventHistoryEntry[]
  /** How many rows are in scope, in all. */
  total: number
  /** How far back the history reaches. */
  coverage?: EventHistoryCoverage
  /** Why the read failed, when it failed; empty when it did not. */
  error: string
  /** Why the next page failed, when it failed; empty when it did not, and the rows on the screen stay. */
  moreError: string
  /** Whether a read is running. */
  busy: boolean
  /** Whether a page follows the one on the screen. */
  hasMore: boolean
  /** The person chose another Project. */
  onProjectChange: (projectId: string) => void
  /** The person chose another Ticket. */
  onTicketChange: (ticketId: string) => void
  /** The person cleared the filters. */
  onClear: () => void
  /** The person asked for the page after the one on the screen. */
  onLoadMore: () => void
}): ReactElement {
  // The Tickets the person may pick are the ones the control plane really holds: the Tickets of the Project it chose, or
  // the Tickets that belong to no Project when it chose none.
  const tickets = props.projectId === ''
    ? props.standaloneTickets
    : (props.projects.find(project => project.id === props.projectId)?.tickets ?? [])
  return (
    <div className="memory-history">
      <div className="memory-filters">
        <label>
          <span>项目</span>
          <select value={props.projectId} onChange={change => props.onProjectChange(change.target.value)}>
            <option value="">全部项目</option>
            {props.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
        </label>
        <label>
          <span>工单</span>
          <select value={props.ticketId} onChange={change => props.onTicketChange(change.target.value)}>
            <option value="">全部工单</option>
            {tickets.map(ticket => <option key={ticket.id} value={ticket.id}>{ticket.title}</option>)}
          </select>
        </label>
        <button type="button" className="action" onClick={props.onClear}
          disabled={props.projectId === '' && props.ticketId === ''}>清除筛选</button>
      </div>
      {props.state === 'error'
        ? <p className="empty">{`读取持久事件历史失败：${props.error}`}</p>
        : props.state === 'pending'
          ? <p className="empty">正在读取持久事件历史……</p>
          : props.rows.length === 0
            ? <p className="empty">这个范围里还没有记录到事实。</p>
            : <div className="memory-rows">
              {props.rows.map(row => (
                <div className="setting" key={row.eventId}>
                  <span>
                    <b>{HISTORY_KIND[row.kind] ?? row.kind}</b>
                    <span className="quiet">{row.summary}</span>
                    <span className="quiet">{`${historyScope(row)} · ${stampOf(row.at)}`}</span>
                  </span>
                  <span className="quiet">{`来源 ${row.sourceTable}`}</span>
                </div>
              ))}
            </div>}
      {props.state === 'ready' && props.rows.length > 0
        ? <p className="quiet">{`这个范围里共 ${props.total} 条事实，显示了 ${props.rows.length} 条。`}</p>
        : null}
      {props.moreError === ''
        ? null
        : <p className="notice warning">{`加载更多失败：${props.moreError}。上面的记录仍在，可以再试一次。`}</p>}
      {props.hasMore
        ? <div className="detail-actions">
          <button type="button" className="action" onClick={props.onLoadMore} disabled={props.busy}>
            {props.busy ? '正在读取……' : '加载更多'}
          </button>
        </div>
        : null}
      {props.coverage === undefined ? null : <p className="quiet">{historyCoverageText(props.coverage)}</p>}
    </div>
  )
}

/** The scope of one row of the durable history, as the console names it. */
function historyScope(row: EventHistoryEntry): string {
  if (row.ticketId !== '') return `工单 ${row.ticketId}`
  if (row.assignmentId !== '') return `派工 ${row.assignmentId}`
  if (row.projectId !== '') return `项目 ${row.projectId}`
  if (row.controlSessionId !== '') return `会话 ${row.controlSessionId}`
  return row.scopeKey
}

/** How much of the durable history the control plane holds, in the console's own words. */
function historyCoverageText(coverage: EventHistoryCoverage): string {
  const since = coverage.since === undefined ? '索引里还没有事实。' : `最早一条是 ${stampOf(coverage.since)}。`
  return `${since}${coverage.retention}索引开始之前的事实没有记录，也补不回来。`
}

/**
 * The long-term memory: the queue of proposals, the memories that are in force, and the decision a person takes.
 *
 * The service exists now (`P5-3`), so the panel says what it really is: a proposal enters the queue and waits, and it
 * becomes a memory only when a decision says so. There is no action here that writes a memory directly, and there is no
 * action that forgets one — the forgetting of a memory is still undecided, so the panel does not offer it.
 *
 * The loader reads; the view beside it shows. The loader holds the rows, the flags of the read and the words of the
 * form; the view turns them into the panel a person reads. That is what lets the panel be rendered on its own, without
 * a React instance of its own, and it is why every state here is a prop rather than something the view looks up.
 */
export function LongTermMemoryPanel(props: {
  /** The revision of the control plane's own facts: a new fact is read again. */
  revision: number
  /** Read the page's facts again, after an action that left no event behind. */
  refresh: () => void
  onOpenProjects: () => void
}): ReactElement {
  const queue = useLoaded(() => readMemoryCandidates(), props.revision)
  const saved = useLoaded(() => readLongTermMemories(), props.revision)
  const reviews = useLoaded(() => readMemoryReviews(), props.revision)
  const maintenance = useLoaded(() => readMemoryMaintenance(), props.revision)
  const projects = useLoaded(() => read<{ projects: ConsoleProject[] }>('/v1/console/projects'), props.revision)
  const [content, setContent] = useState('')
  const [scope, setScope] = useState('user_global|global')
  const action = useAction(() => props.refresh())

  /** One decision about one proposal, and the words that say what it did. */
  const decide = (candidate: MemoryCandidateView, decision: 'approve' | 'reject'): void => {
    action.run(
      () => decideMemoryCandidate({ candidateId: candidate.candidateId, decision, checksum: candidate.checksum }),
      result => decisionWording((result as { code?: string }).code ?? ''))
  }

  /** One proposal, offered by the person who is looking at the page. */
  const propose = (): void => {
    if (content.trim() === '') return
    const [scopeType = '', scopeId = ''] = scope.split('|')
    action.run(
      () => submitMemoryCandidate({ content: content.trim(), scopeType, scopeId }),
      // The words are cleared only once the control plane has taken them: a refused proposal keeps what was written.
      () => { setContent(''); return '候选已进入队列，等待一次决定。' })
  }

  /** One inspection, now, by the person who is looking at the page. */
  const inspect = (): void => {
    action.run(
      () => runMemoryMaintenance(),
      result => maintenanceWording((result as { run?: MemoryMaintenanceRunView }).run))
  }

  const options = [
    { value: 'user_global|global', label: '全局偏好（跨项目）' },
    ...(projects.data?.projects ?? []).map(project =>
      ({ value: `project|project:${project.id}`, label: `项目：${project.title}` })),
  ]

  return (
    <LongTermMemoryView
      candidates={queue.data?.rows ?? []}
      memories={saved.data?.rows ?? []}
      reviews={reviews.data?.rows ?? []}
      reviewState={reviews.error !== '' ? 'error' : reviews.data === undefined ? 'pending' : 'ready'}
      maintenance={maintenance.data?.rows ?? []}
      maintenanceState={maintenance.error !== '' ? 'error' : maintenance.data === undefined ? 'pending' : 'ready'}
      queueState={queue.error !== '' ? 'error' : queue.data === undefined ? 'pending' : 'ready'}
      listState={saved.error !== '' ? 'error' : saved.data === undefined ? 'pending' : 'ready'}
      error={queue.error !== '' ? queue.error : saved.error}
      busy={action.state.busy}
      message={action.state.message}
      actionError={action.state.error}
      content={content}
      scope={scope}
      scopeOptions={options}
      onContentChange={setContent}
      onScopeChange={setScope}
      onSubmit={propose}
      onApprove={candidate => decide(candidate, 'approve')}
      onReject={candidate => decide(candidate, 'reject')}
      onInspect={inspect}
      onOpenProjects={props.onOpenProjects} />
  )
}

/**
 * The long-term memory's own view: the queue, the memories that are in force, and the decision a person takes.
 *
 * It reads nothing and starts nothing: the rows, the flags of the read and the words of the form are given to it. A read
 * that has not answered is shown as waiting, a failed read as the failure it was, and a read that answered with no rows
 * as an empty queue — three different things, never one.
 */
export function LongTermMemoryView(props: {
  /** The proposals that wait for a decision. */
  candidates: MemoryCandidateView[]
  /** The memories that are in force. */
  memories: MemoryRecordView[]
  /** The reviews the memory manager was woken for. */
  reviews: MemoryReviewRunView[]
  /** What the read of the review queue came back with. */
  reviewState: 'pending' | 'error' | 'ready'
  /** The runs of the daily inspection. */
  maintenance: MemoryMaintenanceRunView[]
  /** What the read of the inspection's record came back with. */
  maintenanceState: 'pending' | 'error' | 'ready'
  /** What the read of the queue came back with. */
  queueState: 'pending' | 'error' | 'ready'
  /** What the read of the memories came back with. */
  listState: 'pending' | 'error' | 'ready'
  /** Why a read failed, when it did. */
  error: string
  /** Whether an action is running. */
  busy: boolean
  /** What the last action did. */
  message: string
  /** Why the last action failed, when it did. */
  actionError: string
  /** The body of the proposal the person is writing. */
  content: string
  /** The scope the proposal is offered for. */
  scope: string
  /** The scopes the person may choose from. */
  scopeOptions: { value: string; label: string }[]
  onContentChange: (value: string) => void
  onScopeChange: (value: string) => void
  /** The person offered a proposal. */
  onSubmit: () => void
  /** The person approved a proposal. */
  onApprove: (candidate: MemoryCandidateView) => void
  /** The person did not adopt a proposal. */
  onReject: (candidate: MemoryCandidateView) => void
  /** The person asked for an inspection now. */
  onInspect: () => void
  onOpenProjects: () => void
}): ReactElement {
  const waiting = props.candidates.filter(candidate => REVIEWABLE_STATES.includes(candidate.status))
  const forHuman = props.candidates.filter(candidate => candidate.status === 'pending_human_confirm')
  const last = props.maintenance[0]
  return (
    <section id="memory-domain-longterm" className="memory-domain" aria-labelledby="memory-longterm-heading">
      <h2 id="memory-longterm-heading">长期记忆</h2>
      <p className="quiet">
        候选先入队，再由人决定：一条候选只有经过同库审核才会成为长期记忆。外部来源的事实会被标为不可信，
        永远不能自动进入全局作用域。
      </p>

      {props.actionError !== ''
        ? <p className="notice warning">{`操作失败：${props.actionError}`}</p>
        : null}
      {props.message !== ''
        ? <p className="notice success">{props.message}</p>
        : null}

      <div className="memory-block">
        <div className="memory-block-head">
          <h3>提出一条候选</h3>
          <span className="memory-tag">入队后等待决定</span>
        </div>
        <div className="memory-form">
          <label htmlFor="memory-candidate-content">
            <span>要记住的事实</span>
            <textarea id="memory-candidate-content" rows={3} value={props.content}
              placeholder="例如：这个项目统一用 pnpm，不要用 npm。"
              onChange={event => props.onContentChange(event.target.value)} />
          </label>
          <label htmlFor="memory-candidate-scope">
            <span>作用域</span>
            <select id="memory-candidate-scope" value={props.scope}
              onChange={event => props.onScopeChange(event.target.value)}>
              {props.scopeOptions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <div className="detail-actions">
            <button type="button" className="action" onClick={props.onSubmit}
              disabled={props.busy || props.content.trim() === ''}>
              {props.busy ? '正在提交……' : '提交候选'}
            </button>
          </div>
        </div>
        <p className="quiet">
          正文里不能有路径、密钥或提示词；控制面会在写入前检查并拒绝这样的候选。
        </p>
      </div>

      <div className="memory-block">
        <div className="memory-block-head">
          <h3>等待人工确认</h3>
          <span className="memory-tag">只有人能决定</span>
        </div>
        <p className="quiet">
          这些候选只能由人决定：记忆管理员不能替人通过、归并或取代它们。它们来自全局作用域、来自无法核验的来源，
          或者已经退回过一次。
        </p>
        {props.queueState === 'error'
          ? <p className="empty">{`读取候选队列失败：${props.error}`}</p>
          : props.queueState === 'pending'
            ? <p className="empty">正在读取候选队列……</p>
            : forHuman.length === 0
              ? <p className="empty">没有等待人工确认的候选。</p>
              : <div className="memory-rows">
                {forHuman.map(candidate => (
                  <div className="setting" key={`human-${candidate.candidateId}`}>
                    <span>
                      <b>{candidate.content}</b>
                      <span className="quiet">
                        {`${scopeWording(candidate.scopeType, candidate.scopeId)} · ${trustWording(candidate.sourceTrust)} · ${candidateStatusWording(candidate.status)}`}
                      </span>
                      <span className="quiet">
                        {`${candidate.proposedByRole || '系统'} 提出 · ${stampOf(candidate.createdAt)}`}
                      </span>
                      {candidate.returnedToSessionId !== ''
                        ? <span className="quiet">{`已退回给 ${candidate.returnedToSessionId}，等待补充上下文。`}</span>
                        : null}
                    </span>
                    <span className="memory-action">
                      <button type="button" className="action" onClick={() => props.onApprove(candidate)}
                        aria-label={`通过候选 ${candidate.candidateId}`}
                        disabled={props.busy}>通过</button>
                      <button type="button" className="action" onClick={() => props.onReject(candidate)}
                        aria-label={`不采纳候选 ${candidate.candidateId}`}
                        disabled={props.busy}>不采纳</button>
                    </span>
                  </div>
                ))}
              </div>}
        {props.queueState === 'ready' && forHuman.length > 0
          ? <p className="quiet">{`共 ${forHuman.length} 条候选等待人工确认。`}</p>
          : null}
      </div>

      <div className="memory-block">
        <div className="memory-block-head">
          <h3>候选队列</h3>
          <span className="memory-tag">等待决定</span>
        </div>
        {props.queueState === 'error'
          ? <p className="empty">{`读取候选队列失败：${props.error}`}</p>
          : props.queueState === 'pending'
            ? <p className="empty">正在读取候选队列……</p>
            : props.candidates.length === 0
              ? <p className="empty">队列里还没有候选。</p>
              : <div className="memory-rows">
                {props.candidates.map(candidate => (
                  <div className="setting" key={candidate.candidateId}>
                    <span>
                      <b>{candidate.content}</b>
                      <span className="quiet">
                        {`${scopeWording(candidate.scopeType, candidate.scopeId)} · ${trustWording(candidate.sourceTrust)} · ${candidateStatusWording(candidate.status)}`}
                      </span>
                      <span className="quiet">
                        {`${candidate.proposedByRole || '系统'} 提出 · ${stampOf(candidate.createdAt)}`}
                      </span>
                      {candidate.sourceRefs.length === 0
                        ? <span className="quiet">没有可核验的来源引用。</span>
                        : <span className="quiet">
                          {`来源：${candidate.sourceRefs.map(ref =>
                            `${ref.kind}:${ref.id}${ref.verified ? '' : '（未核验）'}`).join('、')}`}
                        </span>}
                      {candidate.returnedToSessionId !== ''
                        ? <span className="quiet">{`已退回给 ${candidate.returnedToSessionId}，等待补充上下文（被动退回，不唤醒会话）。`}</span>
                        : null}
                      {candidate.reviewNote !== ''
                        ? <span className="quiet">{`审核意见：${candidate.reviewNote}`}</span>
                        : null}
                    </span>
                    {REVIEWABLE_STATES.includes(candidate.status)
                      ? <span className="memory-action">
                        <button type="button" className="action" onClick={() => props.onApprove(candidate)}
                          aria-label={`通过候选 ${candidate.candidateId}`}
                          disabled={props.busy}>通过</button>
                        <button type="button" className="action" onClick={() => props.onReject(candidate)}
                          aria-label={`不采纳候选 ${candidate.candidateId}`}
                          disabled={props.busy}>不采纳</button>
                      </span>
                      : null}
                  </div>
                ))}
              </div>}
        {props.queueState === 'ready' && props.candidates.length > 0
          ? <p className="quiet">{`队列里共 ${props.candidates.length} 条，其中 ${waiting.length} 条等待决定。`}</p>
          : null}
      </div>

      <div className="memory-block">
        <div className="memory-block-head">
          <h3>记忆管理员的审核队列</h3>
          <span className="memory-tag">受限系统角色</span>
        </div>
        <p className="quiet">
          记忆管理员是控制面的受限系统角色，只带四个审核工具：读一条候选、在同一作用域里查已有记忆、提交一个结论、
          把候选退回。它没有文件、命令、网络、派工或发消息的权限；它退回候选时只写入对方的被动队列，不唤醒会话。
        </p>
        {props.reviewState === 'error'
          ? <p className="empty">读取审核队列失败。</p>
          : props.reviewState === 'pending'
            ? <p className="empty">正在读取审核队列……</p>
            : props.reviews.length === 0
              ? <p className="empty">还没有审核记录。</p>
              : <div className="memory-rows">
                {props.reviews.map(review => (
                  <div className="setting" key={review.jobId}>
                    <span>
                      <b>{reviewStateWording(review.state)}</b>
                      <span className="quiet">
                        {`${review.candidateId || '（无候选）'} · ${review.scopeType}:${review.scopeId}`}
                      </span>
                      <span className="quiet">
                        {`${stampOf(review.preparedAt)}${review.finishedAt === '' ? '' : ` · 结束于 ${stampOf(review.finishedAt)}`}`}
                      </span>
                      {review.detail !== '' ? <span className="quiet">{review.detail}</span> : null}
                    </span>
                  </div>
                ))}
              </div>}
      </div>

      <div className="memory-block">
        <div className="memory-block-head">
          <h3>每日巡检</h3>
          <span className="memory-tag">如实记录</span>
        </div>
        <p className="quiet">
          巡检每天在固定时刻检查候选队列和记忆，并把结果写进控制面自己的库。节点离线、重启中断或只做了检查没能处理时，
          记录里写的是真实状态，不会写成「已完成」。
        </p>
        {props.maintenanceState === 'error'
          ? <p className="empty">读取巡检记录失败。</p>
          : props.maintenanceState === 'pending'
            ? <p className="empty">正在读取巡检记录……</p>
            : props.maintenance.length === 0
              ? <p className="empty">还没有巡检记录。</p>
              : <div className="memory-rows">
                {props.maintenance.map(run => (
                  <div className="setting" key={run.runId}>
                    <span>
                      <b>{maintenanceStateWording(run.state)}</b>
                      <span className="quiet">
                        {`${stampOf(run.at)} · 查看 ${run.checked} 条 · 重复 ${run.duplicates} · 冲突 ${run.conflicts} · 冷置 ${run.expired} · 待复核 ${run.stale}`}
                      </span>
                      {run.summary !== '' ? <span className="quiet">{run.summary}</span> : null}
                      {run.nextAt !== '' ? <span className="quiet">{`下次巡检：${stampOf(run.nextAt)}`}</span> : null}
                    </span>
                  </div>
                ))}
              </div>}
        {props.maintenanceState === 'ready' && last !== undefined && last.nextAt !== ''
          ? <p className="quiet">{`下次巡检安排在 ${stampOf(last.nextAt)}。`}</p>
          : null}
        <div className="detail-actions">
          <button type="button" className="action" onClick={props.onInspect} disabled={props.busy}>
            {props.busy ? '正在巡检……' : '立即巡检一次'}
          </button>
        </div>
        <p className="quiet">巡检是操作员的动作：只有控制台连接密钥能运行它，只读密钥只能查看记录。</p>
      </div>

      <div className="memory-block">
        <div className="memory-block-head">
          <h3>已保存的长期记忆</h3>
          <span className="memory-tag">生效中</span>
        </div>
        {props.listState === 'error'
          ? <p className="empty">{`读取长期记忆失败：${props.error}`}</p>
          : props.listState === 'pending'
            ? <p className="empty">正在读取长期记忆……</p>
            : props.memories.length === 0
              ? <p className="empty">还没有生效的长期记忆。</p>
              : <div className="memory-rows">
                {props.memories.map(memory => (
                  <div className="setting" key={memory.memoryId}>
                    <span>
                      <b>{memory.content}</b>
                      <span className="quiet">
                        {`${scopeWording(memory.scopeType, memory.scopeId)} · ${trustWording(memory.sourceTrust)} · 置信度 ${memory.confidence.toFixed(2)}`}
                      </span>
                      <span className="quiet">
                        {`${memory.memoryId} · 最后核验 ${stampOf(memory.lastVerifiedAt)}`}
                      </span>
                      {memory.sourceRefs.length === 0
                        ? <span className="quiet">没有来源引用。</span>
                        : <span className="quiet">
                          {`来源：${memory.sourceRefs.map(ref =>
                            `${ref.kind}:${ref.id}${ref.verified ? '' : '（未核验）'}`).join('、')}`}
                        </span>}
                    </span>
                  </div>
                ))}
              </div>}
        {props.listState === 'ready' && props.memories.length > 0
          ? <p className="quiet">{`共 ${props.memories.length} 条生效中的长期记忆。`}</p>
          : null}
      </div>

      <div className="detail-actions">
        <button type="button" className="action" onClick={props.onOpenProjects}>去项目页记一笔</button>
      </div>
      <p className="quiet">
        「项目 › 项目备忘」里的便签由人维护，不进入候选队列，也不参与这里的检索。遗忘一条记忆的做法还没有定，
        这一页因此不提供删除。
      </p>
    </section>
  )
}

/** The states a candidate may be decided from. */
const REVIEWABLE_STATES: readonly string[] = ['queued', 'reviewing', 'pending_human_confirm']

/** How a candidate's state reads in the console. */
function candidateStatusWording(status: string): string {
  if (status === 'queued') return '等待审核'
  if (status === 'reviewing') return '审核中'
  if (status === 'active') return '已成为长期记忆'
  if (status === 'duplicate') return '与已有记忆重复，已归并'
  if (status === 'superseded') return '已被新版本取代'
  if (status === 'conflict_pending') return '存在冲突，等待确认'
  if (status === 'pending_human_confirm') return '等待人工确认'
  if (status === 'expired_candidate') return '已过期冷置'
  if (status === 'needs_reverify') return '需要复核'
  if (status === 'rejected') return '未被采纳'
  return status
}

/**
 * How a review of the memory manager reads.
 *
 * The wording says what really happened: a job that was prepared but never dispatched is not a review, and a job that
 * was interrupted is not a review that failed — nobody knows how it ended.
 */
function reviewStateWording(state: string): string {
  if (state === 'prepared') return '已准备，尚未派发'
  if (state === 'dispatched') return '审核中'
  if (state === 'completed') return '审核已完成'
  if (state === 'failed') return '审核未完成'
  if (state === 'interrupted') return '审核被中断，结果未知'
  return state
}

/**
 * How a run of the daily inspection reads.
 *
 * A run that did not happen is never worded as a success: an offline node, a switched-off inspection and a run the
 * control plane was interrupted in the middle of all say what they are.
 */
function maintenanceStateWording(state: string): string {
  if (state === 'attempted') return '巡检已开始，结果未知'
  if (state === 'succeeded') return '巡检完成'
  if (state === 'failed') return '巡检未完成'
  if (state === 'skipped_offline') return '节点离线，本轮未运行'
  if (state === 'skipped_no_node') return '没有可用的节点，本轮未运行'
  if (state === 'skipped_disabled') return '巡检已关闭，本轮未运行'
  if (state === 'interrupted') return '巡检被中断，结果未知'
  return state
}

/** What one inspection did, in the console's own words. */
function maintenanceWording(run: MemoryMaintenanceRunView | undefined): string {
  if (run === undefined) return '巡检已运行。'
  return `巡检${maintenanceStateWording(run.state)}：查看 ${run.checked} 条候选，重复 ${run.duplicates}，冲突 ${run.conflicts}。`
}

/** What a decision did, in the console's own words. */
function decisionWording(code: string): string {
  if (code === 'APPROVED') return '已通过：这条候选成为了一条长期记忆。'
  if (code === 'REJECTED') return '未采纳：这条候选不会进入长期记忆。'
  if (code === 'MERGED') return '与已有记忆重复：来源已并入那条记忆，没有新建。'
  if (code === 'CONFLICT_HELD') return '已记为冲突：两边都暂时不生效，等待人工确认。'
  if (code === 'SUPERSEDED') return '已取代旧记忆：旧版本保留溯源，但不再参与召回。'
  return '已完成。'
}

/** How the trust of a fact reads in the console. */
function trustWording(trust: string): string {
  if (trust === 'operator_explicit') return '操作员明确声明'
  if (trust === 'verified_execution') return '已验收的执行结论'
  if (trust === 'external_tainted') return '外部来源（不可信）'
  return trust
}

/** How a scope reads in the console. */
function scopeWording(scopeType: string, scopeId: string): string {
  if (scopeType === 'user_global') return '全局'
  if (scopeType === 'node_env') return `机器 ${scopeId.replace(/^node:/, '')}`
  if (scopeType === 'project') return `项目 ${scopeId.replace(/^project:/, '')}`
  return scopeId
}
