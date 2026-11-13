import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { KV } from '../src/kv.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeEvent, type NodePort } from '../src/shared/protocol.ts'
import { verifySessionToken } from '../src/shared/session-token.ts'

const SECRET = 'control-lost-ack-secret'
const API_TOKEN = 'control-lost-ack-api-token'
const START = '2026-01-01T00:00:00.000Z'
const NEXT = '2026-01-01T00:00:01.000Z'

let directory = ''
let clock = START
let server: ControlPlaneServer | undefined
const opened: ControlPlane[] = []

function now(): string {
  return clock
}

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

function prepare(): void {
  directory = mkdtempSync(join(tmpdir(), 'superagent-control-lost-ack-'))
  clock = START
}

function makeNode(): FakeNode {
  return new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now })
}

function openControl(node: NodePort): ControlPlane {
  const control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node,
    secret: SECRET, workspaceRoot: join(directory, 'workspaces'), now })
  opened.push(control)
  return control
}

function saveProject(control: ControlPlane): ReturnType<ControlPlane['createProject']> {
  control.store.triggers.save(trigger())
  return control.createProject('trigger-1', 'Project', 'Goal')
}

/**
 * A node that executes the command and emits its Session status first, then loses the acknowledgement. This is the
 * order a real transport produces when the response is dropped after the node already committed the command.
 */
class LostAckNode implements NodePort {
  readonly commands: NodeCommand[] = []
  private remaining: number

  constructor(private readonly inner: FakeNode, private readonly failType: NodeCommand['type'], failures = 1) {
    this.remaining = failures
  }

  async send(command: NodeCommand): Promise<void> {
    this.commands.push(command)
    if (command.type === this.failType && this.remaining > 0) {
      this.remaining -= 1
      await this.inner.send(command)
      throw new Error(`lost ${command.type} acknowledgement`)
    }
    await this.inner.send(command)
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }
}

/** A node that rejects the command before executing it, so no status event can exist. */
class RefusedNode implements NodePort {
  readonly commands: NodeCommand[] = []
  private remaining: number

  constructor(private readonly inner: FakeNode, private readonly failType: NodeCommand['type'], failures = 1) {
    this.remaining = failures
  }

  async send(command: NodeCommand): Promise<void> {
    this.commands.push(command)
    if (command.type === this.failType && this.remaining > 0) {
      this.remaining -= 1
      throw new Error(`refused ${command.type}`)
    }
    await this.inner.send(command)
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }
}

/** A node that reports the Session failed while executing the command, then loses its acknowledgement. */
class FailedStatusNode implements NodePort {
  readonly commands: NodeCommand[] = []
  private readonly listeners = new Set<(event: NodeEvent) => void>()
  private seq = 0

  subscribe(listener: (event: NodeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async send(command: NodeCommand): Promise<void> {
    this.commands.push(command)
    if (command.type === 'session.inspect') throw new Error('inspection unsupported')
    if (command.type !== 'pm.ensure') return
    const event: NodeEvent = {
      protocolVersion: NODE_PROTOCOL_VERSION,
      nodeId: 'local',
      sessionId: command.sessionId,
      projectId: command.project.id,
      role: 'pm',
      seq: ++this.seq,
      at: now(),
      type: 'session.status',
      status: 'failed',
    }
    for (const listener of [...this.listeners]) listener(event)
    throw new Error('lost failed-status acknowledgement')
  }
}

function pmEnsures(node: { commands: NodeCommand[] }): Extract<NodeCommand, { type: 'pm.ensure' }>[] {
  return node.commands.filter((command): command is Extract<NodeCommand, { type: 'pm.ensure' }> =>
    command.type === 'pm.ensure')
}

function workerCreates(node: { commands: NodeCommand[] }): Extract<NodeCommand, { type: 'worker.create' }>[] {
  return node.commands.filter((command): command is Extract<NodeCommand, { type: 'worker.create' }> =>
    command.type === 'worker.create')
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  for (const control of opened.splice(0)) await control.close().catch(() => {})
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane lost ensure acknowledgements', () => {
  it('returns the idle PM Session a node reported before its ensure acknowledgement was lost', async () => {
    prepare()
    const inner = makeNode()
    const node = new LostAckNode(inner, 'pm.ensure')
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)

    const pm = await control.openProject(project.id)

    expect(pm).toMatchObject({ sessionId: project.pmSessionId, status: 'idle' })
    expect(control.session(project.pmSessionId)?.status).toBe('idle')
    expect(control.store.get(KV.control.session(project.pmSessionId))).toMatchObject({ status: 'idle' })
    expect(inner.sessions.get(project.pmSessionId)).toMatchObject({ status: 'idle', role: 'pm' })
    expect(verifySessionToken(inner.tokens.get(project.pmSessionId)!, SECRET)).toMatchObject({
      sid: project.pmSessionId, pid: project.id, role: 'pm' })
    expect(pmEnsures(node)).toHaveLength(1)
  })

  it('fails a PM ensure that produced no node status, then retries with a fresh key', async () => {
    prepare()
    const inner = makeNode()
    const node = new RefusedNode(inner, 'pm.ensure')
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)

    await expect(control.openProject(project.id)).rejects.toThrow(/refused pm\.ensure/)
    expect(control.session(project.pmSessionId)).toMatchObject({ status: 'failed' })
    expect(control.store.get(KV.control.session(project.pmSessionId))).toMatchObject({ status: 'failed' })
    expect(inner.sessions.has(project.pmSessionId)).toBe(false)

    clock = NEXT
    const pm = await control.openProject(project.id)

    const attempts = pmEnsures(node)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.idempotencyKey).toBe(`pm-ensure:${project.id}`)
    expect(attempts[1]!.idempotencyKey).not.toBe(attempts[0]!.idempotencyKey)
    expect(attempts[1]!.idempotencyKey.startsWith(`pm-ensure-confirm:${project.id}:`)).toBe(true)
    expect(pm.status).toBe('idle')
    expect(control.session(project.pmSessionId)?.status).toBe('idle')
    expect(control.store.get(KV.control.session(project.pmSessionId))).toMatchObject({
      status: 'idle', createdAt: START, updatedAt: NEXT })
    expect(inner.sessions.get(project.pmSessionId)?.status).toBe('idle')
  })

  it('reconfirms a persisted starting record instead of returning it', async () => {
    prepare()
    const inner = makeNode()
    const first = openControl(inner)
    await first.registerNode()
    const project = saveProject(first)
    const pm = await first.openProject(project.id)
    expect(pm.status).toBe('idle')

    // The exact database state the old lost-ack bug left behind: record starting, node Session idle.
    first.store.set(KV.control.session(pm.sessionId), { ...pm, status: 'starting', updatedAt: START })
    await first.close()
    clock = NEXT

    const second = openControl(inner)
    expect(second.session(pm.sessionId)?.status).toBe('starting')
    const confirmed = await second.openProject(project.id)

    expect(confirmed.status).toBe('idle')
    expect(second.session(pm.sessionId)?.status).toBe('idle')
    expect(second.store.get(KV.control.session(pm.sessionId))).toMatchObject({ status: 'idle' })
    // The persisted record is `starting`, but the node knows the Session is idle: the explicit inspection settles it
    // without a second ensure, because a repeated command would be acknowledged without a fresh status event.
    const ensures = pmEnsures(inner)
    expect(ensures).toHaveLength(1)
    expect(ensures[0]!.idempotencyKey).toBe(`pm-ensure:${project.id}`)
    expect(inner.sessions.get(pm.sessionId)?.status).toBe('idle')
  })

  it('answers 200 for a PM Session that is idle despite the lost acknowledgement', async () => {
    prepare()
    const inner = makeNode()
    const node = new LostAckNode(inner, 'pm.ensure')
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)

    const response = await fetch(`${address.url}/v1/projects/${project.id}/pm`, { method: 'POST',
      headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { session: { sessionId: string; status: string } }
    expect(body.session).toMatchObject({ sessionId: project.pmSessionId, status: 'idle' })
    expect(control.store.get(KV.control.session(project.pmSessionId))).toMatchObject({ status: 'idle' })
    expect(inner.sessions.has(project.pmSessionId)).toBe(true)
  })

  it('keeps a node-reported failed PM status instead of overwriting it with the lost command error', async () => {
    prepare()
    const node = new FailedStatusNode()
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)

    const pm = await control.openProject(project.id)

    expect(pm.status).toBe('failed')
    expect(control.session(project.pmSessionId)?.status).toBe('failed')
    expect(control.store.get(KV.control.session(project.pmSessionId))).toMatchObject({ status: 'failed' })
  })

  it('answers 502 when the PM record is failed', async () => {
    prepare()
    const node = new FailedStatusNode()
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)

    const response = await fetch(`${address.url}/v1/projects/${project.id}/pm`, { method: 'POST',
      headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'The node could not create the PM Session' })
    expect(control.store.get(KV.control.session(project.pmSessionId))).toMatchObject({ status: 'failed' })
  })

  it('returns the idle worker Session a node reported before its create acknowledgement was lost', async () => {
    prepare()
    const inner = makeNode()
    const node = new LostAckNode(inner, 'worker.create')
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    await control.openProject(project.id)

    const worker = await control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')

    expect(worker).toMatchObject({ sessionId: 'worker-assignment-1', status: 'idle' })
    expect(control.store.get(KV.control.session(worker.sessionId))).toMatchObject({ status: 'idle' })
    expect(inner.sessions.get(worker.sessionId)).toMatchObject({ status: 'idle', role: 'worker',
      assignmentId: 'assignment-1' })
    expect(verifySessionToken(inner.tokens.get(worker.sessionId)!, SECRET)).toMatchObject({
      sid: worker.sessionId, aid: 'assignment-1', role: 'worker' })
  })

  it('retries a refused worker create with a fresh key', async () => {
    prepare()
    const inner = makeNode()
    const node = new RefusedNode(inner, 'worker.create')
    const control = openControl(node)
    await control.registerNode()
    const project = saveProject(control)
    await control.openProject(project.id)

    await expect(control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work'))
      .rejects.toThrow(/refused worker\.create/)
    expect(control.session('worker-assignment-1')).toMatchObject({ status: 'failed' })
    expect(inner.sessions.has('worker-assignment-1')).toBe(false)

    clock = NEXT
    const worker = await control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    const attempts = workerCreates(node)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.idempotencyKey).toBe('worker-create:assignment-1')
    expect(attempts[1]!.idempotencyKey.startsWith('worker-create-confirm:assignment-1:')).toBe(true)
    expect(attempts[1]!.idempotencyKey).not.toBe(attempts[0]!.idempotencyKey)
    expect(worker).toMatchObject({ status: 'idle', createdAt: START, updatedAt: NEXT })
    expect(control.store.get(KV.control.session('worker-assignment-1'))).toMatchObject({ status: 'idle' })
    expect(inner.sessions.get('worker-assignment-1')?.status).toBe('idle')
  })
})
