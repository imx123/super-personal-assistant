/**
 * The DSH-backed `DshPortHost`: it turns the port's narrow calls into `Sessions` calls and DSH's Context events.
 *
 * Every `@deepseek-ai/*` import of the node HTTP facade lives here, so `dsh-port.ts` stays free of DSH and its mapping can
 * be tested without a Context. Event mapping is deliberately conservative: only turn boundaries, messages, errors and
 * status changes cross the boundary, because the control plane interprets facts and does not need the model stream.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// These augment DSH's `Context` with the services named below; the imports are type-only and exist for the augmentation.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { WORKER_REPORT_STATES, type NodeStatus, type SessionInspection, type SessionStatus,
  type WorkerReportState } from '../shared/protocol.ts'
import { nodeWorkspace, type DshPortEvent, type DshPortHost } from './dsh-port.ts'

/**
 * The part of `Sessions` this host uses.
 *
 * Narrow on purpose: the host never needs the Executor or the runtime lifecycle, and a test can supply just these two
 * calls instead of building a whole `NodeRuntime`. `ensure` returns whatever the backend created; when it is a DSH
 * Agent with a scoped tool registry, the host registers its control-plane proxy tools there.
 */
export interface DshPortSessions {
  ensure(sessionId: string, directory: string, title: string, role: 'pm' | 'worker'): Promise<unknown>
  prompt(sessionId: string, idempotencyKey: string, text: string, mode: 'queue'): Promise<void>
}

/**
 * The subset of `fetch` the control-plane proxy tools use.
 *
 * A minimal shape rather than `typeof fetch`, so a test can answer without constructing a `Response` and the host keeps
 * no dependency on the DOM fetch implementation.
 */
export type DshPortFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string
  signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** The DSH runtime behind one node, plus the facts the node reports about itself. */
export interface DshPortHostInput {
  /** The plugin's Cordis context, typed as `unknown` so the port itself keeps no DSH type. */
  context: unknown
  /** The node runtime the control plane already drives; the host borrows only its `Sessions`. */
  nodeRuntime: { readonly sessions: DshPortSessions }
  nodeId: string
  /** Absolute node root; `ensureSession` refuses a workspace outside it. */
  root: string
  /** Version `NodeStatus` reports; the plugin passes its own and a test pins one. */
  version?: string
  capabilities?: readonly string[]
  /**
   * Base URL of the independent control plane's HTTP API. When present, `ensureSession` registers the role's proxy
   * tools (`control_project` and `control_create_tickets` for a PM, `control_report` for a Worker) and appends their
   * usage note to the role prompt. Absent keeps the node exactly as it was: no tool is registered and no note is sent.
   */
  controlUrl?: string
  /** Transport for the proxy tools; defaults to the global `fetch`. */
  fetch?: DshPortFetch
}

/**
 * Builds the host one node's port talks to.
 *
 * `ensureSession` creates the Session through `Sessions.ensure` and installs the role prompt under a key derived from the
 * Session, so a retried `ensure` delivers it at most once; a failure is kept for `inspectSession` before it is rethrown.
 * With a control URL it also registers the role's proxy tools on the Agent and appends their usage note, so a PM or
 * Worker Session acts on the independent control plane instead of the plugin's own Store. `cancel`, `archive` and `permission`
 * map onto the Context's `agents`, `workspaceRegistry` and `permissionPresets` services, and `inspectSession` reports the
 * backend's state without changing it.
 */
export function createDshPortHost(input: DshPortHostInput): DshPortHost {
  const context = input.context as Context
  const root = resolve(input.root)
  const version = input.version ?? '0.1.0'
  const capabilities = input.capabilities
  const controlUrl = input.controlUrl ? input.controlUrl.replace(/\/+$/, '') : undefined
  const fetchImpl: DshPortFetch = input.fetch ?? ((url, init) => fetch(url, init))
  /**
   * The latest ensure attempt per Session. An agent reports `idle` as soon as it exists, so a role prompt that failed
   * afterwards would otherwise look like a healthy Session; `inspectSession` reports this beside the backend status.
   */
  const prepared = new Map<string, { ready: boolean; error?: string }>()
  /**
   * The Agent each Session's control-plane tools were registered on, with the token their requests carry.
   *
   * A repeated ensure must not register the tools twice: DSH refuses a duplicate name in one Agent layer. It only
   * refreshes the token, which the control plane re-issues on every attempt.
   */
  const toolSessions = new Map<string, { agent: unknown; role: 'pm' | 'worker'; token: string }>()

  /** Register the role's proxy tools once per Agent and keep their bearer token current. */
  const installTools = (agent: unknown, details: { sessionId: string; role: 'pm' | 'worker'; sessionToken: string
    ticketId?: string; assignmentId?: string }): void => {
    if (!controlUrl) return
    const existing = toolSessions.get(details.sessionId)
    if (existing && existing.agent === agent && existing.role === details.role) {
      existing.token = details.sessionToken
      return
    }
    const session = { agent, role: details.role, token: details.sessionToken }
    registerControlTools(agent, { baseUrl: controlUrl, role: details.role, token: () => session.token, fetch: fetchImpl,
      ...(details.ticketId === undefined ? {} : { ticketId: details.ticketId }),
      ...(details.assignmentId === undefined ? {} : { assignmentId: details.assignmentId }) })
    toolSessions.set(details.sessionId, session)
  }

  return {
    async ensureSession({ sessionId, workspace, title, role, prompt, sessionToken, ticketId, assignmentId }) {
      const directory = nodeWorkspace(root, workspace)
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        const agent = await input.nodeRuntime.sessions.ensure(sessionId, directory, title, role)
        // Tools first: the role prompt starts the Session's first turn, which must already see them.
        installTools(agent, { sessionId, role, sessionToken,
          ...(ticketId === undefined ? {} : { ticketId }), ...(assignmentId === undefined ? {} : { assignmentId }) })
        // One stable key per Session: a repeated ensure never installs the role prompt twice. With a control URL the
        // usage note rides the same message, so the first turn already knows the tool and the Session's Ticket.
        const text = controlUrl
          ? [prompt, controlNote(role, { ...(ticketId === undefined ? {} : { ticketId }),
              ...(assignmentId === undefined ? {} : { assignmentId }) })].filter(Boolean).join('\n\n')
          : prompt
        if (text) await input.nodeRuntime.sessions.prompt(sessionId, `profile:${sessionId}`, text, 'queue')
        prepared.set(sessionId, { ready: true })
      } catch (error) {
        // Remember the failure for a later `session.inspect`, then let the command fail: an `idle` event the agent
        // emitted before this point is not proof that the Session was prepared.
        prepared.set(sessionId, { ready: false, error: messageOf(error) })
        throw error
      }
    },
    promptSession(sessionId, idempotencyKey, text) {
      // Returned, not caught: a delivery the backend refused must fail the command that carried it.
      return input.nodeRuntime.sessions.prompt(sessionId, idempotencyKey, text, 'queue')
    },
    cancelSession(sessionId) {
      context.agents.get(sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
    },
    async archiveSession(sessionId) {
      // A Session with running work refuses the archive; the control plane asked for the archive, so stop that work too.
      await context.workspaceRegistry.archiveSession(sessionId as SessionId, { stopActivity: true })
    },
    async inspectSession(sessionId) {
      const agent = context.agents.get(sessionId as SessionId)
      // The registry's archive set is a getter; a minimal host may provide only `archiveSession`, so treat it as optional.
      const archived = (context.workspaceRegistry.archivedSessionIds ?? []).map(String).includes(sessionId)
      const preparation = prepared.get(sessionId)
      if (!agent && !archived && !preparation) return { sessionId, found: false }
      // The backend knows idle and running; archived is the registry's own fact. A Session whose agent is gone has no
      // status to report, which tells the control plane to ensure it again rather than trust a guess.
      const status: SessionStatus | undefined = archived ? 'archived'
        : agent === undefined ? undefined : agent.status === 'running' ? 'running' : 'idle'
      const backendSessionId = agent !== undefined || archived ? sessionId : undefined
      return {
        sessionId,
        found: true,
        ...(status === undefined ? {} : { status }),
        ...(backendSessionId === undefined ? {} : { backendSessionId }),
        ...(preparation === undefined ? {} : { ready: preparation.ready,
          ...(preparation.error === undefined ? {} : { error: preparation.error }) }),
      }
    },
    setPermission(sessionId, permission) {
      const agent = context.agents.get(sessionId as SessionId)
      if (!agent) throw new Error(`Session ${sessionId} is not loaded on this node`)
      context.permissionPresets.set(agent.session, permission)
    },
    onEvent(listener) {
      const disposers = [
        context.on('agent/created', ({ agent }) => {
          listener({ type: 'session.status', sessionId: String(agent.id), status: 'starting' })
        }),
        context.on('agent/status', ({ agent, status }) => {
          listener({ type: 'session.status', sessionId: String(agent.id), status: status === 'running' ? 'running' : 'idle' })
        }),
        context.on('agent/error', ({ agent, turn, step, error }) => {
          listener({ type: 'session.event', sessionId: String(agent.id), kind: 'error',
            data: { message: error instanceof Error ? error.message : String(error), turn, step } })
        }),
        context.on('session/event', (session, event) => {
          const mapped = portEvent(String(session.id), event)
          if (mapped) listener(mapped)
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    },
    nodeStatus(): NodeStatus {
      return { nodeId: input.nodeId, backend: 'dsh', version, online: true, at: new Date().toISOString(),
        ...(capabilities === undefined ? {} : { capabilities }) }
    },
  }
}

/** The note delivered after the role prompt when the node has a control URL, so the Session knows its tools. */
function controlNote(role: 'pm' | 'worker', ids: { ticketId?: string; assignmentId?: string }): string {
  if (role === 'pm') {
    return 'Use control_project to read this Project and its Tickets, and control_create_tickets to create Tickets in '
      + 'this Project through the control plane.'
  }
  const scope = ids.ticketId === undefined ? ''
    : ` This Session executes Ticket ${ids.ticketId}${ids.assignmentId === undefined ? '' : ` (Assignment ${ids.assignmentId})`}.`
  return `Use control_report to report progress and the final result of this Ticket through the control plane.${scope}`
}

/** What one control-plane proxy tool needs: where the API is, which Session it acts as, and how to reach it. */
interface ControlToolOptions {
  baseUrl: string
  role: 'pm' | 'worker'
  /** Read per request: the control plane re-issues the token on every ensure attempt. */
  token: () => string
  fetch: DshPortFetch
  ticketId?: string
  assignmentId?: string
}

/** The part of an Agent's scoped tool registry this host registers into. */
interface ToolRegistry {
  register(definition: ToolDefinition): () => void
}

/** The Agent's scoped registry, when the backend returned an Agent that has one. */
function agentToolRegistry(agent: unknown): ToolRegistry | undefined {
  const ctx = (agent as { ctx?: { tools?: Partial<ToolRegistry> } } | null | undefined)?.ctx
  return ctx?.tools && typeof ctx.tools.register === 'function' ? ctx.tools as ToolRegistry : undefined
}

/**
 * Register the role's control-plane proxy tools on the Agent.
 *
 * A PM needs both its read path (`control_project`) and its write path (`control_create_tickets`); a Worker needs only
 * its report. A backend that returned no Agent with a tool registry cannot carry them, and continuing silently would
 * leave the Session unable to read, create or report, so the ensure fails and `inspectSession` reports why.
 */
function registerControlTools(agent: unknown, options: ControlToolOptions): void {
  const registry = agentToolRegistry(agent)
  if (!registry) throw new Error('The control-plane tools cannot be installed: the Session has no tool registry')
  for (const tool of controlTools(options)) registry.register(tool)
}

/** The control-plane proxy tools one role gets, in registration order. */
function controlTools(options: ControlToolOptions): ToolDefinition[] {
  return options.role === 'pm' ? [projectTool(options), createTicketsTool(options)] : [reportTool(options)]
}

/**
 * `control_project`: the PM's read path, so its first turn sees the Project it manages and the Tickets already in it.
 *
 * It takes no arguments: the Session token names both the Project and the PM, so the caller names no authority.
 */
function projectTool(options: ControlToolOptions): ToolDefinition {
  return {
    name: 'control_project',
    description: 'Read this Project and the Tickets already created in it through the control plane. It takes no '
      + 'arguments and returns the Project summary and each Ticket with its status and latest Assignment.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textContent(value) },
    execute(_args, exec) {
      return requestControl(options, 'GET', '/v1/tools/pm/context', undefined, exec.signal)
    },
  }
}

/** `control_create_tickets`: the PM's only write path, authenticated by the Session token rather than by its arguments. */
function createTicketsTool(options: ControlToolOptions): ToolDefinition {
  return {
    name: 'control_create_tickets',
    description: 'Create 1-5 Tickets in this Project through the control plane. Each Ticket needs a title and a goal; '
      + 'scope narrows the work, note routes it to the Worker, and threads lists the external "source:id" threads it '
      + 'subscribes to.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['tasks'],
      properties: {
        tasks: {
          type: 'array',
          description: 'The Tickets to create, in order.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'goal'],
            properties: {
              title: { type: 'string', description: 'Short Ticket title.' },
              goal: { type: 'string', description: 'What the Ticket must achieve.' },
              scope: { type: 'string', description: 'Narrower scope for the Worker.' },
              note: { type: 'string', description: 'Routing note for the Worker.' },
              threads: {
                type: 'array',
                description: 'External threads the Ticket subscribes to.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['key'],
                  properties: {
                    key: { type: 'string', description: 'A "source:id" thread key.' },
                    contextOnly: { type: 'boolean', description: 'Read the thread for context only.' },
                  },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textContent(value) },
    async execute(args, exec) {
      const input = argumentsOf(args)
      if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new Error('tasks must be a non-empty array')
      return requestControl(options, 'POST', '/v1/tools/pm/tickets', { tasks: input.tasks }, exec.signal)
    },
  }
}

/** `control_report`: the Worker's status path; the control plane derives the Project and Assignment from the token. */
function reportTool(options: ControlToolOptions): ToolDefinition {
  return {
    name: 'control_report',
    description: 'Report this Ticket\'s state to the control plane. Use "progress" while working, "ready" when the '
      + 'Ticket\'s goal is met, "blocked" or "failed" when it cannot proceed, and "dropped" when the work is no longer '
      + 'needed. Ask a person a question with question only when an answer is needed to continue.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ticketId', 'state', 'summary'],
      properties: {
        ticketId: { type: 'string', description: 'The Ticket this report is about.' },
        assignmentId: { type: 'string', description: 'The Assignment this Session runs; the control plane verifies it.' },
        state: { type: 'string', enum: [...WORKER_REPORT_STATES], description: 'progress, ready, blocked, failed or dropped.' },
        summary: { type: 'string', description: 'What happened and what remains.' },
        question: { oneOf: [{ type: 'string' }, { type: 'null' }],
          description: 'An open question for a person; null clears the current one.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textContent(value) },
    async execute(args, exec) {
      const input = argumentsOf(args)
      const ticketId = requiredString(input.ticketId, 'ticketId')
      const state = requiredState(input.state)
      const summary = requiredString(input.summary, 'summary')
      const question = input.question === undefined ? undefined
        : input.question === null ? null : requiredString(input.question, 'question')
      const assignmentId = input.assignmentId === undefined ? options.assignmentId
        : requiredString(input.assignmentId, 'assignmentId')
      const report = { state, summary, ...(question === undefined ? {} : { question }) }
      return requestControl(options, 'POST', '/v1/tools/worker/report',
        { ticketId, ...(assignmentId === undefined ? {} : { assignmentId }), report }, exec.signal)
    },
  }
}

/**
 * One JSON request to the control plane's tool API; a refused call rejects with the server's own safe message.
 *
 * A GET carries no body at all: `fetch` refuses a body on GET even when it is an empty string, so the request is built
 * per method instead of leaving an empty one in place.
 */
async function requestControl(options: ControlToolOptions, method: 'GET' | 'POST', path: string, body: unknown,
  signal: AbortSignal): Promise<unknown> {
  const response = await options.fetch(`${options.baseUrl}${path}`, { method,
    headers: { authorization: `Bearer ${options.token()}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal })
  const text = await response.text()
  let value: unknown = {}
  if (text !== '') {
    try {
      value = JSON.parse(text) as unknown
    } catch {
      throw new Error(`The control plane answered ${response.status} with a non-JSON body`)
    }
  }
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null ? (value as { error?: unknown }).error : undefined
    throw new Error(typeof message === 'string' && message !== '' ? message
      : `The control plane refused the tool call (HTTP ${response.status})`)
  }
  return value
}

/** The model-facing content of a tool result: its canonical value as JSON text. */
function textContent(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Tool arguments arrive as untrusted JSON even though the declaration describes an object. */
function argumentsOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The tool arguments must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function requiredState(value: unknown): WorkerReportState {
  if (typeof value !== 'string' || !(WORKER_REPORT_STATES as readonly string[]).includes(value)) {
    throw new Error(`state must be one of ${WORKER_REPORT_STATES.join(', ')}`)
  }
  return value as WorkerReportState
}

/** Maps one DSH Session event onto the protocol's conservative vocabulary; every other event is not reported. */
function portEvent(sessionId: string, event: SessionEvent): DshPortEvent | undefined {
  switch (event.type) {
    case 'turn/start':
      return { type: 'session.event', sessionId, kind: 'turn-start', data: { turn: event.data.turn } }
    case 'turn/end':
      return { type: 'session.event', sessionId, kind: 'turn-end', data: { turn: event.data.turn,
        reason: event.data.reason.kind,
        // A failed turn is the one place the loop reports a model or tool failure as a fact.
        ...(event.data.reason.kind === 'error' ? { error: event.data.reason.error.message } : {}) } }
    case 'user/message':
      return { type: 'session.event', sessionId, kind: 'message',
        data: { role: 'user', text: textOf(event.data.content), source: event.data.source.kind } }
    case 'assistant/message':
      return { type: 'session.event', sessionId, kind: 'message',
        data: { role: 'assistant', step: event.data.step, text: textOf(event.data.message.content) } }
    default:
      return undefined
  }
}

/** The message of a caught value, for reporting a failure the backend raised in an unknown shape. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The plain text of a message's content blocks, ignoring images, files, reasoning and tool calls. */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
