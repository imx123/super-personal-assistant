/**
 * The live state of one control plane: what is running right now, read for one caller and for nobody else.
 *
 * The live state is not a record and not a memory. It is a snapshot of the control plane's own facts, taken at the
 * moment the question is asked and dropped right after: it is written to no store, it triggers no model, it starts no
 * Session and it sends no command to the node. Everything it says is read from records the control plane already keeps —
 * the node snapshots the resolver reads, the Session records, the Tickets and their Assignments, the Projects and the
 * scheduled plans — so the answer is the state of the system and not a second opinion about it.
 *
 * The snapshot is scoped. A caller reads what its own role may read and nothing else: the Router reads the pool it
 * manages, a PM reads its own Project and the node it is bound to, a Worker reads its own Assignment and the Ticket it
 * belongs to. The scope comes from the Session the caller proved, never from what the caller asked for.
 *
 * The Assignment of a Ticket is the one that runs now. The attempts before it are history, and the history belongs to the
 * event history, not to a snapshot of what is going on.
 *
 * The fields are projected before they leave. What crosses the boundary is an identifier, a status or a label somebody
 * wrote: a workspace path, a token, a model credential, the text of a report, the note of a scheduled task and anything
 * about the console's own login never appear here.
 *
 * Every list is bounded and says so. A list that was cut reports how many rows it holds in all and how many were left
 * out, so a caller is never left to believe it saw everything.
 */
import { assignmentEpochOf, type NodeLiveSnapshot } from '../control/node-resolver.ts'
import { currentReview, latestAssignment, pmTicketStatus, type Assignment, type ProjectProfile, type Ticket } from '../core/index.ts'
import type { SessionRecord } from '../shared/protocol.ts'

/** Who the live state is read for. */
export type LiveStateAudience = 'operator' | 'router' | 'pm' | 'worker'

/**
 * How a node's connection reads.
 *
 * A node that never registered, or one that is reconnecting, is `unknown`: it is not an offline node, and it is never
 * `online` on the strength of an earlier answer.
 */
export type LiveStateConnection = 'online' | 'offline' | 'unknown'

/**
 * How a backend's availability reads.
 *
 * `unknown` is what a backend of an unknown node has. It is never reported as `available`: a backend that nobody may
 * reach is not an available one.
 */
export type LiveStateAvailability = 'available' | 'unavailable' | 'unknown'

/** How many rows of each kind the live state holds at most. */
export const LIVE_STATE_LIMITS = {
  nodes: 8,
  projects: 20,
  tickets: 50,
  assignments: 50,
  sessions: 50,
  schedules: 20,
} as const

/**
 * What the live state needs to know about one scheduled plan.
 *
 * The note the plan carries is not part of it: a scheduled task's text is a prompt, and a prompt does not belong in a
 * state snapshot.
 */
export interface LiveStatePlanSource {
  /** The plan's own id. */
  readonly id: string
  /** The Project whose PM receives the plan's message. */
  readonly projectId: string
  /** The plan's name, for the operator who reads it. */
  readonly name: string
  /** The rule, as the operator wrote it. */
  readonly rule: string
  /** Whether the plan comes due on its own. */
  readonly enabled: boolean
  /** The next moment the plan comes due. */
  readonly nextAt: string
  /** How the last run ended. */
  readonly lastState?: string
}

/**
 * The authoritative records the live state is read from.
 *
 * The service owns no state of its own: every fact comes from here, at the moment it is asked for, so a snapshot can
 * never be a value that was true yesterday.
 */
export interface LiveStateHost {
  /** The control plane's own clock: the moment the facts were read. */
  now(): string
  /** The node this control plane manages: a Session of another node is not its Session. */
  nodeId(): string
  /** The live node snapshots, read through the resolver. */
  liveNodeSnapshots(): ReadonlyArray<NodeLiveSnapshot>
  /** The control-plane Session records. */
  sessions(): ReadonlyArray<SessionRecord>
  /** The Tickets of the business store. */
  tickets(): ReadonlyArray<Ticket>
  /** The Projects of the business store. */
  projects(): ReadonlyArray<ProjectProfile>
  /** The scheduled plans of the control plane's own scheduler. */
  plans(): ReadonlyArray<LiveStatePlanSource>
  /** The id of the Session that is the Router of this control plane. */
  routerSessionId(): string
}

/** One bounded list of the live state. */
export interface LiveStateList<T> {
  /** The rows in scope, at most the bound of their kind. */
  readonly rows: readonly T[]
  /** How many rows are in scope in all. */
  readonly total: number
  /** How many rows were left out because of the bound. */
  readonly omitted: number
}

/** One node, as the live state names it. */
export interface LiveStateNode {
  readonly nodeId: string
  readonly displayName?: string
  readonly isPrimary: boolean
  /** The connection as it is at the moment of the read. */
  readonly connection: LiveStateConnection
  /** When the node last said something. */
  readonly lastSeenAt?: string
  readonly backends: readonly LiveStateBackend[]
}

/** One backend of a node, with what it can do. */
export interface LiveStateBackend {
  readonly backendId: string
  readonly kind: string
  /** Whether the backend may be reached; `unknown` when the node itself is not known to be there. */
  readonly availability: LiveStateAvailability
  readonly capabilities: {
    readonly turnInterrupt: boolean
    readonly twoStageReceipt: boolean
    readonly sessionResume: boolean
    readonly gitReviewDiff: boolean
  }
}

/** One Session, as the live state names it. */
export interface LiveStateSession {
  readonly sessionId: string
  readonly role: string
  readonly status: string
  /** The Project the Session belongs to; a standalone Worker's is its own Ticket id. */
  readonly projectId: string
  /** The Ticket the Session works on, when it works on one. */
  readonly ticketId?: string
  /** The Assignment the Session runs, when it runs one. */
  readonly assignmentId?: string
  readonly nodeId: string
  readonly updatedAt: string
  /** Whether an operator stopped this Session. */
  readonly stopped?: boolean
  /** Whether this Session's authority was revoked. */
  readonly revoked?: boolean
}

/** One Project, as the live state names it. */
export interface LiveStateProject {
  readonly projectId: string
  readonly title: string
  readonly status: string
  readonly pauseMode?: string
  readonly pmSessionId: string
  readonly updatedAt: string
}

/** One Ticket, as the live state names it. */
export interface LiveStateTicket {
  readonly ticketId: string
  readonly title: string
  /** The Project it belongs to; a standalone Ticket has none. */
  readonly projectId?: string
  /** The status a PM reads for it. */
  readonly status: string
  /** The Assignment that is its current one. */
  readonly assignmentId?: string
  /** The state of the review of its latest result. */
  readonly reviewState?: string
  readonly updatedAt: string
  /** Whether a person stopped this Ticket's Worker. */
  readonly stopped?: boolean
}

/** One Assignment, as the live state names it. */
export interface LiveStateAssignment {
  readonly assignmentId: string
  readonly ticketId: string
  readonly state: string
  /** The Session that runs it, when there is one. */
  readonly sessionId?: string
  /** The state of the Assignment's own last report; the report's text is not part of it. */
  readonly reportState?: string
  /** The lifecycle generation of the Assignment, as the resolver counts them. */
  readonly epoch: number
  readonly startedAt?: string
  readonly endedAt?: string
}

/** One scheduled plan, as the live state names it. */
export interface LiveStateSchedule {
  readonly planId: string
  readonly projectId: string
  readonly name: string
  readonly rule: string
  readonly enabled: boolean
  readonly nextAt: string
  /** How the last run ended. */
  readonly lastState?: string
}

/** The live state, as one caller reads it. */
export interface LiveStateSnapshot {
  /** When the facts were read: the control plane's own clock. */
  readonly at: string
  /** Who the facts are for. */
  readonly audience: LiveStateAudience
  readonly nodes: LiveStateList<LiveStateNode>
  readonly projects: LiveStateList<LiveStateProject>
  readonly tickets: LiveStateList<LiveStateTicket>
  /** The Assignments that run now: the current attempt of each Ticket in scope, never the attempts before it. */
  readonly assignments: LiveStateList<LiveStateAssignment>
  readonly sessions: LiveStateList<LiveStateSession>
  readonly schedules: LiveStateList<LiveStateSchedule>
}

/** Why a caller may not read the live state. */
export type LiveStateRefusalCode =
  | 'UNKNOWN_SESSION'
  | 'ROLE_MISMATCH'
  | 'NO_SCOPE'
  | 'ASSIGNMENT_UNAVAILABLE'
  | 'STALE_ASSIGNMENT'

/** The answer of a scoped read: the snapshot, or the reason there is none. */
export type LiveStateResult =
  | { readonly ok: true; readonly snapshot: LiveStateSnapshot }
  | { readonly ok: false; readonly code: LiveStateRefusalCode; readonly reason: string }

/** The rows of one kind that are in scope, before they are projected. */
interface Scope {
  readonly audience: LiveStateAudience
  readonly nodes: readonly NodeLiveSnapshot[]
  readonly projects: readonly ProjectProfile[]
  readonly tickets: readonly Ticket[]
  readonly assignments: readonly { readonly ticket: Ticket; readonly assignment: Assignment }[]
  readonly sessions: readonly SessionRecord[]
  readonly plans: readonly LiveStatePlanSource[]
}

/** One Assignment with the Ticket that owns it. */
type OwnedAssignment = Scope['assignments'][number]

/**
 * The live state of one control plane.
 *
 * The service is a pure projection over the host's records: it reads them, decides what the caller may see, and hands
 * back the facts. It never writes, never asks the node anything and never calls a model.
 */
export class LiveStateService {
  constructor(private readonly host: LiveStateHost) {}

  /** The whole live state, as the operator reads it. */
  operator(): LiveStateSnapshot {
    return this.project(this.wholeScope())
  }

  /**
   * The live state one Session may read.
   *
   * The Session names its own scope: the role comes from its record and the work from what it owns. A caller that
   * names another Session, another Project or another Ticket is not answered at all — the request carries no authority
   * here, so there is nothing in it to trust.
   */
  forSession(request: { readonly audience: 'router' | 'pm' | 'worker'; readonly sessionId: string }): LiveStateResult {
    const sessions = this.host.sessions()
    const record = sessions.find(session => session.sessionId === request.sessionId)
    if (record === undefined) {
      return { ok: false, code: 'UNKNOWN_SESSION', reason: `There is no Session ${request.sessionId}` }
    }
    if (record.role !== request.audience) {
      return { ok: false, code: 'ROLE_MISMATCH',
        reason: `This Session is a ${record.role} Session and may not read the ${request.audience} view` }
    }
    if (record.revokedAt !== undefined) {
      return { ok: false, code: 'NO_SCOPE', reason: 'This Session was revoked; it opens nothing' }
    }
    if (record.operatorStop !== undefined) {
      return { ok: false, code: 'NO_SCOPE', reason: 'This Session was stopped by an operator; it opens nothing' }
    }
    // A Session belongs to one node: a record of another machine is not this control plane's Session, and the work it
    // would read is that machine's.
    if (!this.isLocal(record)) {
      return { ok: false, code: 'NO_SCOPE',
        reason: `This Session belongs to the node ${record.nodeId}, not to ${this.host.nodeId()}` }
    }
    if (request.audience === 'router') return this.routerScope(record)
    if (request.audience === 'pm') return this.pmScope(record)
    return this.workerScope(record)
  }

  /**
   * Whether one Session record belongs to this control plane's own node.
   *
   * A record that names no node at all is a record from before the binding existed, and it is left alone: the control
   * plane owns every Session it holds. A record that names another machine is a Session of another one, and it is not
   * part of what this control plane manages.
   */
  private isLocal(record: SessionRecord): boolean {
    return record.nodeId === '' || record.nodeId === this.host.nodeId()
  }

  /** Everything this control plane holds; the operator's own view of it. */
  private wholeScope(): Scope {
    const sessions = this.host.sessions()
    const tickets = this.host.tickets()
    return {
      audience: 'operator',
      nodes: this.host.liveNodeSnapshots(),
      projects: this.host.projects(),
      tickets,
      assignments: currentAssignments(tickets),
      sessions,
      plans: this.host.plans(),
    }
  }

  /**
   * The Router's view: the pool it manages.
   *
   * The Router is the one Session that belongs to no Project, so it sees every Project, Ticket and Assignment of this
   * control plane. Its own Session is left out: the Router knows its own state, and the pool it manages is the work
   * around it.
   */
  private routerScope(record: SessionRecord): LiveStateResult {
    if (record.sessionId !== this.host.routerSessionId()) {
      return { ok: false, code: 'NO_SCOPE', reason: 'This Session is not the Router of this control plane' }
    }
    const scope = this.wholeScope()
    return { ok: true, snapshot: this.project({ ...scope, audience: 'router',
      sessions: scope.sessions.filter(session => session.sessionId !== record.sessionId) }) }
  }

  /**
   * A PM's view: its own Project, the work under it and the node it is bound to.
   *
   * The Project is the one whose PM this Session is — the delegation itself, not the id the Session carries. A Project
   * that has ended or been archived keeps its record, but its work is over: the PM then sees the Project and nothing
   * else. A plan of another Project and a Ticket of another Project are never in the scope at all.
   */
  private pmScope(record: SessionRecord): LiveStateResult {
    const projects = this.host.projects()
    const project = projects.find(entry => entry.pmSessionId === record.sessionId)
    if (project === undefined) {
      return { ok: false, code: 'NO_SCOPE', reason: 'This Session is not the PM of a Project of this control plane' }
    }
    if (project.status === 'ended' || project.status === 'archived') {
      return { ok: true, snapshot: this.project({
        audience: 'pm',
        nodes: this.boundNodes(record),
        projects: [project],
        tickets: [],
        assignments: [],
        sessions: [record],
        plans: [],
      }) }
    }
    const tickets = this.host.tickets().filter(ticket => ticket.projectId === project.id)
    const assignments = currentAssignments(tickets)
    const assignmentIds = new Set(assignments.map(entry => entry.assignment.id))
    // The Workers of this Project are the ones this control plane runs: a Session record of another node is not part of
    // this Project's work, even when it claims one of its Assignments.
    const sessions = this.host.sessions().filter(session => session.sessionId === record.sessionId
      || (session.assignmentId !== undefined && assignmentIds.has(session.assignmentId) && this.isLocal(session)))
    return { ok: true, snapshot: this.project({
      audience: 'pm',
      nodes: this.boundNodes(record),
      projects: [project],
      tickets,
      assignments,
      sessions,
      plans: this.host.plans().filter(plan => plan.projectId === project.id),
    }) }
  }

  /**
   * A Worker's view: its own Assignment, the Ticket it belongs to and the node it is bound to.
   *
   * The Assignment is the one the Session record names, and it must still be the Ticket's current one: a Worker whose
   * Assignment was replaced reads nothing at all, because what it would read is no longer its work. The Project of the
   * Ticket is named as metadata, and nothing else of that Project is.
   */
  private workerScope(record: SessionRecord): LiveStateResult {
    const assignmentId = record.assignmentId
    if (assignmentId === undefined || assignmentId === '') {
      return { ok: false, code: 'NO_SCOPE', reason: 'This Worker Session has no Assignment' }
    }
    const tickets = this.host.tickets()
    const ticket = tickets.find(entry => entry.assignments.some(assignment => assignment.id === assignmentId))
    if (ticket === undefined) {
      return { ok: false, code: 'ASSIGNMENT_UNAVAILABLE',
        reason: `The Assignment ${assignmentId} belongs to no Ticket of this control plane` }
    }
    const assignment = ticket.assignments.find(entry => entry.id === assignmentId)
    if (assignment === undefined) {
      return { ok: false, code: 'ASSIGNMENT_UNAVAILABLE',
        reason: `The Assignment ${assignmentId} does not belong to the Ticket ${ticket.id}` }
    }
    if (latestAssignment(ticket)?.id !== assignmentId) {
      return { ok: false, code: 'STALE_ASSIGNMENT',
        reason: `The Assignment ${assignmentId} was replaced and is no longer the work that runs` }
    }
    const project = ticket.projectId === undefined
      ? undefined : this.host.projects().find(entry => entry.id === ticket.projectId)
    return { ok: true, snapshot: this.project({
      audience: 'worker',
      nodes: this.boundNodes(record),
      projects: project === undefined ? [] : [project],
      tickets: [ticket],
      assignments: [{ ticket, assignment }],
      sessions: [record],
      plans: [],
    }) }
  }

  /** The node snapshots of the machine this Session is bound to. */
  private boundNodes(record: SessionRecord): NodeLiveSnapshot[] {
    if (record.nodeId === '') return []
    return this.host.liveNodeSnapshots().filter(snapshot => snapshot.nodeId === record.nodeId)
  }

  /** The scope, projected into the fields that may leave the control plane. */
  private project(scope: Scope): LiveStateSnapshot {
    const sessions = [...scope.sessions].sort(byUpdatedAt(row => row.updatedAt, row => row.sessionId))
    const assignments = [...scope.assignments].sort((left, right) =>
      left.ticket.id === right.ticket.id
        ? left.assignment.id.localeCompare(right.assignment.id)
        : left.ticket.id.localeCompare(right.ticket.id))
    const tickets = [...scope.tickets].sort(byUpdatedAt(row => row.updatedAt, row => row.id))
    const projects = [...scope.projects].sort(byUpdatedAt(row => row.updatedAt, row => row.id))
    const plans = [...scope.plans].sort((left, right) =>
      left.nextAt === right.nextAt ? left.id.localeCompare(right.id) : left.nextAt.localeCompare(right.nextAt))
    const nodes = [...scope.nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    // The Ticket that owns an Assignment, and the Session that runs it: both are read from the records themselves, so the
    // projection never guesses an id the way the domain's older naming would.
    const ticketOfAssignment = new Map<string, string>()
    for (const entry of assignments) ticketOfAssignment.set(entry.assignment.id, entry.ticket.id)
    const sessionOfAssignment = new Map<string, string>()
    for (const session of sessions) {
      if (session.assignmentId !== undefined) sessionOfAssignment.set(session.assignmentId, session.sessionId)
    }
    return {
      at: this.host.now(),
      audience: scope.audience,
      nodes: bounded(nodes.map(node => this.nodeFacts(node)), LIVE_STATE_LIMITS.nodes),
      projects: bounded(projects.map(project => this.projectFacts(project)), LIVE_STATE_LIMITS.projects),
      tickets: bounded(tickets.map(ticket => this.ticketFacts(ticket)), LIVE_STATE_LIMITS.tickets),
      assignments: bounded(assignments.map(entry => this.assignmentFacts(entry, sessionOfAssignment)), LIVE_STATE_LIMITS.assignments),
      sessions: bounded(sessions.map(session => this.sessionFacts(session, ticketOfAssignment)), LIVE_STATE_LIMITS.sessions),
      schedules: bounded(plans.map(plan => this.scheduleFacts(plan)), LIVE_STATE_LIMITS.schedules),
    }
  }

  /** One node, with its connection read as it is at this moment. */
  private nodeFacts(snapshot: NodeLiveSnapshot): LiveStateNode {
    const connection = connectionOf(snapshot)
    return {
      nodeId: snapshot.nodeId,
      ...(snapshot.displayName === undefined ? {} : { displayName: snapshot.displayName }),
      isPrimary: snapshot.isPrimary,
      connection,
      ...(snapshot.lastSeenAt === undefined ? {} : { lastSeenAt: snapshot.lastSeenAt }),
      backends: snapshot.backends.map(backend => ({
        backendId: backend.backendId,
        kind: backend.kind,
        availability: availabilityOf(backend.available, connection),
        capabilities: {
          turnInterrupt: backend.capabilities.turnInterrupt,
          twoStageReceipt: backend.capabilities.twoStageReceipt,
          sessionResume: backend.capabilities.sessionResume,
          gitReviewDiff: backend.capabilities.gitReviewDiff,
        },
      })),
    }
  }

  /** One Project: its identity, its state and the labels somebody wrote. */
  private projectFacts(project: ProjectProfile): LiveStateProject {
    return {
      projectId: project.id,
      title: project.title,
      status: project.status,
      ...(project.pauseMode === undefined ? {} : { pauseMode: project.pauseMode }),
      pmSessionId: project.pmSessionId,
      updatedAt: project.updatedAt,
    }
  }

  /** One Ticket: its identity, the state a PM reads and the Assignment that runs it. */
  private ticketFacts(ticket: Ticket): LiveStateTicket {
    const assignment = latestAssignment(ticket)
    const review = currentReview(ticket)
    return {
      ticketId: ticket.id,
      title: ticket.title,
      ...(ticket.projectId === undefined ? {} : { projectId: ticket.projectId }),
      status: pmTicketStatus(ticket),
      ...(assignment === undefined ? {} : { assignmentId: assignment.id }),
      ...(review === undefined ? {} : { reviewState: review.state }),
      updatedAt: ticket.updatedAt,
      ...(ticket.manualStop === undefined ? {} : { stopped: true }),
    }
  }

  /** One Assignment: its identity, its own state and the state of its last report. */
  private assignmentFacts(entry: OwnedAssignment, sessionOfAssignment: ReadonlyMap<string, string>): LiveStateAssignment {
    const { ticket, assignment } = entry
    const sessionId = sessionOfAssignment.get(assignment.id) ?? assignment.sessionId
    return {
      assignmentId: assignment.id,
      ticketId: ticket.id,
      state: assignment.state,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(assignment.report === undefined ? {} : { reportState: assignment.report.state }),
      epoch: assignmentEpochOf(ticket, assignment.id),
      ...(assignment.startedAt === undefined ? {} : { startedAt: assignment.startedAt }),
      ...(assignment.endedAt === undefined ? {} : { endedAt: assignment.endedAt }),
    }
  }

  /** One Session: its identity, its state and the work it runs. */
  private sessionFacts(record: SessionRecord, ticketOfAssignment: ReadonlyMap<string, string>): LiveStateSession {
    const ticketId = record.assignmentId === undefined ? undefined : ticketOfAssignment.get(record.assignmentId)
    return {
      sessionId: record.sessionId,
      role: record.role,
      status: record.status,
      projectId: record.projectId,
      ...(ticketId === undefined ? {} : { ticketId }),
      ...(record.assignmentId === undefined ? {} : { assignmentId: record.assignmentId }),
      nodeId: record.nodeId,
      updatedAt: record.updatedAt,
      ...(record.operatorStop === undefined ? {} : { stopped: true }),
      ...(record.revokedAt === undefined ? {} : { revoked: true }),
    }
  }

  /** One scheduled plan: its identity, its rule and when it comes due; never the note it carries. */
  private scheduleFacts(plan: LiveStatePlanSource): LiveStateSchedule {
    return {
      planId: plan.id,
      projectId: plan.projectId,
      name: plan.name,
      rule: plan.rule,
      enabled: plan.enabled,
      nextAt: plan.nextAt,
      ...(plan.lastState === undefined ? {} : { lastState: plan.lastState }),
    }
  }
}

/**
 * The Assignment of each Ticket that is its current one.
 *
 * The live state says what runs now: a Ticket that was worked on before names the attempt that runs now, and the attempts
 * before it are history — the event history's own business, not a row of a state snapshot. The epoch of the Assignment still
 * counts the attempts it had, so a Ticket on its third try says so.
 */
function currentAssignments(tickets: readonly Ticket[]): OwnedAssignment[] {
  const owned: OwnedAssignment[] = []
  for (const ticket of tickets) {
    const assignment = latestAssignment(ticket)
    if (assignment !== undefined) owned.push({ ticket, assignment })
  }
  return owned
}

/**
 * The connection of a node, as the resolver reports it now.
 *
 * A node that is reconnecting is not an offline node and not an online one: it is `unknown`, and it is never `online`
 * on the strength of an earlier answer.
 */
function connectionOf(snapshot: NodeLiveSnapshot): LiveStateConnection {
  if (snapshot.connectionStatus === 'online') return 'online'
  if (snapshot.connectionStatus === 'offline') return 'offline'
  return 'unknown'
}

/**
 * The availability of a backend.
 *
 * A backend of a node that is not known to be there is `unknown`, and `unknown` is never `available`: an answer that
 * asserted availability nobody proved would be a claim, not a fact.
 */
function availabilityOf(available: boolean, connection: LiveStateConnection): LiveStateAvailability {
  if (connection === 'online') return available ? 'available' : 'unavailable'
  if (connection === 'offline') return 'unavailable'
  return 'unknown'
}

/** The newest first, with the id as the tie-breaker so the order never depends on the store's own order. */
function byUpdatedAt<T>(updatedAt: (row: T) => string, id: (row: T) => string) {
  return (left: T, right: T): number => {
    const byTime = updatedAt(right).localeCompare(updatedAt(left))
    return byTime !== 0 ? byTime : id(left).localeCompare(id(right))
  }
}

/** The rows of one list, at most the bound, with the count of what was left out. */
function bounded<T>(rows: readonly T[], limit: number): LiveStateList<T> {
  return { rows: rows.slice(0, limit), total: rows.length, omitted: Math.max(0, rows.length - limit) }
}
