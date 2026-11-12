/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, latestSessionId, reasonText, workerSessionsOf, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger }
  from '../core/index.ts'
import { policyVersion, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { DEFAULT_MAIN_SESSION_OPERATOR, mainSessionKind, MAIN_SESSION_SOURCE, syncMainSessionOperator } from '../sources/main-session.ts'
import { internalKind } from '../sources/internal.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, executionStatus, followupNotice, projectPauseRelay, relaySession } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { ArchiveReconciler } from './archive-reconcile.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, pmTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()
/** Limits a host may pass to the Runtime; production keeps the defaults and tests inject shorter waits. */
export interface RuntimeOptions {
  /** How long a pause or handoff waits for a Worker's background cleanup before treating it as failed. */
  cleanupTimeoutMs?: number
}

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly archiveReconciler: ArchiveReconciler
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  /** Set once the state directory lock is compromised: the Store is closed and the runtime must not write again. */
  private compromisedError?: Error
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void, options: RuntimeOptions = {}) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    let opened: Store | undefined
    // A compromised lock is fatal: close the database at once, so no read or write can race the process that may now hold
    // the state directory, report the failure to the host, and abort the runtime lifetime. The host stops the plugin.
    const compromised = (error: Error) => { this.failClosed(error, opened) }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      // The lock can be compromised while this synchronous constructor runs (or by a lock check just after acquiring it).
      if (this.compromisedError) throw this.compromisedError
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      sources.register(mainSessionKind)
      sources.register(internalKind)
      const userSession = sources.instance<{ operator: string }>(MAIN_SESSION_SOURCE)
      const operator = userSession?.config.operator ?? DEFAULT_MAIN_SESSION_OPERATOR
      // Seed the default User Session policy once. A later change of its operator is synced below.
      if (!store.get(KV.runtime.mainSessionPolicySeeded)) {
        const current = store.settings()
        if (!current.policy.sources[MAIN_SESSION_SOURCE]) {
          const value = { ...current, policy: { ...current.policy, sources: { ...current.policy.sources,
            [MAIN_SESSION_SOURCE]: { allowed: [{ id: operator }], admission: {} } } } }
          store.saveSettings(value, { source: 'internal', block: 'policy', policyVersion: policyVersion(value), policyChanged: false, notified: [] })
        }
        store.set(KV.runtime.mainSessionPolicySeeded, true)
      }
      // A configured operator is authoritative: repair a hand-edited or older allowed list at every start.
      if (userSession) {
        const current = store.settings()
        const synced = syncMainSessionOperator(current, userSession.config.operator)
        if (synced !== current) {
          store.saveSettings(synced, { source: 'internal', block: 'policy', policyVersion: policyVersion(synced), policyChanged: false, notified: [] })
        }
      }
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        stateDir: machine.stateDir, lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, target) => target.ticket ? executorTools(this.toolHost, target.ticket)
          : target.project ? pmTools(this.toolHost, target.project) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, cleanupTimeoutMs: options.cleanupTimeoutMs, sessions, closing: () => this.closing(), paused: () => this.paused(),
        environment, sourceLink: link, repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      // A delegated Ticket's authority is its Project's PM Mandate: the Policy must be able to see the Project to revalidate it.
      const policy = () => settingsPolicy(store.settings(), sources, projectId => store.projects.get(projectId))
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, cleanupTimeoutMs: options.cleanupTimeoutMs,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          // A Project Ticket's lifecycle stays in its Project: the PM reads it, and the Router is not told about every child.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          const notice = this.quiet || ended?.projectId ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's Project pause is reported to the Router once, durably, with the Workers stopped and any failure; the
          // individual Worker stops are not relayed to the PM that the pause also stopped.
          if (event.type === 'project.pausedByUser') {
            const paused = store.projects.get(event.data.projectId)
            if (paused) {
              const relay = projectPauseRelay(paused, event.data)
              sessions.relay(relay.id, relay.text, relay.summary)
            }
          }
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          if (ended && setup.configured()) {
            const source = store.triggers.get(ended.origin.triggerId)
            const request = source?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
            if (source?.source === 'main-session' && ended.ended?.by === 'human' && ended.ended.outcome === 'stopped'
              && !ended.assignments.some(item => item.endedAt === ended.ended?.at)) {
              const relay = executionStatus(ended, 'cancel_ticket', latestSessionId(ended), ended.ended.at, ended.assignments.at(-1)?.id)
              const project = ended.projectId ? store.projects.get(ended.projectId) : undefined
              sessions.relay(relay.id, relay.text, relay.summary, relaySession(ended, project))
            }
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.archiveReconciler = new ArchiveReconciler({ context: ctx, store, engine, sessions,
        configured: () => setup.configured(), closing: () => this.closing() })
      this.archiveReconciler.install()
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        localEntry: () => { const instance = sources.instance<{ operator: string }>(MAIN_SESSION_SOURCE)
          return instance ? { enabled: instance.enabled, operator: instance.config.operator } : undefined },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  /** Run one native DSH archive reconciliation now, as the 30-second fallback and archive events do. */
  reconcileArchives(): Promise<void> { return this.archiveReconciler.reconcile() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /**
   * Fail closed after the state directory lock is reported compromised: abort the lifetime, report the failure, and close
   * the database at once so this process cannot read or write state that another process may now own. Closing is
   * idempotent, so a later `stop()` closes it again harmlessly. This never calls `process.exit`: the host reads the error
   * health state and stops the plugin, and `stop()` still tries to release the (already compromised) lock.
   */
  private failClosed(error: Error, store?: Store): void {
    if (!this.compromisedError) this.compromisedError = error
    this.closingFlag = true
    this.runtimeHealth.set({ state: 'error', detail: `Lost the state directory lock: ${error.message}`, at: now() })
    this.stopped.abort()
    if (!store) return
    try { store.close() } catch (failure) {
      // Closing can fail while another operation is in flight; log it and never reopen or keep using the database.
      this.ctx.logger.warn('dsh-superagent could not close its database after losing the state directory lock: %s', String(failure))
    }
  }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    if (this.compromisedError) return
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    // Fail any Handoff a previous process left `starting` before setup or any Worker resume could act on it; it starts
    // nothing, so a crash between a handoff's two transactions can never leave a stuck Ticket or a surprise Worker.
    this.engine.recoverInterruptedHandoffs()
    const configured = await this.setup.run(this.store.settings())
    // A compromise during setup already reported the error and closed the Store; do not overwrite it with `paused` or `ready`.
    if (this.compromisedError) return
    if (!configured) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing() || this.compromisedError) return
    this.executor.resume()
    this.passes.start()
    this.archiveReconciler.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    const failures: unknown[] = []
    /** Run one teardown step; a failure is logged and later steps still run, so a closed Store cannot skip them. */
    const attempt = async (what: string, run: () => unknown | Promise<unknown>): Promise<void> => {
      try { await run() } catch (error) {
        failures.push(error)
        this.ctx.logger.warn('dsh-superagent could not %s while stopping: %s', what, String(error))
      }
    }
    const agents: Agent[] = []
    try {
      await attempt('stop the assessor', () => this.assessor.stop())
      await attempt('stop archive reconciliation', () => this.archiveReconciler.stop())
      await attempt('cancel the master and worker Sessions', () => {
        // A compromised lock already closed the Store; there is nothing left to read, so only the master Session is named
        // here. The Executor keeps its loaded worker Sessions and cancels those in its own shutdown below.
        const ids = [this.masterId, ...(this.store.closed ? [] : this.store.tickets.list().flatMap(ticket => workerSessionsOf(ticket)))]
        const failed: unknown[] = []
        for (const id of ids) {
          const agent = this.ctx.agents.get(id as SessionId)
          if (!agent) continue
          agents.push(agent)
          try { agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch (error) { failed.push(error) }
        }
        // Every loaded Session got its cancel; one failing still lets the rest stop.
        if (failed.length) throw failed[0]
      })
      await attempt('wait for running Sessions', () =>
        Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())]))
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      // The Executor uses its in-memory loaded Sessions when the Store is closed, so a compromised lock still cancels them.
      await attempt('stop the Executor', () => this.executor.shutdown())
      await attempt('dispose the Executor', () => this.executor.dispose())
      await attempt('dispose Sessions', () => this.sessions.dispose())
      await attempt('dispose HTTP routes and listeners', () => {
        const failed: unknown[] = []
        for (const dispose of this.disposers.splice(0).reverse()) {
          try { dispose() } catch (error) { failed.push(error) }
        }
        if (failed.length) throw failed[0]
      })
      await attempt('flush Session persistence', () => this.ctx.sessionPersistence.flush())
      // A normal shutdown still reports its first teardown failure after every step was attempted; after a compromised
      // lock the failure is already logged and stop() must resolve so the host can finish stopping.
      if (!this.store.closed && failures.length) throw failures[0]
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released, and close is idempotent.
      try { this.setup.restore() } catch (error) {
        this.ctx.logger.warn('dsh-superagent could not restore its process environment while stopping: %s', String(error))
      }
      try { this.store.close() } catch (error) {
        this.ctx.logger.warn('dsh-superagent could not close its database while stopping: %s', String(error))
      }
      const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
        String(error)) }
      await this.releaseLock?.().catch(unreleased)
    }
  }
}
