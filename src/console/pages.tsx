/**
 * The console's pages.
 *
 * Every number, name and state on them comes from the control plane's own API: the pages read the facts the kernel
 * derives and show them. A capability the control plane does not have yet is named as such, so the console never fills a
 * gap with an example.
 *
 * The writes here are the operator's own: they go through the control plane's routes, which use the domain's own
 * primitives. The console never acts as a PM — accepting a Worker's result stays the PM's own decision, and the browser
 * has no button for it.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  messageOf, put, read, remove, write, type AuditEntry, type ConsoleProject, type ConsoleTicket,
  type CoordinationDelivery, type DenialAuthorization, type DenialReview, type FastRouteReceipt, type NodeView, type Overview,
  type ProjectGateRecord, type ProjectMemoryEntry, type ReconcileFinding, type ReconcileRun, type RouterHandoffRecord,
  type RouterQueueEntry, type RouterState, type ScheduleCounts, type SchedulePlan, type ScheduleRun, type SessionMessage,
  type SessionView, type StopNotice,
} from './api.ts'
import { Icon } from './icons.tsx'
import { Markdown } from './markdown.tsx'
import { modelKey, readPreferences } from './preferences.ts'
import { ROUTER_ATTACHMENT_BYTES, ROUTER_ATTACHMENT_COUNT, type RouterModel,
  type RouterOptions, type RouterTextAttachment } from '../shared/protocol.ts'

/** What a page is told about the console around it. */
export interface PageProps {
  /** Changes whenever the control plane recorded something, so the page reads its facts again. */
  revision: number
  /**
   * Read the page's facts again, now.
   *
   * An action the control plane carried out does not always leave an event behind — a note written to a Project's
   * memory is one — and a page that waits for the next event would show a state that is already out of date. This is
   * the way a page asks for its own facts again after an action it started.
   */
  refresh: () => void
  /**
   * Go to another page.
   *
   * `where` names what the page should show first: the home page sends `failed` to the scheduled tasks, so the cell of
   * failures leads to the tasks that actually failed.
   */
  navigate: (page: string, where?: string) => void
  /**
   * What the page should show first, as the last navigation asked for.
   *
   * It is empty unless a person came from a cell that points at something — the home page's failure cell sends `failed`.
   */
  focus?: string
  /** Forget the control-plane key and go back to the sign-in. */
  signOut: () => void
}

/**
 * Load one thing, and again whenever the control plane recorded something.
 *
 * `key` names what the load is about: a page that shows one Session's messages reads them again when the person picks
 * another Session, not only when the control plane recorded something.
 */
export function useLoaded<T>(load: () => Promise<T>, revision: number, key?: string): { data: T | undefined; error: string } {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    load().then(value => {
      if (cancelled) return
      setData(value)
      setError('')
    }).catch((reason: unknown) => {
      if (!cancelled) setError(messageOf(reason))
    })
    return () => { cancelled = true }
  }, [revision, key])
  return { data, error }
}

/** What an operator action leaves behind: whether it is running, and what it said. */
interface ActionState {
  busy: boolean
  message: string
  error: string
}

/**
 * Run one operator action and keep what it left behind.
 *
 * The work is a callback, not a promise: the action is marked busy before the request starts, so a request can never
 * begin before the page knows it is running — and a second click cannot start a second one.
 *
 * A refused action shows the control plane's own reason: the domain's rules are the ones that refuse, and the console
 * does not replace their words with its own. The wording of a success may depend on the answer, because an answer that
 * says "not confirmed" is not a success.
 *
 * `onSuccess` runs after an action that worked, so the page reads its facts again: an action that leaves no event
 * behind would otherwise keep the old facts on screen until something else happened.
 */
export function useAction(onSuccess?: () => void): {
  state: ActionState
  run: (work: () => Promise<unknown>, done?: string | ((result: unknown) => string)) => void
} {
  const [state, setState] = useState<ActionState>({ busy: false, message: '', error: '' })
  const run = (work: () => Promise<unknown>, done: string | ((result: unknown) => string) = '已完成'): void => {
    setState({ busy: true, message: '', error: '' })
    void work().then(
      (result: unknown) => {
        onSuccess?.()
        setState({ busy: false,
          message: typeof done === 'function' ? done(result) : done, error: '' })
      },
      (reason: unknown) => setState({ busy: false, message: '', error: messageOf(reason) }),
    )
  }
  return { state, run }
}

/**
 * The wording of a message that the control plane delivered to a Session, as the answer says it went.
 *
 * The answer waits for the node's own confirmation, so `running` really means the Worker has the message. A message the
 * node refused never comes back as a success: the server answers with an error instead, and the console shows it as one.
 */
export function deliveredWording(result: unknown): string {
  const value = result as { via?: string; delivered?: string }
  if (value.via !== 'ticket') return '消息已发出'
  if (value.delivered === 'running') return '消息已送达 Worker'
  if (value.delivered === 'started') return '消息已排队：Worker 启动后会读到它'
  if (value.delivered === 'failed') return '消息未送达 Worker'
  return '消息已排队：Worker 恢复后会读到它'
}

/**
 * The wording of a pause, which says what the pause did to the Project's Workers.
 *
 * The pause is written either way, so the answer says so; a Worker the node did not confirm as stopped is named, with the
 * reason the control plane has, instead of being counted as stopped.
 */
export function pauseWording(result: unknown): string {
  const value = result as { workers?: { stopped?: string[]; failures?: { ticketId: string; error: string }[] } }
  const workers = value.workers
  const failures = workers?.failures ?? []
  const stopped = workers?.stopped ?? []
  if (failures.length > 0) {
    const details = failures.map(({ ticketId, error }) => `${ticketId}（${error}）`).join('、')
    return `项目已暂停。有 ${failures.length} 个 Worker 未确认停止。${details}`
  }
  if (stopped.length > 0) return `项目已暂停，${stopped.length} 个 Worker 已停止`
  return '项目已暂停'
}

/** The wording of a stop the node may or may not have confirmed. */
function stoppedWording(result: unknown): string {
  const value = result as { cancelled?: boolean; stopped?: boolean; error?: string }
  if (value.cancelled === true || value.stopped === true) return 'Worker 已停止'
  return `Worker 未确认停止${value.error === undefined ? '' : `：${value.error}`}`
}

/**
 * The wording of a cancel of a whole Ticket.
 *
 * The scope is part of the answer: the Ticket is over, and the other Tickets and Workers of the Project are not.
 */
function ticketStoppedWording(result: unknown): string {
  const value = result as { stopped?: boolean; confirmed?: boolean; error?: string }
  if (value.stopped !== true) return `工单未确认结束${value.error === undefined ? '' : `：${value.error}`}`
  return '工单已结束（同一项目的其他工单与 Worker 不受影响）'
}

/**
 * The wording of a stop of a PM or Router Session.
 *
 * The scope is part of the answer: a PM that was stopped is only that PM, and a Router that was stopped is only that
 * Router. The words say so, because the operator has to know that the Project and its Tickets are untouched.
 */
function sessionStoppedWording(result: unknown): string {
  const value = result as { stopped?: boolean; scope?: string; error?: string }
  if (value.stopped !== true) return `会话未确认停止${value.error === undefined ? '' : `：${value.error}`}`
  if (value.scope === 'assignment') return '派工已停止，工单仍然开着'
  return '会话已停止（只停这一个会话）'
}

/**
 * The wording of an interrupt.
 *
 * The node's own answer decides: a turn that was not interrupted says why, and a turn that was names the turn it was.
 */
function interruptedWording(result: unknown): string {
  const value = result as { interrupted?: boolean; turn?: number; error?: string }
  if (value.interrupted !== true) return `未打断当前回合${value.error === undefined ? '' : `：${value.error}`}`
  return value.turn === undefined ? '当前回合已打断' : `第 ${value.turn} 回合已打断`
}

/**
 * The wording of a message a person sent to the Router.
 *
 * A message that waits says so, and a message the node refused says why: the queue shows the same facts, and the line
 * under the composer must not claim more than the control plane knows. An interruption and a message are two facts, and
 * the wording names both. A message the Fast Router claimed never reached the Router at all, and the wording says what
 * became of it instead of claiming a delivery to a model that never read it.
 */
function routerSendWording(result: unknown): string {
  const value = result as { queue?: { state?: string; error?: string }; delivered?: string
    interrupt?: { interrupted?: boolean }; routing?: FastRouteReceipt }
  if (value.routing !== undefined) return routingWording(value.routing)
  const state = value.queue?.state ?? value.delivered
  if (state === 'failed') {
    return `消息发送失败${value.queue?.error === undefined ? '' : `：${value.queue.error}`}`
  }
  if (state === 'unconfirmed') {
    return `节点未确认消息是否送达${value.queue?.error === undefined ? '' : `：${value.queue.error}`}`
  }
  if (state === 'routed') return '消息已由快路由直接处理，没有进入 Router 对话'
  if (value.interrupt?.interrupted === true) {
    return state === 'sent' || state === 'read'
      ? '已打断当前回合，消息已交给下一轮'
      : '已打断当前回合，消息已排队交给下一轮'
  }
  if (state === 'queued' || state === 'sending') return '消息已排队，当前回合结束后自动交给下一轮'
  return '消息已送达 Router'
}

/** What a routing did, as the console's own words. */
const ROUTE_OUTCOME: Record<string, string> = {
  existing_ticket: '续接独立工单',
  existing_project_pm: '交给项目 PM',
  standalone_ticket: '派了独立工单',
  read_only: '按权威记录回答',
  escalate: '规则未动手',
  ordinary_reply: '普通对话',
}

/** How far a routing got, as the console's own words. */
const ROUTE_STAGE: Record<string, string> = {
  accepted: '已认领，待处理',
  routing: '正在路由',
  queued: '待送达',
  assigned: '目标已确认接收',
  escalated: '已交给高层 Router',
  model: '由模型处理',
  failed: '失败',
  unconfirmed: '未确认',
}

/** What a decision of the Project Gate became, as the console's own words. */
const GATE_OUTCOME: Record<string, string> = {
  created: '已建项目',
  refused: '未建项目',
  failed: '建项目失败',
  creating: '正在建项目',
}

/**
 * Which kind of handoff it was, as the console's own words.
 *
 * The two are told apart because they mean different things: one is the Router's own decision about work that belonged
 * to a Project, and the other is the brief of a Project the Router just created.
 */
const HANDOFF_OUTCOME: Record<string, string> = {
  handoff: '交给项目 PM',
  brief: '新项目工作说明',
}

/** How far a handoff got, as the console's own words. */
const HANDOFF_STAGE: Record<string, string> = {
  accepted: '已认领，待处理',
  routing: '正在投递',
  queued: '待送达',
  assigned: 'PM 已确认接收',
  refused: '未投递',
  failed: '投递失败',
  unconfirmed: '未确认送达',
}

/** The four conditions of the Project Gate, as the console's own words. */
const GATE_CONDITION: Record<string, string> = {
  multiple_independent_modules: '多个相对独立的模块',
  reasonable_decoupling: '模块之间合理解耦',
  genuine_parallelism: '模块可以真实并行',
  benefit_outweighs_coordination: '并行收益抵消协调成本',
}

/**
 * The wording of a message the Fast Router claimed.
 *
 * The line names the target and how far it got, and it never says that a Worker is running before the node says so: a
 * Worker that was asked to start is "待送达" until the node confirms it. A question the record answered says the answer.
 */
function routingWording(receipt: FastRouteReceipt): string {
  if (receipt.stage === 'failed' || receipt.stage === 'unconfirmed') {
    return `快路由没有投递${receipt.error === undefined ? '' : `：${receipt.error}`}`
  }
  if (receipt.outcome === 'read_only') {
    return receipt.answer ?? '快路由按权威记录回答了这条消息'
  }
  const outcome = ROUTE_OUTCOME[receipt.outcome] ?? receipt.outcome
  const stage = ROUTE_STAGE[receipt.stage] ?? receipt.stage
  const target = receipt.target === undefined ? '' : `（${receipt.target.title || receipt.target.id}）`
  return `快路由：${outcome}${target} · ${stage}`
}

/**
 * The wording of a revocation.
 *
 * The authority is gone either way, but a Session that did not really stop is said so: an HTTP answer of 200 is not a
 * stopped Worker.
 */
function revokedWording(result: unknown): string {
  const value = result as { revoked?: boolean; stopped?: boolean; error?: string }
  if (value.revoked !== true) return '未能撤销会话权限'
  if (value.stopped === false) {
    return `会话权限已撤销，但会话未确认停止${value.error === undefined ? '' : `：${value.error}`}`
  }
  return '会话权限已撤销'
}

/** The wording of a Project action that stops Workers: a partial success says so. */
export function projectWording(what: string, result: unknown): string {
  const value = result as { failures?: string[]; stopped?: string[] }
  const failures = value.failures?.length ?? 0
  const stopped = value.stopped?.length ?? 0
  if (failures > 0) return `${what}，但有 ${failures} 个 Worker 未确认停止`
  if (stopped === 0) return what
  return `${what}，${stopped} 个 Worker 已停止`
}

/** The time of a fact, as a person reads it. */
function timeOf(at: string): string {
  const moment = new Date(at)
  if (Number.isNaN(moment.getTime())) return at
  return moment.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** The time of a fact, with its day. */
function stampOf(at: string): string {
  const moment = new Date(at)
  if (Number.isNaN(moment.getTime())) return at
  return moment.toLocaleString('zh-CN', { hour12: false })
}

/** How an audit entry reads on the home page. */
function activityOf(entry: AuditEntry): { title: string; meta: string; icon: string; tone: string } {
  const detail = entry.detail
  switch (`${entry.kind}.${entry.action}`) {
    case 'project.created': return { title: '创建了项目', meta: detail, icon: 'project', tone: '' }
    case 'project.pm-ready': return { title: '项目 PM 已就绪', meta: detail, icon: 'ok', tone: 'success' }
    case 'project.reported': return { title: 'PM 提交了项目报告', meta: detail, icon: 'chat', tone: '' }
    case 'project.paused': return { title: '暂停了项目', meta: detail, icon: 'clock', tone: '' }
    case 'project.resumed': return { title: '恢复了项目', meta: detail, icon: 'ok', tone: 'success' }
    case 'project.stopped': return { title: '结束了项目', meta: detail, icon: 'fail', tone: 'failure' }
    case 'project.archived': return { title: '归档了项目', meta: detail, icon: 'project', tone: '' }
    case 'project.unarchived': return { title: '取消归档项目', meta: detail, icon: 'project', tone: '' }
    case 'project.remembered': return { title: '记下了项目备忘', meta: detail, icon: 'assign', tone: '' }
    case 'project.gate-created': return { title: '门禁放行后创建了项目', meta: detail, icon: 'project', tone: 'success' }
    case 'project.gate-refused': return { title: '未自动创建项目', meta: detail, icon: 'fail', tone: 'failure' }
    case 'ticket.created': return {
      title: entry.actor === 'router' ? 'Router 分派了独立工单' : 'PM 分派了工单', meta: detail, icon: 'assign', tone: '',
    }
    case 'assignment.started': return { title: 'Worker 开始执行', meta: detail, icon: 'assign', tone: '' }
    case 'review.accepted': return { title: 'PM 验收通过', meta: detail, icon: 'ok', tone: 'success' }
    case 'review.rejected': return { title: 'PM 要求返工', meta: detail, icon: 'fail', tone: 'failure' }
    case 'node.online': return { title: '节点已连接', meta: detail, icon: 'node', tone: 'success' }
    case 'node.offline': return { title: '节点已断开', meta: detail, icon: 'node', tone: 'failure' }
    case 'session.message': return { title: '发送了消息', meta: detail, icon: 'chat', tone: '' }
    case 'session.cancelled': return { title: '停止了会话', meta: detail, icon: 'fail', tone: 'failure' }
    case 'session.stopped': return { title: '停止了会话', meta: detail, icon: 'fail', tone: 'failure' }
    case 'session.archived': return { title: '归档了会话', meta: detail, icon: 'project', tone: '' }
    case 'session.revoked': return { title: '撤回了会话权限', meta: detail, icon: 'fail', tone: 'failure' }
    case 'session.permission': return { title: '修改了会话权限', meta: detail, icon: 'settings', tone: '' }
    case 'session.proposal': return { title: 'Router 提交了转发提议', meta: detail, icon: 'chat', tone: '' }
    case 'session.relayed': return { title: '已把 Router 的提议发给项目 PM', meta: detail, icon: 'ok', tone: 'success' }
    case 'session.routed': return {
      title: entry.outcome === 'failed' ? '快路由没有投递' : entry.outcome === 'skipped' ? '快路由交给了高层 Router' : '快路由已处理一条消息',
      meta: detail, icon: entry.outcome === 'failed' ? 'fail' : 'assign', tone: entry.outcome === 'failed' ? 'failure' : '',
    }
    case 'session.proposal-cancelled': return { title: '取消了 Router 的转发提议', meta: detail, icon: 'fail', tone: '' }
    case 'schedule.created': return { title: '新建了定时任务', meta: detail, icon: 'clock', tone: '' }
    case 'schedule.updated': return { title: '修改了定时任务', meta: detail, icon: 'clock', tone: '' }
    case 'schedule.paused': return { title: '暂停了定时任务', meta: detail, icon: 'clock', tone: '' }
    case 'schedule.resumed': return { title: '恢复了定时任务', meta: detail, icon: 'ok', tone: 'success' }
    case 'schedule.deleted': return { title: '删除了定时任务', meta: detail, icon: 'fail', tone: '' }
    case 'schedule.run.delivered': return { title: '定时任务已送达', meta: detail, icon: 'ok', tone: 'success' }
    case 'schedule.run.failed': return { title: '定时任务没有送达', meta: detail, icon: 'fail', tone: 'failure' }
    case 'schedule.run.interrupted': return { title: '定时任务被中断', meta: detail, icon: 'fail', tone: 'failure' }
    default: break
  }
  if (entry.kind === 'report') {
    return { title: 'Worker 报告', meta: detail, icon: 'chat', tone: entry.action === 'failed' ? 'failure' : '' }
  }
  if (entry.kind === 'denial') {
    return { title: entry.action === 'fused' ? '守卫打断了重复越权的回合' : '守卫拒绝了越权调用',
      meta: detail, icon: 'fail', tone: entry.outcome === 'failed' ? 'failure' : '' }
  }
  if (entry.kind === 'session' && entry.action.startsWith('reconcile-')) {
    const title = entry.outcome === 'ok' ? '已停止并归档残留会话'
      : entry.outcome === 'failed' ? '会话清理失败' : '会话检查发现异常'
    return { title, meta: entry.targetId, icon: 'node', tone: entry.outcome === 'failed' ? 'failure' : '' }
  }
  return { title: `${entry.kind} · ${entry.action}`, meta: detail, icon: 'chat', tone: '' }
}

/**
 * The recent activity of the home page.
 *
 * The newest facts come first, but the PM's and the Worker's own facts are kept: a scheduled task that fires every few
 * minutes must not push the record of the work itself off the list. When the newest slice holds none of them, the newest
 * one that exists is kept in its place.
 */
function recentActivity(entries: AuditEntry[]): AuditEntry[] {
  const isWork = (entry: AuditEntry): boolean =>
    entry.kind === 'ticket' || entry.kind === 'assignment' || entry.kind === 'report'
    || entry.kind === 'review' || entry.kind === 'session'
  const newest = entries.slice(0, 8)
  if (newest.some(isWork)) return newest
  const kept = entries.find(isWork)
  return kept === undefined ? newest : [...newest.slice(0, 7), kept].sort((a, b) => b.seq - a.seq)
}

/** How a Ticket's status reads on the Projects page. */
function statusTone(status: string): string {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'stopped') return 'failure'
  if (status === 'archived') return 'muted'
  return ''
}

/** The status of a Ticket, in the console's own words. */
const TICKET_STATUS: Record<string, string> = {
  open: '待派工',
  running: '执行中',
  waiting: '待 PM 验收',
  blocked: '等待人工',
  failed: '失败',
  completed: '已完成',
  stopped: '已停止',
  archived: '已归档',
}

/** The status of a Session, in the console's own words. */
const SESSION_STATUS: Record<string, string> = {
  starting: '启动中',
  idle: '空闲',
  running: '执行中',
  stopping: '停止中',
  stopped: '已停止',
  archived: '已归档',
  failed: '失败',
}

/** The role of a Session, in the console's own words. */
const SESSION_ROLE: Record<string, string> = {
  router: 'Router',
  pm: 'PM',
  worker: 'Worker',
  scout: '侦察',
}

/**
 * The id one message carries, so a repeated request is the same message.
 *
 * A browser that cannot make a UUID still gets an id; the control plane then names the message itself, and the only
 * thing that is lost is the protection against a repeated request.
 */
function messageId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    // A browser without the UUID API still gets an id; the control plane then names the message itself, and the only
    // thing that is lost is the protection against a repeated request.
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * The stop notices one Session's logical superior reads.
 *
 * The superior of a PM is the Router, the superior of a Worker is the PM of its Project (the Router, for a standalone
 * Ticket), and the Router has no superior above it — so it reads the notices about the work it is above.
 */
function superiorQuery(session: SessionView, superiorId: string): string {
  if (session.role === 'pm') return `superiorKind=pm&superiorId=${encodeURIComponent(session.sessionId)}`
  if (session.role === 'router') return 'superiorKind=router&superiorId=router'
  if (superiorId === '' || superiorId === 'router') return 'superiorKind=router&superiorId=router'
  return `superiorKind=pm&superiorId=${encodeURIComponent(superiorId)}`
}

/** What became of a message a person sent to the Router, in the console's own words. */
const QUEUE_STATE: Record<string, string> = {
  queued: '排队中',
  sending: '正在送出',
  sent: '已送达节点，等待回合读取',
  read: '已被回合读取',
  failed: '发送失败',
  unconfirmed: '节点未确认是否送达',
  routed: '快路由已自行处理',
}

/** What became of the delivery of a report, in the console's own words. */
const COORDINATION_STATUS: Record<string, string> = {
  accepted_pending: '已接受，待发送',
  dispatching: '投递中',
  delivered_inbox: '已送达收件箱',
  consumed_turn: '已被回合读取',
  unconfirmed: '节点未确认是否送达',
  blocked_target_inactive: '目标已停用',
  blocked_node_unavailable: '节点不可用',
  rejected_stale_or_revoked: '权限或代际已失效',
  failed_permanent: '永久失败',
  superseded: '已被更新的报告取代',
  deferred_for_resume: '等待项目恢复',
}

/** How a denial review reads in the console's own words. */
const DENIAL_STATUS: Record<string, string> = {
  pending_manager_online: '等待上级上线',
  dispatching: '正在送达',
  notified: '已通知上级',
  unconfirmed: '节点未确认是否送达',
}

/**
 * How an authorization application reads in the console's own words.
 *
 * The states say what the record is, never what was granted: an acknowledged application was noted by an operator, and
 * nothing was authorized by it.
 */
const APPLICATION_STATUS: Record<string, string> = {
  pending: '等待操作员决定',
  acknowledged: '操作员已知悉（未授予权限）',
  declined: '操作员不授权',
}

/** How the console shows a delivery's state: done, broken, or still on its way. */
function coordinationTone(status: string): string {
  if (status === 'delivered_inbox' || status === 'consumed_turn') return 'success'
  if (status === 'unconfirmed' || status === 'failed_permanent' || status === 'blocked_node_unavailable') return 'failure'
  if (status === 'blocked_target_inactive' || status === 'rejected_stale_or_revoked') return 'failure'
  return 'muted'
}

/** How the console shows a denial review's state. */
function denialTone(status: string): string {
  if (status === 'notified') return 'success'
  if (status === 'unconfirmed') return 'failure'
  return 'muted'
}

/** What a delivery is about, in one line: the Ticket, the Assignment and the kind of the report. */
function coordinationSubject(delivery: CoordinationDelivery): string {
  const parts: string[] = []
  if (delivery.ticketId !== '') parts.push(`工单 ${delivery.ticketId}`)
  if (delivery.assignmentId !== '') parts.push(`执行 ${delivery.assignmentId}`)
  parts.push(delivery.reportKind)
  return parts.join(' · ')
}

/**
 * The deliveries of the reports a Worker and a PM made, as the console shows them.
 *
 * It shows what happened to each delivery — the target, the state, the reason when there is one — and never the body of
 * the report: the stored message is the lower-trust text of the Worker or the PM, and a console that showed it would show
 * untrusted text as if it were the control plane's own.
 */
function CoordinationDeliveries(props: { deliveries: CoordinationDelivery[] }): ReactElement {
  return (
    <div className="router-queue" aria-label="报告投递记录">
      <p className="quiet">Worker 与 PM 的报告投递给谁、投递到哪一步。报告正文不在这里展示。</p>
      {props.deliveries.length === 0
        ? <p className="empty">还没有报告投递记录。</p>
        : <ul className="router-queue-list">
          {props.deliveries.map(delivery => (
            <li key={delivery.deliveryId} className={coordinationTone(delivery.status) === 'failure' ? 'failure' : ''}>
              <span className="router-queue-text">{coordinationSubject(delivery)}</span>
              <span className={`chip ${coordinationTone(delivery.status)}`}>
                {COORDINATION_STATUS[delivery.status] ?? delivery.status}
              </span>
              <span className="quiet">
                {' '}· 目标 {delivery.targetSessionId}（{delivery.targetRole}）
              </span>
              <span className="quiet">
                {' '}· 节点 {delivery.nodeId} / {delivery.backendId}
              </span>
              {delivery.attemptCount > 0 ? <span className="quiet"> · 尝试 {delivery.attemptCount} 次</span> : null}
              {delivery.error ? <span className="quiet"> · {delivery.error}</span> : null}
            </li>
          ))}
        </ul>}
    </div>
  )
}

/**
 * The messages a person sent to the Router, as the console shows them.
 *
 * The home page and the Router's own Session show the same list, because they are the same queue: what one page shows
 * the other shows too, so a reloaded page explains the wait instead of hiding it.
 */
function RouterQueue(props: { entries: RouterQueueEntry[]; id: string }): ReactElement {
  return (
    <div className="router-queue" id={props.id} aria-label="发给 Router 的排队消息">
      <p className="quiet">发给 Router 的消息（按发送顺序；排队中的会在当前回合结束后自动交给下一轮）</p>
      <ul className="router-queue-list">
        {props.entries.map(entry => (
          <li key={entry.id} className={entry.state === 'failed' ? 'failure' : ''}>
            <span className="router-queue-text">{entry.text}</span>
            <span className={`chip ${entry.state === 'failed' ? 'failure' : entry.state === 'read' ? 'success' : 'muted'}`}>
              {QUEUE_STATE[entry.state] ?? entry.state}
            </span>
            {entry.error ? <span className="quiet"> · {entry.error}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The routings the Fast Router made, as the console shows them.
 *
 * The two ways a message travels are shown apart. A message the rules carried out itself never reached the Router's
 * model, and it names the target it found and how far the work really got: the Ticket's own id, the Project's title and
 * the Worker Session's live status. A Worker that was asked to start but is not up yet reads as "待送达" — the console
 * never shows a Worker as running before the node says so. A message the model handles reads as such, with the reason the
 * rules left it alone: a conversation, an ambiguity or a rule that was not sure enough.
 */
function RouterRoutes(props: { receipts: FastRouteReceipt[]; id: string }): ReactElement {
  const fast = props.receipts.filter(receipt => receipt.path !== 'model')
  const model = props.receipts.filter(receipt => receipt.path === 'model')
  return (
    <>
      {fast.length ? (
        <div className="router-queue" id={props.id} aria-label="快路由的处理结果">
          <p className="quiet">快路由直接处理的消息（没有进入 Router 对话）</p>
          <ul className="router-queue-list">
            {fast.map(receipt => (
              <li key={receipt.requestId} className={receipt.stage === 'failed' ? 'failure' : ''}>
                <span className="router-queue-text">{receipt.text}</span>
                <span className={`chip ${receipt.stage === 'failed' ? 'failure' : receipt.stage === 'assigned' ? 'success' : 'muted'}`}>
                  {ROUTE_OUTCOME[receipt.outcome] ?? receipt.outcome}
                </span>
                <span className="quiet"> · {ROUTE_STAGE[receipt.stage] ?? receipt.stage}</span>
                {receipt.target ? <span className="quiet"> · {receipt.target.kind === 'ticket' ? '工单' : '项目'} {receipt.target.title || receipt.target.id}</span> : null}
                {receipt.ticketId ? <span className="quiet"> · 工单 {receipt.ticketId}</span> : null}
                {receipt.sessionId ? <span className="quiet"> · 会话 {receipt.sessionId}{receipt.sessionStatus ? `（${SESSION_STATUS[receipt.sessionStatus] ?? receipt.sessionStatus}）` : ''}</span> : null}
                {receipt.answer ? <span className="quiet"> · {receipt.answer}</span> : null}
                {receipt.error ? <span className="quiet"> · {receipt.error}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {model.length ? (
        <div className="router-queue" id={`${props.id}-model`} aria-label="交给高层 Router 的消息">
          <p className="quiet">交给高层 Router 的消息（同一个 router.v1 会话，由模型处理）</p>
          <ul className="router-queue-list">
            {model.map(receipt => (
              <li key={receipt.requestId}>
                <span className="router-queue-text">{receipt.text}</span>
                <span className="chip muted">{ROUTE_OUTCOME[receipt.outcome] ?? receipt.outcome}</span>
                <span className="quiet"> · {receipt.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  )
}

/**
 * The handoffs the high-level Router made to a Project's PM, as the console shows them.
 *
 * Each line names the request, the Project the work went to and the PM Session that took it, with the words that
 * really travelled beside the reason the Router gave. The stage says how far the delivery got: a PM that confirmed it
 * reads as confirmed, a delivery the node did not acknowledge reads as unconfirmed, and a decision the control plane
 * refused reads as a refusal with the reason — so a person can see that nothing was sent and why.
 */
function RouterHandoffs(props: { records: RouterHandoffRecord[]; id: string }): ReactElement {
  return (
    <div className="router-queue" id={props.id} aria-label="高层 Router 交给项目 PM 的工作">
      <p className="quiet">高层 Router 交给项目 PM 的工作（无需人工确认）</p>
      <ul className="router-queue-list">
        {props.records.map(record => (
          <li key={record.requestId} className={record.stage === 'failed' || record.stage === 'refused' ? 'failure' : ''}>
            <span className="router-queue-text">{record.text}</span>
            <span className={`chip ${record.stage === 'assigned' ? 'success' : record.stage === 'failed' || record.stage === 'refused' ? 'failure' : 'muted'}`}>
              {HANDOFF_OUTCOME[record.kind] ?? record.kind}
            </span>
            <span className="quiet"> · {HANDOFF_STAGE[record.stage] ?? record.stage}</span>
            {record.projectTitle || record.projectId ? <span className="quiet"> · 项目 {record.projectTitle || record.projectId}</span> : null}
            {record.pmSessionId ? <span className="quiet"> · PM 会话 {record.pmSessionId}{record.pmStatus ? `（${SESSION_STATUS[record.pmStatus] ?? record.pmStatus}）` : ''}</span> : null}
            {record.instruction ? <span className="quiet"> · {record.stage === 'assigned' ? '送达内容' : '拟交内容'}：{record.instruction}</span> : null}
            {record.rationale ? <span className="quiet"> · 依据：{record.rationale}</span> : null}
            {record.stage === 'refused' || record.stage === 'failed' || record.stage === 'unconfirmed'
              ? <span className="quiet"> · {record.detail}</span> : null}
            {record.error ? <span className="quiet"> · {record.error}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The decisions of the Project Gate, as the console shows them.
 *
 * Each line names the four conditions and what was decided about each of them, the reason the gate gave, and — when a
 * Project really was created — the Project and the PM that belong to it. A refusal shows the condition that failed, so a
 * person can see that nothing was created and why.
 */
function ProjectGates(props: { records: ProjectGateRecord[]; id: string }): ReactElement {
  return (
    <div className="router-queue" id={props.id} aria-label="自动建项目的判定">
      <p className="quiet">自动建项目的判定</p>
      <ul className="router-queue-list">
        {props.records.map(record => (
          <li key={`${record.requestId}-${record.attempt}`} className={record.outcome === 'refused' ? 'failure' : ''}>
            <span className="router-queue-text">{record.text}</span>
            <span className={`chip ${record.outcome === 'created' ? 'success' : record.outcome === 'refused' ? 'failure' : 'muted'}`}>
              {GATE_OUTCOME[record.outcome] ?? record.outcome}
            </span>
            <span className="quiet"> · {record.detail}</span>
            {record.conditions.length ? (
              <span className="quiet"> · {record.conditions.map(finding =>
                `${GATE_CONDITION[finding.condition] ?? finding.condition}：${finding.met ? '成立' : '不成立'}`).join('；')}</span>
            ) : null}
            {record.modules.length ? (
              <span className="quiet"> · 模块 {record.modules.map(module =>
                `${module.name}（本人原话：${module.anchor || '无'}）`).join('；')}</span>
            ) : null}
            {record.projectId ? <span className="quiet"> · 项目 {record.title || record.projectId}</span> : null}
            {record.pmSessionId ? <span className="quiet"> · PM 会话 {record.pmSessionId}{record.pmStatus ? `（${SESSION_STATUS[record.pmStatus] ?? record.pmStatus}）` : ''}</span> : null}
            {record.pmStatus === 'unconfirmed' ? <span className="quiet"> · PM 未确认启动{record.error ? `：${record.error}` : ''}</span> : null}
            {record.existingProject ? <span className="quiet"> · 已有项目 {record.existingProject.title}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The status of a Project, in the console's own words. */
const PROJECT_STATUS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  ended: '已结束',
  archived: '已归档',
}

/** What a reconciliation finding reads as. */
const FINDING_KIND: Record<string, string> = {
  'orphan-worker': '任务已结束，Worker 会话仍在运行',
  'orphan-pm': '项目已结束，PM 会话仍在运行',
  'missing-worker': '任务仍在进行，节点找不到 Worker',
  'unknown-status': '状态不明的会话',
  'no-pm': '项目没有 PM 会话',
}

const ASSIGNMENT_STATE: Record<string, string> = { pending: '等待启动', running: '执行中', ended: '已结束' }
const REPORT_STATE: Record<string, string> = {
  progress: '进度更新', waiting: '等待回复', ready: '可验收', blocked: '遇到阻碍', failed: '失败', dropped: '已放弃',
}
const REVIEW_STATE: Record<string, string> = {
  pending: '待验收', accepted: '已通过', rejected: '需返工', withdrawn: '已撤回',
}

/**
 * The home page: the Router conversation, the real counts, and the real recent activity.
 *
 * The Router is a real Agent on the node: the console sends a person's message to it and reads the answer back from the
 * node's own message events. It shows what really happened — the person's words, the model's answer, the node's liveness
 * — and never a message of its own making.
 *
 * The conversation is read the way a chat is read: the person's own words sit in a bubble on the right, the Router's
 * answer is laid out as Markdown on the left, and the composer stays where it can be reached. A person reading the
 * history keeps the place they were at: the thread follows the newest answer only while they are at its end.
 *
 * The control plane sends routine work to a Project's PM and the page shows the delivery receipt. Explicit relay
 * proposals wait for the person to confirm or cancel them in the console.
 */
export function HomePage(props: PageProps): ReactElement {
  const [preferences] = useState(readPreferences)
  const overview = useLoaded(() => read<Overview>('/v1/overview'), props.revision)
  const activity = useLoaded(() => read<{ entries: AuditEntry[] }>('/v1/audit?limit=24'), props.revision)
  const router = useLoaded(() => read<RouterState>('/v1/console/router'), props.revision)
  const coordination = useLoaded(() => read<{ deliveries: CoordinationDelivery[] }>(
    '/v1/console/coordination/deliveries?limit=24'), props.revision)
  const denials = useLoaded(() => read<{ reviews: DenialReview[]; applications: DenialAuthorization[] }>(
    '/v1/console/denials?limit=24'), props.revision)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<(RouterTextAttachment & { bytes: number })[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [attaching, setAttaching] = useState(false)
  const [chosen, setChosen] = useState<RouterModel>()
  const action = useAction(props.refresh)
  const data = overview.data
  const entries = recentActivity(activity.data?.entries ?? [])
  const messages = router.data?.messages ?? []
  const session = router.data?.session
  const proposal = router.data?.proposal
  const queue: RouterQueueEntry[] = router.data?.queue ?? []
  const routes: FastRouteReceipt[] = router.data?.routes ?? []
  const gates: ProjectGateRecord[] = router.data?.gates ?? []
  const handoffs: RouterHandoffRecord[] = router.data?.handoffs ?? []
  const deliveries: CoordinationDelivery[] = coordination.data?.deliveries ?? []
  const denialReviews: DenialReview[] = denials.data?.reviews ?? []
  const denialApplications: DenialAuthorization[] = denials.data?.applications ?? []
  const online = router.data?.nodeOnline !== false
  const thread = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const files = useRef<HTMLInputElement>(null)
  /** Whether the thread still follows the newest answer; a person reading the history turns it off. */
  const followLatest = useRef(true)
  /** Where the thread was left, so a reply that arrives does not move it. */
  const restingAt = useRef(0)
  const latestMessage = messages.at(-1)?.seq
  const options = useLoaded(() => read<RouterOptions>('/v1/console/router/options'), latestMessage ?? 0,
    `${online}:${session?.status ?? ''}`).data
  const models = options?.models ?? []
  const preferred = preferences.routerModel
  const requestedModel = chosen ?? (preferred && (!options || models.some(model => modelKey(model) === modelKey(preferred)))
    ? preferred : undefined)
  const selected = requestedModel ?? options?.selected
  const usage = options?.usage
  const usagePercent = usage?.contextWindow ? 100 * usage.tokens / usage.contextWindow : undefined
  const usageLabel = usagePercent !== undefined && usagePercent > 0 && usagePercent < 1
    ? '<1%' : `${Math.round(usagePercent ?? 0)}%`

  const addFiles = async (picked: File[]): Promise<void> => {
    setAttachmentError('')
    if (picked.length === 0) return
    const bytes = [...attachments, ...picked.map(file => ({ bytes: file.size }))].reduce((sum, file) => sum + file.bytes, 0)
    if (attachments.length + picked.length > ROUTER_ATTACHMENT_COUNT || bytes > ROUTER_ATTACHMENT_BYTES) {
      setAttachmentError('每条消息最多附加 4 个文件，合计不超过 48 KB。')
      return
    }
    setAttaching(true)
    try {
      const added = await Promise.all(picked.map(async file => {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
        if (text.includes('\0')) throw new Error('Expected text')
        return { name: file.name, text, bytes: file.size }
      }))
      setAttachments(current => [...current, ...added])
    } catch {
      setAttachmentError('请使用 UTF-8 文本文件，例如 Markdown、CSV、JSON 或源代码。')
    } finally {
      setAttaching(false)
    }
  }

  // The thread follows the newest answer while the person is at its end, and keeps its place while they are not.
  useEffect(() => {
    const element = thread.current
    if (element === null) return
    element.scrollTop = followLatest.current ? element.scrollHeight : restingAt.current
  }, [latestMessage])

  // The composer grows with what is written in it, up to a height that still leaves the answer visible.
  useEffect(() => {
    const element = input.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`
  }, [text])

  const send = (interrupt: boolean): void => {
    const value = text.trim()
    if (!online || action.state.busy || attaching || (value === '' && attachments.length === 0)) return
    followLatest.current = true
    // The message carries its own id, so a request the browser repeats is the same message and not a second one.
    const id = messageId()
    // The turn the operator acted on: it names the round, so a round that started in the meantime is never ended in its
    // place.
    const turn = interrupt ? session?.currentTurn : undefined
    action.run(async () => {
      const result = await write(interrupt ? '/v1/console/sessions/router/interrupt' : '/v1/console/router/message', {
        text: value,
        id,
        ...(turn === undefined ? {} : { turn }),
        ...(attachments.length ? { attachments: attachments.map(({ name, text }) => ({ name, text })) } : {}),
        ...(requestedModel ? { model: requestedModel } : {}),
      })
      setText(current => current === text ? '' : current)
      setAttachments([])
      setAttachmentError('')
      return result
    }, routerSendWording)
  }

  // The interrupt ends the turn the Router runs now and nothing else: the messages that wait for the next turn stay
  // where they are, and the Router keeps its identity.
  const interrupt = (): void => {
    if (!online || action.state.busy) return
    action.run(() => write('/v1/console/sessions/router/interrupt',
      session?.currentTurn === undefined ? {} : { turn: session.currentTurn }), interruptedWording)
  }

  // The state the Router is in, as the control plane reports it.
  const waiting = queue.filter(entry => entry.state === 'queued' || entry.state === 'sending' || entry.state === 'sent').length
  const state = !online
    ? '节点离线，暂时无法和 Router 对话。'
    : session === undefined
      ? '发送第一条消息时会启动 Router。'
      : session.status === 'running'
        ? waiting > 0
          ? `Router 正在回答……有 ${waiting} 条消息在排队，当前回合结束后自动交给下一轮。`
          : 'Router 正在回答……'
        : waiting > 0
          ? `有 ${waiting} 条消息在排队，等 Router 空闲后送出。`
          : 'Router 已就绪。'

  return (
    <>
      <section className="router" aria-labelledby="router-title">
        <div className="router-column">
          <div className="router-heading">
            <span className="router-mark"><Icon name="router" /></span>
            <h2 id="router-title">Router</h2>
          </div>
          <div className="router-thread" ref={thread} aria-live="polite"
            onScroll={event => {
              const element = event.currentTarget
              restingAt.current = element.scrollTop
              followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32
            }}>
            {router.error ? <p className="empty">{router.error}</p> : null}
            {!router.error && messages.length === 0
              ? <div className="router-invite">
                <p className="router-invite-title">今天要做什么？</p>
                <p className="router-invite-text">
                  问项目进度，或请 Router 新建项目、安排任务。
                </p>
              </div>
              : messages.map(message => message.role === 'assistant'
                ? <article className="router-answer" key={message.seq} aria-label="Router 的回答">
                  <Markdown text={message.text} />
                </article>
                : <article className="router-ask" key={message.seq} aria-label="你的消息">
                  {message.attachments?.length ? <ul className="router-files">
                    {message.attachments.map((name, index) => <li key={index}><Icon name="file" /><span>{name}</span></li>)}
                  </ul> : null}
                  {message.text}
                </article>)}
          </div>
          {proposal ? (
            <div className="router-proposal" id="router-proposal" role="group" aria-label="待确认的转发提议">
              <p className="quiet">
                确认后，Router 会把下面这条消息发给 <b>{proposal.projectTitle}</b> 的 PM。
              </p>
              <p className="proposal-text" id="router-proposal-text">{proposal.instruction}</p>
              <div className="detail-actions">
                <button type="button" id="router-proposal-confirm" className="action primary"
                  disabled={action.state.busy}
                  onClick={() => action.run(
                    () => write(`/v1/console/router/proposal/${encodeURIComponent(proposal.id)}/confirm`, {}),
                    '已发给该项目的 PM')}>发给 {proposal.projectTitle}</button>
                <button type="button" id="router-proposal-cancel" className="action" disabled={action.state.busy}
                  onClick={() => action.run(
                    () => write(`/v1/console/router/proposal/${encodeURIComponent(proposal.id)}/cancel`, {}),
                    '已取消转发')}>取消</button>
              </div>
            </div>
          ) : null}
          {routes.length ? <RouterRoutes receipts={routes} id="router-routes" /> : null}
          {handoffs.length ? <RouterHandoffs records={handoffs} id="router-handoffs" /> : null}
          {gates.length ? <ProjectGates records={gates} id="router-gates" /> : null}
          {queue.length ? <RouterQueue entries={queue} id="router-queue" /> : null}
          <form className="composer" onSubmit={event => { event.preventDefault(); send(false) }}>
            {attachments.length ? <ul className="router-files">
              {attachments.map((file, index) => <li key={index}><Icon name="file" /><span title={file.name}>{file.name}</span>
                <button type="button" aria-label={`移除 ${file.name}`} disabled={action.state.busy || attaching}
                  onClick={() => { setAttachments(current => current.filter((_, item) => item !== index)); setAttachmentError('') }}>
                  <Icon name="fail" />
                </button>
              </li>)}
            </ul> : null}
            <input ref={files} type="file" hidden multiple aria-label="选择附件"
              accept="text/*,.txt,.md,.json,.csv,.tsv,.yaml,.yml,.log,.js,.ts,.py,.html,.xml,.css"
              onChange={event => {
                void addFiles(Array.from(event.currentTarget.files ?? []))
                event.currentTarget.value = ''
              }} />
            <label htmlFor="router-input" className="sr-only">发给 Router 的消息</label>
            <textarea id="router-input" ref={input} rows={1} maxLength={1500} value={text}
              onChange={event => setText(event.target.value)}
              onKeyDown={event => {
                // An input method that is still composing its own word is not a sentence that is finished.
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                if (event.key !== 'Enter' || event.shiftKey || !online || !preferences.enterToSend) return
                event.preventDefault()
                send(false)
              }}
              placeholder={online ? '问进度，或告诉 Router 接下来要做什么' : '节点离线，暂时发不出去'} />
            <div className="composer-foot">
              <button type="button" className="composer-attach" aria-label="添加附件" title="添加 UTF-8 文本附件"
                disabled={action.state.busy || attaching || attachments.length >= ROUTER_ATTACHMENT_COUNT}
                onClick={() => files.current?.click()}><Icon name="plus" /></button>
              <div className="composer-options">
                <select aria-label="Router 模型" title="选择下一条消息使用的 Router 模型"
                  disabled={!online || !models.length || action.state.busy || session?.status === 'running'}
                  value={selected ? modelKey(selected) : ''}
                  onChange={event => {
                    const next = models.find(model => modelKey(model) === event.target.value)
                    setChosen(next ? { provider: next.provider, model: next.model } : undefined)
                  }}>
                  {!selected || !models.some(model => modelKey(model) === modelKey(selected))
                    ? <option value={selected ? modelKey(selected) : ''}>{selected?.model ?? '默认模型'}</option> : null}
                  {models.map(model => <option key={modelKey(model)} value={modelKey(model)}>
                    {model.name} ({model.provider})
                  </option>)}
                </select>
                <details className="composer-usage">
                  <summary title="最近一次模型请求的上下文用量">
                    <span className="usage-ring" aria-hidden="true"
                      style={{ '--usage': `${Math.min(100, usagePercent ?? 0)}%` } as React.CSSProperties} />
                    {usagePercent === undefined ? '上下文' : `上下文 ${usageLabel}`}
                  </summary>
                  <div className="usage-popover">
                    <b>最近一次模型请求</b>
                    {usage ? <><p>{usage.model}</p><p>{usage.tokens.toLocaleString()}
                      {usage.contextWindow ? ` / ${usage.contextWindow.toLocaleString()}` : ''} tokens</p>
                    </> : <p>暂无用量，等模型返回第一条回复。</p>}
                  </div>
                </details>
              </div>
              {session?.status === 'running' && session.interruptible === true && session.currentTurn !== undefined ? (
                <div className="composer-turn">
                  <button type="button" id="router-interrupt" className="action" disabled={action.state.busy || !online}
                    title="只打断 Router 当前这一回合：排队的消息不会丢，会话和工单都不变。"
                    onClick={() => interrupt()}>打断当前回合</button>
                  <button type="button" id="router-interrupt-and-send" className="action"
                    disabled={action.state.busy || !online || (text.trim() === '' && attachments.length === 0)}
                    title="先打断 Router 当前这一回合，再把下面写的话交给下一轮。"
                    onClick={() => send(true)}>中断并插话</button>
                </div>
              ) : null}
              <button type="submit" id="router-send" className="send-round" aria-label="发送"
                disabled={action.state.busy || !online || attaching || (text.trim() === '' && attachments.length === 0)}>
                <Icon name="arrowUp" />
              </button>
            </div>
          </form>
          {attachmentError ? <p role="alert" className="notice failure">{attachmentError}</p> : null}
          <ActionLine state={action.state} />
          <p className="status-note">
            {state}
            {session === undefined ? '' : ` 会话 ${session.sessionId} · ${SESSION_STATUS[session.status] ?? session.status}`}
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="summary-title">
        <div className="section-heading">
          <h2 id="summary-title">运行概览</h2>
          <span className="quiet">来自控制面的实时统计</span>
        </div>
        <div className="metrics">
          <button className="metric" onClick={() => props.navigate('projects')}>
            <span className="metric-label">工作进行中</span>
            <strong className="metric-value">{data?.runningTickets ?? '—'}</strong>
          </button>
          <button className="metric" onClick={() => props.navigate('sessions')}>
            <span className="metric-label">Worker 正在执行</span>
            <strong className="metric-value">{data?.runningWorkers ?? '—'}</strong>
          </button>
          <button className="metric review" onClick={() => props.navigate('projects')}>
            <span className="metric-label">待 PM 验收</span>
            <strong className="metric-value">{data?.pendingReviews ?? '—'}</strong>
          </button>
          <button className={`metric failed${(data?.schedules.failed ?? 0) === 0 ? ' none' : ''}`}
            onClick={() => props.navigate('schedules', 'failed')}>
            <span className="metric-label">定时任务失败</span>
            <strong className="metric-value">{data?.features?.schedules ? (data.schedules.failed ?? 0) : '—'}</strong>
          </button>
        </div>
        <p className="status-note">
          {data?.features?.schedules
            ? `${data.schedules.failed} 个定时任务上次发送失败。点击可查看。`
            : '当前控制面未启用定时任务。'}
        </p>
      </section>

      <section className="section" aria-labelledby="activity-title">
        <div className="section-heading">
          <h2 id="activity-title">近期动向</h2>
          <span className="quiet">来自控制面的审计记录</span>
        </div>
        <div className="activity">
          {entries.length === 0
            ? <p className="empty">暂无活动记录。</p>
            : <ol className="activity-list">
              {entries.map(entry => {
                const item = activityOf(entry)
                return (
                  <li key={entry.seq}>
                    <div className="activity-row">
                      <span className={`event-icon ${item.tone}`}><Icon name={item.icon} /></span>
                      <div>
                        <span className="event-title">{item.title}</span>
                        <span className="event-meta">{item.meta || entry.targetId}</span>
                      </div>
                      <time className="event-time" dateTime={entry.at}>{timeOf(entry.at)}</time>
                    </div>
                  </li>
                )
              })}
            </ol>}
        </div>
      </section>

      <section className="section" aria-labelledby="coordination-title">
        <div className="section-heading">
          <h2 id="coordination-title">报告投递</h2>
          <span className="quiet">来自控制面的持久投递记录</span>
        </div>
        <CoordinationDeliveries deliveries={deliveries} />
      </section>

      <section className="section" aria-labelledby="denials-title">
        <div className="section-heading">
          <h2 id="denials-title">权限拒绝审查</h2>
          <span className="quiet">守卫拒绝的调用与上级审查结果</span>
        </div>
        <DenialReviews reviews={denialReviews} />
        <DenialAuthorizations applications={denialApplications} refresh={props.refresh} />
      </section>
    </>
  )
}

/**
 * The explicit human authorization applications the superiors raised, as the console shows them.
 *
 * A superior raised an application about one permission denial review and the operator decides about it here. The
 * decision is a record and nothing else: it grants no capability, widens no Mandate and repeats no refused call, so the
 * panel says so instead of pretending that anything was authorized. Any real change goes through the operator's own
 * path in the console.
 */
function DenialAuthorizations(props: { applications: DenialAuthorization[]; refresh: () => void }): ReactElement {
  const action = useAction(props.refresh)
  return (
    <div className="router-queue" aria-label="人工授权申请单">
      <h3>人工授权申请单</h3>
      <p className="quiet">
        上级就一次权限拒绝审查发起的人工授权申请。记录一条决定不会授予任何权限，也不会重放被拒的调用；真正的 Mandate 或配置变更仍走操作员自己的路径。
      </p>
      {props.applications.length === 0
        ? <p className="empty">还没有人工授权申请单。</p>
        : <ul className="router-queue-list">
          {props.applications.map(application => (
            <li key={application.applicationId} className={application.status === 'declined' ? 'failure' : ''}>
              <span className="router-queue-text">
                {application.applicantRole} · {application.reasonCode} · {application.toolName}
              </span>
              <span className={`chip ${application.status === 'acknowledged' ? 'success' : application.status === 'declined' ? 'failure' : 'muted'}`}>
                {APPLICATION_STATUS[application.status] ?? application.status}
              </span>
              <span className="quiet">
                {' '}· 审查 {application.reviewId}
                {' '}· 会话 {application.controlSessionId}
                {application.ticketId === '' ? '' : ` · 工单 ${application.ticketId}`}
                {' '}· 窗口内 {application.denialCount} 次
              </span>
              {application.status === 'pending'
                ? <div className="detail-actions">
                  <button type="button" className="action" disabled={action.state.busy}
                    onClick={() => action.run(async () => {
                      await write('/v1/console/denials/authorizations',
                        { applicationId: application.applicationId, decision: 'acknowledged' })
                      props.refresh()
                    }, '已记录决定：操作员已知悉，未授予任何权限')}>
                    {action.state.busy ? '正在记录…' : '记录：已知悉'}
                  </button>
                  <button type="button" className="action" disabled={action.state.busy}
                    onClick={() => action.run(async () => {
                      await write('/v1/console/denials/authorizations',
                        { applicationId: application.applicationId, decision: 'declined' })
                      props.refresh()
                    }, '已记录决定：不授权')}>
                    {action.state.busy ? '正在记录…' : '记录：不授权'}
                  </button>
                </div>
                : null}
            </li>
          ))}
        </ul>}
      <ActionLine state={action.state} />
    </div>
  )
}

/**
 * The permission denials the guards refused, as the console shows them.
 *
 * It shows what each refusal was, which reason code it carried, how many the window held and what became of the review.
 * The message that was sent to a superior is not shown, and neither are the arguments of the refused call: the console
 * shows the facts of a refusal, never what the model said.
 */
function DenialReviews(props: { reviews: DenialReview[] }): ReactElement {
  return (
    <div className="router-queue" aria-label="权限拒绝审查记录">
      <p className="quiet">守卫拒绝的调用、原因码与上级审查结果。被拒调用的参数不出现在这里。</p>
      {props.reviews.length === 0
        ? <p className="empty">还没有权限拒绝记录。</p>
        : <ul className="router-queue-list">
          {props.reviews.map(review => (
            <li key={review.noticeId} className={denialTone(review.status) === 'failure' ? 'failure' : ''}>
              <span className="router-queue-text">
                {review.role} · {review.reasonCode} · {review.toolName}
              </span>
              <span className={`chip ${denialTone(review.status)}`}>
                {DENIAL_STATUS[review.status] ?? review.status}
              </span>
              <span className="quiet">
                {' '}· 会话 {review.controlSessionId}
                {review.ticketId === '' ? '' : ` · 工单 ${review.ticketId}`}
                {review.assignmentId === '' ? '' : ` · 执行 ${review.assignmentId}`}
              </span>
              <span className="quiet"> · 窗口内 {review.denialCount} 次</span>
              {review.targetSessionId === ''
                ? <span className="quiet"> · 通知操作员</span>
                : <span className="quiet"> · 目标 {review.targetSessionId}（{review.targetRole}）</span>}
              {review.reason ? <span className="quiet"> · {review.reason}</span> : null}
              {review.taskContext === '' ? null : <span className="quiet"> · {review.taskContext}</span>}
            </li>
          ))}
        </ul>}
    </div>
  )
}

/**
 * The Projects page: the real Projects, the operations an operator may perform on them, and their own memory.
 *
 * Creating a Project goes through the domain's own path, and starting the PM goes through the node's own ensure: the
 * console never creates a Worker by hand, because a Worker exists because an Assignment does.
 */
export function ProjectsPage(props: PageProps): ReactElement {
  const projects = useLoaded(() => read<{ projects: ConsoleProject[]; workspaceRoot: string }>('/v1/console/projects'), props.revision)
  const [selected, setSelected] = useState('')
  const [showDetail, setShowDetail] = useState(false)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [workspace, setWorkspace] = useState('')
  const action = useAction(props.refresh)
  const list = projects.data?.projects ?? []
  const current = list.find(project => project.id === selected) ?? list[0]

  const create = (): void => {
    if (action.state.busy) return
    if (title.trim() === '' || goal.trim() === '') {
      action.run(() => Promise.reject(new Error('请填写项目名称和目标。')))
      return
    }
    action.run(async () => {
      const { project } = await write<{ project: { id: string } }>('/v1/console/projects',
        { title: title.trim(), goal: goal.trim(), ...(workspace.trim() ? { workspace: workspace.trim() } : {}) })
      setSelected(project.id)
      setTitle('')
      setGoal('')
      setWorkspace('')
      setCreating(false)
    }, '项目已创建')
  }

  return (
    <div className="workspace-split" data-detail={showDetail}>
      <section className="workspace-index panel" aria-label="项目列表">
        <div className="workspace-toolbar">
          <button type="button" className="action workspace-new" disabled={action.state.busy}
            onClick={() => { setCreating(true); setShowDetail(true) }}>
            <Icon name="plus" />新建项目
          </button>
        </div>
        {list.length === 0
          ? <p className="empty">还没有项目。</p>
          : list.map(project => (
            <button key={project.id} className="item" aria-pressed={!creating && current?.id === project.id}
              disabled={action.state.busy}
              onClick={() => { setSelected(project.id); setCreating(false); setShowDetail(true) }}>
              <span className="workspace-item-name">
                <b>{project.title}</b>
                <span className="quiet">{PROJECT_STATUS[project.status] ?? project.status}</span>
              </span>
              <span className={`chip ${statusTone(project.status)}`}>{project.tickets.length} 工单</span>
            </button>
          ))}
      </section>
      <section className="workspace-detail panel padded" aria-label="项目详情">
        <button type="button" className="workspace-back action" onClick={() => setShowDetail(false)}>返回项目列表</button>
        {projects.error ? <p className="empty">{projects.error}</p> : null}
        {creating ? (
          <div className="workspace-create">
            <h2>新建项目</h2>
            <form className="form-block" onSubmit={event => { event.preventDefault(); create() }}>
              <label htmlFor="project-title">项目名称</label>
              <input id="project-title" autoFocus value={title} maxLength={200} disabled={action.state.busy}
                onChange={event => setTitle(event.target.value)} placeholder="要做什么" />
              <label htmlFor="project-goal">项目目标</label>
              <textarea id="project-goal" rows={4} maxLength={4000} value={goal} disabled={action.state.busy}
                onChange={event => setGoal(event.target.value)} placeholder="这个项目要达成什么" />
              <label htmlFor="project-workspace">工作区路径（可选）</label>
              <input id="project-workspace" value={workspace} maxLength={4096} disabled={action.state.busy}
                aria-describedby="project-workspace-help" autoComplete="off" spellCheck={false}
                onChange={event => setWorkspace(event.target.value)} placeholder="输入执行节点上的绝对路径" />
              <p className="quiet" id="project-workspace-help">
                PM 和 Worker 会在这个目录工作。留空会为项目分配新目录。
                {projects.data?.workspaceRoot ? <>工作区根目录为 <code>{projects.data.workspaceRoot}</code>，请选择其下的目录。</> : null}
              </p>
              <div className="detail-actions">
                <button type="submit" className="action primary" disabled={action.state.busy}>创建</button>
                <button type="button" className="action" disabled={action.state.busy}
                  onClick={() => { setCreating(false); if (!current) setShowDetail(false) }}>取消</button>
              </div>
              <ActionLine state={action.state} />
            </form>
          </div>
        ) : current ? <ProjectDetail key={current.id} project={current} revision={props.revision} refresh={props.refresh} />
          : !projects.error ? <p className="workspace-empty">新建项目，或从列表选择要查看的项目。</p> : null}
      </section>
    </div>
  )
}

/** One Project: its facts, its lifecycle actions, its memory and the conversation with its PM. */
function ProjectDetail(props: { project: ConsoleProject; revision: number; refresh: () => void }): ReactElement {
  const project = props.project
  const sessions = useLoaded(() => read<{ sessions: SessionView[] }>('/v1/sessions'), props.revision)
  const pm = sessions.data?.sessions.find(session => session.sessionId === project.pmSessionId)
  const canMessagePm = pm !== undefined && !pm.revokedAt && (pm.status === 'idle' || pm.status === 'running')
  const memory = useLoaded(() => read<{ entries: ProjectMemoryEntry[] }>(
    `/v1/console/projects/${encodeURIComponent(project.id)}/memory`), props.revision, project.id)
  const messages = useLoaded(() => pm
    ? read<{ messages: SessionMessage[] }>(`/v1/console/sessions/${encodeURIComponent(pm.sessionId)}/messages`)
    : Promise.resolve({ messages: [] }), props.revision, pm?.sessionId)
  const [note, setNote] = useState('')
  const [text, setText] = useState('')
  const action = useAction(props.refresh)
  const path = `/v1/console/projects/${encodeURIComponent(project.id)}`

  const remember = (): void => {
    if (note.trim() === '') return
    action.run(() => write(`${path}/memory`, { text: note.trim() }), '已记下')
    setNote('')
  }
  const send = (): void => {
    if (!canMessagePm || action.state.busy || text.trim() === '') return
    action.run(() => write(`/v1/console/sessions/${encodeURIComponent(project.pmSessionId)}/message`,
      { text: text.trim() }), deliveredWording)
    setText('')
  }

  return (
    <>
      <h2>{project.title}</h2>
      <p className="quiet">{project.goal}</p>
      <dl className="detail-list">
        <div><dt>状态</dt><dd>{PROJECT_STATUS[project.status] ?? project.status}
          {project.pauseMode ? `（${project.pauseMode === 'hard' ? '已请求停止 Worker' : '现有 Worker 可继续'}）` : ''}</dd></div>
        <div><dt>PM 会话</dt><dd>{project.pmSessionId}{pm ? ` · ${SESSION_STATUS[pm.status] ?? pm.status}` : ' · 尚未启动'}</dd></div>
        <div><dt>工作区</dt><dd>{project.workspace}</dd></div>
        <div><dt>创建时间</dt><dd>{stampOf(project.createdAt)}</dd></div>
        <div><dt>最近报告</dt><dd>{project.latestReport
          ? `${project.latestReport.summary}（${stampOf(project.latestReport.at)}）` : '—'}</dd></div>
      </dl>
      <p className="quiet">项目 Worker 共用此工作区。并行修改同一文件可能覆盖彼此的改动。</p>

      <div className="detail-actions">
        {(pm === undefined || pm.status === 'failed') && project.status !== 'ended' && project.status !== 'archived'
          ? <button type="button" className="action primary" disabled={action.state.busy}
            onClick={() => action.run(() => write(`${path}/pm`, {}), 'PM 已启动')}>启动 PM</button>
          : null}
        {project.status === 'active'
          ? <button type="button" className="action" disabled={action.state.busy}
            onClick={() => action.run(() => write(`${path}/pause`, { paused: true, mode: 'hard' }), pauseWording)}>暂停</button>
          : null}
        {project.status === 'paused'
          ? <button type="button" className="action" disabled={action.state.busy}
            onClick={() => action.run(() => write(`${path}/pause`, { paused: false }), '项目已恢复')}>恢复</button>
          : null}
        {project.status === 'active' || project.status === 'paused'
          ? <button type="button" className="action" disabled={action.state.busy}
            onClick={() => action.run(() => write(`${path}/stop`, { reason: '操作员在控制台结束了这个项目' }),
              result => projectWording('项目已结束', result))}>结束项目</button>
          : null}
        {project.status !== 'archived' && project.status !== 'ended'
          ? <button type="button" className="action" disabled={action.state.busy}
            onClick={() => action.run(() => write(`${path}/archive`, {}),
              result => projectWording('项目已归档', result))}>归档</button>
          : null}
        {project.status === 'archived'
          ? <button type="button" className="action" disabled={action.state.busy}
            onClick={() => action.run(() => write(`${path}/unarchive`, {}), '项目已取消归档')}>取消归档</button>
          : null}
      </div>
      <ActionLine state={action.state} />
      <h3>工单</h3>
      {project.tickets.length === 0
        ? <p className="empty">暂无工单。可请项目 PM 安排工作。</p>
        : project.tickets.map(ticket => <TicketRow key={ticket.id} ticket={ticket} />)}

      <h3>项目备忘</h3>
      <div className="form-block">
        <label htmlFor="project-note" className="sr-only">记一笔</label>
        <textarea id="project-note" rows={2} maxLength={500} value={note}
          onChange={event => setNote(event.target.value)} placeholder="给这个项目记一笔" />
        <button type="button" className="action" disabled={action.state.busy || note.trim() === ''}
          onClick={remember}>记一笔</button>
      </div>
      {memory.error ? <p className="empty">{memory.error}</p> : null}
      {(memory.data?.entries.length ?? 0) === 0
        ? <p className="empty">还没有备忘。</p>
        : (memory.data?.entries ?? []).map(entry => (
          <p key={entry.id} className="session-msg">
            <b>{entry.actor === 'operator' ? '操作员' : entry.actor}</b> {entry.text}
            <span className="quiet"> · {stampOf(entry.at)}</span>
          </p>
        ))}

      <h3>与 PM 的对话</h3>
      {messages.error ? <p className="empty">{messages.error}</p> : null}
      {(messages.data?.messages.length ?? 0) === 0
        ? <p className="empty">{pm ? '还没有对话。' : '启动 PM 后可以开始对话。'}</p>
        : (messages.data?.messages ?? []).map(message => (
          <p key={message.seq} className="session-msg">
            <b>{message.role === 'assistant' ? 'PM' : message.role === 'user' ? '人' : '消息'}</b> {message.text}
          </p>
        ))}
      <div className="form-block">
        <label htmlFor="pm-message" className="sr-only">发给 PM 的消息</label>
        <textarea id="pm-message" rows={2} maxLength={4000} value={text} disabled={!canMessagePm}
          onChange={event => setText(event.target.value)} placeholder="给 PM 发一条消息" />
        <button type="button" className="action" disabled={action.state.busy || !canMessagePm || text.trim() === ''}
          onClick={send}>发送</button>
      </div>
    </>
  )
}

/** One Ticket of a Project: its state, its Assignment and its review. */
function TicketRow(props: { ticket: ConsoleTicket }): ReactElement {
  const ticket = props.ticket
  return (
    <div className="setting">
      <span>
        <b>{ticket.title}</b>
        <span className="quiet">
          {ticket.assignment ? `执行状态 ${ASSIGNMENT_STATE[ticket.assignment.state] ?? ticket.assignment.state}` : '尚未派工'}
          {ticket.assignment?.report ? ` · 报告 ${REPORT_STATE[ticket.assignment.report.state] ?? ticket.assignment.report.state}` : ''}
          {ticket.review ? ` · ${REVIEW_STATE[ticket.review.state] ?? ticket.review.state}` : ''}
        </span>
      </span>
      <span className={`chip ${statusTone(ticket.status)}`}>{TICKET_STATUS[ticket.status] ?? ticket.status}</span>
    </div>
  )
}

/** What an operator action left behind: its own words, or the control plane's refusal. */
export function ActionLine(props: { state: ActionState }): ReactElement | null {
  if (props.state.error) return <p className="notice failure">{props.state.error}</p>
  if (props.state.message) return <p className="notice success">{props.state.message}</p>
  return null
}

/**
 * The Sessions page: the PM and Worker Sessions, and the actions each role really allows.
 *
 * The actions are the role's own: a message reaches a PM directly and a Worker through its Ticket, a stop ends the Worker's
 * Assignment in the domain, and a revocation takes the Session's authority away for good. The console never accepts a
 * Worker's result on the PM's behalf.
 */
export function SessionsPage(props: PageProps): ReactElement {
  const sessions = useLoaded(() => read<{ sessions: SessionView[] }>('/v1/sessions'), props.revision)
  const projects = useLoaded(
    () => read<{ projects: ConsoleProject[]; standaloneTickets?: ConsoleTicket[] }>('/v1/console/projects'), props.revision)
  const [selected, setSelected] = useState('')
  const [role, setRole] = useState('all')
  const [showDetail, setShowDetail] = useState(false)
  const [creating, setCreating] = useState(false)
  const [projectId, setProjectId] = useState('')
  const action = useAction(props.refresh)
  // The Router is a Session of its own, and it is listed here beside the PM and the Worker Sessions: an operator has to
  // be able to stop it, resume it and interrupt its turn from the same place.
  const list = (sessions.data?.sessions ?? []).filter(session => role === 'all' || session.role === role)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const current = list.find(session => session.sessionId === selected) ?? list[0]
  useEffect(() => {
    if (current && !selected) setSelected(current.sessionId)
  }, [current, selected])
  const standaloneTicket = (id: string): ConsoleTicket | undefined =>
    projects.data?.standaloneTickets?.find(ticket => ticket.id === id)
  const projectTitle = (id: string): string =>
    projects.data?.projects.find(project => project.id === id)?.title
      ?? standaloneTicket(id)?.title
      ?? id
  const projectStatus = (id: string): string =>
    projects.data?.projects.find(project => project.id === id)?.status ?? ''
  const sessionTitle = (session: SessionView): string => {
    if (session.role === 'router') return 'Router'
    const project = projects.data?.projects.find(item => item.id === session.projectId)
    const ticket = project?.tickets.find(item => item.assignment?.id === session.assignmentId)
    return ticket?.title ?? projectTitle(session.projectId)
  }
  /** The Ticket a Worker Session runs, when it has one: the worker's own actions go through it. */
  const ticketOf = (session: SessionView): ConsoleTicket | undefined => {
    if (session.role !== 'worker') return undefined
    const project = projects.data?.projects.find(item => item.id === session.projectId)
    const ticket = project?.tickets.find(item => item.assignment?.id === session.assignmentId)
    return ticket ?? standaloneTicket(session.projectId)
  }
  /** The Session that is the logical superior of this one: the PM of its Project, or the Router. */
  const superiorOf = (session: SessionView): string => {
    if (session.role === 'pm') return session.sessionId
    if (session.role === 'router') return 'router'
    const project = projects.data?.projects.find(item => item.id === session.projectId)
    // A Worker of a standalone Ticket is below the Router, not below a Project's PM.
    return project?.pmSessionId ?? 'router'
  }
  const startable = (projects.data?.projects ?? []).filter(project => project.status === 'active' || project.status === 'paused')
  const target = startable.find(project => project.id === projectId) ?? startable[0]
  const startPm = (): void => {
    if (!target || action.state.busy) return
    action.run(async () => {
      const { session } = await write<{ session: SessionView }>(
        `/v1/console/projects/${encodeURIComponent(target.id)}/pm`)
      setRole('all')
      setSelected(session.sessionId)
      setCreating(false)
    }, '')
  }

  return (
    <div className="workspace-split" data-detail={showDetail}>
      <section className="workspace-index panel" aria-label="会话列表">
        <div className="workspace-toolbar">
          <button type="button" className="action workspace-new" disabled={action.state.busy}
            onClick={() => { setCreating(true); setShowDetail(true) }}>
            <Icon name="plus" />新建会话
          </button>
            <select aria-label="会话类型" title="筛选会话类型" value={role}
              onChange={event => { setRole(event.target.value); setSelected('') }}>
              <option value="all">全部</option>
              <option value="router">Router</option>
              <option value="pm">PM</option>
              <option value="worker">Worker</option>
            </select>
        </div>
        {list.length === 0
          ? <p className="empty">还没有会话。</p>
          : list.map(session => (
            <button key={session.sessionId} className="item" title={session.sessionId}
              aria-pressed={!creating && current?.sessionId === session.sessionId} disabled={action.state.busy}
              onClick={() => { setSelected(session.sessionId); setCreating(false); setShowDetail(true) }}>
              <span className="workspace-item-name">
                <b>{sessionTitle(session)}</b>
                <span className="quiet">{SESSION_ROLE[session.role] ?? session.role} · {timeOf(session.updatedAt)}</span>
              </span>
              <span className={`chip ${session.status === 'running' ? '' : 'muted'}`}>
                {session.revokedAt ? '权限已撤销'
                  : session.operatorStop?.state === 'requested' ? '停止未确认'
                    : session.operatorStop?.state === 'confirmed' ? '已停止'
                    : (SESSION_STATUS[session.status] ?? session.status)}
              </span>
            </button>
          ))}
      </section>
      <section className="workspace-detail session-pane panel" aria-label="会话详情">
        <button type="button" className="workspace-back action" onClick={() => setShowDetail(false)}>返回会话列表</button>
        {sessions.error ? <p className="empty">{sessions.error}</p> : null}
        {creating ? (
          <div className="workspace-create padded">
            <h2>新建会话</h2>
            <form className="form-block" onSubmit={event => { event.preventDefault(); startPm() }}>
              <label htmlFor="session-project">项目</label>
              <select id="session-project" value={target?.id ?? ''} disabled={!target || action.state.busy}
                onChange={event => setProjectId(event.target.value)}>
                {!target ? <option value="">请先创建一个项目</option> : null}
                {startable.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
              </select>
              <div className="detail-actions">
                <button type="submit" className="action primary" disabled={!target || action.state.busy}>打开 PM 会话</button>
                <button type="button" className="action" onClick={() => props.navigate('home')}>去 Router 安排任务</button>
                <button type="button" className="action" disabled={action.state.busy}
                  onClick={() => { setCreating(false); if (!current) setShowDetail(false) }}>取消</button>
              </div>
              <ActionLine state={action.state} />
            </form>
          </div>
        ) : current ? <SessionDetail key={current.sessionId} session={current}
          title={sessionTitle(current)} projectTitle={projectTitle(current.projectId)}
          standalone={standaloneTicket(current.projectId)}
          ticket={ticketOf(current)}
          superiorId={superiorOf(current)}
          projectStatus={projectStatus(current.projectId)} revision={props.revision} refresh={props.refresh} />
          : !sessions.error ? <p className="workspace-empty">从列表选择一个会话，或打开项目的 PM 会话。</p> : null}
      </section>
    </div>
  )
}

/** One Session: its facts, the actions its role allows, and the messages it really exchanged. */
function SessionDetail(props: { session: SessionView; title: string; projectTitle: string; projectStatus: string; revision: number
  refresh: () => void; standalone?: ConsoleTicket | undefined; ticket?: ConsoleTicket | undefined
  superiorId?: string }): ReactElement {
  const [preferences] = useState(readPreferences)
  const messages = useLoaded(
    () => read<{ messages: SessionMessage[] }>(`/v1/console/sessions/${encodeURIComponent(props.session.sessionId)}/messages`),
    props.revision, props.session.sessionId)
  // The notices the logical superior of this Session reads. A stop of this work leaves one behind, so an operator sees
  // what the PM or the Router was told about it.
  const notices = useLoaded(
    () => read<{ stops: StopNotice[] }>(`/v1/console/stops?${superiorQuery(props.session, props.superiorId ?? '')}`),
    props.revision, props.session.sessionId)
  // The Router's queue, read from the Router's own state: the session page and the home page show the same queue, so
  // what one page shows the other shows too. Another Session has no queue, and nothing is read for it.
  const router = useLoaded(
    () => props.session.role === 'router'
      ? read<RouterState>('/v1/console/router')
      : Promise.resolve({ nodeOnline: false, messages: [] } as RouterState),
    props.revision, props.session.role === 'router' ? props.session.sessionId : '')
  const session = props.session
  const [text, setText] = useState('')
  const [permission, setPermission] = useState('read-only')
  const [confirming, setConfirming] = useState(false)
  const [confirmingTicket, setConfirmingTicket] = useState(false)
  const action = useAction(props.refresh)
  const thread = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const history = messages.data?.messages ?? []
  const latest = history.at(-1)?.seq
  const path = `/v1/console/sessions/${encodeURIComponent(session.sessionId)}`
  const revoked = session.revokedAt !== undefined
  // A Session that cannot receive a message any more is not offered one: a Worker a newer Assignment replaced would pass
  // the message to the Worker that took its place, and the server refuses it. The server's own check is the rule; this
  // only keeps the console from asking for a refusal it already knows about.
  const deliverable = session.deliverable !== false
  // The operator's own stop of this Session: a stopped PM or Router is resumed by hand and never by a message.
  const stopped = session.operatorStop
  const unavailable = revoked ? '会话权限已撤销'
    : !deliverable && stopped === undefined ? '这个会话无法接收指令' : ''
  const pmActive = session.role === 'pm' && props.projectStatus === 'active'
  const name = SESSION_ROLE[session.role] ?? session.role
  const pending = messages.data === undefined && !messages.error
  // A turn can only be interrupted while the node reports one, and only on a node that offers the interrupt at all.
  const interruptible = session.interruptible === true && session.currentTurn !== undefined
  const ticket = props.ticket
  const assignmentId = session.assignmentId
  // The Router's queue, on the Router's own page only: another Session has no queue of its own.
  const queue = session.role === 'router' ? (router.data?.queue ?? []) : []

  useEffect(() => {
    const element = thread.current
    if (element && followLatest.current) element.scrollTop = element.scrollHeight
  }, [latest])

  const send = (): void => {
    if (action.state.busy || !deliverable || text.trim() === '') return
    followLatest.current = true
    action.run(async () => {
      const result = await write(`${path}/message`, { text: text.trim() })
      setText(current => current === text ? '' : current)
      return result
    }, session.role === 'pm' ? '' : deliveredWording)
  }

  // The interrupt ends the turn that runs now and nothing else: the Session keeps its identity, its Assignment and its
  // Ticket, and the messages that wait for the next turn stay where they are.
  const interrupt = (withMessage: boolean): void => {
    if (action.state.busy || !interruptible) return
    if (withMessage && text.trim() === '') return
    followLatest.current = true
    // The turn the operator acted on is named, so a turn that started in the meantime is never ended in its place.
    const turn = session.currentTurn
    action.run(async () => {
      const result = await write(`${path}/interrupt`, {
        ...(withMessage ? { text: text.trim() } : {}),
        ...(turn === undefined ? {} : { turn }),
      })
      if (withMessage) setText(current => current === text ? '' : current)
      return result
    }, withMessage ? '' : interruptedWording)
  }

  return (
    <div className="session-view">
      <header className="session-header">
        <div className="session-heading">
          <h2>{props.title}</h2>
          <p>{name}{session.model ? ` · ${session.model}` : ''}</p>
        </div>
        <span className={`chip ${session.status === 'running' && !revoked ? 'success' : 'muted'}`}>
          {revoked ? '权限已撤销'
            : stopped?.state === 'requested' ? '停止未确认'
              : stopped?.state === 'confirmed' ? '已停止'
              : (SESSION_STATUS[session.status] ?? session.status)}
        </span>
      </header>
      {unavailable !== '' ? <p className="notice failure">{unavailable}</p> : null}
      {stopped !== undefined ? (
        <p className="notice">
          操作员于 {stampOf(stopped.at)} 请求停止会话。
          {stopped.state === 'confirmed' ? '节点已确认停止。' : '节点尚未确认停止。'}
          {stopped.error ? ` ${stopped.error}` : ''}
        </p>
      ) : null}
      <details className="session-info">
        <summary>会话信息与管理</summary>
        <div className="session-info-body">
          <dl className="detail-list">
            <div><dt>会话 ID</dt><dd>{session.sessionId}</dd></div>
            {props.standalone ? (
              <div><dt>独立工单</dt><dd>{props.standalone.title}</dd></div>
            ) : <div><dt>项目</dt><dd>{props.projectTitle}</dd></div>}
            {props.standalone?.assignment?.report ? (
              <div><dt>最新回报</dt><dd>{props.standalone.assignment.report.summary}</dd></div>
            ) : null}
            {session.assignmentId ? <div><dt>执行记录 ID</dt><dd>{session.assignmentId}</dd></div> : null}
            <div><dt>工作区</dt><dd>{session.workspace}</dd></div>
            <div><dt>DSH 会话 ID</dt><dd>{session.backendSessionId ?? '—'}</dd></div>
            <div><dt>会话令牌版本</dt><dd>{session.tokenVersion ?? 0}</dd></div>
            <div><dt>最后更新</dt><dd>{stampOf(session.updatedAt)}</dd></div>
            {revoked ? <div><dt>权限撤销时间</dt><dd>{stampOf(session.revokedAt!)}{session.revokedReason ? ` · ${session.revokedReason}` : ''}</dd></div> : null}
          </dl>

          <div className="detail-actions">
            {session.role === 'worker'
              ? <>
                <button type="button" className="action" disabled={action.state.busy || revoked || assignmentId === undefined}
                  title="只结束这一次派工：工单仍然开着，同一项目的其他 Worker 继续运行。"
                  onClick={() => action.run(() => write(`/v1/console/assignments/${encodeURIComponent(assignmentId!)}/stop`,
                    { reason: '操作员在控制台停止了这个 Worker 的派工' }), stoppedWording)}>停止这次派工</button>
                {ticket ? <>
                  <button type="button" className="action" disabled={action.state.busy || revoked || confirmingTicket}
                    title="结束整个工单：同一项目的其他工单与 Worker 不受影响。"
                    onClick={() => setConfirmingTicket(true)}>取消工单</button>
                  <button type="button" className="action" disabled={action.state.busy || revoked}
                    title="清除工单上人工停止的标记，让 PM 可以申请新的派工；不会自己启动任何 Worker。"
                    onClick={() => action.run(() => write(`/v1/console/tickets/${encodeURIComponent(ticket.id)}/resume`,
                      { reason: '操作员在控制台允许了这个 Worker 恢复' }), '工单已允许恢复')}>允许恢复</button>
                </> : null}
              </> : <>
                <button type="button" className="action" disabled={action.state.busy || revoked || stopped?.state === 'confirmed'}
                  title={session.role === 'pm'
                    ? '只停止这个 PM 会话：项目、工单、派工和其他 Worker 一律不动，需要人工恢复。'
                    : '只停止这个 Router 会话：已有工单和 PM 授权一律不动，需要人工恢复。'}
                  onClick={() => action.run(() => write(`${path}/cancel`, { reason: '操作员在控制台停止了这个会话' }),
                    sessionStoppedWording)}>{stopped?.state === 'requested' ? '重试停止会话' : '停止会话'}</button>
                {stopped?.state === 'confirmed' ? <button type="button" className="action" disabled={action.state.busy || revoked}
                  title="只有操作员能恢复这个会话；恢复后旧令牌一律失效。"
                  onClick={() => action.run(() => write(`${path}/resume`, { reason: '操作员在控制台恢复了这个会话' }),
                    '会话已恢复')}>恢复会话</button> : null}
              </>}
            {session.role !== 'worker' && !pmActive
              ? <button type="button" className="action" disabled={action.state.busy || revoked}
                onClick={() => action.run(() => write(`${path}/archive`, {}), '会话已归档')}>归档</button>
              : null}
            {interruptible ? <>
              <button type="button" id="session-interrupt" className="action" disabled={action.state.busy}
                title="只打断当前这一回合：会话、派工和工单都不变，排队的消息也不会被丢掉。"
                onClick={() => interrupt(false)}>打断当前回合</button>
              <button type="button" id="session-interrupt-and-send" className="action"
                disabled={action.state.busy || text.trim() === ''}
                title="先打断当前这一回合，再把下面写的话交给下一轮。"
                onClick={() => interrupt(true)}>中断并插话</button>
            </> : null}
            <label className="quiet">
              权限{' '}
              <select value={permission} onChange={event => setPermission(event.target.value)}>
                <option value="read-only">read-only</option>
                <option value="workspace-write">workspace-write</option>
                <option value="danger-full-access">danger-full-access</option>
              </select>
            </label>
            <button type="button" className="action" disabled={action.state.busy || revoked}
              onClick={() => action.run(() => put(`${path}/permission`, { permission }), '权限已修改')}>应用权限</button>
            {confirming
              ? <>
                <button type="button" id="session-revoke-confirm" className="action danger" disabled={action.state.busy}
                  onClick={() => {
                    setConfirming(false)
                    action.run(() => write(`${path}/revoke`, { reason: '操作员在控制台撤回了这个会话的权限' }),
                      revokedWording)
                  }}>确认撤销权限</button>
                <button type="button" className="action" disabled={action.state.busy}
                  onClick={() => setConfirming(false)}>取消</button>
              </>
              : <button type="button" id="session-revoke" className="action danger" disabled={action.state.busy || revoked}
                onClick={() => setConfirming(true)}>撤销权限</button>}
          </div>
          {confirmingTicket && ticket ? (
            <div className="notice failure">
              <p>取消会结束工单「{ticket.title}」和它当前的派工。其他工单继续运行。</p>
              <button type="button" className="action danger" disabled={action.state.busy || revoked}
                onClick={() => {
                  setConfirmingTicket(false)
                  action.run(() => write(`/v1/console/tickets/${encodeURIComponent(ticket.id)}/cancel`,
                    { reason: '操作员在控制台取消了这个工单' }), ticketStoppedWording)
                }}>确认取消工单</button>
              <button type="button" className="action" onClick={() => setConfirmingTicket(false)}>返回</button>
            </div>
          ) : null}
          {confirming ? (
            <p className="notice failure">
              撤销后，此会话将永久失去工具权限。系统也会尝试停止会话。
            </p>
          ) : null}
        </div>
      </details>
      {notices.data?.stops?.length ? (
        <details className="session-info" open>
          <summary>上级收到的停止通知</summary>
          <div className="session-info-body">
            <ul className="notice-list">
              {notices.data.stops.map(notice => (
                <li key={notice.id}>
                  <b>{notice.target.kind} {notice.target.id}</b> · {notice.scope} ·
                  {' '}{notice.state === 'confirmed' ? '节点已确认' : '节点未确认'}
                  {notice.affected.length ? ` · 影响 ${notice.affected.join('、')}` : ''}
                  {notice.unaffected.length ? ` · 未受影响 ${notice.unaffected.join('、')}` : ''}
                  {notice.error ? ` · ${notice.error}` : ''}
                  <span className="quiet"> · {stampOf(notice.at)}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
      {queue.length ? <RouterQueue entries={queue} id="session-router-queue" /> : null}
      <div className="session-thread" ref={thread} role="log" aria-label="对话"
        onScroll={event => {
          const element = event.currentTarget
          followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32
        }}>
        <div className="session-transcript">
          {messages.error ? <p className="empty">{messages.error}</p> : null}
          {pending ? <p className="empty">正在读取会话…</p> : null}
          {!pending && !messages.error && history.length === 0 ? <p className="empty">还没有对话。</p> : null}
          {history.map(message => message.role === 'assistant' ? (
            <article className="session-answer" aria-label={`${name} 的回复`} key={message.seq}>
              <div className="session-message-meta"><b>{name}</b><time dateTime={message.at}>{timeOf(message.at)}</time></div>
              <Markdown text={message.text} />
            </article>
          ) : (
            <article key={message.seq} className={message.role === 'user' ? 'router-ask' : 'session-event'}
              aria-label={message.role === 'user' ? '你的消息' : '会话消息'}>
              {message.text}
            </article>
          ))}
        </div>
      </div>
      <div className="session-bottom">
        <form className="composer session-composer" onSubmit={event => { event.preventDefault(); send() }}>
          <label htmlFor="session-message" className="sr-only">发给这个会话的消息</label>
          <textarea id="session-message" rows={2} maxLength={4000} value={text} disabled={!deliverable}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || !preferences.enterToSend
                || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
              event.preventDefault()
              send()
            }}
            placeholder={unavailable === '' ? `给 ${name} 发消息` : unavailable} />
          <button type="submit" className="send-round" aria-label="发送"
            disabled={action.state.busy || !deliverable || text.trim() === ''}><Icon name="arrowUp" /></button>
        </form>
        <ActionLine state={action.state} />
      </div>
    </div>
  )
}

/**
 * The browser's own timezone, as a person reads it.
 *
 * The plan's own time base is a fixed offset (UTC by default) and is shown beside it; the browser's zone is only ever the
 * place the page happens to be read in, so it is labelled as such.
 */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '未知时区'
  } catch {
    return '未知时区'
  }
}

/** A fixed offset, as `UTC+08:00`. */
function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC'
  const sign = minutes > 0 ? '+' : '-'
  const absolute = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

/** A moment read in the plan's own time base, as `MM-DD HH:MM`. */
function atOffset(at: string, offsetMinutes: number): string {
  const moment = new Date(at)
  if (Number.isNaN(moment.getTime())) return at
  const shifted = new Date(moment.getTime() + offsetMinutes * 60_000)
  const day = `${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
  return `${day} ${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`
}

function scheduleRuleLabel(plan: SchedulePlan): string {
  const interval = /^every:(\d+)([mhd])$/.exec(plan.rule)
  if (interval) {
    const units: Record<string, string> = { m: '分钟', h: '小时', d: '天' }
    return `每隔 ${interval[1]} ${units[interval[2]!]}`
  }
  if (plan.rule.startsWith('daily:')) return `每天 ${plan.rule.slice('daily:'.length)}`
  const weekly = /^weekly:([1-7,]+)@(\d{2}:\d{2})$/.exec(plan.rule)
  if (!weekly) return plan.ruleText
  const weekdays = '一二三四五六日'
  const days = weekly[1]!.split(',').map(day => `周${weekdays[Number(day) - 1]}`).join('、')
  return `每${days} ${weekly[2]}`
}

function ScheduleRuleHelp(props: { id: string }): ReactElement {
  return <p className="quiet" id={props.id}>
    <code>every:30m</code> 每 30 分钟，<code>daily:09:00</code> 每天 9 点，
    <code>weekly:1,3@18:00</code> 每周一和周三 18 点。星期一到星期日用 1 到 7 表示。
  </p>
}

/** How a run ended, in the console's own words. */
const RUN_STATE: Record<string, string> = {
  pending: '待开始',
  running: '投递中',
  delivered: '已送达',
  failed: '失败',
  interrupted: '被中断',
}

/**
 * The Schedules page: the plans the control plane's scheduler really holds.
 *
 * A plan is a clock and a sentence. When it comes due, the scheduler hands one message to the PM the Project already has,
 * and nothing else happens: no Ticket, no Worker, no command, no shell. The page therefore shows the rule, the next moment
 * it comes due, and what every run of it did — including the runs that failed, with the reason the control plane gave.
 *
 * The time base is fixed and shown: the plans run on UTC unless the deployment configured another fixed offset, and the
 * browser's own timezone is labelled as the place the page is read in, never as the clock the plan uses.
 */
export function SchedulesPage(props: PageProps): ReactElement {
  const schedules = useLoaded(() => read<{ plans: SchedulePlan[]; overview: ScheduleCounts;
    timeZoneOffsetMinutes: number }>('/v1/console/schedules'), props.revision)
  const projects = useLoaded(() => read<{ projects: ConsoleProject[] }>('/v1/console/projects'), props.revision)
  const [creating, setCreating] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [name, setName] = useState('')
  const [rule, setRule] = useState('daily:09:00')
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState('')
  const [editing, setEditing] = useState('')
  const [editName, setEditName] = useState('')
  const [editRule, setEditRule] = useState('')
  const [editMessage, setEditMessage] = useState('')
  const [confirming, setConfirming] = useState('')
  const action = useAction(props.refresh)

  const offset = schedules.data?.timeZoneOffsetMinutes ?? 0
  const all = schedules.data?.plans ?? []
  const projectList = projects.data?.projects ?? []
  // The home page's failure cell leads here: the plans whose last run failed come first, and the first of them is opened.
  const failed = all.filter(plan => plan.lastState === 'failed')
  const shown = props.focus === 'failed' && failed.length > 0 ? failed : all
  const current = shown.find(plan => plan.id === selected) ?? shown[0]
  const runs = useLoaded(() => read<{ runs: ScheduleRun[] }>(
    current === undefined ? '/v1/console/schedules/none/runs'
      : `/v1/console/schedules/${encodeURIComponent(current.id)}/runs`), props.revision, current?.id ?? '')

  const create = (): void => {
    if (projectId.trim() === '' || name.trim() === '' || message.trim() === '') {
      action.run(() => Promise.reject(new Error('请选择项目，并填写任务名称和消息内容。')))
      return
    }
    action.run(() => write('/v1/console/schedules', { projectId: projectId.trim(), name: name.trim(),
      rule: rule.trim(), message: message.trim() }), '定时任务已创建')
    setName('')
    setMessage('')
    setCreating(false)
  }

  const save = (plan: SchedulePlan): void => {
    action.run(() => put(`/v1/console/schedules/${encodeURIComponent(plan.id)}`,
      { name: editName.trim(), rule: editRule.trim(), message: editMessage.trim() }), '定时任务已修改')
    setEditing('')
  }

  const startEdit = (plan: SchedulePlan): void => {
    setEditing(plan.id)
    setEditName(plan.name)
    setEditRule(plan.rule)
    setEditMessage(plan.message)
  }

  return (
    <div className="split">
      <section className="panel" aria-label="定时任务列表">
        <div className="padded">
          <button type="button" id="schedule-create-toggle" className="action primary"
            onClick={() => setCreating(value => !value)}>{creating ? '收起' : '新建定时任务'}</button>
          {creating ? (
            <div className="form-block">
              <label htmlFor="schedule-project">项目</label>
              <select id="schedule-project" value={projectId} onChange={event => setProjectId(event.target.value)}>
                <option value="">选一个项目</option>
                {projectList.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
              </select>
              <label htmlFor="schedule-name">名称</label>
              <input id="schedule-name" value={name} maxLength={120}
                onChange={event => setName(event.target.value)} placeholder="这个任务叫什么" />
              <label htmlFor="schedule-rule">运行时间</label>
              <input id="schedule-rule" value={rule} maxLength={120} aria-describedby="schedule-rule-help"
                onChange={event => setRule(event.target.value)} placeholder="daily:09:00" />
              <ScheduleRuleHelp id="schedule-rule-help" />
              <label htmlFor="schedule-message">发给 PM 的消息</label>
              <textarea id="schedule-message" rows={3} maxLength={2000} value={message}
                onChange={event => setMessage(event.target.value)} placeholder="填写到时发给项目 PM 的消息" />
              <button type="button" id="schedule-create" className="action primary" disabled={action.state.busy}
                onClick={create}>创建</button>
            </div>
          ) : null}
        </div>
        {schedules.error ? <p className="empty">{schedules.error}</p> : null}
        {!schedules.error && all.length === 0
          ? <p className="empty">暂无定时任务。创建后，系统会按设定时间给项目 PM 发消息。</p>
          : null}
        {props.focus === 'failed' && failed.length > 0 ? (
          <p className="notice failure">{failed.length} 个定时任务上次发送失败。
            <button type="button" id="schedule-show-all" className="action" onClick={() => props.navigate('schedules')}>
              显示全部</button>
          </p>
        ) : null}
        {shown.map(plan => (
          <button key={plan.id} className="item" aria-pressed={current?.id === plan.id}
            onClick={() => setSelected(plan.id)}>
            <span>
              <b>{plan.name}</b>
              <span className="quiet">{plan.projectTitle} · {scheduleRuleLabel(plan)}</span>
            </span>
            <span className={`chip ${plan.lastState === 'failed' ? 'failure' : plan.enabled ? 'success' : 'muted'}`}>
              {plan.lastState === 'failed' ? '上次发送失败' : plan.enabled ? '已启用' : '已暂停'}
            </span>
          </button>
        ))}
      </section>

      <section className="panel padded" aria-label="定时任务详情">
        {current === undefined ? <p className="empty">还没有定时任务。</p> : (
          <ScheduleDetail plan={current} offset={offset} runs={runs.data?.runs ?? []} error={runs.error}
            editing={editing === current.id} name={editName} rule={editRule} message={editMessage}
            onEdit={() => startEdit(current)} onCancelEdit={() => setEditing('')}
            onSave={() => save(current)} onName={setEditName} onRule={setEditRule} onMessage={setEditMessage}
            confirming={confirming === current.id} onAskDelete={() => setConfirming(current.id)}
            onCancelDelete={() => setConfirming('')}
            action={action} />
        )}
        <ActionLine state={action.state} />
      </section>
    </div>
  )
}

/** One plan: its facts, its actions and the history of its runs. */
function ScheduleDetail(props: {
  plan: SchedulePlan
  offset: number
  runs: ScheduleRun[]
  error: string
  editing: boolean
  name: string
  rule: string
  message: string
  onEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  onName: (value: string) => void
  onRule: (value: string) => void
  onMessage: (value: string) => void
  confirming: boolean
  onAskDelete: () => void
  onCancelDelete: () => void
  action: { state: ActionState; run: (work: () => Promise<unknown>, done?: string | ((result: unknown) => string)) => void }
}): ReactElement {
  const plan = props.plan
  const path = `/v1/console/schedules/${encodeURIComponent(plan.id)}`
  return (
    <>
      <h2>{plan.name}</h2>
      <dl className="detail-list">
        <div><dt>项目</dt><dd>{plan.projectTitle}（{PROJECT_STATUS[plan.projectStatus] ?? plan.projectStatus}）</dd></div>
        <div><dt>运行时间</dt><dd>{scheduleRuleLabel(plan)} · <code className="quiet">{plan.rule}</code></dd></div>
        <div><dt>任务时区</dt><dd>{offsetLabel(props.offset)}（固定偏移，不随夏令时变化）</dd></div>
        <div><dt>浏览器时区</dt><dd>{browserTimeZone()}（用于显示本地时间）</dd></div>
        <div><dt>下次运行</dt><dd>{stampOf(plan.nextAt)} · 任务时区 {atOffset(plan.nextAt, props.offset)}</dd></div>
        <div><dt>状态</dt><dd>{plan.enabled ? '已启用' : '已暂停'}</dd></div>
        {plan.lastAt ? <div><dt>上次运行</dt><dd>{stampOf(plan.lastAt)} · {RUN_STATE[plan.lastState ?? ''] ?? plan.lastState}</dd></div> : null}
        {plan.lastError ? <div><dt>失败原因</dt><dd>{plan.lastError}</dd></div> : null}
        <div><dt>发给 PM 的消息</dt><dd>{plan.message}</dd></div>
      </dl>

      {props.editing ? (
        <div className="form-block">
          <label htmlFor="schedule-edit-name">名称</label>
          <input id="schedule-edit-name" value={props.name} maxLength={120}
            onChange={event => props.onName(event.target.value)} />
          <label htmlFor="schedule-edit-rule">运行时间</label>
          <input id="schedule-edit-rule" value={props.rule} maxLength={120} aria-describedby="schedule-edit-rule-help"
            onChange={event => props.onRule(event.target.value)} />
          <ScheduleRuleHelp id="schedule-edit-rule-help" />
          <label htmlFor="schedule-edit-message">发给 PM 的消息</label>
          <textarea id="schedule-edit-message" rows={3} maxLength={2000} value={props.message}
            onChange={event => props.onMessage(event.target.value)} />
          <button type="button" id="schedule-edit-save" className="action primary" disabled={props.action.state.busy}
            onClick={props.onSave}>保存</button>
          <button type="button" id="schedule-edit-cancel" className="action" disabled={props.action.state.busy}
            onClick={props.onCancelEdit}>取消</button>
        </div>
      ) : null}

      <div className="detail-actions">
        <button type="button" id="schedule-edit" className="action" disabled={props.action.state.busy || props.editing}
          onClick={props.onEdit}>编辑</button>
        {plan.enabled
          ? <button type="button" id="schedule-pause" className="action" disabled={props.action.state.busy}
            onClick={() => props.action.run(() => write(`${path}/pause`, {}), '定时任务已暂停')}>暂停</button>
          : <button type="button" id="schedule-resume" className="action" disabled={props.action.state.busy}
            onClick={() => props.action.run(() => write(`${path}/resume`, {}), '定时任务已恢复')}>恢复</button>}
        <button type="button" id="schedule-run" className="action primary" disabled={props.action.state.busy}
          onClick={() => props.action.run(() => write(`${path}/run`, {}), '消息已发给项目 PM')}>立即运行</button>
        {props.confirming
          ? <>
            <button type="button" id="schedule-delete-confirm" className="action danger" disabled={props.action.state.busy}
              onClick={() => {
                props.onCancelDelete()
                props.action.run(() => remove(`${path}`), '定时任务已删除')
              }}>确认删除</button>
            <button type="button" id="schedule-delete-cancel" className="action" disabled={props.action.state.busy}
              onClick={props.onCancelDelete}>取消</button>
          </>
          : <button type="button" id="schedule-delete" className="action danger" disabled={props.action.state.busy}
            onClick={props.onAskDelete}>删除</button>}
      </div>
      {props.confirming ? (
        <p className="notice failure">
          删除后，系统会保留运行记录和已发送的消息。
        </p>
      ) : null}
      <p className="status-note">
        到了设定时间，系统会把消息发给已启动的项目 PM，供它参考。后续是否派工由 PM 决定。
      </p>

      <h3>运行历史</h3>
      {props.error ? <p className="empty">{props.error}</p> : null}
      {!props.error && props.runs.length === 0
        ? <p className="empty">这个任务还没有运行过。</p>
        : props.runs.map(run => (
          <div key={run.runId} className="setting">
            <span>
              <b>{run.reason === 'manual' ? '手动运行' : '按计划运行'} · {RUN_STATE[run.state] ?? run.state}</b>
              <span className="quiet">
                {stampOf(run.finishedAt ?? run.plannedAt)}
                {run.acknowledged ? ' · 节点已确认' : ' · 未确认'}
                {run.skipped > 0 ? ` · 跳过 ${run.skipped} 次` : ''}
                {run.error ? ` · ${run.error}` : ''}
              </span>
            </span>
            <span className={`chip ${run.state === 'delivered' ? 'success' : run.state === 'failed' ? 'failure' : 'muted'}`}>
              {run.state === 'delivered' ? '已送达' : run.state === 'failed' ? '失败' : run.state === 'interrupted' ? '被中断' : '进行中'}
            </span>
          </div>
        ))}
    </>
  )
}

/**
 * The Nodes page: the node the control plane really talks to, and the reconciliation of the Sessions it holds.
 *
 * The console can request reconciliation immediately. A deployment may also enable periodic reconciliation.
 */
export function NodesPage(props: PageProps): ReactElement {
  const overview = useLoaded(() => read<Overview>('/v1/overview'), props.revision)
  const run = useLoaded(() => read<{ run: ReconcileRun | null }>('/v1/console/reconcile/latest'), props.revision)
  const action = useAction(props.refresh)
  const nodes = overview.data?.nodes ?? []
  const last = run.data?.run ?? null

  return (
    <section className="panel padded">
      <h2>执行节点</h2>
      {overview.error ? <p className="empty">{overview.error}</p> : null}
      {!overview.error && nodes.length === 0 ? <p className="empty">暂无节点记录。</p> : null}
      {nodes.map(node => <NodeCard key={node.nodeId} node={node} />)}

      <h3>清理残留会话</h3>
      <p className="quiet">
        检查这个控制面创建的会话。任务或项目已经结束，且节点确认对应的 Worker 或 PM 会话仍在运行时，系统会停止并归档该会话。
        节点找不到会话、会话还在启动或状态不明时，只记录结果。
      </p>
      <div className="detail-actions">
        <button type="button" className="action primary" disabled={action.state.busy}
          onClick={() => action.run(async () => {
            const { result } = await write<{ result: ReconcileRun }>('/v1/console/reconcile/run', {})
            if (result.nodeOnline) return
            props.refresh()
            throw new Error('节点离线，未进行检查')
          }, '检查已完成')}>
          {action.state.busy ? '正在检查…' : '检查并清理'}
        </button>
      </div>
      <ActionLine state={action.state} />
      {run.error ? <p className="notice failure">{run.error}</p> : null}
      {last === null
        ? (run.data ? <p className="empty">暂无检查记录。</p> : null)
        : <>
          <dl className="detail-list">
            <div><dt>上次检查</dt><dd>{stampOf(last.at)}</dd></div>
            <div><dt>检查结果</dt><dd>{last.nodeOnline ? '已完成' : '节点离线，未进行检查'}</dd></div>
            <div><dt>已检查会话</dt><dd>{last.checked}</dd></div>
            <div><dt>发现残留会话</dt><dd>{last.counts.orphans}</dd></div>
            <div><dt>已停止并归档</dt><dd>{last.counts.cleaned}</dd></div>
            <div><dt>清理失败</dt><dd>{last.counts.failed}</dd></div>
            <div><dt>仅记录异常</dt><dd>{last.counts.reported}</dd></div>
          </dl>
          {last.nodeOnline && last.findings.length === 0 ? <p className="empty">未发现需要处理的会话。</p> : null}
          {last.findings.map(finding => <FindingRow key={finding.id} finding={finding} />)}
        </>}
    </section>
  )
}

/** One finding of a reconciliation run. */
function FindingRow(props: { finding: ReconcileFinding }): ReactElement {
  const finding = props.finding
  const reason = finding.outcome === 'failed' || finding.kind === 'unknown-status' ? finding.reason : undefined
  return (
    <div className="setting">
      <span>
        <b>{FINDING_KIND[finding.kind] ?? finding.kind}</b>
        <span className="quiet">{finding.sessionId}{reason ? ` · ${reason}` : ''}</span>
      </span>
      <span className={`chip ${finding.outcome === 'failed' ? 'failure' : finding.outcome === 'ok' ? 'success' : 'muted'}`}>
        {finding.outcome === 'ok' ? '已归档' : finding.outcome === 'failed' ? '清理失败' : '仅记录'}
      </span>
    </div>
  )
}

/** One node and its real state. */
function NodeCard(props: { node: NodeView }): ReactElement {
  const node = props.node
  return (
    <>
      <dl className="detail-list">
        <div><dt>节点 ID</dt><dd>{node.nodeId}</dd></div>
        <div><dt>后端</dt><dd>{node.backend}</dd></div>
        <div><dt>版本</dt><dd>{node.version}</dd></div>
        <div><dt>连接状态</dt><dd><span className={`chip ${node.online ? 'success' : 'failure'}`}>{node.online ? '在线' : '离线'}</span></dd></div>
        <div><dt>最后心跳</dt><dd>{stampOf(node.at)}</dd></div>
        <div><dt>能力</dt><dd>{node.capabilities?.length ? node.capabilities.join('、') : '—'}</dd></div>
      </dl>
    </>
  )
}
