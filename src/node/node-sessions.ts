/**
 * The node-only `DshPortSessions`: real DSH Sessions driven through `agents`, `sessionQuery`, `agentPresets`,
 * `sessionTitle` and `sessionPersistence` only.
 *
 * An execution node runs in its own DSH profile, which mounts none of `sessionController`, `fileUploads` or `webServer`:
 * those come from the Web app and the client file-upload plugin (see docs/013 §0). Creation is therefore explicit here —
 * a live Agent is reused, a persisted Session is resumed, and anything else is created with its role's preset — while the
 * title and the profile's model are applied before the Session's first turn. The host applies the profile's permission
 * after this returns, because a permission preset is set on the live Session, not on a creation option.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions, ModelSelection, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
// These augment DSH's `Context` with `agents`, `sessionPersistence` and `permissionPresets`; imports are type-only.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { AgentDelivery } from '../app/delivery.ts'
import { initializeRoleModel, resolveRoleModel } from '../app/role-models.ts'
import type { RoleModel } from '../policy.ts'
import type { DeliveryEvidence, RoleProfile, RouterModel, RouterOptions } from '../shared/protocol.ts'
import type { DshPortSessions } from './dsh-port-host.ts'

/**
 * The agent presets a node profile defines for its Sessions.
 *
 * These mirror `PM_PRESET`, `WORKER_PRESET` and `ROUTER_PRESET` in `src/app/sessions.ts`; that module is the control
 * plane's own Session decoration (it imports the Store, the Engine's domain types and zod), so a node keeps its own copy of
 * the three ids and never loads it. The profile's `cordis.patch.yml` must define all three rows with these ids
 * (docs/013 §1.2).
 */
export const NODE_ROLE_PRESETS = { pm: 'dsh-superagent-pm', worker: 'dsh-superagent-worker',
  router: 'dsh-superagent-router' } as const

/**
 * The part of DSH's preset registry (`@deepseek-ai/dsh-agent-preset-registry`) an Agent is created with.
 *
 * `mount` composes a preset into an unpublished Agent scope from its setup callback, so the Agent's tools and prompt
 * sections exist before `agent/created` and the first prompt assembly. `resolve` reports a broken definition before
 * anything is created.
 */
interface AgentPresets {
  resolve(id: string): Promise<{ id: string; broken?: unknown }>
  mount(agentCtx: Context, id: string): Promise<{ id: string }>
}

/** The part of DSH's `sessionQuery` service this adapter reads: whether a Session exists outside this process. */
interface SessionQuery {
  /** Returns a caller-owned observation lease; a projection-free read is enough to prove the Session exists. */
  observeSession(sessionId: SessionId, options?: { projectionMode?: 'none' | 'all' }): Promise<unknown>
}

/** The part of DSH's `sessionTitle` service this adapter uses to name a Session. */
interface SessionTitle {
  get?(session: Session): { title: string } | undefined
  rename(session: Session, title: string): { title: string }
}

/**
 * The part of `@deepseek-ai/dsh-agent-default-model` a node-only profile provides but has no consumer for.
 *
 * The Web app's `api-session-controller` and the headless CLI both read this service and seed its selection onto a new
 * Agent; a node mounts neither, so this adapter is the consumer. The service is not part of `dsh-base` and is therefore
 * not declared on the typed `Context` surface, so it is read by name and narrowed to the one call needed.
 */
interface AgentDefaultModel {
  /** A detached `{ provider, model, reasoningEffort? }` for a freshly created Agent, or nothing when the profile set none. */
  currentSelection(): Partial<ModelSelection> | undefined | null
}

/** Options for the node-only Sessions adapter. */
export interface NodeSessionsOptions {
  /** Cancels a delivery in flight; the plugin aborts it when DSH disposes the node plugin. */
  signal?: AbortSignal
  defaultModel?: RoleModel
}

/**
 * `DshPortSessions` over the DSH services a node-only profile provides.
 *
 * `ensure` never trusts a status alone: an already live Agent is reused as it is (a re-sent `pm.ensure` must not restate
 * its title or reopen its Session), a Session that `sessionQuery` can observe is resumed, and only an unknown id is
 * created. Either branch composes the role's preset in the setup callback, so a Worker or PM Session has its tool
 * boundary from its first turn. `prompt` reuses `AgentDelivery`, which deduplicates per message id across restarts by
 * reading the persisted log, so a retried `session.message` cannot reach the model twice.
 */
export class NodeSessions implements DshPortSessions {
  private readonly delivery: AgentDelivery
  private readonly signal: AbortSignal
  private readonly rolePrompts = new WeakMap<Agent, { text: string }>()
  private readonly routerModels = new WeakMap<Agent, { selected?: ModelSelection }>()
  private catalog?: { expires: number; models: Promise<RouterOptions['models']> }

  constructor(private readonly ctx: Context, private readonly options: NodeSessionsOptions = {}) {
    this.delivery = new AgentDelivery(ctx)
    this.signal = options.signal ?? new AbortController().signal
  }

  /** Resolves, resumes or creates `sessionId`, then names it; returns the live Agent for the host's proxy tools. */
  async ensure(sessionId: string, directory: string, title: string, role: 'pm' | 'worker' | 'router',
    profile?: RoleProfile): Promise<Agent> {
    const id = sessionId as SessionId
    let agent = this.ctx.agents.get(id)
    if (!agent) {
      agent = await this.persisted(id) ? await this.resume(id, role, profile) : await this.create(id, directory, role, profile)
    }
    // Seed on every path, not only after create/resume: a live Agent reused after an earlier ensure failed before it
    // could apply the route must still become runnable. `initializeRoleModel` itself skips an Agent that already has a
    // request header or a recorded selection, so a healthy repeated ensure re-reads the default but never re-seeds it.
    await this.applyDefaultModel(agent, profile)
    if (role === 'router') this.bindRouterModel(agent)
    this.applyTitle(agent, title)
    return agent
  }

  /**
   * Delivers `text` once per idempotency key to `sessionId`'s next turn.
   *
   * `onDelivered` runs once the message is in the Agent's inbox, which may happen before the persistence flush this
   * promise also waits for; a retry that finds the message still waiting there reports it again.
   */
  async prompt(sessionId: string, idempotencyKey: string, text: string, mode: 'queue',
    onDelivered?: () => void): Promise<void> {
    const agent = this.ctx.agents.get(sessionId as SessionId)
    // A node holds no Session registry of its own: an id this process does not run is the control plane's cue to ensure it.
    if (!agent) throw new Error(`Session ${sessionId} is not loaded on this node`)
    await this.delivery.send(agent, idempotencyKey, text, mode, this.signal,
      /* authorize */ undefined, /* accepted */ undefined, onDelivered)
  }

  /**
   * What this node can prove about one delivery.
   *
   * The proof comes from the Session's own persisted history. A Session this process does not run cannot be read at all,
   * and the answer is then `unknown`: the node that may have received the message is not this one.
   */
  async evidence(sessionId: string, idempotencyKey: string): Promise<DeliveryEvidence> {
    const agent = this.ctx.agents.get(sessionId as SessionId)
    if (!agent) return { state: 'unknown', reason: 'this node does not run that Session' }
    return this.delivery.evidence(agent, idempotencyKey)
  }

  setRolePrompt(sessionId: string, text: string): void {
    const agent = this.ctx.agents.get(sessionId as SessionId)
    if (!agent) throw new Error(`Session ${sessionId} is not loaded on this node`)
    const existing = this.rolePrompts.get(agent)
    if (existing) {
      existing.text = text
      return
    }
    const prompt = { text }
    agent.ctx.systemPrompt.section({ name: 'dsh-superagent-node-role', order: 9999,
      interpolate: false, text: () => prompt.text })
    this.rolePrompts.set(agent, prompt)
  }

  private bindRouterModel(agent: Agent): void {
    if (this.routerModels.has(agent)) return
    const selected = agent.session.snapshotEvents().findLast(event => event.type === 'model/selection')?.data
    const route: { selected?: ModelSelection } = selected ? { selected: {
      provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort ? { reasoningEffort: ReasoningEffortId(selected.reasoningEffort) } : {}),
    } } : {}
    this.routerModels.set(agent, route)
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next()
      const model = route.selected
      return model ? { ...result, variables: { ...result.variables, provider: model.provider, model: model.model } } : result
    }, { prepend: true })
    agent.ctx.on('agent/request', async (_payload, next) => {
      const result = await next()
      if (!route.selected) return result
      const { reasoningEffort: _previous, ...rest } = result
      return { ...rest, ...route.selected }
    }, { prepend: true })
  }

  private modelCatalog(): Promise<RouterOptions['models']> {
    if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.models
    const models = Promise.allSettled(this.ctx.llm.listProviders().map(async provider =>
      (await this.ctx.llm.listModels(provider.id)).map(model => ({
        provider: provider.id, model: model.id, name: model.name,
      }))
    )).then(results => results.flatMap(result => result.status === 'fulfilled' ? result.value : []))
    this.catalog = { expires: Date.now() + 60_000, models }
    return models
  }

  async selectRouterModel(sessionId: string, model: RouterModel): Promise<void> {
    const agent = this.ctx.agents.get(sessionId as SessionId)
    const route = agent && this.routerModels.get(agent)
    if (!agent || !route) throw new Error('The Router Session is not loaded')
    if (route.selected?.model === model.model && route.selected.provider === model.provider) return
    if (!(await this.modelCatalog()).some(item => item.provider === model.provider && item.model === model.model)) {
      throw new Error('This model is not available on the Router node')
    }
    const selection = await resolveRoleModel(this.ctx, model)
    if (agent.status === 'running') throw new Error('Wait until the Router finishes before changing models')
    route.selected = selection
    agent.session.append('model/selection', selection)
  }

  async routerOptions(sessionId: string): Promise<RouterOptions> {
    const agent = this.ctx.agents.get(sessionId as SessionId)
    const options: RouterOptions = { models: await this.modelCatalog() }
    const fallback = this.options.defaultModel ?? serviceOf<AgentDefaultModel>(this.ctx, 'agentDefaultModel')?.currentSelection()
    const selected = agent ? this.routerModels.get(agent)?.selected ?? agent.session.requestHeader()?.config ?? fallback : fallback
    if (selected?.provider && selected.model) options.selected = { provider: selected.provider, model: selected.model }
    if (!agent) return options
    const log = agent.session.snapshotEvents()
    const index = log.findLastIndex(event => event.type === 'assistant/message' && event.data.usage !== undefined)
    if (index < 0) return options
    const reply = log[index]!
    if (reply.type !== 'assistant/message' || reply.data.usage === undefined) return options
    const preceding = log.slice(0, index)
    const context = preceding.findLast(event => event.type === 'request/context')?.data
    const config = preceding.findLast(event => event.type === 'request/header')?.data.header.config
    if (config) {
      const usage = reply.data.usage
      const tokens = usage.totalTokens ?? (usage.inputTokens + usage.outputTokens
        + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
      const contextWindow = context?.provider === config.provider && context.model === config.model
        ? context.contextWindow : undefined
      options.usage = { provider: config.provider, model: config.model, tokens,
        ...(contextWindow === undefined ? {} : { contextWindow }) }
    }
    return options
  }

  /** Whether `sessionId` exists outside this process, which decides between resume and create. */
  private async persisted(id: SessionId): Promise<boolean> {
    const query = this.ctx.get('sessionQuery') as SessionQuery | undefined
    if (typeof query?.observeSession !== 'function') {
      throw new Error('The node requires @deepseek-ai/dsh-session-query: the sessionQuery service is not available')
    }
    try {
      // The lease keeps the prepared observation cached; it is released at once because only existence is needed here,
      // and an undisposed lease would pin that cache entry for the life of the process.
      release(await query.observeSession(id, { projectionMode: 'none' }))
      return true
    } catch (error) {
      // The service reports an absent id with a stable code; anything else is a real read failure and must not become a create.
      if ((error as { code?: unknown } | null)?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return false
      throw error
    }
  }

  /** Creates a new Agent on `id` in `directory`, recording the role preset in the Session's metadata. */
  private async create(id: SessionId, directory: string, role: 'pm' | 'worker' | 'router', profile?: RoleProfile): Promise<Agent> {
    const preset = await this.rolePreset(role)
    const options: CreateAgentOptions = { sessionId: id, meta: { cwd: directory, agentPreset: preset },
      setup: agentCtx => this.mount(agentCtx, preset), ...modelOptions(profile) }
    return agentOf(await this.ctx.agents.create(options))
  }

  /** Resumes the persisted Session on `id`, recomposing the role preset in its fresh scope. */
  private async resume(id: SessionId, role: 'pm' | 'worker' | 'router', profile?: RoleProfile): Promise<Agent> {
    const preset = await this.rolePreset(role)
    const options: ResumeAgentOptions = { resumeSessionId: id, setup: agentCtx => this.mount(agentCtx, preset),
      ...modelOptions(profile) }
    return agentOf(await this.ctx.agents.resume(options))
  }

  /** Resolves one of the node profile's presets, failing before creation when the profile does not define it. */
  private async rolePreset(role: 'pm' | 'worker' | 'router'): Promise<string> {
    const presets = this.ctx.get('agentPresets') as AgentPresets | undefined
    if (typeof presets?.resolve !== 'function' || typeof presets.mount !== 'function') {
      throw new Error('The node requires @deepseek-ai/dsh-agent-preset-registry: the agentPresets service is not available')
    }
    const resolved = await presets.resolve(NODE_ROLE_PRESETS[role])
    // A definition whose activation failed would mount a partially composed world; refuse before creating anything.
    if (resolved.broken !== undefined) throw new Error(`The agent preset ${resolved.id} is not usable on this node`)
    return resolved.id
  }

  /**
   * Seeds the node profile's default model onto the Agent before its first turn.
   *
   * A node-only profile mounts `agent-default-model` for its configuration, but neither of the plugins that consume it
   * (the Web app's Session controller and the headless CLI) is part of a node. Without this, the Agent starts with no
   * provider/model and its first turn fails; this is the node's counterpart to `initializeRoleModel` in the control
   * plane. It runs on every ensure — a new Agent, a resumed one, and a live Agent reused after an earlier attempt failed
   * before the route was seeded. `RoleProfile.model` stays authoritative, so a role that names a route never even reads
   * the default; `initializeRoleModel` skips a Session that already has a request header or a recorded selection, so a
   * repeated ensure neither resolves the route again nor appends a second selection. A profile without the service, or
   * without a complete selection, keeps working as before; a route the host's `llm` cannot resolve fails the ensure
   * instead of starting a Session that cannot answer.
   */
  private async applyDefaultModel(agent: Agent, profile: RoleProfile | undefined): Promise<void> {
    if (profile?.model) return
    if (this.options.defaultModel) return initializeRoleModel(this.ctx, agent, this.options.defaultModel)
    const defaults = serviceOf<AgentDefaultModel>(this.ctx, 'agentDefaultModel')
    if (typeof defaults?.currentSelection !== 'function') return
    const selection = defaults.currentSelection()
    if (selection === undefined || selection === null) return
    const { provider, model } = selection
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return
    await initializeRoleModel(this.ctx, agent, {
      provider,
      model,
      ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
        ? { reasoningEffort: selection.reasoningEffort } : {}),
    })
  }

  /** Composes the preset into the unpublished Agent this setup callback is building. */
  private async mount(agentCtx: Context, preset: string): Promise<void> {
    const presets = this.ctx.get('agentPresets') as AgentPresets
    await presets.mount(agentCtx, preset)
  }

  /**
   * Names the Session, once its Agent exists and before its first turn.
   *
   * The title service is part of `dsh-base`; a profile without it still runs, so a missing service is a warning rather
   * than a failed ensure. A repeated ensure with the same title appends nothing, which keeps `pm.ensure` idempotent.
   */
  private applyTitle(agent: Agent, title: string): void {
    if (title === '') return
    const titles = this.ctx.get('sessionTitle') as SessionTitle | undefined
    if (typeof titles?.rename !== 'function') {
      this.ctx.logger.warn('dsh-superagent-node could not name Session %s: the host offers no sessionTitle service', agent.id)
      return
    }
    if (titles.get?.(agent.session)?.title === title) return
    titles.rename(agent.session, title)
  }
}

/** Builds the node-only Sessions adapter for one plugin context. */
export function createNodeSessions(ctx: Context, options: NodeSessionsOptions = {}): NodeSessions {
  return new NodeSessions(ctx, options)
}

/** The model route a RoleProfile names, when it names one; otherwise the host's default applies. */
function modelOptions(profile: RoleProfile | undefined): Pick<CreateAgentOptions, 'agentOptions'> {
  return profile?.model ? { agentOptions: { model: profile.model } } : {}
}

/**
 * Reads one service the typed `Context` surface does not declare.
 *
 * `agentDefaultModel` comes from an optional node profile plugin rather than `dsh-base`, so it is absent from the
 * installed type augmentation. The read is guarded: a minimal host without `get`, or a profile without the plugin,
 * yields `undefined` and the node keeps its old behavior instead of failing.
 */
function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const get = (ctx as { get?: unknown }).get
  return typeof get === 'function' ? (get as (this: Context, name: string) => T | undefined).call(ctx, name) : undefined
}

/** Releases a `sessionQuery` observation lease, whose `[Symbol.dispose]` frees its cache reference. */
function release(observation: unknown): void {
  const dispose = (observation as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose]
  if (typeof dispose === 'function') dispose.call(observation)
}

/**
 * The live Agent behind a creation result.
 *
 * `AgentRegistry.create`/`resume` resolve an `AgentHandle` (the handle owns teardown); an older host resolved the Agent
 * itself. The node does not take ownership: DSH disposes the Agent with the profile's tree.
 */
function agentOf(handle: AgentHandle | Agent): Agent {
  return 'agent' in handle ? handle.agent : handle
}
