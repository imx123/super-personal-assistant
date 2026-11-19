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
import type { ConsoleProject, EventHistoryEntry, LiveStateSnapshot, MemoryCandidateView, MemoryMaintenanceRunView,
  MemorySearchHitView, MemorySearchPage,
  MemoryRecordView, MemoryReviewRunView, Overview } from '../src/console/api.ts'
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
  reevaluations: 0,
  returnedToSessionId: '',
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

/** One review the memory manager was woken for, as the control plane answered with it. */
const review = (over: Partial<MemoryReviewRunView> = {}): MemoryReviewRunView => ({
  runId: 'memrun-1',
  jobId: 'memjob-1',
  kind: 'review',
  candidateId: 'cand_000000000001',
  checksum: 'abc123',
  scopeType: 'project',
  scopeId: 'project:p1',
  sourceKeys: ['review:r1'],
  sessionId: 'memory-manager',
  nodeId: 'local',
  backendId: 'dsh',
  generation: '7',
  state: 'dispatched',
  detail: '',
  preparedAt: '2026-11-19T08:00:00.000Z',
  updatedAt: '2026-11-19T08:00:00.000Z',
  finishedAt: '',
  expiresAt: '2026-11-19T08:05:00.000Z',
  ...over,
})

/** One run of the daily inspection, as the control plane answered with it. */
const maintenance = (over: Partial<MemoryMaintenanceRunView> = {}): MemoryMaintenanceRunView => ({
  runId: 'mem-maint-20261119080000',
  at: '2026-11-19T08:00:00.000Z',
  state: 'succeeded',
  nodeId: 'local',
  backendId: 'dsh',
  checked: 3,
  duplicates: 1,
  conflicts: 0,
  expired: 2,
  stale: 1,
  summary: '查看了 3 条候选。',
  detail: '',
  nextAt: '2026-11-20T08:00:00.000Z',
  preparedAt: '2026-11-19T08:00:00.000Z',
  finishedAt: '2026-11-19T08:00:05.000Z',
  ...over,
})

/** One hit of the memory search, as the control plane answered with it. */
const searchHit = (over: Partial<MemorySearchHitView> = {}): MemorySearchHitView => ({
  memoryId: 'mem_000000000001',
  scopeType: 'project',
  scopeId: 'project:p1',
  content: '这个项目统一用 pnpm，不要用 npm。',
  confidence: 0.9,
  importance: 0,
  utility: 0,
  freshness: 1,
  score: 0.42,
  lastVerifiedAt: '2026-11-19T08:00:00.000Z',
  sourceTrust: 'operator_explicit',
  sourceRefs: [{ kind: 'review', id: 'r1', at: '2026-11-19T08:00:00.000Z', summary: '评审通过', verified: true }],
  conflictWarning: false,
  staleWarning: false,
  tainted: false,
  pinned: false,
  breakdown: {
    relevance: 0.6,
    lexical: 0.5,
    vector: 0,
    coverage: 1,
    priority: 0.575,
    importance: 0,
    confidence: 0.9,
    freshness: 1,
    utility: 0,
    weights: { importance: 0.35, confidence: 0.25, freshness: 0.25, utility: 0.15 },
  },
  reasons: ['相关性 0.60（关键词 0.50，命中 100% 的词）', '内在优先级 0.58（重要性 0.00、置信度 0.90、新鲜度 1.00、效用 0.00）'],
  ...over,
})

/** The answer of the memory search, as the control plane gave it. */
const search = (over: Partial<MemorySearchPage> = {}): MemorySearchPage => ({
  hits: [searchHit()],
  degraded: false,
  degradedReason: '',
  asOf: '2026-11-19T08:00:00.000Z',
  considered: 4,
  minRelevance: 0.3,
  weights: { importance: 0.35, confidence: 0.25, freshness: 0.25, utility: 0.15 },
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
    reviews: over.reviews ?? [],
    reviewState: over.reviewState ?? 'ready',
    maintenance: over.maintenance ?? [],
    maintenanceState: over.maintenanceState ?? 'ready',
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
    onInspect: over.onInspect ?? (() => {}),
    searchQuery: over.searchQuery ?? '',
    search: over.search,
    searchState: over.searchState ?? 'idle',
    searchError: over.searchError ?? '',
    onSearchQueryChange: over.onSearchQueryChange ?? (() => {}),
    onSearch: over.onSearch ?? (() => {}),
    onClearSearch: over.onClearSearch ?? (() => {}),
    onDispute: over.onDispute ?? (() => {}),
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
    // The manual decision is "not adopted"; the passive return is a different thing and says so.
    expect(page).toContain('不采纳')
    expect(page).not.toContain('>退回</button>')
  })

  it('offers no decision about a proposal that has already been decided', () => {
    const page = html(longTerm({
      candidates: [candidate({ status: 'active' })],
    }))
    expect(page).toContain('已成为长期记忆')
    expect(page).not.toContain('>通过</button>')
    expect(page).not.toContain('>不采纳</button>')
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

  it('shows the candidates that wait for a person apart, and offers the decision there', () => {
    const page = html(longTerm({ candidates: [candidate({ status: 'pending_human_confirm' })] }))
    expect(page).toContain('等待人工确认')
    expect(page).toContain('只有人能决定')
    expect(page).toContain('不采纳')
  })

  it('says that no candidate waits for a person when none does', () => {
    const page = html(longTerm({ candidates: [candidate({ status: 'queued' })] }))
    expect(page).toContain('没有等待人工确认的候选')
  })

  it('names a passive return as what it is, apart from the manual decision', () => {
    const page = html(longTerm({ candidates: [candidate({ status: 'reviewing', revisionCount: 1,
      returnedToSessionId: 'router' })] }))
    expect(page).toContain('已退回给 router')
    expect(page).toContain('被动退回，不唤醒会话')
  })

  it('shows the review queue of the memory manager as it really stands', () => {
    const page = html(longTerm({ reviews: [review({ state: 'dispatched' })] }))
    expect(page).toContain('记忆管理员的审核队列')
    expect(page).toContain('审核中')
    expect(page).toContain('cand_000000000001')
  })

  it('says that a review which has not answered is not an empty queue', () => {
    const page = html(longTerm({ reviewState: 'pending' }))
    expect(page).toContain('正在读取审核队列')
    expect(page).not.toContain('还没有审核记录')
  })

  it('shows the inspection that really ran and when the next one is due', () => {
    const page = html(longTerm({ maintenance: [maintenance()] }))
    expect(page).toContain('每日巡检')
    expect(page).toContain('巡检完成')
    expect(page).toContain('下次巡检')
    expect(page).toContain('立即巡检一次')
  })

  it('says that an inspection which did not run did not run', () => {
    const page = html(longTerm({ maintenance: [maintenance({ state: 'skipped_offline' })] }))
    expect(page).toContain('节点离线，本轮未运行')
    expect(page).not.toContain('巡检完成')
  })

  it('says that an inspection which has not answered is not an empty record', () => {
    const page = html(longTerm({ maintenanceState: 'pending' }))
    expect(page).toContain('正在读取巡检记录')
    expect(page).not.toContain('还没有巡检记录')
  })
})

describe('the search of the long-term memory', () => {
  it('offers the words to look for and the two ways out of the search', () => {
    const page = html(longTerm({ searchQuery: 'pnpm' }))
    expect(page).toContain('检索长期记忆')
    expect(page).toContain('id="memory-search-query"')
    expect(page).toContain('value="pnpm"')
    expect(page).toContain('检索')
    expect(page).toContain('清除')
    // The search is a read: nothing about it writes a memory.
    expect(page).not.toContain('>遗忘</button>')
  })

  it('shows what the search found, with its scope, its sources and the reasons of its score', () => {
    const page = html(longTerm({ search: search(), searchState: 'ready', searchQuery: 'pnpm' }))
    expect(page).toContain('这个项目统一用 pnpm，不要用 npm。')
    expect(page).toContain('项目 p1')
    expect(page).toContain('来源：review:r1')
    expect(page).toContain('相关性 0.60')
    expect(page).toContain('内在优先级 0.58')
    expect(page).toContain('mem_000000000001')
    expect(page).toContain('在 4 条候选记忆中命中 1 条')
  })

  it('shows the relevance floor and the weights the search really ran with', () => {
    const page = html(longTerm({ search: search(), searchState: 'ready', searchQuery: 'pnpm' }))
    expect(page).toContain('相关度门槛 0.30')
    expect(page).toContain('重要性 0.35')
    expect(page).toContain('置信度 0.25')
    expect(page).toContain('新鲜度 0.25')
    expect(page).toContain('效用 0.15')
  })

  it('says that a memory which waits for a new verification and one that came from outside say so', () => {
    const page = html(longTerm({
      search: search({ hits: [searchHit({ staleWarning: true, tainted: true, conflictWarning: true })] }),
      searchState: 'ready',
      searchQuery: 'pnpm',
    }))
    expect(page).toContain('待核验时效')
    expect(page).toContain('存在未决冲突，已降权')
  })

  it('says that a search which has not answered is not an empty answer', () => {
    const page = html(longTerm({ searchState: 'pending', searchQuery: 'pnpm' }))
    expect(page).toContain('正在检索长期记忆')
    expect(page).not.toContain('没有匹配的记忆')
  })

  it('says why a search failed instead of showing nothing', () => {
    const page = html(longTerm({ searchState: 'error', searchError: 'HTTP 500' }))
    expect(page).toContain('检索失败：HTTP 500')
    expect(page).not.toContain('没有匹配的记忆')
  })

  it('says that a search which answered with no rows holds no rows', () => {
    const page = html(longTerm({ search: search({ hits: [] }), searchState: 'ready', searchQuery: 'pnpm' }))
    expect(page).toContain('没有匹配的记忆')
  })

  it('says that the search fell back when a path was not there', () => {
    const page = html(longTerm({
      search: search({ degraded: true, degradedReason: '没有配置向量编码接口，检索退回关键词路径。' }),
      searchState: 'ready',
      searchQuery: 'pnpm',
    }))
    expect(page).toContain('检索已降级')
    expect(page).toContain('没有配置向量编码接口')
  })

  it('offers the person to say that a memory misled somebody', () => {
    const page = html(longTerm({ search: search(), searchState: 'ready', searchQuery: 'pnpm' }))
    expect(page).toContain('标为误导')
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
