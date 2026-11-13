/**
 * The contract between the control plane and one execution node.
 *
 * The control plane owns business state (Project, Ticket, Assignment, authorization, audit); a node
 * only runs Sessions and reports facts. Backend-neutral on purpose: the same contract describes DSH
 * today and a Claude Code or Codex adapter later, so this module imports nothing — no `@deepseek-ai/*`,
 * no `src/core`, no `src/app`.
 *
 * Tool names stay plain strings. A `RoleProfile` selects them; the protocol does not copy the control
 * plane's `PM_TOOLS` or `WORK_TOOLS`, and it does not know what any tool does.
 */

/** Bumped only when a command or event shape changes incompatibly. */
export const NODE_PROTOCOL_VERSION = 1

/**
 * The report states a Worker may submit through the control plane's tool API.
 *
 * `waiting` is the Executor's own state — recorded when a Worker's turn ends with nothing to do — and is never a claim a
 * Worker makes. The control plane's HTTP route and the node's `control_report` schema share this list so they cannot drift.
 */
export const WORKER_REPORT_STATES = ['progress', 'ready', 'blocked', 'failed', 'dropped'] as const
export type WorkerReportState = (typeof WORKER_REPORT_STATES)[number]

/** What a Session is for: a Project's PM, an Assignment's Worker, or read-only reconnaissance. */
export type SessionRole = 'pm' | 'worker' | 'scout'

/** The backend that actually runs a Session. */
export type BackendKind = 'dsh' | 'claude' | 'codex'

/** Lifecycle of one Session as the control plane tracks it. */
export type SessionStatus = 'starting' | 'idle' | 'running' | 'stopping' | 'stopped' | 'archived' | 'failed'

/**
 * The control plane's record of one Session.
 *
 * `sessionId` is the control-plane primary key: stable, backend-independent, and what tools, audit and
 * handoffs refer to. `backendSessionId` is the backend's own resume id (a DSH session id, a Claude
 * conversation id, a Codex thread id). It exists so a node can resume the same conversation after a
 * restart; it never replaces `sessionId` and is never accepted as one.
 */
export interface SessionRecord {
  sessionId: string
  backendSessionId?: string
  projectId: string
  assignmentId?: string
  role: SessionRole
  nodeId: string
  /** Absolute path of the Session's workspace on its node; a location, not an identity. */
  workspace: string
  status: SessionStatus
  /** `RoleProfile.name` the Session was created with. */
  toolProfile: string
  model?: string
  /** ISO 8601 timestamp with an explicit offset. */
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

/**
 * A reusable role definition the control plane sends when it creates a Session.
 *
 * `permission` is a control-plane tier, not a backend preset name: the node maps it onto whatever its
 * backend calls the same thing.
 */
export interface RoleProfile {
  /** Stable profile name, stored as `SessionRecord.toolProfile`. */
  name: string
  /** System prompt (or prompt template) the node installs for the Session. */
  prompt: string
  /** Tool names the role may call; the control plane owns the allowlist. */
  tools: readonly string[]
  /** Tool names explicitly denied; `deny` wins over `tools`. */
  deny: readonly string[]
  permission: string
  /** Model id within the backend; absent means the backend's or deployment's default. */
  model?: string
}

/** What a node announces when it registers; `nodeId` must match the command envelope. */
export interface NodeRegistration {
  protocolVersion: typeof NODE_PROTOCOL_VERSION
  nodeId: string
  backend: BackendKind
  version: string
  capabilities?: readonly string[]
}

/**
 * What a node reports when the control plane explicitly asks for one Session's state.
 *
 * `status` is the node's own fact, never the control plane's last event: a lost event or a lost command
 * acknowledgement leaves the control plane guessing, and this is the answer that replaces the guess. `ready`
 * says whether the role profile and its tools finished installing; a Session can be `idle` while `ensure` is
 * still failing, so a status alone is not proof that the command succeeded.
 */
export interface SessionInspection {
  sessionId: string
  /** False when the node has no Session with this id. */
  found: boolean
  /** The node's current status; present when `found`. */
  status?: SessionStatus
  /** The backend's own resume id, when the node knows it. */
  backendSessionId?: string
  /** Whether the role profile and tools finished installing; absent when the node does not track it. */
  ready?: boolean
  /** The installation or node error that left `ready` false. */
  error?: string
}

/** Liveness of a node from the control plane's point of view. */
export interface NodeStatus {
  nodeId: string
  backend: BackendKind
  version: string
  online: boolean
  /** ISO 8601 timestamp with an explicit offset. */
  at: string
  capabilities?: readonly string[]
}

/** Fields every command carries. */
interface CommandEnvelope {
  protocolVersion: typeof NODE_PROTOCOL_VERSION
  /** The node the command is addressed to. */
  nodeId: string
  /** Stable for one logical command; a node must execute a repeated key at most once. */
  idempotencyKey: string
  /** ISO 8601 timestamp with an explicit offset. */
  at: string
}

/**
 * Commands the control plane sends to a node, discriminated by `type`.
 *
 * Commands that create a Session carry that Session's short-lived `sessionToken`; the node hands it to
 * the Session's tools and never parses or logs it.
 */
export type NodeCommand =
  | (CommandEnvelope & { type: 'node.register'; registration: NodeRegistration })
  | (CommandEnvelope & { type: 'node.heartbeat'; status: NodeStatus })
  | (CommandEnvelope & { type: 'project.bind'; projectId: string; workspace: string })
  | (CommandEnvelope & {
    type: 'pm.ensure'
    sessionId: string
    project: { id: string; title: string; goal: string }
    workspace: string
    profile: RoleProfile
    sessionToken: string
    prompt: string
  })
  | (CommandEnvelope & {
    type: 'worker.create'
    sessionId: string
    projectId: string
    assignmentId: string
    ticketId: string
    workspace: string
    profile: RoleProfile
    sessionToken: string
    prompt: string
  })
  | (CommandEnvelope & { type: 'session.message'; sessionId: string; text: string })
  | (CommandEnvelope & { type: 'session.cancel'; sessionId: string; reason?: string })
  | (CommandEnvelope & { type: 'session.archive'; sessionId: string })
  | (CommandEnvelope & { type: 'session.inspect'; sessionId: string })
  | (CommandEnvelope & { type: 'permission.set'; sessionId: string; permission: string })
  | (CommandEnvelope & { type: 'workspace.ensure'; projectId: string; workspace: string })

/**
 * The envelope every event carries.
 *
 * `sessionId` and `projectId` identify what the event is about; node-scoped events (`node.status`)
 * carry empty strings there and an inert `role`, because a node has no Session. Consumers must route
 * on the envelope but never treat it as authority: authorization comes from a verified session token.
 */
interface EventEnvelope {
  protocolVersion: typeof NODE_PROTOCOL_VERSION
  nodeId: string
  sessionId: string
  projectId: string
  assignmentId?: string
  role: SessionRole
  /** Monotonic per node from 1; lets the control plane detect gaps and order events. */
  seq: number
  /** ISO 8601 timestamp with an explicit offset. */
  at: string
}

/** Events a node reports, discriminated by `type`. A node reports facts; the control plane interprets them. */
export type NodeEvent =
  | (EventEnvelope & { type: 'node.status'; status: NodeStatus })
  | (EventEnvelope & { type: 'session.status'; status: SessionStatus })
  | (EventEnvelope & {
    type: 'session.event'
    kind: 'message' | 'turn-start' | 'turn-end' | 'error' | 'usage'
    data?: unknown
  })
  | (EventEnvelope & { type: 'session.inspected'; requestId: string; inspection: SessionInspection })
  | (EventEnvelope & { type: 'tool.call'; tool: string; args: unknown; toolCallId: string })

/**
 * Authority for one tool call.
 *
 * Every field is derived from a verified session token. Tool arguments never supply these values, so a
 * model cannot widen its scope by naming another Session, Project or Assignment.
 */
export interface ToolContext {
  sessionId: string
  projectId: string
  assignmentId?: string
  role: SessionRole
  nodeId: string
  backend: BackendKind
  /** The invocation this context belongs to; absent when resolved outside a call. */
  toolCallId?: string
}

/** A tool invocation forwarded by a node or plugin; `sessionToken` is opaque to both. */
export interface ToolCall {
  protocolVersion: typeof NODE_PROTOCOL_VERSION
  /** Control-plane-issued token; see `session-token.ts`. Never log it. */
  sessionToken: string
  /** Plain tool name. The control plane, not the protocol, owns the catalogue. */
  tool: string
  args: unknown
  idempotencyKey: string
}

/** The result of one tool call. `ok: false` must carry `error`; `ok: true` may omit `result`. */
export interface ToolResult {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

/**
 * The control plane's transport-neutral port to one execution node. HTTP, WebSocket, stdio or an
 * in-process FakeNode can implement it; the kernel only depends on this interface.
 */
export interface NodePort {
  send(command: NodeCommand): Promise<void>
  subscribe(listener: (event: NodeEvent) => void): () => void
  /**
   * Ask the node for a Session's current state instead of inferring it from events.
   *
   * Optional so an in-process or older transport still satisfies the port; a transport that implements it
   * gives the control plane the only loss-proof confirmation of a `starting` record.
   */
  inspect?(sessionId: string): Promise<SessionInspection>
}
