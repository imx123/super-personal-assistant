/** Standalone control-plane kernel: domain state, PM/Worker Session records, and a NodePort. No DSH imports. */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Store } from '../app/store.ts'
import { assignmentStopped, latestAssignment, runningAssignment, waitsForPerson, type Assignment,
  type AssignmentState, type ProjectProfile, type ProjectReport, type ProjectTicketTask, type Ticket,
  type WorkerReport } from '../core/index.ts'
import { KV } from '../kv.ts'
import { NODE_PROTOCOL_VERSION } from '../shared/protocol.ts'
import type { NodeCommand, NodeEvent, NodePort, NodeRegistration, NodeStatus, RoleProfile, SessionInspection,
  SessionRecord, SessionStatus } from '../shared/protocol.ts'
import { issueSessionToken, verifySessionToken, type SessionTokenClaims } from '../shared/session-token.ts'
import { createKernelDomain, type KernelDomain } from './domain.ts'
import { NodeExecutor } from './executor.ts'
import { PM_PROFILE, WORKER_PROFILE } from './roles.ts'

/**
 * Statuses a node reported that already settle an ensure. A record in one of them is a Session whose lifecycle is known,
 * so a later transport error must not rewrite it as `failed`. `starting` and `failed` are the states that still need a
 * (re)confirmation.
 */
const NODE_CONFIRMED: ReadonlySet<SessionStatus> = new Set(['idle', 'running', 'stopping', 'stopped', 'archived'])

function isNodeConfirmed(status: SessionStatus): boolean {
  return NODE_CONFIRMED.has(status)
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

export interface ControlPlaneOptions {
  /** SQLite file. Its directory is locked for the lifetime of this kernel. */
  dbPath: string
  nodeId: string
  node: NodePort
  /** HMAC secret used to issue Session tokens; the node only ever sees the token. */
  secret: string
  /** Every project workspace must resolve under this directory. */
  workspaceRoot: string
  now?: () => string
  tokenTtlSeconds?: number
  /** How long an ensure waits for a node status event before asking the node directly. */
  confirmationTimeoutMs?: number
  /** How long an explicit `session.inspect` waits for the node's answer. */
  inspectionTimeoutMs?: number
}

export interface ControlPlaneState {
  nodeId: string
  nodes: Record<string, NodeStatus>
  projects: ProjectProfile[]
  tickets: Ticket[]
  sessions: SessionRecord[]
  events: number
}

/** What a PM sees of one of its Tickets' states, derived from the Ticket, its Project archive and its latest Assignment. */
export type PmTicketStatus = 'open' | 'running' | 'blocked' | 'failed' | 'completed' | 'stopped' | 'archived'

/** The latest Assignment of a Ticket as a PM reads it: identity, lifecycle state and its own last report. */
export interface PmContextAssignment {
  id: string
  state: AssignmentState
  report?: Assignment['report']
}

/** One Ticket of the PM's own Project; no Mandate, actor or internal input is included. */
export interface PmContextTicket {
  id: string
  title: string
  status: PmTicketStatus
  assignment?: PmContextAssignment
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

/** The read-only context a PM Session may read about its own Project and the Tickets already created in it. */
export interface PmContext {
  project: PmContextProject
  tickets: PmContextTicket[]
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
  if (runningAssignment(ticket)) return 'running'
  return 'open'
}

/**
 * The kernel owns the domain Store and Engine, while a NodePort owns execution. It never imports
 * DSH: the same object can front the current plugin or a FakeNode in tests.
 */
export class ControlPlane {
  readonly store: Store
  readonly domain: KernelDomain
  readonly sessions = new Map<string, SessionRecord>()
  readonly nodes = new Map<string, NodeStatus>()
  readonly events: NodeEvent[] = []
  private readonly tokens = new Map<string, string>()
  private readonly unsubscribe: () => void
  private readonly releaseLock: () => Promise<void>
  private readonly version = '0.1.0'
  /** Ensures already running, by Session id: concurrent requests share one node round trip. */
  private readonly pendingEnsures = new Map<string, Promise<SessionRecord>>()
  /** Callbacks waiting for the next node status of one Session, so an async event can settle an ensure. */
  private readonly statusWaiters = new Map<string, Set<() => void>>()
  /** Answers expected for an explicit `session.inspect`, keyed by its request id. */
  private readonly pendingInspections = new Map<string, (inspection: SessionInspection) => void>()
  /** Scopes command keys to this kernel process, so a restart never repeats a key the node already executed. */
  private readonly instanceId = randomUUID()
  private sequence = 0
  private closed = false

  constructor(private readonly options: ControlPlaneOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 })
    mkdirSync(options.workspaceRoot, { recursive: true, mode: 0o700 })
    const release = lockSync(dirname(options.dbPath), { stale: 30_000 })
    this.releaseLock = async () => { release() }
    try {
      this.store = new Store(options.dbPath)
      // The callbacks run after construction (an Assignment starts only through a later Engine command), so the closures may
      // read `this.engine` and the Session map without an initialization-order hazard.
      const executor = new NodeExecutor({
        createWorkerSession: (projectId, assignmentId, ticketId, prompt) =>
          this.createWorkerSession(projectId, assignmentId, ticketId, prompt),
        sendMessage: (sessionId, text) => this.sendMessage(sessionId, text),
        cancelSession: (sessionId, reason) => this.cancelSession(sessionId, reason),
        assignmentStarted: (ticketId, assignmentId) => { this.engine.assignmentStarted(ticketId, assignmentId) },
        assignmentFailed: (ticketId, assignmentId, error) => { this.assignmentFailed(ticketId, assignmentId, error) },
        taskPrompt: ticket => this.taskPrompt(ticket),
        inputsDelivered: (ticketId, assignmentId, inputIds) => {
          this.engine.inputsDelivered(ticketId, assignmentId, inputIds)
        },
        workerSessionId: (_ticketId, assignmentId) => this.workerSessionFor(assignmentId),
      })
      this.domain = createKernelDomain(this.store, options.now, executor)
      this.loadSessions()
      this.unsubscribe = options.node.subscribe(event => { this.receive(event) })
    } catch (error) {
      void this.releaseLock().catch(() => {})
      throw error
    }
  }

  /** The Engine is exposed for tests and the future panel; callers should prefer the methods below. */
  get engine() { return this.domain.engine }

  now(): string { return this.options.now?.() ?? new Date().toISOString() }

  /** Register the local node once; repeated calls are idempotent at the node. */
  async registerNode(registration: Partial<Pick<NodeRegistration, 'version' | 'capabilities'>> = {}): Promise<void> {
    const value: NodeRegistration = { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: this.options.nodeId, backend: 'dsh',
      version: registration.version ?? this.version, ...(registration.capabilities ? { capabilities: registration.capabilities } : {}) }
    await this.options.node.send({ ...this.base(`node-register:${this.options.nodeId}`), type: 'node.register', registration: value })
  }

  async heartbeat(online = true): Promise<void> {
    const status: NodeStatus = { nodeId: this.options.nodeId, backend: 'dsh', version: this.version, online,
      at: this.now(), capabilities: [] }
    await this.options.node.send({ ...this.base(this.uniqueKey('node-heartbeat', this.options.nodeId)), type: 'node.heartbeat', status })
  }

  /** Create a Project from a stored Trigger through the Engine; no node call is made here. */
  createProject(triggerId: string, title: string, goal: string): ProjectProfile {
    return this.engine.createProject(triggerId, title, goal)
  }

  projects(): ProjectProfile[] { return this.store.projects.list() }

  tickets(): Ticket[] { return this.store.tickets.list() }

  session(sessionId: string): SessionRecord | undefined { return this.sessions.get(sessionId) }

  /**
   * Verify a Session token and that it still names a live Session record.
   *
   * `verifySessionToken` proves the signature, version and expiry with the kernel's own secret. The record comparison
   * proves the claims still describe a Session this kernel owns, so a token minted for a replaced Session cannot be
   * replayed against another one. Only a verified token reaches the tool methods below; no tool argument is authority.
   */
  verifyToolToken(token: string): SessionTokenClaims {
    const claims = verifySessionToken(token, this.options.secret)
    const record = this.sessions.get(claims.sid)
    if (!record) throw new ToolCallError('unauthenticated', 'The Session token does not name a known Session')
    if (record.projectId !== claims.pid || record.role !== claims.role || record.assignmentId !== claims.aid) {
      throw new ToolCallError('unauthenticated', 'The Session token does not match its Session record')
    }
    return claims
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
    return this.engine.createProjectTickets(project.id, sessionId, tasks)
  }

  /**
   * The read-only Project and Ticket context of the caller's own Project.
   *
   * A PM's first turn has to see the Project it manages and the Tickets already created in it; no other tool gives the
   * node that view. The Session record, not an argument, names the Project, and a PM Session that is not the Project's
   * own is refused. Only safe fields cross the boundary: neither the Mandate, the token, nor any internal actor is
   * included, and a Ticket of another Project never appears.
   */
  pmContext(sessionId: string): PmContext {
    const record = this.requireToolSession(sessionId, 'pm')
    const project = this.store.projects.get(record.projectId)
    if (!project) throw new ToolCallError('invalid', `Unknown Project ${record.projectId}`)
    if (project.pmSessionId !== sessionId) {
      throw new ToolCallError('forbidden', 'Only this Project\'s PM Session may read its context')
    }
    const tickets = this.tickets().filter(ticket => ticket.projectId === project.id).map(ticket => {
      const assignment = latestAssignment(ticket)
      return {
        id: ticket.id,
        title: ticket.title,
        status: pmTicketStatus(ticket),
        ...(assignment === undefined ? {} : { assignment: { id: assignment.id, state: assignment.state,
          ...(assignment.report === undefined ? {} : { report: assignment.report }) } }),
      }
    })
    return {
      project: { id: project.id, title: project.title, goal: project.goal, status: project.status,
        ...(project.pauseMode === undefined ? {} : { pauseMode: project.pauseMode }),
        ...(project.latestReport === undefined ? {} : { latestReport: project.latestReport }) },
      tickets,
    }
  }

  /**
   * Record a Worker's report on the Ticket its own Assignment runs.
   *
   * The token's Assignment is the authority; a caller-supplied one must match it. The Ticket must belong to the Worker's
   * Project and its latest Assignment must still be this Worker's, so a replaced Worker cannot report on work a newer
   * Assignment owns. `engine.report` applies the report's own rules (an ended Ticket, a question beside a ready result).
   */
  workerReport(sessionId: string, ticketId: string, assignmentId: string | undefined, report: WorkerReport): Ticket {
    const record = this.requireToolSession(sessionId, 'worker')
    const own = record.assignmentId
    if (!own) throw new ToolCallError('forbidden', 'This Worker Session has no Assignment')
    if (assignmentId !== undefined && assignmentId !== own) {
      throw new ToolCallError('forbidden', 'The Assignment does not belong to this Worker Session')
    }
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket || ticket.projectId !== record.projectId) throw new ToolCallError('invalid', `Unknown ticket ${ticketId}`)
    const current = ticket.assignments.at(-1)
    if (!current || current.id !== own) {
      throw new ToolCallError('invalid', `Assignment ${own} is not current for Ticket ${ticketId}`)
    }
    return this.engine.report(ticketId, report)
  }

  /** The Session a tool call acts as; a token of the wrong role is refused before any domain check runs. */
  private requireToolSession(sessionId: string, role: 'pm' | 'worker'): SessionRecord {
    const record = this.sessions.get(sessionId)
    if (!record) throw new ToolCallError('unauthenticated', `Unknown Session ${sessionId}`)
    if (record.role !== role) throw new ToolCallError('forbidden', `A ${role} Session token is required`)
    return record
  }

  /**
   * Ensure the Project's PM Session. The workspace is created under `workspaceRoot`; the PM gets a short-lived token
   * and the PM role profile. A record a node already confirmed (`idle`, `running`, `stopped`, `archived`, …) is returned
   * as it is.
   *
   * Concurrent requests for the same Session share one ensure. A `starting` or `failed` record is confirmed with the
   * node, not guessed from a repeated command: a node acknowledges a key it already completed without reporting the
   * Session's status, so a retried ensure alone can leave the record `starting` forever. The method never returns a
   * `starting` record: it either settles on a node fact or marks the record failed and throws.
   */
  async openProject(projectId: string, workspace?: string): Promise<SessionRecord> {
    const project = this.store.projects.get(projectId)
    if (!project) throw new Error(`Unknown project ${projectId}`)
    // A concurrent request joins the running ensure before reading the record: a node status event may already have made
    // the record `idle` while the ensure still waits on role installation, and returning that record would report 200
    // for an ensure that can still fail.
    const pending = this.pendingEnsures.get(project.pmSessionId)
    if (pending) return pending
    const existing = this.sessions.get(project.pmSessionId)
    if (existing && isNodeConfirmed(existing.status)) return existing
    return this.singleFlight(project.pmSessionId, () => this.ensurePm(project, workspace))
  }

  /** Create a worker Session for an Assignment; the caller records the Assignment in the domain separately. */
  async createWorkerSession(projectId: string, assignmentId: string, ticketId: string, prompt: string = WORKER_PROFILE.prompt): Promise<SessionRecord> {
    const project = this.store.projects.get(projectId)
    if (!project) throw new Error(`Unknown project ${projectId}`)
    const sessionId = `worker-${assignmentId}`
    const pending = this.pendingEnsures.get(sessionId)
    if (pending) return pending
    const existing = this.sessions.get(sessionId)
    if (existing && isNodeConfirmed(existing.status)) return existing
    return this.singleFlight(sessionId, () => this.ensureWorker(project, assignmentId, ticketId, prompt))
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

  private async ensurePm(project: ProjectProfile, workspace?: string): Promise<SessionRecord> {
    const existing = this.sessions.get(project.pmSessionId)
    if (existing && isNodeConfirmed(existing.status)) return existing
    if (existing) {
      const confirmed = await this.confirmExisting(existing)
      if (confirmed) return confirmed
    }
    const path = this.workspacePath(workspace ?? existing?.workspace ?? join(this.options.workspaceRoot, project.id))
    const at = this.now()
    const retry = existing !== undefined
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
    return this.settleEnsure(record, 'PM')
  }

  private async ensureWorker(project: ProjectProfile, assignmentId: string, ticketId: string, prompt: string): Promise<SessionRecord> {
    const sessionId = `worker-${assignmentId}`
    const existing = this.sessions.get(sessionId)
    if (existing && isNodeConfirmed(existing.status)) return existing
    if (existing) {
      const confirmed = await this.confirmExisting(existing)
      if (confirmed) return confirmed
    }
    const path = this.workspacePath(join(this.options.workspaceRoot, project.id))
    const at = this.now()
    const retry = existing !== undefined
    const record: SessionRecord = existing
      ? this.restartSession(existing, path, at)
      : { sessionId, projectId: project.id, assignmentId, role: 'worker', nodeId: this.options.nodeId, workspace: path,
          status: 'starting', toolProfile: WORKER_PROFILE.name, backendSessionId: `fake-${sessionId}`, createdAt: at,
          updatedAt: at }
    const token = this.issueToken(record)
    this.sessions.set(sessionId, record)
    this.tokens.set(sessionId, token)
    this.persist(record)
    // Same rule as `openProject`: only the first attempt may reuse a stable key.
    const createKey = retry ? this.uniqueKey('worker-create-confirm', assignmentId) : `worker-create:${assignmentId}`
    try {
      await this.options.node.send({ ...this.base(createKey), type: 'worker.create', sessionId, projectId: project.id,
        assignmentId, ticketId, workspace: path, profile: WORKER_PROFILE, sessionToken: token, prompt })
    } catch (error) {
      return this.recoverEnsureFailure(record, error, 'Worker')
    }
    return this.settleEnsure(record, 'Worker')
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const record = this.requireSession(sessionId)
    if (record.status === 'archived' || record.status === 'stopped') throw new Error(`Session ${sessionId} is not running`)
    const token = this.tokens.get(sessionId) ?? this.issueToken(record)
    this.tokens.set(sessionId, token)
    await this.options.node.send({ ...this.base(this.uniqueKey('message', sessionId)), type: 'session.message', sessionId, text })
  }

  async cancelSession(sessionId: string, reason?: string): Promise<void> {
    this.requireSession(sessionId)
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
    await this.options.node.send({ ...this.base(this.uniqueKey('archive', sessionId)), type: 'session.archive', sessionId })
    if (record.status === 'archived') return
    const at = this.now()
    record.status = 'archived'
    record.archivedAt = at
    record.updatedAt = at
    this.persist(record)
  }

  async setPermission(sessionId: string, permission: string): Promise<void> {
    this.requireSession(sessionId)
    await this.options.node.send({ ...this.base(this.uniqueKey('permission', sessionId)), type: 'permission.set', sessionId, permission })
  }

  state(): ControlPlaneState {
    return { nodeId: this.options.nodeId, nodes: Object.fromEntries(this.nodes), projects: this.projects(), tickets: this.tickets(),
      sessions: [...this.sessions.values()], events: this.events.length }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    this.sessions.clear()
    this.tokens.clear()
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
    return this.inspectionHealthy(inspection) ? record : undefined
  }

  /**
   * Settle an ensure whose command was acknowledged. A synchronous status event usually already did; an async or lost
   * event waits briefly, then the node is asked directly. It never returns a `starting` record.
   */
  private async settleEnsure(record: SessionRecord, label: string): Promise<SessionRecord> {
    let current = this.sessions.get(record.sessionId) ?? record
    if (current.status === 'failed' || isNodeConfirmed(current.status)) return current
    const changed = await this.waitForStatus(current, this.options.confirmationTimeoutMs ?? 2000)
    if (changed) {
      current = changed
      if (current.status === 'failed' || isNodeConfirmed(current.status)) return current
    }
    const inspection = await this.tryInspect(current.sessionId)
    if (inspection?.found) {
      this.adoptInspection(current, inspection)
      if (this.inspectionHealthy(inspection)) return this.sessions.get(current.sessionId) ?? current
      this.markFailed(current)
      return current
    }
    this.markFailed(current)
    throw new SessionEnsureError(`The node did not confirm the ${label} Session ${current.sessionId}`)
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
        this.adoptInspection(record, inspection)
        if (this.inspectionHealthy(inspection)) return this.sessions.get(record.sessionId) ?? record
        this.markFailed(record)
        throw new SessionEnsureError(inspection.error
          ? `The node could not prepare the ${label} Session: ${inspection.error}`
          : `The node could not prepare the ${label} Session`)
      }
      // The node has no such Session: the command really did not create it.
      this.markFailed(record)
      throw error
    }
    // No inspection capability: keep a node-reported fact (including a reported failure), otherwise fail explicitly.
    const current = this.sessions.get(record.sessionId) ?? record
    if (current.status === 'failed' || isNodeConfirmed(current.status)) {
      this.persist(current)
      return current
    }
    this.markFailed(current)
    throw error
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
  private inspectOverProtocol(sessionId: string): Promise<SessionInspection | undefined> {
    const requestId = this.uniqueKey('session-inspect', sessionId)
    return new Promise<SessionInspection | undefined>(resolve => {
      const finish = (inspection?: SessionInspection): void => {
        clearTimeout(timer)
        this.pendingInspections.delete(requestId)
        resolve(inspection)
      }
      const timer = setTimeout(() => finish(), this.options.inspectionTimeoutMs ?? 500)
      this.pendingInspections.set(requestId, inspection => finish(inspection))
      void this.options.node.send({ ...this.base(requestId), type: 'session.inspect', sessionId })
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

  private workspacePath(workspace: string): string {
    if (!isAbsolute(workspace)) throw new Error('A workspace path must be absolute')
    const root = resolve(this.options.workspaceRoot)
    const path = resolve(workspace)
    const relativePath = relative(root, path)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error('The workspace must be inside the control plane workspace root')
    }
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
      else if (ticket.assignments.at(-1)?.id === assignmentId) this.engine.report(ticketId, { state: 'failed', summary: error })
    } catch {
      // The Ticket ended or changed meanwhile: the failure no longer has a live record to update.
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
      nodeId: this.options.nodeId }, this.options.secret, this.options.tokenTtlSeconds ?? 3600)
  }

  private receive(event: NodeEvent): void {
    this.events.push(event)
    if (event.type === 'node.status') {
      this.nodes.set(event.nodeId, event.status)
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
    }
    this.persist(record)
    this.notifyStatusWaiters(record.sessionId)
  }
}
