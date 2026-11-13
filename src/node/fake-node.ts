import { mkdirSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import {
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
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type PendingNodeEvent = DistributiveOmit<NodeEvent, 'seq' | 'at'>
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

  private readonly options: FakeNodeOptions
  private readonly idempotencyKeys = new Map<string, true>()
  private readonly listeners = new Set<(event: NodeEvent) => void>()
  private seq = 0

  constructor(options: FakeNodeOptions) {
    this.options = options
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
          ...(registration.capabilities === undefined
            ? {}
            : { capabilities: registration.capabilities }),
        }
        this.emitNodeStatus(status)
        break
      }

      case 'node.heartbeat':
        this.emitNodeStatus(command.status)
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
          backendSessionId: `fake-${command.sessionId}`,
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
          backendSessionId: `fake-${command.sessionId}`,
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

      case 'session.message': {
        const session = this.requireSession(command.sessionId)
        if (session.status === 'archived' || session.status === 'stopped') {
          throw new Error(`session ${command.sessionId} is ${session.status}`)
        }

        const texts = this.messages.get(command.sessionId) ?? []
        texts.push(command.text)
        this.messages.set(command.sessionId, texts)

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
    return {
      sessionId,
      found: true,
      status: session.status,
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
    const root = resolve(this.options.root)
    const target = resolve(root, workspace)
    const escaped = relative(root, target)
    if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
      throw new Error(`workspace escapes node root: ${workspace}`)
    }
    return target
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }
}
