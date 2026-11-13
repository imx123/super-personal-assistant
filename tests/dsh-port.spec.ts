/** Phase 1B-3d: the real DSH node adapter, driven by a fake host and served behind the node HTTP transport. */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpNodePort } from '../src/control/http-node.ts'
import { DshNodePort, type DshPortEvent, type DshPortHost } from '../src/node/dsh-port.ts'
import { startNodeHttpServer } from '../src/node/http-server.ts'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeEvent, type NodeStatus, type RoleProfile, type SessionInspection }
  from '../src/shared/protocol.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'node-1'

const PM_PROFILE: RoleProfile = { name: 'pm.v1', prompt: 'Manage the Project.', tools: [], deny: [], permission: 'read-only' }
const WORKER_PROFILE: RoleProfile = { name: 'worker.v1', prompt: 'Do the work.', tools: ['read'], deny: [],
  permission: 'workspace-write' }

/** A `DshPortHost` that records every call and replays what a test emits; no DSH Context is involved. */
class FakeHost implements DshPortHost {
  readonly ensured: Parameters<DshPortHost['ensureSession']>[0][] = []
  readonly prompts: { sessionId: string; key: string; text: string }[] = []
  readonly cancelled: string[] = []
  readonly archived: string[] = []
  readonly permissions: { sessionId: string; permission: string }[] = []
  readonly listeners = new Set<(event: DshPortEvent) => void>()
  /** How many host subscriptions the port holds, proving one serves every listener. */
  subscriptions = 0

  async ensureSession(input: Parameters<DshPortHost['ensureSession']>[0]): Promise<void> { this.ensured.push(input) }
  async promptSession(sessionId: string, idempotencyKey: string, text: string): Promise<void> {
    this.prompts.push({ sessionId, key: idempotencyKey, text })
  }
  cancelSession(sessionId: string): void { this.cancelled.push(sessionId) }
  async archiveSession(sessionId: string): Promise<void> { this.archived.push(sessionId) }
  async inspectSession(sessionId: string): Promise<SessionInspection> {
    return { sessionId, found: false }
  }
  setPermission(sessionId: string, permission: string): void { this.permissions.push({ sessionId, permission }) }
  onEvent(listener: (event: DshPortEvent) => void): () => void {
    this.listeners.add(listener)
    this.subscriptions++
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
  directory = mkdtempSync(join(tmpdir(), 'superagent-dsh-port-'))
  root = join(directory, 'node')
  mkdirSync(root, { recursive: true })
  host = new FakeHost()
  port = new DshNodePort({ host, nodeId: NODE_ID, root, now: () => NOW })
})

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

function envelope(idempotencyKey: string): { protocolVersion: typeof NODE_PROTOCOL_VERSION; nodeId: string
  idempotencyKey: string; at: string } {
  return { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID, idempotencyKey, at: NOW }
}

function register(idempotencyKey = 'register-1'): NodeCommand {
  return { ...envelope(idempotencyKey), type: 'node.register',
    registration: { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID, backend: 'dsh', version: '0.1.0' } }
}

function heartbeat(idempotencyKey = 'heartbeat-1', online = true): NodeCommand {
  return { ...envelope(idempotencyKey), type: 'node.heartbeat',
    status: { nodeId: NODE_ID, backend: 'dsh', version: '0.1.0', online, at: NOW } }
}

function pmEnsure(idempotencyKey = 'pm-1'): NodeCommand {
  return { ...envelope(idempotencyKey), type: 'pm.ensure', sessionId: 'pm-1',
    project: { id: 'project-1', title: 'Project', goal: 'Ship it' }, workspace: join(root, 'project-1'),
    profile: PM_PROFILE, sessionToken: 'session-token', prompt: PM_PROFILE.prompt }
}

function workerCreate(idempotencyKey = 'worker-1'): NodeCommand {
  return { ...envelope(idempotencyKey), type: 'worker.create', sessionId: 'worker-1', projectId: 'project-1',
    assignmentId: 'assignment-1', ticketId: 'ticket-1', workspace: join(root, 'project-1'),
    profile: WORKER_PROFILE, sessionToken: 'session-token', prompt: 'Do the ticket' }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for the node event stream')
    await sleep(20)
  }
}

describe('DshNodePort', () => {
  it('reports the node status of a register and a heartbeat', async () => {
    const events: NodeEvent[] = []
    port.subscribe(event => events.push(event))

    await port.send(register())
    await port.send(heartbeat('heartbeat-1', false))

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'node.status', sessionId: '', role: 'pm', nodeId: NODE_ID, seq: 1, at: NOW,
      status: { nodeId: NODE_ID, backend: 'dsh', version: '0.1.0', online: true } })
    expect(events[1]).toMatchObject({ type: 'node.status', seq: 2, status: { online: false } })
  })

  it('creates a workspace under the node root and refuses one outside it', async () => {
    await port.send({ ...envelope('workspace-1'), type: 'workspace.ensure', projectId: 'project-1',
      workspace: join(root, 'project-1') })
    await port.send({ ...envelope('bind-1'), type: 'project.bind', projectId: 'project-2', workspace: join(root, 'project-2') })

    expect(existsSync(join(root, 'project-1'))).toBe(true)
    expect(existsSync(join(root, 'project-2'))).toBe(true)

    await expect(port.send({ ...envelope('workspace-escape'), type: 'workspace.ensure', projectId: 'project-1',
      workspace: join(directory, 'outside') })).rejects.toThrow(/escapes the node root/)
    expect(existsSync(join(directory, 'outside'))).toBe(false)
  })

  it('ensures a PM and a Worker Session through the host', async () => {
    await port.send(pmEnsure())
    await port.send(workerCreate())

    expect(host.ensured).toEqual([
      { sessionId: 'pm-1', workspace: join(root, 'project-1'), title: 'Project', role: 'pm', prompt: PM_PROFILE.prompt,
        sessionToken: 'session-token' },
      { sessionId: 'worker-1', workspace: join(root, 'project-1'), title: 'Worker ticket-1', role: 'worker',
        prompt: 'Do the ticket', sessionToken: 'session-token', ticketId: 'ticket-1', assignmentId: 'assignment-1' },
    ])
    expect(existsSync(join(root, 'project-1'))).toBe(true)
  })

  it('delivers messages, cancels, archives and sets permissions', async () => {
    await port.send({ ...envelope('message-1'), type: 'session.message', sessionId: 'pm-1', text: 'Hello' })
    await port.send({ ...envelope('cancel-1'), type: 'session.cancel', sessionId: 'pm-1', reason: 'operator' })
    await port.send({ ...envelope('archive-1'), type: 'session.archive', sessionId: 'pm-1' })
    await port.send({ ...envelope('permission-1'), type: 'permission.set', sessionId: 'pm-1', permission: 'workspace-write' })

    expect(host.prompts).toEqual([{ sessionId: 'pm-1', key: 'message-1', text: 'Hello' }])
    expect(host.cancelled).toEqual(['pm-1'])
    expect(host.archived).toEqual(['pm-1'])
    expect(host.permissions).toEqual([{ sessionId: 'pm-1', permission: 'workspace-write' }])
  })

  it('executes a repeated command at most once', async () => {
    await port.send(pmEnsure('same-key'))
    await port.send(pmEnsure('same-key'))
    expect(host.ensured).toHaveLength(1)

    // A new key is a new logical command; the control plane issues one per attempt.
    await port.send(pmEnsure('other-key'))
    expect(host.ensured).toHaveLength(2)
  })

  it('rejects a command from another protocol version', async () => {
    await expect(port.send({ ...pmEnsure(), protocolVersion: 2 } as unknown as NodeCommand))
      .rejects.toThrow(/protocol version/)
    expect(host.ensured).toHaveLength(0)
  })

  it('republishes host events with the session envelope and a rising seq', async () => {
    const events: NodeEvent[] = []
    port.subscribe(event => events.push(event))
    await port.send(pmEnsure())

    host.emit({ type: 'session.event', sessionId: 'pm-1', kind: 'message', data: { text: 'hi' } })
    host.emit({ type: 'session.status', sessionId: 'pm-1', status: 'running' })
    host.emit({ type: 'session.status', sessionId: 'unregistered', status: 'idle' })

    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ type: 'session.event', kind: 'message', sessionId: 'pm-1', projectId: 'project-1',
      role: 'pm', protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID, seq: 1, at: NOW, data: { text: 'hi' } })
    expect(events[1]).toMatchObject({ type: 'session.status', status: 'running', sessionId: 'pm-1', projectId: 'project-1',
      role: 'pm', seq: 2 })
    // A Session this port did not create still carries a valid envelope; the control plane ignores an unknown Session.
    expect(events[2]).toMatchObject({ type: 'session.status', sessionId: 'unregistered', projectId: '', role: 'worker', seq: 3 })
  })

  it('holds one host subscription for every listener and releases it with the last one', () => {
    const first = port.subscribe(() => {})
    const second = port.subscribe(() => {})
    expect(host.subscriptions).toBe(1)
    expect(host.listeners.size).toBe(1)

    first()
    first()
    expect(host.listeners.size).toBe(1)
    second()
    expect(host.listeners.size).toBe(0)
  })
})

describe('DshNodePort behind the node HTTP server', () => {
  it('accepts commands over HTTP and streams the adapter events back over SSE', async () => {
    const server = await startNodeHttpServer({ node: port, token: 'node-token', port: 0 })
    const client = new HttpNodePort({ url: server.url, token: 'node-token' })
    const events: NodeEvent[] = []
    const unsubscribe = client.subscribe(event => events.push(event))
    try {
      // Warm the stream: the first heartbeat can race the SSE handshake, so send one per attempt until one arrives.
      for (let attempt = 0; events.length === 0; attempt++) {
        if (attempt > 100) throw new Error('the node event stream did not open')
        await client.send(heartbeat(`http-heartbeat-${attempt}`))
        await sleep(20)
      }

      await client.send(pmEnsure('pm-http'))
      expect(host.ensured).toHaveLength(1)
      expect(host.ensured[0]).toMatchObject({ sessionId: 'pm-1', workspace: join(root, 'project-1'), role: 'pm' })

      host.emit({ type: 'session.status', sessionId: 'pm-1', status: 'idle' })
      await waitFor(() => events.some(event => event.type === 'session.status'))
      expect(events.find(event => event.type === 'session.status')).toMatchObject({ sessionId: 'pm-1',
        projectId: 'project-1', role: 'pm', status: 'idle' })
      // The stream keeps rising seq across both the node status the port emitted itself and the forwarded event.
      const sequences = events.map(event => event.seq)
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
    } finally {
      unsubscribe()
      await server.close()
    }
  })
})
