/**
 * The node-side role tool boundary: a node-only profile leaves DSH's whole tool surface inherited by every Agent, so the
 * host must narrow it from `RoleProfile.tools` before the Session's first turn. These tests drive `createDshPortHost`
 * with a fake Agent whose scoped registry records the mask, the guard and the `control_*` registrations.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PM_PROFILE, WORKER_PROFILE } from '../src/control/roles.ts'
import type { DshPortHost } from '../src/node/dsh-port.ts'
import { createDshPortHost, type DshPortFetch } from '../src/node/dsh-port-host.ts'

/** The inherited tool names a fake Agent's parent view exposes. */
type Inherited = readonly string[]
/** One `tools.restrict` filter the boundary applied. */
interface Restriction {
  allow?: string[]
  deny?: string[]
}
/** A `tools.guard` callback; a returned string refuses the call. */
type Guard = (execution: { name: string }) => string | undefined

/**
 * The scoped tool registry of a fake Agent.
 *
 * `schemas` answers with the inherited names and ignores its scope argument (the production code reads the parent view);
 * `restrict` and `guard` record what the boundary did, and `register` accepts the `control_*` tools the host installs
 * into the Agent's own layer after the mask.
 */
class BoundaryRegistry {
  readonly log: string[] = []
  readonly restrictions: Restriction[] = []
  readonly guards: Guard[] = []
  readonly registered: string[] = []
  constructor(private readonly inherited: Inherited) {}
  schemas(_scope?: object): { name: string }[] {
    this.log.push('schemas')
    return this.inherited.map(name => ({ name }))
  }
  restrict(filter: Restriction): () => void {
    this.log.push('restrict')
    this.restrictions.push(filter)
    return () => {}
  }
  guard(guard: Guard): () => void {
    this.log.push('guard')
    this.guards.push(guard)
    return () => {}
  }
  register(definition: { name: string }): () => void {
    this.log.push(`register:${definition.name}`)
    this.registered.push(definition.name)
    return () => {}
  }
  /** The first denial a guard gives for `name`, as DSH would refuse the call. */
  denial(name: string): string | undefined {
    for (const guard of this.guards) {
      const reason = guard({ name })
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

/** A DSH Agent stand-in with the scoped registry surface the host uses. */
class BoundaryAgent {
  readonly tools: BoundaryRegistry
  readonly ctx: { tools: BoundaryRegistry }
  readonly session: { id: string }
  constructor(readonly id: string, inherited: Inherited) {
    this.tools = new BoundaryRegistry(inherited)
    this.ctx = { tools: this.tools }
    this.session = { id }
  }
}

type EnsureInput = Parameters<DshPortHost['ensureSession']>[0]

let directory = ''
let root = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-node-boundary-'))
  root = join(directory, 'node')
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

/** An ensure command for the PM, with the profile's real tool list. */
function pmInput(overrides: Partial<EnsureInput> = {}): EnsureInput {
  return { sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm', profile: PM_PROFILE,
    prompt: PM_PROFILE.prompt, sessionToken: 'pm-token', ...overrides }
}

/** An ensure command for a Worker, with the profile's real tool list. */
function workerInput(overrides: Partial<EnsureInput> = {}): EnsureInput {
  return { sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
    profile: WORKER_PROFILE, prompt: WORKER_PROFILE.prompt, sessionToken: 'worker-token', ticketId: 'ticket-1',
    assignmentId: 'assignment-1', ...overrides }
}

/** A host over fake Sessions; `queued` supplies the Agent a later ensure returns (as a resume would). */
function harness(inherited: Inherited, options: { controlUrl?: string } = {}) {
  const byId = new Map<string, BoundaryAgent>()
  const agents: BoundaryAgent[] = []
  const queued: BoundaryAgent[] = []
  const prompts: { sessionId: string; key: string; text: string }[] = []
  const sessions = {
    async ensure(sessionId: string) {
      const agent = queued.shift() ?? byId.get(sessionId) ?? new BoundaryAgent(sessionId, inherited)
      byId.set(sessionId, agent)
      if (!agents.includes(agent)) agents.push(agent)
      return agent
    },
    async prompt(sessionId: string, key: string, text: string) { prompts.push({ sessionId, key, text }) },
  }
  const context = { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } }
  const fetch: DshPortFetch = async () => ({ ok: true, status: 200, text: async () => '{}' })
  const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: 'node-1', root,
    ...(options.controlUrl === undefined ? {} : { controlUrl: options.controlUrl }), fetch })
  return { host, agents, queued, prompts }
}

describe('node role tool boundary', () => {
  it('hides every inherited tool from a PM and guards calls outside its profile', async () => {
    const inherited = ['write', 'edit', 'bash', 'pwsh', 'web_search', 'read', 'run_code', 'subagent']
    const { host, agents } = harness(inherited, { controlUrl: 'http://control.test' })

    await host.ensureSession(pmInput())

    const registry = agents[0]!.tools
    // `run_code` is the reserved PTC transport and may not appear in a restriction at all.
    expect(registry.restrictions).toEqual([{ deny: ['write', 'edit', 'bash', 'pwsh', 'web_search', 'read', 'subagent'] }])
    // A PM inherits nothing it may use; the guard is what also refuses a scope-local name such as subagent.
    expect(registry.denial('write')).toMatch(/A Project PM may use only/)
    expect(registry.denial('subagent')).toMatch(/A Project PM may use only/)
    expect(registry.denial('control_project')).toBeUndefined()
    expect(registry.denial('control_create_tickets')).toBeUndefined()
    expect(registry.denial('control_message_worker')).toBeUndefined()
    expect(registry.denial('control_cancel_worker')).toBeUndefined()
    expect(registry.denial('control_request_assignment')).toBeUndefined()
    expect(registry.denial('control_review_result')).toBeUndefined()
    expect(registry.denial('control_review_diff')).toBeUndefined()
    // The proxy tools land in the Agent's own layer after the mask, so the mask cannot hide them.
    expect(registry.registered).toEqual(['control_project', 'control_create_tickets', 'control_message_worker',
      'control_cancel_worker', 'control_request_assignment', 'control_review_result', 'control_review_diff',
      'control_project_report', 'control_request_authorization', 'control_subscribe_session_stream',
      'control_unsubscribe_session_stream', 'control_create_external_subscription',
      'control_list_external_subscriptions', 'control_update_external_subscription',
      'control_delete_external_subscription', 'control_live_state', 'control_event_history_query'])
    expect(registry.log).toEqual(['schemas', 'restrict', 'guard', 'register:control_project',
      'register:control_create_tickets', 'register:control_message_worker', 'register:control_cancel_worker',
      'register:control_request_assignment', 'register:control_review_result', 'register:control_review_diff',
      'register:control_project_report', 'register:control_request_authorization',
      'register:control_subscribe_session_stream', 'register:control_unsubscribe_session_stream',
      'register:control_create_external_subscription', 'register:control_list_external_subscriptions',
      'register:control_update_external_subscription', 'register:control_delete_external_subscription',
      'register:control_live_state', 'register:control_event_history_query'])
  })

  it('keeps only the worker profile\'s inherited tools and guards the rest', async () => {
    const inherited = ['read', 'bash', 'write', 'web_search', 'orchestrator_project_report', 'run_code']
    const { host, agents } = harness(inherited, { controlUrl: 'http://control.test' })

    await host.ensureSession(workerInput())

    const registry = agents[0]!.tools
    expect(registry.restrictions).toEqual([{ allow: ['read', 'bash', 'write', 'web_search'] }])
    expect(registry.denial('orchestrator_project_report')).toMatch(/A Worker may use only/)
    expect(registry.denial('read')).toBeUndefined()
    // `control_report` is registered into the own layer, not inherited, and the profile grants it.
    expect(registry.denial('control_report')).toBeUndefined()
    expect(registry.registered).toEqual(['control_report', 'control_create_external_subscription',
      'control_list_external_subscriptions', 'control_update_external_subscription',
      'control_delete_external_subscription', 'control_live_state', 'control_event_history_query'])
  })

  it('applies the boundary once per Agent across repeated ensures', async () => {
    const { host, agents } = harness(['write', 'web_search'], { controlUrl: 'http://control.test' })

    await host.ensureSession(pmInput())
    await host.ensureSession(pmInput())

    const registry = agents[0]!.tools
    expect(agents).toHaveLength(1)
    expect(registry.restrictions).toHaveLength(1)
    expect(registry.guards).toHaveLength(1)
    expect(registry.log.filter(entry => entry === 'restrict' || entry === 'guard')).toEqual(['restrict', 'guard'])
    expect(registry.registered).toEqual(['control_project', 'control_create_tickets', 'control_message_worker',
      'control_cancel_worker', 'control_request_assignment', 'control_review_result', 'control_review_diff',
      'control_project_report', 'control_request_authorization', 'control_subscribe_session_stream',
      'control_unsubscribe_session_stream', 'control_create_external_subscription',
      'control_list_external_subscriptions', 'control_update_external_subscription',
      'control_delete_external_subscription', 'control_live_state', 'control_event_history_query'])
  })

  it('applies the boundary again to a resumed Agent', async () => {
    const inherited = ['write', 'web_search']
    const { host, agents, queued } = harness(inherited)

    await host.ensureSession(pmInput())
    const resumed = new BoundaryAgent('pm-1', inherited)
    queued.push(resumed)
    await host.ensureSession(pmInput())

    expect(agents[0]!.tools.restrictions).toHaveLength(1)
    expect(resumed.tools.restrictions).toEqual([{ deny: ['write', 'web_search'] }])
    expect(resumed.tools.guards).toHaveLength(1)
  })

  it('skips an empty restriction but still guards the role', async () => {
    const { host, agents, prompts } = harness([])

    await host.ensureSession(pmInput())

    const registry = agents[0]!.tools
    // DSH refuses `restrict({})`, so nothing is inherited and only the guard is installed.
    expect(registry.restrictions).toEqual([])
    expect(registry.guards).toHaveLength(1)
    expect(registry.denial('write')).toMatch(/A Project PM may use only/)
    expect(prompts.map(prompt => prompt.text)).toEqual([PM_PROFILE.prompt])
  })

  it('leaves an Agent without a tool registry alone', async () => {
    const sessions = { async ensure(sessionId: string) { return { id: sessionId } }, async prompt() {} }
    const context = { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } }
    const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: 'node-1', root })

    await expect(host.ensureSession(pmInput())).resolves.toBeUndefined()
  })
})
