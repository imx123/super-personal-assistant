/** The node-only entry: Sessions driven by DSH services alone, the RoleProfile's permission, and the environment fail-fast. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { listenFetchLoopback } from './fixtures/fetch-port.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDshPortHost } from '../src/node/dsh-port-host.ts'
import { createNodeSessions, NODE_ROLE_PRESETS } from '../src/node/node-sessions.ts'
import { apply, readNodeEnvironment } from '../src/node/plugin.ts'
import type { RoleProfile } from '../src/shared/protocol.ts'

const PM: RoleProfile = { name: 'pm.v1', prompt: 'Manage the Project.', tools: [], deny: [], permission: 'read-only' }
const WORKER: RoleProfile = { name: 'worker.v1', prompt: 'Do the work.', tools: ['read'], deny: [],
  permission: 'workspace-write' }

type Listener = (...args: unknown[]) => void
/** A handler the seeded model route registers on an Agent's scoped context (prompt assembly or request routing). */
type FakeHandler = (...args: any[]) => any

/** The events and model facts the fake Session records, matching what `initializeRoleModel` reads and writes. */
class FakeSession {
  readonly events: { type: string; data?: unknown }[] = []
  private header: unknown
  constructor(readonly id: string) {}
  requestHeader(): unknown { return this.header }
  snapshotEvents(): { type: string }[] { return this.events.map(event => ({ type: event.type })) }
  append(type: string, data?: unknown): void { this.events.push({ type, data }) }
  setHeader(header: unknown): void { this.header = header }
}

/** A scoped Agent context: `effect` records disposers and `run` drives the waterfall handlers it registered. */
class FakeScopedContext {
  readonly handlers = new Map<string, FakeHandler[]>()
  readonly disposers: (() => void)[] = []
  readonly promptSections: { text: () => string }[] = []
  readonly systemPrompt = {
    section: (section: { text: () => string }) => { this.promptSections.push(section) },
  }
  effect(factory: () => () => void): void { this.disposers.push(factory()) }
  on(name: string, handler: FakeHandler, _options?: unknown): () => void {
    const handlers = this.handlers.get(name) ?? []
    handlers.push(handler)
    this.handlers.set(name, handlers)
    return () => { this.handlers.set(name, handlers.filter(item => item !== handler)) }
  }
  /** Run one waterfall: each handler receives `args` and `next`, the fallback answers once no handler is left. */
  async run(name: string, args: unknown[], fallback: () => unknown): Promise<any> {
    const handlers = this.handlers.get(name) ?? []
    let index = 0
    const next = async (): Promise<unknown> => {
      const handler = handlers[index++]
      return handler ? handler(...args, next) : fallback()
    }
    return next()
  }
}

/** The live Agent the fake registry hands out; `ensure` only needs its id, session, model context and inbox. */
class FakeAgent {
  readonly inbox = { nextTurn: [] as { id: unknown }[], nextStep: [] as { id: unknown }[] }
  readonly session: FakeSession
  readonly ctx = new FakeScopedContext()
  constructor(readonly id: string) { this.session = new FakeSession(id) }
  followup(message: { id: unknown }): void { this.inbox.nextTurn.push(message) }
  cancel(): void {}
  whenIdle(): Promise<void> { return Promise.resolve() }
}

/** The `sessionTitle` service's two calls, with a current title so a repeat ensure can be skipped. */
class FakeTitles {
  readonly renames: string[] = []
  private current?: string
  constructor(title?: string) { this.current = title }
  get(_session: unknown): { title: string } | undefined { return this.current === undefined ? undefined : { title: this.current } }
  rename(_session: unknown, title: string): { title: string } {
    this.current = title
    this.renames.push(title)
    return { title }
  }
}

/** The preset registry: `resolve` reports the requested id and `mount` records the setup-time composition. */
class FakePresets {
  readonly mounted: string[] = []
  resolve(id: string): Promise<{ id: string }> { return Promise.resolve({ id }) }
  mount(_agentCtx: unknown, id: string): Promise<{ id: string }> {
    this.mounted.push(id)
    return Promise.resolve({ id })
  }
}

/** Facts a test can give the fake node context: persistence, live Sessions, and the model services. */
interface HarnessOptions {
  persisted?: readonly string[]
  live?: readonly string[]
  title?: string
  presets?: boolean
  /** The route `agent-default-model` exposes; absent means a profile that does not mount the service. */
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  /** The error `llm.resolveCallConfig` raises; unset resolves the requested route unchanged. */
  modelFailure?: string
  /** Session facts a new or resumed Agent starts with, as a resumed Session would already hold. */
  sessionEvents?: readonly { type: string; data?: unknown }[]
  sessionHeader?: unknown
}

/** A context with every service the node-only adapter reads, and nothing else. */
function harness(options: HarnessOptions = {}) {
  /** Build an Agent carrying the Session facts a resumed (or otherwise pre-existing) Session would already have. */
  const makeAgent = (id: string): FakeAgent => {
    const agent = new FakeAgent(id)
    for (const event of options.sessionEvents ?? []) agent.session.append(event.type, event.data)
    if (options.sessionHeader !== undefined) agent.session.setHeader(options.sessionHeader)
    return agent
  }
  const live = new Map<string, FakeAgent>()
  for (const id of options.live ?? []) live.set(id, makeAgent(id))
  const persisted = new Set(options.persisted ?? [])
  const created: CreateAgentOptions[] = []
  const resumed: ResumeAgentOptions[] = []
  const presets = new FakePresets()
  const titles = new FakeTitles(options.title)
  const permissionSets: { session: unknown; preset: string }[] = []
  const permissions = { names: ['workspace-write', 'danger-full-access'],
    set(session: unknown, preset: string): void { permissionSets.push({ session, preset }) } }
  /** Calls the seeded default route made, so a test can prove when it was (or was not) read and resolved. */
  const model = { selections: 0,
    resolveCalls: [] as { provider: string; model: string; reasoningEffort?: unknown }[] }
  /** The live provider `role-models.ts` resolves a route through; accessed as `ctx.llm` like a Cordis service. */
  const llm = {
    async resolveCallConfig(request: { provider: string; model: string; reasoningEffort?: unknown }) {
      model.resolveCalls.push(request)
      if (options.modelFailure !== undefined) throw new Error(options.modelFailure)
      return { ...request }
    },
  }
  const context = {
    agents: {
      get: (id: string): FakeAgent | undefined => live.get(id),
      async create(options: CreateAgentOptions): Promise<{ agent: FakeAgent; dispose: () => Promise<void> }> {
        created.push(options)
        await options.setup?.({} as Context, undefined as never)
        const agent = makeAgent(String(options.sessionId))
        live.set(agent.id, agent)
        return { agent, dispose: async () => {} }
      },
      async resume(options: ResumeAgentOptions): Promise<{ agent: FakeAgent; dispose: () => Promise<void> }> {
        resumed.push(options)
        await options.setup?.({} as Context, undefined as never)
        const agent = makeAgent(String(options.resumeSessionId))
        live.set(agent.id, agent)
        return { agent, dispose: async () => {} }
      },
    },
    logger: { info(): void {}, warn(): void {} },
    llm,
    on(_name: string, _listener: Listener): () => void { return () => {} },
    get(name: string): unknown {
      switch (name) {
        case 'agentPresets': return options.presets === false ? undefined : presets
        case 'permissionPresets': return permissions
        case 'sessionQuery': return { async observeSession(id: string): Promise<void> {
          if (!persisted.has(id)) throw Object.assign(new Error(`no Session ${id}`), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        } }
        case 'sessionTitle': return titles
        case 'agentDefaultModel': {
          if (options.defaultModel === undefined) return undefined
          const defaultModel = options.defaultModel
          return { currentSelection(): { provider: string; model: string; reasoningEffort?: string } {
            model.selections += 1
            return { ...defaultModel }
          } }
        }
        case 'llm': return llm
        default: return undefined
      }
    },
    sessionPersistence: {
      async flush(): Promise<void> {},
      async open(): Promise<{ read(): Promise<{ events: unknown[] }>; [Symbol.asyncDispose](): Promise<void> }> {
        return { async read() { return { events: [] } }, async [Symbol.asyncDispose]() {} }
      },
    },
  }
  return { context: context as unknown as Context, created, resumed, presets, titles, permissionSets, live, model }
}

let directory = ''
let root = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-node-plugin-'))
  root = join(directory, 'node')
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('NodeSessions.ensure', () => {
  it('creates a Session with its role preset and the profile model, then names it', async () => {
    const { context, created, presets, titles } = harness()
    const agent = await createNodeSessions(context).ensure('pm-1', directory, 'Project One', 'pm',
      { ...PM, model: 'deepseek-v4' })

    expect(String(agent.id)).toBe('pm-1')
    expect(presets.mounted).toEqual([NODE_ROLE_PRESETS.pm])
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ sessionId: 'pm-1', agentOptions: { model: 'deepseek-v4' },
      meta: { cwd: directory, agentPreset: NODE_ROLE_PRESETS.pm } })
    expect(titles.renames).toEqual(['Project One'])
  })

  it('resumes a persisted Session instead of creating it', async () => {
    const { context, created, resumed, presets } = harness({ persisted: ['worker-1'] })
    await createNodeSessions(context).ensure('worker-1', directory, 'Worker ticket-1', 'worker', WORKER)

    expect(created).toEqual([])
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toMatchObject({ resumeSessionId: 'worker-1' })
    expect(presets.mounted).toEqual([NODE_ROLE_PRESETS.worker])
  })

  it('reuses a live Agent without creating, resuming or restating its title', async () => {
    const { context, created, resumed, titles } = harness({ live: ['pm-1'], title: 'Project One' })
    const agent = await createNodeSessions(context).ensure('pm-1', directory, 'Project One', 'pm', PM)

    expect(String(agent.id)).toBe('pm-1')
    expect(created).toEqual([])
    expect(resumed).toEqual([])
    expect(titles.renames).toEqual([])
  })

  it('sets a title once, even when ensure is repeated', async () => {
    const { context, titles } = harness()
    const sessions = createNodeSessions(context)
    await sessions.ensure('pm-1', directory, 'Project One', 'pm', PM)
    await sessions.ensure('pm-1', directory, 'Project One', 'pm', PM)

    expect(titles.renames).toEqual(['Project One'])
  })

  it('seeds the node default model before the first turn and routes requests through it', async () => {
    const { context, created, live, model } = harness({ defaultModel: { provider: 'opencode-go',
      model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } })
    const sessions = createNodeSessions(context)
    const agent = await sessions.ensure('pm-1', directory, 'Project One', 'pm', PM)
    // A repeated ensure reuses the live Agent; the selection must not be appended a second time.
    await sessions.ensure('pm-1', directory, 'Project One', 'pm', PM)

    expect(created[0]?.agentOptions).toBeUndefined()
    // The repeated ensure re-reads the default, but `initializeRoleModel` skips the Session it already seeded.
    expect(model.selections).toBe(2)
    expect(model.resolveCalls).toEqual([{ provider: 'opencode-go', model: 'deepseek-v4.1-flash',
      reasoningEffort: 'high' }])
    const selections = live.get('pm-1')!.session.events.filter(event => event.type === 'model/selection')
    expect(selections).toEqual([{ type: 'model/selection',
      data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } }])

    // The seeded route is what prompt assembly and the request carry, not the host's own model.
    const fake = agent as unknown as FakeAgent
    const assembled = await fake.ctx.run('system-prompt/assemble', [{}, {}],
      () => ({ variables: { provider: 'host', model: 'host' } }))
    expect(assembled).toMatchObject({ variables: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })
    const request = await fake.ctx.run('agent/request', [{}],
      () => ({ provider: 'host', model: 'host', reasoningEffort: 'low' }))
    expect(request).toEqual({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' })
  })

  it('seeds the node default model on a resumed Session too', async () => {
    const { context, resumed, live, model } = harness({ persisted: ['worker-1'],
      defaultModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })
    await createNodeSessions(context).ensure('worker-1', directory, 'Worker ticket-1', 'worker', WORKER)

    expect(resumed).toHaveLength(1)
    expect(model.resolveCalls).toEqual([{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }])
    expect(live.get('worker-1')!.session.events.filter(event => event.type === 'model/selection')).toHaveLength(1)
  })

  it('seeds a live Agent that has no route, so a failed ensure can recover on retry', async () => {
    // The first ensure may have created the Agent and then failed; the control plane's retry finds it live.
    const { context, created, resumed, live, model } = harness({ live: ['pm-1'],
      defaultModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })
    await createNodeSessions(context).ensure('pm-1', directory, 'Project One', 'pm', PM)

    expect(created).toEqual([])
    expect(resumed).toEqual([])
    expect(model.resolveCalls).toEqual([{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }])
    expect(live.get('pm-1')!.session.events.filter(event => event.type === 'model/selection')).toHaveLength(1)
  })

  it('does not append a second selection to a live Agent that already has one', async () => {
    const { context, live, model } = harness({ live: ['pm-1'],
      defaultModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      sessionEvents: [{ type: 'model/selection', data: { provider: 'manual', model: 'manual' } }] })
    await createNodeSessions(context).ensure('pm-1', directory, 'Project One', 'pm', PM)

    expect(model.resolveCalls).toEqual([])
    expect(live.get('pm-1')!.session.events).toHaveLength(1)
  })

  it('writes no model selection when the profile offers no agentDefaultModel service', async () => {
    const { context, live, model } = harness()
    await createNodeSessions(context).ensure('pm-1', directory, 'Project One', 'pm', PM)

    expect(model.selections).toBe(0)
    expect(model.resolveCalls).toEqual([])
    expect(live.get('pm-1')!.session.events).toEqual([])
  })

  it('does not seed over an existing model selection or request header', async () => {
    const withSelection = harness({ defaultModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      sessionEvents: [{ type: 'model/selection', data: { provider: 'manual', model: 'manual' } }] })
    await createNodeSessions(withSelection.context).ensure('pm-1', directory, 'Project One', 'pm', PM)
    expect(withSelection.model.resolveCalls).toEqual([])
    expect(withSelection.live.get('pm-1')!.session.events).toHaveLength(1)

    const withHeader = harness({ defaultModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      sessionHeader: { provider: 'manual', model: 'manual' } })
    await createNodeSessions(withHeader.context).ensure('pm-1', directory, 'Project One', 'pm', PM)
    expect(withHeader.model.resolveCalls).toEqual([])
    expect(withHeader.live.get('pm-1')!.session.events).toEqual([])
  })

  it('does not read the default when the profile names a model', async () => {
    const { context, created, live, model } = harness({ defaultModel: { provider: 'opencode-go',
      model: 'deepseek-v4.1-flash' } })
    await createNodeSessions(context).ensure('pm-1', directory, 'Project One', 'pm', { ...PM, model: 'deepseek-v4' })

    expect(model.selections).toBe(0)
    expect(model.resolveCalls).toEqual([])
    expect(live.get('pm-1')!.session.events).toEqual([])
    expect(created[0]).toMatchObject({ agentOptions: { model: 'deepseek-v4' } })
  })

  it('fails the ensure when the default route cannot be resolved', async () => {
    const { context, model } = harness({ defaultModel: { provider: 'opencode-go', model: 'missing' },
      modelFailure: 'provider "opencode-go" is not configured' })

    await expect(createNodeSessions(context).ensure('pm-1', directory, 'Project One', 'pm', PM))
      .rejects.toThrow('provider "opencode-go" is not configured')
    expect(model.selections).toBe(1)
  })

  it('fails before creating when the profile defines no preset registry', async () => {
    // A profile without `dsh-agent-preset-registry` cannot compose a role's tool boundary, so it must not create silently.
    const { context, created } = harness({ presets: false })

    await expect(createNodeSessions(context).ensure('pm-1', directory, 'Project One', 'pm', PM))
      .rejects.toThrow(/agentPresets service is not available/)
    expect(created).toEqual([])
  })
})

describe('NodeSessions.prompt', () => {
  it('delivers once per idempotency key under the plugin message id', async () => {
    const { context, live } = harness({ live: ['pm-1'] })
    const sessions = createNodeSessions(context)
    await sessions.ensure('pm-1', directory, 'Project One', 'pm', PM)
    await sessions.prompt('pm-1', 'message-1', 'Hello', 'queue')
    await sessions.prompt('pm-1', 'message-1', 'Hello', 'queue')

    const inbox = live.get('pm-1')!.inbox.nextTurn
    expect(inbox).toHaveLength(1)
    expect(String(inbox[0]!.id)).toBe('dsh-superagent:message-1')
  })

  it('reports a message once it reached the inbox, including a retry that finds it waiting', async () => {
    const { context, live } = harness({ live: ['pm-1'] })
    const sessions = createNodeSessions(context)
    await sessions.ensure('pm-1', directory, 'Project One', 'pm', PM)
    const delivered = vi.fn()

    await sessions.prompt('pm-1', 'message-1', 'Hello', 'queue', delivered)
    expect(delivered).toHaveBeenCalledOnce()
    expect(live.get('pm-1')!.inbox.nextTurn).toHaveLength(1)

    // The retry inserts nothing because the message still waits there, but the worker has it all the same.
    await sessions.prompt('pm-1', 'message-1', 'Hello', 'queue', delivered)
    expect(delivered).toHaveBeenCalledTimes(2)
    expect(live.get('pm-1')!.inbox.nextTurn).toHaveLength(1)
  })

  it('refuses a Session this node does not run', async () => {
    const { context } = harness()
    const delivered = vi.fn()
    await expect(createNodeSessions(context).prompt('pm-1', 'message-1', 'Hello', 'queue', delivered))
      .rejects.toThrow(/not loaded on this node/)
    expect(delivered).not.toHaveBeenCalled()
  })
})

describe('createDshPortHost over the node Sessions', () => {
  function hostOf(options: { live?: readonly string[] } = {}) {
    const state = harness(options)
    const host = createDshPortHost({ context: state.context,
      nodeRuntime: { sessions: createNodeSessions(state.context) }, nodeId: 'node-1', root })
    return { ...state, host }
  }

  it('applies the profile permission as the nearest preset this host offers', async () => {
    const { host, permissionSets, live } = hostOf({ live: ['pm-1'] })
    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm', profile: PM,
      prompt: PM.prompt, sessionToken: 'session-token' })

    // `read-only` is not offered; the chain takes the nearest available preset, as Sessions.ensure does for a PM.
    expect(permissionSets).toEqual([{ session: live.get('pm-1')!.session, preset: 'workspace-write' }])

    await host.ensureSession({ sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
      profile: WORKER, prompt: WORKER.prompt, sessionToken: 'session-token' })
    expect(permissionSets.at(-1)).toEqual({ session: live.get('worker-1')!.session, preset: 'workspace-write' })
  })

  it('fails an ensure whose permission tier this host cannot express', async () => {
    const { host } = hostOf({ live: ['pm-1'] })
    await expect(host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      profile: { ...PM, permission: 'root' }, prompt: PM.prompt, sessionToken: 'session-token' }))
      .rejects.toThrow(/no permission preset for "root"/)
  })

  it('installs the PM role once as instructions without starting a turn', async () => {
    const { host, live } = hostOf({ live: ['pm-1'] })
    const input = { sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm' as const, profile: PM,
      prompt: PM.prompt, sessionToken: 'session-token' }
    await host.ensureSession(input)
    await host.ensureSession(input)

    const agent = live.get('pm-1')!
    expect(agent.ctx.promptSections).toHaveLength(1)
    expect(agent.ctx.promptSections[0]!.text()).toBe(PM.prompt)
    expect(agent.inbox.nextTurn).toEqual([])
  })
})

describe('readNodeEnvironment', () => {
  const base = (): NodeJS.ProcessEnv => ({ SUPERAGENT_NODE_TOKEN: 'node-token', SUPERAGENT_NODE_PORT: '47101',
    SUPERAGENT_NODE_ROOT: root })

  it('reads the node identity and defaults the optional values', () => {
    expect(readNodeEnvironment(base())).toEqual({ token: 'node-token', port: 47101, host: '127.0.0.1',
      nodeId: 'local', root })
  })

  it('fails fast without a token, a port or a root', () => {
    expect(() => readNodeEnvironment({ ...base(), SUPERAGENT_NODE_TOKEN: '' })).toThrow('SUPERAGENT_NODE_TOKEN')
    expect(() => readNodeEnvironment({ ...base(), SUPERAGENT_NODE_PORT: undefined })).toThrow('SUPERAGENT_NODE_PORT')
    expect(() => readNodeEnvironment({ ...base(), SUPERAGENT_NODE_ROOT: '' })).toThrow('SUPERAGENT_NODE_ROOT')
  })

  it('refuses a port that is not a port and a root that is not absolute', () => {
    for (const port of ['abc', '-1', '70000', '47.5']) {
      expect(() => readNodeEnvironment({ ...base(), SUPERAGENT_NODE_PORT: port }), port).toThrow('invalid')
    }
    expect(() => readNodeEnvironment({ ...base(), SUPERAGENT_NODE_ROOT: 'relative/node' })).toThrow('absolute path')
  })

  it('refuses a control URL that is not http(s)', () => {
    expect(() => readNodeEnvironment({ ...base(), SUPERAGENT_CONTROL_URL: 'ftp://127.0.0.1:47100' })).toThrow('http')
    expect(readNodeEnvironment({ ...base(), SUPERAGENT_CONTROL_URL: 'http://127.0.0.1:47100' }).controlUrl)
      .toBe('http://127.0.0.1:47100')
  })
})

describe('plugin apply', () => {
  const keys = ['SUPERAGENT_NODE_TOKEN', 'SUPERAGENT_NODE_PORT', 'SUPERAGENT_NODE_HOST', 'SUPERAGENT_NODE_ID',
    'SUPERAGENT_NODE_ROOT', 'SUPERAGENT_CONTROL_URL'] as const
  let saved: Record<string, string | undefined> = {}
  let external: Server | undefined

  beforeEach(() => {
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
  })

  afterEach(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    if (external) await new Promise<void>(resolve => external!.close(() => resolve()))
    external = undefined
  })

  /** A context with only what `apply` touches before any command arrives. */
  function pluginContext() {
    const disposers: (() => unknown)[] = []
    const info: string[] = []
    const ctx = {
      on(_name: string, _listener: Listener): () => void { return () => {} },
      get(): undefined { return undefined },
      effect(factory: () => () => unknown): void { disposers.push(factory()) },
      logger: { info(message: string): void { info.push(message) }, warn(): void {} },
    }
    return { ctx: ctx as unknown as Context, info,
      async dispose(): Promise<void> { for (const dispose of disposers.splice(0)) await dispose() } }
  }

  it('fails the plugin when its environment is incomplete', async () => {
    const { ctx, info } = pluginContext()
    await expect(apply(ctx)).rejects.toThrow('SUPERAGENT_NODE_TOKEN')
    process.env.SUPERAGENT_NODE_TOKEN = 'node-token'
    process.env.SUPERAGENT_NODE_PORT = 'not-a-port'
    process.env.SUPERAGENT_NODE_ROOT = root
    await expect(apply(ctx)).rejects.toThrow('SUPERAGENT_NODE_PORT is invalid')
    expect(info).toEqual([])
  })

  it('listens, serves health, and closes with the plugin effect', async () => {
    process.env.SUPERAGENT_NODE_TOKEN = 'node-token'
    process.env.SUPERAGENT_NODE_PORT = '0'
    process.env.SUPERAGENT_NODE_ROOT = root
    const { ctx, info, dispose } = pluginContext()
    await apply(ctx)

    // The only startup line names the URL the node listens on.
    expect(info).toHaveLength(1)
    const url = info[0]!.replace('dsh-superagent node listening on ', '')
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await expect(fetch(`${url}/health`).then(async response => response.json()))
      .resolves.toEqual({ ok: true, service: 'superagent-node' })

    await dispose()
    await expect(fetch(`${url}/health`)).rejects.toThrow()
  })

  it('fails when another process already holds the port', async () => {
    external = createServer()
    const { port } = await listenFetchLoopback(external)
    process.env.SUPERAGENT_NODE_TOKEN = 'node-token'
    process.env.SUPERAGENT_NODE_PORT = String(port)
    process.env.SUPERAGENT_NODE_ROOT = root

    const { ctx, info } = pluginContext()
    await expect(apply(ctx)).rejects.toThrow(/EADDRINUSE/)
    expect(info).toEqual([])
  })
})
