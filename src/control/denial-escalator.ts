/**
 * The escalation of the permission denials the control plane and the node's tool bridge refuse.
 *
 * A denial here is a *fact about a refusal that already happened*: the role profile refused a tool, a call reached
 * outside the Session's Project, a call went beyond the delegation the Session holds, or the backend's own file
 * sandbox refused a call that reached outside the Session's workspace. Nothing in this module ever guesses. It does not
 * read a model's output, a log line, an arbitrary tool error or a piece of untrusted request text, and it only ever
 * counts the four reason codes the protocol names. A node that is offline, a token that may be refreshed, a malformed
 * argument, a command that failed, a timeout, a person who stopped a Session and a Worker's own `blocked` report are
 * all facts about something else, and none of them is a denial.
 *
 * The counters live in the control plane's own file, in the table `permission_denial_counters`, next to the audit of
 * every refused call and the review that was made about it. Three things are kept apart on purpose:
 *
 * - the **audit** of each refused call, which is written once per genuine call and never twice for a replay;
 * - the **counter** of the escalation, which folds a burst of the same refusal in one turn into one effective denial;
 * - the **fuse**, which counts the raw refused calls of one turn and ends that turn when the model keeps hitting the
 *   same wall.
 *
 * The burst folding and the fuse are not the same number. Five identical refusals in one turn are one denial for the
 * escalation and five for the fuse: the escalation must not fire on a batch of parallel calls, and the fuse must still
 * see that the model is looping.
 *
 * The window the escalation counts in is a **sliding** one. It is not a fixed frame that opens with the first refusal
 * and closes ten minutes later: it always covers the last `windowMs` of the scope's own history, so a refusal that
 * arrives while the scope is still active joins the count it belongs to, and a refusal that arrives after the scope has
 * gone quiet starts the count again without throwing the earlier numbers away. The cooldown is kept across that
 * rollover, so a scope that just made a review stays quiet even while its window slides.
 *
 * The escalation itself is a review, not a grant. It tells the superior that the work hit a wall, and the superior may
 * change the plan within the permissions it already has or ask the operator for an explicit authorization. It never
 * grants an access, never widens a role, and never repeats the refused call.
 */
import { createHash } from 'node:crypto'
import type { ProjectProfile, Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { redact } from '../infra/redact.ts'
import { NodeUnconfirmedError, GUARD_DENIAL_REASON_CODES, type GuardDenialReasonCode, type SessionRecord,
  type SessionRole } from '../shared/protocol.ts'
import type { AuditInput } from './console-audit.ts'
import { readContext, type CoordinationDeliveryKind, type CoordinationDeliveryRow, type DeliveryOutbox,
  type DeliveryRevalidation } from './delivery-outbox.ts'
import type { NodeResolutionResult, ResolvedTarget } from './node-resolver.ts'

/**
 * Where a denial was decided.
 *
 * `control_plane` is the control plane's own tool ingress, and `node_guard` is the node's own role and workspace guard.
 * The two are the only places a denial may come from: a fact that reached the control plane by any other road is not
 * counted.
 */
export type DenialSource = 'control_plane' | 'node_guard'

/**
 * The kinds of review the escalator writes.
 *
 * A `system_denial_review` goes to the direct superior of the Session that was refused. An `operator_denial_alert` is
 * the top of the ladder: the Router has no superior but the operator, so its review is a record the console shows
 * instead of a message to a Session. Both are separate from the `blocked` report a Worker or a PM makes on its own
 * initiative, which travels the report channel and never touches these counters.
 */
export type DenialReviewKind = 'system_denial_review' | 'operator_denial_alert'

/**
 * The states one review reaches.
 *
 * `pending_manager_online` says the superior could not be reached — it was stopped, its Project was paused, or the node
 * was offline — and the review waits for it. `dispatching` says the review was claimed for the wire and is on its way;
 * a control plane that stops in that state leaves an unknown outcome, and the review is never sent again on a guess.
 * `notified` says the superior's inbox took the review. `unconfirmed` says the message may have gone out and the
 * receipt is missing; it is never sent again either.
 */
export type DenialReviewStatus = 'pending_manager_online' | 'dispatching' | 'notified' | 'unconfirmed'

/** The target of a review: the Session that has to hear it, or the operator at the top of the ladder. */
export type DenialTarget = 'session' | 'operator'

/**
 * One refused call, as the escalator is told about it.
 *
 * The facts are the ones a guard knows for certain: which Session made the call, which tool it was for, why it was
 * refused, which turn it was made in and which call it was. Nothing here is taken from the request's own text.
 */
export interface DenialFact {
  /** Where the refusal was decided. */
  readonly source: DenialSource
  /** The Session that made the call. */
  readonly controlSessionId: string
  /** The tool the call was for. */
  readonly toolName: string
  /** Why the guard refused it. */
  readonly reasonCode: GuardDenialReasonCode
  /** The turn the call was made in; empty when the guard could not name one. */
  readonly turnId: string
  /** The stable identity of this very call, so a replay is recognised as the same call. */
  readonly callId: string
  /** The node the refusal came from. */
  readonly nodeId: string
  /** The backend the refusal came from. */
  readonly backendId: string
}

/**
 * What the escalator decided about one refused call.
 *
 * `accepted` says the fact was a denial the escalator could attribute. `duplicate` says the very same call was recorded
 * before, so nothing was counted twice. `counted` says the call was a new effective denial for the escalation counter —
 * a burst of identical refusals in one turn counts once. `escalated` says a review was made about it, and `fused` says
 * the turn that produced it was ended.
 */
export interface DenialOutcome {
  /** Whether the fact was a denial the escalator could attribute. */
  readonly accepted: boolean
  /** Why it was not, when it was not. */
  readonly reason?: string
  /** Whether the very same call was already recorded. */
  readonly duplicate?: boolean
  /** Whether the call added to the escalation counter. */
  readonly counted?: boolean
  /** The number of effective denials in the window after the call. */
  readonly count?: number
  /** Whether a review was made about the window. */
  readonly escalated?: boolean
  /** Whether the turn that produced the refusals was ended. */
  readonly fused?: boolean
}

/**
 * The verified context of one refused call.
 *
 * Everything here is read from the control plane's own records, never from the request: the Session's role and Project,
 * the Assignment it runs and the Ticket that owns it. A call that names something else does not change this context, so
 * a denial can never carry another Project's identity into a review.
 */
interface DenialContext {
  /** The Session that made the call. */
  readonly controlSessionId: string
  /** Where the refusal was decided. */
  readonly source: DenialSource
  /** The role of that Session. */
  readonly role: SessionRole
  /** The Project the Session belongs to; empty for a standalone Ticket. */
  readonly projectId: string
  /** The Ticket the Session works on; empty for a PM or the Router. */
  readonly ticketId: string
  /** The Assignment the Session runs; empty for a PM or the Router. */
  readonly assignmentId: string
  /** The lifecycle generation the Session lives in. */
  readonly assignmentEpoch: number
  /** The turn the call was made in; empty when it could not be named. */
  readonly turnId: string
  /** The tool the call was for. */
  readonly toolName: string
  /** Why it was refused. */
  readonly reasonCode: GuardDenialReasonCode
  /** The stable identity of the call. */
  readonly callId: string
  /** The node the refusal came from. */
  readonly nodeId: string
  /** The backend the refusal came from. */
  readonly backendId: string
  /** When the refusal happened. */
  readonly at: string
  /** The scope the counters of this Session run in. */
  readonly scopeKey: string
  /** The superior this Session's denials are escalated to. */
  readonly managerTarget: string
}

/** One counter row: the window, the cooldown and the fuse of one scope. */
interface CounterRow {
  scopeKey: string
  controlSessionId: string
  role: string
  projectId: string
  ticketId: string
  assignmentId: string
  assignmentEpoch: number
  managerTarget: string
  nodeId: string
  backendId: string
  windowStartedAt: string
  windowCount: number
  lastDenialAt: string
  cooldownUntil: string
  noticeId: string
  fuseTurnId: string
  fuseCount: number
  fuseFiredTurnId: string
}

/** One review row: the durable record of one escalation. */
interface ReviewRow {
  noticeId: string
  kind: DenialReviewKind
  scopeKey: string
  at: string
  status: DenialReviewStatus
  controlSessionId: string
  role: string
  projectId: string
  ticketId: string
  assignmentId: string
  assignmentEpoch: number
  turnId: string
  toolName: string
  reasonCode: string
  denialCount: number
  targetSessionId: string
  targetRole: string
  nodeId: string
  backendId: string
  payload: string
  reason: string
  windowStartedAt: string
  /** The scope the review belongs to, as the counter's scope key. */
  managerTarget: string
}

/**
 * One review as the console reads it.
 *
 * It carries the facts of the escalation and never the message that was sent: the message is the control plane's own
 * wording about a lower-trust refusal, and a console that showed it would show it as if it were a report.
 */
export interface DenialReviewView {
  /** The review's own id; it is also the idempotency key the delivery went out under. */
  readonly noticeId: string
  /** `system_denial_review` or `operator_denial_alert`. */
  readonly kind: DenialReviewKind
  /** When the review was made. */
  readonly at: string
  /** The state the review reached. */
  readonly status: DenialReviewStatus
  /** The Session that was refused. */
  readonly controlSessionId: string
  /** The role of that Session. */
  readonly role: string
  /** The Project the Session belongs to. */
  readonly projectId: string
  /** The Ticket the Session works on. */
  readonly ticketId: string
  /** The Assignment the Session runs. */
  readonly assignmentId: string
  /** The turn the refusals were made in. */
  readonly turnId: string
  /** The tool that was refused. */
  readonly toolName: string
  /** Why it was refused. */
  readonly reasonCode: string
  /** How many effective denials the window held. */
  readonly denialCount: number
  /** The Session the review went to; empty for an operator alert. */
  readonly targetSessionId: string
  /** The role of that Session. */
  readonly targetRole: string
  /** The node the refusal came from. */
  readonly nodeId: string
  /** The backend the refusal came from. */
  readonly backendId: string
  /** Why the review is in that state, when there is something to say. */
  readonly reason: string
  /**
   * The bounded projection of the governed work, in the control plane's own controlled fields.
   *
   * It says which phase the Ticket, the Assignment and the Project are in, which kind of report the own scope made last
   * and how its review stands. It never carries a title, a goal, a path or a sentence of a person or a model.
   */
  readonly taskContext: string
}

/**
 * One counter as the console reads it.
 *
 * It carries the numbers of the window and nothing else: the refused calls themselves are not listed, and their
 * arguments are not kept at all.
 */
export interface DenialCounterView {
  /** The scope the counter runs in. */
  readonly scopeKey: string
  /** The Session the counter belongs to. */
  readonly controlSessionId: string
  /** The role of that Session. */
  readonly role: string
  /** The Project the Session belongs to. */
  readonly projectId: string
  /** The Ticket the Session works on. */
  readonly ticketId: string
  /** The Assignment the Session runs. */
  readonly assignmentId: string
  /** The superior the denials are escalated to. */
  readonly managerTarget: string
  /** The node the refusals came from. */
  readonly nodeId: string
  /** The backend the refusals came from. */
  readonly backendId: string
  /** When the window opened. */
  readonly windowStartedAt: string
  /** How many effective denials the window holds. */
  readonly windowCount: number
  /** When the last refusal happened. */
  readonly lastDenialAt: string
  /** Until when no new review is made for this scope. */
  readonly cooldownUntil: string
  /** The review the window produced, when it produced one. */
  readonly noticeId: string
}

/**
 * The authoritative reads and the writes the escalator needs.
 *
 * The escalator owns the counting, the routing rules and the durable records; the host says what the control plane
 * holds and how a message reaches a Session.
 */
/**
 * One explicit human authorization application, as the console reads it.
 *
 * It names the review it is about, who raised it and what became of it, and nothing else: the arguments of the refused
 * call, the words of the model and the identity of another scope never reach it. An application is a request in front of
 * an operator, never a grant — it changes no Mandate, no role and no configuration.
 */
export interface DenialAuthorizationView {
  /** The application's own id. */
  readonly applicationId: string
  /** The review it is about. */
  readonly reviewId: string
  /** `pending`, `acknowledged` or `declined`. */
  readonly status: string
  /** The Session that raised it. */
  readonly applicantSessionId: string
  /** The role of that Session. */
  readonly applicantRole: string
  /** The Session that was refused. */
  readonly controlSessionId: string
  /** The Project the refused Session belongs to. */
  readonly projectId: string
  /** The Ticket the refused Session works on. */
  readonly ticketId: string
  /** The Assignment the refused Session runs. */
  readonly assignmentId: string
  /** Why the call was refused. */
  readonly reasonCode: string
  /** The tool that was refused. */
  readonly toolName: string
  /** How many effective denials the window held. */
  readonly denialCount: number
  /** When the application was raised. */
  readonly requestedAt: string
  /** When the operator decided about it. */
  readonly decidedAt: string
  /** The operator's decision; empty while the application waits. */
  readonly decision: string
}

/**
 * A request that may not become an authorization application.
 *
 * The reason is the control plane's own sentence: it says what kind of thing happened and never copies the caller's own
 * words.
 */
export class DenialAuthorizationError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'DenialAuthorizationError'
  }
}

export interface DenialEscalatorHost {
  /** The current time, as the control plane's own clock reads it. */
  now(): string
  /** The node this control plane talks to. */
  nodeId(): string
  /** The backend that runs the Sessions of this node. */
  backendId(): string
  /** The Session record, when the control plane holds one. */
  session(sessionId: string): SessionRecord | undefined
  /** The Project by its own id. */
  project(projectId: string): ProjectProfile | undefined
  /** The Ticket that owns an Assignment. */
  ticketOfAssignment(assignmentId: string): Ticket | undefined
  /** The Session id of the Router, the one Session that belongs to no Project. */
  routerSessionId(): string
  /** The turn the Session runs right now, as the node reported it. */
  currentTurn(sessionId: string): number | undefined
  /** The lifecycle generation of a Session: the Assignment's for a Worker, the managed Session's for a PM or the Router. */
  targetEpochs(sessionId: string): { assignmentEpoch: number; toolTokenVersion: number }
  /** Resolve a target Session and the generations it was read under. */
  resolveTarget(sessionId: string, op: 'message'): Promise<NodeResolutionResult<ResolvedTarget>>
  /**
   * Resolve a target Session again, without waiting for the node.
   *
   * The check that runs immediately before the transport may not await anything, so it reads the answer from the control
   * plane's own records at that very moment.
   */
  resolveTargetNow(sessionId: string, op: 'message'): NodeResolutionResult<ResolvedTarget>
  /**
   * Deliver one message to a Session under the node's own idempotency key.
   *
   * The call throws when the message did not go out. A missing receipt means the message may have arrived and is never
   * repeated on a guess.
   */
  deliver(sessionId: string, text: string, idempotencyKey: string, validateForSend?: () => void,
    kind?: CoordinationDeliveryKind): Promise<void>
  /** Interrupt the Session's current turn, and only that turn. */
  interruptTurn(sessionId: string, reason: string, turn: number):
    Promise<{ interrupted: boolean; confirmed: boolean; refusal?: string; error?: string }>
  /** Write one line of the audit trail. */
  audit(input: AuditInput): void
}

/** How the escalator is configured. */
export interface DenialEscalatorOptions {
  /**
   * The width of the window the denials are counted in, in milliseconds.
   *
   * The default is ten minutes: long enough that a model which keeps hitting the same wall is caught, short enough that
   * a burst of yesterday does not wake a superior today. The window slides: it always covers the last `windowMs` of the
   * scope's own history.
   */
  windowMs?: number
  /**
   * How many effective denials in one window make a review.
   *
   * The default is three: one refusal may be a mistake, three are a wall.
   */
  threshold?: number
  /**
   * How long one scope stays quiet after a review, in milliseconds.
   *
   * The cooldown is finite on purpose: an endless cooldown would silence the escalator for good, and a review that is
   * never made again is a wall nobody sees. It is kept across the window's rollover, so a scope that just made a review
   * stays quiet while its window slides.
   */
  cooldownMs?: number
  /**
   * How many refused calls in one turn end that turn.
   *
   * The default is five: a model that tries the same forbidden thing five times in one turn is looping, and the turn is
   * ended so it stops spending the context on it. The turn is interrupted, never stopped: the Session keeps its
   * identity, its authority and its inbox.
   */
  fuseLimit?: number
}

/** The window the denials are counted in, when nothing else is configured. */
export const DEFAULT_DENIAL_WINDOW_MS = 600_000
/** The effective denials that make a review, when nothing else is configured. */
export const DEFAULT_DENIAL_THRESHOLD = 3
/** How long a scope stays quiet after a review, when nothing else is configured. */
export const DEFAULT_DENIAL_COOLDOWN_MS = 600_000
/** The refused calls in one turn that end that turn, when nothing else is configured. */
export const DEFAULT_DENIAL_FUSE_LIMIT = 5

/**
 * The reason codes a denial may carry.
 *
 * They are the protocol's own four codes, so the wire, the table and the check that reads it cannot drift apart: a row
 * whose reason code is not one of these is not a denial and is never counted.
 */
const REASON_CODES: ReadonlySet<string> = new Set<string>(GUARD_DENIAL_REASON_CODES)

/** How long the summary of a refused call may be. */
const SUMMARY_LIMIT = 160
/** How long the projection of the governed work may be. */
const PROJECTION_LIMIT = 240
/** How long the reason of a review may be. */
const REASON_LIMIT = 300

/**
 * The reasons a review may carry.
 *
 * They are fixed sentences, never a message of the node and never a line of a log: an arbitrary error text may hold a
 * path, an argument a person pasted into a task or a secret, and the record of a review is not the place for it. The
 * reason says what kind of thing happened, in the control plane's own words.
 */
const REASONS = {
  superiorStopped: 'the superior was stopped by an operator',
  nodeUnreachable: 'the node is not reachable',
  superiorUnreachable: 'the superior may not be reached',
  superiorGone: 'the superior of this Session does not exist',
  sourceGone: 'the Session that was refused is gone',
  sourceRevoked: 'the Session that was refused was revoked',
  sourceStopped: 'the Session that was refused was stopped by an operator',
  sourceMoved: 'the Session that was refused has moved on',
  targetMoved: 'the superior of the refused Session has moved on',
  targetNotTheManager: 'the review does not belong to that superior',
  deliveryUnconfirmed: 'the node did not confirm the delivery',
  deliveryFailed: 'the review did not reach its superior',
  dispatchUnknown: 'the control plane stopped while the review was on its way; its outcome is unknown',
} as const

/** The tables the escalator owns. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS permission_denial_counters (
  scope_key TEXT PRIMARY KEY,
  control_session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_epoch INTEGER NOT NULL,
  manager_target TEXT NOT NULL,
  node_id TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  window_count INTEGER NOT NULL,
  last_denial_at TEXT NOT NULL,
  cooldown_until TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  fuse_turn_id TEXT NOT NULL,
  fuse_count INTEGER NOT NULL,
  fuse_fired_turn_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS permission_denial_calls (
  call_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  source TEXT NOT NULL,
  control_session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_epoch INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  node_id TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  at TEXT NOT NULL,
  summary TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS permission_denial_calls_scope ON permission_denial_calls(scope_key, at);
CREATE INDEX IF NOT EXISTS permission_denial_calls_burst
  ON permission_denial_calls(scope_key, turn_id, tool_name, reason_code);
CREATE TABLE IF NOT EXISTS permission_denial_effective (
  scope_key TEXT NOT NULL,
  group_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (scope_key, group_key));
CREATE INDEX IF NOT EXISTS permission_denial_effective_at ON permission_denial_effective(scope_key, at);
CREATE TABLE IF NOT EXISTS permission_denial_reviews (
  notice_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL,
  control_session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_epoch INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  denial_count INTEGER NOT NULL,
  target_session_id TEXT NOT NULL,
  target_role TEXT NOT NULL,
  node_id TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  reason TEXT NOT NULL,
  window_started_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS permission_denial_reviews_scope ON permission_denial_reviews(scope_key, at);
CREATE TABLE IF NOT EXISTS denial_authorization_applications (
  application_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  applicant_session_id TEXT NOT NULL,
  applicant_role TEXT NOT NULL,
  control_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  denial_count INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  decision TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS denial_authorization_applications_scope
  ON denial_authorization_applications(scope_key, requested_at);
`

/**
 * The scope one Session's denials are counted in.
 *
 * It names the Session, the Ticket it works on, the lifecycle generation it lives in and the superior the denials are
 * escalated to. The generation is part of it on purpose: a Worker that was replaced starts a new life, and the denials of
 * the old one do not count towards the new one.
 */
function scopeKeyOf(controlSessionId: string, ticketId: string, assignmentEpoch: number, managerTarget: string): string {
  return JSON.stringify([controlSessionId, ticketId, assignmentEpoch, managerTarget])
}

/**
 * The stable identity of one review.
 *
 * It is derived from the scope and from the set of effective denials the window holds, so a review of one wall cluster
 * has one name: a restart, a second attempt or a second caller all reach the same row, and the review is made once. The
 * set is sorted and the walls are named by their own identity, so hitting the same wall again — which moves the moment
 * it was last refused — does not make the review a different one.
 */
function noticeIdOf(scopeKey: string, groups: readonly string[]): string {
  return `denial-review-${createHash('sha256').update(`${scopeKey}|${groups.join(',')}`).digest('hex').slice(0, 32)}`
}

/**
 * The phase of a Ticket, in the control plane's own words.
 *
 * It is a controlled field on purpose: a Ticket's title, goal and scope are the words of a person or a model, and they
 * never reach a review or a console.
 */
function ticketPhaseOf(ticket: Ticket): string {
  if (ticket.archived !== undefined) return 'archived'
  if (ticket.ended !== undefined) return 'ended'
  if (ticket.manualStop !== undefined) return 'stopped'
  return 'open'
}

/**
 * The stable identity of one refused call.
 *
 * It is a digest of the facts that name the call, so the same call always has the same name and another call never
 * shares it. A replay of a request, a repeated event or a retried tool call is therefore recognised as the very same
 * call: it is neither audited nor counted a second time.
 */
export function denialCallId(parts: readonly string[]): string {
  return `denial-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)}`
}

/**
 * The identity of one effective denial.
 *
 * An effective denial is the same turn refusing the same tool for the same reason: the raw refusals are all audited,
 * but a model that fires the same forbidden call five times in one turn has hit one wall, not five. The key names the
 * group, so the group is one row and the window counts it once.
 */
function effectiveGroupKey(turnId: string, toolName: string, reasonCode: string): string {
  return createHash('sha256').update(`${turnId}|${toolName}|${reasonCode}`).digest('hex').slice(0, 32)
}

/** The reason a resolution refused, as a short line. */
function refusalOutcome(code: string): { status: DenialReviewStatus; reason: string } {
  if (code === 'MANUALLY_STOPPED') return { status: 'pending_manager_online', reason: REASONS.superiorStopped }
  if (code === 'NODE_OFFLINE' || code === 'BACKEND_UNAVAILABLE') {
    return { status: 'pending_manager_online', reason: REASONS.nodeUnreachable }
  }
  return { status: 'pending_manager_online', reason: REASONS.superiorUnreachable }
}

/**
 * A review that may not go on the wire any more.
 *
 * The check that runs immediately before the transport found that the life the review was planned for is over: the
 * source moved on, or the superior is not the manager of the work any more. The message never left this control plane,
 * so it is neither a lost receipt nor a refusal by the node.
 */
export class DenialReviewStaleError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'DenialReviewStaleError'
  }
}

/**
 * The escalator of the permission denials.
 *
 * It owns the counters, the burst folding, the fuse and the reviews; the control plane owns the facts and the delivery.
 */
export class DenialEscalator {
  /** The width of the counting window, in milliseconds. */
  private readonly windowMs: number
  /** The effective denials that make a review. */
  private readonly threshold: number
  /** How long a scope stays quiet after a review, in milliseconds. */
  private readonly cooldownMs: number
  /** The refused calls in one turn that end that turn. */
  private readonly fuseLimit: number
  /**
   * The revisits that are running right now.
   *
   * A review that waits for a superior is carried out again when there is evidence that the superior can be reached. Two
   * such revisits may be asked for at the same time — a resume and a reconnect, say — and the claim of a review keeps
   * them from sending it twice; the flag keeps them from doing the same work twice as well, and a revisit that was asked
   * for while one was running is not lost: it runs again as soon as the first one is done.
   */
  private revisiting = false
  /** Whether another revisit was asked for while one was running. */
  private revisitQueued = false

  constructor(private readonly store: Store, private readonly outbox: DeliveryOutbox, private readonly host: DenialEscalatorHost,
    options: DenialEscalatorOptions = {}) {
    this.windowMs = positive(options.windowMs, DEFAULT_DENIAL_WINDOW_MS)
    this.threshold = positive(options.threshold, DEFAULT_DENIAL_THRESHOLD)
    this.cooldownMs = finite(options.cooldownMs, DEFAULT_DENIAL_COOLDOWN_MS)
    this.fuseLimit = positive(options.fuseLimit, DEFAULT_DENIAL_FUSE_LIMIT)
    this.store.db.exec(SCHEMA)
  }

  /** The width of the counting window, in milliseconds. */
  get window(): number { return this.windowMs }

  /** The effective denials that make a review. */
  get limit(): number { return this.threshold }

  /** How long a scope stays quiet after a review, in milliseconds. */
  get cooldown(): number { return this.cooldownMs }

  /** The refused calls in one turn that end that turn. */
  get fuse(): number { return this.fuseLimit }

  /**
   * Record one refused call, and act on it when the numbers call for it.
   *
   * The call is written once: a replay of the very same call is recognised and changes nothing, so a retried request or a
   * repeated event never inflates the audit or the counter.
   */
  async record(fact: DenialFact): Promise<DenialOutcome> {
    const verified = this.verify(fact)
    if (!verified.ok) return { accepted: false, reason: verified.reason }
    const context = verified.context
    // The counter, the audit of the call and the claim of a review happen together: a review that exists always has the
    // calls that caused it, and a call that was written always has its counter move.
    const outcome = this.store.atomic(() => {
      if (this.callExists(context.callId)) return { duplicate: true as const }
      const counter = this.bump(context)
      if (!counter.inserted) return { duplicate: true as const, counter }
      if (counter.escalationReady) {
        const review = this.claimReview(context, counter)
        return { duplicate: false as const, counter, review }
      }
      return { duplicate: false as const, counter, review: undefined }
    })
    if (outcome.duplicate) return { accepted: true, duplicate: true }
    // The fuse ends the turn that produced the refusals. It is a separate step from the escalation: a burst that is
    // folded into one denial may still be a model that is looping.
    const fused = outcome.counter.fuseReady ? await this.interruptFusedTurn(context) : false
    // The review is carried out after the transaction: the message goes out of this control plane, and the record of the
    // attempt is written afterwards.
    if (outcome.review !== undefined) await this.carryOut(outcome.review)
    return {
      accepted: true,
      counted: outcome.counter.counted,
      count: outcome.counter.windowCount,
      escalated: outcome.review !== undefined,
      fused,
    }
  }

  /**
   * Verify one refused call against the control plane's own records.
   *
   * A fact is only a denial when it comes from the node this control plane talks to, names a Session this control plane
   * holds, and names a life that is still alive: a revoked Session, a replaced Assignment, a Ticket of another Project
   * and a turn that already ended are all refused here rather than counted.
   *
   * A turn is checked when the control plane knows which turn runs. A fact that names another turn is a late fact about
   * a turn that is over, and it is refused. A fact that names no turn at all is still a denial — the guard knew it
   * refused something — and it is bound to the turn the Session runs right now, because that is the turn the refusal
   * happened in.
   */
  private verify(fact: DenialFact): { ok: true; context: DenialContext } | { ok: false; reason: string } {
    if (!REASON_CODES.has(fact.reasonCode)) return { ok: false, reason: 'this reason code is not a permission denial' }
    if (fact.callId.trim() === '') return { ok: false, reason: 'the refusal names no call' }
    if (fact.toolName.trim() === '') return { ok: false, reason: 'the refusal names no tool' }
    if (fact.nodeId !== this.host.nodeId()) return { ok: false, reason: 'the refusal came from another node' }
    if (fact.backendId !== this.host.backendId()) return { ok: false, reason: 'the refusal came from another backend' }
    const record = this.host.session(fact.controlSessionId)
    if (record === undefined) return { ok: false, reason: 'the refusal names no Session of this control plane' }
    if (record.nodeId !== '' && record.nodeId !== this.host.nodeId()) {
      return { ok: false, reason: 'the Session the refusal names belongs to another node' }
    }
    if (record.revokedAt !== undefined) return { ok: false, reason: 'the Session the refusal names was revoked' }
    // A Session a person stopped has no authority any more: a refusal that arrives after the stop is a fact about a life
    // that is over, and it is not counted.
    if (record.operatorStop !== undefined) {
      return { ok: false, reason: 'the Session the refusal names was stopped by an operator' }
    }
    // The lifecycle the Session lives in: the Assignment's for a Worker, the managed Session's for a PM and the Router.
    const epochs = this.host.targetEpochs(record.sessionId)
    const assignmentEpoch = epochs.assignmentEpoch
    // A Worker's scope is its Assignment's Ticket; a PM's scope is its Project and the Router's is none at all.
    let ticketId = ''
    let projectId = record.role === 'router' ? '' : record.projectId
    let assignmentId = record.assignmentId ?? ''
    if (record.role === 'worker') {
      if (assignmentId === '') return { ok: false, reason: 'the Worker Session the refusal names runs no Assignment' }
      const ticket = this.host.ticketOfAssignment(assignmentId)
      if (ticket === undefined) return { ok: false, reason: 'the Assignment the refusal names belongs to no Ticket' }
      const current = ticket.assignments.at(-1)
      if (current === undefined || current.id !== assignmentId) {
        return { ok: false, reason: 'the Assignment the refusal names was replaced' }
      }
      ticketId = ticket.id
      projectId = ticket.projectId ?? ''
      // A standalone Ticket is its own scope; a Project's Ticket belongs to that Project.
      if (projectId !== '' && projectId !== record.projectId) {
        return { ok: false, reason: 'the Ticket the refusal names is not the one the Session works on' }
      }
    }
    // The turn: the control plane's own fact is the authority, and a fact that names another turn is late.
    const known = this.host.currentTurn(record.sessionId)
    let turnId = fact.turnId.trim()
    if (known !== undefined && turnId !== '' && turnId !== String(known)) {
      return { ok: false, reason: 'the refusal names a turn that is over' }
    }
    if (turnId === '' && known !== undefined) turnId = String(known)
    const managerTarget = this.managerTargetOf(record, projectId)
    const scopeKey = scopeKeyOf(record.sessionId, ticketId, assignmentEpoch, managerTarget)
    return {
      ok: true,
      context: {
        controlSessionId: record.sessionId,
        source: fact.source,
        role: record.role,
        projectId,
        ticketId,
        assignmentId,
        assignmentEpoch,
        turnId,
        toolName: fact.toolName.trim(),
        reasonCode: fact.reasonCode,
        callId: fact.callId.trim(),
        nodeId: this.host.nodeId(),
        backendId: this.host.backendId(),
        at: this.host.now(),
        scopeKey,
        managerTarget,
      },
    }
  }

  /**
   * The superior one Session's denials are escalated to.
   *
   * The routing is by business ownership, exactly as the reports are routed: a Worker's denials go to the PM of its own
   * Project, a standalone Worker's and a PM's go to the Router, and the Router has no superior but the operator.
   */
  private managerTargetOf(record: SessionRecord, projectId: string): string {
    if (record.role === 'router') return 'operator'
    if (record.role === 'pm') return 'router'
    if (projectId === '') return 'router'
    return `pm:${projectId}`
  }

  /**
   * Move the counter of one scope, and say what may follow.
   *
   * The window is a sliding one: it always covers the last `windowMs` of the scope's own history, so a refusal that
   * arrives while the scope is still active joins the count it belongs to, and a refusal that arrives after the scope
   * has gone quiet starts the count again without throwing the earlier numbers away. Inside the window the *effective*
   * denials are counted, and a burst of the same tool and reason in the same turn counts once — the raw refusals are all
   * audited, but a batch of parallel calls is not a wall.
   *
   * The cooldown is kept across the window's rollover: a scope that just made a review stays quiet even while its window
   * slides and its older numbers drop out.
   */
  private bump(context: DenialContext):
    { windowCount: number; windowStartedAt: string; groups: string[]; counted: boolean; escalationReady: boolean;
      fuseReady: boolean; inserted: boolean } {
    const row = this.counterOf(context.scopeKey)
    const now = Date.parse(context.at)
    const at = Number.isFinite(now) ? now : Date.parse(this.host.now())
    // The edge of the sliding window: everything newer than this is inside it, everything older is out of it. The edge is
    // written as an ISO moment, because the moments of the table are ISO moments and the two are compared as such.
    const edge = Number.isFinite(at) ? new Date(at - this.windowMs).toISOString() : ''
    // The fuse counts the raw refusals of one turn: five separate calls in one turn are five, even when they are all the
    // same call in the counter's eyes. The fuse belongs to the turn, not to the window: a turn that outlives the window
    // keeps its place in it.
    const fuseTurnId = context.turnId === '' ? (row?.fuseTurnId ?? '') : context.turnId
    const fuseCount = context.turnId === '' ? (row?.fuseCount ?? 0)
      : (row === undefined || row.fuseTurnId !== context.turnId ? 1 : row.fuseCount + 1)
    const fuseFiredTurnId = row?.fuseFiredTurnId ?? ''
    // The audit of the call is written first: a call that was written always moves the counter, and a call that was
    // already recorded changes nothing at all.
    const inserted = this.insertCall(context)
    if (!inserted) {
      return { windowCount: row?.windowCount ?? 0, windowStartedAt: row?.windowStartedAt ?? context.at, groups: [],
        counted: false, escalationReady: false, fuseReady: false, inserted: false }
    }
    // The effective denial this call belongs to: the same turn, the same tool and the same reason are one wall. Its row
    // carries the moment of its most recent call, so a wall that is still being hit stays inside the sliding window.
    const group = effectiveGroupKey(context.turnId, context.toolName, context.reasonCode)
    const known = this.effectiveOf(context.scopeKey, group)
    const counted = known === undefined || !this.withinWindow(known.at, edge)
    this.touchEffective(context, group, at)
    // The window holds every effective denial that is still inside it.
    const window = this.windowOf(context.scopeKey, edge)
    const windowCount = window.count
    const windowStartedAt = window.startedAt === '' ? context.at : window.startedAt
    // The cooldown belongs to the scope, not to the window: it survives the window's rollover, so a scope that just made
    // a review stays quiet while its window slides.
    const cooldownUntil = row?.cooldownUntil ?? ''
    const cooling = cooldownUntil !== '' && Number.isFinite(Date.parse(cooldownUntil)) && at < Date.parse(cooldownUntil)
    this.store.db.prepare(
      'INSERT INTO permission_denial_counters (scope_key, control_session_id, role, project_id, ticket_id, assignment_id, '
      + 'assignment_epoch, manager_target, node_id, backend_id, window_started_at, window_count, last_denial_at, '
      + 'cooldown_until, notice_id, fuse_turn_id, fuse_count, fuse_fired_turn_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) '
      + 'ON CONFLICT(scope_key) DO UPDATE SET window_started_at = excluded.window_started_at, '
      + 'window_count = excluded.window_count, last_denial_at = excluded.last_denial_at, '
      + 'notice_id = excluded.notice_id, '
      + 'fuse_turn_id = excluded.fuse_turn_id, fuse_count = excluded.fuse_count')
      .run(context.scopeKey, context.controlSessionId, context.role, context.projectId, context.ticketId,
        context.assignmentId, context.assignmentEpoch, context.managerTarget, context.nodeId, context.backendId,
        windowStartedAt, windowCount, context.at, cooldownUntil, row?.noticeId ?? '', fuseTurnId, fuseCount,
        fuseFiredTurnId)
    // The claim of the fuse is a conditional write: only the caller whose write changed the row may end the turn, so two
    // refusals that arrive together end one turn and not two.
    const fuseReady = context.turnId !== '' && fuseCount >= this.fuseLimit && fuseFiredTurnId !== context.turnId
    return { windowCount, windowStartedAt, groups: window.groups, counted,
      escalationReady: windowCount >= this.threshold && !cooling, fuseReady, inserted: true }
  }

  /**
   * Whether a moment is inside the sliding window.
   *
   * The edge is inclusive: a refusal that is exactly `windowMs` old is still inside the window, and one that is a
   * millisecond older is out of it.
   */
  private withinWindow(at: string, edge: string): boolean {
    if (edge === '') return true
    const moment = Date.parse(at)
    const bound = Date.parse(edge)
    return Number.isFinite(moment) && Number.isFinite(bound) && moment >= bound
  }

  /**
   * The effective denials of one scope that are still inside the window, and the moment the window opened.
   *
   * The walls are named by their own identity and sorted, so the set is a stable name of the walls the window holds: a
   * wall that is refused again moves its own moment but not its place in the set, and the review of that set keeps its
   * name.
   *
   * The rows are ordered by their own moment, so the first row is the oldest wall of the window whatever order the
   * database happens to return them in: the moment the window opened is read from that row, and a row order that is left
   * to the engine would make the window's own start a guess.
   */
  private windowOf(scopeKey: string, edge: string): { count: number; startedAt: string; groups: string[] } {
    const rows = this.store.db.prepare(
      'SELECT group_key, at FROM permission_denial_effective WHERE scope_key = ? AND at >= ? ORDER BY at, group_key')
      .all(scopeKey, edge === '' ? '' : edge) as Record<string, unknown>[]
    const groups = rows.map(row => String(row.group_key ?? '')).sort()
    const oldest = rows[0]?.at
    return {
      count: groups.length,
      startedAt: oldest === null || oldest === undefined ? '' : String(oldest),
      groups,
    }
  }

  /** The effective denial of one group, when the scope already holds it. */
  private effectiveOf(scopeKey: string, group: string): { at: string } | undefined {
    const row = this.store.db.prepare(
      'SELECT at FROM permission_denial_effective WHERE scope_key = ? AND group_key = ?').get(scopeKey, group)
    if (row === undefined) return undefined
    const at = (row as Record<string, unknown>).at
    return { at: at === null || at === undefined ? '' : String(at) }
  }

  /**
   * Move an effective denial to the moment of its most recent call.
   *
   * The row is the group's own record: a wall that is hit again stays inside the sliding window, and a wall that is not
   * hit again slides out of it on its own.
   */
  private touchEffective(context: DenialContext, group: string, at: number): void {
    const moment = Number.isFinite(at) ? at : Date.parse(context.at)
    this.store.db.prepare(
      'INSERT INTO permission_denial_effective (scope_key, group_key, turn_id, tool_name, reason_code, at) '
      + 'VALUES (?,?,?,?,?,?) ON CONFLICT(scope_key, group_key) DO UPDATE SET at = excluded.at')
      .run(context.scopeKey, group, context.turnId, context.toolName, context.reasonCode,
        new Date(moment).toISOString())
  }

  /** Whether the very same call was recorded before. */
  private callExists(callId: string): boolean {
    const row = this.store.db.prepare('SELECT call_id FROM permission_denial_calls WHERE call_id = ?').get(callId)
    return row !== undefined
  }

  /**
   * Write the audit of one refused call.
   *
   * The summary is built from the facts alone: the reason code, the tool and the turn. Nothing the refused call said is
   * kept, so an argument, a path or an error can never reach the audit trail.
   *
   * The write is conditional: a call that is already recorded is not written again, so two callers that race on the very
   * same call produce one audit and one count.
   */
  private insertCall(context: DenialContext): boolean {
    const summary = `${context.reasonCode} · ${context.toolName} · turn ${context.turnId === '' ? 'unknown' : context.turnId}`
    const result = this.store.db.prepare(
      'INSERT OR IGNORE INTO permission_denial_calls (call_id, scope_key, source, control_session_id, role, project_id, '
      + 'ticket_id, assignment_id, assignment_epoch, turn_id, tool_name, reason_code, node_id, backend_id, at, summary) '
      + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(context.callId, context.scopeKey, context.source, context.controlSessionId, context.role, context.projectId,
        context.ticketId, context.assignmentId, context.assignmentEpoch, context.turnId, context.toolName,
        context.reasonCode, context.nodeId, context.backendId, context.at, summary.slice(0, SUMMARY_LIMIT))
    return Number(result.changes ?? 0) === 1
  }

  /**
   * Claim the review of one window.
   *
   * The claim is a write of the review itself: the review's id is derived from the scope and from the walls the window
   * holds, so a second attempt — from another caller, from a later call that hits the same walls or from a restart —
   * reaches the same row and changes nothing. The review is therefore made once for one set of walls, and the escalation
   * never becomes a storm. A new set of walls is a new review, and the cooldown says how long the scope stays quiet.
   */
  private claimReview(context: DenialContext, counter: { windowCount: number; windowStartedAt: string; groups: string[] }):
    ReviewRow | undefined {
    const row = this.counterOf(context.scopeKey)
    const windowStartedAt = counter.windowStartedAt
    const noticeId = noticeIdOf(context.scopeKey, counter.groups)
    const target = this.targetOf(context)
    const review: ReviewRow = {
      noticeId,
      kind: target.kind === 'operator' ? 'operator_denial_alert' : 'system_denial_review',
      scopeKey: context.scopeKey,
      at: context.at,
      status: target.kind === 'operator' ? 'notified' : 'pending_manager_online',
      controlSessionId: context.controlSessionId,
      role: context.role,
      projectId: context.projectId,
      ticketId: context.ticketId,
      assignmentId: context.assignmentId,
      assignmentEpoch: context.assignmentEpoch,
      turnId: context.turnId,
      toolName: context.toolName,
      reasonCode: context.reasonCode,
      denialCount: counter.windowCount,
      targetSessionId: target.sessionId,
      targetRole: target.role,
      nodeId: context.nodeId,
      backendId: context.backendId,
      payload: this.payloadOf(context, counter.windowCount, target, noticeId),
      reason: '',
      windowStartedAt,
      managerTarget: context.managerTarget,
    }
    const written = this.store.db.prepare(
      'INSERT OR IGNORE INTO permission_denial_reviews (notice_id, kind, scope_key, at, status, control_session_id, role, '
      + 'project_id, ticket_id, assignment_id, assignment_epoch, turn_id, tool_name, reason_code, denial_count, '
      + 'target_session_id, target_role, node_id, backend_id, payload, reason, window_started_at) '
      + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(review.noticeId, review.kind, review.scopeKey, review.at, review.status, review.controlSessionId,
        review.role, review.projectId, review.ticketId, review.assignmentId, review.assignmentEpoch, review.turnId,
        review.toolName, review.reasonCode, review.denialCount, review.targetSessionId, review.targetRole,
        review.nodeId, review.backendId, review.payload, review.reason, review.windowStartedAt)
    // The review of these walls already exists: one set of walls makes one review, whoever asks.
    if (Number(written.changes ?? 0) !== 1) return undefined
    // The cooldown is the control plane's own clock plus its own length. A clock that cannot be read leaves the scope
    // without a cooldown rather than throwing: a broken clock must not roll the refusal back with it.
    const at = Date.parse(context.at)
    const cooldownUntil = Number.isFinite(at) ? new Date(at + this.cooldownMs).toISOString() : ''
    this.store.db.prepare(
      'UPDATE permission_denial_counters SET notice_id = ?, cooldown_until = ? WHERE scope_key = ?')
      .run(noticeId, cooldownUntil, context.scopeKey)
    // The operator alert is the record itself: there is no Session to wake above the Router, so it is settled at once and
    // its audit line is written here — exactly once, because only the caller whose write made this row audits it.
    if (review.kind === 'operator_denial_alert') this.auditReview(review)
    return review
  }

  /**
   * The Session one review goes to, or the operator at the top of the ladder.
   *
   * The target is read from the control plane's own records: a Project's PM is the one the Project names, and the
   * Router is the one Session that belongs to no Project. A Project that is not active has no PM to wake, and the review
   * waits for it rather than going somewhere else.
   */
  private targetOf(context: DenialContext): { kind: DenialTarget; sessionId: string; role: string } {
    if (context.managerTarget === 'operator') return { kind: 'operator', sessionId: '', role: 'operator' }
    if (context.managerTarget === 'router') {
      const router = this.host.session(this.host.routerSessionId())
      return { kind: 'session', sessionId: this.host.routerSessionId(), role: router?.role ?? 'router' }
    }
    const projectId = context.managerTarget.slice(3)
    const project = this.host.project(projectId)
    if (project === undefined) return { kind: 'session', sessionId: '', role: 'pm' }
    const manager = this.host.session(project.pmSessionId)
    if (manager === undefined) return { kind: 'session', sessionId: '', role: 'pm' }
    return { kind: 'session', sessionId: manager.sessionId, role: manager.role }
  }

  /**
   * The bounded projection of the governed work one denial happened in.
   *
   * It is built from the control plane's own records: the Ticket the Assignment belongs to, that Assignment, the Project
   * and the Ticket's own reviews. Only controlled fields are read — a phase, a report kind, a review state — so no title,
   * no goal, no path and no sentence of a person or a model ever reaches the message or the console.
   *
   * Nothing of another scope is read: the Ticket is the one the Assignment belongs to, the Project is the one the Session
   * belongs to, and the report and the review are that Ticket's own. The projection is labelled honestly: a scope that has
   * no Ticket of its own says so instead of borrowing another one's.
   */
  private projectionOf(scope: { projectId: string; ticketId: string; assignmentId: string }): string {
    const parts: string[] = []
    const ticket = scope.assignmentId === '' ? undefined : this.host.ticketOfAssignment(scope.assignmentId)
    const own = ticket !== undefined && ticket.id === scope.ticketId ? ticket : undefined
    if (own === undefined) {
      parts.push('no Ticket of its own')
    } else {
      parts.push(`Ticket phase ${ticketPhaseOf(own)}`)
      const assignment = own.assignments.find(item => item.id === scope.assignmentId)
      if (assignment !== undefined) parts.push(`Assignment phase ${assignment.state}`)
      const report = own.assignments.at(-1)?.report?.state
      parts.push(`latest own report ${report ?? 'none'}`)
      const review = own.reviews?.at(-1)?.state
      parts.push(`review state ${review ?? 'none'}`)
    }
    const project = scope.projectId === '' ? undefined : this.host.project(scope.projectId)
    if (project !== undefined) parts.push(`Project phase ${project.status}`)
    return redact(parts.join(', ')).slice(0, PROJECTION_LIMIT)
  }

  /**
   * The message one review carries.
   *
   * It is the control plane's own wording about a refusal: the facts of the refusal, the scope it happened in and what
   * the superior may do about it. It never carries the arguments of the refused call, a path, an error or a credential,
   * and it never carries the identity of another Project's work.
   *
   * The message names the review's own id, because the superior may only name an id that the message itself gave it: the
   * transport's idempotency key is a field of the wire and never reaches the model, so a message that told the superior to
   * use "this review's id" without naming it would name nothing. The id is the one the control plane generated and
   * persisted, and it is a bounded name of a fixed length.
   *
   * Every line is a controlled field of a fixed bound: a role, a reason code, a tool name of at most sixty-four
   * characters, a turn, three ids and the bounded projection of the governed work. The payload therefore stays bounded,
   * and the arguments of the refused call never reach it.
   */
  private payloadOf(context: DenialContext, count: number, target: { kind: DenialTarget; sessionId: string },
    noticeId: string): string {
    const lines = [
      'System permission denial review.',
      '',
      `Review id: ${noticeId}.`,
      `Session: ${context.controlSessionId} (role ${context.role}).`,
      `Reason code: ${context.reasonCode}. Tool: ${context.toolName}.`,
      `Effective denials in the window: ${count}.`,
      `Turn: ${context.turnId === '' ? 'unknown' : context.turnId}.`,
      `Scope: Project ${context.projectId === '' ? 'none' : context.projectId}, `
        + `Ticket ${context.ticketId === '' ? 'none' : context.ticketId}, `
        + `Assignment ${context.assignmentId === '' ? 'none' : context.assignmentId}.`,
      `Task context (this scope's own work only): ${this.projectionOf(context)}.`,
      '',
      'The refused calls are still refused. Nothing was granted: the role\'s tool list, the Project, the delegation and '
        + 'the workspace are unchanged, and the refused call was not repeated.',
      'You may change the plan within the permissions you already have, or raise an explicit human authorization '
        + 'application with control_request_authorization and the review id above; it puts the review in front of an '
        + 'operator and it grants nothing. You may not grant the access yourself and you may not replay the refused call.',
    ]
    if (target.kind === 'operator') {
      lines.push('The Router has no superior but the operator, so this review is a record the console shows.')
    }
    return lines.join('\n')
  }

  /**
   * Carry out one review.
   *
   * The review is claimed for the wire before anything goes out: a crash after the claim leaves a review whose outcome is
   * unknown, and such a review is never sent again on a guess. A review that could not be sent at all — the superior is
   * stopped, its Project is paused, the node is offline — stays pending and waits for the evidence that it can be
   * reached.
   */
  private async carryOut(review: ReviewRow): Promise<void> {
    // The operator alert is settled when it is claimed: it is a record the console shows, not a message to a Session.
    if (review.kind === 'operator_denial_alert') return
    if (review.targetSessionId === '') {
      this.settleReview(review.noticeId, 'pending_manager_online', 'pending_manager_online', REASONS.superiorGone)
      return
    }
    // The source and the target are read again: the Session that was refused and the superior it belongs to must still
    // be the ones the review was made for.
    const source = this.validateSource(review)
    if (!source.ok) {
      this.settleReview(review.noticeId, 'pending_manager_online', 'pending_manager_online', source.reason)
      return
    }
    const target = this.validateTarget(review)
    if (!target.ok) {
      this.settleReview(review.noticeId, 'pending_manager_online', 'pending_manager_online', target.reason)
      return
    }
    const resolution = await this.host.resolveTarget(review.targetSessionId, 'message')
    if (!resolution.ok) {
      const refusal = refusalOutcome(resolution.code)
      this.settleReview(review.noticeId, 'pending_manager_online', refusal.status, refusal.reason)
      return
    }
    if (resolution.handle.role !== review.targetRole) {
      this.settleReview(review.noticeId, 'pending_manager_online', 'pending_manager_online', REASONS.targetNotTheManager)
      return
    }
    // The claim and the record of the review are one write: a control plane that stopped between them would leave a
    // review that is on its way and a delivery that does not exist, and the review would never be delivered again.
    const delivery = this.store.atomic(() => {
      // The claim: from here on the review is on its way. Only the caller whose write changed the row may send it, so a
      // retry and a recovery never both deliver it.
      if (!this.claimForWire(review.noticeId)) return undefined
      // The review is written down before it goes out: the outbox holds the record of what happened to it, so a restart
      // knows whether the review was ever delivered and may ask the node about it.
      return this.outbox.accept({
        kind: 'denial_review',
        idempotencyKey: review.noticeId,
        dedupKey: `denial_review:${review.noticeId}`,
        scope: `denial:${review.scopeKey}`,
        projectId: review.projectId,
        ticketId: review.ticketId,
        assignmentId: review.assignmentId,
        sourceSessionId: review.controlSessionId,
        targetSessionId: review.targetSessionId,
        targetRole: review.targetRole as SessionRole,
        nodeId: review.nodeId,
        backendId: review.backendId,
        expectedAssignmentEpoch: this.host.targetEpochs(review.targetSessionId).assignmentEpoch,
        expectedToolTokenVersion: this.host.targetEpochs(review.targetSessionId).toolTokenVersion,
        expectedNodeTrustEpoch: 0,
        payload: review.payload,
        context: { kind: 'denial_review', noticeId: review.noticeId, scopeKey: review.scopeKey },
      })
    })
    if (delivery === undefined) return
    if (!this.outbox.claim(delivery.deliveryId, ['accepted_pending'])) return
    try {
      await this.host.deliver(review.targetSessionId, review.payload, review.noticeId, () => {
        this.assertSendable(review)
      }, 'denial_review')
    } catch (error) {
      // A missing receipt is not a refusal: the message may have arrived, so it is neither a failure nor to be repeated.
      if (error instanceof NodeUnconfirmedError) {
        this.outbox.settle(delivery.deliveryId, 'dispatching', 'unconfirmed', REASONS.deliveryUnconfirmed)
        this.settleReview(review.noticeId, 'dispatching', 'unconfirmed', REASONS.deliveryUnconfirmed)
        return
      }
      // A review that was stopped before the wire never went out: it waits for the evidence that it may go out again.
      if (error instanceof DenialReviewStaleError) {
        this.outbox.settle(delivery.deliveryId, 'dispatching', 'blocked_target_inactive', error.reason)
        this.settleReview(review.noticeId, 'dispatching', 'pending_manager_online', error.reason)
        return
      }
      this.outbox.settle(delivery.deliveryId, 'dispatching', 'failed_permanent', REASONS.deliveryFailed)
      this.settleReview(review.noticeId, 'dispatching', 'pending_manager_online', REASONS.deliveryFailed)
      return
    }
    this.outbox.settle(delivery.deliveryId, 'dispatching', 'delivered_inbox', '')
    // The review reached its superior: the settle is conditional, so only one of two callers writes the audit line.
    if (this.settleReview(review.noticeId, 'dispatching', 'notified', '')) this.auditReview(review)
  }

  /**
   * Whether the review of one delivery may still go out.
   *
   * The Session that was refused must still live the life it lived when it was refused, and the superior must still be
   * the manager of that work. A review that was already notified is not on its way any more, and a review that waits for
   * a superior is not sent on a guess.
   */
  revalidateReview(row: CoordinationDeliveryRow): DeliveryRevalidation {
    const context = readContext(row.context)
    if (context === undefined || context.kind !== 'denial_review') {
      return { ok: false, outcome: 'closed', status: 'rejected_stale_or_revoked', reason: 'this delivery names no review' }
    }
    const review = this.reviewById(context.noticeId)
    if (review === undefined) {
      return { ok: false, outcome: 'closed', status: 'rejected_stale_or_revoked', reason: 'the review this delivery was about is gone' }
    }
    if (review.status === 'notified') {
      return { ok: false, outcome: 'closed', status: 'rejected_stale_or_revoked', reason: 'the review this delivery was about was notified' }
    }
    const source = this.validateSource(review)
    if (!source.ok) return { ok: false, outcome: 'closed', status: 'blocked_target_inactive', reason: source.reason }
    const target = this.validateTarget(review)
    if (!target.ok) return { ok: false, outcome: 'closed', status: 'blocked_target_inactive', reason: target.reason }
    // The lifecycle the review was planned under must still hold: a superior that was replaced is not this one.
    if (this.host.targetEpochs(review.targetSessionId).assignmentEpoch !== row.expectedAssignmentEpoch) {
      return { ok: false, outcome: 'closed', status: 'rejected_stale_or_revoked',
        reason: 'the superior was replaced before the review went out' }
    }
    return { ok: true }
  }

  /**
   * The message of a review that is sent again.
   *
   * It is the review's own message: the bounded, redacted facts of the refusal that caused it. A review whose record is
   * gone has no message, and it is not sent with another one.
   */
  reviewPayload(row: CoordinationDeliveryRow): string | undefined {
    const context = readContext(row.context)
    if (context === undefined || context.kind !== 'denial_review') return undefined
    const review = this.reviewById(context.noticeId)
    if (review === undefined) return undefined
    return review.payload === '' ? undefined : review.payload
  }

  /**
   * Whether the Session that was refused is still the one whose refusal this review is about.
   *
   * The Session's own record is the authority: it must still exist, must not be revoked, must not have been stopped by
   * an operator, must still run the Assignment the refusal happened in, and must still live the life the refusal was
   * made in. A Worker whose Assignment was replaced is a different life, and a PM that is not the PM of its Project any
   * more has no business being woken for it.
   */
  private validateSource(review: ReviewRow): { ok: true } | { ok: false; reason: string } {
    const record = this.host.session(review.controlSessionId)
    if (record === undefined) return { ok: false, reason: REASONS.sourceGone }
    if (record.revokedAt !== undefined) return { ok: false, reason: REASONS.sourceRevoked }
    if (record.operatorStop !== undefined) return { ok: false, reason: REASONS.sourceStopped }
    if (record.role !== review.role) return { ok: false, reason: REASONS.sourceMoved }
    // The scope of the Session is read the same way the refusal read it: a Worker's is its Ticket's Project, a PM's is
    // its own Project and the Router's is none at all.
    const scope = record.role === 'worker'
      ? (this.host.ticketOfAssignment(record.assignmentId ?? '')?.projectId ?? '')
      : record.role === 'router' ? '' : record.projectId
    if (scope !== review.projectId) return { ok: false, reason: REASONS.sourceMoved }
    if ((record.assignmentId ?? '') !== review.assignmentId) return { ok: false, reason: REASONS.sourceMoved }
    if (review.assignmentId !== '') {
      const ticket = this.host.ticketOfAssignment(review.assignmentId)
      if (ticket === undefined) return { ok: false, reason: REASONS.sourceMoved }
      const current = ticket.assignments.at(-1)
      if (current === undefined || current.id !== review.assignmentId) return { ok: false, reason: REASONS.sourceMoved }
      if (ticket.projectId !== undefined && ticket.projectId !== review.projectId) {
        return { ok: false, reason: REASONS.sourceMoved }
      }
    }
    if (this.host.targetEpochs(review.controlSessionId).assignmentEpoch !== review.assignmentEpoch) {
      return { ok: false, reason: REASONS.sourceMoved }
    }
    if (record.role === 'pm') {
      const project = this.host.project(record.projectId)
      if (project === undefined) return { ok: false, reason: REASONS.sourceGone }
      if (project.pmSessionId !== record.sessionId) return { ok: false, reason: REASONS.sourceMoved }
    }
    if (record.role === 'router' && record.sessionId !== this.host.routerSessionId()) {
      return { ok: false, reason: REASONS.sourceMoved }
    }
    return { ok: true }
  }

  /**
   * Whether the Session a review names may still be woken for it.
   *
   * The routing is by business ownership, and it is checked again here: a Project Worker's review belongs to the PM of
   * its own Project and to nobody else, and a PM's or a standalone Worker's review belongs to the Router. A Project that
   * has another manager now, or a Router that is not the Router, is not woken for a review that is not its own.
   */
  private validateTarget(review: ReviewRow): { ok: true } | { ok: false; reason: string } {
    const target = this.host.session(review.targetSessionId)
    if (target === undefined) return { ok: false, reason: REASONS.superiorGone }
    if (review.managerTarget === 'router') {
      if (review.targetSessionId !== this.host.routerSessionId()) {
        return { ok: false, reason: REASONS.targetNotTheManager }
      }
      if (target.role !== 'router') return { ok: false, reason: REASONS.targetNotTheManager }
      return { ok: true }
    }
    if (!review.managerTarget.startsWith('pm:')) return { ok: false, reason: REASONS.targetNotTheManager }
    const projectId = review.managerTarget.slice(3)
    if (review.projectId !== projectId) return { ok: false, reason: REASONS.targetNotTheManager }
    const project = this.host.project(projectId)
    if (project === undefined) return { ok: false, reason: REASONS.superiorGone }
    if (project.pmSessionId !== review.targetSessionId) return { ok: false, reason: REASONS.targetMoved }
    if (target.role !== 'pm' || target.projectId !== projectId) {
      return { ok: false, reason: REASONS.targetNotTheManager }
    }
    return { ok: true }
  }

  /**
   * The last check before the review goes on the wire.
   *
   * Everything the review was planned under is read again at the moment the transport is about to happen: the Session
   * that was refused still lives the life it lived when it was refused, and the superior is still there, still bound to
   * this node and backend, still allowed to be messaged, and still the manager of the work in question. The check is
   * synchronous on purpose — a check before another await would leave the same gap open.
   */
  private assertSendable(review: ReviewRow): void {
    const source = this.validateSource(review)
    if (!source.ok) throw new DenialReviewStaleError(source.reason)
    const target = this.validateTarget(review)
    if (!target.ok) throw new DenialReviewStaleError(target.reason)
    const resolved = this.host.resolveTargetNow(review.targetSessionId, 'message')
    if (!resolved.ok) throw new DenialReviewStaleError(REASONS.superiorUnreachable)
    if (resolved.handle.role !== review.targetRole) throw new DenialReviewStaleError(REASONS.targetNotTheManager)
  }

  /**
   * Claim one review for the wire.
   *
   * The claim is a conditional write: only the caller whose write changed the row may send the message, so two callers —
   * a retry and a recovery, or two recoveries — never both deliver it. A review that was claimed and never settled is a
   * review whose outcome is unknown, and the recovery marks it as such instead of sending it again.
   */
  private claimForWire(noticeId: string): boolean {
    const result = this.store.db.prepare(
      "UPDATE permission_denial_reviews SET status = 'dispatching' WHERE notice_id = ? AND status = 'pending_manager_online'")
      .run(noticeId)
    return Number(result.changes ?? 0) === 1
  }

  /**
   * End the turn that produced the refusals.
   *
   * The turn is the one the refusals name, and it is interrupted, never stopped: the Session keeps its identity, its
   * authority and its inbox, and the messages that wait for the next turn stay in it. The turn has to be the one that
   * runs right now — a turn that ended in the meantime is not interrupted in its place.
   *
   * The claim is a conditional write: only the caller whose write changed the row may interrupt, so five refusals that
   * arrive together end one turn and not five.
   */
  private async interruptFusedTurn(context: DenialContext): Promise<boolean> {
    // The turn has to be the one that runs right now: a turn that ended in the meantime is not interrupted in its place,
    // and the claim is not spent either — a later refusal of the same turn may still end it.
    const known = this.host.currentTurn(context.controlSessionId)
    if (known === undefined || String(known) !== context.turnId) return false
    const claimed = this.store.db.prepare(
      'UPDATE permission_denial_counters SET fuse_fired_turn_id = ?, last_denial_at = ? WHERE scope_key = ? '
      + 'AND fuse_turn_id = ? AND fuse_count >= ? AND fuse_fired_turn_id <> ?')
      .run(context.turnId, context.at, context.scopeKey, context.turnId, this.fuseLimit, context.turnId)
    if (Number(claimed.changes ?? 0) !== 1) return false
    const outcome = await this.host.interruptTurn(context.controlSessionId,
      'The permission guard refused repeated calls in this turn', known)
    this.host.audit({ actor: 'system', kind: 'denial', action: 'fused', targetKind: 'session',
      targetId: context.controlSessionId, outcome: outcome.interrupted ? 'ok' : 'failed',
      detail: `turn ${context.turnId} · ${context.reasonCode}` })
    return outcome.interrupted
  }

  /**
   * The reviews a previous run of this control plane left open.
   *
   * A review that was on its way when the control plane stopped has an unknown outcome, and the outbox is the one that
   * learned it: it asked the node what it can prove about that exact key. This method reads that answer: a review the node
   * can show was notified, and a review whose outcome stays unknown is never sent again, because a blind resend would
   * repeat a review that may have landed.
   *
   * A review that waits for a superior is carried out again only when there is evidence that the superior can be reached
   * now — it was resumed, or the node came back. A review that was notified or whose outcome is unknown is left alone.
   */
  async recover(): Promise<void> {
    const dispatching = this.store.db.prepare(
      "SELECT notice_id FROM permission_denial_reviews WHERE status = 'dispatching'").all() as Record<string, unknown>[]
    for (const row of dispatching) {
      const noticeId = String(row.notice_id ?? '')
      const delivery = this.outbox.byIdempotencyKey(noticeId)
      const arrived = delivery?.status === 'delivered_inbox' || delivery?.status === 'consumed_turn'
      if (arrived) {
        this.settleReview(noticeId, 'dispatching', 'notified', '')
        continue
      }
      this.settleReview(noticeId, 'dispatching', 'unconfirmed', REASONS.dispatchUnknown)
    }
    await this.revisit()
  }

  /**
   * Carry out the reviews that wait for a superior, when there is evidence that it can be reached.
   *
   * A review that waits is not sent on a guess: it is sent when the superior can be resolved for a message right now.
   * That covers the two ways a waiting review comes back — a person resumed the manager, or the node it lives on came
   * back — without a timer that would try again forever.
   */
  async revisit(sessionId?: string): Promise<void> {
    // A revisit that was asked for while one was running is not dropped: it runs again as soon as the first one is done,
    // and it runs without a filter, so it covers everything the first one may have skipped.
    if (this.revisiting) {
      this.revisitQueued = true
      return
    }
    this.revisiting = true
    try {
      let filter = sessionId
      do {
        this.revisitQueued = false
        await this.carryOutPending(filter)
        filter = undefined
      } while (this.revisitQueued)
    } finally {
      this.revisiting = false
    }
  }

  /** Carry out every waiting review whose superior may be reached right now. */
  private async carryOutPending(sessionId?: string): Promise<void> {
    const rows = this.store.db.prepare(
      "SELECT * FROM permission_denial_reviews WHERE status = 'pending_manager_online' ORDER BY at").all() as
      Record<string, unknown>[]
    for (const raw of rows) {
      const review = this.reviewOf(raw)
      if (review.kind !== 'system_denial_review') continue
      if (review.targetSessionId === '') continue
      if (sessionId !== undefined && review.targetSessionId !== sessionId) continue
      // The evidence: the superior may be reached for a message right now.
      const resolved = this.host.resolveTargetNow(review.targetSessionId, 'message')
      if (!resolved.ok) continue
      await this.carryOut(review)
    }
  }

  /** The reviews the escalator holds, newest last. */
  reviews(limit = 50): ReviewRow[] {
    const rows = this.store.db.prepare('SELECT * FROM permission_denial_reviews ORDER BY at DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 500))) as Record<string, unknown>[]
    return rows.map(raw => this.reviewOf(raw))
  }

  /** The counters the escalator holds, newest first. */
  counters(limit = 50): CounterRow[] {
    const rows = this.store.db.prepare('SELECT * FROM permission_denial_counters ORDER BY last_denial_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 500))) as Record<string, unknown>[]
    return rows.map(raw => this.counterOfRow(raw))
  }

  /** The reviews as the console reads them. */
  views(limit = 50): DenialReviewView[] {
    return this.reviews(limit).map(review => ({
      noticeId: review.noticeId,
      kind: review.kind,
      at: review.at,
      status: review.status,
      controlSessionId: review.controlSessionId,
      role: review.role,
      projectId: review.projectId,
      ticketId: review.ticketId,
      assignmentId: review.assignmentId,
      turnId: review.turnId,
      toolName: review.toolName,
      reasonCode: review.reasonCode,
      denialCount: review.denialCount,
      targetSessionId: review.targetSessionId,
      targetRole: review.targetRole,
      nodeId: review.nodeId,
      backendId: review.backendId,
      reason: review.reason,
      taskContext: this.projectionOf(review),
    }))
  }

  /** The counters as the console reads them. */
  counterViews(limit = 50): DenialCounterView[] {
    return this.counters(limit).map(row => ({
      scopeKey: row.scopeKey,
      controlSessionId: row.controlSessionId,
      role: row.role,
      projectId: row.projectId,
      ticketId: row.ticketId,
      assignmentId: row.assignmentId,
      managerTarget: row.managerTarget,
      nodeId: row.nodeId,
      backendId: row.backendId,
      windowStartedAt: row.windowStartedAt,
      windowCount: row.windowCount,
      lastDenialAt: row.lastDenialAt,
      cooldownUntil: row.cooldownUntil,
      noticeId: row.noticeId,
    }))
  }

  /**
   * Raise one explicit human authorization application about a denial review.
   *
   * The application is a request, never a grant: it puts the review in front of an operator and changes nothing at all.
   *
   * The caller has to be the exact immediate manager of the review — the Session the review was made for — and the edge
   * it governs has to be alive: the refused Session must still live the life the refusal happened in, and the manager
   * must still be the manager of that work. A Worker, another PM, a revoked or stopped Session, a review id that names
   * no review and a review that a newer one replaced are all refused.
   *
   * One review has one application: a repeated request reads the application that is already there back, so a retry
   * after a token refresh is clean.
   */
  requestAuthorization(sessionId: string, reviewId: string): DenialAuthorizationView {
    const applicant = this.host.session(sessionId)
    if (applicant === undefined) {
      throw new DenialAuthorizationError('the Session that raised the application does not exist')
    }
    if (applicant.revokedAt !== undefined) {
      throw new DenialAuthorizationError('the Session that raised the application was revoked')
    }
    if (applicant.operatorStop !== undefined) {
      throw new DenialAuthorizationError('the Session that raised the application was stopped by an operator')
    }
    if (applicant.role !== 'pm' && applicant.role !== 'router') {
      throw new DenialAuthorizationError('only a PM or the Router may raise an authorization application')
    }
    const role = applicant.role
    const review = this.reviewById(reviewId)
    if (review === undefined) throw new DenialAuthorizationError('no denial review has that id')
    if (review.targetSessionId !== sessionId || review.targetRole !== role) {
      throw new DenialAuthorizationError('this review is not this Session\'s to apply for')
    }
    // The review must be the current one of its scope: a review that a newer one replaced is not the one the console shows.
    if (this.currentReviewIdOf(review.scopeKey) !== review.noticeId) {
      throw new DenialAuthorizationError('this review is not the current one of its scope')
    }
    // The governed edge has to be alive: the refused Session must still live the life it lived, and the manager must
    // still be the manager of that work.
    const source = this.validateSource(review)
    if (!source.ok) throw new DenialAuthorizationError(source.reason)
    const target = this.validateTarget(review)
    if (!target.ok) throw new DenialAuthorizationError(target.reason)
    // The application is written once: the row is the record of this review's application, and a request that arrives
    // again reads it back instead of raising a second one.
    const applicationId = `denial-auth-${createHash('sha256').update(review.noticeId).digest('hex').slice(0, 32)}`
    const written = this.store.db.prepare(
      'INSERT OR IGNORE INTO denial_authorization_applications (application_id, review_id, scope_key, applicant_session_id, '
      + 'applicant_role, control_session_id, project_id, ticket_id, assignment_id, reason_code, tool_name, denial_count, '
      + 'requested_at, status, decided_at, decision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(applicationId, review.noticeId, review.scopeKey, sessionId, role, review.controlSessionId,
        review.projectId, review.ticketId, review.assignmentId, review.reasonCode, review.toolName, review.denialCount,
        this.host.now(), 'pending', '', '')
    const application = this.applicationOf(review.noticeId)
    if (application === undefined) throw new DenialAuthorizationError('the application could not be recorded')
    // Only the caller whose write made the row audits it: a retry is the same application, not a second one.
    if (Number(written.changes ?? 0) === 1) {
      this.host.audit({ actor: role, kind: 'denial', action: 'authorization-requested', targetKind: 'session',
        targetId: review.controlSessionId, detail: `${review.reasonCode} · ${review.toolName}` })
    }
    return application
  }

  /**
   * Record the operator's decision on one authorization application.
   *
   * The decision is a record and nothing else: it grants no capability, widens no Mandate, changes no role's tool list
   * and repeats no refused call. Any real change goes through the operator's own path in the console, which this record
   * never touches.
   *
   * The same decision again is the same decision: the record that is already there is returned as it is, and the retry
   * writes no second audit line. A decision is made once, and a retried request — a double click, a replay of the console's
   * own call — must not look like a second decision in the trail.
   */
  decideAuthorization(applicationId: string, decision: 'acknowledged' | 'declined'): DenialAuthorizationView {
    const application = this.applicationById(applicationId)
    if (application === undefined) throw new DenialAuthorizationError('no authorization application has that id')
    // The decision is already this one: the record stands, and nothing is written a second time.
    if (application.status === decision) return application
    this.store.db.prepare(
      'UPDATE denial_authorization_applications SET status = ?, decision = ?, decided_at = ? WHERE application_id = ?')
      .run(decision, decision, this.host.now(), applicationId)
    this.host.audit({ actor: 'operator', kind: 'denial', action: 'authorization-decided', targetKind: 'session',
      targetId: application.controlSessionId, detail: decision })
    const updated = this.applicationById(applicationId)
    if (updated === undefined) throw new DenialAuthorizationError('the decision could not be recorded')
    return updated
  }

  /** The authorization applications the escalator holds, newest first. */
  authorizations(limit = 50): DenialAuthorizationView[] {
    const rows = this.store.db.prepare(
      'SELECT * FROM denial_authorization_applications ORDER BY requested_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 500))) as Record<string, unknown>[]
    return rows.map(raw => this.applicationView(raw))
  }

  /** The review of one id, when the escalator holds it. */
  private reviewById(noticeId: string): ReviewRow | undefined {
    const row = this.store.db.prepare('SELECT * FROM permission_denial_reviews WHERE notice_id = ?').get(noticeId)
    return row === undefined ? undefined : this.reviewOf(row as Record<string, unknown>)
  }

  /** The review that is the current one of a scope: a newer review of the same scope replaced it. */
  private currentReviewIdOf(scopeKey: string): string {
    const row = this.store.db.prepare(
      'SELECT notice_id FROM permission_denial_reviews WHERE scope_key = ? ORDER BY at DESC, rowid DESC LIMIT 1')
      .get(scopeKey) as Record<string, unknown> | undefined
    return row === undefined ? '' : String(row.notice_id ?? '')
  }

  /** The application of one review, when there is one. */
  private applicationOf(reviewId: string): DenialAuthorizationView | undefined {
    const row = this.store.db.prepare(
      'SELECT * FROM denial_authorization_applications WHERE review_id = ? ORDER BY rowid LIMIT 1').get(reviewId)
    return row === undefined ? undefined : this.applicationView(row as Record<string, unknown>)
  }

  /** The application of one id, when there is one. */
  private applicationById(applicationId: string): DenialAuthorizationView | undefined {
    const row = this.store.db.prepare(
      'SELECT * FROM denial_authorization_applications WHERE application_id = ?').get(applicationId)
    return row === undefined ? undefined : this.applicationView(row as Record<string, unknown>)
  }

  /** One application row, as the console reads it. */
  private applicationView(row: Record<string, unknown>): DenialAuthorizationView {
    const text = (name: string): string => {
      const value = row[name]
      return value === null || value === undefined ? '' : String(value)
    }
    const number = (name: string): number => {
      const value = row[name]
      return typeof value === 'number' ? value : Number(value ?? 0)
    }
    return {
      applicationId: text('application_id'),
      reviewId: text('review_id'),
      status: text('status'),
      applicantSessionId: text('applicant_session_id'),
      applicantRole: text('applicant_role'),
      controlSessionId: text('control_session_id'),
      projectId: text('project_id'),
      ticketId: text('ticket_id'),
      assignmentId: text('assignment_id'),
      reasonCode: text('reason_code'),
      toolName: text('tool_name'),
      denialCount: number('denial_count'),
      requestedAt: text('requested_at'),
      decidedAt: text('decided_at'),
      decision: text('decision'),
    }
  }

  /** Write one line of the audit trail about a review that reached its superior. */
  private auditReview(review: ReviewRow): void {
    this.host.audit({ actor: 'system', kind: 'denial', action: 'escalated', targetKind: 'session',
      targetId: review.controlSessionId, detail: `${review.reasonCode} · ${review.toolName} · ${review.denialCount} 次` })
  }

  /**
   * Change the state of one review.
   *
   * The write is conditional: only the caller whose write changed the row may say what happened, so a retry that lost
   * the claim never overwrites the outcome of the caller that won it. The reason is one of the control plane's own
   * sentences: an arbitrary error text of the node may hold a path, an argument or a secret, and it never reaches the
   * record.
   */
  private settleReview(noticeId: string, from: DenialReviewStatus, to: DenialReviewStatus, reason: string): boolean {
    try {
      const result = this.store.db.prepare(
        'UPDATE permission_denial_reviews SET status = ?, reason = ? WHERE notice_id = ? AND status = ?')
        .run(to, redact(reason).slice(0, REASON_LIMIT), noticeId, from)
      return Number(result.changes ?? 0) === 1
    } catch {
      // The database is gone: the control plane is closing, and the record it would have written no longer has a home.
      return false
    }
  }

  /** The counter of one scope, when there is one. */
  private counterOf(scopeKey: string): CounterRow | undefined {
    const row = this.store.db.prepare('SELECT * FROM permission_denial_counters WHERE scope_key = ?').get(scopeKey)
    return row === undefined ? undefined : this.counterOfRow(row as Record<string, unknown>)
  }

  /** One counter row, as the escalator reads it. */
  private counterOfRow(row: Record<string, unknown>): CounterRow {
    const text = (name: string): string => {
      const value = row[name]
      return value === null || value === undefined ? '' : String(value)
    }
    const number = (name: string): number => {
      const value = row[name]
      return typeof value === 'number' ? value : Number(value ?? 0)
    }
    return {
      scopeKey: text('scope_key'),
      controlSessionId: text('control_session_id'),
      role: text('role'),
      projectId: text('project_id'),
      ticketId: text('ticket_id'),
      assignmentId: text('assignment_id'),
      assignmentEpoch: number('assignment_epoch'),
      managerTarget: text('manager_target'),
      nodeId: text('node_id'),
      backendId: text('backend_id'),
      windowStartedAt: text('window_started_at'),
      windowCount: number('window_count'),
      lastDenialAt: text('last_denial_at'),
      cooldownUntil: text('cooldown_until'),
      noticeId: text('notice_id'),
      fuseTurnId: text('fuse_turn_id'),
      fuseCount: number('fuse_count'),
      fuseFiredTurnId: text('fuse_fired_turn_id'),
    }
  }

  /** One review row, as the escalator reads it. */
  private reviewOf(row: Record<string, unknown>): ReviewRow {
    const text = (name: string): string => {
      const value = row[name]
      return value === null || value === undefined ? '' : String(value)
    }
    const number = (name: string): number => {
      const value = row[name]
      return typeof value === 'number' ? value : Number(value ?? 0)
    }
    const scope = this.counterOf(text('scope_key'))
    return {
      noticeId: text('notice_id'),
      kind: text('kind') as DenialReviewKind,
      scopeKey: text('scope_key'),
      at: text('at'),
      status: text('status') as DenialReviewStatus,
      controlSessionId: text('control_session_id'),
      role: text('role'),
      projectId: text('project_id'),
      ticketId: text('ticket_id'),
      assignmentId: text('assignment_id'),
      assignmentEpoch: number('assignment_epoch'),
      turnId: text('turn_id'),
      toolName: text('tool_name'),
      reasonCode: text('reason_code'),
      denialCount: number('denial_count'),
      targetSessionId: text('target_session_id'),
      targetRole: text('target_role'),
      nodeId: text('node_id'),
      backendId: text('backend_id'),
      payload: text('payload'),
      reason: text('reason'),
      windowStartedAt: text('window_started_at'),
      managerTarget: scope?.managerTarget ?? '',
    }
  }
}

/** A positive finite number, or the fallback. */
function positive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/** A finite non-negative number, or the fallback. */
function finite(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}
