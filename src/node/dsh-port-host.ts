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
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// These augment DSH's `Context` with the services named below; the imports are type-only and exist for the augmentation.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { cancelled, stopBackground } from '../executor/background.ts'
import { WORKER_REPORT_STATES, type NodeStatus, type RoleProfile, type SessionInspection, type SessionStatus,
  type WorkerReportState } from '../shared/protocol.ts'
import { nodeWorkspace, type DshPortEvent, type DshPortHost } from './dsh-port.ts'

/** What a cancel tells the Session's jobs when the command carried no reason of its own. */
const STOP_REASON = 'The Session was stopped'
/**
 * How long a cancel waits for the whole stop to settle when the host configures nothing.
 *
 * It must cover the background cleanup (`stopBackground` alone can spend ten seconds or more on a shell job) and the
 * turn's own cancellation, so a Session whose Agent never becomes idle fails the command instead of hanging it forever.
 */
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000

/**
 * The part of `Sessions` this host uses.
 *
 * Narrow on purpose: the host never needs the Executor or the runtime lifecycle, and a test can supply just these two
 * calls instead of building a whole `NodeRuntime`. `ensure` returns whatever the backend created; when it is a DSH
 * Agent with a scoped tool registry, the host registers its control-plane proxy tools there.
 */
export interface DshPortSessions {
  /**
   * Resolve, resume or create the Session and prepare it for its role.
   *
   * The full `RoleProfile` crosses the seam so a node-only backend can choose the role's preset and model while it has
   * the creation call in hand. A backend that manages its own decoration (the control plane's in-process `Sessions`)
   * ignores it; the host applies the profile's permission itself in either case.
   */
  ensure(sessionId: string, directory: string, title: string, role: 'pm' | 'worker',
    profile?: RoleProfile): Promise<unknown>
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
  /**
   * How long `cancelSession` may wait for the whole stop — background jobs, subagents, the turn's cancellation and its
   * settling — before it rejects. A Session whose Agent never becomes idle would otherwise hold its caller forever.
   * Defaults to 10 seconds, which covers a shell job's own kill timeout.
   */
  cancelTimeoutMs?: number
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
  const cancelTimeoutMs = Number.isFinite(input.cancelTimeoutMs) && (input.cancelTimeoutMs ?? 0) > 0
    ? input.cancelTimeoutMs! : DEFAULT_CANCEL_TIMEOUT_MS
  /** The host's permission presets, when it offers them; a minimal host may offer no `get` at all. */
  const permissions = hostService(context, 'permissionPresets')
  /**
   * The latest ensure attempt per Session. An agent reports `idle` as soon as it exists, so a role prompt that failed
   * afterwards would otherwise look like a healthy Session; `inspectSession` reports this beside the backend status.
   */
  const prepared = new Map<string, { ready: boolean; error?: string }>()
  /**
   * The Agent each Session's control-plane tools were registered on, with the credential their requests carry.
   *
   * A repeated ensure must not register the tools twice: DSH refuses a duplicate name in one Agent layer. It only
   * refreshes the credential in place, which the control plane re-issues on every attempt; a tool refresh and a
   * `session.message` do the same, so an already registered tool always reads the latest token.
   */
  const toolSessions = new Map<string, { agent: unknown; role: 'pm' | 'worker'; credential: ControlCredential }>()
  /**
   * The Agent each Session's role tool boundary was applied to.
   *
   * A repeated ensure sees the same live Agent and must not stack a second mask or guard; a resume produces a fresh
   * Agent whose inherited layer is new, so the boundary is applied again for that Agent.
   */
  const boundarySessions = new Map<string, unknown>()
  /** Input ids delivered to a Session whose next turn has not started yet; reported on that turn's start. */
  const pendingInputs = new Map<string, string[]>()

  /** Merge a delivery's Inputs into the Session's pending set; returns the ids this delivery added. */
  const rememberInputs = (sessionId: string, inputIds: readonly string[]): string[] => {
    const prior = pendingInputs.get(sessionId) ?? []
    const merged = [...new Set([...prior, ...inputIds])]
    pendingInputs.set(sessionId, merged)
    return merged.filter(id => !prior.includes(id))
  }

  /** Register the role's proxy tools once per Agent and keep their bearer credential current. */
  const installTools = (agent: unknown, details: { sessionId: string; role: 'pm' | 'worker'; sessionToken: string
    ticketId?: string; assignmentId?: string }): void => {
    if (!controlUrl) return
    const existing = toolSessions.get(details.sessionId)
    if (existing && existing.agent === agent && existing.role === details.role) {
      existing.credential.current = details.sessionToken
      return
    }
    const session = { agent, role: details.role, credential: { current: details.sessionToken } }
    registerControlTools(agent, { baseUrl: controlUrl, role: details.role, credential: session.credential,
      fetch: fetchImpl, ...(details.ticketId === undefined ? {} : { ticketId: details.ticketId }),
      ...(details.assignmentId === undefined ? {} : { assignmentId: details.assignmentId }) })
    toolSessions.set(details.sessionId, session)
  }

  /** Apply the profile's permission tier to the Session the backend just prepared, before its first turn. */
  const applyPermission = (agent: unknown, profile: RoleProfile): void => {
    const session = (agent as { session?: Session } | null | undefined)?.session
    // A backend that returned no Agent with a live Session (a fake one, or one that owns permissions) has nothing to set.
    if (!permissions || session === undefined) return
    const preset = permissionPresetFor(profile.permission, permissions.names)
    // Never leave a wider default in place: a tier this node cannot express fails the ensure, which fails the command.
    if (preset === undefined) {
      throw new Error(`This node offers no permission preset for "${profile.permission}" (offers: `
        + `${permissions.names.join(', ') || 'none'})`)
    }
    permissions.set(session, preset)
  }

  /**
   * Apply the role's tool boundary to the Agent, once per Agent.
   *
   * `RoleProfile.tools` is the role's complete capability set, but a node-only profile leaves DSH's whole tool surface
   * inherited by every Agent. The inherited layer is therefore masked to what the role may use, while the Session's own
   * layer — the `control_*` proxy tools installed after this — stays visible. A guard then refuses any call outside the
   * profile too, because a mask only filters inherited names: a scope-local `subagent` would otherwise stay callable.
   * A PM inherits nothing it may use, so its mask is a deny list of every inherited tool; a Worker keeps the inherited
   * names its profile names. `restrict({})` is skipped because DSH refuses an empty filter, and a minimal host whose
   * Agent has no scoped registry is left as it is.
   */
  const applyToolBoundary = (agent: unknown, details: { sessionId: string; role: 'pm' | 'worker'
    profile: RoleProfile }): void => {
    if (boundarySessions.get(details.sessionId) === agent) return
    const tools = agentTools(agent)
    if (!tools) return
    const allowed = details.profile.tools
    const inherited = inheritedToolNames(agent, tools)
    if (details.role === 'pm') {
      if (inherited.length > 0 && typeof tools.restrict === 'function') tools.restrict({ deny: inherited })
    } else {
      const allow = inherited.filter(name => allowed.includes(name))
      if (allow.length > 0 && typeof tools.restrict === 'function') tools.restrict({ allow })
    }
    if (typeof tools.guard === 'function') {
      tools.guard(({ name }) => allowed.includes(name) ? undefined : toolBoundaryReason(details.role, allowed))
    }
    boundarySessions.set(details.sessionId, agent)
  }

  return {
    async ensureSession({ sessionId, workspace, title, role, prompt, profile, sessionToken, ticketId, assignmentId }) {
      const directory = nodeWorkspace(root, workspace)
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        const agent = await input.nodeRuntime.sessions.ensure(sessionId, directory, title, role, profile)
        // The role's permission comes before its tools and its first turn: a turn that started wider cannot be narrowed
        // retroactively, and the prompt below may start one.
        applyPermission(agent, profile)
        // Its tool boundary comes before the role's own tools: a mask only filters what the Agent inherits, so the
        // `control_*` registrations that follow stay visible while a role's inherited shell/web tools are hidden.
        applyToolBoundary(agent, { sessionId, role, profile })
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
    promptSession(sessionId, idempotencyKey, text, sessionToken, inputIds) {
      // A message carries the control plane's latest token; adopt it so a Session whose tools were registered before a
      // re-issue (for example across a control-plane restart) calls with the current one. Verification stays remote.
      if (sessionToken !== undefined) {
        const session = toolSessions.get(sessionId)
        if (session) session.credential.current = sessionToken
      }
      // Returned, not caught: a delivery the backend refused must fail the command that carried it.
      const delivery = input.nodeRuntime.sessions.prompt(sessionId, idempotencyKey, text, 'queue')
      if (inputIds === undefined || inputIds.length === 0) return delivery
      // The ids become pending only after the backend accepted the message: a turn that starts while the delivery still
      // waits must not claim them, and a refused delivery leaves none behind to be reported as read.
      return delivery.then(() => { rememberInputs(sessionId, inputIds) })
    },
    async cancelSession(sessionId: string, reason?: string) {
      const agent = context.agents.get(sessionId as SessionId)
      // One deadline covers the whole cleanup, because `stopBackground` alone may take longer than any turn cancellation:
      // a Session whose Agent never becomes idle must fail the command, not hold its caller forever. `Promise.race`
      // observes this cleanup to the end, so a rejection after the deadline cannot become an unhandled one.
      await withinDeadline((async () => {
        const failures: unknown[] = []
        // What the Session runs past its turn comes first: its shell jobs die with the stop, and its live subagents are
        // released with it. A host that offers neither service reads `undefined` here and this is a no-op; a host with no
        // `get` at all is left to the turn cancellation below.
        if (typeof (context as { get?: unknown }).get === 'function') {
          try {
            await stopBackground(context, sessionId, reason ?? STOP_REASON, true)
          } catch (error) {
            // A cleanup failure must not skip the turn cancellation, and must not be reported as success either.
            failures.push(error)
          }
        }
        // `stopSubagents` already cancelled the turn it released and waited for it; a second cancel would be redundant once
        // that turn is idle. Any other loaded Agent still cancels, even when a cleanup step above failed.
        const settledBySubagents = agent !== undefined && cancelled.has(agent) && agent.status === 'idle'
        if (agent !== undefined && !settledBySubagents) {
          try {
            agent.cancel({ kind: 'user' }, { keepInbox: true })
          } catch (error) {
            // A cancel that could not be requested still leaves a turn to wait for; its failure is kept as well.
            failures.push(error)
          }
          try {
            // The command's success means the turn really settled, not just that a cancel was requested.
            await agent.whenIdle()
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) {
          // Both the background cleanup and the turn cancellation failed: keep both facts for the node transport.
          throw new AggregateError(failures, `Stopping the Session ${sessionId} did not settle cleanly`)
        }
      })(), cancelTimeoutMs, () => new Error(
        `Stopping the Session ${sessionId} did not settle within ${cancelTimeoutMs} ms`))
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
      if (!agent && !archived && !preparation) {
        // A node restart forgets every live Agent while the Session stays on disk. Ask the persistence-backed query
        // instead of claiming the Session does not exist; a host without the service keeps the old answer.
        const query = serviceOf<SessionQuery>(context, 'sessionQuery')
        if (typeof query?.observeSession !== 'function') return { sessionId, found: false }
        const persisted = await observePersisted(query, sessionId)
        // No `status` on purpose: it tells the control plane "persisted but not mounted" and makes it ensure the
        // Session again. A fabricated `idle` would make it skip the resume that mounts the Agent.
        return persisted ? { sessionId, found: true, backendSessionId: sessionId } : { sessionId, found: false }
      }
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
          const sessionId = String(session.id)
          const mapped = portEvent(sessionId, event, pendingInputs)
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

/**
 * Maps a control-plane permission tier onto a preset this node actually offers.
 *
 * The protocol's `permission` is a tier, not a backend preset name (see `RoleProfile`), so a node translates it. A stock
 * DSH host offers `workspace-write` and `danger-full-access`, and `auto` only while its reviewer runs, so `read-only` is
 * frequently not expressible: the chain then takes the nearest narrower-or-equal preset a host does offer, mirroring the
 * choice `Sessions.ensure` makes for a PM. A tier with no chain entry only matches its own name, and the caller treats an
 * unmatched tier as a configuration error rather than a default.
 */
export function permissionPresetFor(permission: string, names: readonly string[]): string | undefined {
  const chains: Record<string, readonly string[]> = {
    'read-only': ['read-only', 'auto', 'workspace-write', 'danger-full-access'],
    'workspace-write': ['workspace-write', 'auto', 'danger-full-access'],
    auto: ['auto', 'workspace-write', 'danger-full-access'],
    'danger-full-access': ['danger-full-access', 'workspace-write'],
  }
  return (chains[permission] ?? [permission]).find(name => names.includes(name))
}

/**
 * Reads one optional service from the host.
 *
 * `DshPortHostInput.context` is `unknown` on purpose, and a test host may implement only the few members a single test
 * exercises (some provide no `get`), so the read is guarded instead of assuming the full Cordis surface.
 */
function hostService<K extends keyof Context & string>(context: Context, name: K): Context[K] | undefined {
  const get = (context as { get?: unknown }).get
  return typeof get === 'function' ? (get as (this: Context, name: string) => Context[K] | undefined).call(context, name) : undefined
}

/**
 * Reads one optional service by name, including names the typed `Context` surface does not declare.
 *
 * `sessionQuery` comes from a node-only profile plugin rather than `dsh-base`, so the installed type packages do not
 * augment `Context` with it; the host reads it by name and narrows it to the one call inspection needs.
 */
function serviceOf<T>(context: Context, name: string): T | undefined {
  const get = (context as { get?: unknown }).get
  return typeof get === 'function' ? (get as (this: Context, name: string) => T | undefined).call(context, name) : undefined
}

/** The part of DSH's `sessionQuery` service inspection reads: whether a Session exists outside this process. */
interface SessionQuery {
  /** Returns a caller-owned observation lease; a projection-free read is enough to prove the Session exists. */
  observeSession(sessionId: SessionId, options?: { projectionMode?: 'none' | 'all' }): Promise<unknown>
}

/** Releases a `sessionQuery` observation lease, whose `[Symbol.dispose]` frees its cache reference. */
function releaseObservation(observation: unknown): void {
  const dispose = (observation as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose]
  if (typeof dispose === 'function') dispose.call(observation)
}

/**
 * Whether `sessionQuery` observes `sessionId`, releasing the observation lease on both the success and failure paths.
 *
 * An absent Session is reported with a stable code and becomes `false`; any other failure is a read error, which the
 * caller must not turn into "no such Session". A lease is released at once because only existence is needed here, and
 * an undisposed lease would pin that cache entry for the life of the process.
 */
async function observePersisted(query: SessionQuery, sessionId: string): Promise<boolean> {
  let observation: unknown = undefined
  try {
    observation = await query.observeSession(sessionId as SessionId, { projectionMode: 'none' })
    return true
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return false
    throw error
  } finally {
    releaseObservation(observation)
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

/**
 * The mutable bearer credential one Session's proxy tools share.
 *
 * `current` is read before every request, and a successful refresh replaces it in place, so an already registered tool
 * closure observes the new token without being re-registered.
 */
interface ControlCredential {
  current: string
}

/** What one control-plane proxy tool needs: where the API is, which Session it acts as, and how to reach it. */
interface ControlToolOptions {
  baseUrl: string
  role: 'pm' | 'worker'
  /** Read while building each request; replaced after a refresh. */
  credential: ControlCredential
  fetch: DshPortFetch
  ticketId?: string
  assignmentId?: string
}

/** The part of an Agent's scoped tool registry this host registers into. */
interface ToolRegistry {
  register(definition: ToolDefinition): () => void
}

/**
 * The part of an Agent's scoped tool registry the role boundary reads.
 *
 * A minimal host, or a test Agent, may offer only `register`; every member is optional so such an Agent keeps the tools
 * DSH gave it instead of failing an otherwise valid ensure.
 */
interface ToolBoundaryRegistry {
  /** Visible names of the viewing scope; called with the Agent's parent so the result is exactly what it inherits. */
  schemas?(scope?: object): { name: string }[]
  /** Hide inherited tools: `deny` removes, `allow` keeps only the named ones. Own-layer registrations stay visible. */
  restrict?(filter: { allow?: string[]; deny?: string[] }): () => void
  /** Refuse a call by returning a reason; `undefined` lets the call through. */
  guard?(guard: (execution: { name: string }) => string | undefined): () => void
}

/** The Agent's scoped registry, when the backend returned an Agent that has one. */
function agentToolRegistry(agent: unknown): ToolRegistry | undefined {
  const ctx = (agent as { ctx?: { tools?: Partial<ToolRegistry> } } | null | undefined)?.ctx
  return ctx?.tools && typeof ctx.tools.register === 'function' ? ctx.tools as ToolRegistry : undefined
}

/** The same scoped registry as the role boundary sees it, or `undefined` for a host that offers no tool service. */
function agentTools(agent: unknown): ToolBoundaryRegistry | undefined {
  const tools = (agent as { ctx?: { tools?: ToolBoundaryRegistry } } | null | undefined)?.ctx?.tools
  return typeof tools === 'object' && tools !== null ? tools : undefined
}

/**
 * The tool names an Agent inherits, read through its parent scope.
 *
 * The Agent's own view would also include its scope-local registrations such as `subagent`, which `restrict` refuses to
 * name; the parent view holds exactly the global and preset tools a mask may name. `run_code` is the reserved PTC
 * transport and cannot appear in a restriction at all.
 */
function inheritedToolNames(agent: unknown, tools: ToolBoundaryRegistry): string[] {
  if (typeof tools.schemas !== 'function') return []
  return tools.schemas(scopeParentOf(agent as object)).map(schema => schema.name).filter(name => name !== 'run_code')
}

/** The denial a role's guard returns for a tool its profile does not grant. */
function toolBoundaryReason(role: 'pm' | 'worker', allowed: readonly string[]): string {
  const names = allowed.join(', ') || 'no tools'
  return role === 'pm' ? `A Project PM may use only ${names}` : `A Worker may use only ${names}`
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
 *
 * A `401` means the Session token expired while the task ran. The tool refreshes exactly once, adopts the new token, and
 * retries the same request. A failed refresh or a retried `401` is reported as the original refusal: the refresh request
 * never recurses, so a bad control plane cannot turn one tool call into an unbounded loop.
 */
async function requestControl(options: ControlToolOptions, method: 'GET' | 'POST', path: string, body: unknown,
  signal: AbortSignal): Promise<unknown> {
  const first = await sendControl(options, options.credential.current, method, path, body, signal)
  if (first.ok) return jsonOf(first)
  if (first.status === 401) {
    let refreshed: string | undefined
    try {
      refreshed = await refreshToken(options.baseUrl, options.credential.current, options.fetch, signal)
    } catch {
      // A failed refresh is not the tool result; the original refusal below is what the caller should see.
    }
    if (refreshed !== undefined) {
      options.credential.current = refreshed
      const retry = await sendControl(options, refreshed, method, path, body, signal)
      if (retry.ok) return jsonOf(retry)
      // At most one refresh per tool call: a retried 401 is the original refusal, not another refresh.
      return retry.status === 401 ? refusalOf(first) : refusalOf(retry)
    }
  }
  return refusalOf(first)
}

/** One authenticated request with the token that is current at the moment it is built. */
function sendControl(options: ControlToolOptions, token: string, method: 'GET' | 'POST', path: string, body: unknown,
  signal: AbortSignal): Promise<Awaited<ReturnType<DshPortFetch>>> {
  return options.fetch(`${options.baseUrl}${path}`, { method,
    headers: { authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal })
}

/**
 * Ask the control plane to re-issue the Session token behind `token`.
 *
 * No body is sent: the present token names the Session and the control plane derives the role from it. The response's
 * `token` is the only value used; `expiresAt` is informational. This helper deliberately has no retry of its own — the
 * caller does, once — so a refresh can never recurse into another refresh.
 */
export async function refreshToken(baseUrl: string, token: string, fetch: DshPortFetch,
  signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/tools/token/refresh`, { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, ...(signal === undefined ? {} : { signal }) })
  const value = await jsonOf(response)
  if (!response.ok) refusal(value, response.status)
  const refreshed = typeof value === 'object' && value !== null ? (value as { token?: unknown }).token : undefined
  if (typeof refreshed !== 'string' || refreshed === '') {
    throw new Error('The control plane did not return a refreshed Session token')
  }
  return refreshed
}

/** Parse a response body as JSON; an empty body is `{}` and a malformed one names the HTTP status. */
async function jsonOf(response: { status: number; text(): Promise<string> }): Promise<unknown> {
  const text = await response.text()
  if (text === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`The control plane answered ${response.status} with a non-JSON body`)
  }
}

/** The rejection a refused tool call raises, built from its JSON body when the server supplied one. */
async function refusalOf(response: { status: number; text(): Promise<string> }): Promise<never> {
  return refusal(await jsonOf(response), response.status)
}

function refusal(value: unknown, status: number): never {
  const message = typeof value === 'object' && value !== null ? (value as { error?: unknown }).error : undefined
  throw new Error(typeof message === 'string' && message !== '' ? message
    : `The control plane refused the tool call (HTTP ${status})`)
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

/**
 * Maps one DSH Session event onto the protocol's conservative vocabulary; every other event is not reported.
 *
 * A turn reports the Inputs its step took, once: the Session's pending ids ride the `turn/start` that starts with them
 * and are then consumed, so a later turn of the same Session does not report them again. A turn without pending Inputs
 * stays exactly as it was, and the control plane reads no ids from it.
 */
function portEvent(sessionId: string, event: SessionEvent, pendingInputs: Map<string, string[]>): DshPortEvent | undefined {
  switch (event.type) {
    case 'turn/start': {
      const inputIds = pendingInputs.get(sessionId)
      if (inputIds === undefined || inputIds.length === 0) {
        return { type: 'session.event', sessionId, kind: 'turn-start', data: { turn: event.data.turn } }
      }
      pendingInputs.delete(sessionId)
      return { type: 'session.event', sessionId, kind: 'turn-start',
        data: { turn: event.data.turn, inputIds: [...inputIds] } }
    }
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

/**
 * Resolve `work`, or reject with `failure()` once `timeoutMs` elapses.
 *
 * The timer is cleared whichever side settles, and it does not keep the process alive. `Promise.race` observes `work` to
 * its end, so a rejection arriving after the deadline is already handled and cannot surface as an unhandled rejection.
 */
async function withinDeadline<T>(work: Promise<T>, timeoutMs: number, failure: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(failure()) }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The plain text of a message's content blocks, ignoring images, files, reasoning and tool calls. */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
