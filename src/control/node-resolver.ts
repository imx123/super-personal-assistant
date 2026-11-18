// Shared execution target contract for next and feat/multi-node.
import type { ProjectProfile, Ticket } from '../core/index.ts'
import { NODE_CAPABILITY_TURN_INTERRUPT, type NodeStatus, type SessionRecord, type SessionRole } from '../shared/protocol.ts'

export interface ExecutionTargetBinding {
  readonly nodeId: string;
  readonly backendId: string;
  readonly logicalWorkspaceKey?: string;
}

export interface ThreeLayerGeneration {
  readonly nodeTrustEpoch: number;      // 节点注册/重连信任代际
  readonly assignmentEpoch: number;     // Assignment 或受管 Session 生命周期代际
  readonly toolTokenVersion: number;    // 工具令牌版本
}

export interface NodeLiveSnapshot {
  readonly nodeId: string;
  readonly displayName?: string;
  readonly isPrimary: boolean;
  readonly connectionStatus: 'online' | 'offline' | 'reconnecting';
  readonly lastSeenAt?: string;
  readonly backends: ReadonlyArray<{
    readonly backendId: string;
    readonly kind: string;
    readonly available: boolean;
    readonly capabilities: {
      readonly turnInterrupt: boolean;
      readonly twoStageReceipt: boolean;
      readonly sessionResume: boolean;
      readonly gitReviewDiff: boolean;
    };
  }>;
}

export type NodeResolutionErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'NODE_OFFLINE'
  | 'BACKEND_UNAVAILABLE'
  | 'OWNERSHIP_MISMATCH'
  | 'STALE_GENERATION'
  | 'PERMISSION_REVOKED'
  | 'MANUALLY_STOPPED';

export type NodeResolutionResult<T> =
  | { readonly ok: true; readonly handle: T; readonly generation: ThreeLayerGeneration }
  | { readonly ok: false; readonly code: NodeResolutionErrorCode; readonly reason: string; readonly nodeId?: string };

export interface NodeResolver<THandle = unknown> {
  resolveForSession(
    controlSessionId: string,
    op: 'ensure' | 'message' | 'interrupt' | 'stop' | 'resume' | 'reconcile'
  ): Promise<NodeResolutionResult<THandle>>;
  resolveForAssignment(
    ticketId: string,
    assignmentId: string,
    op: 'dispatch' | 'message' | 'stop' | 'verify_callback'
  ): Promise<NodeResolutionResult<THandle>>;
  getLiveNodeSnapshots(): ReadonlyArray<NodeLiveSnapshot>;
}

/**
 * The bound target one resolution hands back.
 *
 * It names the Session the control plane already holds and the node and backend it is bound to. It carries no authority
 * of its own: the authority is what the resolver checked when it resolved the target, and the caller re-reads it before
 * it acts.
 */
export interface ResolvedTarget {
  /** The control-plane Session id the target is. */
  readonly sessionId: string;
  /** What the Session is for. */
  readonly role: SessionRole;
  /** The Project the Session belongs to; a standalone Worker's is its own Ticket id. */
  readonly projectId: string;
  /** The Assignment the Session runs; absent for a PM, the Router or a scout. */
  readonly assignmentId?: string;
  /** The Ticket that owns the Assignment; absent when the Session runs no domain work. */
  readonly ticketId?: string;
  /** The node and backend the target is bound to. */
  readonly binding: ExecutionTargetBinding;
}

/**
 * The authoritative reads the single-node resolver needs.
 *
 * The resolver owns no state of its own: it reads the control plane's own records and answers from them, so a target is
 * never guessed and never falls back to a default.
 */
export interface NodeResolverHost {
  /** The node this control plane talks to. */
  readonly nodeId: string;
  /** The backend that runs the Sessions of this node. */
  readonly backendId: string;
  /** The Session record, when the control plane holds one. */
  session(sessionId: string): SessionRecord | undefined;
  /** The node's own status, when it registered. */
  nodeStatus(): NodeStatus | undefined;
  /** The Ticket by its own id. */
  ticket(ticketId: string): Ticket | undefined;
  /** The Ticket that owns an Assignment. */
  ticketOfAssignment(assignmentId: string): Ticket | undefined;
  /** The Project by its own id. */
  project(projectId: string): ProjectProfile | undefined;
  /** The Session id of the Router, the one Session that belongs to no Project. */
  routerSessionId(): string;
  /** The trust generation of the node: it changes when the node's registration or its continuity changed. */
  nodeTrustEpoch(): number;
  /** The lifecycle generation of a managed Session (a PM or the Router). */
  sessionLifecycleEpoch(sessionId: string): number;
}

/**
 * The operations that may still act on a Session an operator stopped.
 *
 * A stop, the explicit resume that undoes it, and the reconciliation that cleans up after it are the operator's own
 * paths: they may reach a stopped Session. Everything else — a message, an interrupt, an ensure — may not, so a stopped
 * Session is never brought back by a report, a wake-up or a retry.
 */
const EXPLICIT_LIFECYCLE_OPS: ReadonlySet<string> = new Set(['stop', 'resume', 'reconcile'])

/**
 * The operation that the node's liveness may not refuse.
 *
 * A tool callback is an inbound fact: the Worker that made it already reached this control plane, and the callback is
 * checked against the Session, the Assignment and the credential that made it. The flag that says the node is offline is
 * a fact about the other direction — a command that leaves this control plane — and it may not refuse a report that has
 * already arrived. Everything else stays: a Session of another node, another backend, a revoked one, a replaced
 * Assignment and a stale generation are refused as they always were.
 */
const INBOUND_CALLBACK_OPS: ReadonlySet<string> = new Set(['verify_callback'])

/**
 * The operations that need an authoritative binding of the Assignment they act on.
 *
 * A dispatch creates the Worker of an Assignment and a report speaks for it: both say something about domain work, so
 * both need the Ticket that owns that Assignment to be found. The other operations act on a Session that is already
 * there, and the older protocol tests name Assignments the domain never had; those keep working, but only for the
 * operations that do not claim anything about the work itself.
 */
const BOUND_WORK_OPS: ReadonlySet<string> = new Set(['dispatch', 'verify_callback'])

/**
 * The lifecycle generation of one Assignment of one Ticket.
 *
 * It counts the Assignments the Ticket has had, so a Ticket whose Worker was replaced names a different generation: a
 * command, a report or a retry that was meant for the previous Worker is stale, and the node never sees it. The rule
 * lives here alone, so the resolver and the coordination cannot drift apart.
 */
export function assignmentEpochOf(ticket: Ticket, assignmentId: string): number {
  const index = ticket.assignments.findIndex(item => item.id === assignmentId)
  return index < 0 ? 0 : index + 1
}

/**
 * The single-node resolver: the one existing DSH node, resolved from the control plane's own records.
 *
 * Every path that reaches a node goes through it, so the answers about ownership, revocation, operator stops, the
 * lifecycle of an Assignment and the availability of the node are read from one place. It never falls back to a default
 * target: a target that cannot be resolved is refused with the reason it cannot be reached.
 */
export class SingleNodeResolver implements NodeResolver<ResolvedTarget> {
  constructor(private readonly host: NodeResolverHost) {}

  async resolveForSession(controlSessionId: string,
    op: 'ensure' | 'message' | 'interrupt' | 'stop' | 'resume' | 'reconcile'): Promise<NodeResolutionResult<ResolvedTarget>> {
    return this.resolveSession(controlSessionId, op)
  }

  async resolveForAssignment(ticketId: string, assignmentId: string,
    op: 'dispatch' | 'message' | 'stop' | 'verify_callback'): Promise<NodeResolutionResult<ResolvedTarget>> {
    return this.resolveAssignment(ticketId, assignmentId, op)
  }

  /**
   * Resolve one control Session, without waiting for anybody.
   *
   * The single node's own records are the only thing this reads, so there is nothing to wait for. A path that has to
   * decide inside a transaction — the tool callback that writes a report — uses this, and the asynchronous entry points
   * above are the same answer for the paths that may wait.
   */
  resolveSessionNow(controlSessionId: string,
    op: 'ensure' | 'message' | 'interrupt' | 'stop' | 'resume' | 'reconcile'): NodeResolutionResult<ResolvedTarget> {
    return this.resolveSession(controlSessionId, op)
  }

  /**
   * Resolve one Assignment of one Ticket, without waiting for anybody.
   *
   * The tool callback that writes a report uses this: the Assignment, its owner and its lifecycle are read at the moment
   * of the call, and the report is written only when they still hold.
   */
  resolveAssignmentNow(ticketId: string, assignmentId: string,
    op: 'dispatch' | 'message' | 'stop' | 'verify_callback'): NodeResolutionResult<ResolvedTarget> {
    return this.resolveAssignment(ticketId, assignmentId, op)
  }

  /** The one node of this control plane, as the live snapshot reads it. */
  getLiveNodeSnapshots(): ReadonlyArray<NodeLiveSnapshot> {
    const status = this.host.nodeStatus()
    const capabilities = status?.capabilities ?? []
    return [{
      nodeId: this.host.nodeId,
      isPrimary: true,
      connectionStatus: status === undefined ? 'reconnecting' : status.online ? 'online' : 'offline',
      ...(status?.at === undefined ? {} : { lastSeenAt: status.at }),
      backends: [{
        backendId: this.host.backendId,
        kind: this.host.backendId,
        available: status?.online !== false,
        capabilities: {
          turnInterrupt: capabilities.includes(NODE_CAPABILITY_TURN_INTERRUPT),
          // The node protocol has no two-stage receipt yet: a message is known to be in the inbox, never known to have
          // been read by a turn.
          twoStageReceipt: false,
          sessionResume: true,
          gitReviewDiff: true,
        },
      }],
    }]
  }

  /** Resolve one control Session, with the operation that wants to act on it. */
  private resolveSession(sessionId: string, op: string): NodeResolutionResult<ResolvedTarget> {
    const record = this.host.session(sessionId)
    if (record === undefined) {
      return this.refuse('TARGET_NOT_FOUND', `There is no Session ${sessionId}`)
    }
    // A Session belongs to one node: a record that names another node is not this control plane's Session, and a target
    // reached from here would be the wrong machine's.
    const foreign = this.foreignBinding(record)
    if (foreign !== undefined) return this.refuse('OWNERSHIP_MISMATCH', foreign, record.nodeId)
    // The operator's own paths reach a Session whose life is over: a stop cleans up after a revoked, an ended or a
    // stopped Session, and an explicit resume brings a stopped one back. Nothing else does.
    const explicit = EXPLICIT_LIFECYCLE_OPS.has(op)
    // A revoked Session keeps its record and its history, but it has no authority any more.
    if (record.revokedAt && !explicit) {
      return this.refuse('PERMISSION_REVOKED', `The Session ${sessionId} was revoked`, record.nodeId)
    }
    // An operator's stop holds until a person resumes the Session: only the operator's own paths may reach it.
    if (record.operatorStop !== undefined && !explicit) {
      return this.refuse('MANUALLY_STOPPED', `The Session ${sessionId} was stopped by an operator`, record.nodeId)
    }
    // A command for an offline node never leaves this control plane. The operator's own paths still go out: a stop the
    // node cannot take is reported as unconfirmed, not as a refusal.
    if (!explicit && this.host.nodeStatus()?.online === false) {
      return this.refuse('NODE_OFFLINE', `The node ${this.host.nodeId} is offline`, record.nodeId)
    }
    // A Session whose lifecycle is over is no target for a message or an interrupt.
    if ((record.status === 'stopped' || record.status === 'archived') && (op === 'message' || op === 'interrupt')) {
      return this.refuse('TARGET_NOT_FOUND', `The Session ${sessionId} is ${record.status}`, record.nodeId)
    }
    if (record.role === 'worker') {
      return this.resolveWorker(record, op)
    }
    if (record.role === 'pm') {
      const project = this.host.project(record.projectId)
      if (project === undefined) {
        return this.refuse('TARGET_NOT_FOUND', `The Project ${record.projectId} does not exist`, record.nodeId)
      }
      if (project.pmSessionId !== record.sessionId) {
        return this.refuse('OWNERSHIP_MISMATCH',
          `The Session ${sessionId} is not the PM of the Project ${project.id}`, record.nodeId)
      }
      if (!explicit && (project.status === 'ended' || project.status === 'archived')) {
        return this.refuse('TARGET_NOT_FOUND', `The Project ${project.id} is ${project.status}`, record.nodeId)
      }
      // A hard pause stopped the Workers of the Project: the PM may not be woken behind a person's back.
      if (!explicit && project.status === 'paused' && project.pauseMode === 'hard') {
        return this.refuse('MANUALLY_STOPPED', `The Project ${project.id} is hard paused`, record.nodeId)
      }
      return this.accept(record, undefined, this.host.sessionLifecycleEpoch(record.sessionId))
    }
    if (record.role === 'router' && record.sessionId !== this.host.routerSessionId()) {
      return this.refuse('OWNERSHIP_MISMATCH', `The Session ${sessionId} is not the Router of this control plane`,
        record.nodeId)
    }
    return this.accept(record, undefined, this.host.sessionLifecycleEpoch(record.sessionId))
  }

  /** Resolve one Assignment of one Ticket, with the operation that wants to act on it. */
  private resolveAssignment(ticketId: string, assignmentId: string, op: string): NodeResolutionResult<ResolvedTarget> {
    const ticket = this.host.ticket(ticketId)
    if (ticket === undefined) {
      return this.refuse('TARGET_NOT_FOUND', `There is no Ticket ${ticketId}`)
    }
    const owned = this.host.ticketOfAssignment(assignmentId)
    if (owned === undefined || owned.id !== ticketId) {
      return this.refuse('OWNERSHIP_MISMATCH', `The Assignment ${assignmentId} does not belong to the Ticket ${ticketId}`)
    }
    const explicit = EXPLICIT_LIFECYCLE_OPS.has(op)
    // The operator's own paths reach a Worker whose work is over: a stop cleans up after an ended or a replaced
    // Assignment, and nothing else does.
    const refused = this.workerRefusal(ticket, assignmentId)
    if (refused !== undefined && !explicit) return this.refuse(refused.code, refused.reason)
    const sessionId = `worker-${assignmentId}`
    const record = this.host.session(sessionId)
    if (record === undefined) {
      // A dispatch creates the Worker Session; it does not need one yet. Every other operation acts on a Session that
      // has to be there.
      if (op !== 'dispatch') {
        return this.refuse('TARGET_NOT_FOUND', `There is no Worker Session ${sessionId}`)
      }
      if (this.host.nodeStatus()?.online === false) {
        return this.refuse('NODE_OFFLINE', `The node ${this.host.nodeId} is offline`)
      }
      return this.acceptAssignment(ticket, assignmentId, sessionId)
    }
    if (record.assignmentId !== assignmentId) {
      return this.refuse('OWNERSHIP_MISMATCH', `The Session ${sessionId} does not run the Assignment ${assignmentId}`,
        record.nodeId)
    }
    const foreign = this.foreignBinding(record)
    if (foreign !== undefined) return this.refuse('OWNERSHIP_MISMATCH', foreign, record.nodeId)
    if (record.revokedAt && !explicit) {
      return this.refuse('PERMISSION_REVOKED', `The Session ${sessionId} was revoked`, record.nodeId)
    }
    if (record.operatorStop !== undefined && !explicit) {
      return this.refuse('MANUALLY_STOPPED', `The Session ${sessionId} was stopped by an operator`, record.nodeId)
    }
    // A command for an offline node never leaves this control plane. The callback of a Worker is not such a command: it
    // has already arrived, so the liveness of the other direction may not refuse it.
    if (!explicit && !INBOUND_CALLBACK_OPS.has(op) && this.host.nodeStatus()?.online === false) {
      return this.refuse('NODE_OFFLINE', `The node ${this.host.nodeId} is offline`, record.nodeId)
    }
    return this.accept(record, ticket, this.assignmentEpoch(ticket, assignmentId))
  }

  /**
   * Resolve a Worker Session that runs an Assignment.
   *
   * An Assignment no Ticket owns has no authoritative binding: the domain never gave this Session that work. A dispatch
   * or a report claims something about domain work, so those are refused. The remaining operations act on the Session
   * that is there: the nominal entry point and the older protocol tests name Assignments the domain never had, and they
   * are not work that may be refused on a Ticket's account.
   */
  private resolveWorker(record: SessionRecord, op: string): NodeResolutionResult<ResolvedTarget> {
    const assignmentId = record.assignmentId
    if (assignmentId === undefined || assignmentId === '') {
      return this.refuse('TARGET_NOT_FOUND', `The Worker Session ${record.sessionId} has no Assignment`, record.nodeId)
    }
    const ticket = this.host.ticketOfAssignment(assignmentId)
    if (ticket === undefined) {
      if (BOUND_WORK_OPS.has(op)) {
        return this.refuse('OWNERSHIP_MISMATCH',
          `The Assignment ${assignmentId} belongs to no Ticket of this control plane`, record.nodeId)
      }
      return this.accept(record, undefined, 0)
    }
    const refused = this.workerRefusal(ticket, assignmentId)
    if (refused !== undefined && !EXPLICIT_LIFECYCLE_OPS.has(op)) {
      return this.refuse(refused.code, refused.reason, record.nodeId)
    }
    return this.accept(record, ticket, this.assignmentEpoch(ticket, assignmentId))
  }

  /**
   * The reason a Session does not belong to this control plane's node, when it does not.
   *
   * A record that names no node at all is a record from before the binding existed, and it is left alone: the control
   * plane owns every Session it holds. A record that names another node is a Session of another machine, and this one
   * may not act for it.
   */
  private foreignBinding(record: SessionRecord): string | undefined {
    if (record.nodeId === '' || record.nodeId === this.host.nodeId) return undefined
    return `The Session ${record.sessionId} belongs to the node ${record.nodeId}, not to ${this.host.nodeId}`
  }

  /**
   * Why the Worker of one Assignment may not act, or undefined when it may.
   *
   * The Ticket is the authority: it knows whether a person stopped the Worker, whether the Assignment ended and whether
   * that stop is still open.
   */
  private workerRefusal(ticket: Ticket, assignmentId: string): { code: NodeResolutionErrorCode; reason: string } | undefined {
    if (ticket.ended !== undefined) {
      return { code: 'TARGET_NOT_FOUND', reason: `The Ticket ${ticket.id} has ended` }
    }
    const assignments = ticket.assignments
    const index = assignments.findIndex(item => item.id === assignmentId)
    if (index < 0) {
      return { code: 'TARGET_NOT_FOUND', reason: `The Assignment ${assignmentId} does not belong to the Ticket ${ticket.id}` }
    }
    const current = assignments.at(-1)
    if (current === undefined || current.id !== assignmentId) {
      return { code: 'STALE_GENERATION',
        reason: `The Assignment ${assignmentId} was replaced by ${current?.id ?? 'another one'}` }
    }
    if (current.state === 'ended') {
      return { code: 'TARGET_NOT_FOUND', reason: `The Assignment ${assignmentId} has ended` }
    }
    if (ticket.manualStop !== undefined) {
      return { code: 'MANUALLY_STOPPED', reason: `The Ticket ${ticket.id} was stopped by an operator` }
    }
    if (ticket.stopPending?.assignmentId === assignmentId) {
      return { code: 'MANUALLY_STOPPED', reason: `The stop of Assignment ${assignmentId} is still open` }
    }
    if (ticket.stopFailure?.assignmentId === assignmentId) {
      return { code: 'MANUALLY_STOPPED', reason: `The stop of Assignment ${assignmentId} was not confirmed` }
    }
    return undefined
  }

  /**
   * The lifecycle generation of one Assignment.
   *
   * It counts the Assignments the Ticket has had, so a Ticket whose Worker was replaced names a different generation:
   * a command, a report or a retry that was meant for the previous Worker is stale, and the node never sees it.
   */
  private assignmentEpoch(ticket: Ticket, assignmentId: string): number {
    return assignmentEpochOf(ticket, assignmentId)
  }

  /** The resolved target and the generations it was read under. */
  private accept(record: SessionRecord, ticket: Ticket | undefined, epoch: number): NodeResolutionResult<ResolvedTarget> {
    const handle: ResolvedTarget = {
      sessionId: record.sessionId,
      role: record.role,
      projectId: record.projectId,
      ...(record.assignmentId === undefined ? {} : { assignmentId: record.assignmentId }),
      ...(ticket === undefined ? {} : { ticketId: ticket.id }),
      binding: {
        nodeId: this.host.nodeId,
        backendId: this.host.backendId,
        logicalWorkspaceKey: record.projectId,
      },
    }
    return {
      ok: true,
      handle,
      generation: {
        nodeTrustEpoch: this.host.nodeTrustEpoch(),
        assignmentEpoch: epoch,
        // The credential generation is its own thing: a refresh replaces the credential and nothing else.
        toolTokenVersion: record.tokenVersion ?? 0,
      },
    }
  }

  /** The refusal of one target, with the node it belongs to when it is known. */
  private refuse(code: NodeResolutionErrorCode, reason: string, nodeId?: string): NodeResolutionResult<ResolvedTarget> {
    return { ok: false, code, reason, ...(nodeId === undefined ? {} : { nodeId }) }
  }

  /**
   * The resolved target of an Assignment whose Worker Session does not exist yet.
   *
   * A dispatch is the one operation that creates the Session, so the target is named by the Assignment it belongs to.
   */
  private acceptAssignment(ticket: Ticket, assignmentId: string, sessionId: string): NodeResolutionResult<ResolvedTarget> {
    const scope = ticket.projectId ?? ticket.id
    return {
      ok: true,
      handle: {
        sessionId,
        role: 'worker',
        projectId: scope,
        assignmentId,
        ticketId: ticket.id,
        binding: { nodeId: this.host.nodeId, backendId: this.host.backendId, logicalWorkspaceKey: scope },
      },
      generation: {
        nodeTrustEpoch: this.host.nodeTrustEpoch(),
        assignmentEpoch: this.assignmentEpoch(ticket, assignmentId),
        toolTokenVersion: 0,
      },
    }
  }
}
