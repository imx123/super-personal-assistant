/**
 * Cross-layer command results: a refusal the backend raised must reach its caller, and a fact the node performed itself
 * (an archive, an inspection) must be reported instead of being silently acknowledged.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDshPortHost } from '../src/node/dsh-port-host.ts'
import { DshNodePort, type DshPortEvent, type DshPortHost } from '../src/node/dsh-port.ts'
import { startNodeHttpServer } from '../src/node/http-server.ts'
import {
  NODE_PROTOCOL_VERSION,
  type NodeCommand,
  type NodeEvent,
  type NodeStatus,
  type RoleProfile,
  type SessionInspection,
} from '../src/shared/protocol.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'node-1'
const NODE_TOKEN = 'node-token'

const PM_PROFILE: RoleProfile = { name: 'pm.v1', prompt: 'Manage the Project.', tools: [], deny: [],
  permission: 'read-only' }

/** A `DshPortHost` a test drives directly: every call is recorded, and a knobs object makes the backend refuse. */
class FakeHost implements DshPortHost {
  readonly ensured: Parameters<DshPortHost['ensureSession']>[0][] = []
  readonly prompts: { sessionId: string; key: string; text: string }[] = []
  readonly archived: string[] = []
  readonly listeners = new Set<(event: DshPortEvent) => void>()
  /** The backend's answers for `session.inspect`; the default is an unknown Session. */
  inspector: (sessionId: string) => SessionInspection = sessionId => ({ sessionId, found: false })
  promptFailure?: Error
  ensureFailure?: Error
  archiveFailure?: Error

  async ensureSession(input: Parameters<DshPortHost['ensureSession']>[0]): Promise<void> {
    this.ensured.push(input)
    if (this.ensureFailure) throw this.ensureFailure
  }

  async promptSession(sessionId: string, idempotencyKey: string, text: string): Promise<void> {
    this.prompts.push({ sessionId, key: idempotencyKey, text })
    if (this.promptFailure) throw this.promptFailure
  }

  cancelSession(): void {}

  async archiveSession(sessionId: string): Promise<void> {
    if (this.archiveFailure) throw this.archiveFailure
    this.archived.push(sessionId)
  }

  inspectSession(sessionId: string): Promise<SessionInspection> {
    return Promise.resolve(this.inspector(sessionId))
  }

  setPermission(): void {}

  onEvent(listener: (event: DshPortEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  nodeStatus(): NodeStatus {
    return { nodeId: NODE_ID, backend: 'dsh', version: '0.1.0', online: true, at: NOW }
  }

  emit(event: DshPortEvent): void { for (const listener of [...this.listeners]) listener(event) }
}

let directory = ''
let root = ''
let host: FakeHost
let port: DshNodePort

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-node-command-results-'))
  root = join(directory, 'node')
  host = new FakeHost()
  port = new DshNodePort({ host, nodeId: NODE_ID, root, now: () => NOW })
})

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

function envelope(idempotencyKey: string) {
  return { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID, idempotencyKey, at: NOW } as const
}

function message(idempotencyKey: string, text = 'Hello'): NodeCommand {
  return { ...envelope(idempotencyKey), type: 'session.message', sessionId: 'pm-1', text }
}

function archive(idempotencyKey: string): NodeCommand {
  return { ...envelope(idempotencyKey), type: 'session.archive', sessionId: 'pm-1' }
}

function inspect(idempotencyKey: string): NodeCommand {
  return { ...envelope(idempotencyKey), type: 'session.inspect', sessionId: 'pm-1' }
}

function pmEnsure(idempotencyKey = 'pm-1'): NodeCommand {
  return { ...envelope(idempotencyKey), type: 'pm.ensure', sessionId: 'pm-1',
    project: { id: 'project-1', title: 'Project', goal: 'Ship it' }, workspace: join(root, 'project-1'),
    profile: PM_PROFILE, sessionToken: 'session-token', prompt: PM_PROFILE.prompt }
}

describe('DshNodePort command results', () => {
  it('delivers a normal message and records its key only after the host accepted it', async () => {
    await expect(port.send(message('message-1'))).resolves.toBeUndefined()
    expect(host.prompts).toEqual([{ sessionId: 'pm-1', key: 'message-1', text: 'Hello' }])

    // A repeated key is acknowledged from the port's record, not by prompting the host twice.
    await expect(port.send(message('message-1'))).resolves.toBeUndefined()
    expect(host.prompts).toHaveLength(1)
  })

  it('rejects a message the host could not deliver, keeping the key retryable', async () => {
    host.promptFailure = new Error('the inbox is closed')
    await expect(port.send(message('message-2'))).rejects.toThrow('the inbox is closed')

    host.promptFailure = undefined
    await expect(port.send(message('message-2'))).resolves.toBeUndefined()
    expect(host.prompts.map(prompt => prompt.key)).toEqual(['message-2', 'message-2'])
  })

  it('rejects the command when the role prompt could not be installed while ensuring', async () => {
    host.ensureFailure = new Error('the role prompt was rejected')
    await expect(port.send(pmEnsure())).rejects.toThrow('the role prompt was rejected')
    expect(host.ensured).toHaveLength(1)
  })

  it('reports the archive fact only after the host archived the Session', async () => {
    await port.send(pmEnsure())
    const events: NodeEvent[] = []
    port.subscribe(event => events.push(event))

    await expect(port.send(archive('archive-1'))).resolves.toBeUndefined()

    expect(host.archived).toEqual(['pm-1'])
    expect(events).toEqual([expect.objectContaining({ type: 'session.status', sessionId: 'pm-1', status: 'archived',
      projectId: 'project-1', role: 'pm', nodeId: NODE_ID, seq: 1, at: NOW })])
  })

  it('rejects an archive the host refused and reports no archived status', async () => {
    host.archiveFailure = new Error('the archive store is unavailable')
    const events: NodeEvent[] = []
    port.subscribe(event => events.push(event))

    await expect(port.send(archive('archive-2'))).rejects.toThrow('the archive store is unavailable')
    expect(events).toEqual([])
  })

  it('refuses an unknown command type before it reaches the host', async () => {
    const unknown = { ...envelope('unknown-1'), type: 'session.reboot', sessionId: 'pm-1' } as unknown as NodeCommand
    await expect(port.send(unknown)).rejects.toThrow(/Unknown command type: session\.reboot/)
    expect(host.prompts).toEqual([])
  })

  it('refuses a known command with a field the protocol does not allow', async () => {
    const missingText = { ...envelope('invalid-1'), type: 'session.message', sessionId: 'pm-1' } as unknown as NodeCommand
    await expect(port.send(missingText)).rejects.toThrow(/session\.message\.text must be a string/)
    expect(host.prompts).toEqual([])
  })

  it('reports the host inspection under the requesting idempotency key', async () => {
    await port.send(pmEnsure())
    host.inspector = sessionId => sessionId === 'pm-1'
      ? { sessionId, found: true, status: 'archived', ready: true }
      : { sessionId, found: false }
    const events: NodeEvent[] = []
    port.subscribe(event => events.push(event))

    await port.send(inspect('inspect-1'))

    expect(events).toEqual([expect.objectContaining({ type: 'session.inspected', sessionId: 'pm-1',
      requestId: 'inspect-1', projectId: 'project-1', role: 'pm',
      inspection: { sessionId: 'pm-1', found: true, status: 'archived', ready: true } })])
    await expect(port.inspect('missing')).resolves.toEqual({ sessionId: 'missing', found: false })
  })
})

describe('DshNodePort command results over HTTP', () => {
  let server: Awaited<ReturnType<typeof startNodeHttpServer>>

  beforeEach(async () => {
    server = await startNodeHttpServer({ node: port, token: NODE_TOKEN, port: 0 })
  })

  afterEach(async () => {
    await server.close()
  })

  async function post(command: unknown): Promise<Response> {
    return fetch(`${server.url}/commands`, { method: 'POST',
      headers: { authorization: `Bearer ${NODE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(command) })
  }

  it('acknowledges a normal message with 200', async () => {
    const response = await post(message('http-message-1'))
    expect(response.status).toBe(200)
    expect(host.prompts).toHaveLength(1)
  })

  it('answers a refused delivery with 5xx instead of the old silent 200', async () => {
    host.promptFailure = new Error('the inbox is closed')
    const response = await post(message('http-message-2'))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'execution-failed', error: 'the inbox is closed' })
  })

  it('answers a role prompt failure while ensuring with 5xx', async () => {
    host.ensureFailure = new Error('the role prompt was rejected')
    const response = await post(pmEnsure('http-pm-1'))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'execution-failed' })
  })

  it('answers an unknown command type with 400', async () => {
    const response = await post({ ...envelope('http-unknown-1'), type: 'session.reboot', sessionId: 'pm-1' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'unknown-command' })
  })

  it('answers a command with invalid fields with 422', async () => {
    const response = await post({ ...envelope('http-invalid-1'), type: 'session.message', sessionId: 'pm-1' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: 'invalid-command' })
  })

  it('answers a command from another protocol version with 400', async () => {
    const response = await post({ ...message('http-version-1'), protocolVersion: 99 })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'unsupported-protocol-version' })
  })

  it('acknowledges an archive only after the host archived the Session', async () => {
    await port.send(pmEnsure('http-pm-2'))
    const response = await post(archive('http-archive-1'))
    expect(response.status).toBe(200)
    expect(host.archived).toEqual(['pm-1'])
  })
})

describe('createDshPortHost results', () => {
  interface Fixture {
    host: DshPortHost
    ensured: { sessionId: string; directory: string; title: string; role: string }[]
    prompts: { sessionId: string; key: string; text: string }[]
    archived: string[]
    agents: Map<string, { id: string; status: 'idle' | 'running' }>
  }

  function fixture(options: { promptFailure?: Error; archiveFailure?: Error } = {}): Fixture {
    const ensured: Fixture['ensured'] = []
    const prompts: Fixture['prompts'] = []
    const archived: string[] = []
    const agents: Fixture['agents'] = new Map()
    const workspaceRegistry = {
      get archivedSessionIds(): readonly string[] { return archived },
      async archiveSession(sessionId: string): Promise<void> {
        if (options.archiveFailure) throw options.archiveFailure
        archived.push(sessionId)
      },
    }
    const sessions = {
      async ensure(sessionId: string, directory: string, title: string, role: string) {
        ensured.push({ sessionId, directory, title, role })
        // An agent exists and reports idle before the role prompt is attempted, as DSH does.
        const agent = { id: sessionId, status: 'idle' as const }
        agents.set(sessionId, agent)
        return agent
      },
      async prompt(sessionId: string, key: string, text: string) {
        prompts.push({ sessionId, key, text })
        if (options.promptFailure) throw options.promptFailure
      },
    }
    const context = { agents: { get: (id: string) => agents.get(String(id)) }, workspaceRegistry }
    const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: NODE_ID, root })
    return { host, ensured, prompts, archived, agents }
  }

  it('forwards a delivery failure instead of catching it in the background', async () => {
    const failure = new Error('the inbox is closed')
    const { host, prompts } = fixture({ promptFailure: failure })

    await expect(host.promptSession('pm-1', 'message-1', 'Hello')).rejects.toThrow('the inbox is closed')
    expect(prompts).toEqual([{ sessionId: 'pm-1', key: 'message-1', text: 'Hello' }])
  })

  it('rejects an ensure whose role prompt failed and keeps the Session not ready for inspection', async () => {
    const { host, ensured } = fixture({ promptFailure: new Error('the role prompt was rejected') })

    await expect(host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      prompt: PM_PROFILE.prompt, sessionToken: 'session-token' })).rejects.toThrow('the role prompt was rejected')
    expect(ensured).toHaveLength(1)

    // The agent reported idle before the prompt failed; inspection is what stops the control plane from trusting that.
    await expect(host.inspectSession('pm-1')).resolves.toEqual({ sessionId: 'pm-1', found: true, status: 'idle',
      backendSessionId: 'pm-1', ready: false, error: 'the role prompt was rejected' })
  })

  it('reports a prepared Session as ready and an unknown one as not found', async () => {
    const { host } = fixture()

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      prompt: PM_PROFILE.prompt, sessionToken: 'session-token' })
    await expect(host.inspectSession('pm-1')).resolves.toEqual({ sessionId: 'pm-1', found: true, status: 'idle',
      backendSessionId: 'pm-1', ready: true })
    await expect(host.inspectSession('missing')).resolves.toEqual({ sessionId: 'missing', found: false })
  })

  it('inspects a Session whose registry offers no archive set', async () => {
    // A minimal host (and the real registry behind a narrow fixture) may expose only `archiveSession`.
    const sessions = {
      async ensure(sessionId: string) { return { id: sessionId } },
      async prompt() {},
    }
    const context = { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } }
    const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: NODE_ID, root })

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      prompt: PM_PROFILE.prompt, sessionToken: 'session-token' })
    await expect(host.inspectSession('pm-1')).resolves.toEqual({ sessionId: 'pm-1', found: true, ready: true })
    await expect(host.archiveSession('pm-1')).resolves.toBeUndefined()
    // Without the archive set the node cannot claim an archived status, but inspection must not throw.
    await expect(host.inspectSession('pm-1')).resolves.toEqual({ sessionId: 'pm-1', found: true, ready: true })
  })

  it('archives through the registry and reports the archived status', async () => {
    const { host, archived } = fixture()

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      prompt: PM_PROFILE.prompt, sessionToken: 'session-token' })
    await expect(host.archiveSession('pm-1')).resolves.toBeUndefined()
    expect(archived).toEqual(['pm-1'])
    await expect(host.inspectSession('pm-1')).resolves.toMatchObject({ found: true, status: 'archived', ready: true })
  })

  it('rejects an archive the registry refused', async () => {
    const { host, archived } = fixture({ archiveFailure: new Error('the archive store is unavailable') })

    await expect(host.archiveSession('pm-1')).rejects.toThrow('the archive store is unavailable')
    expect(archived).toEqual([])
  })
})
