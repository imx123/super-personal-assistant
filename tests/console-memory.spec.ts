/**
 * The console's memory page.
 *
 * The page names what the control plane can see and what it cannot. A capability the control plane does not have is named
 * as absent: the durable history index and the candidate queue do not exist yet, and the console's own log is bounded and
 * must never be shown as a history that can be read back in full.
 *
 * The durable history is shown through its own view, which reads nothing and holds no state: the rows, the filters and the
 * flags are given to it. That is what lets the panel be rendered here, on the server, without a React instance of its own.
 */
import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConsoleProject, EventHistoryEntry, LiveStateSnapshot, MemoryCandidateView, MemoryRecordView,
  Overview } from '../src/console/api.ts'
import { EventHistoryPanel, LiveStatePanel, LongTermMemoryView, MemoryHead, PersistentHistoryView } from '../src/console/memory.tsx'

/** The control plane's own snapshot, as the shell reads it. */
const overview = (over: Partial<Overview> = {}): Overview => ({
  at: '2026-11-19T08:00:00.000Z',
  runningTickets: 2,
  runningWorkers: 1,
  pendingReviews: 1,
  features: { router: true, schedules: true },
  schedules: { plans: 0, enabled: 0, failed: 0, interrupted: 0, delivered: 0 },
  counts: { projects: 1, tickets: 3, sessions: 4, nodes: 1 },
  nodes: [{ nodeId: 'local', backend: 'dsh', version: '0.1.0', online: true, at: '2026-11-19T08:00:00.000Z' }],
  events: { seq: 120, retained: 100 },
  audit: { entries: 7 },
  retention: { eventDays: 7, eventRows: 20000, auditDays: 0 },
  ...over,
})

/** The live state the control plane answered with, as the console reads it. */
const liveState = (over: Partial<LiveStateSnapshot> = {}): LiveStateSnapshot => ({
  at: '2026-11-19T08:05:00.000Z',
  audience: 'operator',
  nodes: { rows: [{ nodeId: 'local', isPrimary: true, connection: 'online', lastSeenAt: '2026-11-19T08:04:00.000Z',
    backends: [{ backendId: 'dsh', kind: 'dsh', availability: 'available',
      capabilities: { turnInterrupt: true, twoStageReceipt: false, sessionResume: true, gitReviewDiff: true } }] }],
    total: 1, omitted: 0 },
  projects: { rows: [{ projectId: 'p1', title: '控制台改造', status: 'active', pmSessionId: 'pm-p1',
    updatedAt: '2026-11-19T07:30:00.000Z' }], total: 1, omitted: 0 },
  tickets: { rows: [{ ticketId: 't1', title: '记忆页', projectId: 'p1', status: 'running', assignmentId: 'a1',
    updatedAt: '2026-11-19T07:30:00.000Z' }], total: 1, omitted: 0 },
  assignments: { rows: [{ assignmentId: 'a1', ticketId: 't1', state: 'running', sessionId: 'worker-a1',
    reportState: 'progress', epoch: 1 }], total: 1, omitted: 0 },
  sessions: { rows: [{ sessionId: 'worker-a1', role: 'worker', status: 'running', projectId: 'p1', ticketId: 't1',
    assignmentId: 'a1', nodeId: 'local', updatedAt: '2026-11-19T07:30:00.000Z' }], total: 1, omitted: 0 },
  schedules: { rows: [{ planId: 's1', projectId: 'p1', name: '每夜巡检', rule: 'daily:02:00', enabled: true,
    nextAt: '2026-11-20T02:00:00.000Z' }], total: 1, omitted: 0 },
  ...over,
})

/** One Project of the business store, with a Ticket of its own. */
const project: ConsoleProject = {
  id: 'p1',
  title: '控制台改造',
  goal: '让操作员看得到状态',
  workspace: '/workspaces/p1',
  status: 'active',
  pmSessionId: 'pm-1',
  createdAt: '2026-11-19T07:00:00.000Z',
  updatedAt: '2026-11-19T07:30:00.000Z',
  tickets: [{ id: 't1', title: '记忆页', status: 'running' }],
}

/** One fact of the durable history, as the control plane's own index holds it. */
const entry: EventHistoryEntry = {
  seq: 1,
  eventId: 'event-1',
  kind: 'dispatch',
  at: '2026-11-19T08:00:00.000Z',
  scopeKey: 'ticket:t1',
  ticketId: 't1',
  projectId: 'p1',
  controlSessionId: '',
  assignmentId: '',
  nodeId: 'local',
  backendId: 'dsh',
  sourceTable: 'assignments',
  sourceId: 'a1',
  sourceSeq: 1,
  summary: 'Worker 开始执行',
  detail: {},
}

const html = (element: ReactElement): string => renderToStaticMarkup(element)

/** One proposal of the queue, as the control plane answered with it. */
const candidate = (over: Partial<MemoryCandidateView> = {}): MemoryCandidateView => ({
  candidateId: 'cand_000000000001',
  scopeType: 'project',
  scopeId: 'project:p1',
  proposedScopeType: 'project',
  proposedScopeId: 'project:p1',
  content: '这个项目统一用 pnpm，不要用 npm。',
  status: 'queued',
  sourceTrust: 'operator_explicit',
  sourceRefs: [{ kind: 'review', id: 'r1', at: '2026-11-19T08:00:00.000Z', summary: '评审通过', verified: true }],
  proposedByRole: 'operator',
  proposedBySessionId: '',
  provisionalSameSession: false,
  revisionCount: 0,
  conflictWithId: '',
  confidence: 0.9,
  importance: 0,
  reviewNote: '',
  createdAt: '2026-11-19T08:00:00.000Z',
  updatedAt: '2026-11-19T08:00:00.000Z',
  reviewedAt: '',
  expiresAt: '2026-12-19T08:00:00.000Z',
  checksum: 'abc123',
  ...over,
})

/** One memory that is in force, as the control plane answered with it. */
const memory = (over: Partial<MemoryRecordView> = {}): MemoryRecordView => ({
  memoryId: 'mem_000000000001',
  scopeType: 'project',
  scopeId: 'project:p1',
  content: '这个项目统一用 pnpm，不要用 npm。',
  status: 'active',
  sourceTrust: 'operator_explicit',
  sourceRefs: [{ kind: 'review', id: 'r1', at: '2026-11-19T08:00:00.000Z', summary: '评审通过', verified: true }],
  supersedesId: '',
  supersededById: '',
  conflictWithId: '',
  pinned: false,
  importance: 0,
  confidence: 0.9,
  utility: 0,
  validFrom: '2026-11-19T08:00:00.000Z',
  lastVerifiedAt: '2026-11-19T08:00:00.000Z',
  deprecatedAt: '',
  createdAt: '2026-11-19T08:00:00.000Z',
  updatedAt: '2026-11-19T08:00:00.000Z',
  nodeId: 'local',
  backendId: 'dsh',
  checksum: 'def456',
  ...over,
})

/**
 * The long-term memory's own view, with the facts a control plane that answered would give it.
 *
 * It is rendered on its own: the view holds no state of its own, so the markup it shows is the markup it was given.
 */
const longTerm = (over: Partial<ComponentProps<typeof LongTermMemoryView>> = {}): ReactElement =>
  createElement(LongTermMemoryView, {
    candidates: over.candidates ?? [],
    memories: over.memories ?? [],
    queueState: over.queueState ?? 'ready',
    listState: over.listState ?? 'ready',
    error: over.error ?? '',
    busy: over.busy ?? false,
    message: over.message ?? '',
    actionError: over.actionError ?? '',
    content: over.content ?? '',
    scope: over.scope ?? 'user_global|global',
    scopeOptions: over.scopeOptions ?? [
      { value: 'user_global|global', label: '全局偏好（跨项目）' },
      { value: 'project|project:p1', label: '项目：控制台改造' },
    ],
    onContentChange: over.onContentChange ?? (() => {}),
    onScopeChange: over.onScopeChange ?? (() => {}),
    onSubmit: over.onSubmit ?? (() => {}),
    onApprove: over.onApprove ?? (() => {}),
    onReject: over.onReject ?? (() => {}),
    onOpenProjects: over.onOpenProjects ?? (() => {}),
  })

/**
 * The durable history's own view, with the facts a control plane that answered would give it.
 *
 * It is rendered on its own: the view holds no state of its own, so the markup it shows is the markup it was given.
 */
const durable = (over: Partial<ComponentProps<typeof PersistentHistoryView>> = {}): ReactElement =>
  createElement(PersistentHistoryView, {
    projects: over.projects ?? [],
    standaloneTickets: over.standaloneTickets ?? [],
    projectId: over.projectId ?? '',
    ticketId: over.ticketId ?? '',
    state: over.state ?? 'pending',
    rows: over.rows ?? [],
    total: over.total ?? 0,
    coverage: over.coverage,
    error: over.error ?? '',
    moreError: over.moreError ?? '',
    busy: over.busy ?? false,
    hasMore: over.hasMore ?? false,
    onProjectChange: over.onProjectChange ?? (() => {}),
    onTicketChange: over.onTicketChange ?? (() => {}),
    onClear: over.onClear ?? (() => {}),
    onLoadMore: over.onLoadMore ?? (() => {}),
  })

/** The history panel with the facts a control plane that answered would give it. */
const history = (over: Partial<ComponentProps<typeof EventHistoryPanel>> = {}): ReactElement =>
  createElement(EventHistoryPanel, {
    projects: over.projects ?? { state: 'ready' as const, rows: [] },
    events: over.events ?? { state: 'ready' as const, rows: [] },
    gap: over.gap ?? false,
    retained: over.retained ?? 100,
    retention: over.retention ?? { eventDays: 7, eventRows: 20000, auditDays: 0 },
    onOpenProject: over.onOpenProject ?? (() => {}),
    durable: over.durable ?? durable(),
  })

describe('the memory page', () => {
  it('says when the facts were read and whether the stream is carrying new ones', () => {
    const connected = html(createElement(MemoryHead, { overview: overview(), stream: 'connected', refresh: () => {} }))
    expect(connected).toContain('读取时间')
    expect(connected).toContain('2026')
    expect(connected).toContain('事件流已连接')

    const reconnecting = html(createElement(MemoryHead, { overview: overview(), stream: 'reconnecting', refresh: () => {} }))
    expect(reconnecting).toContain('事件流重连中')
    expect(reconnecting).not.toContain('事件流已连接')

    const unknown = html(createElement(MemoryHead, { overview: undefined, stream: undefined, refresh: () => {} }))
    expect(unknown).toContain('事件流状态未知')
  })

  it('shows the live state the control plane answered with', () => {
    const page = html(createElement(LiveStatePanel, { snapshot: liveState(), navigate: () => {} }))
    expect(page).toContain('取样时间')
    expect(page).toContain('在线')
    expect(page).toContain('local')
    expect(page).toContain('控制台改造')
    expect(page).toContain('记忆页')
    expect(page).toContain('每夜巡检')
  })

  it('says that a read which has not answered is not an empty state', () => {
    const page = html(createElement(LiveStatePanel, { navigate: () => {} }))
    expect(page).toContain('正在读取实时状态')
    expect(page).not.toContain('控制面还没有登记任何节点')
  })

  it('says that a node it never heard of is unknown, not offline', () => {
    const page = html(createElement(LiveStatePanel, {
      snapshot: liveState({ nodes: { rows: [], total: 0, omitted: 0 } }),
      navigate: () => {},
    }))
    expect(page).toContain('控制面还没有登记任何节点')
    expect(page).not.toContain('离线')
  })

  it('says a node it cannot place is of an unknown state, not an online one', () => {
    const page = html(createElement(LiveStatePanel, {
      snapshot: liveState({ nodes: { rows: [{ nodeId: 'other', isPrimary: false, connection: 'unknown',
        backends: [{ backendId: 'dsh', kind: 'dsh', availability: 'unknown',
          capabilities: { turnInterrupt: false, twoStageReceipt: false, sessionResume: false, gitReviewDiff: false } }] }],
        total: 1, omitted: 0 } }),
      navigate: () => {},
    }))
    expect(page).toContain('状态未知')
    expect(page).not.toContain('在线')
  })

  it('never leaves an old value looking like the present one after a failed read', () => {
    const page = html(createElement(LiveStatePanel, { snapshot: liveState(), error: 'HTTP 500', navigate: () => {} }))
    expect(page).toContain('读取实时状态失败')
    expect(page).toContain('不是现在的状态')
    expect(page).toContain('刷新')
  })

  it('says the facts may not be the newest while the event stream is not connected', () => {
    const page = html(createElement(LiveStatePanel, { snapshot: liveState(), stream: 'reconnecting', navigate: () => {} }))
    expect(page).toContain('事件流未连接')
    expect(page).toContain('可能不是最新的')
  })

  it('says how many rows a cut list left out', () => {
    const page = html(createElement(LiveStatePanel, {
      snapshot: liveState({ tickets: { rows: [{ ticketId: 't1', title: '记忆页', status: 'running',
        updatedAt: '2026-11-19T07:30:00.000Z' }], total: 12, omitted: 11 } }),
      navigate: () => {},
    }))
    expect(page).toContain('另有 11 条没有显示')
    expect(page).toContain('共 12 条')
  })

  it('offers a way into the work it lists', () => {
    const page = html(createElement(LiveStatePanel, { snapshot: liveState(), navigate: () => {} }))
    expect(page).toContain('打开')
    expect(page).toContain('去项目')
    expect(page).toContain('去节点部署')
  })

  it('shows the Projects of the business store and offers to open one of them', () => {
    const page = html(history({ projects: { state: 'ready', rows: [project] } }))
    expect(page).toContain('控制台改造')
    expect(page).toContain('1 个工单')
    expect(page).toContain('打开')
  })

  it('shows the durable history as its own block, apart from the console log', () => {
    const page = html(history())
    expect(page).toContain('持久事件历史')
    expect(page).toContain('控制台短期日志')
    expect(page).toContain('不按天数裁剪')
    // The two kinds of record are never presented as one: the log is the log, and it says so.
    expect(page).toContain('不是持久历史')
  })

  it('never says the durable history does not exist', () => {
    const page = html(history())
    expect(page).not.toContain('还没有建立')
  })

  it('says that a read of the durable history which has not answered is not an empty list', () => {
    const page = html(history())
    expect(page).toContain('正在读取持久事件历史')
    expect(page).not.toContain('这个范围里还没有记录到事实')
  })

  it('names the console log as a bounded log and says how much of it is left', () => {
    const page = html(history())
    expect(page).toContain('不是持久历史')
    expect(page).toContain('最多保留 20000 行 / 7 天')
    expect(page).toContain('现在保留 100 行')
    expect(page).toContain('永久保留')
  })

  it('does not guess how many rows were dropped', () => {
    const page = html(history())
    expect(page).not.toMatch(/\d+ 行已经被裁掉/)
  })

  it('reports a hole in front of the log instead of hiding it', () => {
    const page = html(history({ gap: true }))
    expect(page).toContain('这段之前的事件已被裁剪，无法补读')
  })

  it('shows no gap when the control plane did not report one', () => {
    const page = html(history({ gap: false }))
    expect(page).not.toContain('无法补读')
  })

  it('says that a read which has not answered is not an empty list', () => {
    const page = html(history({
      projects: { state: 'pending' },
      events: { state: 'pending' },
    }))
    expect(page).toContain('正在读取项目')
    expect(page).toContain('正在读取事件日志')
    expect(page).not.toContain('还没有项目')
    expect(page).not.toContain('暂时没有可读的记录')
  })

  it('shows why a read failed instead of an empty list', () => {
    const page = html(history({
      projects: { state: 'error', error: 'HTTP 500' },
      events: { state: 'error', error: 'HTTP 500' },
    }))
    expect(page).toContain('HTTP 500')
    expect(page).not.toContain('还没有项目')
  })

  it('shows at most the last twelve rows of the log', () => {
    const events = Array.from({ length: 20 }, (_, index) => ({
      seq: index + 1,
      at: '2026-11-19T08:00:00.000Z',
      type: 'session.event',
      kind: 'message',
      sessionId: 's1',
      nodeId: 'local',
    }))
    const page = html(history({ events: { state: 'ready', rows: events } }))
    expect(page).toContain('序号 20')
    expect(page).not.toContain('序号 8')
  })

  it('points at the manual notes and no longer says the service is missing', () => {
    const page = html(longTerm())
    expect(page).not.toContain('长期记忆服务与候选队列还没有建立')
    expect(page).toContain('项目 › 项目备忘')
    expect(page).toContain('去项目页记一笔')
  })

  it('does not repeat the five objects of the memory system in the console', () => {
    const page = html(longTerm())
    expect(page).not.toContain('五类对象')
    expect(page).not.toContain('P5-')
  })
})

describe('the long-term memory panel', () => {
  it('says that a read which has not answered is not an empty queue', () => {
    const page = html(longTerm({ queueState: 'pending', listState: 'pending' }))
    expect(page).toContain('正在读取候选队列')
    expect(page).toContain('正在读取长期记忆')
    expect(page).not.toContain('队列里还没有候选')
    expect(page).not.toContain('还没有生效的长期记忆')
  })

  it('says that a read which answered with no rows holds no rows', () => {
    const page = html(longTerm())
    expect(page).toContain('队列里还没有候选')
    expect(page).toContain('还没有生效的长期记忆')
  })

  it('says why a read failed instead of an empty list', () => {
    const page = html(longTerm({ queueState: 'error', listState: 'error', error: 'HTTP 500' }))
    expect(page).toContain('读取候选队列失败：HTTP 500')
    expect(page).toContain('读取长期记忆失败：HTTP 500')
    expect(page).not.toContain('队列里还没有候选')
  })

  it('shows a proposal with its scope, its trust, its state and its sources', () => {
    const page = html(longTerm({ candidates: [candidate()] }))
    expect(page).toContain('这个项目统一用 pnpm')
    expect(page).toContain('项目 p1')
    expect(page).toContain('操作员明确声明')
    expect(page).toContain('等待审核')
    expect(page).toContain('来源：review:r1')
  })

  it('offers the decision a person takes about a proposal that waits', () => {
    const page = html(longTerm({ candidates: [candidate()] }))
    expect(page).toContain('通过')
    expect(page).toContain('退回')
  })

  it('offers no decision about a proposal that has already been decided', () => {
    const page = html(longTerm({
      candidates: [candidate({ status: 'active' })],
    }))
    expect(page).toContain('已成为长期记忆')
    expect(page).not.toContain('>通过</button>')
    expect(page).not.toContain('>退回</button>')
  })

  it('says that a source the control plane could not check is unverified', () => {
    const page = html(longTerm({
      candidates: [candidate({ sourceRefs: [{ kind: 'ticket', id: 't9', at: '', summary: '', verified: false }] })],
    }))
    expect(page).toContain('ticket:t9（未核验）')
  })

  it('shows the memories that are in force with their own id and last verification', () => {
    const page = html(longTerm({ memories: [memory()] }))
    expect(page).toContain('这个项目统一用 pnpm')
    expect(page).toContain('mem_000000000001')
    expect(page).toContain('最后核验')
  })

  it('says what the last decision did, and says why it failed', () => {
    const done = html(longTerm({ message: '已通过：这条候选成为了一条长期记忆。' }))
    expect(done).toContain('已通过：这条候选成为了一条长期记忆。')
    const failed = html(longTerm({ actionError: 'HTTP 409' }))
    expect(failed).toContain('操作失败：HTTP 409')
  })

  it('offers the scopes a proposal may be made for', () => {
    const page = html(longTerm())
    expect(page).toContain('全局偏好（跨项目）')
    expect(page).toContain('项目：控制台改造')
    expect(page).toContain('提交候选')
  })

  it('does not offer a way to forget a memory, because that is not decided yet', () => {
    const page = html(longTerm({ memories: [memory()] }))
    expect(page).toContain('遗忘一条记忆的做法还没有定')
    expect(page).not.toContain('>遗忘</button>')
    expect(page).not.toContain('>删除</button>')
  })
})

describe('the durable history panel', () => {
  it('offers the exact-key filters the control plane really holds', () => {
    const page = html(durable({
      projects: [project],
      standaloneTickets: [{ id: 't-standalone', title: '独立工单', status: 'running' }],
    }))
    expect(page).toContain('全部项目')
    expect(page).toContain('控制台改造')
    expect(page).toContain('全部工单')
    expect(page).toContain('独立工单')
    expect(page).toContain('清除筛选')
  })

  it('offers only the Tickets of the Project the person chose', () => {
    const page = html(durable({
      projects: [project],
      standaloneTickets: [{ id: 't-standalone', title: '独立工单', status: 'running' }],
      projectId: 'p1',
    }))
    expect(page).toContain('记忆页')
    expect(page).not.toContain('独立工单')
  })

  it('says that a read which has not answered is not an empty range', () => {
    const page = html(durable({ state: 'pending' }))
    expect(page).toContain('正在读取持久事件历史')
    expect(page).not.toContain('这个范围里还没有记录到事实')
  })

  it('says that a range which holds no record holds no record', () => {
    const page = html(durable({ state: 'ready' }))
    expect(page).toContain('这个范围里还没有记录到事实')
  })

  it('says why the read failed instead of an empty range', () => {
    const page = html(durable({ state: 'error', error: 'HTTP 500' }))
    expect(page).toContain('读取持久事件历史失败：HTTP 500')
  })

  it('shows each fact with its own kind, its summary and where it came from', () => {
    const page = html(durable({ state: 'ready', rows: [entry], total: 1 }))
    expect(page).toContain('派工')
    expect(page).toContain('Worker 开始执行')
    expect(page).toContain('工单 t1')
    expect(page).toContain('来源 assignments')
  })

  it('says how many facts the range holds and how many are on the screen', () => {
    const page = html(durable({ state: 'ready', rows: [entry], total: 12 }))
    expect(page).toContain('这个范围里共 12 条事实，显示了 1 条。')
  })

  it('offers the next page of the range while one follows it', () => {
    const page = html(durable({ state: 'ready', rows: [entry], total: 12, hasMore: true }))
    expect(page).toContain('加载更多')
  })

  it('offers no next page when the range is complete', () => {
    const page = html(durable({ state: 'ready', rows: [entry], total: 1 }))
    expect(page).not.toContain('加载更多')
  })

  it('says that a page is on its way while it is being read', () => {
    const page = html(durable({ state: 'ready', rows: [entry], total: 12, hasMore: true, busy: true }))
    expect(page).toContain('正在读取……')
  })

  it('keeps the first page and offers the next one again when a page failed', () => {
    const page = html(durable({
      state: 'ready', rows: [entry], total: 12, hasMore: true, moreError: 'HTTP 500',
    }))
    expect(page).toContain('加载更多失败：HTTP 500')
    // The rows that are already on the screen stay: a page that failed takes nothing away.
    expect(page).toContain('Worker 开始执行')
    // The next page may be asked for again.
    expect(page).toContain('>加载更多</button>')
  })

  it('says how far back the history reaches', () => {
    const page = html(durable({
      state: 'ready',
      rows: [entry],
      total: 1,
      coverage: { since: '2026-11-01T00:00:00.000Z', kinds: ['dispatch'], trimmed: false,
        retention: '索引不按天数或行数裁剪，也不自动删除' },
    }))
    expect(page).toContain('最早一条是')
    expect(page).toContain('索引开始之前的事实没有记录，也补不回来')
  })
})
