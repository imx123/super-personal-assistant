/**
 * The node's own role and workspace guard.
 *
 * The guard is the second authoritative refusal point of the permission model: the control plane refuses a call its role
 * profile does not grant, and the node refuses a call its own tool surface does not grant. Both refusals are facts, and
 * both are reported to the control plane as a structured `guard.denial` event so the escalation can count them.
 *
 * The guard reads `deny` before the allow list and keeps the Session's own Git metadata out of reach. It does not judge
 * the file system as a whole: the backend's own sandbox owns the file access of the native file tools, and this node
 * reads the refusals that sandbox makes instead of guessing where a path leads. Nothing is ever decided from a command's
 * output, from a tool's error text or from a model's words.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PM_PROFILE, WORKER_PROFILE } from '../src/control/roles.ts'
import type { DshPortEvent, DshPortHost } from '../src/node/dsh-port.ts'
import { createDshPortHost, type DshPortFetch } from '../src/node/dsh-port-host.ts'

/** A `tools.guard` callback; a returned string refuses the call. */
type Guard = (execution: { name: string; arguments?: unknown; callId?: string }) => string | undefined

/**
 * The scoped tool registry of a fake Agent.
 *
 * `restrict` and `guard` record what the boundary did, and `register` accepts the `control_*` tools the host installs
 * into the Agent's own layer after the mask.
 */
class BoundaryRegistry {
  readonly guards: Guard[] = []
  readonly registered: string[] = []

  schemas(): { name: string }[] { return [] }
  restrict(): () => void { return () => {} }
  guard(guard: Guard): () => void {
    this.guards.push(guard)
    return () => {}
  }
  register(definition: { name: string }): () => void {
    this.registered.push(definition.name)
    return () => {}
  }

  /**
   * The first denial a guard gives for one call, as DSH would refuse it.
   *
   * The call carries the identity the backend gave it: a refusal is reported under the id of the very call it refused,
   * and a call without an id would not be a fact the control plane could tell apart from a replay of another one.
   */
  denial(name: string, args?: unknown, callId = 'call-1'): string | undefined {
    for (const guard of this.guards) {
      const reason = guard({ name, arguments: args, callId })
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

/** A DSH Agent stand-in with the scoped registry surface the host uses. */
class BoundaryAgent {
  readonly tools = new BoundaryRegistry()
  readonly ctx = { tools: this.tools }
  readonly session = { id: 'worker-1' }
}

/** A Cordis-like context that remembers the handlers the host registered. */
class FakeContext {
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  readonly agents = { get: () => undefined }
  readonly workspaceRegistry = { async archiveSession() {} }

  on(event: string, handler: (...args: unknown[]) => void): () => void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {
      const current = this.handlers.get(event) ?? []
      this.handlers.set(event, current.filter(entry => entry !== handler))
    }
  }

  /** Deliver one event to the handlers that wait for it. */
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }
}

type EnsureInput = Parameters<DshPortHost['ensureSession']>[0]

let directory = ''
let root = ''
let context: FakeContext

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-node-guard-'))
  root = join(directory, 'node')
  mkdirSync(root, { recursive: true })
  context = new FakeContext()
})

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

/** A host over a fake Agent, with the events it publishes collected. */
function harness(): { host: DshPortHost; agent: BoundaryAgent; events: DshPortEvent[] } {
  const agent = new BoundaryAgent()
  const sessions = {
    async ensure() { return agent },
    async prompt() {},
  }
  const fetch: DshPortFetch = async () => ({ ok: true, status: 200, text: async () => '{}' })
  const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: 'node-1', root,
    controlUrl: 'http://control.test', fetch })
  const events: DshPortEvent[] = []
  host.onEvent(event => { events.push(event) })
  return { host, agent, events }
}

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

/** The guard denials the host published. */
function denialsOf(events: DshPortEvent[]): { toolName: string; reasonCode: string; turnId?: string; callId?: string }[] {
  const facts: { toolName: string; reasonCode: string; turnId?: string; callId?: string }[] = []
  for (const event of events) {
    if (event.type !== 'session.event' || event.kind !== 'guard.denial') continue
    const data = (event as unknown as {
      data?: { toolName?: string; reasonCode?: string; turnId?: string; callId?: string }
    }).data
    if (data === undefined) continue
    facts.push({
      toolName: String(data.toolName ?? ''),
      reasonCode: String(data.reasonCode ?? ''),
      ...(data.turnId === undefined ? {} : { turnId: data.turnId }),
      ...(data.callId === undefined ? {} : { callId: data.callId }),
    })
  }
  return facts
}

/** The one Session event the backend reports, as the host reads it. */
function sessionEvent(type: string, data: unknown): void {
  context.fire('session/event', { id: 'worker-1' }, { type, data })
}

describe('the node role and workspace guard', () => {
  it('refuses a tool the role profile does not grant and reports the refusal', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(pmInput())
    const reason = agent.tools.denial('write')

    expect(reason).toMatch(/denies the tool write/)
    expect(denialsOf(events)).toEqual([{ toolName: 'write', reasonCode: 'ROLE_TOOL_DENIED', callId: 'call-1' }])
  })

  it('refuses a tool the role profile denies even when the allow list would let it through', async () => {
    // A profile that names a tool in both lists is a profile whose deny list wins: the explicit refusal is the stronger
    // statement, and the guard has to read it first.
    const profile = { ...WORKER_PROFILE, tools: [...WORKER_PROFILE.tools, 'orchestrator_project_report'] }
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput({ profile }))
    const reason = agent.tools.denial('orchestrator_project_report')

    expect(reason).toMatch(/denies the tool orchestrator_project_report/)
    expect(denialsOf(events)).toEqual([{ toolName: 'orchestrator_project_report', reasonCode: 'ROLE_TOOL_DENIED',
      callId: 'call-1' }])
  })

  it('lets a tool the profile grants through and reports nothing', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput())

    expect(agent.tools.denial('read')).toBeUndefined()
    expect(denialsOf(events)).toEqual([])
  })

  it('refuses a call that changes the Git metadata of the workspace', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput())
    const reason = agent.tools.denial('write', { path: '.git/config' })

    expect(reason).toMatch(/Git metadata/)
    expect(denialsOf(events)).toEqual([{ toolName: 'write', reasonCode: 'WORKSPACE_OUT_OF_BOUNDS', callId: 'call-1' }])
  })

  it('lets a read of the workspace alone through', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput())

    // A read is the Session's business, and the Git metadata of a repository is readable like any other file.
    expect(agent.tools.denial('read', { path: '.git/config' })).toBeUndefined()
    expect(agent.tools.denial('read', { path: 'src/index.ts' })).toBeUndefined()
    expect(denialsOf(events)).toEqual([])
  })

  it('does not judge the file system itself', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput())

    // The backend's own sandbox owns the file access: a path outside the workspace is the backend's business, and a
    // lexical rule about it here would over-block ordinary reads and still miss the relative and symbolic cases.
    expect(agent.tools.denial('write', { path: join(directory, 'elsewhere', 'secret.txt') })).toBeUndefined()
    expect(agent.tools.denial('write', { path: '/etc/passwd' })).toBeUndefined()
    expect(denialsOf(events)).toEqual([])
  })

  it('does not pretend to sandbox the shell', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput())

    // The shell is not one of the backend's file tools, and this node does not claim to keep it inside the workspace.
    expect(agent.tools.denial('bash', { command: 'cat .git/config' })).toBeUndefined()
    expect(denialsOf(events)).toEqual([])
  })

  it('names the turn the refused call was made in', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput())
    sessionEvent('turn/start', { turn: 3 })
    // A tool the Worker profile denies: the guard refuses it, so the refusal is a fact about the role.
    agent.tools.denial('orchestrator_project_report')

    expect(denialsOf(events)).toEqual([{ toolName: 'orchestrator_project_report', reasonCode: 'ROLE_TOOL_DENIED',
      turnId: '3', callId: 'call-1' }])
  })
})

describe('the guard of the delegation that the Mandate narrowed', () => {
  /** A Worker whose Mandate holds only the read tools and its own report. */
  const narrowed = { ...WORKER_PROFILE, mandateTools: ['read', 'grep', 'control_report'] }

  it('refuses a tool the Mandate took away and reports it as a Mandate that was exceeded', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput({ profile: narrowed }))
    const reason = agent.tools.denial('bash')

    // The Mandate took the shell away: that is a delegation that was exceeded, not a role that may not use the tool.
    expect(reason).toMatch(/does not include the tool bash/)
    expect(denialsOf(events)).toEqual([{ toolName: 'bash', reasonCode: 'MANDATE_EXCEEDED', callId: 'call-1' }])
  })

  it('lets the tools the Mandate holds through and reports nothing', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput({ profile: narrowed }))

    expect(agent.tools.denial('read')).toBeUndefined()
    expect(agent.tools.denial('grep')).toBeUndefined()
    // The Session's own report tool is not governed by the Mandate: it stays available.
    expect(agent.tools.denial('control_report')).toBeUndefined()
    expect(denialsOf(events)).toEqual([])
  })

  it('still refuses a tool the role does not grant as a role refusal', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput({ profile: narrowed }))
    const reason = agent.tools.denial('orchestrator_project_report')

    expect(reason).toMatch(/denies the tool orchestrator_project_report/)
    expect(denialsOf(events)).toEqual([{ toolName: 'orchestrator_project_report', reasonCode: 'ROLE_TOOL_DENIED',
      callId: 'call-1' }])
  })

  it('judges no Mandate at all when the profile carries none', async () => {
    const { host, agent, events } = harness()

    await host.ensureSession(workerInput())

    // A Worker whose Mandate names no list keeps the role's whole tool set.
    expect(agent.tools.denial('bash')).toBeUndefined()
    expect(denialsOf(events)).toEqual([])
  })
})

describe('the refusal the backend own file sandbox made', () => {
  it('reports it under the identity of the very call it refused', async () => {
    const { host, events } = harness()

    await host.ensureSession(workerInput())
    sessionEvent('turn/start', { turn: 3 })
    sessionEvent('tool/call', { name: 'write', callId: 'call-9', turn: 3 })
    sessionEvent('tool/result', { message: { isError: true, toolCallId: 'call-9' },
      error: { code: 'FS_SANDBOX_DENIED' } })

    expect(denialsOf(events)).toEqual([{ toolName: 'write', reasonCode: 'WORKSPACE_OUT_OF_BOUNDS', turnId: '3',
      callId: 'call-9' }])
  })

  it('ignores a result that carries no structured error', async () => {
    const { host, events } = harness()

    await host.ensureSession(workerInput())
    sessionEvent('turn/start', { turn: 3 })
    sessionEvent('tool/call', { name: 'write', callId: 'call-9', turn: 3 })
    // A malformed escalation: the tool failed, but it failed in its own way and the backend put no code into the result.
    sessionEvent('tool/result', { message: { isError: true, toolCallId: 'call-9' },
      error: 'invalid escalation: justification is only valid together with sandbox_permissions' })

    expect(denialsOf(events)).toEqual([])
  })

  it('ignores an unknown code and a tool the sandbox does not guard', async () => {
    const { host, events } = harness()

    await host.ensureSession(workerInput())
    sessionEvent('turn/start', { turn: 3 })
    sessionEvent('tool/call', { name: 'write', callId: 'call-9', turn: 3 })
    sessionEvent('tool/result', { message: { isError: true, toolCallId: 'call-9' }, error: { code: 'SOMETHING_ELSE' } })
    // A shell call is not one of the backend's file tools: a refusal of it is not a fact about the workspace.
    sessionEvent('tool/call', { name: 'bash', callId: 'call-10', turn: 3 })
    sessionEvent('tool/result', { message: { isError: true, toolCallId: 'call-10' },
      error: { code: 'FS_SANDBOX_DENIED' } })

    expect(denialsOf(events)).toEqual([])
  })

  it('ignores a refusal of another turn and a result without its call', async () => {
    const { host, events } = harness()

    await host.ensureSession(workerInput())
    sessionEvent('turn/start', { turn: 3 })
    // A call of a turn that is over: the refusal is a late fact about work that has already moved on.
    sessionEvent('tool/call', { name: 'write', callId: 'call-9', turn: 7 })
    sessionEvent('tool/result', { message: { isError: true, toolCallId: 'call-9' },
      error: { code: 'FS_SANDBOX_DENIED' } })
    // A result whose call the node never saw.
    sessionEvent('tool/result', { message: { isError: true, toolCallId: 'call-unknown' },
      error: { code: 'FS_SANDBOX_DENIED' } })

    expect(denialsOf(events)).toEqual([])
  })

  it('never turns a tool error into a fact about the boundary', async () => {
    const { host, events } = harness()

    await host.ensureSession(workerInput())
    sessionEvent('turn/start', { turn: 3 })
    // A call that failed for its own reasons: the result is an error, but it is not the sandbox's refusal.
    sessionEvent('tool/call', { name: 'write', callId: 'call-9', turn: 3 })
    sessionEvent('tool/result', { message: { isError: true, toolCallId: 'call-9' } })

    expect(denialsOf(events)).toEqual([])
  })
})
