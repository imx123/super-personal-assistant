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

/**
 * What a Session is for: a Project's PM, an Assignment's Worker, read-only reconnaissance, or the Router.
 *
 * The Router is the one Session that belongs to no Project: it is the console's own conversation, and it names no
 * Assignment. It still gets a Session id, a token and a lifecycle of its own, so the same boundaries as every other
 * role apply to it.
 */
export type SessionRole = 'pm' | 'worker' | 'scout' | 'router'

/**
 * How one read-only Git review of a Project's workspace ended.
 *
 * `ok` is a complete read and `truncated` a read whose diff was cut at the byte bound. `no-repository` is a workspace
 * that is not a Git repository at all, and `no-baseline` a repository without a commit, so there is nothing to compare
 * against. `refused` is a read the boundary refused: the workspace is not the root of its own repository, its real path
 * leaves the node root, or the repository's own configuration and layout are not the workspace's own. `timeout` is a Git
 * command that ran out of time, and `failed` one that failed otherwise.
 */
export type ReviewDiffStatus = 'ok' | 'truncated' | 'no-repository' | 'no-baseline' | 'refused' | 'timeout' | 'failed'

/**
 * What one read-only Git review of a Project's workspace found.
 *
 * The node produces it and the control plane relays it to the Project's PM. Every field is a fact about the workspace at
 * the moment it was read: the diff is a snapshot of a directory several Workers share, so it can never show which Worker
 * or Assignment changed a file.
 */
export interface ReviewDiffResult {
  /** How the read ended. */
  status: ReviewDiffStatus
  /** The workspace the read describes, as the node resolved it. */
  workspace?: string
  /** The commit the changes are compared against; absent when the repository has no commit yet. */
  baseline?: string
  /** The bounded diff text; empty when there is nothing to show. */
  diff?: string
  /** The files the diff touches, bounded. */
  files?: string[]
  /** How many files the diff touches, before the bound. */
  fileCount?: number
  /** The untracked files of the workspace: their names only, never their content. */
  untracked?: string[]
  /** How many untracked files the workspace has, before the bound. */
  untrackedCount?: number
  /** The whitespace problems the check found, one line each. */
  whitespace?: string[]
  /** Whether the whitespace check found nothing at all. */
  whitespaceClean?: boolean
  /**
   * Whether every part of the read finished.
   *
   * A Git command that failed or ran out of time leaves the answer incomplete: the file list may be short and the
   * whitespace check may have found nothing because it never ran. The answer says so instead of looking like a clean
   * workspace.
   */
  complete?: boolean
  /** Why the read ended the way it did; safe to show to a PM. */
  reason?: string
}

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
  /**
   * The control-plane node generation the Session's last ensure was confirmed under.
   *
   * A generation changes when the control plane starts and whenever the node comes back from offline, so a record left
   * over from an earlier generation is re-ensured once instead of being returned as if the node still knew it. The
   * field is optional so records persisted before it existed still load and count as stale.
   */
  nodeGeneration?: string
  /**
   * Generation of the Session's current token, advanced by every refresh.
   *
   * A token carries the generation it was signed with: the control plane accepts only the current one for tools, and the
   * one immediately before it for a refresh. The field is optional so records persisted before generations load as 0.
   */
  tokenVersion?: number
  /** `RoleProfile.name` the Session was created with. */
  toolProfile: string
  model?: string
  /** ISO 8601 timestamp with an explicit offset. */
  createdAt: string
  updatedAt: string
  archivedAt?: string
  /**
   * When this Session's authority was revoked.
   *
   * A revoked Session keeps its record and its history, but no token may be issued for it again: the ordinary tool routes,
   * the refresh route, every re-ensure and every message refuse it. The field is optional, so a record persisted before
   * revocation existed loads as not revoked.
   */
  revokedAt?: string
  /** Why the authority was revoked, as the operator wrote it. */
  revokedReason?: string
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
export interface RouterModel {
  provider: string
  model: string
}

export interface ConsoleRuntimeSettings {
  schedulerTickMs: number
  reconcileIntervalMs: number
  tokenRefreshGraceSeconds: number
}

export interface RouterOptions {
  models: (RouterModel & { name: string })[]
  selected?: RouterModel
  usage?: RouterModel & { tokens: number; contextWindow?: number }
}

export const ROUTER_ATTACHMENT_BYTES = 48 * 1024
export const ROUTER_ATTACHMENT_COUNT = 4

export interface RouterTextAttachment {
  name: string
  text: string
}

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
  routerOptions?: RouterOptions
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
 * the Session's tools and never parses or logs it. `session.message` may carry the latest token too, so a
 * node can keep its proxy tools current; it is opaque there as well because a node has no signing secret.
 *
 * `review.diff` names a Project and nothing else: the node reads that Project's own workspace with a fixed, read-only
 * Git command set. It carries no path and no Git argument, so a caller can never point it at another directory or at a
 * command of its own.
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
  | (CommandEnvelope & {
    /**
     * Ensure the Router Session.
     *
     * The Router belongs to no Project: the command names its own Session id and its own workspace, and the node keeps it
     * apart from every Project's Sessions. The command is additive — a node that does not know it refuses it, and an older
     * control plane never sends it — so the protocol version does not move.
     */
    type: 'router.ensure'
    sessionId: string
    workspace: string
    profile: RoleProfile
    sessionToken: string
    prompt: string
  })
  | (CommandEnvelope & { type: 'session.message'; sessionId: string; text: string; sessionToken?: string
    inputIds?: readonly string[]; routerModel?: RouterModel })
  | (CommandEnvelope & { type: 'session.cancel'; sessionId: string; reason?: string })
  | (CommandEnvelope & { type: 'session.archive'; sessionId: string })
  | (CommandEnvelope & { type: 'session.inspect'; sessionId: string; routerDetails?: true })
  | (CommandEnvelope & { type: 'permission.set'; sessionId: string; permission: string })
  | (CommandEnvelope & { type: 'workspace.ensure'; projectId: string; workspace: string })
  | (CommandEnvelope & { type: 'review.diff'; projectId: string })

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
  /**
   * The node's own `seq` of the event the control plane recorded, when the event came from a node.
   *
   * The control plane gives every recorded event a sequence of its own, because a node restarts and counts from 1 again.
   * That own sequence is the `seq` a client sees; the node's counter is kept here, so a node restart stays visible instead
   * of silently reusing a number. The control plane itself sets this field, and the node never sends it.
   */
  nodeSeq?: number
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
  | (EventEnvelope & { type: 'review.diff'; requestId: string; result: ReviewDiffResult })
  | (EventEnvelope & { type: 'tool.call'; tool: string; args: unknown; toolCallId: string })
  | (EventEnvelope & {
    type: 'schedule.run'
    /** The plan the run belongs to. */
    scheduleId: string
    /** The run's own id; the same slot of the same plan always has the same id. */
    runId: string
    /** How the run ended: `delivered`, `failed` or `interrupted`. */
    state: string
    /** Whether the node acknowledged the message. A lost confirmation is never a success. */
    acknowledged: boolean
    /** Why the run failed, when it did. */
    reason?: string
  })

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
  inspect?(sessionId: string, routerDetails?: true): Promise<SessionInspection>
}
