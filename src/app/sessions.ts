/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { assignmentStopped, key, latestAssignment, latestSessionId, liveTicket, projectOfSession, WORK_TOOLS, workerSessionsOf,
  type ProjectProfile, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId, type DeliveryMode } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { pmProjectSection, projectInitMessage, SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** Outcome of pausing or resuming a Project's Sessions: a soft notice, or hard cancellations of loaded agents. */
export interface ProjectPauseResult {
  /** True when a soft-pause notice was delivered to the PM (false when it was already delivered or the PM is unavailable). */
  delivered: boolean
  /** Loaded Sessions whose current turn was cancelled on a hard pause. */
  cancelled: string[]
  /** Project Sessions not loaded in this process; there was no turn to cancel, and a later prompt sees the paused state. */
  notLoaded: string[]
  /** Failures that leave the Project status authoritative; each is also logged. */
  failures: { sessionId: string; error: string }[]
}
/** Outcome of asking the host to archive or unarchive a Project's PM and child Sessions. */
export interface SessionArchiveResult {
  /** Session ids the host accepted, in call order. */
  ids: string[]
  /** Sessions the host refused or failed to change; the Project state remains authoritative. */
  failures: { sessionId: string; error: string }[]
  /** True when the host offers no session archive API, so no call was made. */
  unavailable?: true
}

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'projects' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  /** The state directory, where a Project's PM Session works; it does no file work. */
  readonly stateDir: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session, on `ticket`'s worker Session, or on `project`'s PM Session. */
  tools(agent: Agent, target: SessionTarget): Tool[]
}
/** What a decorated Session works on: a Ticket's worker, a Project's PM, or neither for the main Session. */
export interface SessionTarget { ticket?: Ticket; project?: ProjectProfile }
/** The roles `Sessions.ensure` creates: the main Session, a worker, or a Project's PM. */
export type SessionRole = 'orchestrator' | 'worker' | 'pm'

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** The agent presets Executor Sessions, the main Session, and a Project's PM are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router', PM_PRESET = 'dsh-superagent-pm'
/** The tools a Project's PM may see and call: it reads its Project, creates, messages, hands off and revives its Tickets,
 * decides handoffs addressed to it, and reports. */
export const PM_TOOLS = ['orchestrator_read', 'orchestrator_project_report', 'orchestrator_project_ticket_create',
  'orchestrator_project_ticket_message', 'orchestrator_project_ticket_revive', 'orchestrator_project_ticket_handoff',
  'orchestrator_project_ticket_handoff_new_ticket', 'orchestrator_project_ticket_handoff_to_project',
  'orchestrator_project_ticket_handoff_decide'] as const
/**
 * The tool boundary of a Project's PM. `tools.restrict` masks only the tools a Session inherits (DSH's global layer and its
 * preset's) and rejects scope-local names, so naming the PM's own tools there fails with `names unknown global tools`
 * (P2-A05). This instead hides every inherited tool with a deny mask and refuses, through a scope guard, any call outside
 * `PM_TOOLS`; the PM's own registrations stay visible because they belong to the Session's layer. Register the guard before
 * a Session's tools, and keep it if a visibility mask cannot be built, so execution stays bounded in every case.
 */
export function pmToolBoundary(agent: Agent): (() => void)[] {
  const tools = agent.ctx.tools
  const isPmTool = (name: string): boolean => PM_TOOLS.includes(name as typeof PM_TOOLS[number])
  const disposers: (() => void)[] = [tools.guard(({ name }) => isPmTool(name) ? undefined
    : `A Project PM may use only ${PM_TOOLS.join(', ')}`)]
  // The parent view holds exactly the global and preset tools a restriction may name; the PM's own tools are not there.
  const inherited = typeof tools.schemas === 'function'
    ? tools.schemas(scopeParentOf(agent)).map(schema => schema.name).filter(name => name !== 'run_code' && !isPmTool(name))
    : []
  if (inherited.length) disposers.push(tools.restrict({ deny: inherited }))
  return disposers
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: it refuses a bash command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash' || name === 'pwsh') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    const psSleep = name === 'pwsh' && typeof args.command === 'string' && /(?:^|[;&|({\n]\s*)(?:Start-Sleep|sleep)(?=\s|$)/im.test(args.command.trim())
    if (sleeps || psSleep || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  /** Sessions the host proved were never created; archiving them is a no-op, not a failure to retry forever. */
  private readonly absentSessions = new Set<string>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the Session a payload names, or the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices in the order they were queued; a relay may name a Project PM instead of the main Session.
    host.effects.handle('relay', ({ text, summary, sessionId }, requestId) =>
      this.prompt(sessionId ?? host.masterId, requestId, text, summary ? { steer: summary } : 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const projectId = projectOfSession(sessionId)
        const project = projectId ? this.host.store.projects.get(projectId) : undefined
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET
          : project ? PM_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** Resolves or creates a session, then sets its role model, tools, permissions, and title before delivery. */
  async ensure(id: string, cwd: string, title: string, role: SessionRole): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      const preset = role === 'worker' ? WORKER_PRESET : role === 'pm' ? PM_PRESET : ROUTER_PRESET
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id, agentPreset: preset })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    const settings = this.host.store.settings()
    const model = role === 'worker' ? settings.executor.model : role === 'pm' ? settings.eval.pmModel ?? settings.eval.model : settings.eval.model
    await initializeRoleModel(ctx, result.agent, model)
    await this.decorate(result.agent)
    const permissions = ctx.permissionPresets
    // Auto is advertised only while the host's reviewer is registered. Tool denials or errors never change this selection.
    // A PM manages a Project and may create its Tickets, so it takes `auto` as a worker does; without it, the narrowest
    // preset that still lets it work, and full access only when the host offers nothing narrower.
    const preset = role === 'worker' ? (permissions.names.includes('auto') ? 'auto' : 'danger-full-access')
      : role === 'pm' ? (permissions.names.includes('auto') ? 'auto'
        : permissions.names.includes('workspace-write') ? 'workspace-write'
          : permissions.names.includes('read-only') ? 'read-only' : 'danger-full-access')
        : 'danger-full-access'
    permissions.set(result.agent.session, preset)
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /**
   * Create or resolve a Project's PM Session and send it its first message once. The PM works in a directory of its own
   * under the state directory, since it does no file work; the message is idempotent by its Project.
   */
  async openProject(project: ProjectProfile): Promise<string> {
    const directory = join(this.host.stateDir, 'projects', project.id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    await this.ensure(project.pmSessionId, directory, project.title, 'pm')
    await this.prompt(project.pmSessionId, `project-init:${project.id}`, projectInitMessage(project), 'queue')
    return project.pmSessionId
  }
  /** Archive the Project's PM and every child Ticket's Session, with `stopActivity`, after the Project transaction committed. */
  archiveProject(project: ProjectProfile): Promise<SessionArchiveResult> {
    return this.changeProjectSessions(project, true)
  }
  /** Unarchive the Project's PM and every child Ticket's Session; no Assignment is restarted. */
  unarchiveProject(project: ProjectProfile): Promise<SessionArchiveResult> {
    return this.changeProjectSessions(project, false)
  }
  /**
   * Apply a soft or hard pause to a Project's Sessions. Soft queues one structured notice to the PM asking it to finish its
   * report and stop; it cancels no turn. Hard cancels every loaded PM/child agent turn and leaves unloaded Sessions to the
   * paused Project state. The Project transaction has already run; failures are logged and returned, never thrown.
   */
  async pauseProject(project: ProjectProfile, mode: 'soft' | 'hard'): Promise<ProjectPauseResult> {
    const result: ProjectPauseResult = { delivered: false, cancelled: [], notLoaded: [], failures: [] }
    // An ended or archived Project is history; pause/resume must not message or cancel its Sessions.
    if (project.status !== 'active' && project.status !== 'paused') return result
    const actual = project.pauseMode ?? mode
    if (actual === 'hard') {
      for (const sessionId of this.projectSessions(project)) {
        const agent = this.ctx.agents.get(sessionId as SessionId)
        if (!agent) { result.notLoaded.push(sessionId); continue }
        try {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
          result.cancelled.push(sessionId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.ctx.logger.warn('dsh-superagent could not stop Session %s for a hard pause: %s', sessionId, message)
          result.failures.push({ sessionId, error: message })
        }
      }
      return result
    }
    const requestId = key('project-pause', project.id, project.updatedAt)
    if (await this.holds(project.pmSessionId, requestId)) return result
    const payload = { kind: 'project_pause', project_id: project.id, mode: 'soft',
      instruction: 'Finish the current round with orchestrator_project_report, then stop. Do not create Tickets or start new Assignments.' }
    try {
      await this.prompt(project.pmSessionId, requestId, JSON.stringify(payload), 'queue')
      result.delivered = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn('dsh-superagent could not deliver the soft-pause notice for Project %s: %s', project.id, message)
      result.failures.push({ sessionId: project.pmSessionId, error: message })
    }
    return result
  }
  /** Resume a Project's Sessions: no Assignment is restarted and no message is sent; the PM reads the Engine's note. */
  async resumeProject(_project: ProjectProfile): Promise<ProjectPauseResult> {
    return { delivered: false, cancelled: [], notLoaded: [], failures: [] }
  }
  /** The PM Session and every Worker Session of every child Ticket of a Project, without duplicates; a Worker may have several after handoffs. */
  private projectSessions(project: ProjectProfile): string[] {
    const child = this.host.store.tickets.list().filter(ticket => ticket.projectId === project.id).flatMap(ticket => workerSessionsOf(ticket))
    return [...new Set([project.pmSessionId, ...child])]
  }
  /**
   * Ask the host to archive or unarchive a Project's Sessions. A host without the API is reported as unavailable; each
   * failure is logged and returned so the Project state, which stays authoritative, does not hide it.
   */
  private async changeProjectSessions(project: ProjectProfile, archive: boolean): Promise<SessionArchiveResult> {
    const registry = this.ctx.get('workspaceRegistry') as {
      archiveSession?: (sessionId: SessionId, options?: { stopActivity?: boolean }) => Promise<void>
      unarchiveSession?: (sessionId: SessionId) => Promise<void>
    } | undefined
    const method = archive ? registry?.archiveSession : registry?.unarchiveSession
    if (typeof method !== 'function') {
      this.ctx.logger.warn('dsh-superagent: the host offers no %s; Project %s Sessions were not changed', archive ? 'archiveSession'
        : 'unarchiveSession', project.id)
      return { ids: [], failures: [], unavailable: true }
    }
    const ids: string[] = [], failures: { sessionId: string; error: string }[] = []
    for (const sessionId of this.projectSessions(project)) {
      try {
        if (archive) {
          // A retried archive must reach only the Sessions an earlier attempt missed; DSH reports the archived set, so an
          // already archived Session is recorded as done without another host call. A Session previously absent is retried,
          // because it may exist now (P2-A04).
          if (!this.absentSessions.has(sessionId) && this.archivedSession(sessionId) === true) { ids.push(sessionId); continue }
          await registry!.archiveSession!(sessionId as SessionId, { stopActivity: true })
          this.absentSessions.delete(sessionId)
        } else await registry!.unarchiveSession!(sessionId as SessionId)
        ids.push(sessionId)
      } catch (error) {
        // A never-started Worker has no Session to archive; the host reports a definite miss, not a transient failure.
        // Treat it as done so reconcile does not retry it forever (P2-A04).
        if (error instanceof WorkspaceUnknownSessionError
          || (error instanceof Error && error.name === 'WorkspaceUnknownSessionError')) {
          this.absentSessions.add(sessionId)
          ids.push(sessionId)
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn('dsh-superagent could not %s Session %s: %s', archive ? 'archive' : 'unarchive', sessionId, message)
        failures.push({ sessionId, error: message })
      }
    }
    return { ids, failures }
  }
  /** Whether the host reports `sessionId` archived; undefined when the host offers no archived Session ids. */
  archivedSession(sessionId: string): boolean | undefined {
    const registry = this.ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly string[] } | undefined
    if (!registry || !Array.isArray(registry.archivedSessionIds)) return undefined
    return registry.archivedSessionIds.map(String).includes(sessionId)
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: DeliveryMode, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /**
   * Enqueues a steering relay to `sessionId`, the main Session by default; relays are durable and retried by `Effects` until
   * delivered, at most once per `requestId`.
   */
  relay(requestId: string, text: string, summary?: string, sessionId?: string): void {
    this.host.effects.enqueue('relay', requestId, { text, ...(summary ? { summary } : {}), ...(sessionId ? { sessionId } : {}) })
  }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    const master = agent.id === host.masterId
    const projectId = master ? undefined : projectOfSession(agent.id)
    const project = projectId ? host.store.projects.get(projectId) : undefined
    const ticket = master || project ? undefined : this.ticketOf(agent)
    if (!master && !ticket && !project) { this.limitSubagent(agent); return }
    const role = master ? 'orchestrator' as const : project ? 'pm' as const : 'worker' as const
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    try {
      this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
      if (agent.status === 'idle') this.retryHealth.clear(agent.id)
      this.updateModelHealth()
      // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
      binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
        const version = this.promptFor(agent, context.signal !== undefined)
        const current = ticket && host.store.tickets.get(ticket.id)
        const latest = project && host.store.projects.get(project.id)
        const composed = host.prompts.compose(version.config, role, current ? host.environment(current) : undefined)
        const mandate = current ? mandateInstructions(current.mandate) : ''
        const contextSection = latest ? `\n\n${pmProjectSection(latest)}` : ''
        // The notes are in the section just composed; the PM's next prompt has now delivered them. Adding a note while PM is
        // idle never wakes it, so this is the only point that consumes the queue.
        if (latest?.pendingNotes?.length) this.deliverProjectNotes(latest.id, latest.pendingNotes.map(note => note.id))
        return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${mandate}${contextSection}`
      }, ...(master || project ? { complete: true } : {}) }))
      // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
      const skillScope = agent.ctx.inject(['skills'], scope => {
        binding.scope = scope
        binding.skills = undefined
        this.bindSkills(binding, host.prompts.current())
      })
      binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
      await skillScope
      // Bail out if the agent was disposed while awaiting the skill scope.
      if (this.bindings.get(agent) !== binding) return
      // Apply a role's capability boundary before its tools: a PM's guard must exist before the first PM tool, and a failure
      // while registering cannot leave a Session with tools but no bound (see pmToolBoundary and the retry entry).
      if (master) {
        const shell = process.platform === 'win32' && agent.ctx.tools.get('pwsh', scopeParentOf(agent)) ? 'pwsh' : 'bash'
        binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', shell, 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
          agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
      } else if (project) {
        // A Project's PM reads records, creates/messages its Tickets and reports; the preset gives it no shell, file, web or
        // subagent tools, and its boundary hides anything else the host would otherwise inherit into the Session.
        binding.disposers.push(...pmToolBoundary(agent))
      }
      const register = this.registerTool(agent, binding)
      for (const tool of host.tools(agent, { ...ticket ? { ticket } : {}, ...project ? { project } : {} })) register(tool.name, tool.description, tool.schema, tool.execute)
      if (!master && !project) {
        // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
        binding.disposers.push(...this.workOnly(agent, ticket!.id))
      }
    } catch (error) {
      // A retried PM start must decorate from scratch: release what this attempt registered so the next ensure() does not
      // return early on a half-decorated binding. The release also removes any boundary or tool installed before the failure.
      if (this.bindings.get(agent) === binding) this.release(agent)
      throw error
    }
  }
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  /**
   * An Executor Session's tools: only the profile's work tools its Ticket's Mandate allows, which DSH requires to be known,
   * and none once its ticket ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session;
   * only automated input waits (see the executor). Read inherited tools through the parent scope, which includes the preset's
   * tools. The global view misses preset tools; the agent's own view also includes local tools such as subagent, which
   * restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allowed = store.tickets.get(ticketId)?.mandate.allowTools
    const allow = WORK_TOOLS.filter(name => (!allowed?.length || allowed.includes(name)) && agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      if (current?.archived) return 'Ticket is archived with its Project; unarchive the Project before continuing work'
      if (!current || !liveTicket(current)) return 'Ticket ended; new work needs a new authorized ticket'
      if (ticketOfSession(agent.id) === ticketId && latestSessionId(current) !== agent.id) {
        return 'This Worker Session was handed off; the work of this Ticket continues in its new Session, and this one keeps only history'
      }
      return assignmentStopped(latestAssignment(current)) ? 'Assignment stopped by the operator; use Retry before continuing work' : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, narrowed by the same Mandate allowlist, and none once the worker's
   * ticket ended. Any other agent is left as it is.
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  /** Clear the notes whose text the PM's prompt section just carried, so they are delivered once and never wake it. */
  private deliverProjectNotes(projectId: string, noteIds: readonly string[]): void {
    const project = this.host.store.projects.get(projectId)
    if (!project?.pendingNotes?.length) return
    const pendingNotes = project.pendingNotes.filter(note => !noteIds.includes(note.id))
    const updated = { ...project, ...pendingNotes.length ? { pendingNotes } : {}, updatedAt: new Date().toISOString() }
    if (!pendingNotes.length) delete (updated as { pendingNotes?: unknown }).pendingNotes
    this.host.store.projects.save(updated)
  }
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
