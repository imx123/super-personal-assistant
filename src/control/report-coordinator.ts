/**
 * The durable coordination of the reports a Worker and a PM make.
 *
 * A report is a business fact of the domain: the Worker wrote it and the Ticket holds it. What the coordination adds is
 * the *delivery* of that fact to the Session that has to act on it — the PM of the Worker's Project, the Router of a
 * standalone Worker, the Router of a PM's Project report — and the durable record of what that delivery really did.
 *
 * The record lives in the control plane's own database, in the table `coordination_deliveries`, and it is written in the
 * same transaction as the report it is about: a report that was written always has its delivery work, and a delivery
 * work that exists always names a report. A crash between the two leaves a record whose report was never written, and
 * the recovery says exactly that instead of delivering a fact that does not exist.
 *
 * The table itself belongs to the shared outbox (`delivery-outbox.ts`), which owns its shape, its migration and the
 * recovery of every kind of coordination. This module owns the routing of a report, its stable key, its throttle and the
 * message the superior reads; it reads its own rows back for the throttle and for the PM's own view of a wake-up.
 *
 * The three generations are kept apart on purpose. The node's trust answers "is this the node I registered", the
 * Assignment's lifecycle answers "is this still the Worker that owns this work", and the credential's version answers
 * "is this token the current one". Only the middle one says that a target was replaced, so a routine refresh of a
 * credential never invalidates a delivery and never proves that a lifecycle changed.
 *
 * The routing is by business ownership, not by convenience: a Worker's report goes to the PM of its own Project, a
 * standalone Worker's report goes to the Router, and a PM reports to the Router only what belongs to its Project as a
 * whole. A report never reaches a Session that has no business reading it.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ProjectProfile, ReportState } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { redact } from '../infra/redact.ts'
import { NodeUnconfirmedError, type SessionRecord, type SessionRole } from '../shared/protocol.ts'
import type { NodeResolutionErrorCode, NodeResolutionResult, ResolvedTarget } from './node-resolver.ts'
import type { PmReportFacts } from './pm-report.ts'
import { DEFAULT_DELIVERY_TTL_MS, CoordinationDeliveryStaleError, type CoordinationDeliveryKind,
  type CoordinationDeliveryRow, type CoordinationDeliveryStatus, type CoordinationDeliveryView, type DeliveryContext,
  type DeliveryOutbox, type DeliveryRevalidation } from './delivery-outbox.ts'

export type { CoordinationDeliveryKind, CoordinationDeliveryRow, CoordinationDeliveryStatus, CoordinationDeliveryView }

/**
 * The kinds of report the coordination knows.
 *
 * `progress` is the ordinary one; every other kind is a state change a superior has to see at once. A PM's report about
 * its own Project as a whole is a `completed`, a `blocked`, a `failed` or an ordinary `progress`.
 */
export type CoordinationReportKind = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped' | 'completed'

/**
 * What a PM's own report about its Project is.
 *
 * A `progress` is the ordinary one and is throttled like any other report; the other three are a state change the
 * Router has to see at once.
 */
export type PmProjectReportKind = 'progress' | 'blocked' | 'completed' | 'failed'

/**
 * The kind of report a PM's own report is, in the coordination's own words.
 *
 * A report that names no kind is an ordinary progress report: it is never a blocker by accident.
 */
export function projectReportKindOf(kind: PmProjectReportKind): CoordinationReportKind {
  if (kind === 'blocked') return 'blocked'
  if (kind === 'completed') return 'completed'
  if (kind === 'failed') return 'failed'
  return 'progress'
}

/**
 * What one report asks the coordination to deliver.
 *
 * The plan is written by the control plane, which owns the business facts; the coordination owns the routing rules, the
 * durable record and the delivery itself.
 */
export interface ReportDeliveryPlan {
  /** What kind of coordination the delivery is; a report is a Worker's or a PM's. */
  kind: 'worker_report' | 'pm_report'
  /** The Project the report belongs to; empty for a standalone Ticket. */
  projectId: string
  /** The Ticket the report is about. */
  ticketId: string
  /** The Assignment the report is about; empty for a PM's Project report. */
  assignmentId: string
  /** The kind of the report. */
  reportKind: CoordinationReportKind
  /** The review round the report waits for, when it waits for one. */
  reviewId: string
  /** The content the dedup key digests. */
  content: string
  /** The question that is open for a person, when one is. */
  question: string
  /** The Session that made the report. */
  sourceSessionId: string
  /** The Session the report is delivered to. */
  targetSessionId: string
  /** What the target Session is for. */
  targetRole: SessionRole
  /** The node the report came from. */
  nodeId: string
  /** The backend the report came from. */
  backendId: string
  /** The message the target reads. */
  message: string
}

/**
 * A delivery that never left the control plane.
 *
 * The target could not be made ready for the message — the node is not there, or the ensure of the Session failed — so
 * the message was never sent. It is a different fact from a node that refused the message, and the record says so.
 */
export class CoordinationTargetUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoordinationTargetUnavailableError'
  }
}

/** What one delivery really did. */
export interface ReportDeliveryOutcome {
  /** The state the caller shows. */
  state: 'sent' | 'skipped' | 'failed' | 'pending'
  /** Why it went that way, when there is something to say. */
  reason?: string
  /** The durable record of the delivery. */
  delivery?: CoordinationDeliveryRow
}

/**
 * How a delivery reads in the PM's own words.
 *
 * It is the state of the wake-up the PM knows: sent, pending, skipped or failed.
 */
export type CoordinationNotificationState = 'pending' | 'sent' | 'skipped' | 'failed'

/**
 * The state a delivery reads in the PM's own words.
 *
 * A delivery that is on its way is still pending; one the node took is sent; one whose target was resting, whose
 * authority was gone or whose place a newer report took is skipped; one the node refused, one whose receipt is missing
 * and one the node could not be reached on are failed.
 */
export function notificationStateOf(status: CoordinationDeliveryStatus): CoordinationNotificationState {
  if (status === 'delivered_inbox' || status === 'consumed_turn') return 'sent'
  if (status === 'accepted_pending' || status === 'dispatching' || status === 'deferred_for_resume') return 'pending'
  if (status === 'blocked_target_inactive' || status === 'rejected_stale_or_revoked' || status === 'superseded') {
    return 'skipped'
  }
  return 'failed'
}

/**
 * The authoritative reads and the one write the coordination needs.
 *
 * It keeps the coordination free of the control plane itself: the module decides *what* is delivered and *when*, and the
 * host says what the node's answer was.
 */
export interface ReportCoordinatorHost {
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
  /** The Session id of the Router, the one Session that belongs to no Project. */
  routerSessionId(): string
  /** Resolve a target Session and the generations it was read under. */
  resolveTarget(sessionId: string, op: 'message'): Promise<NodeResolutionResult<ResolvedTarget>>
  /**
   * Resolve a target Session again, without waiting for the node.
   *
   * The check that runs immediately before the transport may not await anything, so it reads the answer from the control
   * plane's own records at that very moment: whether the target is still alive, still bound to this node and backend,
   * still allowed to be messaged, and whether the node is there at all.
   */
  resolveTargetNow(sessionId: string, op: 'message'): NodeResolutionResult<ResolvedTarget>
  /**
   * Deliver one message to a Session under the node's own idempotency key.
   *
   * The call throws when the message did not go out. A {@link NodeUnconfirmedError} means the request may have been
   * carried out and its receipt is missing; any other error means the node refused it or it never left this control
   * plane.
   *
   * `validateForSend` is the check that runs immediately before the message goes on the wire. It is called synchronously,
   * right after the target was ensured and again right before the transport, and it throws when the delivery may not go
   * out any more. The check belongs to the caller, because only the caller knows the moment the transport is about to
   * happen.
   */
  deliver(sessionId: string, text: string, idempotencyKey: string, validateForSend?: () => void,
    context?: { readonly ticketId: string; readonly assignmentId: string; readonly projectId: string },
    kind?: CoordinationDeliveryKind): Promise<void>
  /** The latest report of an Assignment, read from the domain. */
  reportOf(ticketId: string, assignmentId: string):
    { state: ReportState; summary: string; at: string; projectId: string; assignmentEpoch: number } | undefined
  /** The review round an Assignment's result waits for, when it waits for one. */
  reviewOf(ticketId: string, assignmentId: string): string | undefined
  /**
   * The generations of a target Session, read without waiting for the node.
   *
   * The coordination writes them down when the delivery is enqueued, so a delivery that waits knows which life it was
   * meant for.
   */
  targetEpochs(sessionId: string): { assignmentEpoch: number; toolTokenVersion: number }
  /** The trust generation of the node. */
  nodeTrustEpoch(): number
}

/**
 * What the coordination decided about one report.
 *
 * `deliver` names the delivery to carry out, `deferred` says the report waits for a Project to be resumed, and `skipped`
 * says the report has no superior to go to — or that the superior already knows it.
 */
export interface ReportPlanResult {
  /** What is to happen with the report. */
  readonly state: 'deliver' | 'deferred' | 'skipped'
  /** Why it went that way, when there is something to say. */
  readonly reason?: string
  /** The delivery to carry out; present when the state is `deliver`. */
  readonly delivery?: CoordinationDeliveryRow
}

/** The Session a report is to go to. */
interface ReportTarget {
  readonly sessionId: string
  readonly role: SessionRole
}

/** How the coordination is configured. */
export interface ReportCoordinatorOptions {
  /**
   * The smallest interval between two ordinary progress reports to the same target, in milliseconds.
   *
   * `0` delivers every progress report at once, which is what a deployment that wants to see every turn of a busy
   * Worker asks for. The default holds an ordinary progress report back and merges it with the ones that follow, so a
   * Worker that reports every turn does not wake its superior for every turn. A final report, a blocker, a failure and
   * a dropped work are never held back: they are state changes the superior has to see at once.
   */
  progressIntervalMs?: number
  /**
   * How long the message of a report stays worth delivering, in milliseconds.
   *
   * The message life is its own: it does not follow the authorization of the Session the report is about, and the
   * authorization does not follow it. A report that is still the current one after this time is still a fact; one that
   * ran out is not delivered any more. `0` turns the message life off, and a report then waits for as long as it takes.
   */
  deliveryTtlMs?: number
}

/**
 * The smallest interval between two ordinary progress reports, when nothing else is configured.
 *
 * A minute is long enough that a Worker which reports after every step does not wake its superior for every step, and
 * short enough that a superior learns of a long silence within a minute of it ending.
 */
export const DEFAULT_PROGRESS_INTERVAL_MS = 60_000

/**
 * The digest of one report's own content.
 *
 * It covers the text the Worker wrote, so the recovery can recognise the report a delivery was about by reading the
 * Assignment again.
 */
export function contentDigest(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex')
}

/**
 * The stable key that makes one report one delivery.
 *
 * It names the scope the report belongs to, the exact Assignment it is about, the review round it waits for, the kind of
 * the report and the digest of its content together with the question it left open. A report that repeats the same facts
 * under the same round is the same delivery; the same text in another round, under another Assignment or in another
 * scope is another fact.
 */
export function stableDedupKey(plan: ReportDeliveryPlan): string {
  return JSON.stringify([plan.projectId === '' ? plan.ticketId : plan.projectId, plan.ticketId, plan.assignmentId,
    plan.reviewId, plan.reportKind, contentDigest(plan.content), plan.question.trim()])
}

/**
 * The scope one delivery's throttle counts in.
 *
 * The scope names the target and the owner of the report: a Worker's reports are counted against its own Assignment, a
 * PM's reports against its own Project. Two Workers never share a throttle, and neither do two Projects. The two parts are
 * kept apart by their shape, so no id can make two scopes run into each other.
 */
function throttleScope(targetSessionId: string, assignmentId: string, projectId: string): string {
  return JSON.stringify([targetSessionId, assignmentId === '' ? `project:${projectId}` : assignmentId])
}

/**
 * The owning record of one delivery of a report.
 *
 * It names the Ticket and the Assignment a Worker's report is about, or the Project a PM's report is about. A recovery
 * reads it and knows which record it has to read again; it never has to guess, and it never has to run anything the
 * writer left behind.
 */
function reportContextOf(plan: ReportDeliveryPlan): DeliveryContext {
  if (plan.kind === 'pm_report') {
    return { kind: 'pm_report', projectId: plan.projectId }
  }
  return { kind: 'worker_report', ticketId: plan.ticketId, assignmentId: plan.assignmentId,
    reportKind: plan.reportKind, reviewId: plan.reviewId }
}

/**
 * What a refused resolution leaves the delivery in.
 *
 * A target that is stopped, paused or gone is blocked rather than failed: nothing is wrong with the report, and a later
 * attempt may still go out. A node that is offline blocks the delivery for now as well, and keeps the target it named.
 * A target whose authority or generation is gone is rejected for good.
 */
function refusalOutcome(code: NodeResolutionErrorCode): { status: CoordinationDeliveryStatus; state: 'skipped' | 'failed' } {
  if (code === 'MANUALLY_STOPPED') return { status: 'blocked_target_inactive', state: 'skipped' }
  if (code === 'NODE_OFFLINE' || code === 'BACKEND_UNAVAILABLE') {
    return { status: 'blocked_node_unavailable', state: 'failed' }
  }
  if (code === 'PERMISSION_REVOKED' || code === 'STALE_GENERATION') return { status: 'rejected_stale_or_revoked', state: 'skipped' }
  return { status: 'rejected_stale_or_revoked', state: 'skipped' }
}

/**
 * The coordination of the reports a Worker and a PM make.
 *
 * It owns three things: the durable record of every delivery, the stable key that keeps an identical report from being
 * delivered twice, and the throttle that merges the ordinary progress reports of a busy Worker into one. The control
 * plane owns the business facts and the message; this module owns the routing rules and the delivery.
 */
export class ReportCoordinator {
  /** The smallest interval between two ordinary progress reports to the same target. */
  private readonly progressIntervalMs: number
  /** The timer that releases a held-back progress report when it is due. */
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  /** The moment the next held-back report is due. */
  private flushAt = 0
  /** The flush that is running, so a close may wait for it. */
  private flushing: Promise<void> | undefined
  /** Whether the coordination is closing; nothing new is scheduled from here on. */
  private closing = false
  /** Whether the coordination was closed; nothing is written after that. */
  private closed = false

  constructor(private readonly store: Store, private readonly outbox: DeliveryOutbox,
    private readonly host: ReportCoordinatorHost, private readonly options: ReportCoordinatorOptions = {}) {
    this.progressIntervalMs = Math.max(0, options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS)
  }

  /**
   * The smallest interval between two ordinary progress reports, in milliseconds.
 *
 * It is the setting the deployment made: `0` delivers every ordinary progress report at once, and the default holds a
 * report back for a minute.
 */
  get progressInterval(): number { return this.progressIntervalMs }

  /** The deliveries the coordination holds, newest last. */
  deliveries(limit = 50): CoordinationDeliveryRow[] {
    return this.outbox.rows(limit)
  }

  /**
   * The deliveries as the console reads them.
   *
   * The view carries the facts of the delivery and never the body of the report: the stored message is the lower-trust
   * text of a Worker or a PM, and a console that shows it would show untrusted text as if it were the control plane's
   * own.
   */
  views(limit = 50): CoordinationDeliveryView[] {
    return this.outbox.views(limit)
  }

  /**
   * The newest delivery of one Ticket, as the PM of its Project reads it.
   *
   * The record is durable, so the PM's own view of a wake-up survives a restart of the control plane: a PM that comes
   * back reads what its Workers reported and what happened to the report, not an empty page.
   */
  notificationOf(ticketId: string): { reportState: string; assignmentId: string; projectId: string; at: string;
    state: CoordinationNotificationState; reason: string } | undefined {
    const row = this.store.db.prepare(
      'SELECT * FROM coordination_deliveries WHERE ticket_id = ? ORDER BY seq DESC LIMIT 1').get(ticketId)
    if (row === undefined) return undefined
    const delivery = this.outbox.readRow(row as Record<string, unknown>)
    return { reportState: delivery.reportKind, assignmentId: delivery.assignmentId, projectId: delivery.projectId,
      at: delivery.at, state: notificationStateOf(delivery.status), reason: delivery.error }
  }

  /**
   * Plan the delivery of one Worker report.
   *
   * The routing is by business ownership: a Worker's report goes to the PM of its own Project, and a standalone Worker's
   * report goes to the Router. A report never reaches a Session that has no business reading it.
   *
   * A report that must not be delivered now is recorded as such: a Project that is not active (archived or ended), a PM
   * that does not exist (the control plane never creates one on its own), and a report the superior already knows.
   *
   * A paused Project is the one case that waits instead of being given up: it has no PM to wake now, so the wake-up waits
   * for the resume — if the result still waits for the PM's decision by then.
   */
  planReport(facts: PmReportFacts, message: string): ReportPlanResult {
    const target = this.decideTarget(facts)
    if (target.kind !== 'deliver') return { state: target.kind, reason: target.reason }
    const delivery = this.planDelivery({
      kind: 'worker_report',
      projectId: facts.projectId,
      ticketId: facts.ticketId,
      assignmentId: facts.assignmentId,
      reportKind: facts.reportState,
      reviewId: facts.reviewId ?? '',
      content: facts.summary,
      question: facts.question ?? '',
      sourceSessionId: `worker-${facts.assignmentId}`,
      targetSessionId: target.target.sessionId,
      targetRole: target.target.role,
      nodeId: facts.nodeId ?? this.host.nodeId(),
      backendId: facts.backendId ?? this.host.backendId(),
      message,
    })
    if (delivery === undefined) {
      // The superior already knows this report: it is one fact, so it is not delivered twice.
      return { state: 'skipped', reason: 'the PM already knows this report' }
    }
    return { state: 'deliver', delivery }
  }

  /**
   * Plan the delivery of one PM's report about its own Project.
   *
   * A PM reports to the Router only what belongs to its Project as a whole: a milestone, a blocker, or a failure the
   * Router has to know about. The report is a fact about the work, never an order. An ordinary `progress` report is
   * throttled like any other; a milestone, a blocker and a failure go out at once.
   */
  planProjectReport(input: { projectId: string; sourceSessionId: string; summary: string; message: string,
    reportKind: CoordinationReportKind }): ReportPlanResult {
    const router = this.host.session(this.host.routerSessionId())
    const delivery = this.planDelivery({
      kind: 'pm_report',
      projectId: input.projectId,
      ticketId: '',
      assignmentId: '',
      reportKind: input.reportKind,
      reviewId: '',
      content: input.summary,
      question: '',
      sourceSessionId: input.sourceSessionId,
      targetSessionId: this.host.routerSessionId(),
      targetRole: router?.role ?? 'router',
      nodeId: this.host.nodeId(),
      backendId: this.host.backendId(),
      message: input.message,
    })
    if (delivery === undefined) {
      return { state: 'skipped', reason: 'the Router already knows this report' }
    }
    return { state: 'deliver', delivery }
  }

  /**
   * The Session a report of this Ticket is to go to, or why it may not go now.
   *
   * A Worker of a Project belongs to that Project's PM; a Worker of a standalone Ticket belongs to the Router, which
   * owns the Tickets no Project owns.
   */
  private decideTarget(facts: PmReportFacts):
  { kind: 'deliver'; target: ReportTarget } | { kind: 'deferred' | 'skipped'; reason: string } {
    if (facts.projectId === '') {
      const router = this.host.session(this.host.routerSessionId())
      if (router === undefined) return { kind: 'skipped', reason: 'the Router has no Session' }
      return { kind: 'deliver', target: { sessionId: router.sessionId, role: router.role } }
    }
    const project = this.host.project(facts.projectId)
    if (project === undefined) return { kind: 'skipped', reason: 'the Project of the Ticket does not exist' }
    if (project.status === 'paused') {
      return { kind: 'deferred', reason: 'the Project is paused; the wake-up waits for the resume' }
    }
    if (project.status !== 'active') return { kind: 'skipped', reason: `the Project is ${project.status}` }
    const manager = this.host.session(project.pmSessionId)
    if (manager === undefined) return { kind: 'skipped', reason: 'the Project has no PM Session' }
    if (manager.role !== 'pm' || manager.projectId !== project.id) {
      return { kind: 'skipped', reason: 'the PM Session does not belong to the Project' }
    }
    return { kind: 'deliver', target: { sessionId: manager.sessionId, role: manager.role } }
  }

  /** The delivery of one report, by its own id. */
  delivery(deliveryId: string): CoordinationDeliveryRow | undefined {
    return this.outbox.row(deliveryId)
  }

  /**
   * The deliveries that wait for a Project to be resumed.
   *
   * A report that was made while the Project was active, but whose delivery could not go out before the Project was
   * paused, waits here. It is not lost: the resume carries the very same delivery out again, after the report, the
   * source and the review it waits for are read again.
   */
  heldFor(projectId: string): CoordinationDeliveryRow[] {
    const rows = this.store.db.prepare(
      "SELECT * FROM coordination_deliveries WHERE status = 'deferred_for_resume' AND project_id = ? ORDER BY seq")
      .all(projectId) as Record<string, unknown>[]
    return rows.map(row => this.outbox.readRow(row))
  }

  /**
   * Settle the deliveries that wait for a Project's resume, because the Project will not be resumed.
   *
   * A Project that was hard paused or that ended takes its wake-ups with it: the PM is not to be woken any more, and a
   * report that waits for a resume that will not come is not pending any more either. The records stay where they are,
   * with the reason they were settled for.
   */
  settleHeldFor(projectId: string, status: CoordinationDeliveryStatus, reason: string): void {
    for (const row of this.heldFor(projectId)) {
      this.settle(row.deliveryId, 'deferred_for_resume', status, reason)
    }
  }

  /**
   * Plan one delivery, inside the control plane's own transaction.
   *
   * The plan is written next to the report it is about, so a report that was written always has its delivery work and a
   * delivery work that exists always names a report. The key that makes an identical report one delivery is reserved
   * here and held open until the delivery settles, so a report that never reached its superior may be tried once more.
   *
   * Returns the record to carry out, or undefined when the superior already knows this report: the report itself is
   * still written — a new call is a new fact — but nothing is delivered twice.
   */
  private planDelivery(plan: ReportDeliveryPlan): CoordinationDeliveryRow | undefined {
    const dedupKey = stableDedupKey(plan)
    // The durable uniqueness of the table is the authority here: a report that is already open under this key is one
    // fact, whether the running control plane knows it or a previous run of it left it behind.
    if (this.liveRowOf(dedupKey) !== undefined) return undefined
    // An ordinary progress report may be held back: the Worker's superior hears the latest one, not every one of them.
    const dueAt = this.progressDueAt(plan)
    // A newer report takes the place of a held-back one: the superior must not read an old progress after the fact that
    // replaced it.
    this.supersedeHeldProgress(plan)
    // A delivery that waits for a Project's resume gives its place to the delivery that is planned now: the same report
    // is one delivery, and the resume sends it once and not twice.
    this.supersedeHeldDelivery(dedupKey)
    // The delivery's own id is unique, never derived from its content: the same report may be delivered twice when the
    // earlier attempt did not reach the superior, and the two deliveries must stay apart.
    const deliveryId = `coordination-${randomUUID()}`
    const epochs = this.host.targetEpochs(plan.targetSessionId)
    const row: CoordinationDeliveryRow = {
      deliveryId,
      kind: plan.kind,
      at: this.host.now(),
      status: 'accepted_pending',
      idempotencyKey: `coordination:${deliveryId}`,
      dedupKey,
      scope: throttleScope(plan.targetSessionId, plan.assignmentId, plan.projectId),
      projectId: plan.projectId,
      ticketId: plan.ticketId,
      assignmentId: plan.assignmentId,
      reviewId: plan.reviewId,
      reportKind: plan.reportKind,
      contentDigest: contentDigest(plan.content),
      sourceSessionId: plan.sourceSessionId,
      targetSessionId: plan.targetSessionId,
      targetRole: plan.targetRole,
      nodeId: plan.nodeId,
      backendId: plan.backendId,
      expectedAssignmentEpoch: epochs.assignmentEpoch,
      expectedToolTokenVersion: epochs.toolTokenVersion,
      expectedNodeTrustEpoch: this.host.nodeTrustEpoch(),
      sourceAssignmentEpoch: this.sourceEpochOf(plan),
      attemptCount: 0,
      dispatchedAt: '',
      dueAt: dueAt ?? '',
      payload: plan.message,
      error: '',
      context: JSON.stringify(reportContextOf(plan)),
      expiresAt: this.expiryOf(),
      resendCount: 0,
      evidence: '',
    }
    try {
      this.outbox.insert(row)
    } catch (error) {
      // The unique index of the table refused the row: another delivery of the same report is open right now, so this
      // report is one fact and is not delivered twice.
      if (this.isUniqueViolation(error)) return undefined
      throw error
    }
    if (dueAt !== undefined) this.scheduleFlush(dueAt)
    return row
  }

  /**
   * The moment the message of a delivery runs out.
   *
   * The message life is its own: it does not follow the authorization, and the authorization does not follow it. A report
   * that is still the current one after a week is still a fact; one that ran out is not delivered any more.
   */
  private expiryOf(): string {
    const ttl = this.options.deliveryTtlMs ?? DEFAULT_DELIVERY_TTL_MS
    if (!Number.isFinite(ttl) || ttl <= 0) return ''
    const now = Date.parse(this.host.now())
    if (!Number.isFinite(now)) return ''
    return new Date(now + ttl).toISOString()
  }

  /**
   * The lifecycle generation of the Assignment a report is about.
   *
   * It is the generation of the source, kept apart from the target's: a report of a Worker that was replaced is a fact
   * about a life that is over, and the delivery says so. A PM's report is about its Project as a whole, so its source is
   * the PM Session itself and its life is the life of that managed Session.
   */
  private sourceEpochOf(plan: ReportDeliveryPlan): number {
    if (plan.assignmentId === '') return this.host.targetEpochs(plan.sourceSessionId).assignmentEpoch
    const report = this.host.reportOf(plan.ticketId, plan.assignmentId)
    return report?.assignmentEpoch ?? 0
  }

  /**
   * Carry out one planned delivery.
   *
   * The target is resolved again right before the message goes out: the authority, the ownership, the operator's stop and
   * the lifecycle of the Assignment are read at that moment, not when the delivery was planned. The Project the report
   * belongs to is read again as well: a Project that was paused after the report was made has no PM to wake, so the
   * wake-up waits for the resume instead of being lost. The report the delivery is about is read again too, so a
   * delivery that waited may not carry a fact that has been replaced. A target that is gone, stopped or replaced is
   * refused with the reason, and the report keeps its place in the record.
   *
   * The delivery is claimed before it goes out, and the claim is a conditional write: only one of two callers may send
   * it, and a snapshot that is stale by the time it writes changes nothing.
   */
  async deliver(row: CoordinationDeliveryRow): Promise<ReportDeliveryOutcome> {
    const current = this.delivery(row.deliveryId)
    if (current === undefined) return { state: 'skipped', reason: 'the delivery record is gone' }
    // A delivery that waits for a Project's resume is carried out again from the state it waits in; every other state
    // is settled already.
    if (current.status !== 'accepted_pending' && current.status !== 'deferred_for_resume') {
      return { state: 'skipped', reason: `the delivery is already ${current.status}`, delivery: current }
    }
    if (current.dueAt !== '' && !this.dueNow(current.dueAt)) {
      this.scheduleFlush(current.dueAt)
      return { state: 'pending', reason: 'the report is held back until the progress interval passed', delivery: current }
    }
    // The report the delivery is about is read again: a report that was replaced while the delivery waited may not go
    // out behind its replacement.
    const source = this.validateSource(current)
    if (!source.ok) {
      this.settle(current.deliveryId, current.status, source.status, source.reason)
      return { state: 'skipped', reason: source.reason, delivery: this.delivery(current.deliveryId) }
    }
    // The Project the report belongs to and the PM that has to hear it are read again: a Project that was paused after
    // the report was made has no PM to wake now, and the wake-up waits for the resume.
    const target = this.validateTarget(current)
    if (!target.ok) {
      this.settle(current.deliveryId, current.status, target.status, target.reason)
      // A wake-up that waits for the resume is not skipped: it is still pending, and the resume carries it out again.
      const held = target.status === 'deferred_for_resume'
      return { state: held ? 'pending' : 'skipped', reason: target.reason, delivery: this.delivery(current.deliveryId) }
    }
    const resolution = await this.host.resolveTarget(current.targetSessionId, 'message')
    if (!resolution.ok) {
      const refused = refusalOutcome(resolution.code)
      const reason = resolution.reason
      this.settle(current.deliveryId, current.status, refused.status, reason)
      return { state: refused.state, reason, delivery: this.delivery(current.deliveryId) }
    }
    // The lifecycle the delivery was planned under must still hold: a target that was replaced since is not this one.
    // The credential's own version is not compared: a refresh replaces the credential and nothing else.
    if (resolution.generation.assignmentEpoch !== current.expectedAssignmentEpoch) {
      const reason = 'the target was replaced before the delivery went out'
      this.settle(current.deliveryId, current.status, 'rejected_stale_or_revoked', reason)
      return { state: 'skipped', reason, delivery: this.delivery(current.deliveryId) }
    }
    // One claim, one send: the row is claimed with a conditional write, so two callers cannot both take it.
    if (!this.outbox.claim(current.deliveryId, ['accepted_pending', 'deferred_for_resume'])) {
      return { state: 'skipped', reason: 'the delivery was already claimed', delivery: this.delivery(current.deliveryId) }
    }
    try {
      // The check that runs right before the transport: the life the delivery was planned for is read again at that very
      // moment, so a target that was replaced or stopped while the ensure was on its way does not receive the message.
      await this.host.deliver(current.targetSessionId, current.payload, current.idempotencyKey, () => {
        this.assertSendable(current)
      }, { ticketId: current.ticketId, assignmentId: current.assignmentId, projectId: current.projectId }, current.kind)
    } catch (error) {
      // A missing receipt is not a refusal: the message may have arrived, so it is neither a failure nor to be repeated.
      const unconfirmed = error instanceof NodeUnconfirmedError
      const unavailable = error instanceof CoordinationTargetUnavailableError
      const reason = redact(error instanceof Error ? error.message : String(error)).slice(0, 300)
      if (error instanceof CoordinationDeliveryStaleError) {
        // A delivery that was refused before the wire never went out: it is skipped, not failed, and it is no lost receipt.
        this.settle(current.deliveryId, 'dispatching', error.status, reason)
        return { state: error.status === 'deferred_for_resume' ? 'pending' : 'skipped', reason,
          delivery: this.delivery(current.deliveryId) }
      }
      const status: CoordinationDeliveryStatus = unconfirmed ? 'unconfirmed'
        : unavailable ? 'blocked_node_unavailable' : 'failed_permanent'
      this.settle(current.deliveryId, 'dispatching', status, reason)
      return { state: 'failed', reason, delivery: this.delivery(current.deliveryId) }
    }
    this.settle(current.deliveryId, 'dispatching', 'delivered_inbox', '')
    return { state: 'sent', delivery: this.delivery(current.deliveryId) }
  }

  /**
   * Record that a delivery could not even be attempted.
   *
   * The target was never ready for it — a Router a person stopped, an ensure that failed before the message left — so
   * the delivery is recorded with the reason instead of waiting for a send that will never happen.
   */
  fail(deliveryId: string, status: CoordinationDeliveryStatus, reason: string): void {
    this.settle(deliveryId, 'accepted_pending', status, redact(reason).slice(0, 300))
  }

  /**
   * The deliveries a restart left open.
   *
   * The recovery belongs to the outbox: it owns the table, it asks the node what it can prove about a delivery that was
   * on its way, and it settles every kind of coordination the same way. A delivery that was never sent is carried out
   * again under its own key, after the report it is about and the target it names are read again. A delivery that was on
   * its way when the control plane stopped is asked about: the node is the only one that knows whether it arrived.
   */
  async recover(): Promise<void> {
    await this.outbox.recover()
  }

  /**
   * Recover the deliveries of one Project that a pause left on the wire.
   *
   * A delivery that was on its way when the Project was paused is not a report that waits for a resume: the node is the
   * only one that knows whether the message arrived, and its answer is what the record says. The recovery belongs to the
   * outbox: it asks the node about the exact key of the exact Session, and it carries out the one re-send a proof of
   * absence permits — under the delivery's own key, and only when that re-send was not made yet.
   */
  async recoverProject(projectId: string): Promise<void> {
    await this.outbox.recoverProject(projectId)
  }

  /**
   * Stop the timer that releases a held-back report, and wait for a flush that is running.
   *
   * Nothing new is scheduled from here on, but the flush that is already running is waited for: a delivery that is on its
   * way is written down before the file closes. Only then does the coordination stop writing, so a record that belongs to
   * a delivery in flight is not lost.
   */
  async close(): Promise<void> {
    this.closing = true
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.flushAt = 0
    const flushing = this.flushing
    if (flushing !== undefined) await flushing.catch(() => {})
    this.closed = true
  }

  /**
   * The moment an ordinary progress report may go out, or undefined when it may go out at once.
   *
   * The interval is measured from the last progress report the same target really received for the same owner, so a
   * busy Worker does not wake its superior for every turn it takes. The first progress report of a scope has nothing to
   * wait for and goes out at once.
   */
  private progressDueAt(plan: ReportDeliveryPlan): string | undefined {
    if (this.progressIntervalMs <= 0) return undefined
    if (plan.reportKind !== 'progress') return undefined
    const last = this.lastDispatchAt(plan)
    if (last === undefined) return undefined
    const now = Date.parse(this.host.now())
    const since = now - Date.parse(last)
    if (!Number.isFinite(since) || since >= this.progressIntervalMs) return undefined
    return new Date(Date.parse(last) + this.progressIntervalMs).toISOString()
  }

  /**
   * When the same target last really received an ordinary progress report of the same owner.
   *
   * A delivery that is on its way counts: the message may already be in the target's inbox, so the next one waits for
   * the interval whether or not the receipt arrived yet.
   */
  private lastDispatchAt(plan: ReportDeliveryPlan): string | undefined {
    const row = this.store.db.prepare(
      "SELECT MAX(dispatched_at) AS last FROM coordination_deliveries WHERE scope = ? AND report_kind = 'progress' "
      + "AND status IN ('dispatching','delivered_inbox','consumed_turn')")
      .get(throttleScope(plan.targetSessionId, plan.assignmentId, plan.projectId)) as Record<string, unknown> | undefined
    const last = row?.last
    if (last === undefined || last === null || String(last) === '') return undefined
    return String(last)
  }

  /**
   * Drop the progress report that waits for the same target and the same owner.
   *
   * Only the newest value is worth delivering: the one it replaces was never sent, so nothing is lost by letting it go.
   * A report that is not an ordinary progress replaces it as well: a superior must not read an old progress after the
   * fact that replaced it.
   */
  private supersedeHeldProgress(plan: ReportDeliveryPlan): void {
    const scope = throttleScope(plan.targetSessionId, plan.assignmentId, plan.projectId)
    const rows = this.store.db.prepare(
      "SELECT delivery_id FROM coordination_deliveries WHERE scope = ? AND report_kind = 'progress' "
      + "AND status = 'accepted_pending'").all(scope) as Record<string, unknown>[]
    for (const row of rows) {
      this.settle(String(row.delivery_id ?? ''), 'accepted_pending', 'superseded',
        'a newer report took the place of this one')
    }
  }

  /**
   * Let a delivery that waits for a Project's resume give way to the one that is planned now.
   *
   * The same report is one delivery: a report that is planned again while the older one waits for the resume takes its
   * place, so the resume sends the report once and not twice.
   */
  private supersedeHeldDelivery(dedupKey: string): void {
    const rows = this.store.db.prepare(
      "SELECT delivery_id FROM coordination_deliveries WHERE dedup_key = ? AND status = 'deferred_for_resume'")
      .all(dedupKey) as Record<string, unknown>[]
    for (const row of rows) {
      this.settle(String(row.delivery_id ?? ''), 'deferred_for_resume', 'superseded',
        'a newer delivery of the same report took its place')
    }
  }

  /**
   * Whether the report the delivery is about is still the one the superior is to hear.
   *
   * The check is made on every send, not only after a restart: a report that was replaced while the delivery waited may
   * not go out behind its replacement, and a round that was decided in the meantime is not a fact the superior still
   * needs.
   */
  private validateSource(row: CoordinationDeliveryRow): { ok: true } | { ok: false; status: CoordinationDeliveryStatus; reason: string } {
    if (row.kind === 'pm_report') return this.validatePmSource(row)
    // The Session that made the report is read again: a Worker whose authority is gone may not speak for its work any
    // more, and a report that waits may not reach the PM behind the back of the authority that made it.
    const worker = this.validateWorkerSource(row)
    if (!worker.ok) return worker
    const report = this.host.reportOf(row.ticketId, row.assignmentId)
    if (report === undefined) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the report this delivery was about is no longer the current one' }
    }
    if (report.projectId !== row.projectId) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the Project this delivery was about is no longer the scope of the report' }
    }
    if (report.state !== row.reportKind) {
      return { ok: false, status: 'superseded', reason: 'a newer report replaced this one' }
    }
    if (contentDigest(report.summary) !== row.contentDigest) {
      return { ok: false, status: 'superseded', reason: 'the report this delivery was about changed' }
    }
    // The review round the report waits for is read again: a round that was decided in the meantime is not a fact the
    // superior still needs.
    if (row.reviewId !== '') {
      const review = this.host.reviewOf(row.ticketId, row.assignmentId) ?? ''
      if (review !== row.reviewId) {
        return { ok: false, status: 'rejected_stale_or_revoked',
          reason: 'the review round this delivery was about was decided in the meantime' }
      }
    }
    return { ok: true }
  }

  /**
   * Whether the Worker Session that made the report is still the one that may speak for it.
   *
   * The Session's own binding is the authority: it must still be a Worker, it must still run the Assignment the report
   * is about, and it must still be bound to the node and the backend the report came from. A Session that was revoked
   * or stopped by an operator has no authority any more, and a report that waits may not reach the PM behind the back
   * of it.
   *
   * The life of the Assignment itself is not read here: a Worker that did its work and reported the result reports a
   * fact that is still true, whether its Assignment ended by itself or not. A report that is complete — the result a
   * standalone Ticket waits for, or the work that was dropped — stays valid even after its Assignment ended.
   */
  private validateWorkerSource(row: CoordinationDeliveryRow): { ok: true } | { ok: false; status: CoordinationDeliveryStatus; reason: string } {
    const source = this.host.session(row.sourceSessionId)
    if (source === undefined) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the Worker Session this delivery was about is gone' }
    }
    if (source.role !== 'worker') {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the Session this delivery was about is not a Worker' }
    }
    if (source.assignmentId !== row.assignmentId) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the Worker Session does not run the Assignment this delivery was about' }
    }
    if (source.nodeId !== row.nodeId || row.backendId !== this.host.backendId()) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the Worker Session is not bound to the node and the backend the report came from' }
    }
    if (source.revokedAt) {
      return { ok: false, status: 'rejected_stale_or_revoked', reason: 'the Worker Session was revoked' }
    }
    if (source.operatorStop !== undefined) {
      return { ok: false, status: 'blocked_target_inactive', reason: 'the Worker Session was stopped by an operator' }
    }
    return { ok: true }
  }

  /**
   * Whether the Project the report belongs to and the PM that has to hear it still hold.
   *
   * A report of a Project belongs to that Project's PM, and a Project that is paused has no PM to wake: the wake-up
   * waits for the resume, and the delivery keeps its place in the record instead of being lost. A Project that was
   * ended, archived or given to another manager is over for this report, and the report is not sent any more.
   *
   * A standalone report belongs to the Router and a PM's own report has its own rule, so neither is judged here.
   */
  private validateTarget(row: CoordinationDeliveryRow): { ok: true } | { ok: false; status: CoordinationDeliveryStatus; reason: string } {
    if (row.kind !== 'worker_report' || row.projectId === '') return { ok: true }
    const project = this.host.project(row.projectId)
    if (project === undefined) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the Project this delivery was about does not exist' }
    }
    if (project.pmSessionId !== row.targetSessionId) {
      return { ok: false, status: 'rejected_stale_or_revoked', reason: 'the Project has another manager now' }
    }
    const manager = this.host.session(row.targetSessionId)
    if (manager === undefined) {
      return { ok: false, status: 'rejected_stale_or_revoked', reason: 'the PM Session this delivery was about is gone' }
    }
    if (manager.role !== 'pm' || manager.projectId !== project.id) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the PM Session does not belong to the Project' }
    }
    // A PM that lost its authority may not be woken, and a PM a person put to rest is never brought back by a report.
    if (manager.revokedAt) {
      return { ok: false, status: 'rejected_stale_or_revoked', reason: 'the PM Session was revoked' }
    }
    if (manager.operatorStop !== undefined) {
      return { ok: false, status: 'blocked_target_inactive', reason: 'the PM Session was stopped by an operator' }
    }
    if (project.status === 'ended' || project.status === 'archived') {
      return { ok: false, status: 'rejected_stale_or_revoked', reason: `the Project ${project.id} is ${project.status}` }
    }
    if (project.status === 'paused') {
      // A hard pause stopped the Workers of the Project: the PM is not woken behind a person's back, and the wake-up
      // does not wait for a resume either — that pause was meant to end the work.
      if (project.pauseMode === 'hard') {
        return { ok: false, status: 'blocked_target_inactive', reason: `the Project ${project.id} is hard paused` }
      }
      return { ok: false, status: 'deferred_for_resume',
        reason: `the Project ${project.id} is paused; the wake-up waits for the resume` }
    }
    return { ok: true }
  }

  /**
   * Whether a PM's report about its own Project is still the one the Router is to hear.
   *
   * A PM's report has no Assignment of its own: its source is the PM Session, and its life is the life of that managed
   * Session. The report is only still the current one while the Project names this very PM as its manager, while that PM
   * still runs the life the report was made in and was neither revoked nor stopped, and while the Project still carries
   * this summary as its latest report. A report that waits while the Project is paused, stopped or changed is never sent
   * afterwards: the Router would read a fact about a Project that is no longer there.
   */
  private validatePmSource(row: CoordinationDeliveryRow): { ok: true } | { ok: false; status: CoordinationDeliveryStatus; reason: string } {
    const project = this.host.project(row.projectId)
    if (project === undefined) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the Project this delivery was about does not exist' }
    }
    if (project.pmSessionId !== row.sourceSessionId) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the Project has another manager now' }
    }
    if (project.status === 'ended' || project.status === 'archived') {
      return { ok: false, status: 'rejected_stale_or_revoked', reason: `the Project ${project.id} is ${project.status}` }
    }
    if (project.status === 'paused') {
      return { ok: false, status: 'blocked_target_inactive', reason: `the Project ${project.id} is paused` }
    }
    const source = this.host.session(row.sourceSessionId)
    if (source === undefined) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the PM Session this delivery was about is gone' }
    }
    if (source.projectId !== row.projectId) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the PM Session does not belong to the Project' }
    }
    if (source.revokedAt) {
      return { ok: false, status: 'rejected_stale_or_revoked', reason: 'the PM Session was revoked' }
    }
    if (source.operatorStop !== undefined) {
      return { ok: false, status: 'blocked_target_inactive',
        reason: 'the PM Session was stopped by an operator' }
    }
    if (this.host.targetEpochs(row.sourceSessionId).assignmentEpoch !== row.sourceAssignmentEpoch) {
      return { ok: false, status: 'rejected_stale_or_revoked',
        reason: 'the PM Session was started again since the report was made' }
    }
    const latest = project.latestReport
    if (latest === undefined || contentDigest(latest.summary) !== row.contentDigest) {
      return { ok: false, status: 'superseded', reason: 'a newer report replaced this one' }
    }
    return { ok: true }
  }

  /**
   * The last check before the message goes on the wire.
   *
   * Everything the delivery was planned under is read again at the moment the transport is about to happen: the report is
   * still the current one, the Worker that made it still has its authority, the Project still has this PM, and the target
   * still runs the life the delivery was planned for. The target itself is resolved once more, without waiting: the
   * revocation, the binding, the operator's stop and the liveness of the node are read here, not when the delivery was
   * planned. The credential's own version is not compared: a refresh replaces the credential and nothing else.
   *
   * The check is synchronous on purpose — a check before another await would leave the same gap open.
   */
  private assertSendable(row: CoordinationDeliveryRow): void {
    const source = this.validateSource(row)
    if (!source.ok) throw new CoordinationDeliveryStaleError(source.reason, source.status)
    const target = this.validateTarget(row)
    if (!target.ok) throw new CoordinationDeliveryStaleError(target.reason, target.status)
    const epochs = this.host.targetEpochs(row.targetSessionId)
    if (epochs.assignmentEpoch !== row.expectedAssignmentEpoch) {
      throw new CoordinationDeliveryStaleError('the target was replaced before the message went out',
        'rejected_stale_or_revoked')
    }
    // The exact target is resolved once more, at this very moment: a target that was revoked, stopped, replaced or
    // unbound while the ensure was on its way does not receive the message.
    const resolved = this.host.resolveTargetNow(row.targetSessionId, 'message')
    if (!resolved.ok) {
      throw new CoordinationDeliveryStaleError(resolved.reason, refusalOutcome(resolved.code).status)
    }
    if (resolved.generation.assignmentEpoch !== row.expectedAssignmentEpoch) {
      throw new CoordinationDeliveryStaleError('the target was replaced before the message went out',
        'rejected_stale_or_revoked')
    }
  }

  /** Whether a held-back report may go out now. */
  private dueNow(dueAt: string): boolean {
    const due = Date.parse(dueAt)
    const now = Date.parse(this.host.now())
    return !Number.isFinite(due) || !Number.isFinite(now) || now >= due
  }

  /** Release the held-back reports when they are due. */
  private scheduleFlush(dueAt: string): void {
    if (this.closing || this.closed) return
    const due = Date.parse(dueAt)
    if (!Number.isFinite(due)) return
    if (this.flushTimer !== undefined && this.flushAt <= due) return
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
    this.flushAt = due
    const delay = Math.max(0, due - Date.parse(this.host.now()))
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flushAt = 0
      this.flushing = this.flushPending().finally(() => { this.flushing = undefined })
    }, delay)
    this.flushTimer.unref?.()
  }

  /** Deliver the progress reports that are due, and the ones that come due while they wait. */
  private async flushPending(): Promise<void> {
    if (this.closed) return
    const rows = this.store.db.prepare(
      "SELECT * FROM coordination_deliveries WHERE status = 'accepted_pending' AND report_kind = 'progress' ORDER BY seq")
      .all() as Record<string, unknown>[]
    for (const raw of rows) {
      if (this.closed) return
      const row = this.outbox.readRow(raw)
      if (row.dueAt !== '' && !this.dueNow(row.dueAt)) {
        this.scheduleFlush(row.dueAt)
        continue
      }
      await this.deliver(row)
    }
  }

  /** The open delivery of one report, when there is one. */
  private liveRowOf(dedupKey: string): CoordinationDeliveryRow | undefined {
    return this.outbox.liveRowOf(dedupKey)
  }

  /**
   * Change the state of one delivery, but only from the state it was in.
   *
   * A snapshot that is stale by the time it writes changes nothing: the row has moved on, and the fact it wanted to
   * record is about a delivery that is no longer the one it read.
   */
  private settle(deliveryId: string, from: CoordinationDeliveryStatus, to: CoordinationDeliveryStatus, error: string): void {
    if (this.closed) return
    this.outbox.settle(deliveryId, from, to, error)
  }

  /** Whether SQLite refused a write because of its unique index. */
  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  }

  /**
   * Re-read the authority of one delivery of a report.
   *
   * This is the answer the outbox asks before it sends a delivery again: the report the delivery is about must still be
   * the report the superior is to hear, the Worker that made it must still be the one that may speak for it, and the
   * Project and its PM must still hold.
   *
   * A report that is held back by the throttle is not refused: it keeps its place and waits for its moment.
   */
  revalidate(row: CoordinationDeliveryRow): DeliveryRevalidation {
    if (row.dueAt !== '' && !this.dueNow(row.dueAt)) {
      return { ok: false, outcome: 'held', reason: 'the report is held back until the progress interval passed' }
    }
    const source = this.validateSource(row)
    if (!source.ok) return { ok: false, outcome: 'closed', status: source.status, reason: source.reason }
    const target = this.validateTarget(row)
    if (!target.ok) return { ok: false, outcome: 'closed', status: target.status, reason: target.reason }
    // The lifecycle the delivery was planned under must still hold: a target that was replaced since is not this one.
    // The credential's own version is not compared: a refresh replaces the credential and nothing else.
    if (this.host.targetEpochs(row.targetSessionId).assignmentEpoch !== row.expectedAssignmentEpoch) {
      return { ok: false, outcome: 'closed', status: 'rejected_stale_or_revoked',
        reason: 'the target was replaced before the delivery went out' }
    }
    return { ok: true }
  }

  /**
   * The message of one delivery of a report, for a delivery that is sent again.
   *
   * The message was assembled when the report was accepted: it is the isolated, bounded reference the PM reads, and it
   * is the very message the first attempt carried. A delivery that has no message is not sent with another one.
   */
  payloadOf(row: CoordinationDeliveryRow): string | undefined {
    return row.payload === '' ? undefined : row.payload
  }
}
