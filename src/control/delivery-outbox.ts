/**
 * The durable outbox of the coordination deliveries.
 *
 * Six kinds of work travel from one Session to another, and all six share the same hard question: what really happened
 * to a message that the control plane accepted? The handoff the Router gave a Project's PM, the report a Worker made,
 * the report a PM made about its own Project, the digest a superior asked for, the review a permission denial caused and
 * the wake-up an external observation produced — they are different facts about different work, and they are the same
 * problem on the wire.
 *
 * The outbox is the answer to that problem, and it is deliberately one table. Everything a recovery needs is written
 * down before anything goes out: the target, the source, the generations it was planned under, the key the node knows it
 * by, the owning record it belongs to, and when the message itself runs out. A record that exists is a delivery the
 * control plane owes; a record that does not is a delivery nobody may claim.
 *
 * Two lives are kept apart. The **authorization life** is the Session's own: its revocation, the operator's stop, the
 * Assignment it runs and the Project it belongs to. The **message life** is the message's own: how long the words the
 * control plane accepted are still worth delivering. A message may outlive its authorization — it is then rejected, not
 * delivered — and an authorization may outlive its message, which is then stale and dropped. Neither is derived from the
 * other.
 *
 * The recovery is the part that must not lie. A record that was *never sent* is sent again, under the very key the node
 * knows it by, so the node executes it at most once. A record that was *on its way* when the control plane stopped has an
 * unknown outcome, and the only honest way to learn it is to ask the node that received it: the node is asked for the
 * exact key in the exact Session, and it answers with what it can *prove*. A proof that the message is in the inbox ends
 * the delivery; a proof that a turn read it ends it more strongly; a proof that the message never arrived permits one
 * controlled re-send; and everything else — a node that cannot answer, a node that is not there, a cache that a restart
 * empties — leaves the delivery *unconfirmed*, which is a fact the console shows and never a licence to send again.
 *
 * The one re-send is spent exactly once, and it is spent only by a re-send that really went out. A delivery that is
 * waiting for its re-send keeps its place on the wire instead of falling back into a class that says its message never
 * left: the ordinary path would carry it out as a fresh send, and the re-send the proof permits would be spent a second
 * time. A re-send that was claimed and then refused before the transport never left, so its budget goes back to the
 * delivery, and the recovery that owns it carries it out when the target may be reached again.
 */
import { randomUUID } from 'node:crypto'
import type { Store } from '../app/store.ts'
import { redact } from '../infra/redact.ts'
import { NodeUnconfirmedError, type DeliveryEvidence, type SessionRole } from '../shared/protocol.ts'

/**
 * The kinds of coordination the outbox carries.
 *
 * Each kind is a different fact with a different owner, and the kind is what tells the recovery whose authority to
 * re-read. `auto_handoff` is the Router's own decision to give a request to a Project's PM, `worker_report` and
 * `pm_report` are the reports of the domain, `stream_digest` is a superior's digest of a subordinate's activity,
 * `denial_review` is the review a permission guard's refusal caused, and `external_wakeup` is an observation that
 * matched a subscription.
 */
export type CoordinationDeliveryKind =
  | 'auto_handoff'
  | 'worker_report'
  | 'pm_report'
  | 'stream_digest'
  | 'denial_review'
  | 'external_wakeup'

/**
 * Whether the payload of one kind of coordination is a sealed packet.
 *
 * Three kinds are sealed. The external wake-up is an isolation envelope: it carries its own declaration, it is cut to a
 * byte budget of its own, and the fence it closes has to stay the last thing in the message — a block of reference data
 * appended to it would push the envelope past its budget and would put something behind its fence. The stream digest ends
 * with the reference of the Session it is about, and that line has to stay the last one for the same reason.
 *
 * **The denial review is sealed as well, and it is a boundary of its own.** The review is the packet of one refusal: it
 * carries its own bounded projection of the governed work and nothing else, and the work it names is the work of one
 * scope. A block of reference data appended to it would put the live state of the whole control plane in front of the
 * Session that reads the review — another Project's running Ticket among them — and the packet would no longer be the one
 * packet it was. The ordinary talk of the Router is a different road and keeps its reference material.
 *
 * The other three kinds are ordinary turns: a handoff, a report of a Worker and a report of a PM are all addressed to a
 * Session that may read the reference material beside them.
 *
 * **The kind is the only thing that decides this.** It is a fact of the coordination, not of the words: the text of a
 * message never says whether it may carry a block, because a message cannot be trusted to say so about itself.
 */
export function isSealedDelivery(kind: CoordinationDeliveryKind | undefined): boolean {
  return kind === 'stream_digest' || kind === 'external_wakeup' || kind === 'denial_review'
}

/**
 * The states of one coordination delivery.
 *
 * They are facts about different moments, and the record keeps them apart: `accepted_pending` is a delivery that was
 * accepted and not sent yet, `dispatching` one that is on its way to the node, `delivered_inbox` one the node confirmed
 * in the target's inbox, `consumed_turn` one a turn of the target read, `unconfirmed` one whose receipt is missing,
 * `blocked_target_inactive` one whose target is stopped, paused or gone, `blocked_node_unavailable` one the node could
 * not be reached on, `rejected_stale_or_revoked` one whose authority or generation no longer holds, `failed_permanent`
 * one the node refused or one whose message ran out, `superseded` one a newer delivery replaced before it could go out,
 * and `deferred_for_resume` one that waits for the Project to be resumed.
 */
export type CoordinationDeliveryStatus =
  | 'accepted_pending'
  | 'dispatching'
  | 'delivered_inbox'
  | 'consumed_turn'
  | 'unconfirmed'
  | 'blocked_target_inactive'
  | 'blocked_node_unavailable'
  | 'rejected_stale_or_revoked'
  | 'failed_permanent'
  | 'superseded'
  | 'deferred_for_resume'

/**
 * The owning record of one delivery, in the words of its own kind.
 *
 * The context is what makes a delivery recoverable without guessing: it names the record the delivery belongs to, so the
 * recovery can re-read that record and learn whether the delivery may still go out. It is typed data and nothing else —
 * no callback, no closure, no serialized function — because a recovery must be able to read it after a restart, in
 * another process, without running anything the writer left behind.
 *
 * The authority of a delivery is never inferred from a role or from the text of a message. It comes from the record this
 * context names.
 *
 * A context that names the revision of the rule it was planned under binds the delivery to that revision: a rule that
 * changed while the delivery was on its way may not carry it out, and a context that cannot be read back may not carry
 * it out either. A context of an older shape is therefore never a licence to dispatch.
 */
export type DeliveryContext =
  | { readonly kind: 'auto_handoff'; readonly requestId: string; readonly projectId: string;
    readonly handoffKind: 'handoff' | 'brief' }
  | { readonly kind: 'worker_report'; readonly ticketId: string; readonly assignmentId: string;
    readonly reportKind: string; readonly reviewId: string }
  | { readonly kind: 'pm_report'; readonly projectId: string }
  | { readonly kind: 'stream_digest'; readonly subscriptionId: string; readonly fromSeq: number; readonly toSeq: number }
  | { readonly kind: 'denial_review'; readonly noticeId: string; readonly scopeKey: string }
  | { readonly kind: 'external_wakeup'; readonly subscriptionId: string; readonly sourceId: string;
    readonly eventId: string; readonly revision: number }

/** One delivery of one coordination, as the durable record holds it. */
export interface CoordinationDeliveryRow {
  /** The delivery's own id; it names the delivery on the node as well. */
  deliveryId: string
  /** What kind of coordination the delivery is. */
  kind: CoordinationDeliveryKind
  /** When the delivery was accepted. */
  at: string
  /** The state the delivery reached. */
  status: CoordinationDeliveryStatus
  /** The key the node knows this delivery by; a repeated key is executed at most once. */
  idempotencyKey: string
  /** The stable key that makes an identical delivery one delivery. */
  dedupKey: string
  /** The scope the throttle of this delivery counts in: the target and the owner of the report. */
  scope: string
  /** The Project the delivery belongs to; empty for a standalone Ticket. */
  projectId: string
  /** The Ticket the delivery is about. */
  ticketId: string
  /** The Assignment the delivery is about; empty for a PM's Project report. */
  assignmentId: string
  /** The review round the delivery waits for, when it waits for one. */
  reviewId: string
  /** The kind of the report; empty for a delivery that is not a report. */
  reportKind: string
  /** The digest of the report's own content. */
  contentDigest: string
  /** The Session that made the report. */
  sourceSessionId: string
  /** The Session the delivery is delivered to. */
  targetSessionId: string
  /** What the target Session is for. */
  targetRole: SessionRole
  /** The node the delivery is made to. */
  nodeId: string
  /** The backend the delivery is made to. */
  backendId: string
  /** The lifecycle generation of the target when the delivery was enqueued. */
  expectedAssignmentEpoch: number
  /** The credential version of the target when the delivery was enqueued. */
  expectedToolTokenVersion: number
  /** The node trust the delivery was made under. */
  expectedNodeTrustEpoch: number
  /** The lifecycle generation of the Assignment the delivery is about. */
  sourceAssignmentEpoch: number
  /** How many times the delivery was attempted. */
  attemptCount: number
  /** When the delivery was claimed and went on its way. */
  dispatchedAt: string
  /** When a held-back delivery may go out; empty when it may go out at once. */
  dueAt: string
  /** The body of the delivery, as an isolated reference. */
  payload: string
  /** Why the delivery failed, when it did. */
  error: string
  /** The owning record of this delivery, in the words of its own kind. */
  context: string
  /** When the message itself runs out; empty when it never does. */
  expiresAt: string
  /** How many times the delivery was sent again after the node proved it never arrived. */
  resendCount: number
  /** What the node last said about this delivery. */
  evidence: string
}

/**
 * One delivery as the console reads it.
 *
 * The body of the delivery is not part of it: the stored message is the lower-trust text of a Worker, a PM or an external
 * observation, and the console shows what happened to a delivery, not what it said. The idempotency key is not part of it
 * either: it is the node's own name for the delivery, and nothing outside the node has a use for it.
 */
export interface CoordinationDeliveryView {
  /** The delivery's own id. */
  deliveryId: string
  /** What kind of coordination the delivery is. */
  kind: CoordinationDeliveryKind
  /** When the delivery was accepted. */
  at: string
  /** The state the delivery reached. */
  status: CoordinationDeliveryStatus
  /** The kind of the report; empty for a delivery that is not a report. */
  reportKind: string
  /** The Project the delivery belongs to; empty for a standalone Ticket. */
  projectId: string
  /** The Ticket the delivery is about. */
  ticketId: string
  /** The Assignment the delivery is about. */
  assignmentId: string
  /** The review round the delivery waits for, when it waits for one. */
  reviewId: string
  /** The Session that made the report. */
  sourceSessionId: string
  /** The Session the delivery is delivered to. */
  targetSessionId: string
  /** What the target Session is for. */
  targetRole: SessionRole
  /** The node the delivery is made to. */
  nodeId: string
  /** The backend the delivery is made to. */
  backendId: string
  /** How many times the delivery was attempted. */
  attemptCount: number
  /** The lifecycle generation of the target when the delivery was enqueued. */
  expectedAssignmentEpoch: number
  /** The credential version of the target when the delivery was enqueued. */
  expectedToolTokenVersion: number
  /** The node trust the delivery was made under. */
  expectedNodeTrustEpoch: number
  /** The lifecycle generation of the Assignment the delivery is about. */
  sourceAssignmentEpoch: number
  /** When a held-back delivery may go out; empty when it may go out at once. */
  dueAt: string
  /** When the delivery was claimed and went on its way. */
  dispatchedAt: string
  /** Why the delivery failed, when it did. */
  error: string
  /** When the message itself runs out; empty when it never does. */
  expiresAt: string
  /** How many times the delivery was sent again after the node proved it never arrived. */
  resendCount: number
  /** What the node last said about this delivery. */
  evidence: string
}

/**
 * A delivery that may not go on the wire any more.
 *
 * The check that runs immediately before the transport found that the life the delivery was planned for is over: the
 * report was replaced, the source moved on, or the target was replaced. The message never left this control plane, so it
 * is neither a lost receipt nor a refusal by the node: the record says which of the two it is.
 */
export class CoordinationDeliveryStaleError extends Error {
  constructor(message: string, readonly status: CoordinationDeliveryStatus) {
    super(message)
    this.name = 'CoordinationDeliveryStaleError'
  }
}

/**
 * What the re-read of one delivery's authority found.
 *
 * A delivery that may go out is `ok`. A delivery that may not is refused with the status the record is to reach: a
 * target that is resting is blocked, a target whose life is over is rejected for good, and a node that is not there
 * blocks the delivery for now.
 *
 * A delivery that may not go out *yet* is held: it is neither closed nor sent, and it keeps its place in the record for
 * the moment it may go.
 */
export type DeliveryRevalidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly outcome: 'closed'; readonly status: CoordinationDeliveryStatus; readonly reason: string }
  | { readonly ok: false; readonly outcome: 'held'; readonly reason: string }

/**
 * What one kind of coordination asks the outbox to accept.
 *
 * It is the whole of a delivery: the target, the source, the generations, the key the node knows it by, the owning
 * record and the message. The outbox fills in the rest.
 */
export interface DeliveryAcceptance {
  /** What kind of coordination the delivery is. */
  kind: CoordinationDeliveryKind
  /** The key the node knows this delivery by; a repeated key is executed at most once. */
  idempotencyKey: string
  /** The stable key that makes an identical delivery one delivery. */
  dedupKey: string
  /** The scope the throttle of this delivery counts in. */
  scope: string
  /** The Project the delivery belongs to. */
  projectId: string
  /** The Ticket the delivery is about. */
  ticketId: string
  /** The Assignment the delivery is about. */
  assignmentId: string
  /** The review round the delivery waits for, when it waits for one. */
  reviewId?: string
  /** The kind of the report; empty for a delivery that is not a report. */
  reportKind?: string
  /** The digest of the report's own content. */
  contentDigest?: string
  /** The Session that made the report. */
  sourceSessionId: string
  /** The Session the delivery is delivered to. */
  targetSessionId: string
  /** What the target Session is for. */
  targetRole: SessionRole
  /** The node the delivery is made to. */
  nodeId: string
  /** The backend the delivery is made to. */
  backendId: string
  /** The lifecycle generation of the target when the delivery was enqueued. */
  expectedAssignmentEpoch: number
  /** The credential version of the target when the delivery was enqueued. */
  expectedToolTokenVersion: number
  /** The node trust the delivery was made under. */
  expectedNodeTrustEpoch: number
  /** The lifecycle generation of the Assignment the delivery is about. */
  sourceAssignmentEpoch?: number
  /** When a held-back delivery may go out; empty when it may go out at once. */
  dueAt?: string
  /** The body of the delivery, as an isolated reference. */
  payload: string
  /** The owning record of this delivery, in the words of its own kind. */
  context: DeliveryContext
  /** How long the message stays worth delivering, in milliseconds; empty means it never runs out. */
  ttlMs?: number
}

/**
 * What one kind of coordination knows about its own deliveries.
 *
 * The outbox owns the record and the recovery; the kind owns the authority. The two questions a recovery asks are asked
 * here: may this delivery still go out, and what exactly would it say?
 */
export interface DeliveryKindHandler {
  /** What kind of coordination this handler owns. */
  readonly kind: CoordinationDeliveryKind
  /**
   * Re-read the authority of one delivery, right now.
   *
   * The answer is a fact about the records of this control plane, never about the text of a message: a Session that was
   * revoked, stopped or replaced, a Ticket that ended, a Project that was paused or archived, a subscription whose lease
   * ran out, a report that was superseded.
   */
  revalidate(row: CoordinationDeliveryRow): DeliveryRevalidation
  /**
   * Rebuild the message of one delivery, for a delivery that is sent again.
   *
   * The message is rebuilt from the owning record, so a replay carries the same words the first attempt carried. It is
   * `undefined` when the message may not be rebuilt — the owning record is gone, or the facts it was built from are not
   * there any more — and the delivery is then closed instead of being sent with something else.
   */
  payloadOf(row: CoordinationDeliveryRow): string | undefined
}

/**
 * The authoritative reads and the writes the outbox needs.
 *
 * The outbox owns no state of its own beyond its own table: it reads the control plane's records through these calls and
 * writes its rows itself.
 */
export interface DeliveryOutboxHost {
  /** The current time, as the control plane's own clock reads it. */
  now(): string
  /** The node this control plane talks to. */
  nodeId(): string
  /** The backend that runs the Sessions of this node. */
  backendId(): string
  /**
   * Deliver one message to a Session under the node's own idempotency key.
   *
   * The call throws when the message did not go out. A {@link NodeUnconfirmedError} means the request may have been
   * carried out and its receipt is missing; any other error means the node refused it or it never left this control
   * plane.
   *
   * The two checks are the same check at two moments: one runs before the target is even ensured and the other runs
   * immediately before the transport. The ensure takes time, and the life the delivery was planned for may end while it
   * is on its way, so a target that was stopped, revoked or replaced in the meantime is never re-ensured and never
   * reached.
   *
   * `kind` is the kind of coordination this delivery is. It is the fact the transport needs: the two sealed kinds go out
   * exactly as they are, and the others may carry the bounded reference material beside their words.
   */
  deliver(sessionId: string, text: string, idempotencyKey: string, validateForSend?: () => void,
    validateBeforeEnsure?: () => void, kind?: CoordinationDeliveryKind): Promise<void>
  /**
   * Ask the node what it can prove about one delivery.
   *
   * The question names the Session and the exact key. A node that cannot answer says `unknown`; it never says `absent`
   * because it does not remember.
   */
  evidence(sessionId: string, deliveryKey: string): Promise<DeliveryEvidence>
  /** Whether this node can be asked at all; a node that cannot is answered `unknown`. */
  evidenceSupported(): boolean
}

/**
 * The statuses that hold a delivery's identity open.
 *
 * While a delivery is in one of them, the same work may not be planned again: the superior either knows it, is about to
 * know it, or may already have it without a receipt. The durable uniqueness of the table enforces the same rule, so a
 * restart cannot lose it.
 */
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'accepted_pending', 'dispatching', 'delivered_inbox', 'consumed_turn', 'unconfirmed', 'rejected_stale_or_revoked',
])

/**
 * The statuses a delivery may be planned again from.
 *
 * They are the ones a delivery never left its superior in: it failed for good, its target was resting, the node could
 * not be reached on, a newer report took its place, or it waits for the Project to be resumed. The unique index of the
 * table is written over the complement of this set, so two open deliveries of one report cannot exist.
 */
const REOPENABLE_STATUSES: readonly string[] = ['failed_permanent', 'blocked_target_inactive', 'blocked_node_unavailable',
  'superseded', 'deferred_for_resume']

/** The statuses a delivery may be planned again from, as the table's own SQL spells them. */
function reopenableStatuses(): string {
  return REOPENABLE_STATUSES.map(status => `'${status}'`).join(',')
}

/**
 * The statuses that say the message of a delivery never left this control plane.
 *
 * A delivery in one of them is carried out again without asking the node anything: the record itself is the proof that
 * the message was never on its way. A delivery that was already attempted may only reach one of them when the message
 * is proven to be absent — by the node, or by the check that runs immediately before the transport, which proves that
 * the message never left.
 */
const UNSENT_STATUSES: ReadonlySet<string> = new Set(['accepted_pending', 'deferred_for_resume'])

/**
 * How long a message stays worth delivering, when nothing else says.
 *
 * A week is long enough that a Project an operator paused keeps the report it was waiting with, and short enough that a
 * message from months ago is not resurrected by a restart. The message life is its own: it does not follow the
 * authorization, and the authorization does not follow it.
 */
export const DEFAULT_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The table of the outbox's own records. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS coordination_deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  report_kind TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  target_role TEXT NOT NULL,
  node_id TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  expected_assignment_epoch INTEGER NOT NULL,
  expected_tool_token_version INTEGER NOT NULL,
  expected_node_trust_epoch INTEGER NOT NULL,
  source_assignment_epoch INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  dispatched_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  error TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  resend_count INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS coordination_deliveries_status ON coordination_deliveries(status, seq);
CREATE INDEX IF NOT EXISTS coordination_deliveries_target ON coordination_deliveries(target_session_id, assignment_id, seq);
`

/**
 * The index that holds one delivery per work.
 *
 * It covers the rows that are still open — the ones the superior knows, is about to know, or may already have without a
 * receipt — so an identical delivery cannot be made twice. It is written after the table has been brought to its
 * current shape, because a file that predates it may still hold rows the index would refuse.
 */
const DEDUP_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS coordination_deliveries_dedup_live
  ON coordination_deliveries(dedup_key) WHERE status NOT IN (${reopenableStatuses()});
`

/**
 * The durable outbox of the coordination deliveries.
 *
 * It owns the table, the vocabulary of the states and the recovery. Everything else — what a report says, which PM has
 * to hear it, which Project may be woken — belongs to the kind that owns the work, and the outbox asks it before it acts.
 */
export class DeliveryOutbox {
  /** The handlers of the kinds this control plane knows, by kind. */
  private readonly handlers = new Map<CoordinationDeliveryKind, DeliveryKindHandler>()
  /** Whether the outbox was closed; nothing is written after that. */
  private closed = false

  constructor(private readonly store: Store, private readonly host: DeliveryOutboxHost) {
    // The outbox's own table lives in the control plane's own file. It is created here, idempotently, so the domain's own
    // schema stays what it always was and an older plugin binary never opens this table.
    this.store.db.exec(SCHEMA)
    this.migrate()
  }

  /**
   * Register the handler of one kind.
   *
   * A kind without a handler is a kind this control plane cannot recover: its deliveries are closed when the recovery
   * meets them, rather than being sent on a guess.
   */
  register(handler: DeliveryKindHandler): void {
    this.handlers.set(handler.kind, handler)
  }

  /** The handler of one kind, when there is one. */
  handlerOf(kind: CoordinationDeliveryKind): DeliveryKindHandler | undefined {
    return this.handlers.get(kind)
  }

  /** The deliveries the outbox holds, newest last. */
  rows(limit = 50): CoordinationDeliveryRow[] {
    const rows = this.store.db.prepare(
      'SELECT * FROM coordination_deliveries ORDER BY seq DESC LIMIT ?').all(Math.max(1, Math.min(limit, 500)))
    return rows.map(row => this.rowOf(row as Record<string, unknown>))
  }

  /**
   * The deliveries as the console reads them.
   *
   * The view carries the facts of the delivery and never the body of the message: the stored message is the lower-trust
   * text of a Worker, a PM or an external observation, and a console that shows it would show untrusted text as if it
   * were the control plane's own.
   */
  views(limit = 50): CoordinationDeliveryView[] {
    return this.rows(limit).map(row => ({
      deliveryId: row.deliveryId,
      kind: row.kind,
      at: row.at,
      status: row.status,
      reportKind: row.reportKind,
      projectId: row.projectId,
      ticketId: row.ticketId,
      assignmentId: row.assignmentId,
      reviewId: row.reviewId,
      sourceSessionId: row.sourceSessionId,
      targetSessionId: row.targetSessionId,
      targetRole: row.targetRole,
      nodeId: row.nodeId,
      backendId: row.backendId,
      attemptCount: row.attemptCount,
      expectedAssignmentEpoch: row.expectedAssignmentEpoch,
      expectedToolTokenVersion: row.expectedToolTokenVersion,
      expectedNodeTrustEpoch: row.expectedNodeTrustEpoch,
      sourceAssignmentEpoch: row.sourceAssignmentEpoch,
      dueAt: row.dueAt,
      dispatchedAt: row.dispatchedAt,
      error: row.error,
      expiresAt: row.expiresAt,
      resendCount: row.resendCount,
      evidence: row.evidence,
    }))
  }

  /** The delivery of one id, when the outbox holds it. */
  row(deliveryId: string): CoordinationDeliveryRow | undefined {
    const row = this.store.db.prepare('SELECT * FROM coordination_deliveries WHERE delivery_id = ?').get(deliveryId)
    return row === undefined ? undefined : this.rowOf(row as Record<string, unknown>)
  }

  /**
   * The newest delivery the node knows under one key.
   *
   * The key is the node's own name for the delivery, so this is how a kind finds the delivery of its own work after a
   * restart: the work names its key, and the outbox answers with the record that carries it.
   */
  byIdempotencyKey(idempotencyKey: string): CoordinationDeliveryRow | undefined {
    const row = this.store.db.prepare(
      'SELECT * FROM coordination_deliveries WHERE idempotency_key = ? ORDER BY seq DESC LIMIT 1').get(idempotencyKey)
    return row === undefined ? undefined : this.rowOf(row as Record<string, unknown>)
  }

  /** One row of the table, as the outbox reads it. */
  readRow(row: Record<string, unknown>): CoordinationDeliveryRow {
    return this.rowOf(row)
  }

  /**
   * Accept one delivery: it is written down before anything goes out.
   *
   * The work that is being delivered is one work, so one open record is enough for it: a delivery that is already open
   * under the same key is returned as it is, and a second record is never written for it. The record is written in the
   * control plane's own transaction, so a work that was accepted always has its delivery and a delivery always names
   * the work it carries.
   */
  accept(input: DeliveryAcceptance): CoordinationDeliveryRow {
    const open = this.liveRowOf(input.dedupKey)
    if (open !== undefined) return open
    const deliveryId = newDeliveryId()
    const row: CoordinationDeliveryRow = {
      deliveryId,
      kind: input.kind,
      at: this.host.now(),
      status: 'accepted_pending',
      idempotencyKey: input.idempotencyKey,
      dedupKey: input.dedupKey,
      scope: input.scope,
      projectId: input.projectId,
      ticketId: input.ticketId,
      assignmentId: input.assignmentId,
      reviewId: input.reviewId ?? '',
      reportKind: input.reportKind ?? '',
      contentDigest: input.contentDigest ?? '',
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      targetRole: input.targetRole,
      nodeId: input.nodeId,
      backendId: input.backendId,
      expectedAssignmentEpoch: input.expectedAssignmentEpoch,
      expectedToolTokenVersion: input.expectedToolTokenVersion,
      expectedNodeTrustEpoch: input.expectedNodeTrustEpoch,
      sourceAssignmentEpoch: input.sourceAssignmentEpoch ?? 0,
      attemptCount: 0,
      dispatchedAt: '',
      dueAt: input.dueAt ?? '',
      payload: input.payload,
      error: '',
      context: JSON.stringify(input.context),
      expiresAt: this.expiryOf(input.ttlMs),
      resendCount: 0,
      evidence: '',
    }
    try {
      this.insert(row)
    } catch (error) {
      // The unique index of the table refused the row: another delivery of the same work is open right now, so this work
      // is one delivery and is not made twice.
      if (this.isUniqueViolation(error)) {
        const existing = this.liveRowOf(input.dedupKey)
        if (existing !== undefined) return existing
      }
      throw error
    }
    return row
  }

  /** Whether SQLite refused a write because of its unique index. */
  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  }

  /** The moment a message runs out, or the empty string when it never does. */
  private expiryOf(ttlMs: number | undefined): string {
    const ttl = ttlMs ?? DEFAULT_DELIVERY_TTL_MS
    if (!Number.isFinite(ttl) || ttl <= 0) return ''
    const now = Date.parse(this.host.now())
    if (!Number.isFinite(now)) return ''
    return new Date(now + ttl).toISOString()
  }

  /** The open delivery of one work, when there is one. */
  liveRowOf(dedupKey: string): CoordinationDeliveryRow | undefined {
    const row = this.store.db.prepare(
      'SELECT * FROM coordination_deliveries WHERE dedup_key = ? ORDER BY seq DESC LIMIT 1').get(dedupKey)
    if (row === undefined) return undefined
    const delivery = this.rowOf(row as Record<string, unknown>)
    return LIVE_STATUSES.has(delivery.status) ? delivery : undefined
  }

  /**
   * Write one delivery down.
   *
   * The row is written before anything goes on the wire, so a control plane that died in the middle leaves the fact
   * behind instead of sending the same work twice. The write is the only place a row is created, and the unique index of
   * the table refuses a second open row of the same work.
   */
  insert(row: CoordinationDeliveryRow): void {
    this.store.db.prepare(
      'INSERT INTO coordination_deliveries (delivery_id, kind, at, status, idempotency_key, dedup_key, scope, '
      + 'project_id, ticket_id, assignment_id, review_id, report_kind, content_digest, source_session_id, '
      + 'target_session_id, target_role, node_id, backend_id, expected_assignment_epoch, expected_tool_token_version, '
      + 'expected_node_trust_epoch, source_assignment_epoch, attempt_count, dispatched_at, due_at, payload, error, '
      + 'context, expires_at, resend_count, evidence) '
      + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.deliveryId, row.kind, row.at, row.status, row.idempotencyKey, row.dedupKey, row.scope,
        row.projectId, row.ticketId, row.assignmentId, row.reviewId, row.reportKind, row.contentDigest,
        row.sourceSessionId, row.targetSessionId, row.targetRole, row.nodeId, row.backendId, row.expectedAssignmentEpoch,
        row.expectedToolTokenVersion, row.expectedNodeTrustEpoch, row.sourceAssignmentEpoch, row.attemptCount,
        row.dispatchedAt, row.dueAt, row.payload, row.error, row.context, row.expiresAt, row.resendCount, row.evidence)
  }

  /**
   * Claim one delivery for the wire.
   *
   * The claim is a conditional write: only the caller whose write changed the row may send the message, so two callers
   * that read the same row never both deliver it. A delivery that is on its way or whose outcome is unknown is never
   * claimed again — except for the one controlled re-send a node's proof of absence permits, and that one is bounded by
   * the row's own resend count.
   */
  claim(deliveryId: string, from: readonly CoordinationDeliveryStatus[], resend = false): boolean {
    const guard = resend ? ' AND resend_count < 1' : ''
    const result = this.store.db.prepare(
      "UPDATE coordination_deliveries SET status = 'dispatching', attempt_count = attempt_count + 1, dispatched_at = ?, "
      + `resend_count = resend_count + ${resend ? 1 : 0} WHERE delivery_id = ? AND status IN (${from.map(status => `'${status}'`).join(',')})${guard}`)
      .run(this.host.now(), deliveryId)
    return Number(result.changes ?? 0) === 1
  }

  /**
   * Change the state of one delivery, but only from the state it was in.
   *
   * A snapshot that is stale by the time it writes changes nothing: the row has moved on, and the fact it wanted to
   * record is about a delivery that is no longer the one it read.
   */
  settle(deliveryId: string, from: CoordinationDeliveryStatus, to: CoordinationDeliveryStatus, reason: string): void {
    if (this.closed) return
    try {
      this.store.db.prepare(
        'UPDATE coordination_deliveries SET status = ?, error = ? WHERE delivery_id = ? AND status = ?')
        .run(to, redact(reason).slice(0, 300), deliveryId, from)
    } catch {
      // The database is gone: the control plane is closing, and the record it would have written no longer has a home.
    }
  }

  /** Write down what the node said about one delivery. */
  noteEvidence(deliveryId: string, evidence: string): void {
    if (this.closed) return
    try {
      this.store.db.prepare('UPDATE coordination_deliveries SET evidence = ? WHERE delivery_id = ?')
        .run(evidence.slice(0, 120), deliveryId)
    } catch {
      // A diagnostic that cannot be written is not a failed delivery.
    }
  }

  /**
   * The deliveries a restart left open.
   *
   * Two kinds of record are here, and they are handled differently. A delivery that was never sent is sent again under
   * the very key the node knows it by, after its authority was read again. A delivery that was on its way when the
   * control plane stopped is asked about: the node is the only one that knows whether the message arrived, and its
   * answer is what the record says.
   */
  async recover(): Promise<void> {
    const rows = this.store.db.prepare(
      "SELECT * FROM coordination_deliveries WHERE status IN "
      + "('accepted_pending','dispatching','deferred_for_resume') ORDER BY seq")
      .all() as Record<string, unknown>[]
    for (const raw of rows) {
      await this.recoverOne(this.rowOf(raw))
    }
  }

  /**
   * Recover the deliveries of one Project that a pause left on the wire.
   *
   * A delivery that was on its way when the Project was paused is not a report that waits for a resume: the node is the
   * only one that knows whether the message arrived, and its answer is what the record says. Only the rows the node has
   * already proven to be absent are recovered here, and only while their one re-send is unspent: a row that is still on
   * its way belongs to the delivery that owns it, and a row whose message never left is carried out by the resume
   * itself.
   *
   * The recovery of such a row is the one the restart does: the node is asked again, and the answer decides whether the
   * delivery is closed or whether the one re-send it permits goes out.
   */
  async recoverProject(projectId: string): Promise<void> {
    const rows = this.store.db.prepare(
      "SELECT * FROM coordination_deliveries WHERE project_id = ? AND status = 'dispatching' AND evidence = 'absent' "
      + "AND resend_count = 0 ORDER BY seq").all(projectId) as Record<string, unknown>[]
    for (const raw of rows) {
      await this.recoverOne(this.rowOf(raw))
    }
  }

  /**
   * Recover one delivery.
   *
   * The authority is read first: a delivery whose life is over is closed, whatever its status said. The message's own
   * life comes next: a message that ran out is closed, whatever the authority says. Only then does the state of the
   * record decide what happens.
   */
  private async recoverOne(row: CoordinationDeliveryRow): Promise<void> {
    const handler = this.handlers.get(row.kind)
    if (handler === undefined) {
      this.settle(row.deliveryId, row.status, 'rejected_stale_or_revoked',
        `this control plane knows no coordination of the kind ${row.kind}`)
      return
    }
    // The authority of the delivery is read again: the target may have been revoked, stopped, replaced or paused, and
    // the source may have moved on. A delivery whose authority is gone is closed, and it is never routed anywhere else.
    const verdict = handler.revalidate(row)
    if (!verdict.ok) {
      // A delivery that may not go out *yet* keeps its place: it is neither closed nor sent.
      if (verdict.outcome === 'held') return
      // A delivery that was already attempted may not fall back into a class that says its message never left: only the
      // node may say that, and only when it proves that the message never arrived. So the node is asked first, and its
      // answer decides what the record says.
      if (this.attempted(row) && UNSENT_STATUSES.has(verdict.status)) {
        await this.askAndSettle(row, handler)
        return
      }
      this.settle(row.deliveryId, row.status, verdict.status, verdict.reason)
      return
    }
    // The message's own life is its own: a message that ran out is stale, whatever the authority says.
    if (this.expired(row)) {
      this.settle(row.deliveryId, row.status, 'failed_permanent', 'the message ran out before it could be delivered')
      return
    }
    if (row.status === 'accepted_pending' || row.status === 'deferred_for_resume') {
      // The record says the message never left this control plane: it is sent again, under the very key the node knows
      // it by, so the node executes it at most once.
      await this.send(row, handler, false)
      return
    }
    // The record says the message was on its way. Only the node knows whether it arrived, so only the node is asked.
    await this.askAndSettle(row, handler)
  }

  /**
   * Whether the delivery was already attempted.
   *
   * A delivery that was claimed at least once may be on its way, and its message may have arrived: it may not fall back
   * into a class that says it was never sent. Only the node may say that, and only with a proof.
   */
  private attempted(row: CoordinationDeliveryRow): boolean {
    return row.attemptCount > 0 || row.resendCount > 0
  }

  /**
   * Ask the node about one delivery and settle the record by what it proves.
   *
   * The node is the only one that knows whether the message arrived, so it is asked about the exact key of the exact
   * Session. The question takes time, and the record may have moved on while it was on its way: the same fences the
   * recovery uses after its own question decide whether this answer is still about this delivery at all — the attempt
   * count, the re-send count and the moment the delivery went on its way, the identity of the delivery, and the life of
   * its message.
   *
   * The authority is read again as well: the question took time, and the life the delivery was planned for may have
   * ended or come back in the meantime. The answer is therefore settled under the life that holds now — a life that
   * holds now is no stale licence to close, and a life that has ended is no stale licence to send.
   */
  private async askAndSettle(row: CoordinationDeliveryRow, handler: DeliveryKindHandler): Promise<void> {
    const evidence = await this.askNode(row)
    const current = this.row(row.deliveryId)
    if (current === undefined || current.status !== row.status) return
    // Another recovery took the delivery while this one was asking the node: its own recovery owns it now, and this one
    // writes nothing.
    if (current.attemptCount !== row.attemptCount || current.resendCount !== row.resendCount
      || current.dispatchedAt !== row.dispatchedAt) return
    // The delivery itself is another one now: another generation of the same work, another target, another key. The
    // answer this recovery holds is about the delivery as it was, so it closes nothing and sends nothing.
    if (this.changedWhileAway(row, current)) {
      this.settle(current.deliveryId, current.status, 'unconfirmed',
        'the delivery changed while the node was asked about it, so the answer is about another delivery')
      return
    }
    // The message's own life is its own: a message that ran out is stale, whatever the authority says.
    if (this.expired(current)) {
      this.settle(current.deliveryId, current.status, 'failed_permanent', 'the message ran out before it could be delivered')
      return
    }
    // The authority is read again, right now.
    const again = handler.revalidate(current)
    if (!again.ok) {
      // A delivery that may not go out *yet* keeps its place: it is neither closed nor sent.
      if (again.outcome === 'held') return
      // The answer about the message is already in hand, and it decides what the record says: a message the node proves
      // to be absent may wait for the target to come back, one the node holds is delivered, and one nobody can prove
      // anything about stays unconfirmed — never sent again on a guess.
      if (UNSENT_STATUSES.has(again.status)) {
        this.settleByEvidence(current, evidence, again.status, again.reason)
        return
      }
      this.settle(current.deliveryId, current.status, again.status, again.reason)
      return
    }
    if (evidence.state === 'consumed_turn') {
      this.settle(current.deliveryId, current.status, 'consumed_turn', '')
      return
    }
    if (evidence.state === 'inbox') {
      this.settle(current.deliveryId, current.status, 'delivered_inbox', '')
      return
    }
    if (evidence.state === 'absent') {
      // The node proved that the message never arrived. That is the one answer that permits another attempt, and it
      // permits exactly one: the delivery is sent again under its own key, after its authority was read again.
      if (current.resendCount >= 1) {
        this.settle(current.deliveryId, current.status, 'unconfirmed',
          'the node proved it did not receive the message, but one re-send was already made')
        return
      }
      await this.send(current, handler, true)
      return
    }
    // The node could not prove anything. The outcome stays unknown, and an unknown outcome is never a licence to send
    // the message again.
    this.settle(current.deliveryId, current.status, 'unconfirmed',
      'the node could not prove whether the delivery arrived; it is not sent again')
  }

  /**
   * Settle a delivery by what the node proved about its message.
   *
   * The node's answer closes a delivery only when its message may have left — that is, only when the record says the
   * delivery was on its way. A message the node holds in the inbox is delivered, a message a turn of the target read is
   * consumed, and a message the node proves never arrived keeps its place on the wire: the one re-send it permits is
   * still owed, and a delivery whose re-send was already made is closed as unconfirmed. Everything else stays
   * unconfirmed — an unknown outcome is never a licence to send the message again.
   *
   * A delivery that was on its way does not fall back into a class that says its message never left: the ordinary path
   * would carry it out as a fresh send, and the one re-send the proof permits would be spent a second time. Such a
   * delivery keeps its place on the wire, and the recovery that owns it carries the one re-send out when the target may
   * be reached again.
   *
   * A delivery whose own record says its message never left is not waiting for an outcome at all: it keeps the place it
   * waits in, and the resume carries it out.
   */
  private settleByEvidence(row: CoordinationDeliveryRow, evidence: DeliveryEvidence, status: CoordinationDeliveryStatus,
    reason: string): void {
    if (evidence.state === 'consumed_turn') {
      this.settle(row.deliveryId, row.status, 'consumed_turn', '')
      return
    }
    if (evidence.state === 'inbox') {
      this.settle(row.deliveryId, row.status, 'delivered_inbox', '')
      return
    }
    if (evidence.state === 'absent') {
      if (row.status === 'dispatching' && this.attempted(row)) {
        // The one re-send the proof permits is spent: the delivery is closed, and it is never sent again.
        if (row.resendCount >= 1) {
          this.settle(row.deliveryId, row.status, 'unconfirmed',
            'the node proved it did not receive the message, but one re-send was already made')
          return
        }
        // The re-send is still owed. The delivery keeps its place on the wire — the recovery owns it, and it carries the
        // one re-send out when the target may be reached again.
        return
      }
      this.settle(row.deliveryId, row.status, status, reason)
      return
    }
    // The node could not prove anything. A delivery that was on its way may have arrived, so it stays unconfirmed: an
    // unknown outcome is never a licence to send the message again. A delivery whose own record says its message never
    // left is not waiting for an outcome at all — it keeps the place it waits in, and the resume carries it out.
    if (row.status !== 'dispatching') return
    this.settle(row.deliveryId, row.status, 'unconfirmed',
      'the node could not prove whether the delivery arrived; it is not sent again')
  }

  /**
   * Whether the record of one delivery became another delivery while the control plane was away from it.
   *
   * The question about a delivery took time, and the record may have moved on: another generation of the same work may
   * have taken its place, the target may have been replaced, or the key the node knows it by may have changed. An answer
   * about the delivery as it was then is an answer about another delivery, so it may neither close this one nor send it
   * again.
   */
  private changedWhileAway(before: CoordinationDeliveryRow, after: CoordinationDeliveryRow): boolean {
    return after.idempotencyKey !== before.idempotencyKey
      || after.dedupKey !== before.dedupKey
      || after.targetSessionId !== before.targetSessionId
      || after.sourceSessionId !== before.sourceSessionId
      || after.nodeId !== before.nodeId
      || after.backendId !== before.backendId
      || after.expectedAssignmentEpoch !== before.expectedAssignmentEpoch
      || after.expectedToolTokenVersion !== before.expectedToolTokenVersion
      || after.expectedNodeTrustEpoch !== before.expectedNodeTrustEpoch
      || after.sourceAssignmentEpoch !== before.sourceAssignmentEpoch
      || after.payload !== before.payload
  }

  /**
   * Ask the node about one delivery.
   *
   * The question is asked of the node the delivery was made to, about the exact key and the exact Session it was made
   * for. A node that cannot be asked, a node that is not there and a node that does not know the question all answer
   * the same way: nothing is proven, so nothing may be repeated.
   */
  private async askNode(row: CoordinationDeliveryRow): Promise<DeliveryEvidence> {
    if (row.nodeId !== this.host.nodeId() || row.backendId !== this.host.backendId()) {
      return { state: 'unknown', reason: 'the delivery was made to another node or another backend' }
    }
    if (!this.host.evidenceSupported()) {
      return { state: 'unknown', reason: 'this node cannot answer a question about a delivery' }
    }
    try {
      const answer = await this.host.evidence(row.targetSessionId, row.idempotencyKey)
      this.noteEvidence(row.deliveryId, answer.state)
      return answer
    } catch {
      return { state: 'unknown', reason: 'the node could not be asked about this delivery' }
    }
  }

  /**
   * Send one delivery, or send it again.
   *
   * The delivery is claimed before anything goes out, and the authority is read again twice: once before the target is
   * ensured and once immediately before the transport. The life the delivery was planned for must still hold at the very
   * moment the message leaves this control plane, and a target that was stopped or revoked in the meantime is never
   * brought back to be messaged.
   */
  private async send(row: CoordinationDeliveryRow, handler: DeliveryKindHandler, resend: boolean): Promise<void> {
    const payload = handler.payloadOf(row)
    if (payload === undefined) {
      this.settle(row.deliveryId, row.status, 'failed_permanent',
        'the message of this delivery may not be rebuilt, so it is not sent')
      return
    }
    const from: CoordinationDeliveryStatus[] = resend ? ['dispatching'] : ['accepted_pending', 'deferred_for_resume']
    if (!this.claim(row.deliveryId, from, resend)) {
      // Another caller took the delivery, or it is not in a state that may be sent. Either way this one sends nothing.
      return
    }
    try {
      // The same check at two moments: before the target is ensured and immediately before the transport. The ensure
      // takes time, and a target that was stopped, revoked or replaced in the meantime is never re-ensured and never
      // reached — a stopped Session is not revived by a delivery that was planned for it.
      const revalidate = (): void => {
        const verdict = handler.revalidate(row)
        if (verdict.ok) return
        // A delivery that may not go out *yet* goes back to where it waits: the message never left this control plane,
        // so it is neither a lost receipt nor a refusal.
        if (verdict.outcome === 'held') {
          throw new CoordinationDeliveryStaleError(verdict.reason, 'accepted_pending')
        }
        throw new CoordinationDeliveryStaleError(verdict.reason, verdict.status)
      }
      await this.host.deliver(row.targetSessionId, payload, row.idempotencyKey, revalidate, revalidate, row.kind)
    } catch (error) {
      if (error instanceof CoordinationDeliveryStaleError) {
        // A delivery that was refused before the wire never went out: it is skipped, not failed, and it is no lost receipt.
        // The check itself is the proof that the message never left this control plane, so the delivery may wait where it
        // waits — a class that says the message was never sent is true here, even for a delivery that was claimed before.
        if (resend) {
          // The re-send was claimed and then refused before the wire: it never left, so the one re-send the node's proof
          // of absence permits is not spent. The budget goes back to the delivery.
          this.giveBackResend(row.deliveryId, error.message)
          if (UNSENT_STATUSES.has(error.status)) {
            // The delivery may go out *yet*: it keeps its place on the wire, where the recovery finds it and carries the
            // one re-send out. It does not go back into a class that says its message never left — the ordinary path
            // would carry it out as a fresh send, and the one re-send the proof permits would be spent a second time.
            return
          }
          // The life the delivery was planned for is over: it is closed for good, and the re-send it never carried out
          // is not counted.
          this.settle(row.deliveryId, 'dispatching', error.status, error.message)
          return
        }
        this.settle(row.deliveryId, 'dispatching', error.status, error.message)
        return
      }
      if (error instanceof NodeUnconfirmedError) {
        // A missing receipt is not a refusal: the message may have arrived, so it is neither a failure nor to be repeated.
        this.settle(row.deliveryId, 'dispatching', 'unconfirmed',
          'the node did not confirm the delivery; the message may have arrived and is not sent again')
        return
      }
      const reason = redact(error instanceof Error ? error.message : String(error)).slice(0, 300)
      this.settle(row.deliveryId, 'dispatching', 'failed_permanent', reason)
      return
    }
    this.settle(row.deliveryId, 'dispatching', 'delivered_inbox', '')
  }

  /**
   * Give back the re-send a delivery claimed but never carried out.
   *
   * The re-send was claimed, and the check right before the transport refused it: that check is the proof that the
   * message never left this control plane. The one re-send the node's proof of absence permits is therefore not spent,
   * and the budget goes back to the delivery — which keeps its place, so the recovery that owns it can carry the re-send
   * out when the target may be reached again.
   */
  private giveBackResend(deliveryId: string, reason: string): void {
    if (this.closed) return
    try {
      this.store.db.prepare(
        "UPDATE coordination_deliveries SET resend_count = resend_count - 1, error = ? WHERE delivery_id = ? "
        + "AND status = 'dispatching' AND resend_count > 0").run(redact(reason).slice(0, 300), deliveryId)
    } catch {
      // The database is gone: the control plane is closing, and the record it would have written no longer has a home.
    }
  }

  /** Whether the message of this delivery ran out. */
  private expired(row: CoordinationDeliveryRow): boolean {
    if (row.expiresAt === '') return false
    const expiry = Date.parse(row.expiresAt)
    const now = Date.parse(this.host.now())
    if (!Number.isFinite(expiry) || !Number.isFinite(now)) return false
    return now >= expiry
  }

  /** Stop writing; nothing is written after that. */
  close(): void {
    this.closed = true
  }

  /**
   * Bring a table of an earlier shape to the shape this outbox expects.
   *
   * The table is the control plane's own, and it only exists where this coordination has run before: a file that predates
   * a column gets it, so an upgrade keeps its records instead of losing them. The index that holds one delivery per work
   * is written last, because a file that predates it may hold rows the index would refuse: the older of two open
   * deliveries of the same work is closed first, and the newest one stays.
   */
  private migrate(): void {
    const columns = this.store.db.prepare('PRAGMA table_info(coordination_deliveries)').all() as Record<string, unknown>[]
    if (columns.length === 0) {
      this.store.db.exec(DEDUP_INDEX)
      return
    }
    const known = new Set(columns.map(column => String(column.name ?? '')))
    const wanted: Record<string, string> = {
      scope: "TEXT NOT NULL DEFAULT ''",
      source_assignment_epoch: 'INTEGER NOT NULL DEFAULT 0',
      dispatched_at: "TEXT NOT NULL DEFAULT ''",
      context: "TEXT NOT NULL DEFAULT ''",
      expires_at: "TEXT NOT NULL DEFAULT ''",
      resend_count: 'INTEGER NOT NULL DEFAULT 0',
      evidence: "TEXT NOT NULL DEFAULT ''",
    }
    for (const [name, definition] of Object.entries(wanted)) {
      if (known.has(name)) continue
      this.store.db.exec(`ALTER TABLE coordination_deliveries ADD COLUMN ${name} ${definition}`)
    }
    // The old table kept an index over every row; the live one is unique over the rows that are still open.
    this.store.db.exec('DROP INDEX IF EXISTS coordination_deliveries_dedup')
    this.closeDuplicateDeliveries()
    // The live index is written again: the set of rows that are still open grew, and an index that still knows the old
    // one would refuse a report that waits for a resume.
    this.store.db.exec('DROP INDEX IF EXISTS coordination_deliveries_dedup_live')
    this.store.db.exec(DEDUP_INDEX)
  }

  /**
   * Close the older of two deliveries that are open under the same work.
   *
   * A file that predates the unique index may hold two such rows. The newest one keeps the work's identity; the older one
   * is closed as superseded, so its record is still there and the index can be written.
   */
  private closeDuplicateDeliveries(): void {
    const rows = this.store.db.prepare(
      "SELECT seq, dedup_key FROM coordination_deliveries WHERE status NOT IN "
      + `(${reopenableStatuses()}) ORDER BY seq DESC`)
      .all() as Record<string, unknown>[]
    const seen = new Set<string>()
    for (const row of rows) {
      const key = String(row.dedup_key ?? '')
      if (!seen.has(key)) {
        seen.add(key)
        continue
      }
      this.store.db.prepare(
        "UPDATE coordination_deliveries SET status = 'superseded', error = ? WHERE seq = ?")
        .run('a newer delivery of the same work took its place', Number(row.seq ?? 0))
    }
  }

  /** One row of the table, as the outbox reads it. */
  private rowOf(row: Record<string, unknown>): CoordinationDeliveryRow {
    const text = (name: string): string => {
      const value = row[name]
      return value === null || value === undefined ? '' : String(value)
    }
    const number = (name: string): number => {
      const value = row[name]
      return typeof value === 'number' ? value : Number(value ?? 0)
    }
    return {
      deliveryId: text('delivery_id'),
      kind: text('kind') as CoordinationDeliveryKind,
      at: text('at'),
      status: text('status') as CoordinationDeliveryStatus,
      idempotencyKey: text('idempotency_key'),
      dedupKey: text('dedup_key'),
      scope: text('scope'),
      projectId: text('project_id'),
      ticketId: text('ticket_id'),
      assignmentId: text('assignment_id'),
      reviewId: text('review_id'),
      reportKind: text('report_kind'),
      contentDigest: text('content_digest'),
      sourceSessionId: text('source_session_id'),
      targetSessionId: text('target_session_id'),
      targetRole: text('target_role') as SessionRole,
      nodeId: text('node_id'),
      backendId: text('backend_id'),
      expectedAssignmentEpoch: number('expected_assignment_epoch'),
      expectedToolTokenVersion: number('expected_tool_token_version'),
      expectedNodeTrustEpoch: number('expected_node_trust_epoch'),
      sourceAssignmentEpoch: number('source_assignment_epoch'),
      attemptCount: number('attempt_count'),
      dispatchedAt: text('dispatched_at'),
      dueAt: text('due_at'),
      payload: text('payload'),
      error: text('error'),
      context: text('context'),
      expiresAt: text('expires_at'),
      resendCount: number('resend_count'),
      evidence: text('evidence'),
    }
  }
}

/**
 * The id of one delivery.
 *
 * It is unique and never derived from the content: the same work may be delivered twice when the earlier attempt did not
 * reach its superior, and the two deliveries must stay apart.
 */
export function newDeliveryId(): string {
  return `coordination-${randomUUID()}`
}

/**
 * The context of one delivery, as the table holds it.
 *
 * The context is typed data: a recovery reads it and knows which record owns the delivery. A context that cannot be read
 * back is `undefined`, and a delivery whose context cannot be read is closed rather than sent on a guess.
 */
export function readContext(raw: string): DeliveryContext | undefined {
  if (raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const value = parsed as Record<string, unknown>
  switch (value.kind) {
    case 'auto_handoff':
      return typeof value.requestId === 'string' && typeof value.projectId === 'string'
        ? { kind: 'auto_handoff', requestId: value.requestId, projectId: value.projectId,
          handoffKind: value.handoffKind === 'brief' ? 'brief' : 'handoff' }
        : undefined
    case 'worker_report':
      return typeof value.ticketId === 'string' && typeof value.assignmentId === 'string'
        ? { kind: 'worker_report', ticketId: value.ticketId, assignmentId: value.assignmentId,
          reportKind: typeof value.reportKind === 'string' ? value.reportKind : '',
          reviewId: typeof value.reviewId === 'string' ? value.reviewId : '' }
        : undefined
    case 'pm_report':
      return typeof value.projectId === 'string' ? { kind: 'pm_report', projectId: value.projectId } : undefined
    case 'stream_digest':
      return typeof value.subscriptionId === 'string' && typeof value.fromSeq === 'number' && typeof value.toSeq === 'number'
        ? { kind: 'stream_digest', subscriptionId: value.subscriptionId, fromSeq: value.fromSeq, toSeq: value.toSeq }
        : undefined
    case 'denial_review':
      return typeof value.noticeId === 'string'
        ? { kind: 'denial_review', noticeId: value.noticeId, scopeKey: typeof value.scopeKey === 'string' ? value.scopeKey : '' }
        : undefined
    case 'external_wakeup':
      // The revision is the rule the wake-up was planned under. A context that does not carry it — one of an older
      // shape, or one that was only partly written — may not authorize a dispatch, so it is not a wake-up at all.
      return typeof value.subscriptionId === 'string' && typeof value.sourceId === 'string' && typeof value.eventId === 'string'
        && typeof value.revision === 'number' && Number.isInteger(value.revision) && value.revision >= 1
        ? { kind: 'external_wakeup', subscriptionId: value.subscriptionId, sourceId: value.sourceId,
          eventId: value.eventId, revision: value.revision }
        : undefined
    default:
      return undefined
  }
}
