/**
 * A `NodePort` over a real DSH-backed node: the protocol's commands become narrow `DshPortHost` calls, and the host's
 * Session events become protocol events stamped with this node's identity and ordering. It imports no DSH module, so the
 * command and event mapping stays testable with a fake host; only `dsh-port-host.ts` names `@deepseek-ai/*`.
 */
import { mkdirSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeEvent, type NodePort, type NodeStatus, type SessionInspection,
  type SessionRole } from '../shared/protocol.ts'
import { NodeCommandError, validateNodeCommand } from './command-validation.ts'

/** Omits a field from each member of a union, so a discriminated command or event keeps its narrowing. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * One event the host reports, before the port stamps its envelope.
 *
 * The host knows the Session it watched and what the backend did; the port owns the protocol version, the node id, the
 * per-node `seq` and the timestamp, so a host cannot forge ordering or identity. `projectId`, `role` and `assignmentId`
 * are optional: the port fills them from the Sessions it created, and a host may supply them when it knows better.
 */
export type DshPortEvent = DistributiveOmit<NodeEvent,
  'protocolVersion' | 'nodeId' | 'projectId' | 'role' | 'assignmentId' | 'seq' | 'at'> & {
  projectId?: string
  role?: SessionRole
  assignmentId?: string
}

/**
 * Everything the port needs from the node behind it, as narrow calls.
 *
 * The port never holds a DSH Context or an Agent: it turns one command into one host call and republishes the host's
 * events, so a test drives the whole mapping with a fake host.
 */
export interface DshPortHost {
  /**
   * Resolve or create a Session in `workspace`, install the role prompt once when there is one, and — when the host
   * knows a control URL — register the control-plane proxy tools that call it with `sessionToken`.
   */
  ensureSession(input: { sessionId: string; workspace: string; title: string; role: 'pm' | 'worker'; prompt?: string
    /** The control plane's short-lived token; the host hands it to the proxy tools, never to the prompt. */
    sessionToken: string
    /** The Ticket a Worker Session executes, when the command names one. */
    ticketId?: string
    /** The Assignment a Worker Session executes. */
    assignmentId?: string }): Promise<void>
  /** Deliver `text` to the Session's next turn, once per idempotency key; rejects when the backend refused it. */
  promptSession(sessionId: string, idempotencyKey: string, text: string): Promise<void>
  /** Cancel the Session's current turn, keeping messages it has not claimed yet. */
  cancelSession(sessionId: string): void
  /** Archive the Session with the host; rejects when the archive did not happen. */
  archiveSession(sessionId: string): Promise<void>
  /** Report what the host knows about one Session, without changing it. */
  inspectSession(sessionId: string): Promise<SessionInspection>
  /** Set the Session's permission preset by name. */
  setPermission(sessionId: string, permission: string): void
  /** Report the Session events the host observes; returns the disposer that stops reporting. */
  onEvent(listener: (event: DshPortEvent) => void): () => void
  /** The node's live status, which the port stamps `online` and `at` on when a command asks for it. */
  nodeStatus(): NodeStatus
}

export interface DshNodePortOptions {
  /** The node behind this port. */
  host: DshPortHost
  /** Stable id of the node; every event carries it and the control plane routes by it. */
  nodeId: string
  /** Absolute node root; no command may name a workspace outside it. */
  root: string
  /** Clock for event and status timestamps; tests pin it. */
  now?: () => string
}

/**
 * Resolves `workspace` against the node root and refuses anything outside it.
 *
 * The check is lexical: a workspace escaping through `..` or an absolute path is rejected before any directory is
 * created, so a bad command cannot make the node write outside its root. A workspace equal to the root is allowed.
 */
export function nodeWorkspace(root: string, workspace: string): string {
  const base = resolve(root)
  const target = resolve(base, workspace)
  const escaped = relative(base, target)
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`Workspace escapes the node root: ${workspace}`)
  }
  return target
}

/**
 * The `NodePort` a DSH node exposes over HTTP.
 *
 * It executes each command at most once per idempotency key (a duplicate arriving during the run awaits that same run),
 * maps commands onto the host, and republishes the host's Session events with a monotonically increasing `seq`. It
 * reports no Session status of its own except the archive fact it performed: every other status comes from the backend.
 */
export class DshNodePort implements NodePort {
  private readonly host: DshPortHost
  private readonly nodeId: string
  private readonly root: string
  private readonly now: () => string
  /** Keys of commands that already completed successfully; a repeated key is acknowledged without a second host call. */
  private readonly done = new Set<string>()
  /**
   * Commands still running, by key. A duplicate arriving while its key is here awaits the same Promise instead of calling
   * the host again; a failed run leaves `done` untouched, so the control plane may retry the key.
   */
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(event: NodeEvent) => void>()
  /**
   * What the port knows about the Sessions it created, so their events carry the right Project, role and Assignment.
   * The port records a Session before `ensure` runs, because DSH reports its creation while `ensure` is still pending.
   */
  private readonly sessions = new Map<string, { projectId: string; role: SessionRole; assignmentId?: string }>()
  /** The single host subscription the port holds while at least one listener is attached. */
  private disposeEvents?: () => void
  private seq = 0

  constructor(options: DshNodePortOptions) {
    if (!options.nodeId) throw new Error('A node id is required')
    if (!options.root) throw new Error('A node root is required')
    this.host = options.host
    this.nodeId = options.nodeId
    this.root = resolve(options.root)
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /**
   * Executes each command at most once per idempotency key, including when a duplicate arrives during the run.
   *
   * A key that already completed resolves at once, while a key still running resolves on the very same Promise, so two
   * copies of one command cannot reach the host twice. The mapping starts on the next microtask, after `inflight` holds
   * the key; only a run that succeeded joins `done`, keeping a failed key retryable. A command that is malformed at
   * runtime is refused before the key is even looked at: a type the union does not cover must never be acknowledged.
   */
  send(command: NodeCommand): Promise<void> {
    try {
      validateNodeCommand(command)
    } catch (error) {
      // A rejected Promise, not a throw: the port promises a Promise and the HTTP facade reports its message.
      return Promise.reject(error)
    }
    const key = command.idempotencyKey
    if (this.done.has(key)) return Promise.resolve()
    const running = this.inflight.get(key)
    if (running) return running

    const execution = Promise.resolve().then(async () => {
      try {
        await this.execute(command)
        this.done.add(key)
      } catch (error) {
        // A refusal keeps the code the validator or a host raised; an unexpected backend failure becomes the node's 5xx.
        throw error instanceof NodeCommandError ? error : new NodeCommandError('execution-failed',
          error instanceof Error ? error.message : String(error), { cause: error })
      } finally {
        this.inflight.delete(key)
      }
    })
    // Recorded before the mapping runs: the command body begins on the next microtask, not inside this call.
    this.inflight.set(key, execution)
    return execution
  }

  /** Answers one Session's state for an in-process caller; the HTTP transport asks through `session.inspect` instead. */
  inspect(sessionId: string): Promise<SessionInspection> {
    return this.host.inspectSession(sessionId)
  }

  /** Runs one command's mapping against the host, once per key until a failed run is retried. */
  private async execute(command: NodeCommand): Promise<void> {
    switch (command.type) {
      case 'node.register':
        this.publish({ sessionId: '', role: 'pm', type: 'node.status', status: this.status(true) })
        break

      case 'node.heartbeat':
        this.publish({ sessionId: '', role: 'pm', type: 'node.status', status: this.status(command.status.online) })
        break

      // Both commands name the directory a Project's Sessions work in; the node only creates it under its own root.
      case 'workspace.ensure':
      case 'project.bind':
        mkdirSync(this.workspaceOf(command.workspace), { recursive: true, mode: 0o700 })
        break

      case 'pm.ensure': {
        const workspace = this.workspaceOf(command.workspace)
        mkdirSync(workspace, { recursive: true, mode: 0o700 })
        this.sessions.set(command.sessionId, { projectId: command.project.id, role: 'pm' })
        await this.host.ensureSession({ sessionId: command.sessionId, workspace, title: command.project.title,
          role: 'pm', prompt: command.profile.prompt, sessionToken: command.sessionToken })
        break
      }

      case 'worker.create': {
        const workspace = this.workspaceOf(command.workspace)
        mkdirSync(workspace, { recursive: true, mode: 0o700 })
        this.sessions.set(command.sessionId, { projectId: command.projectId, role: 'worker',
          assignmentId: command.assignmentId })
        // The control plane sends the role prompt here by default and a Ticket's own prompt otherwise; either way it is
        // the Session's first message, so an empty one falls back to the profile's.
        await this.host.ensureSession({ sessionId: command.sessionId, workspace, title: `Worker ${command.ticketId}`,
          role: 'worker', prompt: command.prompt || command.profile.prompt, sessionToken: command.sessionToken,
          ticketId: command.ticketId, assignmentId: command.assignmentId })
        break
      }

      case 'session.message':
        // The host's queue is idempotent per key, and awaiting it is what lets a refused delivery fail the command.
        await this.host.promptSession(command.sessionId, command.idempotencyKey, command.text)
        break

      case 'session.cancel':
        this.host.cancelSession(command.sessionId)
        break

      case 'session.archive':
        await this.host.archiveSession(command.sessionId)
        // The host acknowledged only after the archive was durable, so the status is a fact the port itself performed.
        this.publish({ type: 'session.status', sessionId: command.sessionId, status: 'archived' })
        break

      case 'session.inspect': {
        const inspection = await this.host.inspectSession(command.sessionId)
        // The request id echoes the key so the asking transport can match the answer to its request.
        this.publish({ type: 'session.inspected', sessionId: command.sessionId,
          requestId: command.idempotencyKey, inspection })
        break
      }

      case 'permission.set':
        this.host.setPermission(command.sessionId, command.permission)
        break
    }
  }

  /** Resolves a command's workspace, reporting a path outside the node root as an invalid command rather than a failure. */
  private workspaceOf(workspace: string): string {
    try {
      return nodeWorkspace(this.root, workspace)
    } catch (error) {
      throw new NodeCommandError('invalid-command', error instanceof Error ? error.message : String(error), { cause: error })
    }
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    this.listeners.add(listener)
    // One host subscription serves every listener: the first listener attaches it and the last one detaches it.
    this.disposeEvents ??= this.host.onEvent(event => { this.publish(event) })
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.disposeEvents?.()
        this.disposeEvents = undefined
      }
    }
  }

  /** Stamps one event with this node's envelope, then hands it to every listener. */
  private publish(event: DshPortEvent): void {
    const known = this.sessions.get(event.sessionId)
    const assignmentId = event.assignmentId ?? known?.assignmentId
    // A cast, because spreading a union widens the discriminated payload; the envelope fields below are what the
    // protocol requires and what the cast restores.
    const full = {
      ...event,
      protocolVersion: NODE_PROTOCOL_VERSION,
      nodeId: this.nodeId,
      projectId: event.projectId ?? known?.projectId ?? '',
      role: event.role ?? known?.role ?? 'worker',
      seq: ++this.seq,
      at: this.now(),
      ...(assignmentId === undefined ? {} : { assignmentId }),
    } as NodeEvent
    for (const listener of [...this.listeners]) {
      try {
        listener(full)
      } catch {
        // A broken listener must not fail the command that produced the event; the transport removes it on close.
      }
    }
  }

  /** The node's live status with the liveness a register or heartbeat command asked for. */
  private status(online: boolean): NodeStatus {
    return { ...this.host.nodeStatus(), nodeId: this.nodeId, online, at: this.now() }
  }
}
