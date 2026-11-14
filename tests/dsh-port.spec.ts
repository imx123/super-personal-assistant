/** Phase 1B-3d: the real DSH node adapter, driven by a fake host and served behind the node HTTP transport. */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpNodePort } from '../src/control/http-node.ts'
import { createDshPortHost } from '../src/node/dsh-port-host.ts'
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
  readonly prompts: { sessionId: string; key: string; text: string; sessionToken?: string
    inputIds?: readonly string[] }[] = []
  readonly cancelled: string[] = []
  /** The reason each cancel carried, proving the command's own reason reaches the host. */
  readonly cancelReasons: (string | undefined)[] = []
  readonly archived: string[] = []
  readonly permissions: { sessionId: string; permission: string }[] = []
  readonly listeners = new Set<(event: DshPortEvent) => void>()
  /** How many host subscriptions the port holds, proving one serves every listener. */
  subscriptions = 0
  /** Optional gate a cancel command waits on, proving the command waits for cleanup. */
  cancelGate?: Promise<void>
  /** When set, a cancel fails with this error, proving the port reports the host's refusal. */
  cancelError?: Error

  async ensureSession(input: Parameters<DshPortHost['ensureSession']>[0]): Promise<void> { this.ensured.push(input) }
  async promptSession(sessionId: string, idempotencyKey: string, text: string, sessionToken?: string,
    inputIds?: readonly string[]): Promise<void> {
    this.prompts.push({ sessionId, key: idempotencyKey, text,
      ...(sessionToken === undefined ? {} : { sessionToken }), ...(inputIds === undefined ? {} : { inputIds }) })
  }
  async cancelSession(sessionId: string, reason?: string): Promise<void> {
    if (this.cancelGate) await this.cancelGate
    if (this.cancelError) throw this.cancelError
    this.cancelled.push(sessionId)
    this.cancelReasons.push(reason)
  }
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
        profile: PM_PROFILE, sessionToken: 'session-token' },
      { sessionId: 'worker-1', workspace: join(root, 'project-1'), title: 'Worker ticket-1', role: 'worker',
        prompt: 'Do the ticket', profile: WORKER_PROFILE, sessionToken: 'session-token', ticketId: 'ticket-1',
        assignmentId: 'assignment-1' },
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
    expect(host.cancelReasons).toEqual(['operator'])
    expect(host.archived).toEqual(['pm-1'])
    expect(host.permissions).toEqual([{ sessionId: 'pm-1', permission: 'workspace-write' }])
  })

  it('waits for the host cancel cleanup before acknowledging the command', async () => {
    let release!: () => void
    host.cancelGate = new Promise<void>(resolve => { release = resolve })
    let settled = false
    const command = port.send({ ...envelope('cancel-wait-1'), type: 'session.cancel', sessionId: 'pm-1', reason: 'operator' })
    void command.then(() => { settled = true })
    await sleep(20)
    expect(settled).toBe(false)
    expect(host.cancelled).toEqual([])
    release()
    await command
    expect(host.cancelled).toEqual(['pm-1'])
  })

  it('fails the cancel command with the host’s cleanup error', async () => {
    host.cancelError = new Error('the Session did not settle within 20 ms')
    await expect(port.send({ ...envelope('cancel-failure-1'), type: 'session.cancel', sessionId: 'pm-1', reason: 'operator' }))
      .rejects.toThrow('the Session did not settle within 20 ms')
    // A failed cancel was never recorded as completed, so the control plane can retry the same key.
    host.cancelError = undefined
    await port.send({ ...envelope('cancel-failure-1'), type: 'session.cancel', sessionId: 'pm-1', reason: 'operator' })
    expect(host.cancelled).toEqual(['pm-1'])
  })

  it('passes an optional Session token on a message through to the host', async () => {
    await port.send({ ...envelope('message-token-1'), type: 'session.message', sessionId: 'pm-1', text: 'Hello',
      sessionToken: 'message-token' })

    expect(host.prompts).toEqual([{ sessionId: 'pm-1', key: 'message-token-1', text: 'Hello',
      sessionToken: 'message-token' }])
  })

  it('passes the Input ids of a message through to the host', async () => {
    await port.send({ ...envelope('message-inputs-1'), type: 'session.message', sessionId: 'pm-1', text: 'Hello',
      inputIds: ['input-1', 'input-2'] })

    expect(host.prompts).toEqual([{ sessionId: 'pm-1', key: 'message-inputs-1', text: 'Hello',
      inputIds: ['input-1', 'input-2'] }])
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

/** A Cordis context stand-in: the host subscribes to Session events and reads optional services from it here. */
type ContextListener = (...args: unknown[]) => void

type FakeContext = {
  on: (name: string, listener: ContextListener) => () => void
  get: (name: string) => unknown
}

function fakeContext(services: Record<string, unknown> = {}): { context: FakeContext
  emit: (name: string, ...args: unknown[]) => void } {
  const listeners = new Map<string, Set<ContextListener>>()
  return {
    context: {
      on(name, listener) {
        const set = listeners.get(name) ?? new Set<ContextListener>()
        set.add(listener)
        listeners.set(name, set)
        return () => { set.delete(listener) }
      },
      get: (name: string) => services[name],
    },
    emit(name, ...args) {
      for (const listener of [...listeners.get(name) ?? []]) listener(...args)
    },
  }
}

describe('createDshPortHost turn start input ids', () => {
  /** A real host over a fake backend and Context; the test drives the Session events it maps. */
  function host(options: { failPrompt?: boolean; promptGate?: Promise<void> } = {}): { host: DshPortHost
    emit: (sessionId: string, event: unknown) => void } {
    const fake = fakeContext()
    return {
      host: createDshPortHost({ context: fake.context, nodeRuntime: { sessions: {
        async ensure() { return {} },
        async prompt(_sessionId: string, _idempotencyKey: string, _text: string, _mode: 'queue',
          onDelivered?: () => void) {
          if (options.promptGate) await options.promptGate
          if (options.failPrompt) throw new Error('the inbox is closed')
          // A real backend reports the insertion from inside `prompt`, before its persistence flush returns.
          onDelivered?.()
        },
      } }, nodeId: NODE_ID, root }),
      emit: (sessionId, event) => fake.emit('session/event', { id: sessionId }, event),
    }
  }

  /** The `data` a mapped event carries; the protocol leaves it `unknown`. */
  const dataOf = (event: DshPortEvent): unknown => (event as { data?: unknown }).data

  it('reports the ids a delivery carried on the next turn start and not on the one after', async () => {
    const { host: portHost, emit } = host()
    const events: DshPortEvent[] = []
    const dispose = portHost.onEvent(event => events.push(event))
    try {
      await portHost.promptSession('worker-1', 'message-1', 'Hello', undefined, ['input-1', 'input-2'])
      emit('worker-1', { type: 'turn/start', data: { turn: 1 } })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'session.event', kind: 'turn-start', sessionId: 'worker-1' })
      expect(dataOf(events[0]!)).toEqual({ turn: 1, inputIds: ['input-1', 'input-2'] })

      // The turn took them, so the Session's next turn reports no ids and its data is exactly what it was before.
      emit('worker-1', { type: 'turn/start', data: { turn: 2 } })
      expect(dataOf(events[1]!)).toEqual({ turn: 2 })
    } finally {
      dispose()
    }
  })

  it('reports no Input id for a turn that starts while the delivery still waits', async () => {
    const gate = Promise.withResolvers<void>()
    const { host: portHost, emit } = host({ promptGate: gate.promise })
    const events: DshPortEvent[] = []
    const dispose = portHost.onEvent(event => events.push(event))
    try {
      const delivery = portHost.promptSession('worker-1', 'message-1', 'Hello', undefined, ['input-1'])
      // The backend has not accepted the message yet, so the turn cannot have taken its Input.
      emit('worker-1', { type: 'turn/start', data: { turn: 1 } })
      expect(dataOf(events[0]!)).toEqual({ turn: 1 })

      gate.resolve()
      await delivery
      emit('worker-1', { type: 'turn/start', data: { turn: 2 } })
      expect(dataOf(events[1]!)).toEqual({ turn: 2, inputIds: ['input-1'] })
    } finally {
      dispose()
    }
  })

  it('merges the ids of deliveries waiting for one turn, per Session', async () => {
    const { host: portHost, emit } = host()
    const events: DshPortEvent[] = []
    const dispose = portHost.onEvent(event => events.push(event))
    try {
      await portHost.promptSession('worker-1', 'message-1', 'first', undefined, ['input-1'])
      await portHost.promptSession('worker-1', 'message-2', 'second', undefined, ['input-2', 'input-1'])
      await portHost.promptSession('worker-2', 'message-3', 'other', undefined, ['input-9'])

      // One turn start reports every id waiting for it, without repeating one delivered twice.
      emit('worker-1', { type: 'turn/start', data: { turn: 1 } })
      expect(dataOf(events[0]!)).toEqual({ turn: 1, inputIds: ['input-1', 'input-2'] })
      // Another Session's delivery waits for its own turn, not this one.
      emit('worker-1', { type: 'turn/start', data: { turn: 2 } })
      expect(dataOf(events[1]!)).toEqual({ turn: 2 })
      emit('worker-2', { type: 'turn/start', data: { turn: 1 } })
      expect(dataOf(events[2]!)).toEqual({ turn: 1, inputIds: ['input-9'] })
    } finally {
      dispose()
    }
  })

  it('forgets the ids of a delivery the backend refused', async () => {
    const { host: portHost, emit } = host({ failPrompt: true })
    const events: DshPortEvent[] = []
    const dispose = portHost.onEvent(event => events.push(event))
    try {
      await expect(portHost.promptSession('worker-1', 'message-1', 'Hello', undefined, ['input-1']))
        .rejects.toThrow('the inbox is closed')

      // The worker never received it, so no turn may claim these Inputs were read.
      emit('worker-1', { type: 'turn/start', data: { turn: 1 } })
      expect(dataOf(events[0]!)).toEqual({ turn: 1 })
    } finally {
      dispose()
    }
  })

  it('reports the Inputs of a message inserted before its turn starts, not after the prompt resolves', async () => {
    const fake = fakeContext()
    const events: DshPortEvent[] = []
    const sessions = {
      async ensure() { return {} },
      async prompt(sessionId: string, _key: string, _text: string, _mode: 'queue', onDelivered?: () => void) {
        // The insertion callback and the turn it starts both happen while `prompt` is still running.
        onDelivered?.()
        fake.emit('session/event', { id: sessionId }, { type: 'turn/start', data: { turn: 1 } })
      },
    }
    const portHost = createDshPortHost({ context: fake.context, nodeRuntime: { sessions }, nodeId: NODE_ID, root })
    const dispose = portHost.onEvent(event => events.push(event))
    try {
      await portHost.promptSession('worker-1', 'message-1', 'Hello', undefined, ['input-1'])
      expect(events).toHaveLength(1)
      expect(dataOf(events[0]!)).toEqual({ turn: 1, inputIds: ['input-1'] })
    } finally {
      dispose()
    }
  })

  it('reports no Inputs for a turn that starts before a refused insertion, and none on a later turn', async () => {
    const fake = fakeContext()
    const events: DshPortEvent[] = []
    const sessions = {
      async ensure() { return {} },
      async prompt(sessionId: string) {
        // The turn starts while the message is still being delivered; the backend then refuses before inserting it.
        fake.emit('session/event', { id: sessionId }, { type: 'turn/start', data: { turn: 1 } })
        throw new Error('the inbox is closed')
      },
    }
    const portHost = createDshPortHost({ context: fake.context, nodeRuntime: { sessions }, nodeId: NODE_ID, root })
    const dispose = portHost.onEvent(event => events.push(event))
    try {
      await expect(portHost.promptSession('worker-1', 'message-1', 'Hello', undefined, ['input-1']))
        .rejects.toThrow('the inbox is closed')
      fake.emit('session/event', { id: 'worker-1' }, { type: 'turn/start', data: { turn: 2 } })
      expect(events.map(dataOf)).toEqual([{ turn: 1 }, { turn: 2 }])
    } finally {
      dispose()
    }
  })

  it('reports each delivery’s Inputs only from the message that was actually inserted', async () => {
    const fake = fakeContext()
    const events: DshPortEvent[] = []
    const insertions = new Map<string, () => void>()
    const sessions = {
      async ensure() { return {} },
      prompt(_sessionId: string, idempotencyKey: string, _text: string, _mode: 'queue', onDelivered?: () => void) {
        return new Promise<void>(resolve => {
          insertions.set(idempotencyKey, () => { onDelivered?.(); resolve() })
        })
      },
    }
    const portHost = createDshPortHost({ context: fake.context, nodeRuntime: { sessions }, nodeId: NODE_ID, root })
    const dispose = portHost.onEvent(event => events.push(event))
    const turn = (n: number) => fake.emit('session/event', { id: 'worker-1' }, { type: 'turn/start', data: { turn: n } })
    try {
      const first = portHost.promptSession('worker-1', 'message-1', 'first', undefined, ['input-1'])
      const second = portHost.promptSession('worker-1', 'message-2', 'second', undefined, ['input-2'])

      // Neither message is in the inbox yet, so an unrelated turn claims no Input.
      turn(1)
      expect(dataOf(events[0]!)).toEqual({ turn: 1 })

      // Only the second message was inserted when its turn starts: it alone owns that turn's ids.
      insertions.get('message-2')!()
      await second
      turn(2)
      expect(dataOf(events[1]!)).toEqual({ turn: 2, inputIds: ['input-2'] })

      insertions.get('message-1')!()
      await first
      turn(3)
      expect(dataOf(events[2]!)).toEqual({ turn: 3, inputIds: ['input-1'] })
    } finally {
      dispose()
    }
  })
})

describe('createDshPortHost cancel deadline', () => {
  it('rejects a cancel whose Agent never becomes idle within the configured deadline', async () => {
    const fake = fakeContext()
    const agent = { status: 'running' as const, cancel: vi.fn(), whenIdle: () => new Promise<void>(() => {}) }
    const context = { ...fake.context, agents: { get: () => agent } }
    const stop = createDshPortHost({ context, nodeRuntime: { sessions: {
      async ensure() { return {} },
      async prompt() {},
    } }, nodeId: NODE_ID, root, cancelTimeoutMs: 20 })

    const started = Date.now()
    const failure = await stop.cancelSession('worker-hang').then(() => undefined, (error: unknown) => error)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(150)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('worker-hang')
    expect((failure as Error).message).toContain('20 ms')
    // The deadline bounds the wait; it does not replace the turn cancellation that may still settle.
    expect(agent.cancel).toHaveBeenCalledOnce()
  })
})

describe('createDshPortHost inspection of a persisted Session', () => {
  /** A host whose Context reports `services`, plus the two members `inspectSession` always reads. */
  function inspectionHost(options: { agent?: { status?: string }; archived?: readonly string[]
    services?: Record<string, unknown> } = {}) {
    const fake = fakeContext(options.services)
    const context = { ...fake.context, agents: { get: () => options.agent },
      workspaceRegistry: { archivedSessionIds: options.archived ?? [] } }
    return {
      host: createDshPortHost({ context, nodeRuntime: { sessions: {
        async ensure() { return {} },
        async prompt() {},
      } }, nodeId: NODE_ID, root }),
      emit: fake.emit,
    }
  }

  /** An observation lease that records its release, as DSH's `sessionQuery` returns one. */
  function lease(released: () => void): { [Symbol.dispose](): void } {
    return { [Symbol.dispose]() { released() } }
  }

  it('reports a Session that exists only in persistence, with its backend id and no status', async () => {
    const release = vi.fn()
    const observeSession = vi.fn(async (_sessionId: string, _options?: unknown) => lease(release))
    const { host } = inspectionHost({ services: { sessionQuery: { observeSession } } })

    const inspection = await host.inspectSession('pm-1')
    expect(inspection).toEqual({ sessionId: 'pm-1', found: true, backendSessionId: 'pm-1' })
    // The missing status is the fact: the control plane must re-ensure a persisted Session that is not mounted.
    expect(inspection).not.toHaveProperty('status')
    expect(observeSession).toHaveBeenCalledWith('pm-1', { projectionMode: 'none' })
    expect(release).toHaveBeenCalledOnce()
  })

  it('reports an absent Session as not found when the query says so', async () => {
    const observeSession = vi.fn(async () => {
      throw Object.assign(new Error('no such Session'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    })
    const { host } = inspectionHost({ services: { sessionQuery: { observeSession } } })

    await expect(host.inspectSession('missing')).resolves.toEqual({ sessionId: 'missing', found: false })
  })

  it('propagates a read failure instead of claiming the Session is absent', async () => {
    const observeSession = vi.fn(async () => { throw new Error('the Session store is unreadable') })
    const { host } = inspectionHost({ services: { sessionQuery: { observeSession } } })

    await expect(host.inspectSession('pm-1')).rejects.toThrow('the Session store is unreadable')
  })

  it('keeps the old answer when the host offers no sessionQuery', async () => {
    const { host } = inspectionHost()
    await expect(host.inspectSession('pm-1')).resolves.toEqual({ sessionId: 'pm-1', found: false })
  })

  it('keeps reporting a live agent status without asking persistence', async () => {
    const observeSession = vi.fn(async () => lease(() => {}))
    const idle = inspectionHost({ agent: { status: 'idle' }, services: { sessionQuery: { observeSession } } })
    await expect(idle.host.inspectSession('pm-1')).resolves.toEqual({ sessionId: 'pm-1', found: true, status: 'idle',
      backendSessionId: 'pm-1' })
    const running = inspectionHost({ agent: { status: 'running' }, services: { sessionQuery: { observeSession } } })
    await expect(running.host.inspectSession('pm-1')).resolves.toEqual({ sessionId: 'pm-1', found: true, status: 'running',
      backendSessionId: 'pm-1' })
    expect(observeSession).not.toHaveBeenCalled()
  })

  it('keeps a prepared Session ready without inventing a status', async () => {
    const observeSession = vi.fn(async () => lease(() => {}))
    const { host } = inspectionHost({ services: { sessionQuery: { observeSession } } })
    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      profile: PM_PROFILE, prompt: PM_PROFILE.prompt, sessionToken: 'session-token' })

    await expect(host.inspectSession('pm-1')).resolves.toEqual({ sessionId: 'pm-1', found: true, ready: true })
    expect(observeSession).not.toHaveBeenCalled()
  })

  it('keeps reporting an archived Session', async () => {
    const observeSession = vi.fn(async () => lease(() => {}))
    const { host } = inspectionHost({ archived: ['pm-1'], services: { sessionQuery: { observeSession } } })

    await expect(host.inspectSession('pm-1')).resolves.toEqual({ sessionId: 'pm-1', found: true, status: 'archived',
      backendSessionId: 'pm-1' })
    expect(observeSession).not.toHaveBeenCalled()
  })
})
