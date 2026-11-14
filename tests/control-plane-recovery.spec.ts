/**
 * P2-D2 control-plane recovery: registration after a control restart, periodic node liveness, Session re-ensure per node
 * generation, and the backend Session id a creation answers with.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { HttpNodePort } from '../src/control/http-node.ts'
import { startControlPlane } from '../src/control/start.ts'
import { KV } from '../src/kv.ts'
import { DshNodePort, type DshPortEvent, type DshPortHost } from '../src/node/dsh-port.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { startNodeHttpServer } from '../src/node/http-server.ts'
import { type NodeCommand, type NodeEvent, type NodePort, type NodeStatus, type SessionInspection }
  from '../src/shared/protocol.ts'

const SECRET = 'recovery-secret'
const API_TOKEN = 'recovery-api-token'
const START = '2026-01-01T00:00:00.000Z'
const NEXT = '2026-01-01T00:00:01.000Z'

let directory = ''
let clock = START
const opened: ControlPlane[] = []

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean, message: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await sleep(5)
  }
}

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

function prepare(): void {
  directory = mkdtempSync(join(tmpdir(), 'superagent-recovery-'))
  clock = START
}

function nodeRoot(): string {
  return join(directory, 'workspaces')
}

function openControl(node: NodePort): ControlPlane {
  const control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: nodeRoot(), now: () => clock, confirmationTimeoutMs: 50 })
  opened.push(control)
  return control
}

function saveProject(control: ControlPlane): ReturnType<ControlPlane['createProject']> {
  control.store.triggers.save(trigger())
  return control.createProject('trigger-1', 'Project', 'Goal')
}

function pmEnsures(node: { commands: NodeCommand[] }): Extract<NodeCommand, { type: 'pm.ensure' }>[] {
  return node.commands.filter((command): command is Extract<NodeCommand, { type: 'pm.ensure' }> =>
    command.type === 'pm.ensure')
}

function workerCreates(node: { commands: NodeCommand[] }): Extract<NodeCommand, { type: 'worker.create' }>[] {
  return node.commands.filter((command): command is Extract<NodeCommand, { type: 'worker.create' }> =>
    command.type === 'worker.create')
}

/** Start the node HTTP facade on the address a closed one used, retrying the moment Windows may need to release it. */
async function listenAt(url: string, node: FakeNode, token: string): Promise<Awaited<ReturnType<typeof startNodeHttpServer>>> {
  const port = Number(new URL(url).port)
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await startNodeHttpServer({ node, token, port })
    } catch (error) {
      if (attempt >= 20) throw error
      await sleep(10)
    }
  }
}

afterEach(async () => {
  for (const control of opened.splice(0)) await control.close().catch(() => {})
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

/** A `DshPortHost` with no backend behaviour: registration and heartbeats never reach it. */
class RegistrationHost implements DshPortHost {
  private readonly listeners = new Set<(event: DshPortEvent) => void>()
  async ensureSession(): Promise<void> {}
  async promptSession(): Promise<void> {}
  async cancelSession(): Promise<void> {}
  async archiveSession(): Promise<void> {}
  async inspectSession(sessionId: string): Promise<SessionInspection> { return { sessionId, found: false } }
  setPermission(): void {}
  onEvent(listener: (event: DshPortEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  nodeStatus(): NodeStatus {
    return { nodeId: 'local', backend: 'dsh', version: '0.1.0', online: true, at: START }
  }
}

/** A node wrapper whose heartbeats can be made to fail, as a node that went away underneath the control plane would. */
class ToggleHeartbeatNode implements NodePort {
  readonly commands: NodeCommand[] = []
  failHeartbeats = false

  constructor(private readonly inner: FakeNode) {}

  async send(command: NodeCommand): Promise<void> {
    this.commands.push(command)
    if (command.type === 'node.heartbeat' && this.failHeartbeats) throw new Error('connect ECONNREFUSED')
    await this.inner.send(command)
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }

  inspect(sessionId: string): Promise<SessionInspection> {
    return this.inner.inspect(sessionId)
  }

  heartbeats(): number {
    return this.commands.filter(command => command.type === 'node.heartbeat').length
  }
}

/** A node that answers an inspection but knows no backend Session id: the control plane must keep its placeholder. */
class PlaceholderNode implements NodePort {
  constructor(private readonly inner: FakeNode) {}

  send(command: NodeCommand): Promise<void> {
    return this.inner.send(command)
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }

  async inspect(sessionId: string): Promise<SessionInspection> {
    const inspection = await this.inner.inspect(sessionId)
    return { sessionId: inspection.sessionId, found: inspection.found,
      ...(inspection.status === undefined ? {} : { status: inspection.status }) }
  }
}

/** A node that refuses one `worker.create` before the inner node executes it, as an unreachable node would. */
class RefusingCreateNode implements NodePort {
  readonly commands: NodeCommand[] = []
  failWorkerCreate = false

  constructor(private readonly inner: FakeNode) {}

  async send(command: NodeCommand): Promise<void> {
    this.commands.push(command)
    if (command.type === 'worker.create' && this.failWorkerCreate) throw new Error('node rejected worker.create')
    await this.inner.send(command)
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }

  inspect(sessionId: string): Promise<SessionInspection> {
    return this.inner.inspect(sessionId)
  }
}

describe('node registration and liveness recovery', () => {
  it('publishes node.status for every registration of a real DshNodePort, including a repeated one', async () => {
    prepare()
    const node = new DshNodePort({ host: new RegistrationHost(), nodeId: 'local', root: join(directory, 'node'),
      now: () => START })
    const observed: NodeEvent[] = []
    node.subscribe(event => observed.push(event))
    const control = openControl(node)

    await control.registerNode()
    await control.registerNode()

    // The fixed `node-register:<nodeId>` key used to be swallowed by DshNodePort.done, so the second registration ran
    // nothing and published no status. A unique key per registration keeps both facts.
    expect(observed.filter(event => event.type === 'node.status')).toHaveLength(2)
    expect(control.state().nodes.local).toMatchObject({ online: true, backend: 'dsh' })
  })

  it('restores state.nodes after a control-plane restart against a node that never restarted', async () => {
    prepare()
    const node = new DshNodePort({ host: new RegistrationHost(), nodeId: 'local', root: join(directory, 'node'),
      now: () => START })
    const first = openControl(node)
    await first.registerNode()
    expect(first.state().nodes.local).toMatchObject({ online: true })
    await first.close()

    const second = openControl(node)
    expect(second.state().nodes).toEqual({})
    await second.registerNode()

    expect(second.state().nodes.local).toMatchObject({ online: true })
  })

  it('keeps the node current with a periodic heartbeat, records a loss offline, refuses commands and stops on close', async () => {
    prepare()
    const inner = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const node = new ToggleHeartbeatNode(inner)
    const env = { SUPERAGENT_CONTROL_TOKEN: API_TOKEN, SUPERAGENT_CONTROL_DB: join(directory, 'startup', 'control.sqlite'),
      SUPERAGENT_WORKSPACE_ROOT: nodeRoot(), SUPERAGENT_NODE_ID: 'local', SUPERAGENT_CONTROL_PORT: '0' }
    const started = await startControlPlane({ env, node, heartbeatMs: 10 })
    const auth = { authorization: `Bearer ${API_TOKEN}` }
    try {
      const project = saveProject(started.control)
      const pm = await started.control.openProject(project.id)
      expect(pm.status).toBe('idle')

      await until(() => node.heartbeats() >= 2, 'the periodic heartbeat did not run')
      expect(started.control.state().nodes.local).toMatchObject({ online: true })

      const seen: NodeEvent[] = []
      started.control.subscribe(event => seen.push(event))
      node.failHeartbeats = true
      await until(() => started.control.state().nodes.local?.online === false, 'the node was not marked offline')

      // A failed heartbeat is a fact the kernel observes itself; no node event will say it, so the kernel announces one
      // with the last known status fields and only `online`/`at` changed.
      const loss = seen.findLast(event => event.type === 'node.status' && !event.status.online)
      expect(loss).toMatchObject({ type: 'node.status', nodeId: 'local', sessionId: '', projectId: '',
        status: { nodeId: 'local', backend: 'dsh', version: '0.1.0', online: false, at: expect.any(String) } })
      expect(started.control.events.some(event => event.type === 'node.status' && !event.status.online)).toBe(true)

      // The Session record is still idle, but the node cannot confirm anything: 502, never a stale 200.
      const refused = await fetch(`${started.address.url}/v1/projects/${project.id}/pm`, { method: 'POST', headers: auth })
      expect(refused.status).toBe(502)
      expect(((await refused.json()) as { error: string }).error).toMatch(/offline/)
      const heartbeatRoute = await fetch(`${started.address.url}/v1/nodes/local/heartbeat`, { method: 'POST', headers: auth })
      expect(heartbeatRoute.status).toBe(502)

      await started.close()
      const beats = node.heartbeats()
      await sleep(80)
      expect(node.heartbeats()).toBe(beats)
      await expect(fetch(`${started.address.url}/health`)).rejects.toThrow()
    } finally {
      await started.close()
    }
  })
})

describe('Session re-ensure per node generation', () => {
  it('re-ensures PM and Worker Sessions once after a control-plane restart, keeping identity and createdAt', async () => {
    prepare()
    const node = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const first = openControl(node)
    await first.registerNode()
    const project = saveProject(first)
    const pm = await first.openProject(project.id)
    const worker = await first.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    expect(pm.nodeGeneration).toEqual(expect.any(String))
    expect(worker.nodeGeneration).toBe(pm.nodeGeneration)
    // The generation is current, so a repeated request sends nothing.
    await first.openProject(project.id)
    expect(pmEnsures(node)).toHaveLength(1)
    await first.close()

    clock = NEXT
    const second = openControl(node)
    await second.registerNode()
    const reopened = await second.openProject(project.id)
    expect(reopened.sessionId).toBe(pm.sessionId)
    expect(reopened.createdAt).toBe(pm.createdAt)
    expect(reopened.nodeGeneration).toEqual(expect.any(String))
    expect(reopened.nodeGeneration).not.toBe(pm.nodeGeneration)
    const ensures = pmEnsures(node)
    expect(ensures).toHaveLength(2)
    expect(ensures[1]!.idempotencyKey).not.toBe(ensures[0]!.idempotencyKey)
    expect(ensures[1]!.idempotencyKey.startsWith(`pm-ensure-confirm:${project.id}:`)).toBe(true)
    expect(second.store.get(KV.control.session(pm.sessionId))).toMatchObject({ createdAt: pm.createdAt,
      status: 'idle', nodeGeneration: reopened.nodeGeneration })

    const reworker = await second.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    expect(reworker.sessionId).toBe(worker.sessionId)
    expect(reworker.createdAt).toBe(worker.createdAt)
    expect(reworker.nodeGeneration).toBe(reopened.nodeGeneration)
    expect(workerCreates(node)).toHaveLength(2)

    // Once the generation is current again, another request does not send a second ensure.
    await second.openProject(project.id)
    await second.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    expect(pmEnsures(node)).toHaveLength(2)
    expect(workerCreates(node)).toHaveLength(2)
  })

  it('does not reopen an archived Session when the generation changes', async () => {
    prepare()
    const node = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const first = openControl(node)
    await first.registerNode()
    const project = saveProject(first)
    const pm = await first.openProject(project.id)
    await first.archiveSession(pm.sessionId)
    expect(first.session(pm.sessionId)).toMatchObject({ status: 'archived', archivedAt: START })
    await first.close()

    clock = NEXT
    const second = openControl(node)
    await second.registerNode()
    const reopened = await second.openProject(project.id)

    // An archived lifecycle is finished: a new generation must not silently resume it with a fresh ensure.
    expect(reopened).toMatchObject({ sessionId: pm.sessionId, status: 'archived', archivedAt: START,
      createdAt: pm.createdAt })
    expect(pmEnsures(node)).toHaveLength(1)
  })

  it('rotates the generation on offline-to-online and re-ensures the recorded Session once', async () => {
    prepare()
    const node = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    const pm = await control.openProject(project.id)
    const firstGeneration = pm.nodeGeneration

    await control.heartbeat(false)
    expect(control.state().nodes.local).toMatchObject({ online: false })
    clock = NEXT
    await control.heartbeat(true)
    expect(control.state().nodes.local).toMatchObject({ online: true })

    const reopened = await control.openProject(project.id)
    expect(reopened.sessionId).toBe(pm.sessionId)
    expect(reopened.createdAt).toBe(pm.createdAt)
    expect(reopened.nodeGeneration).not.toBe(firstGeneration)
    expect(pmEnsures(node)).toHaveLength(2)
  })
})

describe('backend Session id at creation', () => {
  it('answers with the backend Session id the node knows instead of the fake- placeholder', async () => {
    prepare()
    const node = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)

    const pm = await control.openProject(project.id)
    expect(pm.backendSessionId).toBe(pm.sessionId)
    expect(pm.backendSessionId).not.toMatch(/^fake-/)
    expect(control.store.get(KV.control.session(pm.sessionId))).toMatchObject({ backendSessionId: pm.sessionId })

    const worker = await control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    expect(worker.backendSessionId).toBe(worker.sessionId)
    expect(control.store.get(KV.control.session('worker-assignment-1'))).toMatchObject({
      backendSessionId: worker.sessionId })
  })

  it('keeps the placeholder when the node cannot report a real backend id', async () => {
    prepare()
    const inner = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const node = new PlaceholderNode(inner)
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)

    // The node answered the ensure and an inspection but has no backend id of its own. The control plane never invents
    // one, so its creation-time placeholder stays and the record honestly says the backend id is not known yet.
    const pm = await control.openProject(project.id)
    expect(pm.status).toBe('idle')
    expect(pm.backendSessionId).toBe(`fake-${pm.sessionId}`)
    expect(control.store.get(KV.control.session(pm.sessionId))).toMatchObject({
      backendSessionId: `fake-${pm.sessionId}` })
    expect(inner.sessions.get(pm.sessionId)).toBeDefined()
  })
})

describe('message delivery re-ensures a stale Session', () => {
  it('re-ensures a stale Worker Session before delivering its message', async () => {
    prepare()
    const node = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    await control.openProject(project.id)
    const worker = await control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    const generation = worker.nodeGeneration
    await control.heartbeat(false)
    clock = NEXT
    await control.heartbeat(true)

    await control.sendMessage(worker.sessionId, 'resume the work')

    expect(workerCreates(node)).toHaveLength(2)
    const reensure = workerCreates(node)[1]!
    expect(reensure).toMatchObject({ sessionId: worker.sessionId, assignmentId: 'assignment-1' })
    // No Ticket record names this Assignment, so the Assignment id is the fallback title source.
    expect(reensure.ticketId).toBe('assignment-1')
    const messageAt = node.commands.findIndex(command => command.type === 'session.message')
    expect(messageAt).toBeGreaterThan(node.commands.findLastIndex(command => command.type === 'worker.create'))
    expect(node.messages.get(worker.sessionId)).toEqual(['resume the work'])
    expect(control.session(worker.sessionId)?.nodeGeneration).not.toBe(generation)
  })

  it('does not re-ensure a Worker Session whose generation is current', async () => {
    prepare()
    const node = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    await control.openProject(project.id)
    const worker = await control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')

    await control.sendMessage(worker.sessionId, 'hello')

    expect(workerCreates(node)).toHaveLength(1)
    expect(node.commands.filter(command => command.type === 'session.message')).toHaveLength(1)
    expect(node.messages.get(worker.sessionId)).toEqual(['hello'])
  })

  it('re-ensures a stale PM Session before delivering its message', async () => {
    prepare()
    const node = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    const pm = await control.openProject(project.id)
    const generation = pm.nodeGeneration
    const ensuresBefore = pmEnsures(node).length
    await control.heartbeat(false)
    clock = NEXT
    await control.heartbeat(true)

    await control.sendMessage(pm.sessionId, 'hello')

    expect(pmEnsures(node)).toHaveLength(ensuresBefore + 1)
    expect(pmEnsures(node).at(-1)?.sessionId).toBe(pm.sessionId)
    const messageAt = node.commands.findIndex(command => command.type === 'session.message')
    expect(messageAt).toBeGreaterThan(node.commands.findLastIndex(command => command.type === 'pm.ensure'))
    expect(node.messages.get(pm.sessionId)).toEqual(['hello'])
    expect(control.session(pm.sessionId)?.nodeGeneration).not.toBe(generation)
  })

  it('rejects without delivering when the stale Session cannot be re-ensured', async () => {
    prepare()
    const firstNode = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const first = openControl(firstNode)
    await first.registerNode()
    const project = saveProject(first)
    await first.openProject(project.id)
    const worker = await first.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    await first.close()

    clock = NEXT
    // The node restarted and holds no Session; its worker.create is refused before anything executes.
    const restarted = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const refusing = new RefusingCreateNode(restarted)
    const second = openControl(refusing)
    await second.registerNode()
    refusing.failWorkerCreate = true

    await expect(second.sendMessage(worker.sessionId, 'hello')).rejects.toThrow(/node rejected worker\.create/)
    expect(second.session(worker.sessionId)).toMatchObject({ status: 'failed' })
    expect(refusing.commands.some(command => command.type === 'session.message')).toBe(false)
    expect(restarted.messages.get(worker.sessionId)).toBeUndefined()
  })
})

describe('node generation on event-stream reconnect', () => {
  it('rotates the generation when the stream reopens and re-ensures before delivering', async () => {
    prepare()
    const nodeToken = 'recovery-http-node-token'
    const inner = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
    const firstServer = await startNodeHttpServer({ node: inner, token: nodeToken, port: 0 })
    const transport = new HttpNodePort({ url: firstServer.url, token: nodeToken, reconnectDelayMs: 5,
      maxReconnectDelayMs: 20 })
    const env = { SUPERAGENT_CONTROL_TOKEN: API_TOKEN, SUPERAGENT_CONTROL_DB: join(directory, 'reconnect', 'control.sqlite'),
      SUPERAGENT_WORKSPACE_ROOT: nodeRoot(), SUPERAGENT_NODE_ID: 'local', SUPERAGENT_CONTROL_PORT: '0' }
    let started: Awaited<ReturnType<typeof startControlPlane>> | undefined
    let secondServer: Awaited<ReturnType<typeof startNodeHttpServer>> | undefined
    try {
      const running = await startControlPlane({ env, node: transport, heartbeatMs: 0 })
      started = running
      const project = saveProject(running.control)
      const pm = await running.control.openProject(project.id)
      const generation = running.control.generation
      const reconnected = vi.spyOn(running.control, 'nodeReconnected')

      // The node restarts on the same address between two heartbeats: only the stream drop/reopen is observable.
      await firstServer.close()
      const restarted = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
      secondServer = await listenAt(firstServer.url, restarted, nodeToken)

      await until(() => running.control.generation !== generation, 'the reopened stream did not rotate the generation')
      expect(reconnected).toHaveBeenCalledTimes(1)

      await running.control.sendMessage(pm.sessionId, 'after the restart')

      // The restarted node had no such Session; the delivery first re-ensured it on that node.
      expect(restarted.sessions.get(pm.sessionId)).toBeDefined()
      expect(restarted.messages.get(pm.sessionId)).toEqual(['after the restart'])
      const ensureAt = restarted.commands.findIndex(command => command.type === 'pm.ensure')
      const messageAt = restarted.commands.findIndex(command => command.type === 'session.message')
      expect(ensureAt).toBeGreaterThanOrEqual(0)
      expect(ensureAt).toBeLessThan(messageAt)
      reconnected.mockRestore()
    } finally {
      await started?.close().catch(() => {})
      await secondServer?.close().catch(() => {})
      await firstServer.close().catch(() => {})
    }
  })
})

it('keeps a node whose status is still unknown usable (startup registration is the fail-fast point)', async () => {
  prepare()
  const node = new FakeNode({ nodeId: 'local', root: nodeRoot(), now: () => clock })
  const control = openControl(node)
  const project = saveProject(control)

  expect(control.state().nodes).toEqual({})
  const pm = await control.openProject(project.id)
  expect(pm.status).toBe('idle')
})
