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
import { NODE_PROTOCOL_VERSION } from '../shared/protocol.ts'
import type { ConsoleRuntimeSettings, NodeCommand, NodeEvent, NodePort, NodeRegistration, NodeStatus, ReviewDiffResult, RoleProfile, RouterModel,
  RouterOptions, RouterTextAttachment,
  SessionInspection, SessionRecord, SessionStatus } from '../shared/protocol.ts'
import { issueSessionToken, verifySessionToken, type SessionTokenClaims } from '../shared/session-token.ts'
import { workspaceDirectory } from '../shared/workspace-path.ts'
import { AuditRecorder, type AuditActor } from './console-audit.ts'
import { ConsoleStore, type ConsoleAuditRow, type ConsoleEventRow, type ProjectMemoryRow } from './console-store.ts'
import { createKernelDomain, type KernelDomain } from './domain.ts'
import { NodeExecutor } from './executor.ts'
import { pmReportKey, pmReportMessage, type PmReportFacts } from './pm-report.ts'
import { Reconciler, type ReconcileFinding, type ReconcileResult } from './reconcile.ts'
import { reportCallKey, reportCallPrefix, reportPayloadHash, type ReportCallRecord } from './report-call.ts'
import { fenceDiff, PM_REVIEW_DIFF_NOTE, type PmReviewDiff } from './review-diff.ts'
import { RouterRequests, routerInstructionMessage, routerRequestMessage, routerRequestOf, type RouterManagement,
  routerProjectReportMessage, type RouterProposal } from './router.ts'
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
  /** The Router Session, when it has been started. */
  session?: { sessionId: string; status: string; workspace: string; updatedAt: string; revokedAt?: string }
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
 * refused or could not receive, and `pending` a wake-up still in flight.
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
  state: 'pending' | 'sent' | 'skipped' | 'failed'
  /** Why a wake-up was skipped or failed. */
  reason?: string
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
   * The PM's own operation in flight for one Ticket, so a cancel and a re-dispatch never overlap.
   *
   * The two are ordered, not refused: a re-dispatch that arrives while a stop is running waits for the node's answer
   * instead of starting a second Worker over one that may still be running.
   */
  private readonly ticketOperations = new Map<string, Promise<void>>()
  /** The stop of the Worker the PM stopped last, by Ticket id: the gate a new Assignment must pass. */
  private readonly stopStates = new Map<string, PmStopState>()
  /** The Sessions a stop is in flight for, so no message and no re-ensure brings them back while they are stopping. */
  private readonly stoppingSessions = new Set<string>()
  /**
   * The PM wake-ups this control plane made for Worker reports, by Ticket: the newest one per Ticket.
   *
   * The record is the kernel's own fact and does not survive a restart of the control plane; the Worker report it
   * belongs to is durable and stays written whatever the record says.
   */
  private readonly pmNotificationsByTicket = new Map<string, PmNotification>()
  /**
   * The requests a person made to the Router, and the one instruction each of them may authorize.
   *
   * The ledger is what keeps the Router's authority a person's: a Router tool call that names a request id may relay
   * that request, and nothing else.
   */
  private readonly routerRequests = new RouterRequests(() => this.now())
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
        sendMessage: (sessionId, text, inputIds) => this.sendMessage(sessionId, text, inputIds, 'system'),
        cancelSession: (sessionId, reason) => this.cancelSession(sessionId, reason, 'system'),
        assignmentStarted: (ticketId, assignmentId) => {
          this.engine.assignmentStarted(ticketId, assignmentId)
          this.auditAssignmentStarted(ticketId, assignmentId)
        },
        assignmentFailed: (ticketId, assignmentId, error) => { this.assignmentFailed(ticketId, assignmentId, error) },
        taskPrompt: ticket => this.taskPrompt(ticket),
        inputsDelivered: (ticketId, assignmentId, inputIds) => {
          this.engine.inputsDelivered(ticketId, assignmentId, inputIds)
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

  private createProjectFromHumanRequest(title: string, goal: string, requestText: string,
    actor: 'operator' | 'router', workspace?: string): ProjectProfile {
    // The Trigger's own Thread is the Trigger itself, so a request never joins another request's Thread.
    const id = `trigger-${randomUUID()}`
    const trigger: Trigger = { id, source: PROJECT_REQUEST_SOURCE,
      threads: [{ source: PROJECT_REQUEST_SOURCE, id }],
      actor: { source: PROJECT_REQUEST_SOURCE, id: PROJECT_REQUEST_ACTOR }, human: true, at: this.now(), text: requestText,
      meta: { title, goal } }
    const project = this.store.atomic(() => {
      this.engine.recordTriggerForRouting(trigger)
      return this.engine.createProject(trigger.id, title, goal, workspace)
    })
    this.audit.record({ actor, kind: 'project', action: 'created', targetKind: 'project',
      targetId: project.id, detail: project.title })
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
   */
  async pauseProject(projectId: string, paused: boolean, mode: 'soft' | 'hard' = 'soft'):
    Promise<{ project: ProjectProfile; workers: { stopped: string[]; failures: { ticketId: string; error: string }[] } }> {
    const project = this.requireProjectById(projectId)
    const report = await this.engine.pauseProjectReport(projectId, paused, mode)
    this.audit.record({ actor: 'operator', kind: 'project', action: paused ? 'paused' : 'resumed', targetKind: 'project',
      targetId: projectId, outcome: report.workers.failures.length === 0 ? 'ok' : 'failed',
      detail: `${project.title} · ${mode}` })
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
   */
  async ensureRouter(): Promise<SessionRecord> {
    const known = this.sessions.get(ROUTER_SESSION_ID)
    // A revoked Router stays revoked: re-ensuring it would issue a new token and hand the authority back.
    if (known?.revokedAt) {
      throw new OperatorError(409, 'The Router Session was revoked and cannot be started again')
    }
    this.requireNodeOnline()
    const pending = this.pendingEnsures.get(ROUTER_SESSION_ID)
    if (pending) return pending
    const existing = this.sessions.get(ROUTER_SESSION_ID)
    if (existing && isNodeConfirmed(existing.status) && !this.needsReensure(existing)) return existing
    return this.singleFlight(ROUTER_SESSION_ID, () => this.ensureRouterSession())
  }

  /** The Router's own ensure: the node is asked for one Session of its own, in a workspace of its own. */
  private async ensureRouterSession(): Promise<SessionRecord> {
    const existing = this.sessions.get(ROUTER_SESSION_ID)
    // The same rule as a PM: a confirmed Session from an older generation is re-ensured under the same id.
    const stale = existing !== undefined && this.needsReensure(existing)
    if (existing && !stale && isNodeConfirmed(existing.status)) return existing
    if (existing && !stale) {
      const confirmed = await this.confirmExisting(existing)
      if (confirmed) return confirmed
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
      return this.recoverEnsureFailure(record, error, 'Router')
    }
    return this.settleEnsure(record, 'Router')
  }

  /**
   * Deliver a person's message to the Router.
   *
   * The message is recorded as a request before it goes out, so the Router may act for it — and only for it. The Router
   * Session is ensured here, so the first message a person sends starts it without a detour through another page.
   */
  async sendToRouter(text: string, attachments: readonly RouterTextAttachment[] = [],
    routerModel?: RouterModel): Promise<{ requestId: string; session: SessionRecord }> {
    const value = text.trim()
    if (value === '') throw new OperatorError(400, 'A message to the Router needs a text')
    const session = await this.ensureRouter()
    const request = this.routerRequests.record(value)
    try {
      await this.sendMessage(ROUTER_SESSION_ID, routerRequestMessage(request, attachments), undefined, 'operator',
        routerModel ? { routerModel } : {})
    } catch (error) {
      // A message that never left leaves no open request behind: the Router never saw the id, so it must not be able
      // to propose for it either.
      this.routerRequests.discard(request.id)
      throw error
    }
    return { requestId: request.id, session }
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
    if (record === undefined) return base
    return { ...base, session: { sessionId: record.sessionId, status: record.status, workspace: record.workspace,
      updatedAt: record.updatedAt, ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }) } }
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

  async routerCreateProject(sessionId: string, requestId: string, title: string, goal: string): Promise<{
    project: { id: string; title: string; goal: string }
    pm: { sessionId: string; status: string } | { status: 'unconfirmed'; error: string }
  }> {
    this.requireToolSession(sessionId, 'router')
    const request = this.routerRequests.get(requestId)
    if (!request) throw new ToolCallError('invalid', 'This request is unknown or is too old')
    if (request.dispatchedTicket || request.management) throw new ToolCallError('invalid', 'This request already routed to another action')
    if (request.createdProject === undefined) {
      if (request.proposal !== undefined) throw new ToolCallError('invalid', 'This request already carries a relay proposal')
      const project = this.createProjectFromHumanRequest(title, goal, request.text, 'router')
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

  routerDispatch(sessionId: string, requestId: string, title: string, goal: string):
    { ticket: ConsoleTicket; worker?: { sessionId: string; status: string } } {
    this.requireToolSession(sessionId, 'router')
    const request = this.routerRequests.get(requestId)
    if (!request) throw new ToolCallError('invalid', 'This request is unknown or is too old')
    if (request.createdProject || request.proposal || request.management) {
      throw new ToolCallError('invalid', 'This request already routed to another action')
    }
    if (!request.dispatchedTicket) {
      this.requireNodeOnline()
      const id = request.id
      const trigger: Trigger = { id, source: PROJECT_REQUEST_SOURCE, threads: [{ source: PROJECT_REQUEST_SOURCE, id }],
        actor: { source: PROJECT_REQUEST_SOURCE, id: PROJECT_REQUEST_ACTOR }, human: true, at: request.at,
        text: request.text, meta: { title, goal } }
      const ticketId = this.store.atomic(() => {
        this.engine.recordTriggerForRouting(trigger)
        const decision = this.engine.decide(id, { kind: 'accept', title, scope: goal, acknowledgement: goal,
          reason: { code: 'explicitRouted' } })
        if (!decision.ticketId) throw new ToolCallError('invalid', 'The request did not create a Ticket')
        return decision.ticketId
      })
      request.dispatchedTicket = { id: ticketId, title, goal }
      this.audit.record({ actor: 'router', kind: 'ticket', action: 'created', targetKind: 'ticket',
        targetId: ticketId, detail: title })
    }
    const dispatched = request.dispatchedTicket
    if (dispatched.title !== title || dispatched.goal !== goal) {
      throw new ToolCallError('invalid', 'This request already dispatched a different Ticket')
    }
    return this.routerTicketResult(this.requireStandaloneTicket(dispatched.id))
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
    if (request.createdProject || request.proposal || request.dispatchedTicket) {
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
        const result = this.engine.messageTicket(ticket.id, text)
        return { ...this.routerTicketResult(result.ticket), delivery: result.delivered }
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
    return {
      project: { id: project.id, title: project.title, goal: project.goal, status: project.status,
        ...(project.pauseMode === undefined ? {} : { pauseMode: project.pauseMode }),
        ...(project.latestReport === undefined ? {} : { latestReport: project.latestReport }) },
      tickets,
      ...(memory.length === 0 ? {} : { memory: memory.map(entry => ({ at: entry.at, actor: entry.actor, text: entry.text })) }),
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
    return this.engine.messageTicket(ticketId, text, false)
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
    const delivery = this.executor.deliveryInFlight(assignmentId)
    if (!delivery?.inputIds.includes(revisionInputId)) return undefined
    await delivery.work
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
    const cleanups: { ticketId: string; work: Promise<void> }[] = []
    if (options.reconfirm === true) {
      // The Assignment ended but the node never confirmed the stop: ask it again, so the Worker really stops.
      this.engine.reconfirmStoppedWorker(project.id, project.pmSessionId, ticketId, target.id,
        { ...(options.reason ? { reason: options.reason } : {}), cleanups })
    } else {
      this.engine.stopProjectWorker(project.id, project.pmSessionId, ticketId, target.id,
        { ...(options.reason ? { reason: options.reason } : {}), cleanups })
    }
    const work = cleanups[0]?.work
    this.setStopState(ticketId, { assignmentId: target.id, state: 'stopping', ...(work ? { work } : {}) })
    if (work) {
      // The cleanup settles on its own: it decides the state, whoever is waiting for it.
      void work.then(
        () => { this.setStopState(ticketId, { assignmentId: target.id, state: 'stopped' }) },
        (error: unknown) => { this.setStopState(ticketId, { assignmentId: target.id, state: 'failed',
          error: this.stopDiagnostic(ticketId, target.id, messageOf(error)) }) })
    }
    if (!work) return { stopped: true }
    const settled = await this.settleStopWork(work)
    if (settled.state === 'stopped') {
      this.setStopState(ticketId, { assignmentId: target.id, state: 'stopped' })
      return { stopped: true }
    }
    if (settled.state === 'pending') {
      // The node has not answered: the Worker may still run, so the failure is recorded and no replacement starts.
      const timeoutMs = this.options.stopCleanupTimeoutMs ?? STOP_CLEANUP_TIMEOUT_MS
      const error = this.noteUnconfirmedStop(ticketId, target.id,
        `The Worker Session did not stop within ${timeoutMs} ms`)
      return { stopped: false, error }
    }
    const error = this.stopDiagnostic(ticketId, target.id, settled.error)
    this.setStopState(ticketId, { assignmentId: target.id, state: 'failed', error })
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
   * A report that must not wake the PM is skipped and recorded: a Project that is not active (paused, archived or
   * ended), a PM that does not exist (the control plane never creates one on its own), and a report the PM already
   * knows. A message the node refuses or cannot receive is recorded as failed with a redacted diagnostic; the report
   * stays written either way.
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
    const key = pmReportKey(facts)
    const known = this.notifiedReports.get(assignmentId) ?? new Set<string>()
    if (known.has(key)) {
      finish('skipped', 'the PM already knows this report')
      this.markReportNotified(ledgerKey)
      return
    }
    known.add(key)
    // The oldest key goes first, so one Assignment that reports many different texts keeps a bounded memory.
    while (known.size > NOTIFIED_REPORTS_PER_ASSIGNMENT) {
      const oldest = known.values().next().value
      if (oldest === undefined) break
      known.delete(oldest)
    }
    this.notifiedReports.set(assignmentId, known)
    // The wake-up runs in the background: the PM's Session may be busy, and the Worker's report must not wait for it.
    void this.sendMessage(manager.sessionId, pmReportMessage(facts), undefined, 'system').then(
      () => { finish('sent'); this.markReportNotified(ledgerKey) },
      (error: unknown) => {
        // The delivery failed: the report stays written, and the key goes back so a later report with the same content
        // may try again once the node is reachable. The ledger entry stays unnotified for the same reason.
        known.delete(key)
        finish('failed', redact(messageOf(error)).slice(0, 300))
      })
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
    this.requireNodeOnline()
    // A concurrent request joins the running ensure before reading the record: a node status event may already have made
    // the record `idle` while the ensure still waits on role installation, and returning that record would report 200
    // for an ensure that can still fail.
    const pending = this.pendingEnsures.get(project.pmSessionId)
    if (pending) return pending
    const existing = this.sessions.get(project.pmSessionId)
    if (existing && isNodeConfirmed(existing.status) && !this.needsReensure(existing)) return existing
    return this.singleFlight(project.pmSessionId, () => this.ensurePm(project, workspace))
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
    const pending = this.pendingEnsures.get(sessionId)
    if (pending) return pending
    const existing = this.sessions.get(sessionId)
    if (existing && isNodeConfirmed(existing.status) && !this.needsReensure(existing)) return existing
    return this.singleFlight(sessionId, () => this.ensureWorker(projectId, assignmentId, ticketId, prompt))
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

  private async ensurePm(project: ProjectProfile, workspace?: string): Promise<SessionRecord> {
    const existing = this.sessions.get(project.pmSessionId)
    // A confirmed record from an older generation is re-ensured rather than inspected: the node's answer would be the
    // same stale fact the generation already told us not to trust.
    const stale = existing !== undefined && this.needsReensure(existing)
    if (existing && !stale && isNodeConfirmed(existing.status)) return existing
    if (existing && !stale) {
      const confirmed = await this.confirmExisting(existing)
      if (confirmed) return confirmed
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
      return this.recoverEnsureFailure(record, error, 'PM')
    }
    const settled = await this.settleEnsure(record, 'PM')
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
    if (existing && !stale && isNodeConfirmed(existing.status)) return existing
    if (existing && !stale) {
      const confirmed = await this.confirmExisting(existing)
      if (confirmed) return confirmed
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
      return this.recoverEnsureFailure(record, error, 'Worker')
    }
    return this.settleEnsure(record, 'Worker')
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
    }
    const token = this.tokens.get(sessionId) ?? this.issueToken(record)
    this.tokens.set(sessionId, token)
    const key = options.idempotencyKey ?? this.uniqueKey('message', sessionId)
    await this.options.node.send({ ...this.base(key), type: 'session.message', sessionId, text,
      sessionToken: token, ...(inputIds && inputIds.length ? { inputIds } : {}),
      ...(options.routerModel ? { routerModel: options.routerModel } : {}) })
    if (origin === 'operator') {
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
        const repeat = (): void => { void this.stopSession(sessionId, reason).catch(() => {}) }
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
   */
  async sendToSession(sessionId: string, text: string): Promise<{ via: 'session' | 'ticket'; delivered: string }> {
    const record = this.requireSession(sessionId)
    if (record.revokedAt) {
      throw new OperatorError(409, `The Session ${sessionId} was revoked; it cannot receive a message any more`)
    }
    if (record.role === 'pm') {
      await this.sendMessage(sessionId, text, undefined, 'operator')
      return { via: 'session', delivered: 'session' }
    }
    if (record.role === 'worker') {
      const ticket = record.assignmentId ? this.ticketOfAssignment(record.assignmentId) : undefined
      if (!ticket) {
        throw new OperatorError(409, `The Worker Session ${sessionId} has no Ticket; there is nothing to deliver a message to`)
      }
      const result = this.engine.messageTicket(ticket.id, text, false)
      // The message itself is not copied into the audit: its size and its target are the facts worth keeping.
      this.audit.record({ actor: 'operator', kind: 'session', action: 'message', targetKind: 'session',
        targetId: sessionId, detail: `${text.length} 字` })
      return { via: 'ticket', delivered: result.delivered }
    }
    throw new OperatorError(409, `The Session ${sessionId} cannot receive an operator message`)
  }

  /**
   * Stop a Session, by the role that Session has.
   *
   * A Worker Session is stopped through its Ticket: the Assignment ends in the domain, the node is asked to stop the
   * Worker, and the answer decides whether the Worker is really gone. The stop shares the Ticket's own serial queue with
   * the PM's re-dispatch, so a cleanup never starts a second Worker over one that may still run.
   *
   * A PM Session is refused: it has no Assignment of its own, and stopping it would leave its Project without the PM that
   * manages it — while ending that Project is a decision about the Project, not about one Session. The Project's own
   * lifecycle is the action that fits, and the operator takes it there.
   */
  async stopSessionByOperator(sessionId: string, reason?: string): Promise<{ stopped: boolean; scope: string; error?: string }> {
    const record = this.requireSession(sessionId)
    if (record.role === 'pm') {
      throw new OperatorError(409, 'Stopping a PM Session is not an operator action: end the Project it manages instead')
    }
    if (record.role !== 'worker') {
      throw new OperatorError(409, `The Session ${sessionId} cannot be stopped by an operator`)
    }
    const outcome = await this.stopWorkerSession(record, reason ?? 'An operator stopped this Worker')
    this.audit.record({ actor: 'operator', kind: 'session', action: 'stopped', targetKind: 'session', targetId: sessionId,
      outcome: outcome.stopped ? 'ok' : 'failed', detail: 'worker' })
    return { stopped: outcome.stopped, scope: 'worker', ...(outcome.error ? { error: outcome.error } : {}) }
  }

  /**
   * Stop one Worker's Assignment and wait for the node to confirm it.
   *
   * The Assignment ends in the domain and the node is asked to stop the Session; the answer decides whether the Worker is
   * really gone. A Worker whose Assignment is already over only has the node Session left to stop. A Project that is not
   * active takes no project-scope stop, so the person's own stop ends the Ticket instead.
   */
  private async stopWorkerSession(record: SessionRecord, reason: string): Promise<{ stopped: boolean; error?: string }> {
    const assignmentId = record.assignmentId
    const ticket = assignmentId ? this.ticketOfAssignment(assignmentId) : undefined
    if (!ticket || !assignmentId) {
      // No Assignment behind this Session: there is no domain work to stop, only the node Session.
      await this.cancelSession(record.sessionId, reason)
      return { stopped: true }
    }
    if (ticket.projectId === undefined) {
      return this.withTicketOperation(ticket.id, async () => {
        const current = this.requireStandaloneTicket(ticket.id)
        if (latestAssignment(current)?.id === assignmentId) return this.stopStandaloneTicket(current, reason)
        await this.cancelSession(record.sessionId, reason)
        return { stopped: true }
      })
    }
    const project = ticket.projectId ? this.store.projects.get(ticket.projectId) : undefined
    if (!project) {
      await this.cancelSession(record.sessionId, reason)
      return { stopped: true }
    }
    // The stop and a re-dispatch of the same Ticket never overlap: they share the Ticket's own serial queue.
    return this.withTicketOperation(ticket.id, async (): Promise<{ stopped: boolean; error?: string }> => {
      const current = this.store.tickets.get(ticket.id) ?? ticket
      const latest = latestAssignment(current)
      if (!latest || latest.id !== assignmentId || latest.state === 'ended') {
        // The Assignment this Session ran is over: only the node Session can be left over.
        await this.cancelSession(record.sessionId, reason)
        return { stopped: true }
      }
      if (project.status === 'active') {
        return this.performStop(project, ticket.id, latest, { reason })
      }
      // A paused, ended or archived Project takes no project-scope stop, so the person's own stop ends the Ticket.
      this.engine.stopTicket(ticket.id, reason)
      await this.cancelSession(record.sessionId, reason)
      return { stopped: true }
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
    // The scheduler writes to the console's own file, so it is stopped before that file is closed: a delivery still in
    // flight gets its record written instead of finding a closed database.
    await this.stopScheduler()
    this.unsubscribe()
    this.eventListeners.clear()
    this.sessions.clear()
    this.tokens.clear()
    this.stoppingSessions.clear()
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
      record.status = event.status
      record.updatedAt = event.at
      if (event.status === 'archived') record.archivedAt = event.at
      // The node confirmed the Session is gone: it must not be brought back by a message or a re-ensure.
      if (event.status === 'stopped' || event.status === 'archived') this.stoppingSessions.delete(event.sessionId)
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
