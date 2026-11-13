import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane, SessionEnsureError } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { startControlPlane } from '../src/control/start.ts'
import { KV } from '../src/kv.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeEvent, type NodePort, type SessionInspection }
  from '../src/shared/protocol.ts'

const SECRET = 'crosslayer-secret'
const API_TOKEN = 'crosslayer-api-token'
const START = '2026-01-01T00:00:00.000Z'
const NEXT = '2026-01-01T00:00:01.000Z'

let directory = ''
let server: ControlPlaneServer | undefined
const opened: ControlPlane[] = []

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

function prepare(): void {
  directory = mkdtempSync(join(tmpdir(), 'superagent-crosslayer-'))
}

function openControl(node: NodePort): ControlPlane {
  const control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node,
    secret: SECRET, workspaceRoot: join(directory, 'workspaces'), now: () => START, confirmationTimeoutMs: 50 })
  opened.push(control)
  return control
}

function saveProject(control: ControlPlane): ReturnType<ControlPlane['createProject']> {
  control.store.triggers.save(trigger())
  return control.createProject('trigger-1', 'Project', 'Goal')
}

/**
 * A FakeNode with the failures the cross-layer acceptance exercised: lost acknowledgements, lost status events,
 * role installation that fails after the Session is already idle, and rejected message delivery.
 *
 * `inspect` answers from the FakeNode's own state, which is what an explicit node query exists for.
 */
class ControlledNode implements NodePort {
  readonly commands: NodeCommand[] = []
  readonly ensured: string[] = []
  /** Sessions whose role installation rejects after the agent already became idle. */
  readonly unready = new Set<string>()
  /** Drop the next `session.status` event for these Sessions, emulating a lost event over SSE. */
  readonly dropStatus = new Set<string>()
  /** How many pm.ensure/worker.create acknowledgements to lose after the node actually executed them. */
  ensureAcksToLose = 0
  rejectMessages = false
  dropArchiveStatus = false
  /** Stall one ensure before the node executes it. */
  hold: { sessionId: string; entered: () => void; wait: Promise<void> } | undefined
  /** Stall one ensure after the node executed it: its Session is already idle and only role installation can still fail. */
  holdAfter: { sessionId: string; entered: () => void; wait: Promise<void> } | undefined

  constructor(readonly inner: FakeNode) {}

  async send(command: NodeCommand): Promise<void> {
    this.commands.push(command)
    if (command.type === 'pm.ensure' || command.type === 'worker.create') this.ensured.push(command.sessionId)
    const hold = this.hold
    if (hold && command.type === 'pm.ensure' && command.sessionId === hold.sessionId) {
      this.hold = undefined
      hold.entered()
      await hold.wait
    }
    if (command.type === 'session.message' && this.rejectMessages) throw new Error('message delivery failed')
    await this.inner.send(command)
    const holdAfter = this.holdAfter
    if (holdAfter && (command.type === 'pm.ensure' || command.type === 'worker.create') && command.sessionId === holdAfter.sessionId) {
      this.holdAfter = undefined
      holdAfter.entered()
      await holdAfter.wait
    }
    if ((command.type === 'pm.ensure' || command.type === 'worker.create') && this.unready.has(command.sessionId)) {
      throw new Error('role prompt installation failed')
    }
    if ((command.type === 'pm.ensure' || command.type === 'worker.create') && this.ensureAcksToLose > 0) {
      this.ensureAcksToLose -= 1
      throw new Error(`lost ${command.type} acknowledgement`)
    }
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    return this.inner.subscribe(event => {
      if (event.type === 'session.status' && this.dropStatus.has(event.sessionId)) {
        this.dropStatus.delete(event.sessionId)
        return
      }
      if (event.type === 'session.status' && event.status === 'archived' && this.dropArchiveStatus) {
        this.dropArchiveStatus = false
        return
      }
      listener(event)
    })
  }

  async inspect(sessionId: string): Promise<SessionInspection> {
    const session = this.inner.sessions.get(sessionId)
    if (!session) return { sessionId, found: false }
    return { sessionId, found: true, status: session.status, ready: !this.unready.has(sessionId),
      ...(session.backendSessionId === undefined ? {} : { backendSessionId: session.backendSessionId }) }
  }
}

/** A node without `inspect`: event loss must still produce an explicit failure, never a `200 / starting`. */
class NoInspectNode implements NodePort {  readonly commands: NodeCommand[] = []
  ensureAcksToLose = 1
  readonly dropStatus = new Set<string>()

  constructor(readonly inner: FakeNode) {}

  async send(command: NodeCommand): Promise<void> {
    this.commands.push(command)
    // This node cannot answer an explicit query: the control plane must then fail instead of guessing.
    if (command.type === 'session.inspect') throw new Error('inspection unsupported')
    await this.inner.send(command)
    if (command.type === 'pm.ensure' && this.ensureAcksToLose > 0) {
      this.ensureAcksToLose -= 1
      throw new Error('lost pm.ensure acknowledgement')
    }
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    return this.inner.subscribe(event => {
      if (event.type === 'session.status' && this.dropStatus.has(event.sessionId)) {
        this.dropStatus.delete(event.sessionId)
        return
      }
      listener(event)
    })
  }
}

/** A node whose only confirmation channel is the protocol's `send`/`subscribe` pair, like an opaque SSE wrapper. */
class ProtocolOnlyNode implements NodePort {
  private readonly protocolListeners = new Set<(event: NodeEvent) => void>()
  private seq = 0

  constructor(readonly inner: ControlledNode) {}

  async send(command: NodeCommand): Promise<void> {
    if (command.type === 'session.inspect') {
      const inspection = await this.inner.inspect(command.sessionId)
      const session = this.inner.inner.sessions.get(command.sessionId)
      const event: NodeEvent = {
        protocolVersion: NODE_PROTOCOL_VERSION,
        nodeId: 'local',
        sessionId: command.sessionId,
        projectId: session?.projectId ?? '',
        role: session?.role ?? 'pm',
        seq: ++this.seq,
        at: START,
        type: 'session.inspected',
        requestId: command.idempotencyKey,
        inspection,
      }
      for (const listener of [...this.protocolListeners]) listener(event)
      return
    }
    await this.inner.send(command)
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    this.protocolListeners.add(listener)
    const dispose = this.inner.subscribe(listener)
    return () => {
      this.protocolListeners.delete(listener)
      dispose()
    }
  }
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  for (const control of opened.splice(0)) await control.close().catch(() => {})
  vi.restoreAllMocks()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane cross-layer outcomes', () => {
  it('recovers a lost ensure acknowledgement and lost first status with an explicit node inspection', async () => {
    prepare()
    const node = new ControlledNode(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START }))
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    node.ensureAcksToLose = 1
    node.dropStatus.add(project.pmSessionId)
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)
    const path = `${address.url}/v1/projects/${project.id}/pm`
    const auth = { authorization: `Bearer ${API_TOKEN}` }

    const first = await fetch(path, { method: 'POST', headers: auth })
    expect(first.status).toBe(200)
    const body = (await first.json()) as { session: { sessionId: string; status: string } }
    expect(body.session).toMatchObject({ sessionId: project.pmSessionId, status: 'idle' })
    expect(control.store.get(KV.control.session(project.pmSessionId))).toMatchObject({ status: 'idle' })

    // The retry must return the same confirmed state without another ensure: the record is no longer starting.
    const retry = await fetch(path, { method: 'POST', headers: auth })
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { session: { status: string } }).session.status).toBe('idle')
    expect(node.commands.filter(command => command.type === 'pm.ensure')).toHaveLength(1)
  })

  it('never answers 200/starting when neither the acknowledgement nor the status event can be recovered', async () => {
    prepare()
    const node = new NoInspectNode(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START }))
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    node.dropStatus.add(project.pmSessionId)
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)
    const auth = { authorization: `Bearer ${API_TOKEN}` }

    const response = await fetch(`${address.url}/v1/projects/${project.id}/pm`, { method: 'POST', headers: auth })
    expect(response.status).not.toBe(200)
    const body = (await response.json()) as { session?: unknown; error?: unknown }
    expect(body.session).toBeUndefined()
    expect(typeof body.error).toBe('string')
    const record = control.session(project.pmSessionId)
    expect(record?.status).not.toBe('starting')
    expect(control.store.get(KV.control.session(project.pmSessionId))).toMatchObject({ status: 'failed' })
  })

  it('confirms through the command/event protocol when the transport has no inspect method', async () => {
    prepare()
    const inner = new ControlledNode(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START }))
    const node = new ProtocolOnlyNode(inner)
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    inner.ensureAcksToLose = 1
    inner.dropStatus.add(project.pmSessionId)

    const pm = await control.openProject(project.id)

    expect(pm.status).toBe('idle')
    expect(control.store.get(KV.control.session(project.pmSessionId))).toMatchObject({ status: 'idle' })
    expect(inner.commands.filter(command => command.type === 'pm.ensure')).toHaveLength(1)
  })

  it('shares one ensure between concurrent openProject requests for the same Session', async () => {
    prepare()
    const node = new ControlledNode(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START }))
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    node.hold = { sessionId: project.pmSessionId, entered, wait }
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)
    const auth = { authorization: `Bearer ${API_TOKEN}` }
    const path = `${address.url}/v1/projects/${project.id}/pm`

    const first = fetch(path, { method: 'POST', headers: auth })
    await enteredPromise
    const second = fetch(path, { method: 'POST', headers: auth })
    // Give the second request time to join the running ensure; it must not start a second one.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(node.ensured.filter(id => id === project.pmSessionId)).toHaveLength(1)
    release()
    const [firstResponse, secondResponse] = await Promise.all([first, second])
    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(node.ensured.filter(id => id === project.pmSessionId)).toHaveLength(1)
    expect(control.session(project.pmSessionId)?.status).toBe('idle')
  })

  it('makes a second concurrent PM request await the ensure even after the Session reported idle', async () => {
    prepare()
    const node = new ControlledNode(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START }))
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    // The node executed pm.ensure and reported idle, but its role installation has not finished yet.
    node.holdAfter = { sessionId: project.pmSessionId, entered, wait }
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)
    const auth = { authorization: `Bearer ${API_TOKEN}` }
    const path = `${address.url}/v1/projects/${project.id}/pm`

    const first = fetch(path, { method: 'POST', headers: auth })
    await enteredPromise
    expect(control.session(project.pmSessionId)?.status).toBe('idle')
    let secondSettled = false
    const second = fetch(path, { method: 'POST', headers: auth }).then(response => { secondSettled = true; return response })
    await new Promise(resolve => setTimeout(resolve, 30))
    // The record is already idle, but the ensure that produced it is still running: the second request must join it.
    expect(secondSettled).toBe(false)
    expect(node.ensured.filter(id => id === project.pmSessionId)).toHaveLength(1)

    release()
    const [firstResponse, secondResponse] = await Promise.all([first, second])
    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(control.session(project.pmSessionId)?.status).toBe('idle')
    expect(node.ensured.filter(id => id === project.pmSessionId)).toHaveLength(1)
  })

  it('fails both concurrent PM requests when role installation fails after the Session reported idle', async () => {
    prepare()
    const node = new ControlledNode(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START }))
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    node.unready.add(project.pmSessionId)
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    node.holdAfter = { sessionId: project.pmSessionId, entered, wait }
    // Two callers of the same control-plane entry point, without the HTTP connection pool in between: this is the
    // single-flight guarantee the API relies on. The second call must join the first even though the record already
    // looks idle, because the role installation can still fail.
    const first = control.openProject(project.id)
    await enteredPromise
    expect(control.session(project.pmSessionId)?.status).toBe('idle')
    const second = control.openProject(project.id)
    let secondSettled = false
    void second.finally(() => { secondSettled = true }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(secondSettled).toBe(false)

    release()
    const results = await Promise.allSettled([first, second])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(control.session(project.pmSessionId)).toMatchObject({ status: 'failed' })
    expect(node.ensured.filter(id => id === project.pmSessionId)).toHaveLength(1)
  })

  it('shares one worker.create between concurrent createWorkerSession calls after the node reported idle', async () => {
    prepare()
    const node = new ControlledNode(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START }))
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    await control.openProject(project.id)
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    node.holdAfter = { sessionId: 'worker-assignment-1', entered, wait }

    const first = control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    await enteredPromise
    expect(control.session('worker-assignment-1')?.status).toBe('idle')
    let secondSettled = false
    const second = control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
      .then(session => { secondSettled = true; return session })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(secondSettled).toBe(false)

    release()
    const [firstSession, secondSession] = await Promise.all([first, second])
    expect(firstSession.status).toBe('idle')
    expect(secondSession.status).toBe('idle')
    expect(node.ensured.filter(id => id === 'worker-assignment-1')).toHaveLength(1)
  })

  it('fails the request when the Session is idle but role installation failed', async () => {
    prepare()
    const node = new ControlledNode(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START }))
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    node.unready.add(project.pmSessionId)
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)

    const response = await fetch(`${address.url}/v1/projects/${project.id}/pm`, { method: 'POST',
      headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(response.status).toBe(502)
    expect(control.session(project.pmSessionId)).toMatchObject({ status: 'failed' })
    expect(control.store.get(KV.control.session(project.pmSessionId))).toMatchObject({ status: 'failed' })

    await expect(control.openProject(project.id)).rejects.toBeInstanceOf(SessionEnsureError)
  })

  it('does not report sent:true when the node rejects message delivery', async () => {
    prepare()
    const node = new ControlledNode(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START }))
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    const pm = await control.openProject(project.id)
    node.rejectMessages = true
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)

    const response = await fetch(`${address.url}/v1/sessions/${pm.sessionId}/message`, { method: 'POST',
      headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }) })
    expect(response.status).not.toBe(200)
    const body = (await response.json()) as { sent?: unknown; error?: unknown }
    expect(body.sent).toBeUndefined()
    expect(typeof body.error).toBe('string')
    expect(node.inner.messages.get(pm.sessionId)).toBeUndefined()
  })

  it('records the archive in the control plane even when its status event is lost', async () => {
    prepare()
    const node = new ControlledNode(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START }))
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    const pm = await control.openProject(project.id)
    node.dropArchiveStatus = true
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)
    const auth = { authorization: `Bearer ${API_TOKEN}` }

    const archived = await fetch(`${address.url}/v1/sessions/${pm.sessionId}/archive`, { method: 'POST', headers: auth })
    expect(archived.status).toBe(200)
    expect(control.session(pm.sessionId)).toMatchObject({ status: 'archived', archivedAt: expect.any(String) })
    expect(control.store.get(KV.control.session(pm.sessionId))).toMatchObject({ status: 'archived' })
    const read = await fetch(`${address.url}/v1/sessions/${pm.sessionId}`, { headers: auth })
    expect(((await read.json()) as { session: { status: string } }).session.status).toBe('archived')
  })

  it('fails startup and closes both halves when node registration fails', async () => {
    prepare()
    const node: NodePort = {
      async send() { throw new Error('registration refused') },
      subscribe() { return () => {} },
      async inspect(sessionId) { return { sessionId, found: false } },
    }
    const closeControl = vi.spyOn(ControlPlane.prototype, 'close')
    const closeServer = vi.spyOn(ControlPlaneServer.prototype, 'close')
    const env = {
      SUPERAGENT_CONTROL_TOKEN: API_TOKEN,
      SUPERAGENT_CONTROL_DB: join(directory, 'startup', 'control.sqlite'),
      SUPERAGENT_WORKSPACE_ROOT: join(directory, 'workspaces'),
      SUPERAGENT_NODE_ID: 'local',
      SUPERAGENT_CONTROL_PORT: '0',
    }

    await expect(startControlPlane({ env, node })).rejects.toThrow(/registration refused/)
    expect(closeControl).toHaveBeenCalled()
    expect(closeServer).toHaveBeenCalled()
  })

  it('listens only after a successful node registration', async () => {
    prepare()
    const node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START })
    const env = {
      SUPERAGENT_CONTROL_TOKEN: API_TOKEN,
      SUPERAGENT_CONTROL_DB: join(directory, 'startup', 'control.sqlite'),
      SUPERAGENT_WORKSPACE_ROOT: join(directory, 'startup', 'workspaces'),
      SUPERAGENT_NODE_ID: 'local',
      SUPERAGENT_CONTROL_PORT: '0',
    }
    const started = await startControlPlane({ env, node })
    try {
      expect(started.address.port).toBeGreaterThan(0)
      const health = await fetch(`${started.address.url}/health`)
      expect(health.status).toBe(200)
      expect(node.registrations).toHaveLength(1)
    } finally {
      await started.close()
    }
  })
})
