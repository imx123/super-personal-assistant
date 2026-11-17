/** Standalone control-plane kernel: domain state, PM/Worker Session records, and a NodePort. No DSH imports. */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Store } from '../app/store.ts'
import { assignmentStopped, canRetry, currentReview, latestAssignment, pendingReview, runningAssignment, waitsForPerson,
  type Assignment, type AssignmentState, type ProjectProfile, type ProjectReport, type ProjectTicketTask, type Ticket,
  type TicketInput, type TicketMessageDelivery, type TicketReview, type Trigger, type WorkerReport } from '../core/index.ts'
import { key } from '../core/ids.ts'
import { KV, type Key } from '../kv.ts'
import { redact } from '../infra/redact.ts'
import { NODE_CAPABILITY_TURN_INTERRUPT, NODE_PROTOCOL_VERSION, NodeUnconfirmedError, PROJECT_GATE_CONDITIONS,
  type ProjectGateCondition } from '../shared/protocol.ts'
import type { ConsoleRuntimeSettings, NodeCommand, NodeEvent, NodePort, NodeRegistration, NodeStatus, OperatorStop, ReviewDiffResult, RoleProfile, RouterModel,
  RouterOptions, RouterTextAttachment,
  SessionInspection, SessionRecord, SessionStatus } from '../shared/protocol.ts'
import { issueSessionToken, verifySessionToken, type SessionTokenClaims } from '../shared/session-token.ts'
import { workspaceDirectory } from '../shared/workspace-path.ts'
import { AuditRecorder, type AuditActor } from './console-audit.ts'
import { ConsoleStore, type ConsoleAuditRow, type ConsoleEventRow, type FastRouteRow, type ProjectGateRow,
  type ProjectMemoryRow, type RouterHandoffRow, type RouterQueueRow, type StopNoticeRow } from './console-store.ts'
import { createKernelDomain, type KernelDomain } from './domain.ts'
import { NodeExecutor, type DeliveryOutcome } from './executor.ts'
import { asksForAuthority, asksForIrreversible, FAST_ROUTE_MIN_CONFIDENCE, fastRoute, type FastRouteDecision, type FastRouteFacts, type FastRouteOutcome,
  type FastRouteStage, type FastRouteTarget } from './fast-router.ts'
import { pmReportKey, pmReportMessage, type PmReportFacts } from './pm-report.ts'
import { evaluateProjectGate, explicitProjectRequest, namedProject,
  ProjectGateError, readProjectGateDecision, type ProjectGateDecision, type ProjectGateFinding,
  type ProjectGateModule, type ProjectGateProject, type ProjectGateVerdict } from './project-gate.ts'
import { Reconciler, type ReconcileFinding, type ReconcileResult } from './reconcile.ts'
import { reportCallKey, reportCallPrefix, reportPayloadHash, type ReportCallRecord } from './report-call.ts'
import { fenceDiff, PM_REVIEW_DIFF_NOTE, type PmReviewDiff } from './review-diff.ts'
import { createOnlyRequest, evaluateRouterHandoff, mentionedProjects, readRouterHandoffDecision, RouterHandoffError,
  type RouterHandoffDecision, type RouterHandoffProject, type RouterHandoffVerdict } from './router-handoff.ts'
import { RouterRequests, routerAutoInstructionMessage, routerInstructionMessage, routerProjectBriefMessage,
  routerRequestMessage, routerRequestOf,
  type RouterManagement, routerProjectReportMessage, type RouterProposal, type RouterRequest } from './router.ts'
import { DEFAULT_TICK_MS, Scheduler, type ScheduleAuditEntry, type ScheduleDelivery, type ScheduleDeliveryResult, type ScheduleOverview,
  type SchedulePlan, type ScheduleRun } from './scheduler.ts'
import { PM_PROFILE, ROUTER_PROFILE, WORKER_PROFILE } from './roles.ts'

/**
 * Statuses a node reported that already settle an ensure. A record in one of them is a Session whose lifecycle is known,
 * so a later transport error must not rewrite it as `failed`. `starting` and `failed` are the states that still need a
 * (re)confirmation.
 */
const NODE_CONFIRMED: ReadonlySet<SessionStatus> = new Set(['idle', 'running', 'stopping', 'stopped', 'archived'])

/** The interval the standalone control plane keeps its node's liveness fresh with when nothing else is configured. */
const DEFAULT_HEARTBEAT_MS = 10_000
const RUNTIME_SETTINGS_KEY = 'runtime-settings.v1'
const MAX_TIMER_MS = 2_147_483_647

function parseRuntimeSettings(value: unknown): ConsoleRuntimeSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperatorError(400, '运行设置必须是对象。')
  }
  const record = value as Record<string, unknown>
  const integer = (key: keyof ConsoleRuntimeSettings, max: number): number => {
    const value = record[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
      throw new OperatorError(400, `${key} 必须是 0 到 ${max} 之间的整数。`)
    }
    return value
  }
  return {
    schedulerTickMs: integer('schedulerTickMs', MAX_TIMER_MS),
    reconcileIntervalMs: integer('reconcileIntervalMs', MAX_TIMER_MS),
    tokenRefreshGraceSeconds: integer('tokenRefreshGraceSeconds', Number.MAX_SAFE_INTEGER),
  }
}

/**
 * The Source an operator request is recorded as.
 *
 * The standalone control plane has no Source of its own: a request arrives over the operator API, so it is recorded on the
 * internal Source, the one the domain already uses for Triggers nobody received from a channel. The Trigger is a person's
 * request (`human: true`), which is what the kernel's gate admits a Project from.
 */
const PROJECT_REQUEST_SOURCE = 'internal'

/** The actor an operator request is recorded as: the person who holds the control-plane token. */
const PROJECT_REQUEST_ACTOR = 'operator'

/**
 * The Router Session's id: one Session for the whole control plane.
 *
 * The Router belongs to no Project, so its id is fixed and its workspace is its own: every Project keeps its own PM and
 * its own Workers, and the Router never shares a directory with any of them.
 */
export const ROUTER_SESSION_ID = 'router'

/**
 * The Project id the Router's record carries.
 *
 * A Session record names the Project it works for, and a token names the same id; the Router works for no Project, so it
 * carries a reserved one that no real Project can have — a Project id is a hash of its Trigger, never a plain word.
 */
export const ROUTER_PROJECT_ID = 'router'

/**
 * How long the control plane waits for the node to confirm a Worker's stop.
 *
 * The node's own cancel settles within ten seconds (see `DshPortHost.cancelSession`), so this bound is a little wider: it
 * covers the node's deadline plus the round trip, and a node that never answers fails the wait instead of holding the PM's
 * tool call open.
 */
const STOP_CLEANUP_TIMEOUT_MS = 15_000

/**
 * How long a stop waits for a Worker Session whose creation is still in flight.
 *
 * A cancel that reaches the node before the Session exists is a cancel of nothing, and the create that follows brings the
 * Worker back. The creation is therefore awaited first; this bound keeps a node that never answers from holding the PM's
 * tool call open, and a creation that outlives it leaves the stop unconfirmed rather than falsely successful.
 */
const ENSURE_SETTLE_TIMEOUT_MS = 10_000

/**
 * How long a message waits for the node's own confirmation before the answer says it was not confirmed.
 *
 * The node's command timeout is the real bound; this one is the control plane's own, so a transport that never settles
 * leaves the operator with an honest answer instead of a request that never returns.
 */
const DELIVERY_CONFIRM_TIMEOUT_MS = 30_000

/**
 * How long after its expiry a Session token may still rotate itself through the refresh route.
 *
 * Five minutes covers the gap between a long tool call starting and the node's proxy noticing a 401, without turning an
 * expired bearer credential into a second class of long-lived credential: ordinary tool and message routes never use it.
 */
export const DEFAULT_TOKEN_REFRESH_GRACE_SECONDS = 300

/**
 * How many distinct report contents one Assignment keeps as "the PM already knows this".
 *
 * The memory is the kernel's own and stays small: an Assignment that reports many different Progress summaries keeps
 * the newest ones, so a very old report may wake the PM once more.
 */
const NOTIFIED_REPORTS_PER_ASSIGNMENT = 32

/**
 * How many events the kernel keeps in memory.
 *
 * The durable log is the one that keeps the history; this array is the recent window a subscriber reads. It is bounded so
 * a control plane that runs for weeks does not grow without limit.
 */
const EVENT_MEMORY_LIMIT = 2000

/** How many events one page of the history holds. */
export const EVENT_REPLAY_LIMIT = 1000

/** How many messages of one Session the console may read. */
const SESSION_MESSAGE_LIMIT = 200

/**
 * How many entries of a Project's memory the PM reads and the console shows.
 *
 * A memory is a note, not a log: the PM reads the newest ones, and an unbounded answer would crowd out the Project and
 * its Tickets, which are the facts a PM acts on.
 */
export const PROJECT_MEMORY_LIMIT = 20

/** How long one entry of a Project's memory may be. */
export const PROJECT_MEMORY_TEXT_LIMIT = 500

/** How many entries one Project's memory keeps. */
const PROJECT_MEMORY_KEPT = 200

/**
 * How many stop notices one reader sees.
 *
 * A notice is a fact about a stop, not a log of everything that happened: the newest ones are the ones a PM or the
 * Router has to know about, and the bound keeps the answer from growing with the life of the control plane.
 */
const PROJECT_STOP_NOTICE_LIMIT = 20

/**
 * How many of the Router's queued messages one reader sees.
 *
 * The queue is a task list, not a history: the messages that wait and the ones that failed are what a person has to see,
 * and the ones that were read long ago are only noise.
 */
const ROUTER_QUEUE_SHOWN = 50

/**
 * How many messages the Router's queue holds at most.
 *
 * The queue is a task list, not a history: a person may write while the Router answers, and the messages wait in the
 * order they were written. The bound is what keeps that promise honest — a queue that grows without end would promise a
 * turn that never comes. A full queue refuses the new message before it is accepted, and the messages that are already
 * there keep their place: nothing is pushed out to make room.
 */
const ROUTER_QUEUE_LIMIT = 50

/**
 * How many messages the queue still holds, counted over the states that are not final.
 *
 * A message that waits, that is on its way, that the node took or whose receipt is missing is still a task: it occupies
 * the queue until a turn reads it or a refusal ends it.
 */
const ROUTER_QUEUE_PENDING = ['queued', 'sending', 'sent', 'unconfirmed'] as const

/**
 * How long the queue waits before it looks at the Router again.
 *
 * The Router's own turn end is what usually releases the queue. This is the safety net for the case where that event
 * never arrived: a message that waits must not wait for ever because one event was lost.
 */
const ROUTER_QUEUE_RETRY_MS = 5_000

/**
 * How many routings the console shows.
 *
 * The routings are a task list like the queue: the ones a person still waits for are what has to be readable, and the
 * ones that came to rest long ago are only noise.
 */
const FAST_ROUTE_SHOWN = 50

/**
 * How many decisions of the Project Gate the console shows.
 *
 * The decisions are what a person reads to learn why their request did or did not become a Project, so the newest ones
 * are the ones that are kept.
 */
const PROJECT_GATE_SHOWN = 50

/**
 * How many handoffs to a Project's PM the console shows.
 *
 * They are the deliveries the high-level Router made on its own, so a person may see where their message went and what
 * the PM really answered with it.
 */
const ROUTER_HANDOFF_SHOWN = 50

/**
 * How many report calls one Session keeps in the ledger.
 *
 * The ledger is what makes a replayed call a replay, so it has to outlive a restart — but it is not a log of everything
 * that ever happened: only the newest calls of a Session are kept, and an old one is dropped rather than kept forever.
 */
const REPORT_CALLS_PER_SESSION = 100

/**
 * How long the control plane waits for the node's answer to a review diff.
 *
 * The node's own Git commands are bounded (ten seconds each), so this only covers a node that accepted the command and
 * never answered. A PM that waits longer than this learns that the answer did not arrive instead of waiting forever.
 */
const DEFAULT_REVIEW_DIFF_TIMEOUT_MS = 30_000

/** Statuses a Session has finished in for good: a node generation change must not reopen one of them. */
const SESSION_TERMINAL: ReadonlySet<SessionStatus> = new Set(['stopped', 'archived'])

function isNodeConfirmed(status: SessionStatus): boolean {
  return NODE_CONFIRMED.has(status)
}

/** The message of a caught value, for reporting a failure the node or the transport raised. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The shape the console reads a Router proposal in. */
function routerProposalView(proposal: RouterProposal): RouterProposalView {
  return { id: proposal.id, requestId: proposal.requestId, projectId: proposal.projectId,
    projectTitle: proposal.projectTitle, instruction: proposal.instruction, at: proposal.at }
}

/**
 * Why a proposal may not be confirmed or cancelled any more.
 *
 * The reason is the honest one: a proposal that was sent cannot be sent again, one that is on its way is already being
 * sent, and one that was cancelled or that waited too long is gone. The console shows these words rather than a
 * generic refusal, because the person has to know whether the instruction reached the PM.
 */
function routerProposalRefusal(proposal: RouterProposal): string {
  if (proposal.state === 'confirmed') return 'This proposal was already sent to the Project\'s PM'
  if (proposal.state === 'sending') return 'This proposal is already being sent'
  if (proposal.state === 'cancelled') return 'This proposal was cancelled; nothing was sent'
  return 'This proposal is no longer valid; nothing was sent'
}

/**
 * Whether a routing is a claim the control plane carries out itself, or only a decision to leave the message to the Router.
 *
 * Only the first kind is the control plane's own work: it is idempotent by its request id, and a message that was
 * dispatched is never dispatched twice, while a message that was merely escalated is queued for the Router as it always was.
 */
function isClaimedOutcome(outcome: string): boolean {
  return outcome === 'existing_ticket' || outcome === 'existing_project_pm' || outcome === 'standalone_ticket'
    || outcome === 'read_only'
}

/**
 * Which way a message went: the rules carried it out, or the Router's own model handles it.
 *
 * The two are kept apart in the record and in the console, because they cost different things: a rule acts without a
 * model turn, and a message the model handles says so instead of pretending that a rule read it.
 */
function fastRoutePath(outcome: string): 'fast' | 'model' {
  return isClaimedOutcome(outcome) ? 'fast' : 'model'
}

/**
 * The findings of a recorded decision, read back.
 *
 * A record that cannot be read is read as nothing: the console shows the reason the gate gave and no findings, rather
 * than failing to show the decision at all.
 */
function parseGateFindings(value: string): ProjectGateFinding[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(entry => typeof entry === 'object' && entry !== null)
      .map(entry => entry as Record<string, unknown>)
      .filter(entry => PROJECT_GATE_CONDITIONS.includes(entry.condition as ProjectGateCondition))
      .map(entry => ({ condition: entry.condition as ProjectGateCondition, met: entry.met === true,
        evidence: typeof entry.evidence === 'string' ? entry.evidence : '' }))
  } catch {
    return []
  }
}

/**
 * The modules of a recorded decision, read back.
 *
 * A record that cannot be read is read as nothing, for the same reason the findings are.
 */
function parseGateModules(value: string): ProjectGateModule[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(entry => typeof entry === 'object' && entry !== null)
      .map(entry => entry as Record<string, unknown>)
      .map(entry => ({ name: typeof entry.name === 'string' ? entry.name : '',
        responsibility: typeof entry.responsibility === 'string' ? entry.responsibility : '',
        independent: entry.independent === true,
        evidence: typeof entry.evidence === 'string' ? entry.evidence : '',
        anchor: typeof entry.anchor === 'string' ? entry.anchor : '' }))
  } catch {
    return []
  }
}

/** The Project a recorded decision named outright, read back. */
function parseGateProject(value: string): { id: string; title: string } | undefined {
  if (value === '') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.title !== 'string') return undefined
    return { id: record.id, title: record.title }
  } catch {
    return undefined
  }
}

/**
 * The record of a rule that was not sure enough to act.
 *
 * The rule did not claim the message, so the message goes to the Router's model — but the reason is its own: the rule
 * knew what to do and was not sure enough to do it. That is a different fact from "the rules did not know", and a person
 * asking why their message needed a model is owed the difference.
 */
function unsureDecision(decision: FastRouteDecision): FastRouteDecision {
  return { ...decision, outcome: 'escalate', stage: 'escalated', reason: 'low_confidence',
    detail: `规则把握不够（${Math.round(decision.confidence * 100)}%），交给高层 Router。` }
}

/** The Project a raw handoff decision names, as far as it can be read at all. */
function readProjectIdOf(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ''
  const value = (input as Record<string, unknown>).projectId
  return typeof value === 'string' ? value.trim() : ''
}

/** The instruction a raw handoff decision carries, as far as it can be read at all. */
function readInstructionOf(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ''
  const value = (input as Record<string, unknown>).instruction
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The empty decision a handoff that could not be read is recorded with.
 *
 * A decision the control plane cannot read is still a fact about the request, and the record of it says what was asked
 * for as far as it could be read. Nothing is sent.
 */
function decisionOfNothing(input: unknown): RouterHandoffDecision {
  return { projectId: readProjectIdOf(input), instruction: readInstructionOf(input), rationale: '' }
}

/**
 * Validate the configured refresh grace.
 *
 * An invalid number is a deployment error and fails construction, so a typo can neither disable the intended grace silently
 * nor widen it to "all expired tokens" through `Infinity`.
 */
function refreshGraceSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TOKEN_REFRESH_GRACE_SECONDS
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('sessionTokenRefreshGraceSeconds must be a non-negative finite number of seconds')
  }
  return value
}

/** A failed Session creation or role installation; the HTTP facade reports it as 502, not as a server bug. */
export class SessionEnsureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionEnsureError'
  }
}

/** Why a tool call was refused; the HTTP facade maps each code onto one client status. */
export type ToolCallErrorCode = 'unauthenticated' | 'forbidden' | 'invalid'

/**
 * A refused control-plane tool call.
 *
 * The message is safe to return to the caller: it names no token, secret or Session of another Project, so a Worker can
 * learn that its call was refused without learning what else exists.
 */
export class ToolCallError extends Error {
  constructor(readonly code: ToolCallErrorCode, message: string) {
    super(message)
    this.name = 'ToolCallError'
  }
}

/**
 * A refused operator action.
 *
 * The request was understood and the domain's own rules forbid it: the Session was revoked, the Project is over, the
 * Worker still runs. The status says which kind of refusal it is, so the console can show the reason instead of a
 * generic failure.
 */
export class OperatorError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'OperatorError'
  }
}

export interface ControlPlaneOptions {
  /** SQLite file. Its directory is locked for the lifetime of this kernel. */
  dbPath: string
  /**
   * The control plane's own file: the event log with a sequence of its own and the audit trail.
   *
   * It is a separate SQLite file from the domain's, so the domain's schema stays what the plugin and the kernel share and
   * an older plugin binary never opens it. It defaults to a `console.sqlite` beside the domain's file.
   */
  consoleDbPath?: string
  /** How many events the log keeps; the oldest are dropped first. */
  consoleEventRows?: number
  /** How many days the log keeps; `0` keeps the events forever. */
  consoleEventDays?: number
  /** How many days the audit keeps; `0` keeps the audit forever. */
  consoleAuditDays?: number
  nodeId: string
  node: NodePort
  /** HMAC secret used to issue Session tokens; the node only ever sees the token. */
  secret: string
  /** Every project workspace must resolve under this directory. */
  workspaceRoot: string
  now?: () => string
  /** Lifetime of a Session token in seconds; a long task refreshes it through the tool API before it expires. */
  sessionTokenTtlSeconds?: number
  /** @deprecated Use `sessionTokenTtlSeconds`; kept so an existing caller keeps its configured lifetime. */
  tokenTtlSeconds?: number
  /**
   * How long an already expired Session token may still refresh itself, in seconds.
   *
   * Only `POST /v1/tools/token/refresh` reads this; every ordinary tool and message route verifies strictly and answers 401
   * for the same expired token. Defaults to {@link DEFAULT_TOKEN_REFRESH_GRACE_SECONDS}. `0` disables the grace entirely.
   */
  sessionTokenRefreshGraceSeconds?: number
  /** How long an ensure waits for a node status event before asking the node directly. */
  confirmationTimeoutMs?: number
  /**
   * How long a review diff waits for the node's answer.
   *
   * Defaults to {@link DEFAULT_REVIEW_DIFF_TIMEOUT_MS}. A node that never answers leaves the PM with a `timeout` result
   * instead of a call that never returns.
   */
  reviewDiffTimeoutMs?: number
  /** How long an explicit `session.inspect` waits for the node's answer. */
  inspectionTimeoutMs?: number
  /**
   * How long a stop waits for the node to confirm that a Worker Session stopped.
   *
   * Defaults to {@link STOP_CLEANUP_TIMEOUT_MS}. A stop the node does not answer within it fails: the Worker may still
   * run, so no new Assignment starts over it until a later stop is confirmed.
   */
  stopCleanupTimeoutMs?: number
  /**
   * How long a stop waits for a Worker Session whose creation is still in flight.
   *
   * Defaults to {@link ENSURE_SETTLE_TIMEOUT_MS}. A creation that outlives it leaves the order open, so the stop is
   * reported as unconfirmed and no new Assignment starts over it.
   */
  ensureSettleTimeoutMs?: number
  /**
   * How long a message waits for the node's own confirmation before it is reported as unconfirmed.
   *
   * Defaults to {@link DELIVERY_CONFIRM_TIMEOUT_MS}. A node that never answers leaves the operator with a message that was
   * not confirmed, instead of a request that never returns.
   */
  deliveryConfirmTimeoutMs?: number
  /**
   * Default period of the periodic heartbeat `startHeartbeat` runs; the standalone control plane starts it after a
   * successful registration. The loop is opt-in so an in-process kernel owns no timer it did not ask for.
   */
  heartbeatIntervalMs?: number
  /**
   * Period of the periodic reconciliation `startReconcile` runs, in milliseconds; `0` leaves it off.
   *
   * The loop is opt-in: a cleanup that runs on its own deserves a deployment to ask for it. What it may do is decided by
   * the evidence, not by the clock — only a Session the node confirms is still running although its Assignment is over is
   * ever touched.
   */
  reconcileIntervalMs?: number
  /**
   * The time base of the scheduled plans, as a fixed offset in minutes east of UTC.
   *
   * The default is UTC. The offset is fixed on purpose: a named timezone would carry a daylight-saving rule, and a plan
   * that fires at 03:30 on the day the clocks change is a plan that surprises its operator. The console shows the offset
   * next to every rule, so nobody has to guess which clock a plan uses.
   */
  schedulerTimeZoneOffsetMinutes?: number
  /**
   * How often the scheduler looks for plans that came due, in milliseconds.
   *
   * It is the scheduler's own timer; the control plane starts it and stops it with the rest of the kernel.
   */
  schedulerTickMs?: number
}

export interface ControlPlaneState {
  nodeId: string
  nodes: Record<string, NodeStatus>
  projects: ProjectProfile[]
  tickets: Ticket[]
  sessions: SessionRecord[]
  events: number
  /** The PM wake-ups this control plane made for Worker reports, newest last. */
  pmNotifications: PmNotification[]
}

/**
 * What the console shows on its home page: the counts of the work that is really going on.
 *
 * A count is a fact about the domain, computed by the kernel that owns it, so the console never derives a number of its
 * own and never shows one it made up. A capability the control plane does not have yet is named as absent instead of being
 * counted: the console says the feature is not there rather than showing a zero that reads like a result.
 */
export interface ControlPlaneOverview {
  /** When the counts were read. */
  at: string
  /** Tickets a Worker is working on: a Ticket whose latest Assignment is running. */
  runningTickets: number
  /** Worker Sessions that are running a turn right now; an idle Worker is not one of them. */
  runningWorkers: number
  /** Tickets whose latest result waits for the PM's decision. */
  pendingReviews: number
  /** The capabilities the console may show. A false one is a feature that is not connected yet. */
  features: { router: boolean; schedules: boolean }
  /**
   * What the scheduler holds, as the console's home page shows it.
   *
   * The failure count is the number of plans whose **last** run failed: a plan that failed once and then succeeded is not a
   * failing plan any more. It is a fact about the scheduler's own record, never an estimate.
   */
  schedules: ScheduleOverview
  /** How much of each kind the control plane holds. */
  counts: { projects: number; tickets: number; sessions: number; nodes: number }
  /** The nodes the control plane knows, as it sees them. */
  nodes: NodeStatus[]
  /** The control plane's own event sequence and how much of the log it holds. */
  events: { seq: number; retained: number }
  /** How many audit entries the trail holds. */
  audit: { entries: number }
  /** What the log and the audit keep, and for how long. */
  retention: { eventDays: number; eventRows: number; auditDays: number }
}

/** One Ticket as the Router reads it. */
export interface RouterSummaryTicket {
  id: string
  title: string
  status: string
  /** The Ticket's latest Assignment and its own last report. */
  assignment?: { id: string; state: string; report?: { state: string; summary: string; at: string } }
}

/** One Project as the Router reads it. */
export interface RouterSummaryProject {
  id: string
  title: string
  goal: string
  status: string
  /** The Session id of the Project's PM. */
  pmSessionId: string
  latestReport?: ProjectReport
  /** The Project's Tickets with the state a PM reads for them. */
  tickets: RouterSummaryTicket[]
}

/**
 * The running state the Router reads: every Project, its Tickets, and the Sessions that run them.
 *
 * It is a summary of facts, not a copy of the work: a Ticket's title and state, a report's own summary and nothing of the
 * workspace behind them. The Router answers questions about the state of the work; it never reads the work itself.
 */
export interface RouterSummary {
  /** When the summary was read. */
  at: string
  /** Every Project this control plane manages. */
  projects: RouterSummaryProject[]
  standaloneTickets: RouterSummaryTicket[]
  /** The Sessions that run the work: the PMs and the Workers. */
  sessions: { sessionId: string; role: string; status: string; projectId: string }[]
  /** The counts a person asks for most often. */
  counts: { projects: number; tickets: number; runningTickets: number; pendingReviews: number }
}

/**
 * The Router's own facts, as the console reads them.
 *
 * The conversation comes from the node's own message events, so what the console shows is what really happened: the
 * person's own words on one side, the model's answers on the other, and nothing in between that the console made up.
 */
export interface RouterState {
  /**
   * The Router Session, when it has been started.
   *
   * `currentTurn` is the turn the Router runs right now, as the node reported it, and `interruptible` says whether the
   * node offers to end one turn at all. The console offers the interrupt only when the backend says so: an action the
   * server would refuse is not offered.
   */
  session?: { sessionId: string; status: string; workspace: string; updatedAt: string; revokedAt?: string
    currentTurn?: number; interruptible?: boolean }
  /** Whether the node the Router runs on is reachable. */
  nodeOnline: boolean
  /** The conversation, oldest first. */
  messages: RouterMessage[]
  /**
   * The proposal that waits for a person right now, when there is one.
   *
   * It is a proposal and nothing more: the instruction it names has not reached any PM, and it will not until a person
   * confirms it in the console.
   */
  proposal?: RouterProposalView
  /**
   * The notices about stops the Router is the logical superior of.
   *
   * The Router is the superior of every PM Session and of the Workers of the standalone Tickets, so an operator's stop
   * of any of them leaves a notice here. A notice carries the target, the scope, the impact and the operator — never
   * the work itself and never another notice's data.
   */
  stops?: StopNotice[]
  /**
   * The messages that wait for the Router, oldest first.
   *
   * The queue is the control plane's own durable record of what a person said to the Router and what became of it. A
   * message that is still `queued` waits for the Router's next turn; a `sent` one reached the node's inbox; a `read` one
   * was really taken by a turn; a `failed` one the node refused, with the reason it gave.
   */
  queue?: RouterQueueEntry[]
  /**
   * The routings the Fast Router made, oldest first.
   *
   * A receipt is the control plane's own account of one message: which rule read it, which target it found, and how far
   * it got. The stage never claims more than happened — a Worker that was asked to start is not running until the node
   * says so, and the Session status beside it is the node's own word.
   */
  routes?: FastRouteReceipt[]
  /**
   * The decisions of the Project Gate, oldest first.
   *
   * A record is the control plane's own account of one decision: the four findings and the modules they were made of, the
   * reason the gate gave, and the Project and PM that exist when it let one through. A refusal is a record as well, so a
   * person may ask later why their request did not become a Project.
   */
  gates?: ProjectGateRecord[]
  /**
   * The handoffs the high-level Router made to a Project's PM, oldest first.
   *
   * A record is the control plane's own account of one delivery: the Project it went to, the PM Session that took it, the
   * words that really travelled and how far the delivery got. A refusal is a record as well, so a person may see why a
   * request did not reach a PM.
   */
  handoffs?: RouterHandoffRecord[]
}

/**
 * How far a handoff to a Project's PM got.
 *
 * The stages are the same ones the Fast Router uses, so the console reads them the same way: `assigned` means the node
 * confirmed that the PM took the work, `unconfirmed` means nobody confirmed it and the control plane will not say it
 * again, and `refused` means the decision was judged and nothing was sent.
 */
export type RouterHandoffStage = FastRouteStage | 'refused'

/**
 * What became of one message a person sent to the Router.
 *
 * The states are facts about different moments, and the console keeps them apart: the node's inbox is not a turn, and an
 * HTTP answer of 200 is neither.
 *
 * `queued` is a message that was never attempted, `sending` one that is on its way, `sent` one the node took into the
 * Session's inbox, `read` one a turn of that Session really took, `failed` one the node refused, `unconfirmed` one
 * whose receipt is missing — the control plane cannot say whether it arrived, and says exactly that. `routed` is one the
 * Fast Router claimed: the control plane carried it out itself, so it never reaches the Router's model at all.
 */
export type RouterQueueState = 'queued' | 'sending' | 'sent' | 'read' | 'failed' | 'unconfirmed' | 'routed'

/** One message a person sent to the Router, as the console reads it. */
export interface RouterQueueEntry {
  /** The message's own id: the stable id the node knows it by. */
  id: string
  /** When the person sent it. */
  at: string
  /** The person's own words. */
  text: string
  /** The names of the files the message carried. */
  attachments: string[]
  /** What became of it. */
  state: RouterQueueState
  /** Why it failed, or why it still waits; empty when there is nothing to say. */
  error?: string
  /** The Router request the message is. */
  requestId: string
}

/**
 * One routing the Fast Router made, as the console reads it.
 *
 * The receipt is the control plane's own account of what became of a person's message: which rule read it, which target it
 * found, and how far it really got. The stage never claims more than happened — a Worker that was asked to start is not
 * running until the node says so, and the live Session status beside it is the node's own word.
 */
export interface FastRouteReceipt {
  /** The Router request this routing is; the message's own id. */
  requestId: string
  /** When the message was accepted. */
  at: string
  /** The person's own words. */
  text: string
  /**
   * Which way the message went.
   *
   * `fast` is a message the rules carried out themselves; no model turn started for it. `model` is a message the Router's
   * own model handles — an ordinary conversation, or a request the rules were not sure about — in the very same
   * `router.v1` Session. The two are kept apart so that a person can see which of their messages needed a model and why.
   */
  path: 'fast' | 'model'
  /** What the rule decided. */
  outcome: FastRouteOutcome
  /** How far the message got. */
  stage: FastRouteStage
  /** How sure the rule was, between 0 and 1. */
  confidence: number
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** The target the rule found, when it found one. */
  target?: { kind: string; id: string; title: string }
  /** The Ticket the work landed in, when one was created or addressed. */
  ticketId?: string
  /** The Worker Session of that Ticket, when it is known. */
  sessionId?: string
  /** The live status of that Session, as the control plane knows it. */
  sessionStatus?: string
  /** Why it failed, when it failed. */
  error?: string
  /**
   * The answer to a question about the state of a thing, when the record itself answered it.
   *
   * A message that only asked for the state of a Ticket or a Project is answered from the authoritative record: no model
   * turn runs and nothing is dispatched, and the answer is the record's own word.
   */
  answer?: string
}

/**
 * What one message to the Router became.
 *
 * A message the fast router claimed never reaches the Router's model: the control plane carried it out itself and
 * answers with the receipt of what it did. A message it did not claim is queued for the Router as it always was.
 */
export type RouterSendResult =
  | { routed: true; requestId: string; route: FastRouteReceipt }
  | { routed: false; requestId: string; session: SessionRecord; entry: RouterQueueEntry }

/**
 * What one decision of the Project Gate became.
 *
 * The answer says plainly what happened: `created` names the Project and the PM that belong to it, `refused` names the
 * reason and creates nothing at all. A refusal is a real answer and not an error — the model may read it and try again
 * with a decision that holds.
 */
export interface ProjectGateOutcome {
  /** What became of the decision. */
  outcome: 'created' | 'refused'
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** The Project that was created, when one was. */
  project?: { id: string; title: string; goal: string }
  /** The PM of that Project: its Session and the state the node confirmed, or the reason it did not come up. */
  pm?: { sessionId: string; status: string } | { status: 'unconfirmed'; error: string }
  /** The four findings, as they were read. */
  conditions: ProjectGateFinding[]
  /** The modules, as they were read. */
  modules: ProjectGateModule[]
  /** The condition that failed, when one did. */
  failedCondition?: ProjectGateCondition
  /** The Project the request named outright, when it named one. */
  existingProject?: { id: string; title: string }
}

/**
 * One decision of the Project Gate, as the console reads it.
 *
 * It names the human request the decision was made for, the four findings and the modules, the reason, and — when a
 * Project really was created — the Project and the PM that belong to it. A refusal is a record too: it says that nothing
 * was created and why.
 */
export interface ProjectGateRecord {
  /** The Router request this decision was made for. */
  requestId: string
  /** Which try of that request this is. */
  attempt: number
  /** When the decision was made. */
  at: string
  /** The person's own words. */
  text: string
  /** The title the decision would have given the Project. */
  title: string
  /** The goal the decision would have given the Project. */
  goal: string
  /** What became of it. */
  outcome: string
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** The four findings, as they were read. */
  conditions: ProjectGateFinding[]
  /** The modules, as they were read. */
  modules: ProjectGateModule[]
  /** The condition that failed, when one did. */
  failedCondition?: ProjectGateCondition
  /** The Project that was created, when one was. */
  projectId?: string
  existingProject?: { id: string; title: string }
  /** The PM Session of that Project, when there is one. */
  pmSessionId?: string
  /** The state of that PM Session, as the control plane knows it. */
  pmStatus?: string
  /** Why it failed, when it failed. */
  error?: string
}

/**
 * What one handoff to a Project's PM became.
 *
 * The answer says plainly what happened: `delivered` names the Project, the PM Session that took the work and the words
 * that really travelled; `refused` names the reason and sends nothing at all. A refusal is a real answer and not an
 * error — the model may read it and ask the person the question it names.
 */
export interface RouterHandoffOutcome {
  /** What became of the decision. */
  outcome: 'delivered' | 'refused' | 'failed' | 'unconfirmed'
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** The Project the work goes to, when the decision named one this control plane holds. */
  project?: { id: string; title: string }
  /** The PM of that Project: its Session and the state the control plane knows it by. */
  pm?: { sessionId: string; status: string }
  /** The words that really travelled, when they travelled. */
  instruction?: string
  /** The short reason the Router gave for choosing this Project. */
  rationale?: string
}

/**
 * One handoff to a Project's PM, as the console reads it.
 *
 * It names the human request the work came from, the Project it went to, the PM Session that received it, the words that
 * really travelled and how far the delivery got. A refusal is a record too: it says that nothing was sent and why.
 */
export interface RouterHandoffRecord {
  /** The Router request this handoff is; the message's own id. */
  requestId: string
  /**
   * Which kind of handoff this is.
   *
   * `handoff` is the high-level Router's own decision to give a request to the PM of a Project that already existed.
   * `brief` is the work brief the Project Gate published to the PM of the Project it just created.
   */
  kind: 'handoff' | 'brief'
  /** When the decision was made. */
  at: string
  /** The person's own words. */
  text: string
  /** The Project the work goes to. */
  projectId: string
  /** The title of that Project, as the console shows it. */
  projectTitle: string
  /** The PM Session that received the work. */
  pmSessionId: string
  /** The live status of that PM Session, as the control plane knows it. */
  pmStatus?: string
  /** The words that really travelled to that PM. */
  instruction: string
  /** The short, checkable reason the Router gave. */
  rationale: string
  /** How far the handoff got. */
  stage: RouterHandoffStage
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** Why it failed, when it failed. */
  error?: string
}

/**
 * What one interrupt of a running turn did.
 *
 * `interrupted` says that the turn was ended and `confirmed` that the node itself said so. A refusal is named by
 * `refusal`, so a caller can tell "there was no turn to interrupt" from "the node does not know how" and from "the node
 * refused" without reading the diagnostic.
 */
export interface InterruptOutcome {
  /** Whether the turn was ended. */
  interrupted: boolean
  /** Whether the node confirmed that the turn ended. */
  confirmed: boolean
  /** The turn that was interrupted, when the caller named one. */
  turn?: number
  /** Why it was not interrupted, when it was not. */
  error?: string
  /** The kind of refusal, when the request itself was refused. */
  refusal?: 'no-running-turn' | 'unsupported' | 'stopped' | 'revoked' | 'replaced'
}

/**
 * One proposal to relay a person's instruction to the PM of one Project, as the console reads it.
 *
 * The text is the text that would really be sent, so the person who confirms it reads the instruction the PM will get
 * and not the Router's summary of it.
 */
export interface RouterProposalView {
  /** The proposal's own id: the handle the console confirms or cancels. */
  id: string
  /** The request the proposal came from. */
  requestId: string
  /** The Project whose PM would receive the instruction. */
  projectId: string
  /** The Project's title. */
  projectTitle: string
  /** The text that would really be sent to that Project's PM. */
  instruction: string
  /** When the proposal was made. */
  at: string
}

/** One message of a Session, as the event log holds it. */
export interface SessionMessage {
  /** The control plane's own sequence of the event the message came from. */
  seq: number
  /** When the message happened. */
  at: string
  /** Who wrote it: `user`, `assistant` or `message` when the node did not say. */
  role: string
  /** The text of the message. */
  text: string
}

/**
 * One message of the Router's conversation, as the console reads it.
 *
 * A person's own message carries the request it is, so the console may show the words the person wrote rather than the
 * envelope the Router received; a model's answer is the node's own message event.
 */
export interface RouterMessage {
  /** The control plane's own sequence of the event the message came from. */
  seq: number
  /** When the message happened. */
  at: string
  /** Who wrote it: `user` for a person, `assistant` for the Router's model. */
  role: string
  /** The text of the message. */
  text: string
  attachments?: string[]
  /** The request id a person's message carries, when it is one of the Router's own requests. */
  requestId?: string
}

/** One Ticket as the console reads it: the facts a person needs, and the status the kernel derives. */
export interface ConsoleTicket {
  id: string
  title: string
  /** The Project it belongs to, when it has one. */
  projectId?: string
  /** The status a PM reads for it: `open`, `running`, `waiting`, `blocked`, `failed`, `completed`, `stopped` or `archived`. */
  status: PmTicketStatus
  /** Its latest Assignment and that Assignment's own last report. */
  assignment?: { id: string; state: string; report?: { state: string; summary: string; at: string } }
  /** The review of its latest result, when it has one. */
  review?: { id: string; state: string; assignmentId: string; at: string; summary?: string }
  /** The open question a Worker asked a person. */
  attention?: { question: string }
  /** The stop that keeps a new Assignment from starting. */
  manualStop?: { scope: string; at: string }
}

/** One Project as the console reads it, with the Tickets that belong to it. */
export interface ConsoleProject {
  id: string
  title: string
  goal: string
  workspace: string
  status: ProjectProfile['status']
  pauseMode?: ProjectProfile['pauseMode']
  pmSessionId: string
  createdAt: string
  updatedAt: string
  /** The Project's own last report, when it has one. */
  latestReport?: ProjectReport
  /** The Tickets of this Project, in the order the domain keeps them. */
  tickets: ConsoleTicket[]
}

/**
 * What a PM sees of one of its Tickets' states, derived from the Ticket, its Project archive and its latest Assignment.
 *
 * `waiting` is the state of a Ticket whose Worker reported its result and whose PM has not decided about it yet: the
 * work is done, the Ticket stays open until the PM accepts or rejects it.
 */
export type PmTicketStatus = 'open' | 'running' | 'waiting' | 'blocked' | 'failed' | 'completed' | 'stopped' | 'archived'

/** The latest Assignment of a Ticket as a PM reads it: identity, lifecycle state and its own last report. */
export interface PmContextAssignment {
  id: string
  state: AssignmentState
  /**
   * The Session id the control plane gives that Assignment's Worker (`worker-<assignmentId>`), which is the Session the
   * node runs. The domain's own `Assignment.sessionId` keeps the older `worker-<ticketId>` name and is not it.
   */
  sessionId: string
  report?: Assignment['report']
}

/** One Ticket of the PM's own Project; no Mandate, actor or internal input is included. */
export interface PmContextTicket {
  id: string
  title: string
  status: PmTicketStatus
  assignment?: PmContextAssignment
  /** The review of this Ticket's latest result: pending while the PM has not decided, decided once it did. */
  review?: PmContextReview
  /** The open question a Worker asked a person; the PM may read it but not answer it. */
  attention?: { question: string }
  /** The last failed delivery of an Input to the Worker, so a node failure is visible to the PM. */
  delivery?: { error: string; at: string }
  /** The last failed stop of the Worker: the Assignment ended, but its Session may still run. */
  stopFailure?: { at: string; error: string }
  /** The stop of a Worker that is still open: the Assignment ended, but no node confirmed that its Session stopped. */
  stopPending?: { at: string; assignmentId: string }
  /** The stop that keeps a new Assignment from starting: `worker` waits for a person, `project` for the PM. */
  manualStop?: { scope: 'worker' | 'project'; at: string; by: string }
  /** The wake-up this control plane made for this Ticket's latest Worker report, when it made one. */
  pmNotification?: PmNotification
}

/** The review a PM reads: the result waiting for its decision, or the last round it had. */
export interface PmContextReview {
  /**
   * The review's own id, the round this decision is about.
   *
   * It is the Ticket's own durable id, and a decision names it: a decision about an earlier round never reaches a later
   * one, and a new round of the same Assignment gets a new id.
   */
  id: string
  /** `pending` while the result waits for the PM; `accepted` or `rejected` once it decided; `withdrawn` when the Worker
   * reported something else since. */
  state: TicketReview['state']
  /** The Assignment whose result the review is about. */
  assignmentId: string
  /** When the review was opened. */
  at: string
  /** The Worker's own summary of the result under review. */
  summary?: string
  /** Why the PM rejected the result. */
  reason?: string
  /** When the PM decided. */
  decidedAt?: string
}

/**
 * What the control plane did with one Worker report about waking the Project's PM.
 *
 * `sent` is the node's acceptance of the message, `skipped` a report that was written but must not wake the PM (a
 * Project that is not active, a PM that does not exist, a report the PM already knows), `failed` a message the node
 * refused or could not receive, `pending` a wake-up still in flight, and `deferred` a wake-up a paused Project held back:
 * it waits for the resume, and the PM is told then if the result still waits for a decision.
 *
 * The record is the control plane's own fact and lives in memory: it does not outlive a restart of the control plane,
 * which is acceptable while the delivery itself is a best-effort wake-up rather than a durable outbox. The Worker
 * report it belongs to is durable and stays written whatever this record says.
 */
export interface PmNotification {
  ticketId: string
  projectId: string
  /** The Assignment that made the report; only the Assignment's current Worker reports reach the PM. */
  assignmentId: string
  /** The report state that caused the wake-up. */
  reportState: string
  /** When the wake-up was recorded. */
  at: string
  state: 'pending' | 'sent' | 'skipped' | 'failed' | 'deferred'
  /** Why a wake-up was skipped, failed or deferred. */
  reason?: string
}

/**
 * One Session as the console reads it: the record itself, and what may still be done with it.
 *
 * A Worker Session that a newer Assignment replaced cannot receive a message any more, and the console says so instead of
 * offering an action the server would refuse.
 */
export interface ConsoleSession extends SessionRecord {
  /** Whether an operator's message may still reach this Session. */
  deliverable: boolean
  /** Why it may not, when it may not. */
  unavailableReason?: string
  /**
   * The turn this Session runs, when the node reported one.
   *
   * The number is what an interrupt names: the node is asked to end that very turn, so a turn that started in the
   * meantime is never ended in its place.
   */
  currentTurn?: number
  /**
   * Whether the node can interrupt one running turn of one Session.
   *
   * A node that does not offer it says so here, and the console does not offer an action the server would refuse.
   */
  interruptible: boolean
}

/**
 * What one operator's stop did, as the console and the logical superior read it.
 *
 * The scope says how far the stop reached: `session` for a PM or Router Session, `assignment` for one Worker's
 * Assignment and `ticket` for a whole Ticket. The state says whether the node confirmed it — `requested` is a stop the
 * node refused, timed out on or never answered.
 */
export interface SessionStopView {
  /** The Session the stop was about. */
  sessionId: string
  /** The role that Session has. */
  role: string
  /** How far the stop reached. */
  scope: 'session' | 'assignment' | 'ticket'
  /** `requested` until the node confirmed the stop; `confirmed` afterwards. */
  state: 'requested' | 'confirmed'
  /** When the operator asked for the stop. */
  at: string
  /** Who asked. */
  by: string
  /** Why, as the operator wrote it. */
  reason?: string
  /** When the node confirmed the stop. */
  confirmedAt?: string
  /** The redacted diagnostic of a stop the node did not confirm. */
  error?: string
  /** What the stop affected. */
  affected: string[]
  /** What the stop left running. */
  unaffected: string[]
}

/**
 * One notice about a stop, as the logical superior reads it.
 *
 * Every id it names belongs to the one Project the stopped work was part of, so a notice read by one PM never carries
 * another Project's data.
 */
export interface StopNotice {
  /** The notice's own id. */
  id: number
  /** When the stop was recorded. */
  at: string
  /** What was stopped. */
  target: { kind: string; id: string; sessionId?: string }
  /** How far the stop reached. */
  scope: string
  /** `requested` until the node confirmed the stop; `confirmed` afterwards. */
  state: string
  /** Who stopped it. */
  actor: string
  /** The Project the stopped work belonged to, when it had one. */
  projectId?: string
  /** What the stop affected. */
  affected: string[]
  /** What the stop left running. */
  unaffected: string[]
  /** Who may read the notice. */
  superior: { kind: string; id?: string }
  /** The redacted diagnostic of a stop the node did not confirm. */
  error?: string
}

/** The safe Project summary a PM reads: the identity and goal it manages, not its Mandate or PM Session record. */
export interface PmContextProject {
  id: string
  title: string
  goal: string
  status: ProjectProfile['status']
  pauseMode?: 'soft' | 'hard'
  latestReport?: ProjectReport
}

/**
 * What this kernel knows about the PM's last stop of one Ticket's Worker.
 *
 * `stopping` means the node has not answered yet, `stopped` that it confirmed the Session is gone, and `failed` that it
 * refused the stop or never answered in time. It is this kernel's own answer and it does not outlive a restart: the
 * Ticket's own facts (`stopPending`, `stopFailure`) are the durable ones, and the two are reconciled by Assignment.
 */
interface PmStopState {
  /** The Assignment the stop applied to. */
  assignmentId: string
  state: 'stopping' | 'stopped' | 'failed'
  /** The redacted diagnostic of a stop the node did not confirm. */
  error?: string
  /** The cleanup that settles the stop, so a later request waits for the same answer. */
  work?: Promise<void>
}

/** What a PM's cancel reports: the Assignment it stopped, and whether the node confirmed the stop. */
export interface PmCancelResult {
  ticket: Ticket
  /** The Assignment the stop applied to — never a newer one that replaced it while the stop was in flight. */
  assignment: Assignment
  /** Whether the node confirmed that the Worker Session stopped. */
  stopped: boolean
  /** The redacted diagnostic of a stop the node did not confirm. */
  error?: string
}

/** What the PM decided about a Worker's result. */
export interface PmReviewDecision {
  /** `accept` ends the Ticket as completed; `reject` sends the reason back to the same Assignment. */
  action: 'accept' | 'reject'
  /** Why the result is rejected; a rejection needs one the Worker can act on. */
  reason?: string
  /**
   * The review this decision is about: the id the PM's context and the wake-up show.
   *
   * It names the round, so a decision that arrives late never decides the round that waits now.
   */
  reviewId: string
}

/** What the PM's decision did: the Ticket, the review it decided, and how a revision request reached the Worker. */
export interface PmReviewResult {
  ticket: Ticket
  /** The review the decision was about, named by its own id. */
  review: PmContextReview
  /** How the revision request reached the Worker; absent for an acceptance, which sends nothing. */
  delivered?: TicketMessageDelivery
  /** The redacted diagnostic of a revision request the node refused. */
  error?: string
}

/** What the node answered about a stop: it confirmed it, refused it, or did not answer in time. */
type StopOutcome = { state: 'stopped' } | { state: 'failed'; error: string } | { state: 'pending' }

/** The read-only context a PM Session may read about its own Project and the Tickets already created in it. */
export interface PmContext {
  project: PmContextProject
  tickets: PmContextTicket[]
  /**
   * The Project's own memory: what an operator wrote down for this Project.
   *
   * It is a note for the PM, not an authority: it carries no id, no Assignment and no decision. Only the PM of this very
   * Project reads it, and only the newest {@link PROJECT_MEMORY_LIMIT} entries.
   */
  memory?: PmContextMemory[]
  /**
   * The notices about stops in this Project, as the PM reads them.
   *
   * The PM is the logical superior of the Workers of its own Project, so an operator's stop of one of them leaves a
   * notice here: the target, the scope, what the stop affected, what it left running and who made it. The notices carry
   * this Project's ids only — never another Project's.
   */
  stops?: StopNotice[]
}

/** One entry of a Project's memory, as the PM reads it. */
export interface PmContextMemory {
  /** When the entry was written. */
  at: string
  /** Who wrote it. */
  actor: string
  /** The text of the entry. */
  text: string
}

/** The status a PM sees for a Ticket; the first matching rule wins, mirroring `ticketStage` where it applies. */
export function pmTicketStatus(ticket: Ticket): PmTicketStatus {
  if (ticket.archived) return 'archived'
  // A `merged` Ticket completed its work just as a `completed` one did; every other outcome ended it without that.
  if (ticket.ended) return ticket.ended.outcome === 'completed' || ticket.ended.outcome === 'merged'
    ? 'completed' : 'stopped'
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  // A person's later message lifts a blocked or failed report, so only an unanswered one still blocks the Ticket.
  if (report === 'blocked' && waitsForPerson(ticket)) return 'blocked'
  if (report === 'failed' && waitsForPerson(ticket)) return 'failed'
  if (assignmentStopped(assignment) || ticket.manualStop) return 'stopped'
  // A result that waits for the PM's decision is neither running nor open: the work is done, the Ticket is not.
  if (currentReview(ticket)?.state === 'pending') return 'waiting'
  if (runningAssignment(ticket)) return 'running'
  return 'open'
}

/**
 * The state of a Ticket, in words a person can read.
 *
 * The Fast Router answers a question about a Ticket with this: the answer is the record's own word, and it never claims
 * more than the domain holds.
 */
const TICKET_STATE: Record<string, string> = {
  open: '待开始', running: '进行中', completed: '已完成', stopped: '已停止', waiting: '等待审阅',
  blocked: '已阻塞', failed: '失败', archived: '已归档',
}

/**
 * The Input ids a `turn-start` reported, as this kernel may act on them.
 *
 * A node reports them as opaque strings in `data`, which is untrusted protocol payload: only a non-empty array of
 * non-empty strings is read, and every other value in it is dropped. An absent or malformed field means the node said
 * nothing about Inputs, which is what a node that records no reads also reports.
 */
function turnInputIds(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return []
  const value = (data as { inputIds?: unknown }).inputIds
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string' && id !== '')
}

/**
 * The turn number a node reported, when it reported one.
 *
 * The number is what makes an interrupt precise: the node is asked to end that very turn, and refuses when another one
 * is running. A node that reports no number leaves the interrupt without a target, and the node then decides.
 */
function turnNumber(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const value = (data as { turn?: unknown }).turn
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** The shape of a message id a person may choose for themselves: a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The attachments a queued message carries, read back from the row that holds them.
 *
 * A row that cannot be read is a row without attachments: the message itself is still the person's own words, and a
 * broken attachment list must not take the message away.
 */
function parseRouterAttachments(value: string): RouterTextAttachment[] {
  if (value === '') return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap(entry => {
      if (typeof entry !== 'object' || entry === null) return []
      const file = entry as { name?: unknown; text?: unknown }
      if (typeof file.name !== 'string' || typeof file.text !== 'string') return []
      return [{ name: file.name, text: file.text }]
    })
  } catch {
    return []
  }
}

/** The model a queued message asked for, read back from the row that holds it. */
function parseRouterModel(value: string): RouterModel | undefined {
  if (value === '') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const model = parsed as { provider?: unknown; model?: unknown }
    if (typeof model.provider !== 'string' || typeof model.model !== 'string') return undefined
    if (model.provider === '' || model.model === '') return undefined
    return { provider: model.provider, model: model.model }
  } catch {
    return undefined
  }
}

/**
 * Whether two file lists are the same files in the same order.
 *
 * The comparison is by name and by content: a message that carries another file under the same id is another message,
 * and the queue may not hold both of them.
 */
function sameAttachments(left: readonly RouterTextAttachment[], right: readonly RouterTextAttachment[]): boolean {
  if (left.length !== right.length) return false
  return left.every((file, index) => file.name === right[index]?.name && file.text === right[index]?.text)
}

/** Whether a queued message asked for the same model as the one a person sends now. */
function sameModel(left: RouterModel | undefined, right: RouterModel | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider && left.model === right.model
}

/**
 * The kernel owns the domain Store and Engine, while a NodePort owns execution. It never imports
 * DSH: the same object can front the current plugin or a FakeNode in tests.
 */
export class ControlPlane {
  readonly store: Store
  readonly domain: KernelDomain
  /** The control plane's own file: the event log with a sequence of its own, and the audit trail. */
  readonly consoleStore: ConsoleStore
  /**
   * The control plane's own scheduler: the plans that turn a moment in time into one message for a Project's PM.
   *
   * It lives in the console's own file, in tables of its own, and it is started and stopped with this kernel. It never
   * creates a Session, never dispatches a Worker and never runs a command: it hands one message to the PM a Project
   * already has.
   */
  readonly scheduler: Scheduler
  /** The audit trail, written from the kernel's own facts. */
  private readonly audit: AuditRecorder
  /** The Engine's Executor over the node; it knows which delivery of a message is still in flight. */
  private readonly executor: NodeExecutor
  readonly sessions = new Map<string, SessionRecord>()
  readonly nodes = new Map<string, NodeStatus>()
  readonly events: NodeEvent[] = []
  /** Listeners told about every received event; the server's SSE stream is one and a test or panel may be another. */
  private readonly eventListeners = new Set<(event: NodeEvent) => void>()
  private readonly tokens = new Map<string, string>()
  private readonly unsubscribe: () => void
  private readonly releaseLock: () => Promise<void>
  private readonly version = '0.1.0'
  /** Ensures already running, by Session id: concurrent requests share one node round trip. */
  private readonly pendingEnsures = new Map<string, Promise<SessionRecord>>()
  /**
   * The gate decisions running right now, by request id: two calls for one request share one run.
   *
   * A request is one result, so the second call joins the first one instead of writing a second "creating" record and
   * deciding the title and the goal a second time.
   */
  private readonly gateFlights = new Map<string, Promise<ProjectGateOutcome>>()
  /**
   * The handoffs running right now, by request id: two calls for one request share one run.
   *
   * A request is one delivery, so the second call joins the first one instead of sending the same work to the same PM
   * twice.
   */
  private readonly handoffFlights = new Map<string, Promise<RouterHandoffOutcome>>()
  /**
   * The PM's own operation in flight for one Ticket, so a cancel and a re-dispatch never overlap.
   *
   * The two are ordered, not refused: a re-dispatch that arrives while a stop is running waits for the node's answer
   * instead of starting a second Worker over one that may still be running.
   */
  private readonly ticketOperations = new Map<string, Promise<void>>()
  /**
   * The stop and the resume of one Session, one at a time.
   *
   * They are ordered, not refused: a resume that arrives while a stop is running waits for the node's answer, so the
   * stop's late cancel can never reach the Session the resume brought back.
   */
  private readonly sessionOperations = new Map<string, Promise<void>>()
  /** The stop of the Worker the PM stopped last, by Ticket id: the gate a new Assignment must pass. */
  private readonly stopStates = new Map<string, PmStopState>()
  /** The Sessions a stop is in flight for, so no message and no re-ensure brings them back while they are stopping. */
  private readonly stoppingSessions = new Set<string>()
  /**
   * How many times one Session was resumed, by Session id.
   *
   * A stop that repeats its cancel after its creation settled must not reach a Session that was resumed in between, so
   * the resume advances this counter and the repeat only fires while it is unchanged.
   */
  private readonly sessionEpochs = new Map<string, number>()
  /**
   * The Sessions that were resumed, by Session id.
   *
   * A report of the stop that came before the resume is about the old lifecycle: it must not stop the resumed Session
   * again. A new stop clears the Session from this set — that stop owns the Session's status once more.
   */
  private readonly resumedSessions = new Set<string>()
  /**
   * The PM wake-ups this control plane made for Worker reports, by Ticket: the newest one per Ticket.
   *
   * The record is the kernel's own fact and does not survive a restart of the control plane; the Worker report it
   * belongs to is durable and stays written whatever the record says.
   */
  private readonly pmNotificationsByTicket = new Map<string, PmNotification>()
  /**
   * The PM wake-ups a paused Project held back, by the report's own key.
   *
   * A Project that is paused has no PM to wake: the report stays written, and the wake-up waits here until the Project is
   * resumed. Only the wake-ups that still wait are sent then — a result the PM already decided, or one a newer round
   * replaced, is not a fact the PM still needs.
   */
  private readonly resumingPmNotifications = new Set<string>()
  /**
   * The requests a person made to the Router, and the one instruction each of them may authorize.
   *
   * The ledger is what keeps the Router's authority a person's: a Router tool call that names a request id may relay
   * that request, and nothing else.
   */
  private readonly routerRequests = new RouterRequests(() => this.now())
  /**
   * The turn each Session runs, by the node's own turn facts.
   *
   * The number is what makes an interrupt precise: the node is asked to end that very turn and refuses when another one
   * is running, so a turn that started after the operator's request is never ended in its place.
   */
  private readonly sessionTurns = new Map<string, number>()
  /**
   * The Router's delivery queue, one link at a time.
   *
   * The chain is what keeps two messages in the order the person wrote them: the second delivery waits for the first to
   * settle, so the node's inbox holds them in that order however many requests arrived at once.
   */
  private routerQueuePump: Promise<void> = Promise.resolve()
  /**
   * The timer that looks at the queue again when the Router still claims to be answering.
   *
   * One timer serves the whole queue: a hundred waiting messages do not mean a hundred lookups.
   */
  private routerQueueRetry: ReturnType<typeof setTimeout> | undefined
  /**
   * The report contents a PM was already woken for, by Assignment.
   *
   * A replayed report is one fact, not two, so the same content wakes a PM once. A wake-up that failed gives its key
   * back, so a later report with the same content may try again once the node is reachable.
   */
  private readonly notifiedReports = new Map<string, Set<string>>()
  /** Callbacks waiting for the next node status of one Session, so an async event can settle an ensure. */
  private readonly statusWaiters = new Map<string, Set<() => void>>()
  /** Answers expected for an explicit `session.inspect`, keyed by its request id. */
  private readonly pendingInspections = new Map<string, (inspection: SessionInspection) => void>()
  /**
   * The review diffs this control plane asked the node for, by request id.
   *
   * The answer travels back as a node event, so the request has to be waiting before the command goes out: an event that
   * arrives first would otherwise find nobody to hand it to. The Project the request named is kept with it, so an answer
   * about another Project is refused instead of read.
   */
  private readonly pendingReviewDiffs = new Map<string, { projectId: string; settle: (result: ReviewDiffResult) => void }>()
  /** Scopes command keys to this kernel process, so a restart never repeats a key the node already executed. */
  private readonly instanceId = randomUUID()
  /**
   * The node generation this kernel trusts. It changes when the kernel starts and whenever the node comes back from
   * offline, so a Session confirmed under another generation is re-ensured once rather than reported as current.
   */
  private nodeGeneration = randomUUID()
  /** The periodic heartbeat timer, owned by this kernel so `close` can stop it. */
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether the loop is running; also true while a beat is in flight, when no timer exists yet. */
  private heartbeatActive = false
  /** The periodic reconciliation timer, owned by this kernel so `close` can stop it. */
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined
  /** The period of the periodic reconciliation, in milliseconds. */
  private reconcileInterval = 0
  /** Whether the periodic reconciliation is running. */
  private reconcileActive = false
  private reconcileGeneration = 0
  private reconcileInFlight: Promise<ReconcileResult> | undefined
  /**
   * The control plane's own event sequence: the last sequence it handed out.
   *
   * It is the control plane's counter, not the node's: a node restarts and counts from 1 again, while this one keeps
   * counting across control-plane restarts, because the log it wrote holds the counter.
   */
  private lastEventSeq = 0
  /** How many events were recorded since the log was last pruned. */
  private eventsSincePrune = 0
  private sequence = 0
  private closed = false
  /**
   * The effective grace for the refresh route. Ordinary tool routes never read it.
   */
  get tokenRefreshGraceSeconds(): number { return this.runtime.tokenRefreshGraceSeconds }
  private readonly startupRuntime: ConsoleRuntimeSettings
  private runtime: ConsoleRuntimeSettings

  constructor(private readonly options: ControlPlaneOptions) {
    this.startupRuntime = {
      tokenRefreshGraceSeconds: refreshGraceSeconds(options.sessionTokenRefreshGraceSeconds),
      reconcileIntervalMs: options.reconcileIntervalMs ?? 0,
      schedulerTickMs: options.schedulerTickMs ?? DEFAULT_TICK_MS,
    }
    this.runtime = this.startupRuntime
    mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 })
    mkdirSync(options.workspaceRoot, { recursive: true, mode: 0o700 })
    const release = lockSync(dirname(options.dbPath), { stale: 30_000 })
    this.releaseLock = async () => { release() }
    // The console's own file is separate from the domain's, so the domain's schema stays what it always was and an older
    // plugin binary never opens it. Its event counter is what makes the control plane's sequence survive a restart.
    let consoleDb: ConsoleStore | undefined
    try {
      this.store = new Store(options.dbPath)
      consoleDb = new ConsoleStore(options.consoleDbPath ?? join(dirname(options.dbPath), 'console.sqlite'), {
        ...(options.consoleEventRows === undefined ? {} : { eventRows: options.consoleEventRows }),
        ...(options.consoleEventDays === undefined ? {} : { eventDays: options.consoleEventDays }),
        ...(options.consoleAuditDays === undefined ? {} : { auditDays: options.consoleAuditDays }),
      })
      this.consoleStore = consoleDb
      const savedRuntime = consoleDb.meta(RUNTIME_SETTINGS_KEY)
      if (savedRuntime) this.runtime = parseRuntimeSettings(JSON.parse(savedRuntime))
      this.lastEventSeq = consoleDb.lastEventSeq()
      // The log is bounded; a restart is a good moment to drop what it may no longer keep.
      this.pruneConsoleLog()
      // The Router's queue is the control plane's own durable record, and a message that was on its way when this
      // process ended has an unknown outcome: it is marked as such instead of being sent again.
      this.reconcileRouterQueue()
      // The routings the Fast Router made are the same kind of record: one that was on its way when the process ended
      // is marked as unconfirmed, and it is never carried out again.
      this.reconcileFastRoutes()
      // The handoffs of the high-level Router are the same kind of record: work that was on its way to a PM when the
      // process ended may or may not have arrived, and it is never sent again.
      this.reconcileRouterHandoffs()
      this.audit = new AuditRecorder(consoleDb, () => this.now(), error => {
        // An audit trail that cannot be written is a diagnostic, never a failed report: the work itself stays written.
        process.stderr.write(`superagent control-plane audit write failed: ${
          error instanceof Error ? error.message : String(error)}\n`)
      })
      // The callbacks run after construction (an Assignment starts only through a later Engine command), so the closures may
      // read `this.engine` and the Session map without an initialization-order hazard.
      const executor = new NodeExecutor({
        createWorkerSession: (projectId, assignmentId, ticketId, prompt) =>
          this.createAssignmentWorker(projectId, assignmentId, ticketId, prompt),
        sendMessage: (sessionId, text, inputIds, idempotencyKey) => this.sendMessage(sessionId, text, inputIds, 'system',
          idempotencyKey === undefined ? {} : { idempotencyKey }),
        cancelSession: (sessionId, reason) => this.cancelSession(sessionId, reason, 'system'),
        assignmentStarted: (ticketId, assignmentId) => {
          this.engine.assignmentStarted(ticketId, assignmentId)
          this.auditAssignmentStarted(ticketId, assignmentId)
          this.markFastRouteAssigned(ticketId)
        },
        assignmentFailed: (ticketId, assignmentId, error) => { this.assignmentFailed(ticketId, assignmentId, error) },
        taskPrompt: ticket => this.taskPrompt(ticket),
        inputsDelivered: (ticketId, assignmentId, inputIds) => {
          this.engine.inputsDelivered(ticketId, assignmentId, inputIds)
          this.markFastRouteDelivered(ticketId, inputIds)
        },
        inputText: input => this.inputText(input),
        workerSessionId: (_ticketId, assignmentId) => this.workerSessionFor(assignmentId),
      })
      this.executor = executor
      this.domain = createKernelDomain(this.store, options.now, executor)
      // The scheduler keeps its plans in the console's own file, in tables of its own: the domain's schema is untouched, and
      // an old plugin binary never opens this file. The kernel owns the delivery — it is the only one that knows a Project's
      // PM Session and whether the node really holds it.
      this.scheduler = new Scheduler({
        db: consoleDb.db,
        deliver: delivery => this.deliverSchedule(delivery),
        now: () => new Date(this.now()),
        ...(options.schedulerTimeZoneOffsetMinutes === undefined
          ? {} : { timeZoneOffsetMinutes: options.schedulerTimeZoneOffsetMinutes }),
        tickMs: this.runtime.schedulerTickMs,
        audit: entry => { this.recordScheduleAudit(entry) },
        onRunFinished: event => { this.publishScheduleRun(event) },
        onError: error => {
          process.stderr.write(`superagent control-plane scheduler failed: ${
            error instanceof Error ? error.message : String(error)}\n`)
        },
      })
      this.loadSessions()
      this.unsubscribe = options.node.subscribe(event => { this.receive(event) })
    } catch (error) {
      // The console's own file may already be open when a later step fails; it is closed with the rest.
      try { consoleDb?.close() } catch { /* a file that never opened needs no closing */ }
      void this.releaseLock().catch(() => {})
      throw error
    }
  }

  /** The Engine is exposed for tests and the future panel; callers should prefer the methods below. */
  get engine() { return this.domain.engine }

  now(): string { return this.options.now?.() ?? new Date().toISOString() }

  /** The node generation this kernel trusts; a Session confirmed under another one is re-ensured before it is used. */
  get generation(): string { return this.nodeGeneration }

  /**
   * Register this control plane with the node.
   *
   * Every call uses a fresh key: a node acknowledges a completed key without executing the command again, so a control
   * plane that restarted would otherwise never publish `node.status` again and `/v1/state` would keep no node at all.
   * Registration has no effect beyond reporting that status, so repeating it stays harmless.
   */
  async registerNode(registration: Partial<Pick<NodeRegistration, 'version' | 'capabilities'>> = {}): Promise<void> {
    const value: NodeRegistration = { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: this.options.nodeId, backend: 'dsh',
      version: registration.version ?? this.version, ...(registration.capabilities ? { capabilities: registration.capabilities } : {}) }
    await this.options.node.send({ ...this.base(this.uniqueKey('node-register', this.options.nodeId)), type: 'node.register',
      registration: value })
  }

  /**
   * Ask the node for one liveness fact.
   *
   * The kernel records the answer itself instead of waiting for the node's event: a successful beat makes the node
   * online (the event stream may be down even while commands are answered), and a failed one records it offline and
   * rethrows, so a caller learns that nothing reached the node. A transport must bound its own send (`HttpNodePort` does
   * through `commandTimeoutMs`), because a node that accepts the socket but never answers must fail this beat rather than
   * keep the periodic loop awaiting it forever. The node's own later `node.status` event is applied on top of that and
   * never contradicts it.
   */
  async heartbeat(online = true): Promise<void> {
    const status: NodeStatus = { nodeId: this.options.nodeId, backend: 'dsh', version: this.version, online,
      at: this.now(), capabilities: [] }
    try {
      await this.options.node.send({ ...this.base(this.uniqueKey('node-heartbeat', this.options.nodeId)), type: 'node.heartbeat', status })
    } catch (error) {
      this.markNodeOffline()
      throw new SessionEnsureError(`The node ${this.options.nodeId} could not be reached: ${
        error instanceof Error ? error.message : String(error)}`)
    }
    if (online) this.markNodeOnline()
    else this.markNodeOffline()
  }

  /**
   * Start the periodic heartbeat, once.
   *
   * The loop is owned by this kernel: `stopHeartbeat` and `close` clear the timer, and a beat is scheduled only after
   * the previous one settled, so a slow node never accumulates overlapping beats. A failed beat records the node
   * offline through `heartbeat`; the loop itself keeps trying, so a returning node becomes online again.
   */
  startHeartbeat(intervalMs = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS): void {
    if (this.closed || this.heartbeatActive) return
    this.heartbeatActive = true
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_HEARTBEAT_MS
    const beat = async (): Promise<void> => {
      this.heartbeatTimer = undefined
      if (this.closed || !this.heartbeatActive) return
      try {
        await this.heartbeat()
      } catch {
        // `heartbeat` already recorded the offline transition; the loop's next beat is the retry.
      }
      schedule(interval)
    }
    const schedule = (delayMs: number): void => {
      if (this.closed || !this.heartbeatActive) return
      this.heartbeatTimer = setTimeout(() => { void beat() }, delayMs)
      // A heartbeat alone must never keep a shutting-down process alive; `close` still clears the timer.
      this.heartbeatTimer.unref?.()
    }
    // One beat now: after a restart the recorded node status is unknown, and a successful first beat is what makes it
    // online again without waiting a whole interval. The registration's own event may already have done it.
    schedule(0)
  }

  /** Stop the periodic heartbeat; safe to call when it was never started or already stopped. */
  stopHeartbeat(): void {
    this.heartbeatActive = false
    if (this.heartbeatTimer === undefined) return
    clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  /**
   * Start the periodic reconciliation, once.
   *
   * The loop is owned by this kernel: `stopReconcile` and `close` clear the timer, and a run is scheduled only after the
   * previous one settled, so a slow node never makes two runs overlap. A run that fails is reported and the loop goes on:
   * a reconciliation that cannot run must not look like one that found nothing.
   */
  startReconcile(intervalMs = this.runtime.reconcileIntervalMs): void {
    if (this.closed || this.reconcileActive) return
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0
    if (interval === 0) return
    this.reconcileInterval = interval
    this.reconcileActive = true
    this.scheduleReconcile(interval)
  }

  /** Stop the periodic reconciliation; safe to call when it was never started or already stopped. */
  stopReconcile(): void {
    this.reconcileGeneration += 1
    this.reconcileActive = false
    if (this.reconcileTimer === undefined) return
    clearTimeout(this.reconcileTimer)
    this.reconcileTimer = undefined
  }

  /** Schedule the next reconciliation run; the timer belongs to this kernel and `close` clears it. */
  private scheduleReconcile(delayMs: number): void {
    if (this.closed || !this.reconcileActive) return
    const generation = this.reconcileGeneration
    this.reconcileTimer = setTimeout(() => { void this.runReconcile(generation) }, delayMs)
    // A reconciliation alone must never keep a shutting-down process alive; `close` still clears the timer.
    this.reconcileTimer.unref?.()
  }

  /** Run one reconciliation and schedule the next one, whatever the run ended with. */
  private async runReconcile(generation: number): Promise<void> {
    if (generation !== this.reconcileGeneration) return
    this.reconcileTimer = undefined
    if (this.closed || !this.reconcileActive) return
    try {
      await this.reconcile()
    } catch (error) {
      process.stderr.write(`superagent control-plane reconciliation failed: ${
        error instanceof Error ? error.message : String(error)}\n`)
    }
    if (generation === this.reconcileGeneration) this.scheduleReconcile(this.reconcileInterval)
  }

  runtimeSettings(): { values: ConsoleRuntimeSettings; startup: ConsoleRuntimeSettings; schedulerOffsetMinutes: number } {
    return { values: { ...this.runtime }, startup: { ...this.startupRuntime },
      schedulerOffsetMinutes: this.scheduler.timeZoneOffsetMinutes }
  }

  saveRuntimeSettings(input: unknown): ReturnType<ControlPlane['runtimeSettings']> {
    const next = parseRuntimeSettings(input)
    this.consoleStore.setMeta(RUNTIME_SETTINGS_KEY, JSON.stringify(next))
    this.applyRuntimeSettings(next)
    return this.runtimeSettings()
  }

  resetRuntimeSettings(): ReturnType<ControlPlane['runtimeSettings']> {
    this.consoleStore.setMeta(RUNTIME_SETTINGS_KEY, '')
    this.applyRuntimeSettings(this.startupRuntime)
    return this.runtimeSettings()
  }

  private applyRuntimeSettings(next: ConsoleRuntimeSettings): void {
    const reconcileChanged = this.runtime.reconcileIntervalMs !== next.reconcileIntervalMs
    this.runtime = next
    this.scheduler.setTickInterval(next.schedulerTickMs)
    if (reconcileChanged) {
      this.stopReconcile()
      this.startReconcile()
    }
  }

  /**
   * Start the scheduler, once.
   *
   * The timer belongs to the scheduler, which belongs to this kernel: `stopScheduler` and `close` clear it. Starting it
   * recovers the runs a dead process left in flight — they are recorded as `interrupted` and never replayed — and then
   * looks for the plans that came due.
   */
  startScheduler(): void {
    if (this.closed) return
    this.scheduler.start()
  }

  /**
   * Stop the scheduler and wait for the deliveries in flight.
   *
   * It runs before the database is closed: a scheduler that writes to a closed file would lose the record of a run it had
   * already started.
   */
  async stopScheduler(): Promise<void> {
    await this.scheduler.close().catch(() => {})
  }

  /** The plans the scheduler holds, newest first. */
  schedulePlans(): SchedulePlan[] { return this.scheduler.listPlans() }

  /** One plan, or undefined when it does not exist or was deleted. */
  schedulePlan(id: string): SchedulePlan | undefined { return this.scheduler.getPlan(id) }

  /** The runs of one plan, newest first. */
  scheduleRuns(planId: string, limit = 50): ScheduleRun[] { return this.scheduler.runs(planId, limit) }

  /** The runs of every plan, newest first. */
  scheduleRecentRuns(limit = 20): ScheduleRun[] { return this.scheduler.recentRuns(limit) }

  /** What the scheduler holds: the counts the console's home page shows. */
  scheduleOverview(): ScheduleOverview { return this.scheduler.overview() }

  /**
   * Create a plan for a Project this control plane really has.
   *
   * The Project is checked here, not in the scheduler: a plan that names a Project nobody has would fail at every moment
   * it came due, and the operator deserves to be told at once that the Project does not exist.
   */
  createSchedule(input: { projectId: string; name: string; rule: string; message: string; enabled?: boolean }): SchedulePlan {
    const project = this.store.projects.get(input.projectId.trim())
    if (!project) throw new OperatorError(400, `Unknown Project ${input.projectId}`)
    return this.scheduler.createPlan({ ...input, projectId: project.id })
  }

  /**
   * Deliver one scheduled message to the PM of its Project.
   *
   * The rules are the kernel's own, and none of them is negotiable at the moment the plan comes due:
   *
   * - The Project must exist and still be `active`. A deleted or ended Project has no PM to read anything.
   * - The PM Session must be the one the Project itself names, must not be revoked, and must be `idle` or `running`.
   * - The node must be reachable and the Session must have been confirmed **in the current node generation**: a Session
   *   the node may have forgotten is re-ensured for an operator's message, but a scheduled task never starts a Session on
   *   its own. A plan that comes due while the PM is not there fails, and the failure says why.
   * - Only the node's own acknowledgement makes it a success. A message that was sent but never confirmed is a failure, and
   *   the run is recorded as one.
   *
   * The message is a fact about the work, not an order: it says so in its own text, and the operator's note is fenced
   * inside it. What the PM does with it afterwards is the PM's own decision.
   */
  private async deliverSchedule(delivery: ScheduleDelivery): Promise<ScheduleDeliveryResult> {
    const project = this.store.projects.get(delivery.projectId)
    if (!project) return { ok: false, acknowledged: false, error: 'the Project does not exist' }
    if (project.status !== 'active') return { ok: false, acknowledged: false, error: `the Project is ${project.status}` }
    const pm = this.sessions.get(project.pmSessionId)
    if (!pm) return { ok: false, acknowledged: false, error: 'the Project has no PM Session' }
    if (pm.revokedAt) return { ok: false, acknowledged: false, error: 'the PM Session was revoked' }
    // A PM an operator stopped takes no scheduled message: the plan fails and says why, rather than waking a Session
    // a person put to rest.
    if (this.operatorStopRefusal(pm)) {
      return { ok: false, acknowledged: false, error: 'the PM Session was stopped by an operator' }
    }
    if (pm.role !== 'pm' || pm.projectId !== project.id) {
      return { ok: false, acknowledged: false, error: 'the PM Session does not belong to the Project' }
    }
    if (pm.status !== 'idle' && pm.status !== 'running') {
      return { ok: false, acknowledged: false, error: `the PM Session is ${pm.status}` }
    }
    const node = this.nodes.get(this.options.nodeId)
    if (node === undefined) return { ok: false, acknowledged: false, error: 'the node is not registered' }
    if (node.online === false) return { ok: false, acknowledged: false, error: 'the node is offline' }
    if (!this.isCurrentGeneration(pm)) {
      return { ok: false, acknowledged: false, error: 'the PM Session was not confirmed in the current node generation' }
    }
    try {
      // The run's own id is the node's idempotency key: the same slot of the same plan is the same message, and a node
      // that already executed the key does not execute it twice.
      await this.sendMessage(pm.sessionId, delivery.message, undefined, 'system',
        { idempotencyKey: `schedule:${delivery.runId}`, allowEnsure: false })
    } catch (error) {
      return { ok: false, acknowledged: false, error: redact(messageOf(error)).slice(0, 300) }
    }
    return { ok: true, acknowledged: true, detail: 'the node accepted the message' }
  }

  /**
   * Write one fact of a plan or of a run to the audit trail.
   *
   * The line is the scheduler's own: it names the rule, the moment and the outcome, never the text of the message and
   * never a credential.
   */
  private recordScheduleAudit(entry: ScheduleAuditEntry): void {
    const plan = this.scheduler.getPlan(entry.targetId, { includeDeleted: true })
    const name = plan === undefined ? '' : ` · ${plan.name}`
    this.audit.record({ actor: entry.actor, kind: 'schedule', action: entry.action, targetKind: 'schedule',
      targetId: entry.targetId, outcome: entry.outcome, detail: `${entry.detail}${name}` })
  }

  /**
   * Announce one finished run, so a console that is watching sees it without asking.
   *
   * The event carries the run's own facts and nothing else: no message, no credential, no name of a person. It is the
   * control plane that publishes it — the node never reports a scheduled run.
   */
  private publishScheduleRun(event: { run: ScheduleRun }): void {
    const run = event.run
    const nodeEvent: NodeEvent = {
      protocolVersion: NODE_PROTOCOL_VERSION,
      nodeId: this.options.nodeId,
      sessionId: '',
      projectId: run.projectId,
      role: 'pm',
      seq: 0,
      at: this.now(),
      type: 'schedule.run',
      scheduleId: run.planId,
      runId: run.runId,
      state: run.state,
      acknowledged: run.acknowledged,
      reason: run.error,
    }
    this.receive(nodeEvent, 'control')
  }

  /**
   * Record that the transport to the node was re-established.
   *
   * A node can restart and come back between two heartbeats, so the kernel never observes an offline transition: the
   * generation would stay the same while every Session the node held in memory is gone, and a message would be refused as
   * "not loaded". The reopened event stream is the only sign available, so every reconnect rotates the generation; a
   * redundant idempotent re-ensure is cheaper and safer than messaging a Session the node no longer has. The reconnect
   * handler refreshes liveness with `heartbeat` afterwards.
   */
  nodeReconnected(): void {
    if (this.closed) return
    this.nodeGeneration = randomUUID()
  }

  /**
   * Record that the node is unreachable, as a fact this kernel observed itself.
   *
   * A failed heartbeat leaves the event stream silent, so no node event will announce the loss: the kernel records the
   * transition and announces it with the same `node.status` shape, keeping every field of the last known status. An
   * already offline node only has its timestamp refreshed, so a failing loop does not repeat the same event forever.
   */
  markNodeOffline(): NodeStatus {
    const previous = this.nodes.get(this.options.nodeId)
    const status: NodeStatus = { ...(previous ?? this.defaultNodeStatus()), online: false, at: this.now() }
    if (previous?.online === false) {
      this.nodes.set(status.nodeId, status)
      return status
    }
    this.publishNodeStatus(status)
    return status
  }

  /**
   * Record the node online after a heartbeat it answered.
   *
   * No event is synthesized: the node's own `node.status` may still arrive and would then be a duplicate, and a
   * heartbeat that was answered while no status was known has nothing to announce. The state change still rotates the
   * generation when it ends an offline period, which is what makes recorded Sessions stale.
   */
  private markNodeOnline(): void {
    const previous = this.nodes.get(this.options.nodeId)
    if (previous?.online === true) return
    this.applyNodeStatus({ ...(previous ?? this.defaultNodeStatus()), online: true, at: this.now() })
  }

  private defaultNodeStatus(): NodeStatus {
    return { nodeId: this.options.nodeId, backend: 'dsh', version: this.version, online: true, at: this.now(), capabilities: [] }
  }

  /** Record one event this kernel synthesized, so subscribers and the polled history see it exactly like a node fact. */
  private publishNodeStatus(status: NodeStatus): void {
    const event: NodeEvent = { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: status.nodeId, sessionId: '', projectId: '',
      role: 'pm', seq: 0, at: status.at, type: 'node.status', status }
    this.receive(event, 'control')
  }

  /** Create a Project from a stored Trigger through the Engine; no node call is made here. */
  createProject(triggerId: string, title: string, goal: string): ProjectProfile {
    return this.engine.createProject(triggerId, title, goal)
  }

  /**
   * Create a Project from an operator request, through the domain's own path.
   *
   * A Project is a routing act, and the domain admits one only from an explicit human Trigger, so the kernel records a
   * real Trigger for the request first and creates the Project from it. Nothing is seeded into SQLite directly and no
   * invariant is bypassed: the Trigger goes through Intake (stored, correlated to its own Thread, and never queued for an
   * Eval), and the Project through `Engine.createProject`, which takes the gate-only `project` Decision and the PM Mandate
   * it implies. Both writes share one transaction, so a refused Project leaves no Trigger behind.
   *
   * The request is not work: it starts no Eval, no Ticket and no Assignment, and it starts no Session either. The PM is
   * ensured on its own by `openProject`, so creating a Project never brings a PM or a Worker up.
   */
  createProjectFromOperator(title: string, goal: string, workspace?: string): ProjectProfile {
    let selected: string | undefined
    if (workspace) {
      if (!isAbsolute(workspace) || /[\u0000-\u001f]/.test(workspace)) {
        throw new OperatorError(400, '请输入有效的工作区绝对路径。')
      }
      const outside = '工作区必须位于工作区根目录内。'
      try {
        selected = workspaceDirectory(this.options.workspaceRoot, workspace, outside)
      } catch (error) {
        throw new OperatorError(400, error instanceof Error && error.message === outside
          ? outside : '无法使用这个工作区。请检查路径是否指向可访问的目录。')
      }
    }
    return this.createProjectFromHumanRequest(title, goal, goal, 'operator', selected)
  }

  projectWorkspaceRoot(): string { return resolve(this.options.workspaceRoot) }

  /**
   * The Trigger one request names, and the Project that follows from it.
   *
   * Both ways of making a Project out of a request — the person's own words and the gate — use this one id, so a request
   * has exactly one Project in the domain: the same id after a restart, the same id when two calls arrive at once, and
   * the same id whichever way the Project was asked for.
   */
  private requestTriggerId(requestId: string): string { return `trigger-${key('project-request', requestId)}` }

  /** The Project one request leads to, whether or not it was made yet. */
  private requestProjectId(requestId: string): string { return key('project', this.requestTriggerId(requestId)) }

  private createProjectFromHumanRequest(title: string, goal: string, requestText: string,
    actor: 'operator' | 'router', workspace?: string, triggerId?: string): ProjectProfile {
    // The Trigger's own Thread is the Trigger itself, so a request never joins another request's Thread.
    // A Router's request names its own Trigger, so the same request never becomes a second Project — not after a
    // restart, and not when two calls of it arrive at once.
    const id = triggerId ?? `trigger-${randomUUID()}`
    const trigger: Trigger = { id, source: PROJECT_REQUEST_SOURCE,
      threads: [{ source: PROJECT_REQUEST_SOURCE, id }],
      actor: { source: PROJECT_REQUEST_SOURCE, id: PROJECT_REQUEST_ACTOR }, human: true, at: this.now(), text: requestText,
      meta: { title, goal } }
    // The Project may already be there: the same request names the same Trigger, and the domain is idempotent by it.
    // A second call finds the Project the first one made, and the trail says the Project was created once.
    const before = this.projects().map(project => project.id)
    const project = this.store.atomic(() => {
      this.engine.recordTriggerForRouting(trigger)
      return this.engine.createProject(trigger.id, title, goal, workspace)
    })
    if (!before.includes(project.id)) {
      this.audit.record({ actor, kind: 'project', action: 'created', targetKind: 'project',
        targetId: project.id, detail: project.title })
    }
    return project
  }

  projects(): ProjectProfile[] { return this.store.projects.list() }

  tickets(): Ticket[] { return this.store.tickets.list() }

  /**
   * The Project an operator named, read from the domain's own record.
   *
   * An unknown Project is unknown: the caller is told it does not exist rather than that it may not be touched, so the
   * operator API does not confirm the existence of anything it cannot show.
   */
  private requireProjectById(projectId: string): ProjectProfile {
    const project = this.store.projects.get(projectId)
    if (!project) throw new Error(`Unknown project ${projectId}`)
    return project
  }

  /**
   * The memory of one Project: what an operator wrote down for it.
   *
   * The entries belong to that Project alone. They are read by that Project's PM and by nobody else, and the slice is
   * bounded: a memory is a note, not a log.
   */
  projectMemory(projectId: string, limit = PROJECT_MEMORY_LIMIT): ProjectMemoryRow[] {
    return this.consoleStore.memories(projectId, limit)
  }

  /**
   * Write one entry into a Project's memory.
   *
   * The entry is a fact about the Project, not an instruction and not an authority: it names no Ticket, no Assignment and
   * no decision, and it grants nothing. It is written to the control plane's own file, so writing one never touches a
   * Ticket, an Assignment or a Project, and an old plugin binary never opens it.
   *
   * A long entry is cut and says so: the note stays readable, and the cut is visible instead of silent.
   */
  rememberProject(projectId: string, text: string, actor: AuditActor = 'operator'): ProjectMemoryRow {
    const project = this.requireProjectById(projectId)
    const value = text.trim()
    if (value === '') throw new Error('A project memory entry needs a text')
    const bounded = value.length > PROJECT_MEMORY_TEXT_LIMIT
      ? `${value.slice(0, PROJECT_MEMORY_TEXT_LIMIT)}… (已截断)`
      : value
    const at = this.now()
    this.consoleStore.addMemory({ projectId, at, actor, text: bounded })
    this.consoleStore.pruneMemories(projectId, PROJECT_MEMORY_KEPT)
    this.audit.record({ actor, kind: 'project', action: 'remembered', targetKind: 'project', targetId: projectId,
      detail: `${project.title} · ${bounded.length} 字` })
    const entry = this.consoleStore.memories(projectId, 1)[0]
    return entry ?? { id: 0, projectId, at, actor, text: bounded }
  }

  /**
   * Pause or resume a Project, through the domain's own primitive.
   *
   * A hard pause stops the Project's Workers one by one through the one primitive a person's stop uses, so each ends
   * exactly as it would otherwise, and the domain waits for the node's answer: a Worker that could not be stopped is
   * reported instead of being claimed as stopped. The report says which Workers stopped and which did not.
   *
   * A resume also sends the PM wake-ups the pause held back, and only those that still wait: a result the PM has not
   * decided yet is still worth telling the PM about, and a result it already decided is not asked about again.
   */
  async pauseProject(projectId: string, paused: boolean, mode: 'soft' | 'hard' = 'soft'):
    Promise<{ project: ProjectProfile; workers: { stopped: string[]; failures: { ticketId: string; error: string }[] } }> {
    const project = this.requireProjectById(projectId)
    const report = await this.engine.pauseProjectReport(projectId, paused, mode)
    this.audit.record({ actor: 'operator', kind: 'project', action: paused ? 'paused' : 'resumed', targetKind: 'project',
      targetId: projectId, outcome: report.workers.failures.length === 0 ? 'ok' : 'failed',
      detail: `${project.title} · ${mode}` })
    if (!paused) await this.resumeDeferredPmNotifications(projectId)
    return { project: report.project, workers: report.workers }
  }

  /**
   * End a Project, through the domain's own primitive.
   *
   * The domain ends the Project and stops every Ticket it still owns, asking the node to stop each Worker as it goes. The
   * node's answers are awaited, so a Worker that could not be stopped is reported here instead of being claimed as
   * stopped: the reconciliation later finds the Session that is still running.
   */
  async stopProject(projectId: string, reason?: string):
    Promise<{ project: ProjectProfile; stopped: string[]; failures: string[] }> {
    const project = this.requireProjectById(projectId)
    const workers = this.runningWorkersOf(projectId)
    const cleanups: { ticketId: string; work: Promise<void> }[] = []
    // The domain ends the Project first, so no Assignment can start over a Worker that is on its way out.
    const ended = this.engine.stopProject(projectId, reason, { cleanups })
    const { stopped, failures } = await this.awaitCleanups(cleanups, workers)
    this.audit.record({ actor: 'operator', kind: 'project', action: 'stopped', targetKind: 'project', targetId: projectId,
      outcome: failures.length === 0 ? 'ok' : 'failed', detail: project.title })
    return { project: ended, stopped, failures }
  }

  /**
   * Archive a Project, through the domain's own primitive.
   *
   * The domain writes the archive first: the Project and its Tickets are archived and the Assignments that still ran are
   * ended, and the node is asked to stop each of those Workers through the one path that stops them. Nothing is stopped
   * twice, and there is no window in which the PM could dispatch a Worker that outlives the archive.
   *
   * The recorded cleanups are awaited, so an archive that could not stop a Worker says so: the leftover Session is
   * reported here and cleaned up by the reconciliation, which is the only path that may touch a Session the domain no
   * longer owns.
   */
  async archiveProject(projectId: string): Promise<{ project: ProjectProfile; stopped: string[]; failures: string[] }> {
    const project = this.requireProjectById(projectId)
    const workers = this.runningWorkersOf(projectId)
    const cleanups: { ticketId: string; work: Promise<void> }[] = []
    const archived = this.engine.archiveProject(projectId, { cleanups })
    const { stopped, failures } = await this.awaitCleanups(cleanups, workers)
    // The Worker Sessions are archived after that, so the node holds no Session for work that is over. The PM Session
    // stays: an archived Project can come back, and a Project whose PM can never be started again would be a Project
    // that cannot be resumed.
    for (const sessionId of workers.values()) {
      if (!this.sessions.has(sessionId)) continue
      try {
        await this.archiveSession(sessionId)
      } catch (error) {
        failures.push(`${sessionId}: ${redact(messageOf(error)).slice(0, 200)}`)
      }
    }
    this.audit.record({ actor: 'operator', kind: 'project', action: 'archived', targetKind: 'project', targetId: projectId,
      outcome: failures.length === 0 ? 'ok' : 'failed', detail: project.title })
    return { project: archived, stopped, failures }
  }

  /**
   * The Worker Sessions of the Assignments that still run in a Project, by Ticket id.
   *
   * It is read before the domain writes, because the domain ends exactly these Assignments: the Session of an Assignment
   * that was already over is not one of them, and a Worker that is created while the write happens cannot escape the
   * archive, because the archive is what freezes the Project.
   */
  private runningWorkersOf(projectId: string): Map<string, string> {
    const workers = new Map<string, string>()
    for (const ticket of this.store.tickets.list()) {
      if (ticket.projectId !== projectId) continue
      const assignment = latestAssignment(ticket)
      if (!assignment || assignment.state === 'ended') continue
      workers.set(ticket.id, this.workerSessionFor(assignment.id))
    }
    return workers
  }

  /**
   * Wait for the recorded cleanups of a Project's Workers, and report which of them are really gone.
   *
   * The wait is bounded: a node that never answers leaves the Worker reported as unconfirmed rather than holding the
   * request open forever. The reconciliation finds the Session that is still running afterwards.
   */
  private async awaitCleanups(cleanups: { ticketId: string; work: Promise<void> }[], workers: Map<string, string>):
    Promise<{ stopped: string[]; failures: string[] }> {
    const stopped: string[] = []
    const failures: string[] = []
    for (const cleanup of cleanups) {
      const sessionId = workers.get(cleanup.ticketId) ?? cleanup.ticketId
      const outcome = await this.settleStopWork(cleanup.work)
      if (outcome.state === 'stopped') {
        stopped.push(sessionId)
        continue
      }
      const detail = outcome.state === 'pending'
        ? `The Worker Session did not stop within ${this.options.stopCleanupTimeoutMs ?? STOP_CLEANUP_TIMEOUT_MS} ms`
        : outcome.error
      failures.push(`${sessionId}: ${redact(detail).slice(0, 200)}`)
    }
    return { stopped, failures }
  }

  /**
   * Bring an archived Project back, through the domain's own primitive.
   *
   * Nothing is restarted: the domain restores the Project's own status and clears its archive marker, and the PM decides
   * what to do with the Tickets that wait.
   */
  unarchiveProject(projectId: string): ProjectProfile {
    const project = this.requireProjectById(projectId)
    const restored = this.engine.unarchiveProject(projectId)
    this.audit.record({ actor: 'operator', kind: 'project', action: 'unarchived', targetKind: 'project', targetId: projectId,
      detail: project.title })
    return restored
  }

  session(sessionId: string): SessionRecord | undefined { return this.sessions.get(sessionId) }

  /**
   * The Sessions the console shows, with the facts about what may still be done with them.
   *
   * A Worker Session whose Assignment a newer one replaced, or whose Worker is gone, cannot receive a message: the console
   * shows that it is not deliverable instead of offering an action the server would refuse. The server's own check stays
   * the rule — this only keeps the console from asking for a refusal it already knows about.
   */
  consoleSessions(): ConsoleSession[] {
    const interruptible = this.nodeSupportsTurnInterrupt()
    return [...this.sessions.values()].map(record => {
      const refusal = this.sessionDeliveryRefusal(record)
      const view: ConsoleSession = { ...record, deliverable: refusal === undefined, interruptible }
      if (refusal !== undefined) view.unavailableReason = refusal
      const turn = this.sessionTurns.get(record.sessionId)
      if (turn !== undefined) view.currentTurn = turn
      return view
    })
  }

  /**
   * Why a Session cannot receive an operator's message, or undefined when it can.
   *
   * The same rule the write path uses, so the console and the server never disagree about it.
   */
  private sessionDeliveryRefusal(record: SessionRecord): string | undefined {
    if (record.revokedAt) return 'the Session was revoked'
    // A Session an operator stopped takes no message, whether the node confirmed the stop or not.
    const stopped = this.operatorStopRefusal(record)
    if (stopped !== undefined) return stopped
    if (record.status === 'archived' || record.status === 'stopped' || record.status === 'stopping'
      || this.stoppingSessions.has(record.sessionId)) {
      return `the Session is ${record.status === 'stopping' || this.stoppingSessions.has(record.sessionId) ? 'stopping' : record.status}`
    }
    if (record.role !== 'worker') return undefined
    const assignmentId = record.assignmentId
    if (!assignmentId) return 'the Worker Session has no Assignment'
    const ticket = this.ticketOfAssignment(assignmentId)
    if (!ticket) return 'the Worker Session has no Ticket'
    const latest = latestAssignment(ticket)
    if (!latest || latest.id !== assignmentId) return 'a newer Assignment of the Ticket took over'
    if (latest.state === 'ended') return 'the Worker Assignment has ended'
    return undefined
  }

  /**
   * The Router Session's record, when this control plane has one.
   *
   * The Router is one Session of the whole control plane: it belongs to no Project, it has a workspace of its own, and it
   * is never created as a side effect of a Project's work.
   */
  routerSession(): SessionRecord | undefined { return this.sessions.get(ROUTER_SESSION_ID) }

  /**
   * Ensure the Router Session.
   *
   * The Router comes up the first time a person speaks to it, so the console never has to ask for it on another page
   * first. Concurrent requests share one ensure, and a Session the current node generation already confirmed is returned as
   * it is: a reconnecting node that forgot it gets the same Session id re-ensured, never a second Session beside it.
   *
   * A Router an operator stopped is not ensured again: the stop is the operator's own word, and only an explicit resume
   * takes it back.
   */
  async ensureRouter(): Promise<SessionRecord> {
    return this.ensureRouterWith({})
  }

  /**
   * The Router's own ensure, with the one option a resume needs.
   *
   * `resume` is the operator's explicit act: it may bring back a Session an operator stopped, and it skips the fast paths
   * that would hand the stopped record back as it is. Nothing else passes it, and the public entry never does.
   */
  private async ensureRouterWith(options: { resume?: boolean }): Promise<SessionRecord> {
    const known = this.sessions.get(ROUTER_SESSION_ID)
    // A revoked Router stays revoked: re-ensuring it would issue a new token and hand the authority back.
    if (known?.revokedAt) {
      throw new OperatorError(409, 'The Router Session was revoked and cannot be started again')
    }
    // A Router an operator stopped stays stopped: no ensure brings it back behind the operator's back.
    if (options.resume !== true && known && this.operatorStopRefusal(known)) {
      throw new OperatorError(409, 'The Router Session was stopped by an operator and has to be resumed explicitly')
    }
    this.requireNodeOnline()
    const pending = this.pendingEnsures.get(ROUTER_SESSION_ID)
    if (pending) {
      // A creation that is still in flight belongs to the stop that came before the resume: joining it would answer with
      // the Session that stop took away.
      if (options.resume === true) {
        throw new OperatorError(409, 'The Router Session is still being created; resume it once that creation settled')
      }
      return pending
    }
    const existing = this.sessions.get(ROUTER_SESSION_ID)
    if (options.resume !== true && existing && isNodeConfirmed(existing.status) && !this.needsReensure(existing)) return existing
    return this.singleFlight(ROUTER_SESSION_ID, () => this.ensureRouterSession(options))
  }

  /** The Router's own ensure: the node is asked for one Session of its own, in a workspace of its own. */
  private async ensureRouterSession(options: { resume?: boolean } = {}): Promise<SessionRecord> {
    const existing = this.sessions.get(ROUTER_SESSION_ID)
    // The same rule as a PM: a confirmed Session from an older generation is re-ensured under the same id.
    const stale = existing !== undefined && this.needsReensure(existing)
    if (options.resume !== true) {
      // The fast paths hand the record back as it is, so the stop gate has to be applied here too: an ensure that was
      // already in flight when the operator stopped the Session must not answer with a Session they stopped.
      if (existing && !stale && isNodeConfirmed(existing.status)) {
        await this.enforceOperatorStop(existing)
        return existing
      }
      if (existing && !stale) {
        const confirmed = await this.confirmExisting(existing)
        if (confirmed) {
          await this.enforceOperatorStop(confirmed)
          return confirmed
        }
      }
    }
    const path = this.workspacePath(join(this.options.workspaceRoot, 'router'))
    const at = this.now()
    const retry = existing !== undefined
    const record: SessionRecord = existing
      ? this.restartSession(existing, path, at)
      : { sessionId: ROUTER_SESSION_ID, projectId: ROUTER_PROJECT_ID, role: 'router', nodeId: this.options.nodeId,
          workspace: path, status: 'starting', toolProfile: ROUTER_PROFILE.name,
          backendSessionId: `fake-${ROUTER_SESSION_ID}`, createdAt: at, updatedAt: at }
    const token = this.issueToken(record)
    this.sessions.set(record.sessionId, record)
    this.tokens.set(record.sessionId, token)
    this.persist(record)
    // Only the first attempt may reuse a stable key: a repeated key is acknowledged by the node without executing it.
    const ensureKey = retry ? this.uniqueKey('router-ensure-confirm', ROUTER_SESSION_ID) : `router-ensure:${ROUTER_SESSION_ID}`
    try {
      await this.options.node.send({ ...this.base(ensureKey), type: 'router.ensure', sessionId: record.sessionId,
        workspace: path, profile: ROUTER_PROFILE, sessionToken: token, prompt: ROUTER_PROFILE.prompt })
    } catch (error) {
      // An ensure that failed on an abnormal receipt must not answer with a Session an operator stopped either.
      const failed = await this.recoverEnsureFailure(record, error, 'Router')
      await this.enforceOperatorStop(failed)
      return failed
    }
    const settled = await this.settleEnsure(record, 'Router')
    // An ensure that was already in flight when the operator stopped the Session would bring it back.
    await this.enforceOperatorStop(settled)
    // The Router is up: the messages that waited for it may go now.
    this.scheduleRouterQueue()
    return settled
  }

  /**
   * Deliver a person's message to the Router.
   *
   * The message is queued first and delivered second, so a person can write while the Router is still answering: the
   * message waits in the queue until the turn that runs now ends, and the turn that follows reads it. The person does
   * not have to press send again.
   *
   * The message is recorded as a request before it goes out, so the Router may act for it — and only for it. The Router
   * Session is ensured here, so the first message a person sends starts it without a detour through another page.
   *
   * The Fast Router reads the message before any of that, but it may only act on it **in the queue's own order**: a
   * message that plainly names its target — a Ticket of this Router, a Project of this control plane, an independent task
   * of its own, or a question about the state of a thing — is carried out by the control plane itself, in the place the
   * queue gives it. No model turn starts for it, nothing waits for one, and the answer is the receipt of what really
   * happened. A message that waits behind an earlier one waits with it, and a Router an operator stopped takes no
   * message at all — the fast route never acts behind the operator's back.
   *
   * Every other message — a question, a conversation, anything the rules are not sure about — is queued for the Router
   * exactly as it was, and the rules say why they left it alone.
   *
   * `options.id` is the message's own id, and it is what makes a repeated send the same message: a message that is
   * already queued is not queued twice, and a message the fast router already carried out is not carried out twice, so a
   * browser that repeats its request cannot make the Router read it twice or create a second Ticket. The same id with
   * other words, other files or another model is a conflict and is refused: the queue holds one message under one id, and
   * the person would not know which of the two the Router reads.
   */
  async sendToRouter(text: string, attachments: readonly RouterTextAttachment[] = [], routerModel?: RouterModel,
    options: { id?: string } = {}): Promise<RouterSendResult> {
    const value = text.trim()
    if (value === '') throw new OperatorError(400, 'A message to the Router needs a text')
    const id = options.id !== undefined && UUID.test(options.id) ? options.id : randomUUID()
    const messageId = `router-msg-${id}`
    const requestId = `router-req-${id}`
    // The same id is the same message: a message that is already in the queue is not queued twice.
    const known = this.consoleStore.routerMessage(messageId)
    if (known) return this.knownRouterMessage(known, value, attachments, routerModel)
    // A message with files belongs to the conversation: the files are read by the Router's own turn, so it is not
    // fast-routed and the model sees it as it always did.
    const decision = attachments.length === 0 ? fastRoute(value, this.fastRouteFacts()) : undefined
    // A rule that is not sure enough does not act: the message goes to the Router's own model, and the record says why.
    const unsure = decision !== undefined && decision.outcome !== 'ordinary_reply' && decision.outcome !== 'escalate'
      && decision.confidence < FAST_ROUTE_MIN_CONFIDENCE
    const claimed = decision !== undefined && !unsure && decision.outcome !== 'ordinary_reply'
      && decision.outcome !== 'escalate'
    if (!claimed) {
      // The Router Session is ensured here, so the first message a person sends starts it without a detour.
      const session = await this.ensureRouter()
      // The ensure awaited: two copies of one message may arrive at the same moment, and the second one finds the row the
      // first one wrote instead of writing a second row.
      const knownNow = this.consoleStore.routerMessage(messageId)
      if (knownNow) return this.knownRouterMessage(knownNow, value, attachments, routerModel)
      const request = this.acceptRouterMessage(messageId, requestId, value, attachments, routerModel)
      // Every message the rules did not carry out keeps the reason why, so the console can say which way it went: the
      // rules read it and left it alone, or the rules never read it because it was a conversation. The record is written
      // before the message goes out, so the order of the records is the order the person wrote them in.
      if (decision !== undefined) {
        this.recordModelRoute(requestId, value, request.at, unsure ? unsureDecision(decision) : decision)
      } else {
        // A message with files belongs to the conversation: the rules never read it, and the model reads it with the
        // files. It is recorded as well, so that every message a person sent is accounted for.
        this.recordModelRoute(requestId, value, request.at, { outcome: 'ordinary_reply', stage: 'model', confidence: 0,
          reason: 'attachments', detail: '这条消息带着附件，交给高层 Router 一起读。' })
      }
      // The delivery is awaited when it can happen right away, so the answer says whether the message really went out. A
      // Router that is answering keeps the message: the answer then says it is queued, not that it was read.
      await this.scheduleRouterQueue()
      return { routed: false, requestId, session, entry: this.routerQueueEntry(this.consoleStore.routerMessage(messageId)!) }
    }
    // The message is one the rules may carry out by themselves. It is queued like any other message, so it keeps its
    // place, and the claim travels with it: the queue's own pump decides when the action happens.
    // A Router an operator stopped — or one whose authority was withdrawn — takes no message at all, and the fast route
    // is not a way around it: the same refusal the conversation path gives.
    const refusal = this.routerTakesNoMessage()
    if (refusal !== undefined) {
      throw new OperatorError(409, `The Router Session is not running: ${refusal}`)
    }
    try {
      this.consoleStore.writeTransaction(() => {
        const request = this.acceptRouterMessage(messageId, requestId, value, attachments, routerModel)
        this.recordClaim(requestId, value, request.at, decision!)
      })
    } catch (error) {
      this.routerRequests.discard(requestId)
      throw error
    }
    await this.scheduleRouterQueue()
    return { routed: true, requestId, route: this.fastRouteReceipt(requestId) }
  }

  /**
   * Accept one message into the Router's queue.
   *
   * The queue is bounded: a message that does not fit is refused before it is accepted, and the messages that are already
   * there keep their place. The person still holds the words in the browser.
   *
   * The request is recorded before the message goes out, so the Router may act for this message — and only for it. The
   * request keeps the time it was written: the window in which the Router may act on it is the one the person was given,
   * and a message that waits for ever does not get a new one.
   */
  private acceptRouterMessage(messageId: string, requestId: string, value: string,
    attachments: readonly RouterTextAttachment[], routerModel?: RouterModel): RouterRequest {
    const pending = this.consoleStore.routerMessageCount(ROUTER_QUEUE_PENDING)
    if (pending >= ROUTER_QUEUE_LIMIT) {
      throw new OperatorError(409, `The Router queue holds ${pending} messages and cannot take more `
        + `(the limit is ${ROUTER_QUEUE_LIMIT}); this message was not queued`)
    }
    const request = this.routerRequests.record(value, requestId)
    this.consoleStore.addRouterMessage({
      id: messageId,
      at: request.at,
      text: value,
      attachments: JSON.stringify(attachments),
      model: routerModel === undefined ? '' : JSON.stringify(routerModel),
      requestId,
      state: 'queued',
      error: '',
    })
    return request
  }

  /**
   * The authoritative facts the Fast Router reads.
   *
   * The rules never guess a Ticket or a Project: they read the ones this control plane really holds, with the state that
   * decides whether they may be acted upon. A Ticket of a Project is in the list as well, because its PM — not the
   * Router — is the one that owns it.
   */
  private fastRouteFacts(): FastRouteFacts {
    return {
      tickets: this.tickets().map(ticket => ({ id: ticket.id, title: ticket.title,
        ...(ticket.projectId === undefined ? {} : { projectId: ticket.projectId }),
        ended: ticket.ended !== undefined, archived: ticket.archived !== undefined })),
      projects: this.projects().map(project => ({ id: project.id, title: project.title, status: project.status })),
    }
  }

  /**
   * Write down that the rules claimed one message, before anything acts on it.
   *
   * The row is the claim itself: it names the rule that read the message, the target it found and the words that would
   * really be delivered. It is written before the action begins, so a control plane that died in the middle leaves the
   * fact behind — and the queue's own order decides *when* the action happens.
   */
  private recordClaim(requestId: string, text: string, at: string, decision: FastRouteDecision): void {
    this.consoleStore.addFastRoute({
      requestId, at, text, outcome: decision.outcome, stage: 'accepted',
      confidence: Math.round(decision.confidence * 100), reason: decision.reason, detail: decision.detail,
      targetKind: decision.target?.kind ?? '', targetId: decision.target?.id ?? '', targetTitle: decision.target?.title ?? '',
      ticketId: '', sessionId: '', ticketTitle: decision.title ?? '', ticketGoal: decision.goal ?? '', error: '',
    })
  }

  /**
   * The action one rule asked for.
   *
   * The record was written before the action began, so a control plane that died in the middle leaves the fact behind
   * instead of repeating the action when it comes back.
   *
   * A failure here is the end of this message, not the beginning of another one: the receipt says what happened, and the
   * message does **not** go to the high-level Router afterwards. A delivery that was already tried — and refused, or
   * never confirmed — must not be tried again by a model that would read the same words and act on them a second time.
   */
  private async executeFastRoute(requestId: string, text: string, decision: FastRouteDecision, at: string):
    Promise<FastRouteStage> {
    try {
      if (decision.outcome === 'standalone_ticket') return await this.dispatchStandaloneTicket(requestId, text, decision, at)
      if (decision.outcome === 'existing_ticket') return await this.continueStandaloneTicket(requestId, text, decision)
      if (decision.outcome === 'read_only') return this.answerReadOnly(requestId, decision)
      return await this.handInstructionToProjectPm(requestId, text, decision)
    } catch (error) {
      // The action was attempted and could not be carried out. The receipt says so, and the message stays where it is:
      // nothing here is reported as a delivery that did not happen, and nothing is handed to the Router to try again.
      const reason = redact(messageOf(error)).slice(0, 300)
      // A missing receipt is not a refusal: the action may have arrived, so it is neither "failed" nor to be repeated.
      const stage: FastRouteStage = error instanceof NodeUnconfirmedError ? 'unconfirmed' : 'failed'
      this.consoleStore.updateFastRoute(requestId, { stage, error: reason })
      this.audit.record({ actor: 'system', kind: 'session', action: 'routed', targetKind: decision.target?.kind ?? 'session',
        targetId: decision.target?.id ?? requestId, outcome: 'failed', detail: reason })
      return stage
    }
  }

  /**
   * The answer to a question about the state of a thing the message named by its id.
   *
   * The record is the answer: the control plane reads the authoritative state and writes it down. No model turn runs, no
   * Worker is started and no PM is interrupted — the person asked what is true, and what is true is on record.
   */
  private answerReadOnly(requestId: string, decision: FastRouteDecision): FastRouteStage {
    const target = decision.target
    if (target === undefined) throw new OperatorError(400, 'The read-only request named no target')
    const answer = this.fastRouteAnswer(target)
    this.consoleStore.updateFastRoute(requestId, { stage: 'assigned', detail: answer, error: '' })
    this.audit.record({ actor: 'system', kind: 'session', action: 'routed', targetKind: target.kind, targetId: target.id,
      detail: answer })
    return 'assigned'
  }

  /**
   * The state of the thing a message named, as the authoritative record holds it.
   *
   * The answer is the record's own word: the Ticket's title and where it stands, the Project's status and the work under
   * it. Nothing here is a summary of a conversation — it is what the control plane really knows.
   */
  private fastRouteAnswer(target: FastRouteTarget): string {
    if (target.kind === 'ticket') {
      const ticket = this.store.tickets.get(target.id)
      if (!ticket) return `工单 ${target.id} 不在这个控制面里。`
      const assignment = latestAssignment(ticket)
      const worker = assignment === undefined ? '' : `；Worker 派工 ${assignment.state}`
      const state = pmTicketStatus(ticket)
      return `工单 ${target.id}「${ticket.title}」现在是 ${TICKET_STATE[state] ?? state}${worker}。`
    }
    const project = this.store.projects.get(target.id)
    if (!project) return `项目 ${target.id} 不在这个控制面里。`
    const tickets = this.tickets().filter(ticket => ticket.projectId === project.id)
    const running = tickets.filter(ticket => pmTicketStatus(ticket) === 'running').length
    return `项目「${project.title}」现在是 ${project.status}；共 ${tickets.length} 张工单，其中 ${running} 张在跑。`
  }

  /**
   * The independent task a rule found: a Ticket of the Router's own, with its own Worker.
   *
   * The Ticket is created through the Engine, exactly as the Router's own dispatch tool creates it, so the domain's
   * idempotency holds: the same request never becomes a second Ticket, even when the control plane is restarted between
   * the two attempts.
   */
  private async dispatchStandaloneTicket(requestId: string, text: string, decision: FastRouteDecision, at: string):
    Promise<FastRouteStage> {
    const title = decision.title ?? ''
    const goal = decision.goal ?? ''
    if (title === '' || goal === '') throw new OperatorError(400, 'The request did not say what the task is')
    this.requireNodeOnline()
    // The Router owns the Ticket it creates, and that Ticket's Worker reports back to the Router: the Session is ensured
    // here, so the report finds the Router it belongs to. This is a Session, not a model turn — the model only runs when
    // a message is delivered, and this path delivers none.
    await this.ensureRouter()
    // The request is recorded before the Ticket is created, so the Router may act for this message — and only for it.
    // The request keeps the time it was written: the window it may act in is the one it was given, never a new one.
    const request = this.routerRequests.record(text, requestId, at)
    const ticketId = this.dispatchStandaloneForRequest(request, title, goal)
    const ticket = this.requireStandaloneTicket(ticketId)
    const assignment = latestAssignment(ticket)
    const sessionId = assignment === undefined ? undefined : this.workerSessionFor(assignment.id)
    // The Worker was asked to start; it is not running until the node says so, so the receipt says "waiting" until then.
    this.consoleStore.updateFastRoute(requestId, { stage: 'queued', ticketId: ticket.id, error: '',
      ...(sessionId === undefined ? {} : { sessionId }) })
    this.audit.record({ actor: 'system', kind: 'session', action: 'routed', targetKind: 'ticket', targetId: ticket.id,
      detail: `${title} · ${decision.detail}` })
    return 'queued'
  }

  /**
   * The Ticket a rule found: the message continues the work of a Ticket the Router owns.
   *
   * The message becomes an Input of that Ticket and is delivered by the same path every other message to a Worker takes,
   * so the node's own answer says whether it arrived. A Ticket that has ended is never continued: the domain refuses it,
   * and the refusal is reported as the failure it is.
   */
  private async continueStandaloneTicket(requestId: string, text: string, decision: FastRouteDecision):
    Promise<FastRouteStage> {
    const ticketId = decision.target?.id ?? ''
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || ticket.projectId !== undefined) {
      throw new OperatorError(400, `Unknown standalone Ticket ${ticketId}`)
    }
    const inputId = key('input', ticketId, 'note', 'router', requestId)
    const result = this.engine.messageTicketTo(ticketId, text, { standalone: true, inputId })
    const assignment = latestAssignment(result.ticket)
    const delivery: { delivered: TicketMessageDelivery; error?: string } = assignment === undefined
      ? { delivered: result.delivered }
      : await this.confirmTicketDelivery(assignment.id, result.inputId, result.delivered)
    const stage: FastRouteStage = delivery.delivered === 'failed' ? 'failed'
      : delivery.delivered === 'running' ? 'assigned' : 'queued'
    const sessionId = assignment === undefined ? undefined : this.workerSessionFor(assignment.id)
    this.consoleStore.updateFastRoute(requestId, { stage, ticketId, error: delivery.error ?? '',
      ...(sessionId === undefined ? {} : { sessionId }) })
    this.audit.record({ actor: 'system', kind: 'session', action: 'routed', targetKind: 'ticket', targetId: ticketId,
      outcome: delivery.delivered === 'failed' ? 'failed' : 'ok', detail: decision.detail })
    return stage
  }

  /**
   * The Project a rule found: the message is an instruction for the PM of that Project.
   *
   * Only the body the Project needs travels with it: the person's own words, fenced as data, and nothing else — no
   * history of the conversation, no files, no other Project's data. The Project must be active and its PM must be there
   * and may be used: a paused, ended or archived Project, a revoked PM and a PM an operator stopped all refuse the
   * instruction, so a routine handoff never walks around a pause, a stop or a withdrawal of authority.
   */
  private async handInstructionToProjectPm(requestId: string, text: string, decision: FastRouteDecision):
    Promise<FastRouteStage> {
    const projectId = decision.target?.id ?? ''
    const project = this.store.projects.get(projectId)
    if (!project) throw new OperatorError(400, `Unknown Project ${projectId}`)
    if (project.status !== 'active') {
      throw new OperatorError(409, `This Project is ${project.status}; it has no PM to instruct`)
    }
    this.consoleStore.updateFastRoute(requestId, { sessionId: project.pmSessionId })
    const pm = this.sessions.get(project.pmSessionId)
    if (!pm) throw new OperatorError(409, 'This Project has no PM Session')
    if (pm.revokedAt) throw new OperatorError(409, 'The PM Session of this Project was revoked')
    const stopped = this.operatorStopRefusal(pm)
    if (stopped !== undefined) {
      throw new OperatorError(409, `The PM Session of this Project is not running: ${stopped}`)
    }
    const instruction = decision.instruction ?? text
    // The key names the delivery, so a repeated attempt of the same request is executed by the node at most once.
    await this.sendMessage(project.pmSessionId, routerAutoInstructionMessage(requestId, instruction, project.title),
      undefined, 'system', { idempotencyKey: `fast-relay:${requestId}` })
    this.consoleStore.updateFastRoute(requestId, { stage: 'assigned', error: '' })
    this.audit.record({ actor: 'system', kind: 'session', action: 'routed', targetKind: 'project', targetId: project.id,
      detail: `${project.title} · ${decision.detail}` })
    return 'assigned'
  }

  /**
   * Write down that a message went to the Router's own model, and why.
   *
   * The reason is the whole point of the record: a person may ask why their message was not carried out at once, and the
   * answer is a stable code beside the words they wrote. A conversation and an escalation are both recorded here — the
   * first because the model answered it, the second because the rules were not sure — and the two are told apart by their
   * outcome and their reason, never by a guess.
   */
  private recordModelRoute(requestId: string, text: string, at: string, decision: FastRouteDecision): void {
    this.consoleStore.addFastRoute({
      requestId, at, text, outcome: decision.outcome, stage: decision.outcome === 'escalate' ? 'escalated' : 'model',
      confidence: Math.round(decision.confidence * 100),
      reason: decision.reason, detail: decision.detail, targetKind: '', targetId: '', targetTitle: '',
      ticketId: '', sessionId: '', ticketTitle: '', ticketGoal: '', error: '',
    })
    // The audit trail keeps the escalations: a message that needed the model is a fact about the work. A conversation is
    // not, and a trail of them would bury the work itself.
    if (decision.outcome !== 'escalate') return
    this.audit.record({ actor: 'system', kind: 'session', action: 'routed', targetKind: 'session', targetId: requestId,
      outcome: 'skipped', detail: decision.detail })
  }

  /**
   * The decision a row on record carries.
   *
   * The row is what the claim was: the target and the task it named are the ones the row holds, so a fact that moved in
   * the meantime cannot send the work somewhere else, and a restart cannot turn the claim into another one.
   */
  private fastRouteDecisionOf(row: FastRouteRow): FastRouteDecision {
    const target = row.targetId === ''
      ? undefined
      : { kind: row.targetKind as 'ticket' | 'project', id: row.targetId, title: row.targetTitle }
    return { outcome: row.outcome as FastRouteOutcome, stage: 'accepted', confidence: row.confidence / 100,
      reason: row.reason, detail: row.detail,
      ...(target === undefined ? {} : { target }),
      ...(row.ticketTitle === '' ? {} : { title: row.ticketTitle }),
      ...(row.ticketGoal === '' ? {} : { goal: row.ticketGoal }),
      ...(row.outcome === 'existing_project_pm' ? { instruction: row.text } : {}) }
  }

  /**
   * One routing, as the console reads it.
   *
   * The Session status beside it is the node's own word, so a Worker that was asked to start but is not up yet is never
   * shown as running.
   */
  private fastRouteReceipt(requestId: string): FastRouteReceipt {
    const row = this.consoleStore.fastRoute(requestId)
    if (!row) throw new OperatorError(500, 'The routing of this message is not on record')
    const session = row.sessionId === '' ? undefined : this.sessions.get(row.sessionId)
    return { requestId: row.requestId, at: row.at, text: row.text, path: fastRoutePath(row.outcome),
      outcome: row.outcome as FastRouteOutcome,
      stage: row.stage as FastRouteStage, confidence: row.confidence / 100, reason: row.reason, detail: row.detail,
      ...(row.targetId === '' ? {} : { target: { kind: row.targetKind, id: row.targetId, title: row.targetTitle } }),
      ...(row.ticketId === '' ? {} : { ticketId: row.ticketId }),
      ...(row.sessionId === '' ? {} : { sessionId: row.sessionId }),
      ...(session === undefined ? {} : { sessionStatus: session.status }),
      ...(row.error === '' ? {} : { error: row.error }),
      ...(row.outcome === 'read_only' && row.stage === 'assigned' ? { answer: row.detail } : {}) }
  }

  /**
   * The routings the console shows: what became of the messages the rules read.
   *
   * They are the newest first, so the console may show them in the order they were made.
   */
  fastRouteReceipts(limit = FAST_ROUTE_SHOWN): FastRouteReceipt[] {
    return this.consoleStore.fastRoutes({ limit, newest: true })
      .reverse()
      .map(row => this.fastRouteReceipt(row.requestId))
  }

  /**
   * A Worker's Assignment started: the routing that started this Worker now has its target.
   *
   * The receipt moves from "waiting" to "the target took it" here, where the node's own confirmation of the Worker
   * Session is the fact that the work began. A routing that continued a Ticket waits for its own message instead: it
   * moves when the node says that message reached the Worker.
   */
  private markFastRouteAssigned(ticketId: string): void {
    for (const row of this.consoleStore.fastRoutesOfTicket(ticketId)) {
      if (row.stage !== 'queued' && row.stage !== 'routing') continue
      if (row.outcome !== 'standalone_ticket') continue
      this.consoleStore.updateFastRoute(row.requestId, { stage: 'assigned' })
    }
  }

  /**
   * The Worker took the message a routing was waiting for.
   *
   * The receipt moves from "waiting" to "the target took it" here, where the node's own answer says the Input reached
   * the Worker's Session. The Input carries the id the routing derived, so a message that belongs to another routing is
   * never mistaken for this one.
   */
  private markFastRouteDelivered(ticketId: string, inputIds: readonly string[]): void {
    for (const row of this.consoleStore.fastRoutesOfTicket(ticketId)) {
      if (row.stage !== 'queued') continue
      if (row.outcome !== 'existing_ticket') continue
      const inputId = key('input', ticketId, 'note', 'router', row.requestId)
      if (!inputIds.includes(inputId)) continue
      this.consoleStore.updateFastRoute(row.requestId, { stage: 'assigned' })
    }
  }

  /**
   * The answer for a message the queue already holds.
   *
   * The same id with the same words is the same message, so its own result is returned: a browser that repeats its
   * request neither queues a second message nor gets a second answer. The same id with other words, other files or
   * another model is a conflict and is refused — the queue cannot hold both, and a person would not know which one the
   * Router is going to read.
   *
   * A message the rules claimed is answered with its own receipt: the control plane carried it out, and a repeated
   * request neither carries it out again nor hands it to the Router now.
   */
  private async knownRouterMessage(row: RouterQueueRow, text: string, attachments: readonly RouterTextAttachment[],
    routerModel?: RouterModel): Promise<RouterSendResult> {
    const same = row.text === text
      && sameAttachments(parseRouterAttachments(row.attachments), attachments)
      && sameModel(parseRouterModel(row.model), routerModel)
    if (!same) {
      throw new OperatorError(409, `The message id ${row.id} was already used for another message; `
        + 'send this one with a new id')
    }
    const claim = this.consoleStore.fastRoute(row.requestId)
    if (claim !== undefined && isClaimedOutcome(claim.outcome)) {
      return { routed: true, requestId: row.requestId, route: this.fastRouteReceipt(row.requestId) }
    }
    const session = this.sessions.get(ROUTER_SESSION_ID) ?? await this.ensureRouter()
    return { routed: false, requestId: row.requestId, session, entry: this.routerQueueEntry(row) }
  }

  /**
   * Deliver the Router's queued messages, oldest first.
   *
   * The chain is what keeps the order: the second delivery waits for the first to settle, so the node's inbox holds the
   * messages in the order the person wrote them however many requests arrived at once.
   *
   * A message is delivered when the Router is not running. An interjection waits for the turn that runs now to end, and
   * the turn that follows reads it — that is what the queue is for.
   */
  private scheduleRouterQueue(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.routerQueuePump = this.routerQueuePump
      .then(() => this.pumpRouterQueue())
      .catch(error => {
        // A queue that failed is reported and left alone: the messages stay in it and the next run tries again.
        process.stderr.write(`superagent control-plane Router queue failed: ${messageOf(error)}\n`)
      })
    return this.routerQueuePump
  }

  /** Deliver the Router's queued messages, oldest first. */
  private async pumpRouterQueue(): Promise<void> {
    while (!this.closed) {
      const next = this.consoleStore.routerMessages({ limit: 1, states: ['queued'] })[0]
      if (!next) return
      // A message the rules claimed is the control plane's own work: it is carried out here, in the place the queue
      // gives it, and it never reaches the Router's model. A later task never overtakes an earlier one, because the
      // queue's order is the only order there is.
      const claim = this.consoleStore.fastRoute(next.requestId)
      if (claim !== undefined && isClaimedOutcome(claim.outcome)) {
        if (claim.stage !== 'accepted') {
          // The action already began: the message is the control plane's own work now, and a second attempt would be a
          // second Ticket, a second handoff or a second message to a Worker that already has this one.
          this.consoleStore.updateRouterMessage(next.id, { state: 'routed', error: '' })
          continue
        }
        const record = this.sessions.get(ROUTER_SESSION_ID)
        if (record !== undefined && this.routerTakesNoMessage() === undefined && !await this.routerIsFree(record)) {
          this.scheduleRouterQueueRetry()
          return
        }
        if (this.closed) return
        const refusal = this.routerTakesNoMessage()
        if (refusal !== undefined) {
          // A Router an operator stopped — or one whose authority was withdrawn — takes no message at all: the claim
          // waits with the rest of the queue for the explicit resume, and nothing is carried out behind the operator's
          // back. The Projects and the Workers that are still running stay as they are.
          this.consoleStore.updateRouterMessage(next.id, { state: 'queued', error: refusal })
          this.consoleStore.updateFastRoute(claim.requestId, { stage: 'accepted', error: refusal })
          return
        }
        await this.runClaimedFastRoute(next, claim)
        // The next message may follow: a carried-out claim costs no model turn, so the queue does not wait for one.
        continue
      }
      const record = this.sessions.get(ROUTER_SESSION_ID)
      if (!record) {
        // The Router Session is not there yet: the message waits for it rather than failing.
        this.consoleStore.updateRouterMessage(next.id, { error: 'The Router Session is not running yet' })
        return
      }
      // A Router an operator stopped takes no message: it waits for the explicit resume instead of failing.
      const stopped = this.operatorStopRefusal(record)
      if (stopped !== undefined) {
        this.consoleStore.updateRouterMessage(next.id, { state: 'queued', error: stopped })
        return
      }
      // A Router that is answering waits: the message goes out in the turn that follows the one that runs now. The
      // node's own answer decides, so an old "running" cannot hold the queue for ever.
      if (!await this.routerIsFree(record)) {
        this.scheduleRouterQueueRetry()
        return
      }
      if (this.closed) return
      const outcome = await this.deliverRouterMessage(next)
      if (outcome === 'delivered') {
        // One message per round: the next one goes out in the round that follows the one this message starts, so the
        // model that runs now is not switched under it. The Router's own turn end brings the queue back, and the retry
        // is the safety net for a turn end that never arrived.
        this.scheduleRouterQueueRetry()
        return
      }
      if (outcome === 'unconfirmed') {
        // The receipt is missing: the next message waits for the next look, so nothing is sent twice.
        this.scheduleRouterQueueRetry()
        return
      }
      if (outcome === 'waiting') return
      // The node refused this message: it is over, and the next one still has to move. The queue does not stop at the
      // first refusal, and it does not push the waiting messages out either.
    }
  }

  /**
   * Why the Router takes no message right now, or undefined when it may.
   *
   * A Router an operator stopped — or one whose authority was withdrawn — is not a Router that may be used: its own
   * messages wait for the explicit resume, and the fast route waits with them. The Projects and the Workers that are
   * still running are not touched by this: only the Router's own messages wait.
   */
  private routerTakesNoMessage(): string | undefined {
    const record = this.sessions.get(ROUTER_SESSION_ID)
    if (record === undefined) return undefined
    const stopped = this.operatorStopRefusal(record)
    if (stopped !== undefined) return stopped
    return record.revokedAt === undefined ? undefined : 'the Router Session was revoked'
  }

  /**
   * Carry one claimed message out, in the queue's own order.
   *
   * The message leaves the queue before the action begins: it is the control plane's own work from now on, so a control
   * plane that died in the middle must not carry it out a second time when it comes back.
   */
  private async runClaimedFastRoute(entry: RouterQueueRow, row: FastRouteRow): Promise<void> {
    this.consoleStore.writeTransaction(() => {
      this.consoleStore.updateRouterMessage(entry.id, { state: 'routed', error: '' })
      this.consoleStore.updateFastRoute(row.requestId, { stage: 'routing', error: '' })
    })
    await this.executeFastRoute(row.requestId, entry.text, this.fastRouteDecisionOf(row), row.at)
  }

  /**
   * Whether the Router may take a message right now.
   *
   * The node's own answer is the authority: the control plane's status is the last event it saw, and an event that never
   * arrived leaves a status that says "running" for ever — or one that says "idle" for a Router that really answers.
   * The question goes through the command and event path the control plane already uses, so it needs no second
   * connection to the node, and a Router that really answers is never interrupted mid-turn: the model that runs now is
   * not switched under it.
   */
  private async routerIsFree(record: SessionRecord): Promise<boolean> {
    const inspection = await this.inspectOverProtocol(ROUTER_SESSION_ID)
    if (this.closed) return false
    if (inspection?.found && inspection.status !== undefined) {
      this.adoptInspection(record, inspection)
      return inspection.status !== 'running'
    }
    // The node could not answer: its own last word is the record's status, and a Router that is answering waits.
    return record.status !== 'running'
  }

  /**
   * Look at the queue again after a while.
   *
   * The Router's own turn end is what usually releases the queue. This is the safety net for the case where that event
   * never arrived: a message that waits must not wait for ever because one event was lost. One timer serves the whole
   * queue, so a hundred waiting messages do not mean a hundred lookups.
   */
  private scheduleRouterQueueRetry(): void {
    if (this.closed || this.routerQueueRetry !== undefined) return
    const timer = setTimeout(() => {
      this.routerQueueRetry = undefined
      void this.scheduleRouterQueue()
    }, ROUTER_QUEUE_RETRY_MS)
    timer.unref?.()
    this.routerQueueRetry = timer
  }

  /**
   * Deliver one queued message to the Router, and write down what became of it.
   *
   * The message names its own id, so the node reports it under that id when a turn really takes it. The inbox and the
   * turn are two facts: the message is `sent` once the node took it, and only a turn that names it makes it `read`.
   *
   * The request the Router may act for is restored here, and only here: a message that waited across a restart gets its
   * own id, its own words and the time it was written back. The window it may act in is the one it was given — never a
   * new one — and a message that was already sent or read never gets an executable authority back.
   */
  private async deliverRouterMessage(entry: RouterQueueRow): Promise<'delivered' | 'failed' | 'waiting' | 'unconfirmed'> {
    const attachments = parseRouterAttachments(entry.attachments)
    const model = parseRouterModel(entry.model)
    const request = { id: entry.requestId, at: entry.at, text: entry.text }
    // The request the Router may act for: it is the one the message was written with, restored with the time it was
    // written, so the window it may act in is the one it was given.
    if (this.routerRequests.get(entry.requestId) === undefined) {
      this.routerRequests.record(entry.text, entry.requestId, entry.at)
    }
    // The message is on its way: the state says so before the node answers, so a restart in the middle leaves an honest
    // record behind instead of a message that looks as if it never left.
    this.consoleStore.updateRouterMessage(entry.id, { state: 'sending', error: '' })
    try {
      await this.sendMessage(ROUTER_SESSION_ID, routerRequestMessage(request, attachments), [entry.id], 'operator', {
        idempotencyKey: `router-msg:${entry.id}`,
        ...(model === undefined ? {} : { routerModel: model }),
      })
    } catch (error) {
      if (this.closed) return 'unconfirmed'
      const reason = redact(messageOf(error)).slice(0, 300)
      const current = this.consoleStore.routerMessage(entry.id)
      // A turn that really took the message says so more strongly: a later failure must not overwrite that fact.
      if (current?.state === 'read') return 'delivered'
      // A missing receipt is not a refusal: the message may have reached the node, so it is neither sent again nor
      // given an authority back. It is marked as what it is.
      if (error instanceof NodeUnconfirmedError) {
        this.consoleStore.updateRouterMessage(entry.id, { state: 'unconfirmed', error: reason })
        this.routerRequests.discard(entry.requestId)
        return 'unconfirmed'
      }
      // A node that is not reachable keeps the message: it waits for the node instead of failing.
      if (this.nodeOffline()) {
        this.consoleStore.updateRouterMessage(entry.id, { state: 'queued', error: reason })
        return 'waiting'
      }
      this.consoleStore.updateRouterMessage(entry.id, { state: 'failed', error: reason })
      // A message that never reached the Router leaves no open request behind: the Router never saw the id, so it must
      // not be able to propose for it either.
      this.routerRequests.discard(entry.requestId)
      return 'failed'
    }
    if (this.closed) return 'unconfirmed'
    // The node took the message. A turn that already read it says so more strongly, and that fact is not undone here.
    if (this.consoleStore.routerMessage(entry.id)?.state !== 'read') {
      this.consoleStore.updateRouterMessage(entry.id, { state: 'sent', error: '' })
    }
    return 'delivered'
  }

  /** Write down that a turn of the Router really took one of the queued messages. */
  private markRouterMessagesRead(inputIds: readonly string[]): void {
    for (const id of inputIds) {
      const row = this.consoleStore.routerMessage(id)
      if (!row || row.state === 'read') continue
      this.consoleStore.updateRouterMessage(id, { state: 'read', error: '' })
    }
  }

  /**
   * Say honestly what a restart left behind.
   *
   * A message that was on its way when the process ended may or may not have reached the node: the receipt is missing,
   * not negative. It is marked as that — it is neither sent again nor given an authority back — and the messages that
   * were still waiting keep waiting, with the request they were written with.
   */
  private reconcileRouterQueue(): void {
    for (const row of this.consoleStore.routerMessages({ limit: ROUTER_QUEUE_LIMIT, states: ['sending'] })) {
      this.consoleStore.updateRouterMessage(row.id, { state: 'unconfirmed',
        error: 'The control plane stopped while this message was on its way; it is not sent again' })
      this.routerRequests.discard(row.requestId)
    }
  }

  /**
   * Say honestly what a restart left behind the Fast Router's routings.
   *
   * A routing that was on its way when the process ended may or may not have reached its target: the receipt is missing,
   * not negative. It says exactly that, and it is never carried out again: a Ticket that may or may not exist, an
   * instruction that may or may not have arrived and a Worker that may or may not have the message are all facts the
   * control plane cannot confirm, so the person's message is not repeated to find out.
   */
  private reconcileFastRoutes(): void {
    for (const row of this.consoleStore.fastRoutes({ limit: 200, newest: true })) {
      if (row.stage !== 'routing') continue
      this.consoleStore.updateFastRoute(row.requestId, {
        stage: 'unconfirmed',
        error: 'The control plane stopped while this routing was on its way; it is not carried out again',
      })
    }
  }

  /**
   * Say honestly what a restart left behind the handoffs to a Project's PM.
   *
   * Work that was on its way when the process ended may or may not have reached the PM: the receipt is missing, not
   * negative. It says exactly that, and it is never sent again — the person's request is not repeated to find out.
   */
  private reconcileRouterHandoffs(): void {
    for (const row of this.consoleStore.routerHandoffs({ limit: 200, newest: true })) {
      if (row.stage !== 'routing') continue
      this.consoleStore.updateRouterHandoff(row.requestId, { stage: 'unconfirmed', reason: 'delivery_unconfirmed',
        detail: '控制面在这份工作送达途中停了，无法确认它是否到达，不会再送一次。',
        error: 'The control plane stopped while this work was on its way; it is not sent again' })
    }
  }

  /** One row of the Router's queue, as the console reads it. */
  private routerQueueEntry(row: RouterQueueRow): RouterQueueEntry {
    return { id: row.id, at: row.at, text: row.text, attachments: parseRouterAttachments(row.attachments).map(file => file.name),
      state: row.state as RouterQueueState, ...(row.error === '' ? {} : { error: row.error }), requestId: row.requestId }
  }

  async routerOptions(): Promise<RouterOptions> {
    try {
      const node = this.options.node
      const inspection = node.inspect
        ? await node.inspect(ROUTER_SESSION_ID, true)
        : await this.inspectOverProtocol(ROUTER_SESSION_ID, true)
      return inspection?.routerOptions ?? { models: [] }
    } catch {
      return { models: [] }
    }
  }

  /**
   * The Router's facts, as the console reads them.
   *
   * The conversation is read from the node's own message events, so the console shows what really happened: the
   * person's own words for the requests it sent, and the model's own answers for the replies. Nothing is echoed twice and
   * nothing is invented here.
   */
  routerState(): RouterState {
    const record = this.sessions.get(ROUTER_SESSION_ID)
    const messages = this.sessionMessages(ROUTER_SESSION_ID)
      .filter(message => message.role === 'assistant'
        || !/^\[superagent: (worker|project) report\]\r?\n/.test(message.text))
      .map(message => {
        const request = routerRequestOf(message.text)
        return request === undefined
          ? { ...message }
          : { seq: message.seq, at: message.at, role: 'user', text: request.text, requestId: request.id,
            ...(request.attachments ? { attachments: request.attachments } : {}) }
      })
    const proposal = this.routerRequests.current()
    const base: RouterState = { nodeOnline: this.nodes.get(this.options.nodeId)?.online !== false, messages }
    // The proposal the console shows: the one that waits for a person right now, with the text that would be sent.
    if (proposal !== undefined) base.proposal = routerProposalView(proposal)
    // The Router is the logical superior of the PM Sessions and of the standalone Workers, so it reads their notices.
    const stops = this.stopNotices({ superiorKind: 'router', superiorId: ROUTER_SESSION_ID, limit: PROJECT_STOP_NOTICE_LIMIT })
    if (stops.length > 0) base.stops = stops
    // The messages a person sent to the Router, and what became of them: the console shows the queue, so a reloaded
    // page explains it instead of hiding it. The newest are kept and shown in the order they were written, because
    // that is the order they will be delivered in. A message the Fast Router carried out is not in this list: it never
    // went to the Router, and the routings below show it once.
    const queue = this.consoleStore.routerMessages({ limit: ROUTER_QUEUE_SHOWN, newest: true })
      .filter(row => row.state !== 'routed')
      .reverse()
      .map(row => this.routerQueueEntry(row))
    if (queue.length > 0) base.queue = queue
    // The routings the Fast Router made, and what became of them: the console shows the target of each one and how far
    // it really got, so a person never has to guess where their message went.
    const routes = this.fastRouteReceipts()
    if (routes.length > 0) base.routes = routes
    // The decisions of the Project Gate: what the gate was asked, what it answered, and the Project and the PM that
    // exist when it let one through.
    const gates = this.projectGateRecords()
    if (gates.length > 0) base.gates = gates
    // The handoffs the high-level Router made to a Project's PM: the target, the PM Session, the words that really
    // travelled and how far the delivery got.
    const handoffs = this.routerHandoffRecords()
    if (handoffs.length > 0) base.handoffs = handoffs
    if (record === undefined) return base
    // The turn the Router runs right now and the node's own offer to end one: the console shows the interrupt only when
    // the backend confirms both.
    const turn = this.sessionTurns.get(ROUTER_SESSION_ID)
    return { ...base, session: { sessionId: record.sessionId, status: record.status, workspace: record.workspace,
      updatedAt: record.updatedAt, ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
      ...(turn === undefined ? {} : { currentTurn: turn }),
      interruptible: this.nodeSupportsTurnInterrupt() } }
  }

  /**
   * The running state the Router reads.
   *
   * It is the same facts the console shows, in a shape a model can read: every Project, its Tickets and their Assignments.
   * A report's own summary is included, bounded, because a person asking "what is going on" wants the words of the last
   * report and not only a state.
   */
  routerSummary(): RouterSummary {
    const projects = this.projects()
    const tickets = this.tickets()
    const summary: RouterSummary = {
      at: this.now(),
      standaloneTickets: this.consoleStandaloneTickets().map(ticket => ({
        ...ticket,
        ...(ticket.assignment?.report === undefined ? {} : { assignment: { ...ticket.assignment,
          report: { ...ticket.assignment.report, summary: ticket.assignment.report.summary.slice(0, 400) } } }),
      })),
      projects: projects.map(project => ({
        id: project.id,
        title: project.title,
        goal: project.goal,
        status: project.status,
        pmSessionId: project.pmSessionId,
        ...(project.latestReport === undefined ? {} : { latestReport: { ...project.latestReport,
          summary: project.latestReport.summary.slice(0, 400) } }),
        tickets: tickets.filter(ticket => ticket.projectId === project.id).map(ticket => {
          const assignment = latestAssignment(ticket)
          const card: RouterSummaryTicket = { id: ticket.id, title: ticket.title, status: pmTicketStatus(ticket) }
          if (assignment !== undefined) {
            card.assignment = { id: assignment.id, state: assignment.state,
              ...(assignment.report === undefined ? {} : { report: { state: assignment.report.state,
                summary: assignment.report.summary.slice(0, 400), at: assignment.report.at } }) }
          }
          return card
        }),
      })),
      sessions: [...this.sessions.values()].filter(session => session.role !== 'router')
        .map(session => ({ sessionId: session.sessionId, role: session.role, status: session.status,
          projectId: session.projectId })),
      counts: { projects: projects.length, tickets: tickets.length,
        runningTickets: tickets.filter(ticket => pmTicketStatus(ticket) === 'running').length,
        pendingReviews: tickets.filter(ticket => pendingReview(ticket) !== undefined).length },
    }
    return summary
  }

  /**
   * A proposal to relay one instruction to one Project's PM.
   *
   * It proposes; it never delivers. The Router's authority is the person's request and nothing else, so the request id
   * must name a request that is still open, and a request may carry at most one proposal — the person's words are one
   * request, and one request is one thing to confirm. The Project is checked against the domain — it must exist, still
   * be active, and still have the PM Session that belongs to it — so a Router can neither reach a Project that is over
   * nor invent one.
   *
   * The answer says plainly that the proposal is waiting: nothing has been sent, and only the person who holds the
   * console key may confirm it.
   */
  async routerPmProposal(sessionId: string, requestId: string, projectId: string, instruction: string):
    Promise<{ status: 'pending'; proposalId: string; requestId: string; projectId: string; projectTitle: string;
      instruction: string }> {
    this.requireToolSession(sessionId, 'router')
    const request = this.routerRequests.get(requestId)
    if (!request) {
      throw new ToolCallError('invalid', 'This request is unknown or is too old; the Router may only propose what a '
        + 'person asked for just now')
    }
    if (request.proposal !== undefined) {
      throw new ToolCallError('invalid', 'This request already carries one proposal; one request is one thing to confirm')
    }
    if (request.dispatchedTicket || request.management) throw new ToolCallError('invalid', 'This request already routed to another action')
    // The two ways of reaching a PM do not cross: a request that was already given to a PM does not also wait for a
    // proposal, and a request that waits for a proposal is not given to a PM behind the person's back.
    if (request.handoff !== undefined || this.consoleStore.routerHandoff(requestId) !== undefined) {
      throw new ToolCallError('invalid', 'This request already reached a Project PM; one request is one thing to do')
    }
    if (request.createdProject !== undefined && request.createdProject.id !== projectId) {
      throw new ToolCallError('invalid', 'This request created another Project')
    }
    const project = this.requireRouterProject(projectId)
    const proposal = this.routerRequests.propose(request, { projectId: project.id, projectTitle: project.title,
      instruction: instruction.trim() })
    this.audit.record({ actor: 'router', kind: 'session', action: 'proposal', targetKind: 'project',
      targetId: project.id, detail: `${project.title} · 待确认 · ${proposal.instruction.length} 字` })
    return { status: 'pending', proposalId: proposal.id, requestId, projectId: project.id, projectTitle: project.title,
      instruction: proposal.instruction }
  }

  /**
   * The high-level Router's own handoff: give this request to the PM of one Project.
   *
   * The person asked for work that belongs to a Project, the model worked out which Project, and the control plane does
   * the delivery itself — no proposal, no confirmation, no second click. What the model may decide is *which* Project and
   * *what* to say; everything else is checked here against the person's own words: the request has to ask for work, the
   * Project has to be the one the request names — or the one the request created — and the instruction has to be the
   * person's own words.
   *
   * One request is one delivery. A repeated call for the same request finds the delivery that already happened and
   * answers with it; a call for a request that went somewhere else is refused; and a call for a request nobody made any
   * more is refused rather than carried out on a stale permission.
   */
  async routerPmHandoff(sessionId: string, requestId: string, input: unknown): Promise<RouterHandoffOutcome> {
    this.requireToolSession(sessionId, 'router')
    const running = this.handoffFlights.get(requestId)
    if (running !== undefined) return running
    let flight: Promise<RouterHandoffOutcome>
    flight = this.runRouterHandoff(requestId, input).finally(() => {
      if (this.handoffFlights.get(requestId) === flight) this.handoffFlights.delete(requestId)
    })
    this.handoffFlights.set(requestId, flight)
    return flight
  }

  /**
   * One handoff of one request.
   *
   * The request is looked up first: a request that is not in memory is unknown or too old, and the only thing that may
   * answer for it is the durable record of a delivery that really ran — the receipt of that delivery, and nothing new.
   */
  private async runRouterHandoff(requestId: string, input: unknown): Promise<RouterHandoffOutcome> {
    const request = this.routerRequests.get(requestId)
    if (request === undefined) return this.replayHandoffOutcome(requestId)
    // One request is one thing to do: a request that already became a Ticket, a management action or a proposal does
    // not also reach a PM.
    if (request.dispatchedTicket || request.management) {
      throw new ToolCallError('invalid', 'This request already routed to another action')
    }
    if (request.proposal !== undefined) {
      throw new ToolCallError('invalid', 'This request already carries a relay proposal; confirm it in the console')
    }
    // A delivery that already happened is the answer to a repeated call: the same work is never sent twice.
    const recorded = this.consoleStore.routerHandoff(requestId)
    if (recorded !== undefined) {
      const same = recorded.projectId === readProjectIdOf(input) && recorded.instruction === readInstructionOf(input)
      if (same) return this.handoffOutcomeOf(recorded)
      // A refusal sent nothing, so a decision that holds may follow it; a delivery that was tried does not.
      if (!this.handoffMayRetry(recorded)) {
        throw new ToolCallError('invalid', 'This request already handed its work to a Project PM')
      }
    }
    let decision: RouterHandoffDecision
    try {
      decision = readRouterHandoffDecision(input)
    } catch (error) {
      if (!(error instanceof RouterHandoffError)) throw error
      return this.recordHandoffRefusal(request, error.reason, error.message, decisionOfNothing(input))
    }
    const verdict = evaluateRouterHandoff(decision, { text: request.text, projects: this.handoffProjects(),
      ...(request.createdProject === undefined ? {} : { createdProjectId: request.createdProject.id }) })
    if (!verdict.allowed) {
      return this.recordHandoffRefusal(request, verdict.reason, verdict.detail, decision)
    }
    return this.deliverRouterHandoff(request, 'handoff', decision, verdict)
  }

  /**
   * The receipt of a delivery that really ran, when the request itself is gone.
   *
   * A request that is not in memory is unknown or too old, and only a durable record may answer for it: the record of a
   * delivery that was carried out is the receipt of that delivery, and it is answered without sending anything and
   * without sending a command to the node. A delivery that was written down as "on its way" and never finished is
   * answered as unconfirmed: the control plane cannot say whether it arrived, and it is never sent again.
   */
  private replayHandoffOutcome(requestId: string): RouterHandoffOutcome {
    const row = this.consoleStore.routerHandoff(requestId)
    if (row === undefined) throw new ToolCallError('invalid', 'This request is unknown or is too old')
    if (row.stage !== 'routing' && row.stage !== 'accepted') return this.handoffOutcomeOf(row)
    this.consoleStore.updateRouterHandoff(requestId, { stage: 'unconfirmed', reason: 'delivery_unconfirmed',
      detail: '上一次交接在送达途中停了，控制面无法确认工作是否到达，不会再送一次。' })
    return this.handoffOutcomeOf(this.consoleStore.routerHandoff(requestId)!)
  }

  /**
   * Deliver the work to the PM of the Project, once.
   *
   * The Project is checked again here, at the moment of the delivery: it must exist, still be active and still have the
   * PM Session that belongs to it. A paused, ended or archived Project, a revoked PM and a PM an operator stopped all
   * refuse the work, so a routine handoff never walks around a pause, a stop or a withdrawal of authority.
   *
   * The record is written before anything is sent, so a control plane that died in the middle leaves the fact behind
   * instead of sending the same work twice. The delivery carries a stable key, so the node itself executes it at most
   * once.
   */
  private async deliverRouterHandoff(request: RouterRequest, kind: 'handoff' | 'brief', decision: RouterHandoffDecision,
    verdict: RouterHandoffVerdict): Promise<RouterHandoffOutcome> {
    // A delivery that already happened is the answer: one request reaches one PM, and the same work is never sent twice.
    const already = this.consoleStore.routerHandoff(request.id)
    if (already !== undefined && !this.handoffMayRetry(already)) return this.handoffOutcomeOf(already)
    const projectId = verdict.project?.id ?? decision.projectId
    const project = this.store.projects.get(projectId)
    if (!project) return this.recordHandoffFailure(request, kind, decision, 'unknown_project',
      `这个控制面里没有项目 ${projectId}。`)
    if (project.status !== 'active') {
      return this.recordHandoffFailure(request, kind, decision, 'project_unavailable',
        `项目「${project.title}」现在是 ${project.status}，没有可以接收工作的 PM。`)
    }
    const pm = this.sessions.get(project.pmSessionId)
    if (!pm) {
      return this.recordHandoffFailure(request, kind, decision, 'pm_unavailable',
        `项目「${project.title}」没有 PM 会话。`)
    }
    if (pm.revokedAt) {
      return this.recordHandoffFailure(request, kind, decision, 'pm_revoked',
        `项目「${project.title}」的 PM 会话已被撤权。`)
    }
    const stopped = this.operatorStopRefusal(pm)
    if (stopped !== undefined) {
      return this.recordHandoffFailure(request, kind, decision, 'pm_stopped',
        `项目「${project.title}」的 PM 会话没有在运行：${stopped}`)
    }
    const instruction = verdict.instruction ?? decision.instruction
    this.consoleStore.addRouterHandoff({ requestId: request.id, kind, at: this.now(), text: request.text,
      projectId: project.id, projectTitle: project.title, pmSessionId: project.pmSessionId, instruction,
      rationale: decision.rationale, stage: 'routing', reason: verdict.reason, detail: verdict.detail, error: '' })
    request.handoff = { projectId: project.id, instruction }
    const message = kind === 'brief'
      ? routerProjectBriefMessage(request.id, instruction, project.title)
      : routerAutoInstructionMessage(request.id, instruction, project.title, 'work')
    try {
      // The key names the delivery, so a repeated attempt of the same request is executed by the node at most once.
      await this.sendMessage(project.pmSessionId, message, undefined, 'system',
        { idempotencyKey: `router-${kind}:${request.id}` })
    } catch (error) {
      const reason = redact(messageOf(error)).slice(0, 300)
      // A missing receipt is not a refusal: the work may have arrived, so it is neither "failed" nor to be repeated.
      const stage: RouterHandoffStage = error instanceof NodeUnconfirmedError ? 'unconfirmed' : 'failed'
      this.consoleStore.updateRouterHandoff(request.id, { stage, reason: stage === 'unconfirmed' ? 'delivery_unconfirmed'
        : 'delivery_failed', detail: stage === 'unconfirmed' ? '节点没有确认工作是否送达，不会再送一次。'
        : '工作没有送到这个项目的 PM。', error: reason })
      this.audit.record({ actor: 'router', kind: 'session', action: 'routed', targetKind: 'project',
        targetId: project.id, outcome: 'failed', detail: `${project.title} · ${reason}` })
      return this.handoffOutcomeOf(this.consoleStore.routerHandoff(request.id)!)
    }
    this.consoleStore.updateRouterHandoff(request.id, { stage: 'assigned', reason: verdict.reason, detail: verdict.detail,
      error: '' })
    this.audit.record({ actor: 'router', kind: 'session', action: 'routed', targetKind: 'project',
      targetId: project.id, detail: `${project.title} · ${instruction.length} 字` })
    return this.handoffOutcomeOf(this.consoleStore.routerHandoff(request.id)!)
  }

  /**
   * Write down that a handoff was refused, and answer with the refusal.
   *
   * Nothing is sent: the refusal is a record and an answer, and the Project, its PM and its Tickets stay as they were.
   */
  private recordHandoffRefusal(request: RouterRequest, reason: string, detail: string,
    decision: RouterHandoffDecision): RouterHandoffOutcome {
    const project = this.store.projects.get(decision.projectId)
    this.consoleStore.addRouterHandoff({ requestId: request.id, kind: 'handoff', at: this.now(), text: request.text,
      projectId: decision.projectId, projectTitle: project?.title ?? '', pmSessionId: project?.pmSessionId ?? '',
      instruction: decision.instruction, rationale: decision.rationale, stage: 'refused', reason, detail, error: '' })
    this.audit.record({ actor: 'router', kind: 'session', action: 'routed', targetKind: 'project',
      targetId: decision.projectId, outcome: 'skipped', detail })
    return this.handoffOutcomeOf(this.consoleStore.routerHandoff(request.id)!)
  }

  /**
   * Write down that a handoff could not be delivered, and answer with the reason.
   *
   * The Project was there and the decision held, but the target was not able to take the work: a paused Project, a PM
   * without a Session, a PM whose authority was withdrawn or a PM an operator stopped. Nothing is sent and nothing is
   * brought back: the work waits for the person.
   */
  private recordHandoffFailure(request: RouterRequest, kind: 'handoff' | 'brief', decision: RouterHandoffDecision,
    reason: string, detail: string): RouterHandoffOutcome {
    const project = this.store.projects.get(decision.projectId)
    this.consoleStore.addRouterHandoff({ requestId: request.id, kind, at: this.now(), text: request.text,
      projectId: decision.projectId, projectTitle: project?.title ?? '', pmSessionId: project?.pmSessionId ?? '',
      instruction: decision.instruction, rationale: decision.rationale, stage: 'failed', reason, detail, error: '' })
    this.audit.record({ actor: 'router', kind: 'session', action: 'routed', targetKind: 'project',
      targetId: decision.projectId, outcome: 'failed', detail })
    return this.handoffOutcomeOf(this.consoleStore.routerHandoff(request.id)!)
  }

  /**
   * Whether a recorded handoff may still be decided again.
   *
   * A refusal sent nothing, so a decision that holds may follow it — the Router is told what was wrong and may correct
   * it. A delivery that was tried is a different matter: the work may have reached the PM, and it is never sent again.
   */
  private handoffMayRetry(row: RouterHandoffRow): boolean {
    return row.kind === 'handoff' && row.stage === 'refused'
  }

  /**
   * The Projects the handoff reads, as it reads them.
   *
   * The handoff may only be told about the Projects this control plane really holds, so it can never name one that does
   * not exist.
   */
  private handoffProjects(): RouterHandoffProject[] {
    return this.projects().map(project => ({ id: project.id, title: project.title, status: project.status }))
  }

  /** One handoff, as the console reads it. */
  private routerHandoffRecord(row: RouterHandoffRow): RouterHandoffRecord {
    const session = row.pmSessionId === '' ? undefined : this.sessions.get(row.pmSessionId)
    return { requestId: row.requestId, kind: row.kind === 'brief' ? 'brief' : 'handoff', at: row.at, text: row.text,
      projectId: row.projectId, projectTitle: row.projectTitle, pmSessionId: row.pmSessionId,
      ...(session === undefined ? {} : { pmStatus: session.status }), instruction: row.instruction,
      rationale: row.rationale, stage: row.stage as RouterHandoffStage, reason: row.reason, detail: row.detail,
      ...(row.error === '' ? {} : { error: row.error }) }
  }

  /** The handoffs the console shows: what became of the work the high-level Router gave to a Project's PM. */
  routerHandoffRecords(limit = ROUTER_HANDOFF_SHOWN): RouterHandoffRecord[] {
    return this.consoleStore.routerHandoffs({ limit, newest: true }).reverse().map(row => this.routerHandoffRecord(row))
  }

  /** The answer one recorded handoff gives. */
  private handoffOutcomeOf(row: RouterHandoffRow): RouterHandoffOutcome {
    const record = this.routerHandoffRecord(row)
    const project = row.projectId === '' ? undefined : { id: row.projectId, title: row.projectTitle }
    const pm = row.pmSessionId === '' ? undefined : { sessionId: row.pmSessionId, status: record.pmStatus ?? 'unknown' }
    const delivered = row.stage === 'assigned'
    return {
      outcome: delivered ? 'delivered' : row.stage === 'refused' ? 'refused'
        : row.stage === 'unconfirmed' ? 'unconfirmed' : 'failed',
      reason: row.reason, detail: row.detail,
      ...(project === undefined ? {} : { project }),
      ...(pm === undefined ? {} : { pm }),
      ...(row.instruction === '' ? {} : { instruction: row.instruction }),
      ...(row.rationale === '' ? {} : { rationale: row.rationale }),
    }
  }

  /**
   * Create a Project because a person asked for one.
   *
   * The person's own words decide whether this is such a request, and the model is not believed about it: a model that
   * says the person asked for a Project is answered with the words the person really wrote, and a request that does not
   * ask for one may not create one. Such a request may still become a Project — through the gate, which asks for the four
   * conditions and checks them — and the tool says so instead of creating one quietly.
   *
   * The request that names a Project that already exists is a request about that Project: a second Project with the same
   * name is not a new piece of work, it is the same one twice.
   *
   * One request is one Project in the domain as well: the Project of this request is the same one whether it was made
   * here or through the gate, and a request that already has one may only start its PM again — never a second Project.
   */
  async routerCreateProject(sessionId: string, requestId: string, title: string, goal: string): Promise<{
    project: { id: string; title: string; goal: string }
    pm: { sessionId: string; status: string } | { status: 'unconfirmed'; error: string }
  }> {
    this.requireToolSession(sessionId, 'router')
    const request = this.routerRequests.get(requestId)
    if (!request) throw new ToolCallError('invalid', 'This request is unknown or is too old')
    if (request.dispatchedTicket || request.management) throw new ToolCallError('invalid', 'This request already routed to another action')
    if (request.createdProject === undefined) {
      if (request.handoff !== undefined) throw new ToolCallError('invalid', 'This request already handed its work to a Project PM')
      if (request.proposal !== undefined) throw new ToolCallError('invalid', 'This request already carries a relay proposal')
      if (!explicitProjectRequest(request.text)) {
        throw new ToolCallError('invalid', 'This request does not ask for a Project. Use control_router_project_gate with the '
          + 'four conditions when the work really is several independent modules that can run in parallel.')
      }
      const existing = namedProject(request.text, this.gateProjects())
      if (existing !== undefined) {
        throw new ToolCallError('invalid', `This request names the Project 「${existing.title}」, which already exists; `
          + 'its work goes to its PM instead of to a second Project')
      }
      const project = this.createProjectFromHumanRequest(title, goal, request.text, 'router', undefined,
        this.requestTriggerId(request.id))
      request.createdProject = { id: project.id, title: project.title, goal: project.goal }
    }
    const project = request.createdProject
    if (project.title !== title || project.goal !== goal) {
      throw new ToolCallError('invalid', 'This request already created a Project')
    }
    try {
      const pm = await this.startProjectPm(project.id)
      return { project, pm: { sessionId: pm.sessionId, status: pm.status } }
    } catch (error) {
      return { project, pm: { status: 'unconfirmed', error: redact(messageOf(error)).slice(0, 200) } }
    }
  }

  /**
   * The Project Gate: may this request become a Project without a person asking for one?
   *
   * The decision is checked here and not believed: the four conditions have to hold, each on its own evidence, the
   * evidence has to be about the modules the decision names, and the decision has to quote the person's own request. A
   * refusal creates nothing at all — no Project, no PM, no Ticket, no Session — and leaves a record that says which
   * condition failed and why, so that a person may ask later.
   *
   * One request is one result. The record is written before anything is created and names the human request, so a
   * decision that already made a Project is answered with that Project instead of making a second one: a repeated call, a
   * call after a restart and a call whose receipt was lost all lead to the same Project. Two calls that arrive at the
   * same moment share one run, so the record is written once and the title and the goal are the ones of the first call.
   */
  async routerProjectGate(sessionId: string, requestId: string, input: unknown): Promise<ProjectGateOutcome> {
    this.requireToolSession(sessionId, 'router')
    const running = this.gateFlights.get(requestId)
    if (running !== undefined) return running
    let flight: Promise<ProjectGateOutcome>
    flight = this.runProjectGate(requestId, input).finally(() => {
      if (this.gateFlights.get(requestId) === flight) this.gateFlights.delete(requestId)
    })
    this.gateFlights.set(requestId, flight)
    return flight
  }

  /**
   * One run of the gate for one request.
   *
   * The request is looked up first: a request that is not in memory is unknown or too old, and the only thing that may
   * answer for it is the durable record of a decision that really ran — the receipt of that decision, and nothing new.
   */
  private async runProjectGate(requestId: string, input: unknown): Promise<ProjectGateOutcome> {
    const request = this.routerRequests.get(requestId)
    if (request === undefined) return this.replayGateOutcome(requestId)
    if (request.dispatchedTicket || request.management) {
      throw new ToolCallError('invalid', 'This request already routed to another action')
    }
    if (request.proposal !== undefined) {
      throw new ToolCallError('invalid', 'This request already carries a relay proposal')
    }
    // One request is one Project: a decision that already made one is answered with that Project.
    const created = this.consoleStore.createdProjectGate(request.id)
    if (created !== undefined) return this.projectGateOutcomeOf(created)
    if (request.handoff !== undefined) {
      throw new ToolCallError('invalid', 'This request already handed its work to a Project PM')
    }
    // A request that created a Project by the person's own words does not get a second one through the gate.
    if (request.createdProject !== undefined) {
      throw new ToolCallError('invalid', 'This request already created a Project')
    }
    let decision: ProjectGateDecision
    try {
      decision = readProjectGateDecision(input)
    } catch (error) {
      if (!(error instanceof ProjectGateError)) throw error
      const raw = typeof input === 'object' && input !== null && !Array.isArray(input)
        ? input as Record<string, unknown> : {}
      return this.recordGateRefusal(request, error.reason, error.message, [], [],
        typeof raw.title === 'string' ? raw.title.trim() : '', typeof raw.goal === 'string' ? raw.goal.trim() : '')
    }
    const verdict = evaluateProjectGate(decision, { text: request.text, projects: this.gateProjects() })
    if (!verdict.allowed) {
      return this.recordGateRefusal(request, verdict.reason, verdict.detail, verdict.conditions, verdict.modules,
        decision.title, decision.goal, verdict)
    }
    // The gate opened. The row is written before the Project is, so a control plane that dies in the middle leaves the
    // fact behind — and the same request leads to the same Project when it is tried again.
    const attempt = this.nextGateAttempt(request.id)
    this.consoleStore.addProjectGate({ requestId: request.id, attempt, at: this.now(), text: request.text,
      title: decision.title, goal: decision.goal, outcome: 'creating', reason: verdict.reason, detail: verdict.detail,
      conditions: JSON.stringify(verdict.conditions), modules: JSON.stringify(verdict.modules),
      failedCondition: '', existingProject: '', projectId: '', pmSessionId: '', pmStatus: '', error: '' })
    let project: ProjectProfile
    try {
      project = this.createProjectFromHumanRequest(decision.title, decision.goal, request.text, 'router', undefined,
        this.requestTriggerId(request.id))
    } catch (error) {
      const reason = redact(messageOf(error)).slice(0, 300)
      this.consoleStore.updateProjectGate(request.id, attempt, { outcome: 'failed', error: reason })
      this.audit.record({ actor: 'router', kind: 'project', action: 'gate-created', targetKind: 'project',
        targetId: request.id, outcome: 'failed', detail: reason })
      throw new ToolCallError('invalid', `The Project could not be created: ${reason}`)
    }
    // The Project of this request is the Project of this request: the request may not dispatch a second independent
    // Ticket or touch another Project afterwards.
    request.createdProject = { id: project.id, title: project.title, goal: project.goal }
    this.consoleStore.updateProjectGate(request.id, attempt, { projectId: project.id, pmSessionId: project.pmSessionId })
    let pm: { sessionId: string; status: string } | { status: 'unconfirmed'; error: string }
    let pmStatus = ''
    let pmError = ''
    try {
      const session = await this.startProjectPm(project.id)
      pm = { sessionId: session.sessionId, status: session.status }
      pmStatus = session.status
    } catch (error) {
      // The Project exists; only its PM did not come up. The record says so instead of claiming a PM that is not there.
      pmError = redact(messageOf(error)).slice(0, 200)
      pm = { status: 'unconfirmed', error: pmError }
      pmStatus = 'unconfirmed'
    }
    this.consoleStore.updateProjectGate(request.id, attempt, { outcome: 'created', pmStatus,
      ...(pmError === '' ? {} : { error: pmError }) })
    // The work brief: the request's own words, to the PM of the Project this request just created, and to nobody else.
    // The Router does not create Tickets for this Project — the brief asks its PM to do that itself.
    await this.publishProjectBrief(request, project, pmStatus === 'unconfirmed')
    this.audit.record({ actor: 'router', kind: 'project', action: 'gate-created', targetKind: 'project',
      targetId: project.id, outcome: pmStatus === 'unconfirmed' ? 'failed' : 'ok',
      detail: `${project.title} · 四项条件均成立` })
    return { outcome: 'created', reason: verdict.reason, detail: verdict.detail,
      project: { id: project.id, title: project.title, goal: project.goal }, pm,
      conditions: verdict.conditions, modules: verdict.modules }
  }

  /**
   * Publish the work brief of a Project the gate just created.
   *
   * The brief is the same request that passed the gate, including the work and its constraints. It goes to that PM and to
   * nobody else: no earlier messages, no files, no other Project. The Router creates no Ticket for it; the PM reads the
   * brief and decides what this Project needs.
   *
   * A person who asked for the Project to be created and to wait keeps the PM idle: the brief is not published, and the
   * record says why. A Project whose PM did not come up gets no brief either, and the record says that too.
   */
  private async publishProjectBrief(request: RouterRequest, project: ProjectProfile, pmUnconfirmed: boolean): Promise<void> {
    const brief = request.text
    if (createOnlyRequest(request.text)) {
      this.consoleStore.addRouterHandoff({ requestId: request.id, kind: 'brief', at: this.now(), text: request.text,
        projectId: project.id, projectTitle: project.title, pmSessionId: project.pmSessionId, instruction: brief,
        rationale: '本人明确只要创建项目并待命。', stage: 'refused', reason: 'create_only_request',
        detail: '本人明确只要创建项目并待命，没有派发工作 brief，PM 保持空闲。', error: '' })
      return
    }
    if (pmUnconfirmed) {
      this.consoleStore.addRouterHandoff({ requestId: request.id, kind: 'brief', at: this.now(), text: request.text,
        projectId: project.id, projectTitle: project.title, pmSessionId: project.pmSessionId, instruction: brief,
        rationale: '门禁放行后创建的项目，工作 brief 交给它自己的 PM。', stage: 'failed', reason: 'pm_unavailable',
        detail: '这个项目的 PM 没有确认启动，工作 brief 没有送出。', error: '' })
      return
    }
    // The brief is for this Project alone: it may not carry the name of another Project of this control plane.
    const others = mentionedProjects(brief, this.handoffProjects()).filter(item => item.id !== project.id)
    if (others.length > 0) {
      this.consoleStore.addRouterHandoff({ requestId: request.id, kind: 'brief', at: this.now(), text: request.text,
        projectId: project.id, projectTitle: project.title, pmSessionId: project.pmSessionId, instruction: brief,
        rationale: '门禁放行后创建的项目，工作 brief 交给它自己的 PM。', stage: 'refused', reason: 'cross_project',
        detail: `工作 brief 说到别的项目「${others[0]!.title}」，没有送出。`, error: '' })
      return
    }
    if (asksForIrreversible(brief) || asksForAuthority(brief)) {
      this.consoleStore.addRouterHandoff({ requestId: request.id, kind: 'brief', at: this.now(), text: request.text,
        projectId: project.id, projectTitle: project.title, pmSessionId: project.pmSessionId, instruction: brief,
        rationale: '', stage: 'refused', reason: 'scope_requires_review',
        detail: '这项工作涉及新的授权或不可逆操作，未自动交给项目 PM。', error: '' })
      return
    }
    const decision: RouterHandoffDecision = { projectId: project.id, instruction: brief,
      rationale: '门禁放行后创建的项目，工作 brief 交给它自己的 PM。' }
    const verdict: RouterHandoffVerdict = { allowed: true, reason: 'allowed',
      detail: '门禁放行后创建的项目，工作 brief 交给它自己的 PM。',
      project: { id: project.id, title: project.title }, instruction: brief }
    await this.deliverRouterHandoff(request, 'brief', decision, verdict)
  }

  /**
   * The receipt of a decision that really ran, when the request itself is gone.
   *
   * A request that is not in memory is unknown or too old, and only a durable record may answer for it: the record of a
   * decision that was carried out is the receipt of that decision, and it is answered without creating anything and
   * without sending a command to the node. A decision that was written down as "creating" and never finished is decided
   * by the domain: the Project of this request exists, or nothing was made. It is never made a second time.
   */
  private replayGateOutcome(requestId: string): ProjectGateOutcome {
    const rows = this.consoleStore.projectGatesOfRequest(requestId)
    if (rows.length === 0) throw new ToolCallError('invalid', 'This request is unknown or is too old')
    const row = rows[rows.length - 1]!
    if (row.outcome === 'created' && row.projectId !== '') return this.projectGateOutcomeOf(row)
    if (row.outcome !== 'creating') return this.projectGateOutcomeOf(row)
    // The control plane died in the middle of the creation. The domain decides the truth: the Project of this request
    // exists, or it does not.
    const project = this.store.projects.get(this.requestProjectId(requestId))
    if (project !== undefined) {
      const pm = this.sessions.get(project.pmSessionId)
      this.consoleStore.updateProjectGate(requestId, row.attempt, { outcome: 'created', projectId: project.id,
        pmSessionId: project.pmSessionId, pmStatus: pm?.status ?? 'unconfirmed',
        ...(pm === undefined ? { error: 'The PM Session of this Project was not confirmed.' } : {}) })
      const settled = this.consoleStore.projectGatesOfRequest(requestId).find(entry => entry.attempt === row.attempt)!
      return this.projectGateOutcomeOf(settled)
    }
    // Nothing can be confirmed: the decision is refused rather than carried out again.
    this.consoleStore.updateProjectGate(requestId, row.attempt, { outcome: 'failed',
      error: 'The control plane stopped while this Project was being created; it was not created again' })
    return { outcome: 'refused', reason: 'creation_unconfirmed',
      detail: '上一次判定在创建项目的途中停了，控制面无法确认项目是否存在，不会重新创建。', conditions: [], modules: [] }
  }

  /**
   * The Projects the gate reads, as it reads them.
   *
   * The gate asks whether a request names a Project that already exists, and it may only be told about the Projects this
   * control plane really holds.
   */
  private gateProjects(): ProjectGateProject[] {
    return this.projects().map(project => ({ id: project.id, title: project.title, status: project.status }))
  }

  /** The try of one request that comes next. */
  private nextGateAttempt(requestId: string): number {
    const rows = this.consoleStore.projectGatesOfRequest(requestId)
    return rows.length === 0 ? 1 : Math.max(...rows.map(row => row.attempt)) + 1
  }

  /**
   * Write down that the gate refused a decision, and answer with the refusal.
   *
   * Nothing is created: the refusal is a record and an answer, and the Project, the PM, the Ticket and the Session of the
   * refused decision stay as they were.
   */
  private recordGateRefusal(request: RouterRequest, reason: string, detail: string, conditions: ProjectGateFinding[],
    modules: ProjectGateModule[], title = '', goal = '', verdict?: ProjectGateVerdict): ProjectGateOutcome {
    const attempt = this.nextGateAttempt(request.id)
    this.consoleStore.addProjectGate({ requestId: request.id, attempt, at: this.now(), text: request.text,
      title, goal, outcome: 'refused', reason, detail,
      conditions: JSON.stringify(conditions), modules: JSON.stringify(modules),
      failedCondition: verdict?.failedCondition ?? '', existingProject: verdict?.existingProject
        ? JSON.stringify(verdict.existingProject) : '',
      projectId: '', pmSessionId: '', pmStatus: '', error: '' })
    this.audit.record({ actor: 'router', kind: 'project', action: 'gate-refused', targetKind: 'project',
      targetId: request.id, outcome: 'skipped', detail })
    return { outcome: 'refused', reason, detail, conditions, modules,
      ...(verdict?.failedCondition === undefined ? {} : { failedCondition: verdict.failedCondition }),
      ...(verdict?.existingProject === undefined ? {} : { existingProject: verdict.existingProject }) }
  }

  /**
   * The decisions of the Project Gate, as the console reads them.
   *
   * A record is a fact about one decision: the human request it was made for, the four findings and the modules, the
   * reason, and the Project and the PM when the gate let one through. A refusal is a record too.
   */
  projectGateRecords(limit = PROJECT_GATE_SHOWN): ProjectGateRecord[] {
    return this.consoleStore.projectGates({ limit, newest: true }).reverse().map(row => this.projectGateRecord(row))
  }

  /** One decision of the gate, as the console reads it. */
  private projectGateRecord(row: ProjectGateRow): ProjectGateRecord {
    const conditions = parseGateFindings(row.conditions)
    const modules = parseGateModules(row.modules)
    const existing = parseGateProject(row.existingProject)
    return { requestId: row.requestId, attempt: row.attempt, at: row.at, text: row.text, title: row.title, goal: row.goal,
      outcome: row.outcome, reason: row.reason, detail: row.detail, conditions, modules,
      ...(row.failedCondition === '' ? {} : { failedCondition: row.failedCondition as ProjectGateCondition }),
      ...(existing === undefined ? {} : { existingProject: existing }),
      ...(row.projectId === '' ? {} : { projectId: row.projectId }),
      ...(row.pmSessionId === '' ? {} : { pmSessionId: row.pmSessionId }),
      ...(row.pmStatus === '' ? {} : { pmStatus: row.pmStatus }),
      ...(row.error === '' ? {} : { error: row.error }) }
  }

  /** The answer one recorded decision gives, when it is asked for again. */
  private projectGateOutcomeOf(row: ProjectGateRow): ProjectGateOutcome {
    const record = this.projectGateRecord(row)
    if (row.outcome !== 'created' || row.projectId === '') {
      return { outcome: 'refused', reason: record.reason, detail: record.detail, conditions: record.conditions,
        modules: record.modules,
        ...(record.failedCondition === undefined ? {} : { failedCondition: record.failedCondition }),
        ...(record.existingProject === undefined ? {} : { existingProject: record.existingProject }) }
    }
    const project = this.store.projects.get(row.projectId)
    const pm = row.pmStatus === 'unconfirmed'
      ? { status: 'unconfirmed' as const, error: row.error }
      : { sessionId: row.pmSessionId, status: row.pmStatus }
    return { outcome: 'created', reason: record.reason, detail: record.detail,
      project: { id: row.projectId, title: project?.title ?? row.title, goal: project?.goal ?? row.goal }, pm,
      conditions: record.conditions, modules: record.modules }
  }

  routerDispatch(sessionId: string, requestId: string, title: string, goal: string):
    { ticket: ConsoleTicket; worker?: { sessionId: string; status: string } } {
    this.requireToolSession(sessionId, 'router')
    const request = this.routerRequests.get(requestId)
    if (!request) throw new ToolCallError('invalid', 'This request is unknown or is too old')
    if (request.createdProject || request.proposal || request.management || request.handoff) {
      throw new ToolCallError('invalid', 'This request already routed to another action')
    }
    const dispatched = request.dispatchedTicket
    if (dispatched !== undefined && (dispatched.title !== title || dispatched.goal !== goal)) {
      throw new ToolCallError('invalid', 'This request already dispatched a different Ticket')
    }
    const ticketId = this.dispatchStandaloneForRequest(request, title, goal)
    return this.routerTicketResult(this.requireStandaloneTicket(ticketId))
  }

  /**
   * The standalone Ticket one request names, created once.
   *
   * The Router's own dispatch tool and the Fast Router both come through here, so one request is one Ticket: a second
   * attempt finds the Ticket the first one made instead of making another. The domain's own idempotency holds it too —
   * the Trigger carries the request id, so a control plane that was restarted between the two attempts ends up with the
   * same Ticket and not a second one.
   */
  private dispatchStandaloneForRequest(request: RouterRequest, title: string, goal: string): string {
    if (request.dispatchedTicket !== undefined) return request.dispatchedTicket.id
    this.requireNodeOnline()
    const id = request.id
    const trigger: Trigger = { id, source: PROJECT_REQUEST_SOURCE, threads: [{ source: PROJECT_REQUEST_SOURCE, id }],
      actor: { source: PROJECT_REQUEST_SOURCE, id: PROJECT_REQUEST_ACTOR }, human: true, at: request.at,
      text: request.text, meta: { title, goal } }
    const ticketId = this.store.atomic(() => {
      this.engine.recordTriggerForRouting(trigger)
      const decided = this.engine.decide(id, { kind: 'accept', title, scope: goal, acknowledgement: goal,
        reason: { code: 'explicitRouted' } })
      if (!decided.ticketId) throw new ToolCallError('invalid', 'The request did not create a Ticket')
      return decided.ticketId
    })
    request.dispatchedTicket = { id: ticketId, title, goal }
    this.audit.record({ actor: 'router', kind: 'ticket', action: 'created', targetKind: 'ticket',
      targetId: ticketId, detail: title })
    return ticketId
  }

  private requireStandaloneTicket(ticketId: string): Ticket {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || ticket.projectId !== undefined) throw new ToolCallError('invalid', `Unknown standalone Ticket ${ticketId}`)
    return ticket
  }

  private routerTicketResult(ticket: Ticket): { ticket: ConsoleTicket; worker?: { sessionId: string; status: string } } {
    const assignment = latestAssignment(ticket)
    const worker = assignment ? this.sessions.get(this.workerSessionFor(assignment.id)) : undefined
    return { ticket: this.consoleTicket(ticket),
      ...(worker === undefined ? {} : { worker: { sessionId: worker.sessionId, status: worker.status } }) }
  }

  pmReportProject(sessionId: string, summary: string): { projectId: string; report: ProjectReport } {
    const { project } = this.requireProject(sessionId)
    if (project.status === 'archived' || project.status === 'ended') {
      throw new ToolCallError('invalid', `This Project is ${project.status}`)
    }
    const duplicate = project.latestReport?.summary === summary
    const updated = duplicate ? project : this.engine.projectReport(project.id, summary)
    const report = updated.latestReport!
    if (!duplicate) {
      this.audit.record({ actor: 'pm', kind: 'project', action: 'reported', targetKind: 'project',
        targetId: project.id, detail: project.title })
    }
    const idempotencyKey = `project-report:${key(project.id, report.at, report.summary)}`
    void this.ensureRouter().then(() =>
      this.sendMessage(ROUTER_SESSION_ID, routerProjectReportMessage(updated, report), undefined, 'system',
        { idempotencyKey })
    ).catch(() => { /* The report remains available from the Project and Router summary. */ })
    return { projectId: project.id, report }
  }

  routerManage(sessionId: string, requestId: string, action: RouterManagement, targetId: string, text?: string):
    Promise<unknown> {
    this.requireToolSession(sessionId, 'router')
    const request = this.routerRequests.get(requestId)
    if (!request) throw new ToolCallError('invalid', 'This request is unknown or is too old')
    if (request.createdProject || request.proposal || request.dispatchedTicket || request.handoff) {
      throw new ToolCallError('invalid', 'This request already routed to another action')
    }
    const fingerprint = JSON.stringify([action, targetId, text])
    if (request.management) {
      if (request.management.fingerprint === fingerprint) return request.management.work
      throw new ToolCallError('invalid', 'This request already started another management action')
    }
    const work = this.manageFromRouter(action, targetId, text)
    request.management = { fingerprint, work }
    return work
  }

  private async manageFromRouter(action: RouterManagement, targetId: string, text?: string): Promise<unknown> {
    if (action === 'archive_project') return this.archiveProject(targetId)
    if (action === 'unarchive_project') return { project: this.unarchiveProject(targetId) }
    return this.withTicketOperation(targetId, async () => {
      const ticket = this.requireStandaloneTicket(targetId)
      if (action === 'message_ticket') {
        if (!text) throw new ToolCallError('invalid', 'A message needs text')
        // A standalone Ticket belongs to no Project, so it has no PM to ask: the message goes to its own Worker, with the
        // same delivery semantics every other message to a Worker has.
        const result = this.engine.messageTicketTo(ticket.id, text, {
          standalone: true,
          // The message is an Input of its own: two messages the Router was asked to send are two Inputs, even when their
          // words are the same.
          inputId: key('input', ticket.id, 'note', 'router', randomUUID()),
        })
        const assignment = latestAssignment(result.ticket)
        const delivery = assignment === undefined
          ? { delivered: result.delivered }
          : await this.confirmTicketDelivery(assignment.id, result.inputId, result.delivered)
        return { ...this.routerTicketResult(result.ticket), delivery: delivery.delivered,
          ...(delivery.error === undefined ? {} : { error: delivery.error }) }
      }
      if (action === 'stop_ticket') {
        const stop = await this.stopStandaloneTicket(ticket, text ?? 'Stopped by the operator through Router')
        return { ...this.routerTicketResult(this.requireStandaloneTicket(ticket.id)), ...stop }
      }
      const assignment = latestAssignment(ticket)
      if (!assignment || !canRetry(ticket) || ticket.manualStop) {
        throw new ToolCallError('invalid', `Ticket ${ticket.id} has no retryable Assignment`)
      }
      await this.requireConfirmedStop(ticket)
      const sessionId = this.workerSessionFor(assignment.id)
      if (this.sessions.has(sessionId)) await this.cancelSession(sessionId, 'Retrying a stalled Worker', 'router')
      const retried = this.engine.retryTicket(ticket.id, assignment.id)
      return this.routerTicketResult(retried)
    })
  }

  private async stopStandaloneTicket(ticket: Ticket, reason: string): Promise<{ stopped: boolean; error?: string }> {
    const assignment = latestAssignment(ticket)
    const cleanups: { ticketId: string; work: Promise<void> }[] = []
    if (!ticket.ended) this.engine.stopTicket(ticket.id, reason, cleanups)
    const cleanup = cleanups[0]?.work
    const sessionId = assignment && this.workerSessionFor(assignment.id)
    const work = cleanup ?? (sessionId && this.sessions.has(sessionId)
      ? this.cancelSession(sessionId, reason, 'system') : undefined)
    if (!work) return { stopped: true }
    const result = await this.settleStopWork(work)
    if (result.state === 'stopped') return { stopped: true }
    const error = result.state === 'pending' ? 'The node has not confirmed that the Worker stopped' : result.error
    return { stopped: false, error: redact(error).slice(0, 200) }
  }

  /**
   * Confirm one proposal: a person says yes, and the instruction really reaches the Project's PM.
   *
   * The proposal is taken before anything is awaited, so two confirmations of the same proposal cannot both send it:
   * the second one finds it taken and is refused. The Project and its PM are checked again here, because the domain may
   * have moved on since the proposal was made: a Project that ended, an archived Project or a revoked PM Session means
   * the instruction is not sent at all.
   *
   * The answer says what really happened. A proposal that was already sent cannot be sent again, and one that was
   * cancelled or that waited too long is refused with the reason.
   */
  async confirmRouterProposal(proposalId: string): Promise<{ delivered: boolean; proposal: RouterProposalView }> {
    const found = this.routerRequests.find(proposalId)
    if (found === undefined) throw new OperatorError(404, 'There is no such proposal')
    const proposal = this.routerRequests.claim(proposalId)
    if (proposal === undefined) {
      throw new OperatorError(409, routerProposalRefusal(found))
    }
    const project = this.routerProjectFor(proposal)
    try {
      await this.sendMessage(project.pmSessionId, routerInstructionMessage(proposal.requestId, proposal.instruction),
        undefined, 'system')
    } catch (error) {
      this.routerRequests.fail(proposal)
      this.audit.record({ actor: 'operator', kind: 'session', action: 'relayed', targetKind: 'project',
        targetId: project.id, outcome: 'failed', detail: `${project.title} · ${proposal.instruction.length} 字` })
      throw new OperatorError(502, `The PM Session of this Project could not be reached: ${
        redact(messageOf(error)).slice(0, 200)}`)
    }
    this.routerRequests.confirm(proposal)
    this.audit.record({ actor: 'operator', kind: 'session', action: 'relayed', targetKind: 'project',
      targetId: project.id, detail: `${project.title} · ${proposal.instruction.length} 字` })
    return { delivered: true, proposal: routerProposalView(proposal) }
  }

  /**
   * The Project a proposal may still be delivered to, checked again at the moment of the confirmation.
   *
   * A target that is gone kills the proposal instead of leaving it waiting: the person is told that nothing was sent,
   * and the proposal does not wait for a second confirmation that could not work either.
   */
  private routerProjectFor(proposal: RouterProposal): ProjectProfile {
    try {
      return this.requireRouterProject(proposal.projectId)
    } catch (error) {
      this.routerRequests.fail(proposal)
      this.audit.record({ actor: 'operator', kind: 'session', action: 'proposal', targetKind: 'project',
        targetId: proposal.projectId, outcome: 'failed', detail: `${proposal.projectTitle} · 目标已不可用` })
      throw error
    }
  }

  /**
   * Cancel one proposal: nothing is sent.
   *
   * A proposal that is already on its way cannot be unsent, so it is refused rather than pretended to be cancelled.
   */
  async cancelRouterProposal(proposalId: string): Promise<{ cancelled: boolean; proposal: RouterProposalView }> {
    const found = this.routerRequests.find(proposalId)
    if (found === undefined) throw new OperatorError(404, 'There is no such proposal')
    const proposal = this.routerRequests.cancel(proposalId)
    if (proposal === undefined) {
      throw new OperatorError(409, routerProposalRefusal(found))
    }
    this.audit.record({ actor: 'operator', kind: 'session', action: 'proposal-cancelled', targetKind: 'project',
      targetId: proposal.projectId, detail: proposal.projectTitle })
    return { cancelled: true, proposal: routerProposalView(proposal) }
  }

  /**
   * The Project a Router proposal may name: it must exist, still be active, and still have its own PM Session.
   *
   * The check is made twice — when the Router proposes and again when a person confirms — because the domain moves on
   * between the two, and a proposal must never deliver to a Project that is over or to a PM whose authority was taken
   * away.
   */
  private requireRouterProject(projectId: string): ProjectProfile {
    const project = this.store.projects.get(projectId)
    if (!project) throw new OperatorError(400, `Unknown Project ${projectId}`)
    if (project.status === 'ended' || project.status === 'archived') {
      throw new OperatorError(400, `This Project is ${project.status}; it has no PM to instruct`)
    }
    const pm = this.sessions.get(project.pmSessionId)
    if (!pm) throw new OperatorError(400, 'This Project has no PM Session')
    if (pm.revokedAt) throw new OperatorError(400, 'The PM Session of this Project was revoked')
    if (pm.role !== 'pm' || pm.projectId !== project.id) {
      throw new OperatorError(400, 'The PM Session of this Project does not belong to it')
    }
    return project
  }

  /** Whether the Router is connected: its Session exists and the node confirmed it. */
  private routerAvailable(): boolean {
    const record = this.sessions.get(ROUTER_SESSION_ID)
    return record !== undefined && isNodeConfirmed(record.status)
  }

  /**
   * Verify a Session token and that it still names a live Session record.
   *
   * `verifySessionToken` proves the signature, version and expiry with the kernel's own secret. The record comparison
   * proves the claims still describe a Session this kernel owns, so a token minted for a replaced Session cannot be
   * replayed against another one. Only a verified token reaches the tool methods below; no tool argument is authority.
   *
   * The token generation must match the record's current `tokenVersion`. `allowPrevious` additionally accepts the one
   * generation before it, which is the narrow grace the refresh route needs: an already retired token may rotate itself
   * once, but it can never open an ordinary tool route.
   *
   * `allowExpiredSeconds` is passed by the refresh route alone (with the kernel's configured
   * `tokenRefreshGraceSeconds`). An ordinary caller omits it, so a token past its `exp` is always 401 there even when the
   * same token could still refresh itself. The refusal message never contains the token.
   */
  verifyToolToken(token: string, options: { allowPrevious?: boolean; allowExpiredSeconds?: number } = {}): SessionTokenClaims {
    const claims = verifySessionToken(token, this.options.secret, undefined,
      options.allowExpiredSeconds === undefined ? {} : { allowExpiredSeconds: options.allowExpiredSeconds })
    const record = this.sessions.get(claims.sid)
    if (!record) throw new ToolCallError('unauthenticated', 'The Session token does not name a known Session')
    if (record.projectId !== claims.pid || record.role !== claims.role || record.assignmentId !== claims.aid) {
      throw new ToolCallError('unauthenticated', 'The Session token does not match its Session record')
    }
    // A revoked Session has no authority left, whatever its token says: the revocation is a fact about the Session, not
    // about one credential, so neither a fresh token nor an old one may open a route.
    if (record.revokedAt) {
      throw new ToolCallError('unauthenticated', 'The Session was revoked; its token opens nothing')
    }
    // A Session an operator stopped opens no tool route, and no refresh either: the stop is a fact about the Session,
    // not about one credential. The token may still be valid, but the Session it names is not running.
    if (this.operatorStopRefusal(record)) {
      throw new ToolCallError('forbidden', 'The Session was stopped by an operator; it opens nothing until it is resumed')
    }
    const current = record.tokenVersion ?? 0
    if (claims.tv !== current && !(options.allowPrevious === true && claims.tv === current - 1)) {
      throw new ToolCallError('unauthenticated', 'The Session token has been superseded by a refresh')
    }
    return claims
  }

  /**
   * Retire the Session's current token and issue the next generation.
   *
   * The record's `tokenVersion` advances and is persisted before the new token exists, so a restart cannot resurrect an
   * old token. The superseded token remains the one previous generation: it can call this method once more through the
   * refresh route, but every ordinary tool route already refuses it. The generation is part of the signed claims, so a
   * refresh within the same second still produces a different token.
   */
  refreshToolToken(sessionId: string): string {
    const record = this.sessions.get(sessionId)
    if (!record) throw new ToolCallError('unauthenticated', 'The Session token does not name a known Session')
    // A revoked Session may not rotate itself into a fresh credential: the revocation outlasts every token it ever had.
    if (record.revokedAt) {
      throw new ToolCallError('unauthenticated', 'The Session was revoked; its token cannot be refreshed')
    }
    // A Session an operator stopped may not rotate itself either: the refresh is the one route that still accepts a
    // token one generation behind, so it is the one route a stop has to close explicitly.
    if (this.operatorStopRefusal(record)) {
      throw new ToolCallError('forbidden', 'The Session was stopped by an operator; its token cannot be refreshed')
    }
    record.tokenVersion = (record.tokenVersion ?? 0) + 1
    this.persist(record)
    const token = this.issueToken(record)
    this.tokens.set(sessionId, token)
    return token
  }

  /**
   * Create Tickets in the caller's own Project.
   *
   * The Session, not the request body, names the Project: a PM Session only manages the Project whose `pmSessionId` it
   * is, and the Engine's own `notProjectPm` check is the second line of defense behind this one.
   */
  pmCreateTickets(sessionId: string, tasks: readonly ProjectTicketTask[]): Ticket[] {
    const record = this.requireToolSession(sessionId, 'pm')
    const project = this.store.projects.get(record.projectId)
    if (!project) throw new ToolCallError('invalid', `Unknown Project ${record.projectId}`)
    if (project.pmSessionId !== sessionId) {
      throw new ToolCallError('forbidden', 'Only this Project\'s PM Session may create its Tickets')
    }
    const tickets = this.engine.createProjectTickets(project.id, sessionId, tasks)
    // The PM's own dispatch of work: one entry per Ticket it created, with the Ticket's own title and nothing else.
    this.auditTicketsCreated(project, tickets)
    return tickets
  }

  /** The PM's own dispatch of work, as the audit trail records it: one entry per Ticket it created. */
  private auditTicketsCreated(project: ProjectProfile, tickets: readonly Ticket[]): void {
    for (const ticket of tickets) {
      this.audit.record({ actor: 'pm', kind: 'ticket', action: 'created', targetKind: 'ticket', targetId: ticket.id,
        detail: `${project.title} · ${ticket.title}` })
    }
  }

  /**
   * The read-only Project and Ticket context of the caller's own Project.
   *
   * A PM's first turn has to see the Project it manages and the Tickets already created in it; no other tool gives the
   * node that view. The Session record, not an argument, names the Project, and a PM Session that is not the Project's
   * own is refused. Only safe fields cross the boundary: neither the Mandate, the token, nor any internal actor is
   * included, and a Ticket of another Project never appears.
   *
   * Each Ticket carries its current Assignment and that Assignment's own last report, plus the facts a PM needs to
   * decide what to do next: the open question a Worker asked a person, a failed delivery, a failed stop, and the stop
   * that keeps a new Assignment from starting.
   */
  pmContext(sessionId: string): PmContext {
    const { project } = this.requireProject(sessionId)
    const tickets = this.tickets().filter(ticket => ticket.projectId === project.id).map(ticket => this.pmTicketCard(ticket))
    const memory = this.projectMemory(project.id, PROJECT_MEMORY_LIMIT)
    // The PM is the logical superior of the Workers of its own Project, so it reads the notices about them.
    const stops = this.stopNotices({ superiorKind: 'pm', superiorId: sessionId, limit: PROJECT_STOP_NOTICE_LIMIT })
    return {
      project: { id: project.id, title: project.title, goal: project.goal, status: project.status,
        ...(project.pauseMode === undefined ? {} : { pauseMode: project.pauseMode }),
        ...(project.latestReport === undefined ? {} : { latestReport: project.latestReport }) },
      tickets,
      ...(memory.length === 0 ? {} : { memory: memory.map(entry => ({ at: entry.at, actor: entry.actor, text: entry.text })) }),
      ...(stops.length === 0 ? {} : { stops }),
    }
  }

  /**
   * One Ticket as the PM reads it: its current Assignment and that Assignment's own last report, plus the facts a PM
   * needs to decide what to do next — the open question a Worker asked a person, a failed delivery, a failed stop, and
   * the stop that keeps a new Assignment from starting.
   */
  private pmTicketCard(ticket: Ticket): PmContextTicket {
    const card: PmContextTicket = { id: ticket.id, title: ticket.title, status: pmTicketStatus(ticket) }
    const assignment = latestAssignment(ticket)
    if (assignment !== undefined) {
      const current: PmContextAssignment = { id: assignment.id, state: assignment.state,
        sessionId: this.workerSessionFor(assignment.id) }
      if (assignment.report !== undefined) current.report = assignment.report
      card.assignment = current
    }
    const review = currentReview(ticket)
    if (review !== undefined) {
      card.review = { id: review.id, state: review.state, assignmentId: review.assignmentId, at: review.at,
        ...(review.summary === undefined ? {} : { summary: review.summary }),
        ...(review.reason === undefined ? {} : { reason: review.reason }),
        ...(review.decidedAt === undefined ? {} : { decidedAt: review.decidedAt }) }
    }
    if (ticket.attention !== undefined) card.attention = { question: ticket.attention.question }
    if (ticket.delivery !== undefined) card.delivery = { error: ticket.delivery.error, at: ticket.delivery.at }
    if (ticket.stopFailure !== undefined) card.stopFailure = { at: ticket.stopFailure.at, error: ticket.stopFailure.error }
    if (ticket.stopPending !== undefined) {
      card.stopPending = { at: ticket.stopPending.at, assignmentId: ticket.stopPending.assignmentId }
    }
    if (ticket.manualStop !== undefined) {
      card.manualStop = { scope: ticket.manualStop.scope, at: ticket.manualStop.at, by: ticket.manualStop.by }
    }
    const notification = this.pmNotificationsByTicket.get(ticket.id)
    if (notification !== undefined) card.pmNotification = notification
    return card
  }

  /**
   * The PM's coordination message to the Worker of one of its own Tickets.
   *
   * The message goes through the Engine's own path (`messageTicket`), so it is stored as a Ticket Input and reaches the
   * current Assignment only: a Worker a later Assignment replaced never sees it, and a Ticket whose Worker is not running
   * keeps the message queued instead of delivering it to nobody. An `assignmentId` the caller names must still be the
   * Ticket's current Assignment, so a stale Assignment cannot carry a message into a newer Worker.
   */
  pmMessageWorker(sessionId: string, ticketId: string, text: string, assignmentId?: string):
    { delivered: TicketMessageDelivery; ticket: Ticket } {
    const { project } = this.requireProject(sessionId)
    const ticket = this.requireProjectTicket(project, ticketId)
    if (assignmentId !== undefined) this.requireCurrentAssignment(ticket, assignmentId)
    // The Assignment is checked again inside the transaction that stores the message: a re-dispatch that happens at the
    // same moment cannot slip between the check above and the write below.
    const result = this.engine.messageTicketTo(ticketId, text, assignmentId === undefined ? {} : { assignmentId })
    return { delivered: result.delivered, ticket: result.ticket }
  }

  /**
   * The PM's request to stop the Worker of one of its own Tickets.
   *
   * The stop goes through the domain (`stopProjectWorker`), which ends the Assignment, records the stop on the Ticket and
   * asks the Executor to stop the Worker's Session. Only the remote Session is never enough: the Assignment ends in the
   * Store, so no second Worker starts over the stopped one and the Ticket reads as stopped.
   *
   * The node's own stop is awaited, so a node that refused or could not reach the Worker is reported to the PM instead of
   * a silent success: `stopped` says whether the Session really stopped, and `error` carries the reason.
   *
   * The answer names the Assignment the stop applied to, never a newer one: a re-dispatch that arrives while the stop runs
   * waits for it (see `withTicketOperation`) instead of taking the Assignment's place. A stop the node did not confirm
   * leaves the Ticket's failure in place and blocks every later re-dispatch, until a later stop confirms it.
   */
  async pmCancelWorker(sessionId: string, ticketId: string, assignmentId: string | undefined, reason?: string):
    Promise<PmCancelResult> {
    const { project } = this.requireProject(sessionId)
    this.requireProjectTicket(project, ticketId)
    return this.withTicketOperation(ticketId, async (): Promise<PmCancelResult> => {
      const ticket = this.store.tickets.get(ticketId)
      if (!ticket) throw new ToolCallError('invalid', `Unknown ticket ${ticketId}`)
      const latest = latestAssignment(ticket)
      if (!latest) throw new ToolCallError('invalid', `Ticket ${ticketId} has no Assignment`)
      const target = this.stopTarget(ticket, latest, assignmentId)
      // An Assignment that ended and whose stop the node confirmed needs no second stop: it is already gone.
      if (target.state === 'ended' && !this.stopUnconfirmed(ticket, target.id)) {
        return { ticket, assignment: target, stopped: true }
      }
      const outcome = await this.performStop(project, ticketId, target,
        { ...(reason ? { reason } : {}), reconfirm: target.state === 'ended' })
      const current = this.store.tickets.get(ticketId) ?? ticket
      const assignment = current.assignments.find(item => item.id === target.id) ?? target
      return { ticket: current, assignment, stopped: outcome.stopped, ...(outcome.error ? { error: outcome.error } : {}) }
    })
  }

  /**
   * The PM's explicit request for a new Assignment on one of its own Tickets.
   *
   * Which rule applies is the domain's, not the tool's: a Ticket whose Worker the Project stopped — by a hard pause or by
   * the PM's own cancel — is revived (`reviveProjectTicket`), and a Ticket whose Worker stalled is retried. Both keep the
   * Ticket's Mandate and worktree and start exactly one new Assignment, so a Ticket is never dispatched twice.
   *
   * The old Worker is stopped and confirmed before its replacement starts. A stalled Worker that still runs is stopped
   * here and the node's confirmation is awaited, so the two never overlap; a stop the node did not confirm blocks the
   * request instead of starting a Worker over one that may still run.
   *
   * A Ticket a person stopped is refused: only a person may approve that Worker's resume. A Ticket whose Worker is still
   * working is refused too, because it needs no new Assignment. A request that names an Assignment must name the current
   * one, so a stale request starts no new attempt.
   */
  async pmRequestAssignment(sessionId: string, ticketId: string, assignmentId?: string):
    Promise<{ ticket: Ticket; assignment: Assignment; rule: 'revived' | 'retried' }> {
    const { project } = this.requireProject(sessionId)
    this.requireProjectTicket(project, ticketId)
    return this.withTicketOperation(ticketId, async (): Promise<{ ticket: Ticket; assignment: Assignment;
      rule: 'revived' | 'retried' }> => {
      const ticket = this.store.tickets.get(ticketId)
      if (!ticket) throw new ToolCallError('invalid', `Unknown ticket ${ticketId}`)
      if (ticket.manualStop?.scope === 'worker') {
        throw new ToolCallError('forbidden', 'A person stopped this Worker; only a person may approve its resume')
      }
      const latest = latestAssignment(ticket)
      if (!latest) throw new ToolCallError('invalid', `Ticket ${ticketId} has no Assignment`)
      if (assignmentId !== undefined && assignmentId !== latest.id) {
        throw new ToolCallError('invalid', `Assignment ${assignmentId} is not current for Ticket ${ticketId}`)
      }
      // The previous Worker must be gone before its replacement starts; a stop the node did not confirm blocks this.
      await this.requireConfirmedStop(ticket)
      const current = this.store.tickets.get(ticketId) ?? ticket
      const active = latestAssignment(current)
      // A Worker the Project stopped: revive it under the same Mandate and worktree.
      if (current.manualStop?.scope === 'project') {
        const revived = this.engine.reviveProjectTicket(project.id, project.pmSessionId, ticketId)
        return { ticket: revived, assignment: latestAssignment(revived)!, rule: 'revived' }
      }
      if (active && active.state !== 'ended') {
        // A stalled Worker that still runs: it is stopped here and the node's confirmation is awaited, so its
        // replacement never overlaps it. The old plugin's own retry path is untouched.
        if (!canRetry(current)) {
          throw new ToolCallError('invalid', `Ticket ${ticketId} has no stopped or stalled Worker to replace`)
        }
        const stopped = await this.performStop(project, ticketId, active, { reason: 'The PM replaced a stalled Worker' })
        if (!stopped.stopped) {
          throw new ToolCallError('invalid', `The Worker of Ticket ${ticketId} could not be stopped `
            + `(${stopped.error ?? 'the node did not confirm the stop'}); no new Assignment was started. Stop that Worker `
            + 'again and wait for the confirmation before asking for a new Assignment.')
        }
        const revived = this.engine.reviveProjectTicket(project.id, project.pmSessionId, ticketId)
        return { ticket: revived, assignment: latestAssignment(revived)!, rule: 'retried' }
      }
      if (!canRetry(current)) {
        throw new ToolCallError('invalid', `Ticket ${ticketId} has no stopped or stalled Worker to replace`)
      }
      const retried = this.engine.retryTicket(ticketId)
      return { ticket: retried, assignment: latestAssignment(retried)!, rule: 'retried' }
    })
  }

  /**
   * The PM's decision about a Worker's result: accept it, or reject it with a reason.
   *
   * The decision names the review it is about, and the decision is the domain's: the Ticket's own review says which
   * Assignment produced the result, so a decision never applies to another Assignment's work, and a Ticket of another
   * Project is unknown to the caller. An acceptance ends the Ticket as `completed`; a rejection keeps the Ticket open,
   * records the reason and sends it back to the same Assignment as a revision request, without starting a second Worker
   * beside it.
   *
   * The decision is serialized with the PM's other operations on that Ticket, so a cancel, a re-dispatch and a review
   * never overlap: the second waits for the first and reads the state the first left. A repeated decision answers with
   * the same result instead of contradicting it, and a decision about a round a newer one replaced answers as it was made
   * and changes nothing.
   */
  async pmReview(sessionId: string, ticketId: string, assignmentId: string, decision: PmReviewDecision): Promise<PmReviewResult> {
    const { project } = this.requireProject(sessionId)
    this.requireProjectTicket(project, ticketId)
    if (decision.action !== 'accept' && decision.action !== 'reject') {
      throw new ToolCallError('invalid', 'A review is either an acceptance or a rejection')
    }
    const reviewId = typeof decision.reviewId === 'string' ? decision.reviewId.trim() : ''
    if (!reviewId) throw new ToolCallError('invalid', 'A decision names the review it is about')
    if (decision.action === 'reject' && !decision.reason?.trim()) {
      throw new ToolCallError('invalid', 'A rejection needs a reason the Worker can act on')
    }
    return this.withTicketOperation(ticketId, async (): Promise<PmReviewResult> => {
      if (decision.action === 'accept') {
        const ticket = this.engine.acceptProjectReview(project.id, sessionId, ticketId, assignmentId, reviewId)
        this.audit.record({ actor: 'pm', kind: 'review', action: 'accepted', targetKind: 'ticket', targetId: ticketId,
          detail: `${project.title} · ${ticket.title}` })
        return { ticket, review: this.reviewOf(ticket, reviewId) }
      }
      const rejected = this.engine.rejectProjectReview(project.id, sessionId, ticketId, assignmentId, reviewId,
        decision.reason!.trim())
      this.audit.record({ actor: 'pm', kind: 'review', action: 'rejected', targetKind: 'ticket', targetId: ticketId,
        detail: `${project.title} · ${rejected.ticket.title}` })
      // The revision request goes out to the node; a node that refused it is reported, never hidden.
      const error = await this.revisionFailure(ticketId, assignmentId, rejected.revisionInputId)
      return { ticket: rejected.ticket, review: this.reviewOf(rejected.ticket, reviewId),
        ...(rejected.delivered === undefined ? {} : { delivered: rejected.delivered }),
        ...(error === undefined ? {} : { error }) }
    })
  }

  /**
   * The PM's read of the code differences behind a review.
   *
   * The read itself happens on the node, in the workspace that node bound to the Project: the control plane never runs
   * Git and never names a directory, and the command it sends carries the Project id and nothing else. What the control
   * plane does is bind the request to the review the PM named — the Ticket must be the PM's own, the review must be the
   * one still waiting for a decision, and it must be about the Assignment the caller named — so one Project's PM can
   * never read another Project's work.
   *
   * The answer is a snapshot, and it says so: a Project's Workers share one directory, so the diff shows every change
   * in it and cannot show which Worker made one. The diff text is fenced and handed over as data.
   */
  async pmReviewDiff(sessionId: string, ticketId: string, reviewId: string, assignmentId: string): Promise<PmReviewDiff> {
    const { project } = this.requireProject(sessionId)
    const ticket = this.requireProjectTicket(project, ticketId)
    const review = ticket.reviews?.find(item => item.id === reviewId)
    if (!review) throw new ToolCallError('invalid', `Unknown review ${reviewId} for Ticket ${ticketId}`)
    if (review.assignmentId !== assignmentId) {
      throw new ToolCallError('invalid', `The review ${reviewId} is about Assignment ${review.assignmentId}, not ${assignmentId}`)
    }
    const waiting = pendingReview(ticket)
    if (!waiting || waiting.id !== reviewId) {
      throw new ToolCallError('invalid', `The review ${reviewId} is no longer waiting for a decision`)
    }
    const result = await this.requestReviewDiff(project.id)
    // The PM may have decided the review while the node was reading the workspace: a diff nobody can act on any more is
    // not handed over, and its text leaves the control plane with the answer.
    const current = this.store.tickets.get(ticket.id)
    const stillWaiting = current ? pendingReview(current) : undefined
    if (!current || !stillWaiting || stillWaiting.id !== reviewId) {
      throw new ToolCallError('invalid', `The review ${reviewId} is no longer waiting for a decision`)
    }
    return {
      projectId: project.id,
      ticketId: ticket.id,
      reviewId,
      assignmentId,
      note: PM_REVIEW_DIFF_NOTE,
      ...result,
      ...(result.diff === undefined ? {} : { diff: fenceDiff(result.diff) }),
    }
  }

  /**
   * Ask the node for one Project's review diff and wait for its answer.
   *
   * The request is waiting before the command goes out, so an answer that arrives early still finds its caller. Every
   * outcome is an answer: a node that refuses the command, a node that never answers and a node that read the workspace
   * all end the call, and only the last one carries a diff.
   */
  private requestReviewDiff(projectId: string): Promise<ReviewDiffResult> {
    const requestId = this.uniqueKey('review-diff', projectId)
    const timeoutMs = this.options.reviewDiffTimeoutMs ?? DEFAULT_REVIEW_DIFF_TIMEOUT_MS
    return new Promise<ReviewDiffResult>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (result: ReviewDiffResult): void => {
        if (timer !== undefined) clearTimeout(timer)
        this.pendingReviewDiffs.delete(requestId)
        resolve(result)
      }
      timer = setTimeout(() => {
        settle({ status: 'timeout', reason: `The node did not answer the review diff within ${timeoutMs} ms` })
      }, timeoutMs)
      timer.unref?.()
      this.pendingReviewDiffs.set(requestId, { projectId, settle })
      void this.options.node.send({ ...this.base(requestId), type: 'review.diff', projectId }).catch((error: unknown) => {
        settle({ status: 'failed', reason: `The node refused the review diff: ${redact(messageOf(error)).slice(0, 300)}` })
      })
    })
  }

  /**
   * The review the PM's decision was about, named by its own id.
   *
   * The domain always leaves that round on the Ticket, so a decision that arrives late still answers with the round it
   * named and never with the round that waits now.
   */
  private reviewOf(ticket: Ticket, reviewId: string): PmContextReview {
    const review = ticket.reviews?.find(item => item.id === reviewId)
    if (!review) throw new ToolCallError('invalid', 'The Ticket keeps no review of a Worker result')
    return { id: review.id, state: review.state, assignmentId: review.assignmentId, at: review.at,
      ...(review.summary === undefined ? {} : { summary: review.summary }),
      ...(review.reason === undefined ? {} : { reason: review.reason }),
      ...(review.decidedAt === undefined ? {} : { decidedAt: review.decidedAt }) }
  }

  /**
   * The redacted diagnostic of a revision request the node refused, once its delivery settled.
   *
   * The delivery happens outside the domain transaction, so the failure is read from the Ticket's own fact after the send
   * settled: a request that never reached the Worker says so instead of pretending the Worker was told.
   */
  private async revisionFailure(ticketId: string, assignmentId: string, revisionInputId: string): Promise<string | undefined> {
    const delivery = this.executor.deliveryOf(assignmentId, revisionInputId)
    if (!delivery) return undefined
    await delivery.outcome
    const ticket = this.store.tickets.get(ticketId)
    // The revision request reached the Worker when its Input left the Ticket's waiting list.
    if (!ticket?.undelivered.includes(revisionInputId)) return undefined
    return ticket.delivery?.error
  }

  /**
   * Run one PM operation at a time per Ticket.
   *
   * A cancel and a re-dispatch of the same Ticket are ordered instead of refused: the second waits for the first to
   * settle, so a re-dispatch never starts a second Worker over one whose stop is still in flight, and a cancel never
   * reports an Assignment a re-dispatch has already replaced.
   */
  private async withTicketOperation<T>(ticketId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.ticketOperations.get(ticketId)
    const started = (previous ?? Promise.resolve()).then(work)
    const tail = started.then(() => undefined, () => undefined)
    this.ticketOperations.set(ticketId, tail)
    try {
      return await started
    } finally {
      if (this.ticketOperations.get(ticketId) === tail) this.ticketOperations.delete(ticketId)
    }
  }

  /**
   * Run one stop or one resume of a Session at a time.
   *
   * The two are ordered instead of refused: the resume waits for the stop to settle, so a cancel the stop repeats after
   * its creation settles cannot reach the Session the resume brought back.
   */
  private async withSessionOperation<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperations.get(sessionId)
    const started = (previous ?? Promise.resolve()).then(work)
    const tail = started.then(() => undefined, () => undefined)
    this.sessionOperations.set(sessionId, tail)
    try {
      return await started
    } finally {
      if (this.sessionOperations.get(sessionId) === tail) this.sessionOperations.delete(sessionId)
    }
  }

  /**
   * The Assignment a cancel applies to: the Ticket's current one, or one whose earlier stop was never confirmed.
   *
   * A PM that retries a failed stop names the Assignment it stopped. Any other stale Assignment may not stop anything,
   * so it is refused.
   */
  private stopTarget(ticket: Ticket, latest: Assignment, assignmentId: string | undefined): Assignment {
    if (assignmentId === undefined) return latest
    if (assignmentId === latest.id) return latest
    const stale = ticket.assignments.find(item => item.id === assignmentId)
    if (stale && this.stopUnconfirmed(ticket, assignmentId)) return stale
    throw new ToolCallError('invalid', `Assignment ${assignmentId} is not current for Ticket ${ticket.id}`)
  }

  /**
   * Whether the stop of one Assignment is still unconfirmed.
   *
   * This kernel's own state is its answer for the Assignment it names, and the Ticket's own facts are the durable ones,
   * which outlive a restart of the control plane. The two are reconciled by Assignment: a fact of another Assignment never
   * covers this one, and neither of them hides the other. A stop the node confirmed leaves none of them.
   */
  private stopUnconfirmed(ticket: Ticket, assignmentId: string): boolean {
    const state = this.stopStates.get(ticket.id)
    if (state && state.assignmentId === assignmentId) return state.state !== 'stopped'
    const current = this.store.tickets.get(ticket.id) ?? ticket
    if (current.stopPending?.assignmentId === assignmentId) return true
    return current.stopFailure?.assignmentId === assignmentId
  }

  /**
   * Stop one Worker and wait for the node to confirm it.
   *
   * The Assignment ends in the domain, the node is asked to stop the Session, and the node's answer decides whether the
   * Worker is really gone. A stop the node refused leaves the Ticket's failure in place and no replacement may start; a
   * stop it never answered keeps the Ticket's failure too, and the cleanup stays pending so a later request waits for the
   * same answer.
   */
  private async performStop(project: ProjectProfile, ticketId: string, target: Assignment,
    options: { reason?: string; reconfirm?: boolean }): Promise<{ stopped: boolean; error?: string }> {
    return this.settleStop(ticketId, target.id, cleanups => {
      if (options.reconfirm === true) {
        // The Assignment ended but the node never confirmed the stop: ask it again, so the Worker really stops.
        this.engine.reconfirmStoppedWorker(project.id, project.pmSessionId, ticketId, target.id,
          { ...(options.reason ? { reason: options.reason } : {}), cleanups })
      } else {
        this.engine.stopProjectWorker(project.id, project.pmSessionId, ticketId, target.id,
          { ...(options.reason ? { reason: options.reason } : {}), cleanups })
      }
    })
  }

  /**
   * Run one domain stop of one Assignment and wait for the node to confirm it.
   *
   * The domain stop itself is the caller's: `start` ends the Assignment (or asks the node to stop a Worker whose
   * Assignment is already over) and leaves its cleanup behind. This method owns what happens around it: the open stop is
   * recorded so a restart still knows that the Worker may run, the node's answer decides whether the Worker is really
   * gone, and a stop the node refused or never answered leaves the Ticket's own failure in place — so no replacement
   * starts over a Worker that may still be running.
   */
  private async settleStop(ticketId: string, assignmentId: string,
    start: (cleanups: { ticketId: string; work: Promise<void> }[]) => void): Promise<{ stopped: boolean; error?: string }> {
    const cleanups: { ticketId: string; work: Promise<void> }[] = []
    start(cleanups)
    const work = cleanups[0]?.work
    this.setStopState(ticketId, { assignmentId, state: 'stopping', ...(work ? { work } : {}) })
    if (work) {
      // The cleanup settles on its own: it decides the state, whoever is waiting for it.
      void work.then(
        () => { this.setStopState(ticketId, { assignmentId, state: 'stopped' }) },
        (error: unknown) => { this.setStopState(ticketId, { assignmentId, state: 'failed',
          error: this.stopDiagnostic(ticketId, assignmentId, messageOf(error)) }) })
    }
    if (!work) return { stopped: true }
    const settled = await this.settleStopWork(work)
    if (settled.state === 'stopped') {
      this.setStopState(ticketId, { assignmentId, state: 'stopped' })
      return { stopped: true }
    }
    if (settled.state === 'pending') {
      // The node has not answered: the Worker may still run, so the failure is recorded and no replacement starts.
      const timeoutMs = this.options.stopCleanupTimeoutMs ?? STOP_CLEANUP_TIMEOUT_MS
      const error = this.noteUnconfirmedStop(ticketId, assignmentId,
        `The Worker Session did not stop within ${timeoutMs} ms`)
      return { stopped: false, error }
    }
    const error = this.stopDiagnostic(ticketId, assignmentId, settled.error)
    this.setStopState(ticketId, { assignmentId, state: 'failed', error })
    return { stopped: false, error }
  }

  /**
   * Refuse a re-dispatch while the previous Worker's stop is unconfirmed.
   *
   * A Worker that may still run must never overlap its replacement. A stop still in flight is awaited, bounded; a stop
   * the node refused or never answered is reported with the Ticket's own diagnostic, and the PM is told to stop that
   * Worker again first.
   *
   * The Ticket's own facts decide, not this kernel's memory: an open stop survives a restart of the control plane, so a
   * re-dispatch is refused after a restart as well. This kernel's memory only adds what the durable facts cannot know
   * yet, namely a stop that is still in flight.
   */
  private async requireConfirmedStop(ticket: Ticket): Promise<void> {
    const state = this.stopStates.get(ticket.id)
    if (state?.state === 'stopping' && state.work) {
      const settled = await this.settleStopWork(state.work)
      if (settled.state === 'pending') {
        throw new ToolCallError('invalid', `The Worker of Ticket ${ticket.id} is still being stopped; ask for a new `
          + 'Assignment once its stop is confirmed')
      }
      if (settled.state === 'failed') {
        this.setStopState(ticket.id, { assignmentId: state.assignmentId, state: 'failed',
          error: this.stopDiagnostic(ticket.id, state.assignmentId, settled.error) })
      }
    }
    const current = this.store.tickets.get(ticket.id) ?? ticket
    const message = (diagnostic: string): string => `The Worker of Ticket ${ticket.id} was not confirmed stopped `
      + `(${diagnostic}); stop that Worker again and wait for the confirmation before asking for a new Assignment`
    // An open stop is the fact that matters: the Assignment ended, but nobody confirmed that its Worker Session stopped.
    if (current.stopPending) {
      throw new ToolCallError('invalid', message(`the stop of Assignment ${current.stopPending.assignmentId} is still open`))
    }
    if (current.stopFailure) {
      throw new ToolCallError('invalid', message(current.stopFailure.error))
    }
  }

  /**
   * The diagnostic of a stop the node did not confirm.
   *
   * The Ticket keeps the redacted form of that failure, and the answer the PM reads is that form: a raw error may carry a
   * path or a credential, and both the panel and the PM read this.
   */
  private stopDiagnostic(ticketId: string, assignmentId: string, failure: string): string {
    const recorded = this.store.tickets.get(ticketId)?.stopFailure
    if (recorded && recorded.assignmentId === assignmentId) return recorded.error
    return redact(failure).slice(0, 300)
  }

  /**
   * Record that a stop was not confirmed, so the Ticket keeps the failure until a later stop confirms it.
   *
   * A stop the node confirmed while the wait expired leaves no open stop behind, so nothing is recorded: the failure
   * would name a Worker that is really gone.
   */
  private noteUnconfirmedStop(ticketId: string, assignmentId: string, message: string): string {
    const current = this.store.tickets.get(ticketId)
    if (current && current.stopPending?.assignmentId !== assignmentId && current.stopFailure?.assignmentId !== assignmentId) {
      return redact(message).slice(0, 300)
    }
    this.engine.noteStopFailure(ticketId, assignmentId, message)
    const recorded = this.store.tickets.get(ticketId)?.stopFailure
    return recorded?.assignmentId === assignmentId ? recorded.error : redact(message).slice(0, 300)
  }

  /**
   * Record the stop state of one Ticket, unless a newer Assignment already replaced it.
   *
   * The Assignments of a Ticket are ordered, so a late report of an older stop never overwrites the state of a newer one:
   * the diagnostics of the Assignment the PM is working on stay its own.
   */
  private setStopState(ticketId: string, state: PmStopState): void {
    const current = this.stopStates.get(ticketId)
    if (current && current.assignmentId !== state.assignmentId
      && !this.newerAssignment(ticketId, state.assignmentId, current.assignmentId)) return
    this.stopStates.set(ticketId, state)
  }

  /** Whether one Assignment of a Ticket is newer than another; the Ticket's own order decides. */
  private newerAssignment(ticketId: string, assignmentId: string, otherAssignmentId: string): boolean {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) return false
    const order = (id: string): number => ticket.assignments.findIndex(item => item.id === id)
    return order(assignmentId) > order(otherAssignmentId)
  }

  /**
   * The caller's own Project, from its Session record. A PM Session that is not the Project's own PM is refused, so a
   * token cannot manage a Project it was not given.
   */
  private requireProject(sessionId: string): { record: SessionRecord; project: ProjectProfile } {
    const record = this.requireToolSession(sessionId, 'pm')
    const project = this.store.projects.get(record.projectId)
    if (!project) throw new ToolCallError('invalid', `Unknown Project ${record.projectId}`)
    if (project.pmSessionId !== sessionId) {
      throw new ToolCallError('forbidden', 'Only this Project\'s PM Session may manage its Tickets')
    }
    return { record, project }
  }

  /**
   * A Ticket of the caller's own Project, read from the persistent record. A Ticket of another Project is unknown to the
   * caller, so its existence is never confirmed across the Project boundary.
   */
  private requireProjectTicket(project: ProjectProfile, ticketId: string): Ticket {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || ticket.projectId !== project.id) throw new ToolCallError('invalid', `Unknown ticket ${ticketId}`)
    return ticket
  }

  /**
   * The Assignment a caller named, when it is still the Ticket's current one. A stale Assignment is refused instead of
   * reaching the Worker a newer Assignment owns.
   */
  private requireCurrentAssignment(ticket: Ticket, assignmentId: string): Assignment {
    const latest = latestAssignment(ticket)
    if (!latest || latest.id !== assignmentId) {
      throw new ToolCallError('invalid', `Assignment ${assignmentId} is not current for Ticket ${ticket.id}`)
    }
    return latest
  }

  /**
   * Wait for the node's answer about a stop, bounded.
   *
   * `stopped` means the node confirmed the stop, `pending` that it did not answer within the deadline, and `failed` that it
   * refused the stop. A cleanup that settles after the deadline is observed here, so it cannot surface as an unhandled
   * rejection.
   */
  private async settleStopWork(work: Promise<unknown>, timeoutMs = this.options.stopCleanupTimeoutMs ?? STOP_CLEANUP_TIMEOUT_MS):
    Promise<StopOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'pending'>(resolve => {
      timer = setTimeout(() => resolve('pending'), timeoutMs)
      timer.unref?.()
    })
    const outcome = work.then(() => 'ok' as const, (error: unknown) => `failed:${messageOf(error)}`)
    try {
      const result = await Promise.race([outcome, expired])
      if (result === 'ok') return { state: 'stopped' }
      if (result === 'pending') return { state: 'pending' }
      return { state: 'failed', error: result.slice('failed:'.length) }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // A cleanup that settles after the deadline is observed here, so it cannot become an unhandled rejection.
      void work.catch(() => {})
    }
  }

  /**
   * Record a Worker's report on the Ticket its own Assignment runs.
   *
   * The token's Assignment is the authority; a caller-supplied one must match it. The Ticket must belong to the Worker's
   * Project and its latest Assignment must still be this Worker's, so a replaced Worker cannot report on work a newer
   * Assignment owns. `engine.report` applies the report's own rules (an ended Ticket, a question beside a ready result).
   *
   * A call that names its own id is recorded with it: the report and the ledger entry are written in one transaction, so
   * a report that was written is always recorded, and a recorded call is never forgotten by a restart. The same call with
   * the same payload is a replay — it changes nothing and answers with the Ticket as it stands — and the same call with a
   * different payload is a conflict, which is refused rather than written over the first one.
   *
   * A call without an id (a node that does not send one) keeps the older behaviour: the report is written, and the
   * content decides whether the PM is woken. The content cannot tell a replay from a new fact, so it never suppresses
   * one.
   *
   * The report is written first and only then does the Project's PM learn about it: a wake-up that fails never undoes
   * the report and never fails the Worker's own call.
   */
  workerReport(sessionId: string, ticketId: string, assignmentId: string | undefined, report: WorkerReport,
    callKey?: string): Ticket {
    const record = this.requireToolSession(sessionId, 'worker')
    const own = record.assignmentId
    if (!own) throw new ToolCallError('forbidden', 'This Worker Session has no Assignment')
    if (assignmentId !== undefined && assignmentId !== own) {
      throw new ToolCallError('forbidden', 'The Assignment does not belong to this Worker Session')
    }
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || (ticket.projectId ?? ticket.id) !== record.projectId) {
      throw new ToolCallError('invalid', `Unknown ticket ${ticketId}`)
    }
    const current = ticket.assignments.at(-1)
    if (!current || current.id !== own) {
      throw new ToolCallError('invalid', `Assignment ${own} is not current for Ticket ${ticketId}`)
    }
    const payloadHash = reportPayloadHash(ticketId, own, report)
    const key = callKey !== undefined && callKey.trim() !== ''
      ? reportCallKey(sessionId, own, callKey.trim())
      : undefined
    // One transaction: the report and its ledger entry are written together, or neither is.
    const outcome = this.store.atomic(() => {
      if (key !== undefined) {
        const prior = this.store.get(key)
        if (prior !== undefined) {
          if (prior.payloadHash !== payloadHash) {
            throw new ToolCallError('invalid',
              'This report call was already recorded with a different payload; it cannot be reused')
          }
          return { ticket: this.store.tickets.get(ticketId) ?? ticket, replay: true as const, prior }
        }
      }
      const written = this.engine.report(ticketId, report)
      if (key !== undefined) {
        this.store.set(key, { sessionId, assignmentId: own, ticketId, payloadHash, state: report.state,
          notified: false, at: this.now() })
        this.pruneReportCalls(sessionId)
      }
      return { ticket: written, replay: false as const, prior: undefined }
    })
    if (outcome.replay) {
      // The call was already recorded: the work is not done twice, and the PM is not woken twice.
      this.audit.record({ actor: 'worker', kind: 'report', action: 'duplicate', targetKind: 'assignment', targetId: own,
        outcome: 'skipped', detail: `${ticket.title} · 这个调用已经记录过` })
      const notification: PmNotification = { ticketId: ticket.id, projectId: ticket.projectId ?? '', assignmentId: own,
        reportState: report.state, at: this.now(), state: 'skipped', reason: 'this report call was already recorded' }
      this.pmNotificationsByTicket.set(ticket.id, notification)
      return outcome.ticket
    }
    // The report is committed now, so the PM may learn about it. The wake-up runs outside the transaction and never
    // throws into this call: a PM that cannot be reached is a diagnostic, not a failed report.
    this.audit.record({ actor: 'worker', kind: 'report', action: report.state, targetKind: 'assignment',
      targetId: own, detail: `${ticket.title} · ${report.summary}` })
    this.notifyOwnerOfReport(outcome.ticket, own, key)
    return outcome.ticket
  }

  /**
   * Record that the PM was woken for one report call.
   *
   * The flag is what makes the wake-up happen once: a replay of the same call finds it set and asks nothing of the PM. It
   * is written after the wake-up settled, so a delivery that failed leaves the flag unset and a later call may try again.
   */
  private markReportNotified(key: Key<ReportCallRecord> | undefined): void {
    if (key === undefined) return
    const record = this.store.get(key)
    if (record === undefined || record.notified) return
    this.store.set(key, { ...record, notified: true })
  }

  /**
   * Drop the report calls one Session may no longer keep.
   *
   * The ledger outlives a restart, so it is bounded the way the event log is: the newest calls of a Session stay, the
   * oldest go. A call that was dropped may be replayed as a new one, which is the safe direction: the work is written
   * again and the PM is woken again, rather than a fact being lost.
   */
  private pruneReportCalls(sessionId: string): void {
    const prefix = reportCallPrefix(sessionId)
    const keys = this.store.keys(KV.control.reportCall).filter(key => key.startsWith(prefix))
    if (keys.length <= REPORT_CALLS_PER_SESSION) return
    const entries = keys.map(key => ({ key, at: this.store.get(key)?.at ?? '' }))
    entries.sort((left, right) => left.at.localeCompare(right.at))
    for (const entry of entries.slice(0, entries.length - REPORT_CALLS_PER_SESSION)) this.store.delete(entry.key)
  }

  /**
   * The Assignment that started, as the audit trail records it.
   *
   * This is the PM's own dispatch of work becoming real: a Worker Session runs the Assignment, and the entry names the
   * Project and the Ticket it works on.
   */
  private auditAssignmentStarted(ticketId: string, assignmentId: string): void {
    const ticket = this.store.tickets.get(ticketId)
    const project = ticket?.projectId ? this.store.projects.get(ticket.projectId) : undefined
    this.audit.record({ actor: ticket?.projectId === undefined ? 'router' : 'pm',
      kind: 'assignment', action: 'started', targetKind: 'assignment',
      targetId: assignmentId, detail: [project?.title, ticket?.title].filter(Boolean).join(' · ') })
  }

  /**
   * Wake the Project's PM with one Worker report.
   *
   * The message names the Project, the Ticket, the Assignment and the report itself, and it carries the Worker's own
   * text as data. It goes to the PM Session of the report's own Project and to no other, so one Project's work never
   * wakes another's PM.
   *
   * A report that must not wake the PM is skipped and recorded: a Project that is not active (archived or ended), a PM
   * that does not exist (the control plane never creates one on its own), and a report the PM already knows. A message the
   * node refuses or cannot receive is recorded as failed with a redacted diagnostic; the report stays written either way.
   *
   * A paused Project is the one case that waits instead of being given up: it has no PM to wake now, so the wake-up is
   * held back and sent when the Project is resumed — if the result still waits for the PM's decision by then.
   *
   * The wake-up is not awaited: the PM's Session may be busy with a turn of its own, and a Worker must never wait for
   * the PM. The message is queued by the node, which starts the PM's turn when it can.
   */
  private notifyOwnerOfReport(ticket: Ticket, assignmentId: string, ledgerKey?: Key<ReportCallRecord>): void {
    const report = latestAssignment(ticket)?.report
    if (!report) return
    const projectId = ticket.projectId ?? ''
    // A ready result waits for the PM's decision, and the decision names the review: the wake-up carries that id, so the
    // PM decides the round it was told about and a new round with the same text is a new fact, not a replayed one.
    const review = report.state === 'ready' ? pendingReview(ticket) : undefined
    const reviewId = review?.assignmentId === assignmentId ? review.id : undefined
    const facts: PmReportFacts = {
      projectId,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      assignmentId,
      reportState: report.state,
      summary: report.summary,
      ...(reviewId === undefined ? {} : { reviewId }),
      ...(ticket.attention === undefined ? {} : { question: ticket.attention.question }),
      at: report.at,
    }
    const record: PmNotification = { ticketId: ticket.id, projectId, assignmentId, reportState: report.state,
      at: this.now(), state: 'pending' }
    this.pmNotificationsByTicket.set(ticket.id, record)
    const finish = (state: PmNotification['state'], reason?: string): void => {
      record.state = state
      if (reason !== undefined) record.reason = reason
    }
    const project = projectId === '' ? undefined : this.store.projects.get(projectId)
    // Every outcome that will not wake the PM settles the call: the PM will not learn this report from here, so the call
    // is recorded as notified and a replay of it asks nothing of the PM again.
    if (projectId !== '' && !project) {
      finish('skipped', 'the Project of the Ticket does not exist')
      this.markReportNotified(ledgerKey)
      return
    }
    if (project && project.status === 'paused') {
      // A paused Project has no PM to wake. The report stays written, and the wake-up waits for the resume: the PM decides
      // on the result when the Project is active again, and only then.
      this.store.set(KV.control.deferredPmReport(ticket.id), { facts, ...(ledgerKey === undefined ? {} : { ledgerKey }) })
      finish('deferred', 'the Project is paused; the wake-up waits for the resume')
      return
    }
    if (project && project.status !== 'active') {
      finish('skipped', `the Project is ${project.status}`)
      this.markReportNotified(ledgerKey)
      return
    }
    const manager = this.sessions.get(project?.pmSessionId ?? ROUTER_SESSION_ID)
    if (!manager) {
      finish('skipped', project ? 'the Project has no PM Session' : 'the Router has no Session')
      this.markReportNotified(ledgerKey)
      return
    }
    if (project && (manager.role !== 'pm' || manager.projectId !== project.id)) {
      finish('skipped', 'the PM Session does not belong to the Project')
      this.markReportNotified(ledgerKey)
      return
    }
    // The wake-up runs in the background: the PM's Session may be busy, and the Worker's report must not wait for it.
    void this.sendPmWakeUp(manager.sessionId, facts, ledgerKey).then(
      (outcome) => { finish(outcome.state, outcome.error) },
      (error: unknown) => { finish('failed', redact(messageOf(error)).slice(0, 300)) })
  }

  /**
   * Send one PM wake-up, and record what the PM learned.
   *
   * The report's own content is the key: the same Assignment reporting the same content is one fact, so the PM is woken
   * once for it. A wake-up that failed gives its key back, so a later report with the same content may try again once the
   * node is reachable, and the report's own ledger entry stays unnotified for the same reason.
   */
  private async sendPmWakeUp(managerSessionId: string, facts: PmReportFacts, ledgerKey?: Key<ReportCallRecord>):
    Promise<{ state: 'sent' | 'skipped' | 'failed'; error?: string }> {
    const reportKey = pmReportKey(facts)
    const known = this.notifiedReports.get(facts.assignmentId) ?? new Set<string>()
    if (known.has(reportKey)) {
      // The PM already knows this report: the call is recorded as notified and a replay asks nothing of the PM again.
      this.markReportNotified(ledgerKey)
      return { state: 'skipped', error: 'the PM already knows this report' }
    }
    known.add(reportKey)
    // The oldest key goes first, so one Assignment that reports many different texts keeps a bounded memory.
    while (known.size > NOTIFIED_REPORTS_PER_ASSIGNMENT) {
      const oldest = known.values().next().value
      if (oldest === undefined) break
      known.delete(oldest)
    }
    this.notifiedReports.set(facts.assignmentId, known)
    try {
      await this.sendMessage(managerSessionId, pmReportMessage(facts), undefined, 'system',
        facts.reviewId === undefined ? {} : { idempotencyKey: key('pm-report', reportKey) })
      this.markReportNotified(ledgerKey)
      return { state: 'sent' }
    } catch (error) {
      known.delete(reportKey)
      return { state: 'failed', error: redact(messageOf(error)).slice(0, 300) }
    }
  }

  /**
   * Send the PM wake-ups a paused Project held back, and only the ones that still wait.
   *
   * A result the PM has not decided yet, whose Assignment is still the Ticket's current one, is still worth telling the PM
   * about: the Project was paused when the Worker reported it, and the pause is over. A result the PM already decided, one
   * a newer round replaced, and one whose Assignment is no longer the Ticket's current one are not sent again: the PM
   * would act on a fact that is no longer there.
   *
   * The wake-up is sent once. The entry is dropped as soon as it is sent, so a second resume asks nothing of the PM again,
   * and the report's own ledger entry is marked, so a replay of the same report asks nothing either.
   */
  private async resumeDeferredPmNotifications(projectId: string): Promise<void> {
    const project = this.store.projects.get(projectId)
    if (!project || project.status !== 'active') return
    const manager = this.sessions.get(project.pmSessionId)
    if (!manager || manager.revokedAt || manager.role !== 'pm' || manager.projectId !== project.id) return
    for (const entryKey of this.store.keys(KV.control.deferredPmReport)) {
      if (this.store.projects.get(projectId)?.status !== 'active') return
      if (this.resumingPmNotifications.has(entryKey)) continue
      const entry = this.store.get(entryKey as ReturnType<typeof KV.control.deferredPmReport>)
      if (!entry || entry.facts.projectId !== projectId) continue
      const ticket = this.store.tickets.get(entry.facts.ticketId)
      if (!ticket || !this.deferredNotificationStillWaits(ticket, entry.facts)) {
        this.store.delete(entryKey)
        continue
      }
      this.resumingPmNotifications.add(entryKey)
      const record: PmNotification = { ticketId: ticket.id, projectId, assignmentId: entry.facts.assignmentId,
        reportState: entry.facts.reportState, at: this.now(), state: 'pending' }
      this.pmNotificationsByTicket.set(ticket.id, record)
      try {
        const outcome = await this.sendPmWakeUp(manager.sessionId, entry.facts, entry.ledgerKey)
        record.state = outcome.state
        if (outcome.error !== undefined) record.reason = outcome.error
        const current = this.store.get(entryKey as ReturnType<typeof KV.control.deferredPmReport>)
        if (outcome.state !== 'failed' && current && pmReportKey(current.facts) === pmReportKey(entry.facts)) {
          this.store.delete(entryKey)
        }
      } finally {
        this.resumingPmNotifications.delete(entryKey)
      }
    }
  }

  /**
   * Whether a wake-up a paused Project held back still waits for the PM's decision.
   *
   * The Assignment must still be the Ticket's current one, the report must still be the one that Assignment made, and a
   * result that waits for a review must still wait for that very review: a round the PM already decided, or one a newer
   * round replaced, is not a fact the PM still needs.
   */
  private deferredNotificationStillWaits(ticket: Ticket, facts: PmReportFacts): boolean {
    const assignment = latestAssignment(ticket)
    if (!assignment || assignment.id !== facts.assignmentId) return false
    const report = assignment.report
    if (!report || report.state !== facts.reportState || report.summary !== facts.summary || report.at !== facts.at) return false
    if (facts.reviewId === undefined) return true
    return pendingReview(ticket)?.id === facts.reviewId
  }

  /** The PM wake-ups this control plane made for Worker reports, newest last. */
  pmNotifications(): PmNotification[] { return [...this.pmNotificationsByTicket.values()] }

  /** The Session a tool call acts as; a token of the wrong role is refused before any domain check runs. */
  private requireToolSession(sessionId: string, role: 'pm' | 'worker' | 'router'): SessionRecord {
    const record = this.sessions.get(sessionId)
    if (!record) throw new ToolCallError('unauthenticated', `Unknown Session ${sessionId}`)
    if (record.role !== role) throw new ToolCallError('forbidden', `A ${role} Session token is required`)
    return record
  }

  /**
   * Ensure the Project's PM Session. The workspace is created under `workspaceRoot`; the PM gets a short-lived token
   * and the PM role profile. A record the current node generation already confirmed (`idle`, `running`, `stopped`,
   * `archived`, …) is returned as it is.
   *
   * Concurrent requests for the same Session share one ensure. A `starting` or `failed` record is confirmed with the
   * node, not guessed from a repeated command: a node acknowledges a key it already completed without reporting the
   * Session's status, so a retried ensure alone can leave the record `starting` forever. A confirmed record from an
   * older generation (the control plane restarted, or the node went offline and came back) is re-ensured under the same
   * Session id instead: the node may no longer hold it, and returning the stale record would claim a Session that is not
   * there. A `stopped` or `archived` record is returned as it is, because its lifecycle is already over. The method never
   * returns a `starting` record: it either settles on a node fact or marks the record failed.
   */
  async openProject(projectId: string, workspace?: string): Promise<SessionRecord> {
    return this.openProjectWith(projectId, workspace, {})
  }

  /**
   * The PM Session of a Project, with the one option a resume needs.
   *
   * `resume` is the operator's explicit act: it may bring back a Session an operator stopped, and it skips the fast paths
   * that would hand the stopped record back as it is. Nothing else passes it, and the public entry never does.
   */
  private async openProjectWith(projectId: string, workspace: string | undefined,
    options: { resume?: boolean }): Promise<SessionRecord> {
    const project = this.store.projects.get(projectId)
    if (!project) throw new Error(`Unknown project ${projectId}`)
    if (project.workspace && workspace !== undefined
      && (!isAbsolute(workspace) || relative(project.workspace, workspace) !== '')) {
      throw new OperatorError(409, '请使用项目创建时指定的工作区。')
    }
    // A revoked PM Session stays revoked: re-ensuring it would issue a new token and hand the authority back.
    const known = this.sessions.get(project.pmSessionId)
    if (known?.revokedAt) {
      throw new OperatorError(409, `The PM Session of this Project was revoked and cannot be started again`)
    }
    // A PM an operator stopped is not ensured again: the stop is the operator's own word, and only an explicit resume
    // takes it back.
    if (options.resume !== true && known && this.operatorStopRefusal(known)) {
      throw new OperatorError(409, 'The PM Session of this Project was stopped by an operator '
        + 'and has to be resumed explicitly')
    }
    this.requireNodeOnline()
    // A concurrent request joins the running ensure before reading the record: a node status event may already have made
    // the record `idle` while the ensure still waits on role installation, and returning that record would report 200
    // for an ensure that can still fail.
    const pending = this.pendingEnsures.get(project.pmSessionId)
    if (pending) {
      // A creation that is still in flight belongs to the stop that came before the resume: joining it would answer with
      // the Session that stop took away.
      if (options.resume === true) {
        throw new OperatorError(409, 'The PM Session of this Project is still being created; '
          + 'resume it once that creation settled')
      }
      return pending
    }
    const existing = this.sessions.get(project.pmSessionId)
    if (options.resume !== true && existing && isNodeConfirmed(existing.status) && !this.needsReensure(existing)) return existing
    return this.singleFlight(project.pmSessionId, () => this.ensurePm(project, workspace, options))
  }

  /**
   * Ensure the PM Session of a Project an operator asked to start.
   *
   * A Project that is over gets no PM: an ended or archived Project is a state the domain knows, and starting a PM for it
   * would leave a Session behind that no work will ever use.
   */
  async startProjectPm(projectId: string, workspace?: string): Promise<SessionRecord> {
    const project = this.requireProjectById(projectId)
    if (project.status === 'ended' || project.status === 'archived') {
      throw new OperatorError(409, `This Project is ${project.status}; it cannot get a PM Session any more`)
    }
    return this.openProject(projectId, workspace)
  }

  /** Create a worker Session for an Assignment; the caller records the Assignment in the domain separately. */
  async createWorkerSession(projectId: string, assignmentId: string, ticketId: string, prompt: string = WORKER_PROFILE.prompt): Promise<SessionRecord> {
    return this.createAssignmentWorker(projectId, assignmentId, ticketId, prompt)
  }

  private async createAssignmentWorker(projectId: string | undefined, assignmentId: string, ticketId: string,
    prompt: string): Promise<SessionRecord> {
    if (projectId !== undefined && !this.store.projects.get(projectId)) throw new Error(`Unknown project ${projectId}`)
    this.requireNodeOnline()
    const sessionId = `worker-${assignmentId}`
    // The Ticket decides whether this Assignment may still run: the Session record is the control plane's own fact, and
    // a Worker that was stopped before its Session existed has no record at all.
    const refused = this.workerRefusal(assignmentId, { projectId, ticketId })
    if (refused !== undefined) throw new SessionEnsureError(refused)
    // A Session that is being stopped must not be created again: a re-ensure would bring the Worker back over a stop
    // the node has not confirmed yet.
    if (this.stoppingSessions.has(sessionId)) {
      throw new SessionEnsureError(`The Worker Session ${sessionId} is stopping and must not be created again`)
    }
    // A revoked Session stays revoked: a re-ensure would issue a new token and hand the authority back.
    const known = this.sessions.get(sessionId)
    if (known?.revokedAt) {
      throw new SessionEnsureError(`The Worker Session ${sessionId} was revoked and cannot be created again`)
    }
    // A Worker an operator stopped is not created again: the low-level ensure path must not resurrect a Worker that a
    // person stopped, and only an explicit resume of its Ticket may start a new Assignment.
    if (known && this.operatorStopRefusal(known)) {
      throw new SessionEnsureError(`The Worker Session ${sessionId} was stopped by an operator and cannot be created again`)
    }
    const pending = this.pendingEnsures.get(sessionId)
    if (pending) return pending
    const existing = this.sessions.get(sessionId)
    if (existing && isNodeConfirmed(existing.status) && !this.needsReensure(existing)) return existing
    return this.singleFlight(sessionId, () => this.ensureWorker(projectId, assignmentId, ticketId, prompt))
  }

  /**
   * Why the Worker of one Assignment may not be created, or undefined when it may.
   *
   * The Ticket is the authority: it knows whether a person stopped the Worker, whether the Assignment ended and whether
   * that stop is still open. The Session record only knows what this control plane saw, and a Worker stopped before its
   * Session existed has no record at all. An Assignment no Ticket owns is left alone: the nominal entry point and the
   * older protocol tests name Assignments the domain never had.
   */
  private workerRefusal(assignmentId: string,
    target?: { projectId: string | undefined; ticketId: string }): string | undefined {
    const ticket = this.ticketOfAssignment(assignmentId)
    const assignment = ticket?.assignments.find(item => item.id === assignmentId)
    if (!ticket || !assignment) return undefined
    const sessionId = this.workerSessionFor(assignmentId)
    if (target && (ticket.id !== target.ticketId || ticket.projectId !== target.projectId)) {
      return `The Worker Session ${sessionId} does not belong to the selected Ticket or Project`
    }
    if (ticket.ended) return `The Worker Session ${sessionId} cannot be created: its Ticket ${ticket.id} has ended`
    const latest = latestAssignment(ticket)
    if (latest?.id !== assignmentId) {
      return `The Worker Session ${sessionId} cannot be created: Assignment ${assignmentId} was replaced`
    }
    if (assignment.state === 'ended') {
      return `The Worker Session ${sessionId} cannot be created: Assignment ${assignmentId} has ended`
    }
    if (ticket.manualStop) {
      return `The Worker Session ${sessionId} was stopped by an operator and cannot be created again`
    }
    if (ticket.stopPending?.assignmentId === assignmentId) {
      return `The Worker Session ${sessionId} cannot be created: the stop of Assignment ${assignmentId} is still open`
    }
    if (ticket.stopFailure?.assignmentId === assignmentId) {
      return `The Worker Session ${sessionId} cannot be created: the stop of Assignment ${assignmentId} was not confirmed`
    }
    return undefined
  }

  /**
   * The brief a Worker Session starts from. A Project Ticket's task text lives on its internal Trigger's `meta`
   * (`title`, `goal`, `scope`, `note`) because the Ticket itself keeps only the short title; the Trigger's `text` is the
   * request its PM started from. Every field stays present, so even a Trigger without meta gives the Worker more than a
   * bare title.
   */
  taskPrompt(ticket: Ticket): string {
    const trigger = this.store.triggers.get(ticket.origin.triggerId)
    const meta = trigger?.meta ?? {}
    const field = (name: string): string | undefined => {
      const value = meta[name]
      return typeof value === 'string' && value.trim() ? value.trim() : undefined
    }
    const execution = ticket.execution?.assignment.trim() || undefined
    const title = field('title') ?? ticket.title
    const source = trigger?.text.trim() || ticket.title
    const goal = field('goal') ?? execution ?? source
    const scope = field('scope') ?? '(not specified)'
    const note = field('note') ?? '(none)'
    const assignment = execution ?? goal
    return [`Ticket: ${title}`, `Goal: ${goal}`, `Scope: ${scope}`, `Note: ${note}`, `Assignment: ${assignment}`,
      `Source: ${source}`].join('\n')
  }

  /**
   * The text one Ticket Input contributes to a delivery.
   *
   * A `text` or `note` Input already carries its message. A Trigger Input names only its Trigger, so the Trigger's `text`
   * is resolved here — the message a Worker must actually read — together with the task fields a Project Ticket keeps on
   * its Trigger's `meta` (`title`, `goal`, `scope`, `note`), each only when it holds text. Undefined when neither does,
   * which lets the Executor fall back to its own notice.
   */
  inputText(input: TicketInput): string | undefined {
    if (input.kind === 'text' || input.kind === 'note') return input.text
    if (input.kind !== 'trigger') return undefined
    const trigger = this.store.triggers.get(input.triggerId)
    const meta = trigger?.meta ?? {}
    const field = (name: string): string | undefined => {
      const value = meta[name]
      return typeof value === 'string' && value.trim() ? value.trim() : undefined
    }
    const labelled = (['title', 'goal', 'scope', 'note'] as const).flatMap(name => {
      const value = field(name)
      return value ? [`${name[0]!.toUpperCase()}${name.slice(1)}: ${value}`] : []
    })
    const lines = [trigger?.text.trim() || undefined, ...labelled].filter((line): line is string => line !== undefined)
    return lines.join('\n').trim() || undefined
  }

  private async ensurePm(project: ProjectProfile, workspace?: string, options: { resume?: boolean } = {}): Promise<SessionRecord> {
    const existing = this.sessions.get(project.pmSessionId)
    // A confirmed record from an older generation is re-ensured rather than inspected: the node's answer would be the
    // same stale fact the generation already told us not to trust.
    const stale = existing !== undefined && this.needsReensure(existing)
    if (options.resume !== true) {
      // The fast paths hand the record back as it is, so the stop gate has to be applied here too: an ensure that was
      // already in flight when the operator stopped the Session must not answer with a Session they stopped.
      if (existing && !stale && isNodeConfirmed(existing.status)) {
        await this.enforceOperatorStop(existing)
        return existing
      }
      if (existing && !stale) {
        const confirmed = await this.confirmExisting(existing)
        if (confirmed) {
          await this.enforceOperatorStop(confirmed)
          return confirmed
        }
      }
    }
    const path = this.workspacePath(project.workspace ?? workspace ?? existing?.workspace ?? join(this.options.workspaceRoot, project.id))
    const at = this.now()
    const retry = existing !== undefined
    const created = existing === undefined
    const record: SessionRecord = existing
      ? this.restartSession(existing, path, at)
      : { sessionId: project.pmSessionId, projectId: project.id, role: 'pm', nodeId: this.options.nodeId, workspace: path,
          status: 'starting', toolProfile: PM_PROFILE.name, backendSessionId: `fake-${project.pmSessionId}`, createdAt: at,
          updatedAt: at }
    const token = this.issueToken(record)
    this.sessions.set(record.sessionId, record)
    this.tokens.set(record.sessionId, token)
    this.persist(record)
    const workspaceKey = retry ? this.uniqueKey('workspace-confirm', project.id) : `workspace:${project.id}`
    const bindKey = retry ? this.uniqueKey('project-bind-confirm', project.id) : `project-bind:${project.id}`
    const ensureKey = retry ? this.uniqueKey('pm-ensure-confirm', project.id) : `pm-ensure:${project.id}`
    try {
      await this.options.node.send({ ...this.base(workspaceKey), type: 'workspace.ensure', projectId: project.id, workspace: path })
      await this.options.node.send({ ...this.base(bindKey), type: 'project.bind', projectId: project.id, workspace: path })
      await this.options.node.send({ ...this.base(ensureKey), type: 'pm.ensure', sessionId: record.sessionId,
        project: { id: project.id, title: project.title, goal: project.goal }, workspace: path, profile: PM_PROFILE,
        sessionToken: token, prompt: PM_PROFILE.prompt })
    } catch (error) {
      // An ensure that failed on an abnormal receipt must not answer with a Session an operator stopped either.
      const failed = await this.recoverEnsureFailure(record, error, 'PM')
      await this.enforceOperatorStop(failed)
      return failed
    }
    const settled = await this.settleEnsure(record, 'PM')
    // An ensure that was already in flight when the operator stopped the Session would bring it back.
    await this.enforceOperatorStop(settled)
    if (created) {
      // The Project's PM Session exists and the node confirmed it: the fact the console's Project page shows.
      this.audit.record({ actor: 'system', kind: 'project', action: 'pm-ready', targetKind: 'project',
        targetId: project.id, detail: project.title })
    }
    return settled
  }

  private async ensureWorker(projectId: string | undefined, assignmentId: string, ticketId: string,
    prompt: string): Promise<SessionRecord> {
    const sessionId = `worker-${assignmentId}`
    const existing = this.sessions.get(sessionId)
    // Same rule as the PM: a confirmed Session from an older generation is re-ensured under the same id.
    const stale = existing !== undefined && this.needsReensure(existing)
    // The fast paths hand the record back as it is, so the stop gate has to be applied here too: an ensure that was
    // already in flight when the operator stopped the Worker must not answer with a Session they stopped.
    if (existing && !stale && isNodeConfirmed(existing.status)) {
      await this.enforceOperatorStop(existing)
      return existing
    }
    if (existing && !stale) {
      const confirmed = await this.confirmExisting(existing)
      if (confirmed) {
        await this.enforceOperatorStop(confirmed)
        return confirmed
      }
    }
    // The wire protocol requires a workspace identifier. An independent Ticket has its own isolated workspace.
    const workspaceId = projectId ?? ticketId
    const projectWorkspace = projectId ? this.store.projects.get(projectId)?.workspace : undefined
    const path = this.workspacePath(projectWorkspace ?? join(this.options.workspaceRoot, workspaceId))
    const at = this.now()
    const retry = existing !== undefined
    const record: SessionRecord = existing
      ? this.restartSession(existing, path, at)
      : { sessionId, projectId: workspaceId, assignmentId, role: 'worker', nodeId: this.options.nodeId, workspace: path,
          status: 'starting', toolProfile: WORKER_PROFILE.name, backendSessionId: `fake-${sessionId}`, createdAt: at,
          updatedAt: at }
    const token = this.issueToken(record)
    this.sessions.set(sessionId, record)
    this.tokens.set(sessionId, token)
    this.persist(record)
    // Same rule as `openProject`: only the first attempt may reuse a stable key.
    const createKey = retry ? this.uniqueKey('worker-create-confirm', assignmentId) : `worker-create:${assignmentId}`
    try {
      await this.options.node.send({ ...this.base(createKey), type: 'worker.create', sessionId, projectId: workspaceId,
        assignmentId, ticketId, workspace: path, profile: WORKER_PROFILE, sessionToken: token, prompt })
    } catch (error) {
      // An ensure that failed on an abnormal receipt must not answer with a Session an operator stopped either.
      const failed = await this.recoverEnsureFailure(record, error, 'Worker')
      await this.enforceOperatorStop(failed)
      return failed
    }
    const settled = await this.settleEnsure(record, 'Worker')
    // An ensure that was already in flight when the operator stopped the Worker would bring it back.
    await this.enforceOperatorStop(settled)
    return settled
  }

  /**
   * Deliver one message to a Session.
   *
   * `origin` says who asked for it: an operator's own message is a fact of the work, while the Executor's delivery and the
   * PM's wake-up are the system carrying out what the domain already decided. Only the operator's message is audited, and
   * it is audited as a fact about its size rather than as a copy of its body.
   *
   * `options.idempotencyKey` names the node's own key, so a delivery that is repeated under the same key is executed by the
   * node at most once — that is how a scheduled run keeps its own identity across a retry. `options.allowEnsure: false`
   * forbids the re-ensure below: a scheduled task never starts a Session on its own, so a Session the node may have
   * forgotten is a failure and not something to bring back.
   */
  async sendMessage(sessionId: string, text: string, inputIds?: readonly string[],
    origin: 'operator' | 'system' = 'operator',
    options: { idempotencyKey?: string; allowEnsure?: boolean; routerModel?: RouterModel } = {}): Promise<void> {
    let record = this.requireSession(sessionId)
    // A revoked Session is not a running Session: a message must not bring it back, and it must not re-ensure it either.
    if (record.revokedAt) throw new Error(`Session ${sessionId} was revoked`)
    // A Session an operator stopped stays stopped: this is the low-level path every message goes through, so it is
    // where a stopped PM, Router or Worker is kept from being used — and, through the re-ensure below, from being
    // brought back.
    const stopped = this.operatorStopRefusal(record)
    if (stopped !== undefined) throw new Error(`Session ${sessionId} is not running: ${stopped}`)
    // The Ticket decides whether the Worker may still run: a Worker whose Assignment a person stopped takes no message,
    // whatever its own Session record says, and the re-ensure below may not bring it back either.
    if (record.role === 'worker' && record.assignmentId !== undefined) {
      const refused = this.workerRefusal(record.assignmentId)
      if (refused !== undefined) throw new Error(`Session ${sessionId} is not running: ${refused}`)
    }
    if (record.status === 'archived' || record.status === 'stopped' || record.status === 'stopping'
      || this.stoppingSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is not running`)
    }
    this.requireNodeOnline()
    // A node restart leaves the record confirmed under an older generation while its Agent is gone; the node would refuse
    // the message as "session not loaded" and fail the Assignment. Ensure the Session first, then re-read the record: the
    // ensure re-issues the token and may settle on a status newer than the one read here.
    if (!this.isCurrentGeneration(record)) {
      if (options.allowEnsure === false) {
        throw new Error(`Session ${sessionId} was not confirmed in the current node generation`)
      }
      await this.ensureForMessage(record)
      record = this.requireSession(sessionId)
      // The Session may have started stopping while it was re-ensured; a message must not revive it.
      if (record.status === 'stopping' || this.stoppingSessions.has(sessionId)) {
        throw new Error(`Session ${sessionId} is not running`)
      }
      // The Session may have been stopped by an operator while it was re-ensured; a message must not revive it either.
      const stoppedAfterEnsure = this.operatorStopRefusal(record)
      if (stoppedAfterEnsure !== undefined) throw new Error(`Session ${sessionId} is not running: ${stoppedAfterEnsure}`)
    }
    const token = this.tokens.get(sessionId) ?? this.issueToken(record)
    this.tokens.set(sessionId, token)
    const key = options.idempotencyKey ?? this.uniqueKey('message', sessionId)
    await this.options.node.send({ ...this.base(key), type: 'session.message', sessionId, text,
      sessionToken: token, ...(inputIds && inputIds.length ? { inputIds } : {}),
      ...(options.routerModel ? { routerModel: options.routerModel } : {}) })
    if (origin === 'operator' && !this.closed) {
      // The message itself is not copied into the audit: its size and its target are the facts worth keeping.
      this.audit.record({ actor: 'operator', kind: 'session', action: 'message', targetKind: 'session',
        targetId: sessionId, detail: `${text.length} 字` })
    }
  }

  /**
   * Re-ensure a Session whose generation this kernel no longer trusts, before delivering a message to it.
   *
   * The PM and Worker paths reuse the public ensure entry points, so concurrency, idempotency keys, inspection and failure
   * handling stay exactly the ones already tested. A Worker without an Assignment cannot be recreated, so it is refused
   * rather than messaged into a Session that may not exist.
   */
  private async ensureForMessage(record: SessionRecord): Promise<void> {
    if (record.role === 'pm') {
      await this.openProject(record.projectId)
      return
    }
    if (record.role === 'router') {
      // The Router is re-ensured under its own id, so a node that came back without it gets the same Session again.
      await this.ensureRouter()
      return
    }
    if (record.role !== 'worker') return
    const assignmentId = record.assignmentId
    if (assignmentId === undefined || assignmentId === '') {
      throw new SessionEnsureError(`The Worker Session ${record.sessionId} has no Assignment to re-ensure`)
    }
    // The Ticket only names the Worker's title and prompt; an Assignment whose Ticket is gone still has an id to use.
    const ticket = this.ticketOfAssignment(assignmentId)
    if (ticket?.projectId === undefined && ticket?.id === record.projectId) {
      await this.createAssignmentWorker(undefined, assignmentId, ticket.id, this.taskPrompt(ticket))
      return
    }
    await this.createWorkerSession(record.projectId, assignmentId, ticket?.id ?? assignmentId)
  }

  /**
   * Stop one Session on the node.
   *
   * A Session whose creation is still in flight must not outlive the stop: the node applies a cancel to a Session that does
   * not exist yet, and the create that follows brings the Worker back. The creation is therefore awaited first, bounded;
   * one that outlives the bound leaves the stop unconfirmed — the cancel still goes out and is repeated once the creation
   * settles, so the Worker cannot come back after the stop, and the caller is told the stop is not confirmed. A creation
   * that timed out is not a creation that ended: the node may still be bringing that Worker up.
   *
   * The Session is marked as stopping before the node is asked, so no message and no re-ensure brings it back while the
   * node is stopping it. The mark is this kernel's own transient fact, not the Session's status: a stop that did not happen
   * takes it back, so a Session whose stop was refused stays a Session that may be messaged and re-ensured, and the old
   * management route keeps working on it.
   *
   * A Session this kernel never created has nothing to stop: its Worker never ran, so the stop is confirmed at once.
   */
  async cancelSession(sessionId: string, reason?: string, actor: AuditActor = 'operator'): Promise<void> {
    this.requireNodeOnline()
    const record = this.sessions.get(sessionId)
    // A Session that was never created has no Worker behind it, so there is nothing to stop.
    if (!record) return
    // A Session whose lifecycle is over needs no mark: it will not be brought back by anything.
    const marked = !SESSION_TERMINAL.has(record.status)
    if (marked) this.stoppingSessions.add(sessionId)
    const pending = this.pendingEnsures.get(sessionId)
    let unconfirmed = false
    if (pending) {
      const settled = await this.settlePendingEnsure(pending)
      if (settled.state === 'pending') {
        unconfirmed = true
        // The creation may still complete: the cancel is repeated once it settles, so the Worker cannot come back.
        const epoch = this.sessionEpoch(sessionId)
        const repeat = (): void => { void this.repeatStop(sessionId, reason, epoch).catch(() => {}) }
        void pending.then(repeat, repeat)
      }
    }
    try {
      await this.stopSession(sessionId, reason)
    } catch (error) {
      // The node refused the stop: the Session is not stopping after all, so the mark is taken back.
      if (marked) this.stoppingSessions.delete(sessionId)
      throw error
    }
    if (unconfirmed) {
      throw new Error(`The Worker Session ${sessionId} was still being created, so its stop is not confirmed`)
    }
    this.audit.record({ actor, kind: 'session', action: 'cancelled', targetKind: 'session', targetId: sessionId,
      outcome: 'ok', detail: record.role })
  }

  /**
   * Wait for a Session's creation to settle, bounded.
   *
   * A creation that failed still settles the order: the cancel that follows is sent after the create was answered, so the
   * Worker cannot come back after it. Only a creation that outlives the bound leaves the order open.
   */
  private async settlePendingEnsure(pending: Promise<unknown>,
    timeoutMs = this.options.ensureSettleTimeoutMs ?? ENSURE_SETTLE_TIMEOUT_MS):
    Promise<{ state: 'settled' } | { state: 'pending' }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'pending'>(resolve => {
      timer = setTimeout(() => resolve('pending'), timeoutMs)
      timer.unref?.()
    })
    const settled = pending.then(() => 'ok' as const, () => 'ok' as const)
    try {
      const result = await Promise.race([settled, expired])
      return result === 'pending' ? { state: 'pending' } : { state: 'settled' }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      void pending.catch(() => {})
    }
  }

  /** Ask the node to stop one Session; the command's own answer is the node's confirmation. */
  private async stopSession(sessionId: string, reason?: string): Promise<void> {
    await this.options.node.send({ ...this.base(this.uniqueKey('cancel', sessionId)), type: 'session.cancel', sessionId,
      ...(reason ? { reason } : {}) })
  }

  /**
   * Cancel one Session again, unless a resume took it away in the meantime.
   *
   * A stop whose creation was still in flight repeats its cancel once that creation settles, so the Session cannot come
   * back after the stop. A resume that happened in between owns the Session now: the late cancel must not stop it. The
   * epoch is what tells the two apart — the resume advances it, and the repeat only fires while it is unchanged.
   */
  private async repeatStop(sessionId: string, reason: string | undefined, epoch: number): Promise<void> {
    if (this.sessionEpoch(sessionId) !== epoch) return
    await this.stopSession(sessionId, reason)
  }

  /** How many times one Session was resumed: a cancel of an older stop may not reach it any more. */
  private sessionEpoch(sessionId: string): number {
    return this.sessionEpochs.get(sessionId) ?? 0
  }

  /** Advance the epoch of one Session, so the cancels of the stops before it are known to be stale. */
  private advanceSessionEpoch(sessionId: string): void {
    this.sessionEpochs.set(sessionId, this.sessionEpoch(sessionId) + 1)
  }

  /**
   * Archive a Session and record the node's completed fact.
   *
   * The node acknowledges only after the archive happened, so a lost `session.status` event must not leave the
   * control plane reporting the old `idle` status. A failed command throws before anything is recorded.
   */
  async archiveSession(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId)
    this.requireNodeOnline()
    await this.options.node.send({ ...this.base(this.uniqueKey('archive', sessionId)), type: 'session.archive', sessionId })
    if (record.status === 'archived') return
    const at = this.now()
    record.status = 'archived'
    record.archivedAt = at
    record.updatedAt = at
    this.persist(record)
    this.audit.record({ actor: 'operator', kind: 'session', action: 'archived', targetKind: 'session',
      targetId: sessionId, detail: record.role })
  }

  async setPermission(sessionId: string, permission: string): Promise<void> {
    this.requireSession(sessionId)
    this.requireNodeOnline()
    await this.options.node.send({ ...this.base(this.uniqueKey('permission', sessionId)), type: 'permission.set', sessionId, permission })
    this.audit.record({ actor: 'operator', kind: 'session', action: 'permission', targetKind: 'session',
      targetId: sessionId, detail: permission })
  }

  /**
   * Send an operator's message to a Session, by the role that Session has.
   *
   * A PM Session receives the message directly: it is the agent that manages the Project, and the message is a fact of
   * the work it decides about. A Worker Session does not: a message that reaches a Worker outside its Ticket is a fact
   * the domain never holds, so the message becomes an Input of the Ticket the Worker runs, and the domain delivers it the
   * way it delivers every other message.
   *
   * The message is bound to the Session it was written for. A Worker Session a newer Assignment replaced cannot receive
   * a message: the message would reach the Worker that took its place, so it is refused with the conflict the operator
   * needs to see, and nothing is written to the Ticket. The Session's own Assignment must still be the Ticket's current
   * one, and the domain checks that inside the transaction that stores the message, so a re-dispatch that happens at the
   * same moment cannot slip between the check and the write.
   *
   * The answer says what really happened. A message that reached a running Worker waits for the node's own confirmation:
   * a message the node refused never reached the Worker, so the answer says that instead of claiming a delivery.
   */
  async sendToSession(sessionId: string, text: string, options: { assignmentId?: string } = {}):
    Promise<{ via: 'session' | 'ticket'; delivered: string; inputId?: string }> {
    const record = this.requireSession(sessionId)
    if (record.revokedAt) {
      throw new OperatorError(409, `The Session ${sessionId} was revoked; it cannot receive a message any more`)
    }
    // A Session an operator stopped takes no message: the console is told the same fact, so it does not offer the
    // action in the first place.
    const stopped = this.operatorStopRefusal(record)
    if (stopped !== undefined) {
      throw new OperatorError(409, `The Session ${sessionId} cannot receive a message: ${stopped}`)
    }
    if (record.role === 'pm') {
      await this.sendMessage(sessionId, text, undefined, 'operator')
      return { via: 'session', delivered: 'session' }
    }
    if (record.role === 'worker') {
      const assignmentId = record.assignmentId
      if (!assignmentId) {
        throw new OperatorError(409, `The Worker Session ${sessionId} has no Assignment; there is nothing to deliver a message to`)
      }
      if (options.assignmentId !== undefined && options.assignmentId !== assignmentId) {
        throw new OperatorError(409,
          `This message names Assignment ${options.assignmentId}, but the Session ${sessionId} runs ${assignmentId}`)
      }
      // A Session that is over cannot receive a message: its Worker is gone, and the message would wait for a Worker that
      // will never read it. The console is told the same fact, so it does not offer the action in the first place.
      const refusal = this.sessionDeliveryRefusal(record)
      if (refusal !== undefined) {
        throw new OperatorError(409, `The Worker Session ${sessionId} cannot receive a message: ${refusal}`)
      }
      const ticket = this.ticketOfAssignment(assignmentId)
      if (!ticket) {
        throw new OperatorError(409, `The Worker Session ${sessionId} has no Ticket; there is nothing to deliver a message to`)
      }
      const result = this.engine.messageTicketTo(ticket.id, text, {
        assignmentId,
        standalone: ticket.projectId === undefined,
        // The message is an Input of its own: two messages a person wrote on purpose are two Inputs, even when their
        // words are the same.
        inputId: key('input', ticket.id, 'note', 'operator', randomUUID()),
      })
      // The message itself is not copied into the audit: its size and its target are the facts worth keeping.
      const delivery = await this.confirmTicketDelivery(assignmentId, result.inputId, result.delivered)
      this.audit.record({ actor: 'operator', kind: 'session', action: 'message', targetKind: 'session',
        targetId: sessionId, outcome: delivery.delivered === 'failed' ? 'failed' : 'ok', detail: `${text.length} 字` })
      if (delivery.delivered === 'failed') {
        throw new OperatorError(502, `The node did not take the message: ${delivery.error ?? 'the delivery was refused'}`)
      }
      return { via: 'ticket', delivered: delivery.delivered, inputId: result.inputId }
    }
    throw new OperatorError(409, `The Session ${sessionId} cannot receive an operator message`)
  }

  /**
   * Wait for the node's answer about one message, and report what really happened.
   *
   * A message that reached a running Assignment is delivered by the Executor in the background: the answer a person sees
   * must wait for the node's own confirmation, because a message the node refused never reached the Worker. The wait is
   * bounded, so a node that never answers cannot hold the request open.
   *
   * A message that is only queued keeps its own answer: nothing was delivered yet, and the Input waits among the Ticket's
   * undelivered ones until a Worker can take it.
   */
  private async confirmTicketDelivery(assignmentId: string, inputId: string,
    delivered: TicketMessageDelivery): Promise<{ delivered: TicketMessageDelivery; error?: string }> {
    if (delivered !== 'running') return { delivered }
    const inFlight = this.executor.deliveryOf(assignmentId, inputId)
    if (!inFlight) return { delivered: 'failed', error: 'the node did not confirm delivery of this message' }
    const outcome = await this.settleDeliveryOutcome(inFlight.outcome)
    if (outcome.delivered) return { delivered }
    return { delivered: 'failed', ...(outcome.error === undefined ? {} : { error: redact(outcome.error).slice(0, 300) }) }
  }

  /** The outcome of one delivery, bounded: a node that never answers cannot hold the request open. */
  private async settleDeliveryOutcome(outcome: Promise<DeliveryOutcome>,
    timeoutMs = this.options.deliveryConfirmTimeoutMs ?? DELIVERY_CONFIRM_TIMEOUT_MS): Promise<DeliveryOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<DeliveryOutcome>(resolve => {
      timer = setTimeout(() => resolve({ delivered: false, error: `the node did not answer within ${timeoutMs} ms` }), timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([outcome, expired])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Stop a Session, by the role that Session has.
   *
   * A Worker Session is stopped through its Ticket: the Assignment ends in the domain, the node is asked to stop the
   * Worker, and the answer decides whether the Worker is really gone. It is a person's stop: the domain records it under
   * the `worker` scope, so only a person may approve the resume.
   *
   * A PM or Router Session is stopped on its own: its Project, Tickets, Workers and PM Mandates stay exactly as they
   * were. Stopping a PM is not a decision about its Project and not a revocation — only an explicit resume brings it back.
   *
   * The stop and the resume of one Session are ordered, so the cancel a stop repeats after its creation settled cannot
   * reach the Session a resume brought back.
   */
  async stopSessionByOperator(sessionId: string, reason?: string):
    Promise<{ stopped: boolean; scope: 'session' | 'assignment'; confirmed: boolean; error?: string }> {
    const record = this.requireSession(sessionId)
    if (record.role === 'worker') {
      return this.withSessionOperation(sessionId, async () => {
        const current = this.requireSession(sessionId)
        if (current.assignmentId === undefined) {
          throw new OperatorError(409, `The Worker Session ${sessionId} has no Assignment; there is nothing to stop`)
        }
        // A Worker Session whose Assignment no Ticket owns has no domain work behind it: only the node Session is left
        // to stop, and the domain keeps whatever it has.
        const owned = this.ticketOfAssignment(current.assignmentId)
        const outcome = owned
          ? await this.stopWorkerAssignment(current.assignmentId, reason ?? 'An operator stopped this Worker',
            { stale: 'cancel' })
          : await this.stopOrphanWorkerSession(current, reason ?? 'An operator stopped this Worker')
        this.audit.record({ actor: 'operator', kind: 'session', action: 'stopped', targetKind: 'session', targetId: sessionId,
          outcome: outcome.stopped ? 'ok' : 'failed', detail: 'worker' })
        this.noticeWorkerStop({ sessionId, assignmentId: current.assignmentId, ticket: owned },
          outcome, 'assignment')
        return { stopped: outcome.stopped, scope: 'assignment', confirmed: outcome.stopped,
          ...(outcome.error ? { error: outcome.error } : {}) }
      })
    }
    if (record.role !== 'pm' && record.role !== 'router') {
      throw new OperatorError(409, `The Session ${sessionId} cannot be stopped by an operator`)
    }
    return this.withSessionOperation(sessionId, async () => {
      const current = this.requireSession(sessionId)
      const outcome = await this.stopManagerSession(current, reason ?? 'An operator stopped this Session')
      this.audit.record({ actor: 'operator', kind: 'session', action: 'stopped', targetKind: 'session', targetId: sessionId,
        outcome: outcome.stopped ? 'ok' : 'failed', detail: current.role })
      this.noticeManagerStop(current, outcome)
      return { stopped: outcome.stopped, scope: 'session', confirmed: outcome.stopped,
        ...(outcome.error ? { error: outcome.error } : {}) }
    })
  }

  /**
   * Interrupt the Session's current turn, and only that turn.
   *
   * An interrupt is not a stop. The Session keeps its identity, its authority, its Assignment and its Ticket; the
   * messages that wait for the next turn stay in the Session's inbox; no Project, Ticket or Assignment changes; and no
   * other Session is touched. A Worker a newer Assignment replaced is refused, because the domain — not this kernel —
   * decides which Worker may still work.
   *
   * The node is asked to end the turn that runs now, and it confirms only after it saw that turn end. A node that does
   * not offer the interrupt is told so plainly, and a node that already runs another turn refuses: a turn that started
   * after the operator's request is not the turn the operator asked about.
   *
   * `turn` names the turn the caller believes is running. A turn that started in the meantime is not that turn, so the
   * request is refused instead of ending the wrong one: the target of one round never drifts into the next.
   */
  async interruptSessionByOperator(sessionId: string, reason?: string, turn?: number): Promise<InterruptOutcome> {
    const outcome = await this.interruptTurn(sessionId, reason, turn)
    if (outcome.refusal === 'no-running-turn') {
      throw new OperatorError(409, `The Session ${sessionId} has no running turn the control plane knows of`)
    }
    if (outcome.refusal === 'unsupported') {
      throw new OperatorError(409, `The node ${this.options.nodeId} cannot interrupt a turn: it does not offer `
        + `"${NODE_CAPABILITY_TURN_INTERRUPT}"`)
    }
    if (outcome.refusal === 'stopped') {
      throw new OperatorError(409, `The Session ${sessionId} was stopped by an operator and has no turn to interrupt`)
    }
    if (outcome.refusal === 'revoked') {
      throw new OperatorError(409, `The Session ${sessionId} was revoked and has no turn to interrupt`)
    }
    if (outcome.refusal === 'replaced') {
      throw new OperatorError(409, `The Session ${sessionId} cannot be interrupted: ${outcome.error ?? 'its Assignment was replaced'}`)
    }
    this.audit.record({ actor: 'operator', kind: 'session', action: 'interrupted', targetKind: 'session',
      targetId: sessionId, outcome: outcome.interrupted ? 'ok' : 'failed',
      detail: outcome.turn === undefined ? 'session' : `turn ${outcome.turn}` })
    return outcome
  }

  /**
   * Interrupt one turn, and report what really happened.
   *
   * The refusal kinds are what a caller needs: "there was no turn", "the node cannot do this", "the Session is gone".
   * Everything else is the node's own answer, and it is reported as it came.
   */
  private async interruptTurn(sessionId: string, reason?: string, asked?: number): Promise<InterruptOutcome> {
    const record = this.requireSession(sessionId)
    if (record.revokedAt) {
      return { interrupted: false, confirmed: false, refusal: 'revoked', error: 'The Session was revoked' }
    }
    if (record.role === 'worker' && record.assignmentId !== undefined) {
      // The Ticket decides whether this Worker may still run: a Worker a newer Assignment replaced is not interrupted,
      // and neither is the Worker of a Ticket that is over.
      const ticket = this.ticketOfAssignment(record.assignmentId)
      const latest = ticket === undefined ? undefined : latestAssignment(ticket)
      if (ticket !== undefined && (latest === undefined || latest.id !== record.assignmentId)) {
        return { interrupted: false, confirmed: false, refusal: 'replaced',
          error: `The Assignment ${record.assignmentId} was replaced by a newer one; this Session may not interrupt it` }
      }
      if (ticket?.ended) {
        return { interrupted: false, confirmed: false, refusal: 'replaced',
          error: `The Ticket ${ticket.id} has ended; this Session may not interrupt a turn` }
      }
    }
    const stopped = this.operatorStopRefusal(record)
    if (stopped !== undefined) {
      return { interrupted: false, confirmed: false, refusal: 'stopped', error: stopped }
    }
    if (!this.nodeSupportsTurnInterrupt()) {
      return { interrupted: false, confirmed: false, refusal: 'unsupported',
        error: `The node ${this.options.nodeId} does not offer "${NODE_CAPABILITY_TURN_INTERRUPT}"` }
    }
    const turn = this.sessionTurns.get(sessionId)
    if (turn === undefined) {
      return { interrupted: false, confirmed: false, refusal: 'no-running-turn',
        error: 'The Session has no running turn to interrupt' }
    }
    // The turn the caller named is the turn it wants to end. A turn that started in the meantime is another turn, and
    // ending it would interrupt work the operator never asked about.
    if (asked !== undefined && asked !== turn) {
      return { interrupted: false, confirmed: false,
        error: `The Session ${sessionId} runs turn ${turn}, not turn ${asked}; it was not interrupted` }
    }
    try {
      // The turn is named, so a node that already runs another turn refuses instead of ending that one.
      await this.options.node.send({ ...this.base(this.uniqueKey('interrupt', sessionId)), type: 'session.interrupt',
        sessionId, ...(reason ? { reason } : {}), turn })
    } catch (error) {
      return { interrupted: false, confirmed: false, error: redact(messageOf(error)).slice(0, 300) }
    }
    return { interrupted: true, confirmed: true, turn }
  }

  /**
   * Interrupt one Session's current turn, and say something next.
   *
   * The two are separate facts and the answer carries both. A turn that could not be interrupted does not swallow the
   * message: the message still goes out, in the round that follows. And a message that could not be delivered does not
   * undo the interrupt that worked — the turn really ended.
   *
   * A message to a Worker goes through its Ticket, so the domain keeps the record of it; a message to the Router joins
   * the Router's queue, where it waits for the turn that follows the one that was just ended.
   */
  async interruptAndSendToSession(sessionId: string, text: string,
    options: { reason?: string; attachments?: readonly RouterTextAttachment[]; model?: RouterModel; id?: string
      turn?: number } = {}): Promise<{ interrupt: InterruptOutcome; delivered: string }> {
    const record = this.requireSession(sessionId)
    const outcome = await this.interruptTurn(sessionId, options.reason, options.turn)
    this.audit.record({ actor: 'operator', kind: 'session', action: 'interrupted', targetKind: 'session',
      targetId: sessionId, outcome: outcome.interrupted ? 'ok' : 'failed',
      detail: outcome.turn === undefined ? record.role : `turn ${outcome.turn}` })
    const value = text.trim()
    if (value === '') return { interrupt: outcome, delivered: 'none' }
    if (record.role === 'router') {
      const queued = await this.sendToRouter(value, options.attachments ?? [], options.model,
        options.id === undefined ? {} : { id: options.id })
      // A message the fast router claimed did not join the queue: it was carried out by the control plane itself.
      if (queued.routed) return { interrupt: outcome, delivered: 'routed' }
      // The answer says what became of the message, in the queue's own words: a message that waits is queued, one the
      // node took is sent, one the node refused is failed, and one whose receipt is missing is unconfirmed.
      return { interrupt: outcome, delivered: queued.entry.state }
    }
    const sent = await this.sendToSession(sessionId, value)
    return { interrupt: outcome, delivered: sent.delivered }
  }

  /** Whether the node offers to interrupt one running turn of one Session. */
  private nodeSupportsTurnInterrupt(): boolean {
    const capabilities = this.nodes.get(this.options.nodeId)?.capabilities
    return Array.isArray(capabilities) && capabilities.includes(NODE_CAPABILITY_TURN_INTERRUPT)
  }

  /** Whether the node is known to be unreachable right now. */
  private nodeOffline(): boolean {
    return this.nodes.get(this.options.nodeId)?.online === false
  }

  /**
   * Why a Session an operator stopped may not be used, or undefined when it may.
   *
   * The marker is the control plane's own durable fact, so it survives a restart. An unconfirmed stop refuses just like a
   * confirmed one: the operator's intent is what holds, not the node's answer.
   */
  private operatorStopRefusal(record: SessionRecord): string | undefined {
    const stop = record.operatorStop
    if (!stop) return undefined
    return stop.state === 'confirmed'
      ? `the Session was stopped by an operator at ${stop.at}`
      : `the Session carries an operator stop from ${stop.at} that the node has not confirmed`
  }

  /**
   * Write the operator's stop of a Session, before the node is asked.
   *
   * Written first, so anything that arrives while the node is stopping the Session already finds it. A confirmed stop
   * is not turned back into an open one by a repeated request: the second request is another attempt at the same stop.
   */
  private markOperatorStop(record: SessionRecord, reason: string | undefined): OperatorStop {
    const existing = record.operatorStop
    const confirmed = existing !== undefined && existing.state === 'confirmed'
    const why = reason ?? existing?.reason
    const stop: OperatorStop = {
      at: confirmed && existing !== undefined ? existing.at : this.now(),
      by: 'operator',
      ...(why === undefined ? {} : { reason: why }),
      state: confirmed ? 'confirmed' : 'requested',
      ...(existing?.confirmedAt === undefined ? {} : { confirmedAt: existing.confirmedAt }),
      ...(existing?.error === undefined ? {} : { error: existing.error }),
    }
    record.operatorStop = stop
    record.updatedAt = this.now()
    // A new stop owns the Session's status once more: the reports of an older stop no longer apply to it.
    this.resumedSessions.delete(record.sessionId)
    this.persist(record)
    return stop
  }

  /**
   * Record that the node confirmed that the Session is gone.
   *
   * The node's answer to the cancel command is the confirmation, and so is a status that reports the Session as stopped
   * or archived. A node that acknowledged the stop without reporting a status is confirmed all the same: the receipt is
   * the node's own word, and its Session may still show `idle`. A later live status does not undo the confirmation.
   */
  private confirmOperatorStop(record: SessionRecord, at = this.now()): void {
    const stop = record.operatorStop
    if (!stop || stop.state === 'confirmed') return
    record.operatorStop = { ...stop, state: 'confirmed', confirmedAt: at }
    record.updatedAt = at
    this.persist(record)
  }

  /**
   * Record that a stop the node did not confirm failed, keeping the operator's intent open.
   *
   * The stop stays `requested` and keeps its diagnostic, so the console shows an open stop that can be retried. A
   * marker a resume took away in the meantime is not written back: the resume owns the Session now.
   */
  private failOperatorStop(record: SessionRecord, error: string | undefined): void {
    const stop = record.operatorStop
    if (!stop || error === undefined) return
    record.operatorStop = { ...stop, error }
    this.persist(record)
  }

  /**
   * Keep an operator's stop true after an ensure that was already in flight.
   *
   * An ensure that started before the stop reaches the node after the cancel and brings the Session back. The Session is
   * therefore stopped again before the caller hears anything: an ensure that answers with a Session a person stopped is
   * worse than one that fails.
   */
  private async enforceOperatorStop(record: SessionRecord): Promise<void> {
    const stop = record.operatorStop
    if (!stop) return
    try {
      await this.stopSession(record.sessionId, stop.reason ?? 'The Session was stopped by an operator')
      this.confirmOperatorStop(record)
    } catch {
      // The node did not take the second cancel either: the operator's intent stays recorded and open.
    }
    throw new OperatorError(409, `The Session ${record.sessionId} was stopped by an operator `
      + 'and has to be resumed explicitly before it may be used again')
  }

  /**
   * Stop a PM or Router Session on its own.
   *
   * The stop reaches that Session and nothing else. A creation that is still in flight is awaited first, bounded: a
   * cancel that reaches the node before the Session exists cancels nothing. The node's answer decides whether the stop
   * is confirmed; a refused, timed-out or lost answer keeps the operator's intent and its diagnostic.
   */
  private async stopManagerSession(record: SessionRecord, reason: string):
    Promise<{ stopped: boolean; error?: string }> {
    this.markOperatorStop(record, reason)
    const pending = this.pendingEnsures.get(record.sessionId)
    let unconfirmed = false
    if (pending) {
      const settled = await this.settlePendingEnsure(pending)
      if (settled.state === 'pending') {
        unconfirmed = true
        // The creation may still complete: the cancel is repeated once it settles, so the Session cannot come back.
        const epoch = this.sessionEpoch(record.sessionId)
        const repeat = (): void => { void this.repeatStop(record.sessionId, reason, epoch).catch(() => {}) }
        void pending.then(repeat, repeat)
      }
    }
    try {
      await this.stopSession(record.sessionId, reason)
    } catch (error) {
      const failure = redact(messageOf(error)).slice(0, 300)
      this.failOperatorStop(record, failure)
      return { stopped: false, error: failure }
    }
    if (unconfirmed) {
      const failure = `The Session ${record.sessionId} was still being created, so its stop is not confirmed`
      this.failOperatorStop(record, failure)
      return { stopped: false, error: failure }
    }
    this.confirmOperatorStop(record)
    return { stopped: true }
  }

  /**
   * Stop one Worker's Assignment, on the operator's word.
   *
   * The stop reaches the Assignment and nothing else: the Ticket stays open and the other Workers of the same Project keep
   * running. It is a person's stop, so the Project's PM may not revive that Worker on its own.
   */
  async stopAssignmentByOperator(assignmentId: string, reason?: string):
    Promise<{ stopped: boolean; scope: 'assignment'; confirmed: boolean; assignmentId: string; ticketId: string;
      error?: string }> {
    const outcome = await this.stopWorkerAssignment(assignmentId, reason ?? 'An operator stopped this Worker')
    this.audit.record({ actor: 'operator', kind: 'assignment', action: 'stopped', targetKind: 'assignment',
      targetId: assignmentId, outcome: outcome.stopped ? 'ok' : 'failed', detail: outcome.ticket.id })
    this.noticeWorkerStop({ sessionId: outcome.sessionId, assignmentId, ticket: outcome.ticket }, outcome, 'assignment')
    return { stopped: outcome.stopped, scope: 'assignment', confirmed: outcome.stopped, assignmentId,
      ticketId: outcome.ticket.id, ...(outcome.error ? { error: outcome.error } : {}) }
  }

  /**
   * Stop the node Session of a Worker no Ticket owns.
   *
   * There is no domain work behind that Assignment — the nominal entry point and the older protocol tests name
   * Assignments the domain never had — so only the node Session is left to stop. The operator's marker is written all
   * the same, and the node's own answer is the confirmation.
   */
  private async stopOrphanWorkerSession(record: SessionRecord, reason: string): Promise<{ stopped: boolean; error?: string }> {
    this.markOperatorStop(record, reason)
    try {
      await this.cancelSession(record.sessionId, reason)
    } catch (error) {
      const failure = redact(messageOf(error)).slice(0, 300)
      this.failOperatorStop(record, failure)
      return { stopped: false, error: failure }
    }
    this.confirmOperatorStop(record)
    return { stopped: true }
  }

  /**
   * The one stop of one Worker's Assignment, shared by both entries.
   *
   * The Session route and the Assignment route come here, so the two never keep two stop states of their own: the marker
   * on the Session, the `worker` stop on the Ticket and the open-stop facts are written once.
   *
   * The Assignment must still be the Ticket's current one, and the Session record is chosen inside the Ticket's own queue:
   * a record of an Assignment a newer one replaced is not marked, confirmed or notified here. An Assignment that already
   * ended is asked again — that is what turns an unconfirmed stop into a confirmed one — and the domain's own completion
   * facts are the ones that clear it.
   *
   * `stale: 'cancel'` keeps the Session route's own use: a Session whose Assignment was replaced still stops the node
   * Session that is left over, and the domain keeps the newer Assignment untouched.
   */
  private async stopWorkerAssignment(assignmentId: string, reason: string,
    options: { stale?: 'refuse' | 'cancel' } = {}): Promise<{
      stopped: boolean; error?: string; sessionId?: string; ticket: Ticket
    }> {
    const ticket = this.store.tickets.list().find(item => item.assignments.some(one => one.id === assignmentId))
    if (!ticket) throw new OperatorError(404, `There is no Assignment ${assignmentId}`)
    return this.withTicketOperation(ticket.id, async (): Promise<{
      stopped: boolean; error?: string; sessionId?: string; ticket: Ticket
    }> => {
      const current = this.store.tickets.get(ticket.id) ?? ticket
      const latest = latestAssignment(current)
      const sessionId = this.workerSessionFor(assignmentId)
      if (!latest || latest.id !== assignmentId) {
        if (options.stale !== 'cancel') {
          throw new OperatorError(409, `The Assignment ${assignmentId} is not the current one of Ticket ${current.id}; `
            + 'the Session of a replaced Assignment cannot stop the Worker that took its place')
        }
        // The Assignment this Session ran was replaced: only the node Session is left over, and stopping that is the
        // Session route's own use. The domain keeps the newer Assignment exactly as it is.
        const stale = this.sessions.get(sessionId)
        if (stale) this.markOperatorStop(stale, reason)
        try {
          await this.cancelSession(sessionId, reason)
        } catch (error) {
          const failure = redact(messageOf(error)).slice(0, 300)
          if (stale) this.failOperatorStop(stale, failure)
          return { stopped: false, error: failure, sessionId, ticket: current }
        }
        if (stale) this.confirmOperatorStop(stale)
        return { stopped: true, sessionId, ticket: current }
      }
      // The operator's intent is written before the node is asked: a message or an ensure that arrives in between must
      // find the Worker stopped.
      const record = this.sessions.get(sessionId)
      if (record) this.markOperatorStop(record, reason)
      const outcome = latest.state === 'ended'
        // The Assignment is already over: the node is asked again, and a confirmed stop clears the open facts.
        ? await this.settleStop(current.id, assignmentId, cleanups => {
          this.engine.reconfirmStoppedWorkerByOperator(current.id, assignmentId, { reason, cleanups })
        })
        : await this.settleStop(current.id, assignmentId, cleanups => {
          this.engine.stopAssignment(current.id, assignmentId, { confirmStop: true, cleanups })
        })
      if (record) {
        // The node's own answer is the confirmation: a stop that was not confirmed keeps the operator's intent open.
        if (outcome.stopped) this.confirmOperatorStop(record)
        else this.failOperatorStop(record, outcome.error)
      }
      return { ...outcome, sessionId, ticket: current }
    })
  }

  /**
   * Cancel a whole Ticket, on the operator's word.
   *
   * The stop reaches the Ticket: it ends, its Assignment ends with it, and the Worker Session is asked to stop. This is
   * the action that withdraws the Ticket's Mandate; the assignment stop is the narrower one that leaves the Ticket open.
   *
   * The stop shares the Ticket's own serial queue with the PM's re-dispatch and with the assignment stop, so a cleanup
   * never starts a second Worker over one that may still run.
   */
  async cancelTicketByOperator(ticketId: string, reason?: string):
    Promise<{ stopped: boolean; scope: 'ticket'; confirmed: boolean; ticketId: string; error?: string }> {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) throw new OperatorError(404, `There is no such Ticket ${ticketId}`)
    const outcome = await this.withTicketOperation(ticket.id, async (): Promise<{
      stopped: boolean; error?: string; sessionId?: string; assignmentId?: string; ticket: Ticket
    }> => {
      const current = this.store.tickets.get(ticket.id)
      if (!current) throw new OperatorError(404, `There is no such Ticket ${ticketId}`)
      // The Assignment and the Session record are chosen inside the Ticket's own queue: a Worker a newer Assignment
      // replaced must not be marked, confirmed or notified here.
      const assignment = latestAssignment(current)
      const sessionId = assignment ? this.workerSessionFor(assignment.id) : undefined
      // The operator's intent is written before the node is asked: a message or an ensure that arrives in between must
      // find the Worker stopped.
      const record = sessionId ? this.sessions.get(sessionId) : undefined
      if (record) this.markOperatorStop(record, reason ?? 'An operator cancelled this Ticket')
      let stopped = true
      let error: string | undefined
      if (current.ended) {
        // The Ticket is already over: only the node Session can be left over.
        if (sessionId && this.sessions.has(sessionId)) {
          await this.cancelSession(sessionId, reason ?? 'An operator cancelled this Ticket')
        }
      } else {
        const cleanups: { ticketId: string; work: Promise<void> }[] = []
        this.engine.stopTicket(ticket.id, reason ?? 'An operator cancelled this Ticket', cleanups)
        const work = cleanups[0]?.work
        if (work) {
          const settled = await this.settleStopWork(work)
          if (settled.state !== 'stopped') {
            stopped = false
            error = redact(settled.state === 'pending'
              ? `The Worker Session did not stop within ${this.options.stopCleanupTimeoutMs ?? STOP_CLEANUP_TIMEOUT_MS} ms`
              : settled.error).slice(0, 200)
          }
        }
      }
      if (record) {
        // The node's own answer is the confirmation: a stop that was not confirmed keeps the operator's intent open.
        if (stopped) this.confirmOperatorStop(record)
        else this.failOperatorStop(record, error)
      }
      return { stopped, ...(error === undefined ? {} : { error }), sessionId, assignmentId: assignment?.id, ticket: current }
    })
    this.audit.record({ actor: 'operator', kind: 'ticket', action: 'cancelled', targetKind: 'ticket', targetId: ticket.id,
      outcome: outcome.stopped ? 'ok' : 'failed', detail: ticket.title })
    this.noticeWorkerStop({ sessionId: outcome.sessionId, assignmentId: outcome.assignmentId, ticket: outcome.ticket },
      outcome, 'ticket')
    return { stopped: outcome.stopped, scope: 'ticket', confirmed: outcome.stopped, ticketId: ticket.id,
      ...(outcome.error ? { error: outcome.error } : {}) }
  }

  /**
   * Resume a Worker a person stopped, on the operator's explicit word.
   *
   * The resume clears the person's stop on the Ticket and nothing else: it starts no Worker and revives no Session. The
   * Project's PM decides on its next request whether the Ticket gets a new Assignment.
   *
   * A Worker whose stop the node never confirmed is not resumed: the old Worker may still run, and a new Assignment would
   * overlap it. The resume shares the Ticket's queue with the stop, so it never clears a stop that is still open.
   */
  async resumeTicketWorker(ticketId: string, reason?: string): Promise<{ ticket: Ticket; resumed: boolean }> {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) throw new OperatorError(404, `There is no such Ticket ${ticketId}`)
    return this.withTicketOperation(ticket.id, async () => {
      const current = this.store.tickets.get(ticketId) ?? ticket
      if (current.manualStop?.scope !== 'worker') {
        throw new OperatorError(409, `The Ticket ${ticketId} carries no Worker stop of a person to resume`)
      }
      if (current.stopPending || current.stopFailure) {
        const open = current.stopPending
          ? `the stop of Assignment ${current.stopPending.assignmentId} is still open`
          : (current.stopFailure?.error ?? 'the node did not confirm the stop')
        throw new OperatorError(409, `The Worker of Ticket ${ticketId} was not confirmed stopped (${open}); `
          + 'stop it again and wait for the node\'s confirmation before resuming it')
      }
      const cleared = this.engine.allowResume(ticketId)
      this.audit.record({ actor: 'operator', kind: 'ticket', action: 'resumed', targetKind: 'ticket', targetId: ticketId,
        detail: `${cleared.title}${reason ? ` · ${reason}` : ''}` })
      return { ticket: cleared, resumed: true }
    })
  }

  /**
   * Resume a PM or Router Session an operator stopped, on the operator's explicit word.
   *
   * The resume is a separate act that needs the operator's authority: nothing else clears the marker. The Session keeps
   * everything it had — role, Project, Assignment, permission boundary — and only its credential changes: the token
   * generation advances by two, so the token that was in circulation during the stop opens nothing afterwards.
   *
   * Only a confirmed stop is resumed: a stop the node refused or never answered leaves a Worker that may still run, and a
   * new Session over that one would overlap it. The resume shares the Session's queue with the stop, so a late cancel
   * cannot reach the Session it brings back. A resume that cannot bring the Session back keeps the stop.
   */
  async resumeSessionByOperator(sessionId: string, reason?: string):
    Promise<{ resumed: boolean; session: SessionRecord; tokenVersion: number }> {
    const selected = this.requireSession(sessionId)
    if (selected.revokedAt) {
      throw new OperatorError(409, `The Session ${sessionId} was revoked; a revoked Session cannot be resumed`)
    }
    if (selected.role === 'worker') {
      throw new OperatorError(409, `A Worker Session is not resumed on its own: resume its Ticket, `
        + 'which lets the Project PM start a new Assignment')
    }
    if (!selected.operatorStop) {
      throw new OperatorError(409, `The Session ${sessionId} was not stopped by an operator; there is nothing to resume`)
    }
    return this.withSessionOperation(sessionId, async () => {
      const record = this.requireSession(sessionId)
      if (record.revokedAt) {
        throw new OperatorError(409, `The Session ${sessionId} was revoked; a revoked Session cannot be resumed`)
      }
      const stop = record.operatorStop
      // The same Session must still carry the stop the operator asked to undo: another stop or resume changed it, so
      // this one fails closed instead of undoing somebody else's decision.
      if (!stop) {
        throw new OperatorError(409, `The Session ${sessionId} was not stopped by an operator; there is nothing to resume`)
      }
      if (stop.state !== 'confirmed') {
        const open = stop.error ?? 'the node did not confirm the stop'
        throw new OperatorError(409, `The Session ${sessionId} was not confirmed stopped (${open}); `
          + 'stop it again and wait for the node\'s answer before resuming it')
      }
      if (record.role === 'pm') {
        const project = this.store.projects.get(record.projectId)
        if (!project) throw new OperatorError(404, `Unknown project ${record.projectId}`)
        // A Project that is over gets no PM back: it would leave a Session behind that no work will ever use.
        if (project.status === 'ended' || project.status === 'archived') {
          throw new OperatorError(409, `This Project is ${project.status}; its PM Session cannot be resumed`)
        }
      }
      const at = this.now()
      // The cancels of the stops before this one are stale from now on: a late cancel must not stop the Session again.
      this.advanceSessionEpoch(sessionId)
      // A report of the stop that came before this resume is about the old lifecycle and must not stop the Session again.
      this.resumedSessions.add(sessionId)
      delete record.operatorStop
      // The credential of the stopped Session is retired: the resume brings a new one, and the old one opens nothing.
      record.tokenVersion = (record.tokenVersion ?? 0) + 2
      record.updatedAt = at
      this.persist(record)
      this.audit.record({ actor: 'operator', kind: 'session', action: 'resumed', targetKind: 'session', targetId: sessionId,
        detail: `${record.role}${reason ? ` · ${reason}` : ''}` })
      try {
        // The Session comes back under its own id, with the token generation the resume just retired.
        const session = record.role === 'router'
          ? await this.ensureRouterWith({ resume: true })
          : await this.openProjectWith(record.projectId, undefined, { resume: true })
        if (session.status === 'stopped' || session.status === 'archived') {
          throw new OperatorError(409, `The node did not bring the Session ${sessionId} back; it still reports it as ${session.status}`)
        }
        return { resumed: true, session, tokenVersion: record.tokenVersion ?? 0 }
      } catch (error) {
        // The resume failed: the Session stays stopped, with the operator's own stop on it.
        record.operatorStop = stop
        record.updatedAt = this.now()
        this.persist(record)
        throw error
      }
    })
  }

  /**
   * The logical superior of stopped work: the PM of the Project it belongs to, the Router for work that belongs to no
   * Project, and the operator for the Router's own Session.
   *
   * Derived from the stopped work itself, never from a request body, so a notice can never be addressed to a Session
   * that has no business reading it.
   */
  private superiorOf(record: SessionRecord): { kind: string; id?: string } {
    if (record.role === 'router') return { kind: 'operator' }
    if (record.role === 'pm') return { kind: 'router', id: ROUTER_SESSION_ID }
    return this.superiorOfTicket(record.assignmentId ? this.ticketOfAssignment(record.assignmentId) : undefined)
  }

  /** The logical superior of one Ticket's work: its Project's PM, or the Router for a Ticket that belongs to none. */
  private superiorOfTicket(ticket: Ticket | undefined): { kind: string; id?: string } {
    if (!ticket || ticket.projectId === undefined) return { kind: 'router', id: ROUTER_SESSION_ID }
    const pmSessionId = this.store.projects.get(ticket.projectId)?.pmSessionId
    return pmSessionId === undefined ? { kind: 'operator' } : { kind: 'pm', id: pmSessionId }
  }

  /**
   * The work of one Project that a stop did not touch, as the ids a notice carries: that Project's own Tickets and their
   * Worker Sessions, and nothing of another Project.
   */
  private unaffectedWorkOf(projectId: string | undefined, excludeTicketId?: string): string[] {
    if (projectId === undefined) return []
    const items: string[] = []
    for (const ticket of this.store.tickets.list()) {
      if (ticket.projectId !== projectId || ticket.id === excludeTicketId) continue
      items.push(ticket.id)
      const assignment = latestAssignment(ticket)
      if (assignment) items.push(this.workerSessionFor(assignment.id))
    }
    return items
  }

  /** The standalone Tickets the Router owns: its own subtasks, which belong to no Project. */
  private standaloneTicketsOf(): string[] {
    return this.store.tickets.list().filter(ticket => ticket.projectId === undefined).map(ticket => ticket.id)
  }

  /**
   * Write the notice of a stopped PM or Router Session, for the logical superior: the Session, the scope, what it
   * affected, what it left running and the operator — and nothing beyond that Project.
   */
  private noticeManagerStop(record: SessionRecord, outcome: { stopped: boolean; error?: string }): void {
    const project = record.role === 'pm' ? this.store.projects.get(record.projectId) : undefined
    const unaffected = record.role === 'pm'
      ? this.unaffectedWorkOf(record.projectId)
      : this.standaloneTicketsOf()
    this.recordStopNotice({
      target: { kind: 'session', id: record.sessionId, sessionId: record.sessionId },
      scope: 'session',
      state: outcome.stopped ? 'confirmed' : 'requested',
      actor: 'operator',
      ...(project === undefined ? {} : { projectId: project.id }),
      affected: [record.sessionId],
      unaffected,
      superior: this.superiorOf(record),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    })
  }

  /**
   * Write the notice of a stopped Worker, for the logical superior of its work: the Assignment or the Ticket that was
   * stopped, the Session that was asked to stop, the work that keeps running and the operator.
   */
  private noticeWorkerStop(target: { sessionId?: string; assignmentId?: string; ticket?: Ticket },
    outcome: { stopped: boolean; error?: string }, scope: 'assignment' | 'ticket'): void {
    const ticket = target.ticket
    const affected: string[] = []
    if (target.sessionId !== undefined) affected.push(target.sessionId)
    if (target.assignmentId !== undefined) affected.push(target.assignmentId)
    if (scope === 'ticket' && ticket !== undefined) affected.push(ticket.id)
    this.recordStopNotice({
      target: { kind: scope, id: scope === 'ticket' && ticket !== undefined
        ? ticket.id : (target.assignmentId ?? target.sessionId ?? ''),
        ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }) },
      scope,
      state: outcome.stopped ? 'confirmed' : 'requested',
      actor: 'operator',
      ...(ticket?.projectId === undefined ? {} : { projectId: ticket.projectId }),
      affected,
      unaffected: this.unaffectedWorkOf(ticket?.projectId, ticket?.id),
      superior: this.superiorOfTicket(ticket),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    })
  }

  /**
   * Write one notice about a stop, for the logical superior of the stopped work.
   *
   * The notice is the control plane's own durable fact: it lives in the console's own file, so it survives a restart and
   * stays queryable long after the Session it is about is gone. Nothing else is written with it.
   */
  private recordStopNotice(notice: {
    target: { kind: string; id: string; sessionId?: string }
    scope: string
    state: 'requested' | 'confirmed'
    actor: string
    projectId?: string
    affected: string[]
    unaffected: string[]
    superior: { kind: string; id?: string }
    error?: string
  }): StopNotice {
    const at = this.now()
    const id = this.consoleStore.addStopNotice({ at, targetKind: notice.target.kind, targetId: notice.target.id,
      sessionId: notice.target.sessionId ?? '', scope: notice.scope, state: notice.state, actor: notice.actor,
      projectId: notice.projectId ?? '', affected: JSON.stringify(notice.affected),
      unaffected: JSON.stringify(notice.unaffected), superiorKind: notice.superior.kind,
      superiorId: notice.superior.id ?? '', error: notice.error ?? '' })
    return { id, at, target: notice.target, scope: notice.scope, state: notice.state, actor: notice.actor,
      ...(notice.projectId === undefined ? {} : { projectId: notice.projectId }), affected: notice.affected,
      unaffected: notice.unaffected, superior: notice.superior,
      ...(notice.error === undefined ? {} : { error: notice.error }) }
  }

  /**
   * The notices about stops, as the console and the logical superior read them.
   *
   * The filter is what keeps one Project's notice out of another Project's PM: a superior reads the notices meant for
   * it, and the operator reads them all.
   */
  stopNotices(options: { limit?: number; superiorKind?: string; superiorId?: string; projectId?: string } = {}): StopNotice[] {
    return this.consoleStore.stopNotices(options).map(row => this.stopNoticeView(row))
  }

  /**
   * Every operator stop this control plane holds, as the console reads it.
   *
   * The view joins what the Session record knows (who stopped it, when, and whether the node confirmed it) with what
   * the notice knows (what the stop reached and what it left running). A Session that is gone leaves its stop behind:
   * the fact outlives the Session it is about.
   */
  stopViews(): SessionStopView[] {
    return this.stopNotices({ limit: 500 }).map(notice => {
      const record = notice.target.sessionId === undefined ? undefined : this.sessions.get(notice.target.sessionId)
      return {
        sessionId: notice.target.sessionId ?? notice.target.id,
        role: record?.role ?? '',
        scope: notice.scope as SessionStopView['scope'],
        state: notice.state as SessionStopView['state'],
        at: notice.at,
        by: notice.actor,
        affected: notice.affected,
        unaffected: notice.unaffected,
        ...(notice.error === undefined ? {} : { error: notice.error }),
      }
    })
  }

  /** One notice, as the console reads it. */
  private stopNoticeView(row: StopNoticeRow): StopNotice {
    return { id: row.id, at: row.at,
      target: { kind: row.targetKind, id: row.targetId, ...(row.sessionId === '' ? {} : { sessionId: row.sessionId }) },
      scope: row.scope, state: row.state, actor: row.actor,
      ...(row.projectId === '' ? {} : { projectId: row.projectId }),
      affected: this.stringListOf(row.affected), unaffected: this.stringListOf(row.unaffected),
      superior: { kind: row.superiorKind, ...(row.superiorId === '' ? {} : { id: row.superiorId }) },
      ...(row.error === '' ? {} : { error: row.error }) }
  }

  /** A stored list of ids, read back as ids; a broken row is an empty list rather than a failure. */
  private stringListOf(value: string): string[] {
    const parsed = this.parseJson(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  }

  /**
   * Stop one Worker's Assignment and wait for the node to confirm it.
   *
   * The Assignment ends in the domain and the node is asked to stop the Session; the answer decides whether the Worker is
   * really gone. A Worker whose Assignment is already over only has the node Session left to stop.
   *
   * The stop is a person's stop: the domain records it under the `worker` scope, so the Project's PM may not revive that
   * Worker on its own and an automatic retry may not replace it.
   */
  private async stopWorkerSession(record: SessionRecord, reason: string): Promise<{ stopped: boolean; error?: string }> {
    const assignmentId = record.assignmentId
    const ticket = assignmentId ? this.ticketOfAssignment(assignmentId) : undefined
    if (!ticket || !assignmentId) {
      // No Assignment behind this Session: there is no domain work to stop, only the node Session.
      await this.cancelSession(record.sessionId, reason)
      return { stopped: true }
    }
    // The stop and a re-dispatch of the same Ticket never overlap: they share the Ticket's own serial queue.
    return this.withTicketOperation(ticket.id, async (): Promise<{ stopped: boolean; error?: string }> => {
      const current = this.store.tickets.get(ticket.id) ?? ticket
      const latest = latestAssignment(current)
      if (!latest || latest.id !== assignmentId || latest.state === 'ended') {
        // The Assignment this Session ran is over or was replaced: only the node Session can be left over.
        await this.cancelSession(record.sessionId, reason)
        return { stopped: true }
      }
      return this.settleStop(ticket.id, assignmentId, cleanups => {
        this.engine.stopAssignment(ticket.id, assignmentId, { confirmStop: true, cleanups })
      })
    })
  }

  /**
   * Archive a Session, by the role that Session has.
   *
   * Archiving a Session that still runs its work would leave the domain behind: a Worker whose Assignment is still
   * running, or a Project that still expects its PM. Both are refused with the reason, so the operator stops the work
   * first and archives afterwards.
   */
  async archiveSessionByOperator(sessionId: string): Promise<{ archived: boolean; scope: string }> {
    const record = this.requireSession(sessionId)
    if (record.role === 'worker') {
      const assignment = record.assignmentId ? this.assignmentFacts(record.assignmentId) : undefined
      if (assignment && assignment.state !== 'ended') {
        throw new OperatorError(409, 'This Worker still runs its Assignment; stop it before archiving the Session')
      }
    }
    if (record.role === 'pm') {
      const project = this.store.projects.get(record.projectId)
      if (project && project.status === 'active') {
        throw new OperatorError(409, 'This Project is still active; stop or archive the Project before archiving its PM Session')
      }
    }
    await this.archiveSession(sessionId)
    return { archived: true, scope: record.role }
  }

  /**
   * Revoke a Session's authority, for good.
   *
   * The Session's token generation advances by two, so the token the Session holds now falls two generations behind: the
   * ordinary tool routes refuse it, and the refresh route's one-generation grace does not reach it either. The record is
   * marked revoked and persisted, so no later ensure, no later refresh and no later message may issue a new token for
   * it: a revocation that a re-ensure could undo would not be a revocation at all.
   *
   * The Session stops as well, because a Session that keeps running with an authority nobody granted it would leave work
   * behind that the domain still waits for. A Worker's Assignment ends through its Ticket; a PM Session is stopped on the
   * node, and its Project is left as it is for the operator to stop or archive.
   */
  async revokeSession(sessionId: string, reason?: string): Promise<
    { revoked: boolean; alreadyRevoked: boolean; tokenVersion: number; stopped: boolean; error?: string }> {
    const record = this.requireSession(sessionId)
    if (record.revokedAt) {
      return { revoked: true, alreadyRevoked: true, tokenVersion: record.tokenVersion ?? 0, stopped: true }
    }
    record.tokenVersion = (record.tokenVersion ?? 0) + 2
    record.revokedAt = this.now()
    record.revokedReason = reason
    this.persist(record)
    this.audit.record({ actor: 'operator', kind: 'session', action: 'revoked', targetKind: 'session', targetId: sessionId,
      detail: `${record.role}${reason ? ` · ${reason}` : ''}` })
    let stopped = true
    let error: string | undefined
    try {
      if (record.role === 'worker') {
        const outcome = await this.stopWorkerSession(record, reason ?? 'The Session was revoked')
        stopped = outcome.stopped
        error = outcome.error
      } else {
        await this.cancelSession(sessionId, reason ?? 'The Session was revoked')
      }
    } catch (failure) {
      stopped = false
      error = redact(messageOf(failure)).slice(0, 300)
    }
    return { revoked: true, alreadyRevoked: false, tokenVersion: record.tokenVersion, stopped,
      ...(error === undefined ? {} : { error }) }
  }

  /**
   * Reconcile the Assignments this control plane manages against the Sessions the node really holds.
   *
   * The reconciler asks the node about every Session it knows, cleans up the ones the node confirms are still running
   * although their work is over, and reports everything else. It never starts a Worker, never stops a Session whose
   * state it could not confirm, and never touches a Session this control plane does not manage.
   */
  reconcile(): Promise<ReconcileResult> {
    return this.reconcileInFlight ??= this.performReconcile().finally(() => { this.reconcileInFlight = undefined })
  }

  private async performReconcile(): Promise<ReconcileResult> {
    const reconciler = new Reconciler({
      now: () => this.now(),
      sessions: () => [...this.sessions.values()],
      assignmentOf: assignmentId => this.assignmentFacts(assignmentId),
      projectOf: projectId => {
        const project = this.store.projects.get(projectId)
        return project ? { id: project.id, status: project.status, pmSessionId: project.pmSessionId } : undefined
      },
      inspect: sessionId => this.tryInspect(sessionId),
      nodeOnline: () => this.nodes.get(this.options.nodeId)?.online !== false,
      cleanup: (sessionId, reason) => this.cleanupOrphan(sessionId, reason),
      audit: finding => this.auditReconcile(finding),
    })
    const result = await reconciler.run()
    this.consoleStore.writeReconcileRun({ at: result.at, nodeOnline: result.nodeOnline, checked: result.checked,
      findings: JSON.stringify(result.findings), counts: JSON.stringify(result.counts), boundary: result.boundary })
    return result
  }

  /** The runs of the reconciliation, newest first: what the console shows about the last one. */
  reconcileRuns(limit = 10): { id: number; at: string; nodeOnline: boolean; checked: number; findings: unknown;
    counts: unknown; boundary: string }[] {
    return this.consoleStore.reconcileRuns(limit).map(run => ({
      id: run.id, at: run.at, nodeOnline: run.nodeOnline, checked: run.checked,
      findings: this.parseJson(run.findings), counts: this.parseJson(run.counts), boundary: run.boundary,
    }))
  }

  /** The domain's facts about one Assignment, as the reconciler reads them. */
  private assignmentFacts(assignmentId: string): {
    id: string; state: string; ticketId: string; projectId: string; ticketArchived: boolean; ticketEnded: boolean
  } | undefined {
    const ticket = this.ticketOfAssignment(assignmentId)
    if (!ticket) return undefined
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment) return undefined
    return { id: assignment.id, state: assignment.state, ticketId: ticket.id, projectId: ticket.projectId ?? '',
      ticketArchived: ticket.archived !== undefined, ticketEnded: ticket.ended !== undefined }
  }

  /**
   * Stop and archive one Session the reconciler found to be a leftover.
   *
   * The cleanup is serialized with the Session's Ticket's other operations, so it never overlaps a re-dispatch of the same
   * Ticket: a Worker that is being replaced is not stopped behind the replacement's back.
   */
  private async cleanupOrphan(sessionId: string, reason: string): Promise<{ ok: boolean; reason?: string }> {
    const record = this.sessions.get(sessionId)
    const ticket = record?.assignmentId ? this.ticketOfAssignment(record.assignmentId) : undefined
    const work = async (): Promise<void> => {
      await this.cancelSession(sessionId, reason, 'system')
      await this.archiveSession(sessionId)
    }
    const run = async (): Promise<{ ok: boolean; reason?: string }> => {
      try {
        await work()
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: redact(messageOf(error)).slice(0, 300) }
      }
    }
    if (!ticket) return run()
    return this.withTicketOperation(ticket.id, run)
  }

  /** Record one reconciliation finding in the audit trail. */
  private auditReconcile(finding: ReconcileFinding): void {
    this.audit.record({ actor: 'system', kind: 'session', action: `reconcile-${finding.kind}`, targetKind: 'session',
      targetId: finding.sessionId, outcome: finding.outcome === 'ok' ? 'ok' : finding.outcome === 'failed' ? 'failed' : 'skipped',
      detail: finding.reason ?? finding.action })
  }

  state(): ControlPlaneState {
    return { nodeId: this.options.nodeId, nodes: Object.fromEntries(this.nodes), projects: this.projects(), tickets: this.tickets(),
      sessions: [...this.sessions.values()], events: this.events.length, pmNotifications: this.pmNotifications() }
  }

  /**
   * The recorded events after a sequence, and whether the log has a gap there.
   *
   * The log is the control plane's own, so a client that reconnects after a restart receives the events it missed, with
   * the same sequence numbers it would have seen live. A gap is reported instead of hidden: the log is bounded, and the
   * events it no longer holds cannot be delivered again.
   */
  eventHistory(after: number, limit = EVENT_REPLAY_LIMIT): { events: NodeEvent[]; gap: boolean } {
    const { rows, gapFrom } = this.consoleStore.eventsAfter(after, limit)
    const events: NodeEvent[] = []
    for (const row of rows) {
      const event = this.parseEvent(row)
      if (event) events.push(event)
    }
    // A hole inside the returned slice is a gap as well: the events around it are not consecutive, and a client that
    // believes they are would miss one without being told.
    let gap = gapFrom !== undefined
    for (let index = 0; index < events.length && !gap; index += 1) {
      if (events[index]!.seq !== after + 1 + index) gap = true
    }
    return { events, gap }
  }

  /**
   * The counts the console's home page shows.
   *
   * Every number is a fact of the domain, read by the kernel that owns it: a Ticket is running when its latest Assignment
   * is running, a Worker is executing when its Session is running rather than idle, and a Ticket waits for its PM when a
   * review is pending. A capability the control plane does not have is named as absent, so the console can say so
   * instead of showing a number that reads like a result.
   */
  overview(): ControlPlaneOverview {
    const tickets = this.tickets()
    const sessions = [...this.sessions.values()]
    return {
      at: this.now(),
      runningTickets: tickets.filter(ticket => pmTicketStatus(ticket) === 'running').length,
      runningWorkers: sessions.filter(session => session.role === 'worker' && session.status === 'running').length,
      pendingReviews: tickets.filter(ticket => pendingReview(ticket) !== undefined).length,
      features: { router: this.routerAvailable(), schedules: true },
      schedules: this.scheduler.overview(),
      counts: { projects: this.projects().length, tickets: tickets.length, sessions: sessions.length,
        nodes: this.nodes.size },
      nodes: [...this.nodes.values()],
      events: { seq: this.lastEventSeq, retained: this.consoleStore.eventCount() },
      audit: { entries: this.audit.count() },
      retention: { eventDays: this.consoleStore.eventDays, eventRows: this.consoleStore.eventRows,
        auditDays: this.consoleStore.auditDays },
    }
  }

  /** The audit trail, newest first: the facts the console's activity list shows. */
  auditEntries(options: { limit?: number; kind?: string } = {}): ConsoleAuditRow[] {
    return this.audit.entries(options)
  }

  /**
   * The Projects as the console reads them, with the Tickets that belong to them.
   *
   * The status of a Ticket is the kernel's own: the console shows the state a PM reads, not a second opinion computed in
   * the browser. The facts it carries are the ones a person needs to see — what the work is, who runs it and whether it
   * waits for a decision — and never the Mandate, the actor or the internal inputs of a Ticket.
   */
  consoleProjects(): ConsoleProject[] {
    const tickets = this.tickets()
    return this.projects().map(project => ({
      id: project.id,
      title: project.title,
      goal: project.goal,
      workspace: project.workspace ?? this.sessions.get(project.pmSessionId)?.workspace ?? join(this.projectWorkspaceRoot(), project.id),
      status: project.status,
      ...(project.pauseMode === undefined ? {} : { pauseMode: project.pauseMode }),
      pmSessionId: project.pmSessionId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ...(project.latestReport === undefined ? {} : { latestReport: project.latestReport }),
      tickets: tickets.filter(ticket => ticket.projectId === project.id).map(ticket => this.consoleTicket(ticket)),
    }))
  }

  consoleStandaloneTickets(): ConsoleTicket[] {
    return this.tickets().filter(ticket => ticket.projectId === undefined).map(ticket => this.consoleTicket(ticket))
  }

  /** One Ticket as the console reads it. */
  private consoleTicket(ticket: Ticket): ConsoleTicket {
    const assignment = latestAssignment(ticket)
    const review = currentReview(ticket)
    return {
      id: ticket.id,
      title: ticket.title,
      ...(ticket.projectId === undefined ? {} : { projectId: ticket.projectId }),
      status: pmTicketStatus(ticket),
      ...(assignment === undefined ? {} : { assignment: { id: assignment.id, state: assignment.state,
        ...(assignment.report === undefined ? {} : { report: { state: assignment.report.state,
          summary: assignment.report.summary, at: assignment.report.at } }) } }),
      ...(review === undefined ? {} : { review: { id: review.id, state: review.state, assignmentId: review.assignmentId,
        at: review.at, ...(review.summary === undefined ? {} : { summary: review.summary }) } }),
      ...(ticket.attention === undefined ? {} : { attention: { question: ticket.attention.question } }),
      ...(ticket.manualStop === undefined ? {} : { manualStop: { scope: ticket.manualStop.scope, at: ticket.manualStop.at } }),
    }
  }

  /**
   * The messages of one Session, oldest first.
   *
   * They are the message events the node reported, read from the log, so a console shows the conversation that really
   * happened. A Session that never reported a message has none.
   */
  sessionMessages(sessionId: string, limit = SESSION_MESSAGE_LIMIT): SessionMessage[] {
    return this.consoleStore.messagesFor(sessionId, limit).flatMap(row => {
      const event = this.parseEvent(row)
      if (!event || event.type !== 'session.event' || event.kind !== 'message') return []
      const data = event.data
      if (typeof data !== 'object' || data === null) return []
      const message = data as { role?: unknown; text?: unknown; source?: unknown }
      const role = typeof message.role === 'string' ? message.role : 'message'
      const text = typeof message.text === 'string' ? message.text : ''
      if (text.trim() === '' || message.source === 'runtime-context' || message.source === 'time-context') return []
      if (message.source === 'dsh-superagent' && (text === ROUTER_PROFILE.prompt || text === PM_PROFILE.prompt
        || text.startsWith(ROUTER_PROFILE.prompt + '\n') || text.startsWith(PM_PROFILE.prompt + '\n'))) return []
      return [{ seq: event.seq, at: event.at, role, text }]
    })
  }

  /** One logged event, parsed back into the shape a subscriber saw. */
  private parseEvent(row: ConsoleEventRow): NodeEvent | undefined {
    try {
      const event = JSON.parse(row.payload) as NodeEvent
      return event && typeof event === 'object' && typeof event.seq === 'number' ? event : undefined
    } catch {
      // A row that cannot be parsed is skipped: a broken payload must not take the whole history with it.
      return undefined
    }
  }

  /**
   * Listen to every node event this kernel receives: node liveness, Session facts and tool calls alike.
   *
   * The listener runs synchronously inside `receive`, after the event was recorded in `events` and applied to the
   * kernel's state, so listeners observe the same order the kernel did. A listener that throws is reported and skipped:
   * one broken consumer must never stop the state machine, the node's transport or the other listeners. The returned
   * function unsubscribes and is safe to call more than once.
   */
  subscribe(listener: (event: NodeEvent) => void): () => void {
    if (this.closed) return () => {}
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopHeartbeat()
    this.stopReconcile()
    // The queue's own lookups stop with the kernel: a closed control plane looks at nothing.
    if (this.routerQueueRetry !== undefined) {
      clearTimeout(this.routerQueueRetry)
      this.routerQueueRetry = undefined
    }
    // The scheduler writes to the console's own file, so it is stopped before that file is closed: a delivery still in
    // flight gets its record written instead of finding a closed database.
    await this.stopScheduler()
    this.unsubscribe()
    this.eventListeners.clear()
    this.sessions.clear()
    this.tokens.clear()
    this.stoppingSessions.clear()
    this.sessionTurns.clear()
    // A PM waiting for a diff must not wait for a kernel that is gone: every waiting request is answered with the fact.
    for (const pending of [...this.pendingReviewDiffs.values()]) {
      pending.settle({ status: 'failed', reason: 'The control plane closed before the node answered the review diff' })
    }
    this.pendingReviewDiffs.clear()
    // The console's own file is closed with the domain's store: both belong to this kernel and to nobody else.
    try { this.consoleStore.close() } catch { /* a file that was never opened needs no closing */ }
    try { this.store.close() } finally { await this.releaseLock().catch(() => {}) }
  }

  private base(idempotencyKey: string) {
    return { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: this.options.nodeId, idempotencyKey, at: this.now() } as const
  }

  /**
   * A key for one command invocation. A node executes a repeated key at most once, so two calls in the
   * same millisecond must still differ: the clock is never the source of uniqueness.
   */
  private uniqueKey(prefix: string, scope: string): string {
    return `${prefix}:${scope}:${this.instanceId}:${++this.sequence}`
  }

  /**
   * Run one ensure per Session at a time. Two concurrent open/create requests await the same Promise, so the node
   * receives one `pm.ensure` / `worker.create` for a Session rather than two racing creates.
   */
  private singleFlight(sessionId: string, run: () => Promise<SessionRecord>): Promise<SessionRecord> {
    const running = this.pendingEnsures.get(sessionId)
    if (running) return running
    let shared: Promise<SessionRecord>
    shared = run().finally(() => {
      if (this.pendingEnsures.get(sessionId) === shared) this.pendingEnsures.delete(sessionId)
    })
    this.pendingEnsures.set(sessionId, shared)
    return shared
  }

  /**
   * Confirm a record the control plane is about to recreate. An explicit node inspection is the only loss-proof
   * source: a lost status event and a lost acknowledgement leave no local fact at all. An unhealthy answer falls
   * through to a fresh ensure, whose own result is confirmed again rather than trusted.
   */
  private async confirmExisting(record: SessionRecord): Promise<SessionRecord | undefined> {
    const inspection = await this.tryInspect(record.sessionId)
    if (!inspection?.found) return undefined
    this.adoptInspection(record, inspection)
    if (!this.inspectionHealthy(inspection)) return undefined
    // The node answered for this Session now, so the record is confirmed under the generation the kernel trusts.
    this.adoptGeneration(record)
    return record
  }

  /**
   * Settle an ensure whose command was acknowledged. A synchronous status event usually already did; an async or lost
   * event waits briefly, then the node is asked directly. It never returns a `starting` record.
   */
  private async settleEnsure(record: SessionRecord, label: string): Promise<SessionRecord> {
    let current = this.sessions.get(record.sessionId) ?? record
    if (current.status === 'failed') return current
    if (isNodeConfirmed(current.status)) return this.confirmEnsure(current)
    const changed = await this.waitForStatus(current, this.options.confirmationTimeoutMs ?? 2000)
    if (changed) {
      current = changed
      if (current.status === 'failed') return current
      if (isNodeConfirmed(current.status)) return this.confirmEnsure(current)
    }
    const inspection = await this.tryInspect(current.sessionId)
    if (inspection?.found) {
      if (this.inspectionHealthy(inspection)) return this.confirmEnsure(current, inspection)
      this.adoptInspection(current, inspection)
      this.markFailed(current)
      return current
    }
    this.markFailed(current)
    throw new SessionEnsureError(`The node did not confirm the ${label} Session ${current.sessionId}`)
  }

  /**
   * Finish a successful ensure: adopt the current node generation and, when the node knows a real backend Session id,
   * that id, so a creation response carries the backend's own resume id instead of a placeholder.
   *
   * An inspection already taken for this settle is passed in rather than repeated; a record without one is inspected
   * once here. A node that cannot report a real id keeps the placeholder — the control plane never invents one.
   */
  private async confirmEnsure(record: SessionRecord, inspection?: SessionInspection): Promise<SessionRecord> {
    const current = this.sessions.get(record.sessionId) ?? record
    if (inspection !== undefined) this.adoptInspection(current, inspection)
    if (current.backendSessionId === undefined || current.backendSessionId.startsWith('fake-')) {
      const answer = await this.tryInspect(current.sessionId)
      if (answer?.found) this.adoptInspection(current, answer)
    }
    this.adoptGeneration(current)
    return current
  }

  /** Mark a record's ensure as confirmed under the kernel's current node generation. */
  private adoptGeneration(record: SessionRecord): void {
    record.nodeGeneration = this.nodeGeneration
    this.persist(record)
  }

  private isCurrentGeneration(record: SessionRecord): boolean {
    return record.nodeGeneration === this.nodeGeneration
  }

  /**
   * Whether a confirmed Session has to be ensured again before it may be returned.
   *
   * A control-plane start and every offline-to-online transition produce a new generation, so a record confirmed under
   * an older one describes a node that may have forgotten it. A stopped or archived Session is a finished lifecycle,
   * though: a generation change must not silently reopen one, so those records are returned as they are. A Session that
   * is stopping is not reopened either: it is on its way out, and re-ensuring it would bring the Worker back.
   */
  private needsReensure(record: SessionRecord): boolean {
    return isNodeConfirmed(record.status) && !SESSION_TERMINAL.has(record.status) && record.status !== 'stopping'
      && !this.isCurrentGeneration(record)
  }

  /**
   * Resolve a failed ensure command. A status event observed while `send` was pending is a node fact; an explicit
   * inspection decides whether that fact is a healthy Session (a lost acknowledgement) or a command that really failed.
   * The important case is `idle` followed by a role-installation failure: the node reported `idle` before its ensure
   * rejected, so "idle" alone must not make the request a success.
   */
  private async recoverEnsureFailure(record: SessionRecord, error: unknown, label: string): Promise<SessionRecord> {
    const inspection = await this.tryInspect(record.sessionId)
    if (inspection) {
      if (inspection.found) {
        if (this.inspectionHealthy(inspection)) return this.confirmEnsure(record, inspection)
        this.adoptInspection(record, inspection)
        this.markFailed(record)
        throw new SessionEnsureError(inspection.error
          ? `The node could not prepare the ${label} Session: ${inspection.error}`
          : `The node could not prepare the ${label} Session`)
      }
      // The node has no such Session: the command really did not create it.
      this.markFailed(record)
      throw this.ensureFailure(error)
    }
    // No inspection capability: keep a node-reported fact (including a reported failure), otherwise fail explicitly.
    const current = this.sessions.get(record.sessionId) ?? record
    if (current.status === 'failed' || isNodeConfirmed(current.status)) {
      this.adoptGeneration(current)
      return current
    }
    this.markFailed(current)
    throw this.ensureFailure(error)
  }

  /** Report a failed ensure command as an ensure failure, keeping the node's or transport's message for the caller. */
  private ensureFailure(error: unknown): SessionEnsureError {
    return error instanceof SessionEnsureError
      ? error
      : new SessionEnsureError(error instanceof Error ? error.message : String(error))
  }

  /** Ask the node for one Session's status; undefined when it cannot answer. */
  private async tryInspect(sessionId: string): Promise<SessionInspection | undefined> {
    const inspect = this.options.node.inspect
    if (inspect) {
      try {
        return await inspect.call(this.options.node, sessionId)
      } catch {
        // Fall through to the command/event path: a transport may implement `inspect` only partially.
      }
    }
    return this.inspectOverProtocol(sessionId)
  }

  /**
   * Ask through the plain command/event protocol, so a transport that only forwards `send`/`subscribe` still gets an
   * explicit answer. The request id is the command key the node echoes in `session.inspected`.
   */
  private inspectOverProtocol(sessionId: string, routerDetails?: true): Promise<SessionInspection | undefined> {
    const requestId = this.uniqueKey('session-inspect', sessionId)
    return new Promise<SessionInspection | undefined>(resolve => {
      const finish = (inspection?: SessionInspection): void => {
        clearTimeout(timer)
        this.pendingInspections.delete(requestId)
        resolve(inspection)
      }
      const timer = setTimeout(() => finish(), this.options.inspectionTimeoutMs ?? 500)
      this.pendingInspections.set(requestId, inspection => finish(inspection))
      void this.options.node.send({ ...this.base(requestId), type: 'session.inspect', sessionId,
        ...(routerDetails ? { routerDetails } : {}) })
        .catch(() => finish())
    })
  }

  private adoptInspection(record: SessionRecord, inspection: SessionInspection): void {
    const at = this.now()
    record.updatedAt = at
    if (inspection.backendSessionId !== undefined) record.backendSessionId = inspection.backendSessionId
    if (inspection.status !== undefined) {
      record.status = inspection.status
      if (inspection.status === 'archived') record.archivedAt ??= at
    }
    // The turn the node reports is the turn an interrupt may name, and an idle Session runs no turn: after a reconnect
    // or a restart the node's own answer is what tells the two apart.
    if (inspection.turn !== undefined) this.sessionTurns.set(record.sessionId, inspection.turn)
    else if (inspection.status === 'idle') this.sessionTurns.delete(record.sessionId)
    this.persist(record)
  }

  private inspectionHealthy(inspection: SessionInspection): boolean {
    return inspection.found && inspection.ready !== false && inspection.status !== undefined
      && isNodeConfirmed(inspection.status)
  }

  private markFailed(record: SessionRecord): void {
    record.status = 'failed'
    record.updatedAt = this.now()
    this.persist(record)
  }

  /** Wait for a status event that moves the record past `starting`; resolves undefined on timeout. */
  private waitForStatus(record: SessionRecord, timeoutMs: number): Promise<SessionRecord | undefined> {
    if (record.status !== 'starting') return Promise.resolve(record)
    if (timeoutMs <= 0) return Promise.resolve(undefined)
    return new Promise<SessionRecord | undefined>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const remove = (): void => {
        const waiters = this.statusWaiters.get(record.sessionId)
        if (!waiters) return
        waiters.delete(wake)
        if (waiters.size === 0) this.statusWaiters.delete(record.sessionId)
      }
      const finish = (value: SessionRecord | undefined): void => {
        if (timer !== undefined) clearTimeout(timer)
        remove()
        resolve(value)
      }
      const wake = (): void => {
        const current = this.sessions.get(record.sessionId)
        if (current && current.status !== 'starting') finish(current)
      }
      const waiters = this.statusWaiters.get(record.sessionId) ?? new Set<() => void>()
      waiters.add(wake)
      this.statusWaiters.set(record.sessionId, waiters)
      timer = setTimeout(() => finish(undefined), timeoutMs)
    })
  }

  private notifyStatusWaiters(sessionId: string): void {
    const waiters = this.statusWaiters.get(sessionId)
    if (!waiters) return
    for (const wake of [...waiters]) wake()
  }

  /** Reset a failed or abandoned `starting` record for one more ensure attempt; its identity and createdAt stay. */
  private restartSession(record: SessionRecord, workspace: string, at: string): SessionRecord {
    record.status = 'starting'
    record.workspace = workspace
    record.updatedAt = at
    return record
  }

  private validateWorkspace(workspace: string): string {
    if (!isAbsolute(workspace)) throw new Error('A workspace path must be absolute')
    return workspaceDirectory(this.options.workspaceRoot, workspace, 'The workspace must be inside the control plane workspace root')
  }

  private workspacePath(workspace: string): string {
    const path = this.validateWorkspace(workspace)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return path
  }

  /** The Session id `createWorkerSession` gives an Assignment; delivery and stop resolve its Worker by it. */
  private workerSessionFor(assignmentId: string): string {
    return `worker-${assignmentId}`
  }

  /**
   * Record an Executor failure on its Ticket. A launch that never reached `running` gets a `failed` report: no Assignment
   * state says failed, so this is what keeps it from waiting silently. A delivery failure to a running Assignment keeps the
   * Engine's `delivery.error` contract instead. A failure for an Assignment a later command replaced is ignored, so a stale
   * callback cannot fail the replacement.
   */
  private assignmentFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.store.tickets.get(ticketId)
    const assignment = ticket?.assignments.find(item => item.id === assignmentId)
    if (!ticket || !assignment) return
    try {
      if (assignment.state === 'running') this.engine.deliveryFailed(ticketId, assignmentId, error)
      else if (ticket.assignments.at(-1)?.id === assignmentId) {
        const written = this.engine.report(ticketId, { state: 'failed', summary: error })
        if (ticket.projectId === undefined) this.notifyOwnerOfReport(written, assignmentId)
      }
    } catch {
      // The Ticket ended or changed meanwhile: the failure no longer has a live record to update.
    }
  }

  /**
   * Refuse a command to a node this kernel knows is offline.
   *
   * The node cannot confirm anything while it is unreachable, so a recorded `idle` Session must not be returned as a
   * success and no command should be posted into the void. The refusal is a Session ensure failure, which the HTTP
   * facade reports as 502 rather than 200. An unknown status is not treated as offline: startup registration is the
   * fail-fast boundary, and an in-process node may never publish a status of its own.
   */
  private requireNodeOnline(): void {
    const status = this.nodes.get(this.options.nodeId)
    if (status?.online === false) {
      throw new SessionEnsureError(`The node ${this.options.nodeId} is offline; the command was not sent`)
    }
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId)
    if (!record) throw new Error(`Unknown session ${sessionId}`)
    return record
  }

  /** Write a Session record to the Store's KV area; tokens are deliberately not part of it. */
  private persist(record: SessionRecord): void {
    this.store.set(KV.control.session(record.sessionId), record)
  }

  /** Restore Session records written by an earlier kernel on the same database; tokens are re-issued on demand. */
  private loadSessions(): void {
    for (const key of this.store.keys(KV.control.session)) {
      const record = this.store.get(key)
      if (record) this.sessions.set(record.sessionId, record)
    }
  }

  private issueToken(record: SessionRecord): string {
    return issueSessionToken({ sid: record.sessionId, pid: record.projectId,
      ...(record.assignmentId === undefined ? {} : { aid: record.assignmentId }), role: record.role, backend: 'dsh',
      nodeId: this.options.nodeId, tv: record.tokenVersion ?? 0 }, this.options.secret,
    this.options.sessionTokenTtlSeconds ?? this.options.tokenTtlSeconds ?? 3600)
  }

  /**
   * Record one node status and rotate the generation when the node comes back.
   *
   * A node that was offline may have restarted its backend in the meantime. Sessions confirmed before the loss cannot be
   * trusted to still exist there, while Sessions confirmed after this transition are; the generation is what tells the
   * two apart, so only an offline-to-online transition starts a new one.
   */
  private applyNodeStatus(status: NodeStatus): void {
    const previous = this.nodes.get(status.nodeId)
    this.nodes.set(status.nodeId, status)
    if (status.nodeId === this.options.nodeId && status.online && previous !== undefined && previous.online === false) {
      this.nodeGeneration = randomUUID()
    }
    // Only a change of liveness is a fact worth keeping: a heartbeat that repeats what is already known is not an event.
    if (previous?.online !== status.online) {
      this.audit.record({ actor: 'system', kind: 'node', action: status.online ? 'online' : 'offline',
        targetKind: 'node', targetId: status.nodeId, detail: status.backend })
    }
    // A node that came back may take the messages that waited for it.
    if (status.nodeId === this.options.nodeId && status.online) this.scheduleRouterQueue()
  }

  /**
   * Record one node event, apply it to the kernel's state, then announce it to every subscriber.
   *
   * The event enters `events` before anything else, so a listener — and a reconnecting client replaying by `seq` —
   * always sees the same history the kernel does. A failure while applying the event still announces it: the fact the
   * node reported is worth showing even when one of its consequences is refused.
   *
   * A review diff is the one exception: it carries the content of a Project's workspace, and it answers one authorized
   * request. It is neither recorded nor announced, so it never reaches the event history, the event stream or a
   * notification — a viewer of the control plane reads the state of a Project, never its code.
   */
  private receive(event: NodeEvent, origin: 'node' | 'control' = 'node'): void {
    if (event.type === 'review.diff') {
      this.applyEvent(event)
      return
    }
    const recorded = this.record(event, origin)
    this.events.push(recorded)
    // The durable log keeps the history; this array is the recent window, and it stays bounded.
    if (this.events.length > EVENT_MEMORY_LIMIT) this.events.splice(0, this.events.length - EVENT_MEMORY_LIMIT)
    try {
      this.applyEvent(recorded)
    } finally {
      this.notifyEvent(recorded)
    }
  }

  /**
   * Give one event the control plane's own sequence and write it to the log.
   *
   * The sequence is the control plane's, not the node's: a node restarts and counts from 1 again, while this one keeps
   * counting across restarts, because the log holds the counter. The node's own counter is kept beside it, so a node
   * restart stays visible instead of silently reusing a number.
   *
   * A tool call's arguments are the model's own input and may hold a secret a person pasted into a task, so the log keeps
   * the call and not its input. Nothing else is dropped: the conversation of a Session is what the console reads.
   */
  private record(event: NodeEvent, origin: 'node' | 'control'): NodeEvent {
    const nodeSeq = origin === 'node' ? event.seq : undefined
    const seq = this.consoleStore.nextEventSeq()
    const recorded = this.withSequence(event, seq, nodeSeq)
    try {
      this.consoleStore.appendEvent({ seq, at: recorded.at, nodeId: recorded.nodeId,
        ...(nodeSeq === undefined ? {} : { nodeSeq }), sessionId: recorded.sessionId, type: recorded.type,
        kind: recorded.type === 'session.event' ? recorded.kind : '', payload: JSON.stringify(recorded) })
    } catch (error) {
      // A log that cannot be written must not stop the work: the event keeps the sequence it was given, the failure is
      // reported, and the gap it leaves is the one a client is told about.
      process.stderr.write(`superagent control-plane event log write failed: ${
        error instanceof Error ? error.message : String(error)}\n`)
    }
    if (seq > this.lastEventSeq) this.lastEventSeq = seq
    this.eventsSincePrune += 1
    if (this.eventsSincePrune >= EVENT_REPLAY_LIMIT) this.pruneConsoleLog()
    return recorded
  }

  /**
   * Drop what the event log may no longer keep.
   *
   * The log is bounded by its rows and by its age; the sequence it hands out is never reused, so dropping the oldest rows
   * costs a client the events it may still ask for — which is why the log reports the gap it leaves. A prune that fails is
   * a diagnostic, never a failed event.
   */
  private pruneConsoleLog(): void {
    this.eventsSincePrune = 0
    try {
      this.consoleStore.prune(this.now())
    } catch (error) {
      process.stderr.write(`superagent control-plane event log prune failed: ${
        error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  /** One event with the control plane's own sequence and the node's counter beside it. */
  private withSequence(event: NodeEvent, seq: number, nodeSeq: number | undefined): NodeEvent {
    switch (event.type) {
      case 'node.status': return { ...event, seq, nodeSeq }
      case 'session.status': return { ...event, seq, nodeSeq }
      case 'session.event': return { ...event, seq, nodeSeq }
      case 'session.inspected': return { ...event, seq, nodeSeq }
      // The arguments of a tool call are the model's input; the log keeps the call, not its input.
      case 'tool.call': return { ...event, seq, nodeSeq, args: undefined }
      // A scheduled run is the control plane's own fact; it carries no node counter.
      case 'schedule.run': return { ...event, seq, nodeSeq: undefined }
    }
    throw new Error(`an event of the unknown kind ${(event as { type: string }).type} cannot be recorded`)
  }

  /** Fold one received event into the kernel's state: node liveness, the Session record and the Engine's facts. */
  private applyEvent(event: NodeEvent): void {
    if (event.type === 'node.status') {
      this.applyNodeStatus(event.status)
      return
    }
    // A review diff belongs to no Session: it answers a command the control plane sent for a Project, and the request
    // waiting for it is found by the id the command carried. The answer is read only when it comes from this node and
    // is about the Project the request named: an answer about another Project is refused, never handed on.
    if (event.type === 'review.diff') {
      const pending = this.pendingReviewDiffs.get(event.requestId)
      if (!pending) return
      if (event.nodeId !== this.options.nodeId) {
        pending.settle({ status: 'failed', reason: 'The review diff came from another node' })
        return
      }
      if (event.projectId !== pending.projectId) {
        pending.settle({ status: 'failed', reason: 'The node answered the review diff about another Project' })
        return
      }
      pending.settle(event.result)
      return
    }
    if (event.type === 'session.inspected') {
      const pending = this.pendingInspections.get(event.requestId)
      if (pending) pending(event.inspection)
    }
    const record = this.sessions.get(event.sessionId)
    if (!record) return
    if (event.type === 'session.status') {
      // A report of the stop that came before a resume is about the old lifecycle: it must not stop the resumed Session.
      const stale = this.resumedSessions.has(event.sessionId)
      if (!stale) {
        record.status = event.status
        record.updatedAt = event.at
        if (event.status === 'archived') record.archivedAt = event.at
      }
      // The node confirmed the Session is gone: it must not be brought back by a message or a re-ensure.
      if (event.status === 'stopped' || event.status === 'archived') this.stoppingSessions.delete(event.sessionId)
      // A node that reports the Session as gone confirms an operator's stop. A late report that the Session is still
      // live does not undo it: the operator's stop holds, and the Session stays unusable until a person resumes it.
      if (event.status === 'stopped' || event.status === 'archived') this.confirmOperatorStop(record, event.at)
      // The Router is idle again: the messages that waited behind its turn may go now.
      if (event.sessionId === ROUTER_SESSION_ID && event.status === 'idle') this.scheduleRouterQueue()
    } else if (event.type === 'session.inspected') {
      const inspection = event.inspection
      record.updatedAt = event.at
      if (inspection.backendSessionId !== undefined) record.backendSessionId = inspection.backendSessionId
      if (inspection.found && inspection.status !== undefined) {
        record.status = inspection.status
        if (inspection.status === 'archived') record.archivedAt ??= event.at
      }
    } else {
      record.updatedAt = event.at
      if (event.type === 'session.event') {
        this.applyTurnFact(event)
      }
      if (event.type === 'session.event' && record.assignmentId !== undefined
        && (event.kind === 'turn-start' || event.kind === 'turn-end')) {
        const ticket = this.ticketOfAssignment(record.assignmentId)
        if (ticket) {
          if (event.kind === 'turn-start') {
            this.engine.turnBegan(ticket.id, record.assignmentId)
            // The turn names the Inputs its step took; the assigned worker reads them from here. A turn that names none,
            // or an Assignment a later one replaced (no Ticket found above), changes nothing beyond the turn fact.
            const inputIds = turnInputIds(event.data)
            // The turn belongs to the Session's Assignment: a late turn of a replaced Worker names Inputs the current
            // Worker never took, so passing the id stops it from marking them read.
            if (inputIds.length > 0) this.engine.inputsRead(ticket.id, inputIds, record.assignmentId)
          } else this.engine.turnEnded(ticket.id, record.assignmentId)
        }
      }
    }
    this.persist(record)
    this.notifyStatusWaiters(record.sessionId)
  }

  /**
   * Record what a node reported about one Session's turn.
   *
   * The turn number is the fact an interrupt needs: the node is asked to end that very turn, so a turn that started in
   * the meantime is never ended in its place.
   *
   * A `turn-start` also names the Input ids the turn really took. That is the only fact that makes a queued message
   * `read`: the node's inbox says the message is there, and only a turn says it was taken.
   */
  private applyTurnFact(event: NodeEvent): void {
    if (event.type !== 'session.event') return
    const sessionId = event.sessionId
    if (event.kind === 'turn-start') {
      const turn = turnNumber(event.data)
      if (turn !== undefined) this.sessionTurns.set(sessionId, turn)
      if (sessionId === ROUTER_SESSION_ID) this.markRouterMessagesRead(turnInputIds(event.data))
      return
    }
    if (event.kind === 'turn-end') {
      const turn = turnNumber(event.data)
      if (turn === undefined || this.sessionTurns.get(sessionId) === turn) this.sessionTurns.delete(sessionId)
      // The Router's turn ended: the messages that waited behind it may go now.
      if (sessionId === ROUTER_SESSION_ID) this.scheduleRouterQueue()
    }
  }

  /**
   * Hand one received event to every subscriber, in subscription order.
   *
   * A listener runs inside the node's event delivery, so it must not be able to break it: each failure is reported to
   * stderr and the remaining listeners still run. The set is copied first, so a listener may unsubscribe while being
   * notified without changing which listeners this event reaches.
   */
  private notifyEvent(event: NodeEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event)
      } catch (error) {
        process.stderr.write(`superagent control-plane event listener failed: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }

  /** The Ticket whose current or past Assignment has this id; events from replaced Assignments are ignored by Engine. */
  private ticketOfAssignment(assignmentId: string): Ticket | undefined {
    return this.store.tickets.list().find(ticket => ticket.assignments.some(assignment => assignment.id === assignmentId))
  }

  /** A JSON value the control plane stored, read back; a broken row is answered as nothing rather than failing a read. */
  private parseJson(value: string): unknown {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
}
