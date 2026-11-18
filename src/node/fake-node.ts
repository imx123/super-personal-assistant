import { mkdirSync } from 'node:fs'
import {
  NODE_CAPABILITY_TURN_INTERRUPT,
  NODE_PROTOCOL_VERSION,
  type NodeCommand,
  type NodeEvent,
  type NodePort,
  type NodeRegistration,
  type NodeStatus,
  type SessionInspection,
  type SessionRecord,
  type SessionRole,
  type SessionStatus,
} from '../shared/protocol.ts'
import { workspaceDirectory } from '../shared/workspace-path.ts'
import { reviewWorkspace, type ReviewDiffLimits } from './review-diff.ts'

/** The fields every Session event carries; the protocol's envelope is not exported directly. */
export interface NodeEventBase {
  protocolVersion: typeof NODE_PROTOCOL_VERSION
  nodeId: string
  sessionId: string
  projectId: string
  assignmentId?: string
  role: SessionRole
  seq: number
  at: string
}

export interface FakeNodeOptions {
  nodeId: string
  root: string
  now?: () => string
  /** The bounds of the read-only Git review this node offers; the defaults bound it tightly. */
  reviewDiff?: ReviewDiffLimits
  /**
   * The capabilities this node advertises.
   *
   * The default is what the fake really offers: it can interrupt one running turn of one Session. A test that needs an
   * older node passes `[]`, and the control plane then says plainly that the node cannot interrupt a turn.
   */
  capabilities?: readonly string[]
}

/** The omission of the keys of every member of a union, one member at a time. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** The event of the node, without the counters the fake itself writes. */
export type PendingNodeEvent = DistributiveOmit<NodeEvent, 'seq' | 'at'>
type EventEnvelopeFields = Omit<NodeEventBase, 'seq' | 'at'>

/** An in-process NodePort for the standalone kernel and tests; it records commands and emits ordered events. */
export class FakeNode implements NodePort {
  readonly sessions: Map<string, SessionRecord> = new Map()
  readonly messages: Map<string, string[]> = new Map()
  readonly permissions: Map<string, string> = new Map()
  readonly tokens: Map<string, string> = new Map()
  readonly workspaces: Map<string, string> = new Map()
  readonly commands: NodeCommand[] = []
  readonly events: NodeEvent[] = []
  readonly registrations: NodeRegistration[] = []
  /**
   * The turn each Session runs, and the messages that wait for the next one.
   *
   * The fake has no model, so a turn only exists when a test opens one with {@link holdTurn}: that is what lets a test
   * act on a Session that is running, interrupt the turn it runs, and watch the message that waits behind it.
   */
  private readonly turns = new Map<string, { current?: number; counter: number }>()
  private readonly pending = new Map<string, { text: string; inputIds: string[] }[]>()

  private readonly options: FakeNodeOptions
  private readonly idempotencyKeys = new Map<string, true>()
  private readonly listeners = new Set<(event: NodeEvent) => void>()
  private seq = 0

  constructor(options: FakeNodeOptions) {
    this.options = options
  }

  /**
   * The capabilities this node reports.
   *
   * The fake's own capabilities are always part of the answer: they are what it can really do, and a node that hides
   * them would make the control plane refuse an action the node would have carried out.
   */
  private capabilitiesOf(reported: readonly string[] | undefined): string[] {
    const own = this.options.capabilities ?? [NODE_CAPABILITY_TURN_INTERRUPT]
    return [...new Set([...own, ...(reported ?? [])])]
  }

  async send(command: NodeCommand): Promise<void> {
    if (command.protocolVersion !== NODE_PROTOCOL_VERSION) {
      throw new Error(`unsupported protocol version: ${String(command.protocolVersion)}`)
    }
    if (this.idempotencyKeys.has(command.idempotencyKey)) {
      return
    }

    this.commands.push(command)

    switch (command.type) {
      case 'node.register': {
        this.registrations.push(command.registration)
        const registration = command.registration
        const status: NodeStatus = {
          nodeId: registration.nodeId,
          backend: registration.backend,
          version: registration.version,
          online: true,
          at: this.now(),
          capabilities: this.capabilitiesOf(registration.capabilities),
        }
        this.emitNodeStatus(status)
        break
      }

      case 'node.heartbeat':
        this.emitNodeStatus({ ...command.status, capabilities: this.capabilitiesOf(command.status.capabilities) })
        break

      case 'workspace.ensure': {
        const workspace = this.resolveWorkspace(command.workspace)
        mkdirSync(workspace, { recursive: true })
        this.workspaces.set(command.projectId, workspace)
        break
      }

      case 'project.bind': {
        const workspace = this.resolveWorkspace(command.workspace)
        this.workspaces.set(command.projectId, workspace)
        break
      }

      case 'pm.ensure': {
        const workspace = this.resolveWorkspace(command.workspace)
        const at = this.now()
        const session: SessionRecord = {
          sessionId: command.sessionId,
          // The fake mirrors the DSH host: the backend's own resume id is the Session id the host resolved, so a control
          // plane inspecting a created Session learns a real backend id rather than a placeholder.
          backendSessionId: command.sessionId,
          projectId: command.project.id,
          role: 'pm',
          nodeId: this.options.nodeId,
          workspace,
          status: 'idle',
          toolProfile: command.profile.name,
          createdAt: at,
          updatedAt: at,
        }
        this.sessions.set(session.sessionId, session)
        this.tokens.set(session.sessionId, command.sessionToken)
        this.emitSessionStatus(session, 'idle')
        break
      }

      case 'worker.create': {
        const workspace = this.resolveWorkspace(command.workspace)
        const at = this.now()
        const session: SessionRecord = {
          sessionId: command.sessionId,
          backendSessionId: command.sessionId,
          projectId: command.projectId,
          assignmentId: command.assignmentId,
          role: 'worker',
          nodeId: this.options.nodeId,
          workspace,
          status: 'idle',
          toolProfile: command.profile.name,
          createdAt: at,
          updatedAt: at,
        }
        this.sessions.set(session.sessionId, session)
        this.tokens.set(session.sessionId, command.sessionToken)
        this.emitSessionStatus(session, 'idle')
        break
      }

      // The Router: one Session of its own, bound to no Project. The fake keeps it apart from every Project's Sessions,
      // exactly as the real node does.
      case 'router.ensure': {
        const workspace = this.resolveWorkspace(command.workspace)
        const at = this.now()
        const session: SessionRecord = {
          sessionId: command.sessionId,
          backendSessionId: command.sessionId,
          projectId: '',
          role: 'router',
          nodeId: this.options.nodeId,
          workspace,
          status: 'idle',
          toolProfile: command.profile.name,
          createdAt: at,
          updatedAt: at,
        }
        this.sessions.set(session.sessionId, session)
        this.tokens.set(session.sessionId, command.sessionToken)
        this.emitSessionStatus(session, 'idle')
        break
      }

      case 'session.message': {
        const session = this.requireSession(command.sessionId)
        if (session.status === 'archived' || session.status === 'stopped') {
          throw new Error(`session ${command.sessionId} is ${session.status}`)
        }
        // The optional token is only passed through, but the fake keeps it as the latest one the way a real node would.
        if (command.sessionToken !== undefined) this.tokens.set(command.sessionId, command.sessionToken)

        const texts = this.messages.get(command.sessionId) ?? []
        texts.push(command.text)
        this.messages.set(command.sessionId, texts)

        // A Session that runs a turn takes the message for the next one: the message waits in the inbox and the turn
        // that follows reads it. This is what a real backend's next-turn queue does.
        if (this.turnOf(command.sessionId).current !== undefined) {
          this.pendingOf(command.sessionId).push({ text: command.text, inputIds: [...(command.inputIds ?? [])] })
          break
        }

        this.transitionSession(session, 'running')
        this.emit({
          ...this.sessionEnvelope(session),
          type: 'session.event',
          kind: 'message',
          data: { text: command.text },
        })
        this.transitionSession(session, 'idle')
        break
      }

      // The interrupt ends the turn the Session runs and nothing else: the Session keeps its identity, and the messages
      // that wait for the next turn stay in the inbox.
      case 'session.interrupt': {
        const session = this.requireSession(command.sessionId)
        if (session.status === 'archived' || session.status === 'stopped') {
          throw new Error(`session ${command.sessionId} is ${session.status}`)
        }
        const turn = this.turnOf(command.sessionId)
        if (turn.current === undefined) {
          throw new Error(`Session ${command.sessionId} has no running turn to interrupt`)
        }
        // A turn that started after the request is not the turn the request named: the wrong turn is never ended.
        if (command.turn !== undefined && command.turn !== turn.current) {
          throw new Error(`Session ${command.sessionId} is running turn ${turn.current}, not turn ${command.turn}; `
            + 'it was not interrupted')
        }
        const ended = turn.current
        turn.current = undefined
        this.emit({
          ...this.sessionEnvelope(session),
          type: 'session.event',
          kind: 'turn-end',
          data: { turn: ended, reason: 'aborted', cause: 'user' },
        })
        this.transitionSession(session, 'idle')
        // The messages that waited behind the interrupted turn run in the turn that follows it.
        this.runPending(session)
        break
      }

      case 'session.cancel': {
        const session = this.sessions.get(command.sessionId)
        if (!session || session.status === 'stopped' || session.status === 'archived') {
          break
        }
        this.transitionSession(session, 'stopped')
        break
      }

      case 'session.archive': {
        const session = this.sessions.get(command.sessionId)
        if (!session || session.status === 'archived') {
          break
        }
        const at = this.now()
        session.status = 'archived'
        session.archivedAt = at
        session.updatedAt = at
        this.emitSessionStatus(session, 'archived')
        break
      }

      case 'session.inspect': {
        const inspection = this.inspectOf(command.sessionId)
        const session = this.sessions.get(command.sessionId)
        this.emit({
          protocolVersion: NODE_PROTOCOL_VERSION,
          nodeId: this.options.nodeId,
          sessionId: command.sessionId,
          projectId: session?.projectId ?? '',
          role: session?.role ?? 'worker',
          ...(session?.assignmentId === undefined ? {} : { assignmentId: session.assignmentId }),
          type: 'session.inspected',
          requestId: command.idempotencyKey,
          inspection,
        })
        break
      }

      case 'permission.set': {
        const session = this.sessions.get(command.sessionId)
        if (!session) {
          break
        }
        this.permissions.set(command.sessionId, command.permission)
        this.emit({
          ...this.sessionEnvelope(session),
          type: 'session.event',
          kind: 'message',
          data: { text: `permission:${command.permission}` },
        })
        break
      }

      // The read-only review of a Project's workspace. The fake reads the workspace it bound to that Project with the
      // same reader the real node uses, so a test exercises the real Git boundary without a DSH node.
      case 'review.diff': {
        const workspace = this.workspaces.get(command.projectId)
        const result = workspace === undefined
          ? { status: 'refused' as const, reason: 'This node holds no workspace for the Project' }
          : await reviewWorkspace({ workspace, root: this.options.root, ...(this.options.reviewDiff ?? {}) })
        this.emit({
          protocolVersion: NODE_PROTOCOL_VERSION,
          nodeId: this.options.nodeId,
          sessionId: '',
          projectId: command.projectId,
          role: 'pm',
          type: 'review.diff',
          requestId: command.idempotencyKey,
          result,
        })
        break
      }
    }

    this.idempotencyKeys.set(command.idempotencyKey, true)
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Answer an explicit status query from the Sessions this node actually holds. */
  async inspect(sessionId: string): Promise<SessionInspection> {
    return this.inspectOf(sessionId)
  }

  /** The shape both `inspect` and the `session.inspect` command answer with. */
  private inspectOf(sessionId: string): SessionInspection {
    const session = this.sessions.get(sessionId)
    if (!session) return { sessionId, found: false }
    // The turn the Session runs right now: the fake's own fact, so an inspection names the turn an interrupt may end.
    const turn = this.turns.get(sessionId)?.current
    return {
      sessionId,
      found: true,
      status: session.status,
      ...(turn === undefined ? {} : { turn }),
      ...(session.backendSessionId === undefined ? {} : { backendSessionId: session.backendSessionId }),
    }
  }

  simulateToolCall(sessionId: string, tool: string, args: Record<string, unknown>): void {
    const session = this.requireSession(sessionId)
    this.emit({
      ...this.sessionEnvelope(session),
      type: 'tool.call',
      tool,
      args,
      toolCallId: `fake-tool-${this.seq + 1}`,
    })
  }

  /**
   * Report one refusal of the node's own tool guard, as the node reports it.
   *
   * The fake has no tool guard of its own, so a test that needs one writes the fact here: the tool that was refused, the
   * reason code the guard decided, the turn the call was made in and the identity of the call itself. The turn is the one
   * the Session really runs, so a fact is always about the work that runs now.
   *
   * The node id, the backend and the Assignment may be named as well, so a test can write a fact of another node, of
   * another backend or of another Assignment and see it refused.
   */
  simulateGuardDenial(sessionId: string, toolName: string, reasonCode: string, options: {
    /** The turn the call was made in; the Session's own running turn when it is not named. */
    turnId?: string
    /** The identity of the call; a fresh one when it is not named. */
    callId?: string
    /** The node the fact claims to come from. */
    nodeId?: string
    /** The backend the fact claims to come from. */
    backend?: string
    /** The Assignment the fact claims to be about. */
    assignmentId?: string
  } = {}): void {
    const session = this.requireSession(sessionId)
    const turn = options.turnId ?? this.turns.get(sessionId)?.current
    const callId = options.callId ?? `fake-guard-${this.seq + 1}`
    const envelope = this.sessionEnvelope(session)
    this.emit({
      ...envelope,
      nodeId: options.nodeId ?? envelope.nodeId,
      ...(options.assignmentId === undefined ? {} : { assignmentId: options.assignmentId }),
      type: 'session.event',
      kind: 'guard.denial',
      data: { toolName, reasonCode, ...(turn === undefined ? {} : { turnId: String(turn) }),
        callId, backend: options.backend ?? 'dsh' },
    })
  }

  /**
   * Report the facts of one tool call, as the node reports them.
   *
   * The fake has no backend that makes tool calls, so a test that needs one writes the fact here: the tool's name, how
   * the call ended, the identity of the call and — for a call that changed a file — the relative path it changed. The
   * turn is the one the Session really runs, so a fact is always about the work that runs now.
   */
  simulateToolFact(sessionId: string, toolName: string, outcome: 'succeeded' | 'failed', options: {
    /** The turn the call was made in; the Session's own running turn when it is not named. */
    turnId?: string
    /** The identity of the call; a fresh one when it is not named. */
    callId?: string
    /** The relative paths the call changed, when it changed files. */
    changedPaths?: readonly string[]
  } = {}): void {
    const session = this.requireSession(sessionId)
    const turn = options.turnId ?? this.turns.get(sessionId)?.current
    const callId = options.callId ?? `fake-tool-fact-${this.seq + 1}`
    this.emit({
      ...this.sessionEnvelope(session),
      type: 'tool.fact',
      fact: {
        toolName,
        outcome,
        callId,
        ...(turn === undefined ? {} : { turnId: String(turn) }),
        backend: 'dsh',
        ...(options.changedPaths === undefined ? {} : { changedPaths: [...options.changedPaths] }),
      },
    })
  }

  /**
   * Report one event exactly as the test writes it.
   *
   * The control plane has to refuse an event of another node, of another role or of another Assignment, and a test needs
   * to be able to say so: this reports the envelope the test wrote, without the fake's own.
   */
  simulateEvent(event: PendingNodeEvent): void {
    this.emit(event)
  }

  /**
   * Open a turn the Session keeps running, and report the turn's number.
   *
   * The fake has no model, so a turn exists only when a test opens one: that is what lets a test act on a Session that
   * is running — interrupt the turn it runs, or send a message that has to wait for the next turn.
   */
  holdTurn(sessionId: string): number {
    const session = this.requireSession(sessionId)
    const turn = this.turnOf(sessionId)
    turn.current = ++turn.counter
    this.transitionSession(session, 'running')
    this.emit({
      ...this.sessionEnvelope(session),
      type: 'session.event',
      kind: 'turn-start',
      data: { turn: turn.current },
    })
    return turn.current
  }

  /** End the turn the Session runs, and let the messages that waited behind it run in the turn that follows. */
  releaseTurn(sessionId: string): void {
    const session = this.requireSession(sessionId)
    const turn = this.turnOf(sessionId)
    if (turn.current === undefined) return
    const ended = turn.current
    turn.current = undefined
    this.emit({
      ...this.sessionEnvelope(session),
      type: 'session.event',
      kind: 'turn-end',
      data: { turn: ended, reason: 'completed' },
    })
    this.transitionSession(session, 'idle')
    this.runPending(session)
  }

  /** The turn state of one Session, created on demand. */
  private turnOf(sessionId: string): { current?: number; counter: number } {
    let turn = this.turns.get(sessionId)
    if (!turn) { turn = { counter: 0 }; this.turns.set(sessionId, turn) }
    return turn
  }

  /** The messages that wait for the Session's next turn, created on demand. */
  private pendingOf(sessionId: string): { text: string; inputIds: string[] }[] {
    let waiting = this.pending.get(sessionId)
    if (!waiting) { waiting = []; this.pending.set(sessionId, waiting) }
    return waiting
  }

  /** Run the messages that waited behind a turn, in the turn that follows it. */
  private runPending(session: SessionRecord): void {
    const waiting = this.pending.get(session.sessionId)
    if (!waiting || waiting.length === 0) return
    this.pending.delete(session.sessionId)
    const turn = this.turnOf(session.sessionId)
    const number = ++turn.counter
    turn.current = number
    this.transitionSession(session, 'running')
    this.emit({
      ...this.sessionEnvelope(session),
      type: 'session.event',
      kind: 'turn-start',
      data: { turn: number, inputIds: waiting.flatMap(message => message.inputIds) },
    })
    for (const message of waiting) {
      this.emit({
        ...this.sessionEnvelope(session),
        type: 'session.event',
        kind: 'message',
        data: { text: message.text },
      })
    }
    turn.current = undefined
    this.emit({
      ...this.sessionEnvelope(session),
      type: 'session.event',
      kind: 'turn-end',
      data: { turn: number, reason: 'completed' },
    })
    this.transitionSession(session, 'idle')
  }

  /**
   * Report one message of a Session, as a backend would.
   *
   * The fake has no model, so a test that needs the other side of a conversation reports it here: `role: 'assistant'` is
   * what a model's own answer looks like, and `role: 'user'` what a person's message looks like. The control plane reads
   * both from the event log, so a console shows the same conversation it would show against a real node.
   */
  simulateMessage(sessionId: string, role: 'user' | 'assistant', text: string): void {
    const session = this.requireSession(sessionId)
    this.emit({
      ...this.sessionEnvelope(session),
      type: 'session.event',
      kind: 'message',
      data: { role, text },
    })
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`unknown session: ${sessionId}`)
    }
    return session
  }

  private sessionEnvelope(session: SessionRecord): EventEnvelopeFields {
    return {
      protocolVersion: NODE_PROTOCOL_VERSION,
      nodeId: this.options.nodeId,
      sessionId: session.sessionId,
      projectId: session.projectId,
      role: session.role,
      ...(session.assignmentId === undefined ? {} : { assignmentId: session.assignmentId }),
    }
  }

  private transitionSession(session: SessionRecord, status: SessionStatus): void {
    session.status = status
    session.updatedAt = this.now()
    this.emitSessionStatus(session, status)
  }

  private emitSessionStatus(session: SessionRecord, status: SessionStatus): void {
    this.emit({
      ...this.sessionEnvelope(session),
      type: 'session.status',
      status,
    })
  }

  private emitNodeStatus(status: NodeStatus): void {
    this.emit({
      protocolVersion: NODE_PROTOCOL_VERSION,
      nodeId: this.options.nodeId,
      sessionId: '',
      projectId: '',
      role: 'pm',
      type: 'node.status',
      status,
    })
  }

  private emit(event: PendingNodeEvent): void {
    const fullEvent = {
      ...event,
      seq: ++this.seq,
      at: this.now(),
    } as NodeEvent

    this.events.push(fullEvent)
    for (const listener of [...this.listeners]) {
      listener(fullEvent)
    }
  }

  private resolveWorkspace(workspace: string): string {
    return workspaceDirectory(this.options.root, workspace, `workspace escapes node root: ${workspace}`)
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }
}
