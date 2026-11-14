/** Standalone control-plane kernel: domain state, PM/Worker Session records, and a NodePort. No DSH imports. */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Store } from '../app/store.ts'
import { assignmentStopped, latestAssignment, runningAssignment, waitsForPerson, type Assignment,
  type AssignmentState, type ProjectProfile, type ProjectReport, type ProjectTicketTask, type Ticket,
  type TicketInput, type WorkerReport } from '../core/index.ts'
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

/** The interval the standalone control plane keeps its node's liveness fresh with when nothing else is configured. */
const DEFAULT_HEARTBEAT_MS = 10_000

/**
 * How long after its expiry a Session token may still rotate itself through the refresh route.
 *
 * Five minutes covers the gap between a long tool call starting and the node's proxy noticing a 401, without turning an
 * expired bearer credential into a second class of long-lived credential: ordinary tool and message routes never use it.
 */
export const DEFAULT_TOKEN_REFRESH_GRACE_SECONDS = 300

/** Statuses a Session has finished in for good: a node generation change must not reopen one of them. */
const SESSION_TERMINAL: ReadonlySet<SessionStatus> = new Set(['stopped', 'archived'])

function isNodeConfirmed(status: SessionStatus): boolean {
  return NODE_CONFIRMED.has(status)
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
  /** How long an explicit `session.inspect` waits for the node's answer. */
  inspectionTimeoutMs?: number
  /**
   * Default period of the periodic heartbeat `startHeartbeat` runs; the standalone control plane starts it after a
   * successful registration. The loop is opt-in so an in-process kernel owns no timer it did not ask for.
   */
  heartbeatIntervalMs?: number
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
  /** Callbacks waiting for the next node status of one Session, so an async event can settle an ensure. */
  private readonly statusWaiters = new Map<string, Set<() => void>>()
  /** Answers expected for an explicit `session.inspect`, keyed by its request id. */
  private readonly pendingInspections = new Map<string, (inspection: SessionInspection) => void>()
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
  /** The highest event `seq` recorded, so an event this kernel synthesizes sorts after every received one. */
  private lastEventSeq = 0
  private sequence = 0
  private closed = false
  /**
   * The grace the refresh route gives an expired token; resolved once so a bad configuration cannot disable it per request.
   * Ordinary tool routes never read it.
   */
  readonly tokenRefreshGraceSeconds: number

  constructor(private readonly options: ControlPlaneOptions) {
    this.tokenRefreshGraceSeconds = refreshGraceSeconds(options.sessionTokenRefreshGraceSeconds)
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
        sendMessage: (sessionId, text, inputIds) => this.sendMessage(sessionId, text, inputIds),
        cancelSession: (sessionId, reason) => this.cancelSession(sessionId, reason),
        assignmentStarted: (ticketId, assignmentId) => { this.engine.assignmentStarted(ticketId, assignmentId) },
        assignmentFailed: (ticketId, assignmentId, error) => { this.assignmentFailed(ticketId, assignmentId, error) },
        taskPrompt: ticket => this.taskPrompt(ticket),
        inputsDelivered: (ticketId, assignmentId, inputIds) => {
          this.engine.inputsDelivered(ticketId, assignmentId, inputIds)
        },
        inputText: input => this.inputText(input),
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
      role: 'pm', seq: this.nextEventSeq(), at: status.at, type: 'node.status', status }
    this.receive(event)
  }

  /** The next id for a synthesized event; always above every event received so far. */
  private nextEventSeq(): number {
    return ++this.lastEventSeq
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

  /** Create a worker Session for an Assignment; the caller records the Assignment in the domain separately. */
  async createWorkerSession(projectId: string, assignmentId: string, ticketId: string, prompt: string = WORKER_PROFILE.prompt): Promise<SessionRecord> {
    const project = this.store.projects.get(projectId)
    if (!project) throw new Error(`Unknown project ${projectId}`)
    this.requireNodeOnline()
    const sessionId = `worker-${assignmentId}`
    const pending = this.pendingEnsures.get(sessionId)
    if (pending) return pending
    const existing = this.sessions.get(sessionId)
    if (existing && isNodeConfirmed(existing.status) && !this.needsReensure(existing)) return existing
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
    // Same rule as the PM: a confirmed Session from an older generation is re-ensured under the same id.
    const stale = existing !== undefined && this.needsReensure(existing)
    if (existing && !stale && isNodeConfirmed(existing.status)) return existing
    if (existing && !stale) {
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

  async sendMessage(sessionId: string, text: string, inputIds?: readonly string[]): Promise<void> {
    let record = this.requireSession(sessionId)
    if (record.status === 'archived' || record.status === 'stopped') throw new Error(`Session ${sessionId} is not running`)
    this.requireNodeOnline()
    // A node restart leaves the record confirmed under an older generation while its Agent is gone; the node would refuse
    // the message as "session not loaded" and fail the Assignment. Ensure the Session first, then re-read the record: the
    // ensure re-issues the token and may settle on a status newer than the one read here.
    if (!this.isCurrentGeneration(record)) {
      await this.ensureForMessage(record)
      record = this.requireSession(sessionId)
    }
    const token = this.tokens.get(sessionId) ?? this.issueToken(record)
    this.tokens.set(sessionId, token)
    await this.options.node.send({ ...this.base(this.uniqueKey('message', sessionId)), type: 'session.message', sessionId, text,
      sessionToken: token, ...(inputIds && inputIds.length ? { inputIds } : {}) })
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
    if (record.role !== 'worker') return
    const assignmentId = record.assignmentId
    if (assignmentId === undefined || assignmentId === '') {
      throw new SessionEnsureError(`The Worker Session ${record.sessionId} has no Assignment to re-ensure`)
    }
    // The Ticket only names the Worker's title and prompt; an Assignment whose Ticket is gone still has an id to use.
    const ticketId = this.ticketOfAssignment(assignmentId)?.id ?? assignmentId
    await this.createWorkerSession(record.projectId, assignmentId, ticketId)
  }

  async cancelSession(sessionId: string, reason?: string): Promise<void> {
    this.requireSession(sessionId)
    this.requireNodeOnline()
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
  }

  async setPermission(sessionId: string, permission: string): Promise<void> {
    this.requireSession(sessionId)
    this.requireNodeOnline()
    await this.options.node.send({ ...this.base(this.uniqueKey('permission', sessionId)), type: 'permission.set', sessionId, permission })
  }

  state(): ControlPlaneState {
    return { nodeId: this.options.nodeId, nodes: Object.fromEntries(this.nodes), projects: this.projects(), tickets: this.tickets(),
      sessions: [...this.sessions.values()], events: this.events.length }
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
    this.unsubscribe()
    this.eventListeners.clear()
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
   * though: a generation change must not silently reopen one, so those records are returned as they are.
   */
  private needsReensure(record: SessionRecord): boolean {
    return isNodeConfirmed(record.status) && !SESSION_TERMINAL.has(record.status) && !this.isCurrentGeneration(record)
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
  }

  /**
   * Record one node event, apply it to the kernel's state, then announce it to every subscriber.
   *
   * The event enters `events` before anything else, so a listener — and a reconnecting client replaying by `seq` —
   * always sees the same history the kernel does. A failure while applying the event still announces it: the fact the
   * node reported is worth showing even when one of its consequences is refused.
   */
  private receive(event: NodeEvent): void {
    this.events.push(event)
    if (event.seq > this.lastEventSeq) this.lastEventSeq = event.seq
    try {
      this.applyEvent(event)
    } finally {
      this.notifyEvent(event)
    }
  }

  /** Fold one received event into the kernel's state: node liveness, the Session record and the Engine's facts. */
  private applyEvent(event: NodeEvent): void {
    if (event.type === 'node.status') {
      this.applyNodeStatus(event.status)
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
}
