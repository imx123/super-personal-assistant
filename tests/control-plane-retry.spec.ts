import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { KV } from '../src/kv.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { type NodeCommand, type NodeEvent, type NodePort } from '../src/shared/protocol.ts'
import { verifySessionToken } from '../src/shared/session-token.ts'

const SECRET = 'control-retry-secret'
const API_TOKEN = 'control-retry-api-token'
const START = '2026-01-01T00:00:00.000Z'
const NEXT = '2026-01-01T00:00:01.000Z'

let directory = ''
let clock = START
let node: FakeNode
let flaky: FlakyNode
let control: ControlPlane
let server: ControlPlaneServer | undefined

function now(): string {
  return clock
}

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

/**
 * A NodePort that fails one command type a fixed number of times before delegating. It fails before the
 * inner node sees the command, which is how a transport error looks to the control plane.
 */
class FlakyNode implements NodePort {
  private remaining: number
  /** Every command the control plane attempted, including the one this node refused. */
  readonly attempts: NodeCommand[] = []

  constructor(private readonly inner: FakeNode, private readonly failType?: NodeCommand['type'], failures = 1) {
    this.remaining = failures
  }

  async send(command: NodeCommand): Promise<void> {
    this.attempts.push(command)
    if (command.type === this.failType && this.remaining > 0) {
      this.remaining -= 1
      throw new Error(`injected ${command.type} failure`)
    }
    await this.inner.send(command)
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }
}

function setup(failType?: NodeCommand['type']): void {
  directory = mkdtempSync(join(tmpdir(), 'superagent-control-retry-'))
  clock = START
  node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now })
  flaky = new FlakyNode(node, failType)
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node: flaky,
    secret: SECRET, workspaceRoot: join(directory, 'workspaces'), now })
}

function saveProject(): ReturnType<ControlPlane['createProject']> {
  control.store.triggers.save(trigger())
  return control.createProject('trigger-1', 'Project', 'Goal')
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane retries and command keys', () => {
  it('retries a failed PM ensure instead of returning the failed record', async () => {
    setup('pm.ensure')
    await control.registerNode()
    const project = saveProject()
    const sessionId = project.pmSessionId

    await expect(control.openProject(project.id)).rejects.toThrow(/injected pm\.ensure failure/)
    expect(control.session(sessionId)).toMatchObject({ status: 'failed', createdAt: START, updatedAt: START })
    expect(control.store.get(KV.control.session(sessionId))).toMatchObject({ status: 'failed' })
    expect(node.sessions.has(sessionId)).toBe(false)

    clock = NEXT
    const pm = await control.openProject(project.id)
    expect(pm.sessionId).toBe(sessionId)
    expect(pm.status).toBe('idle')
    expect(pm.createdAt).toBe(START)
    expect(pm.updatedAt).toBe(NEXT)
    expect(control.session(sessionId)).toMatchObject({ status: 'idle' })
    expect(control.store.get(KV.control.session(sessionId))).toMatchObject({ status: 'idle', createdAt: START, updatedAt: NEXT })
    expect(node.sessions.get(sessionId)?.status).toBe('idle')

    const token = node.tokens.get(sessionId)
    expect(token).toBeTruthy()
    expect(verifySessionToken(token!, SECRET)).toMatchObject({ sid: sessionId, pid: project.id, role: 'pm' })
    expect(JSON.stringify(control.store.get(KV.control.session(sessionId)))).not.toContain(token!)

    // The failed attempt never reached the node; the retry re-runs setup and ensure under fresh keys, because a node
    // acknowledges a completed key without emitting the Session's status a second time.
    const workspaces = node.commands.filter((command): command is Extract<NodeCommand, { type: 'workspace.ensure' }> =>
      command.type === 'workspace.ensure')
    const binds = node.commands.filter((command): command is Extract<NodeCommand, { type: 'project.bind' }> =>
      command.type === 'project.bind')
    expect(workspaces).toHaveLength(2)
    expect(binds).toHaveLength(2)
    expect(new Set(workspaces.map(command => command.idempotencyKey)).size).toBe(2)
    expect(new Set(binds.map(command => command.idempotencyKey)).size).toBe(2)
    const ensures = node.commands.filter((command): command is Extract<NodeCommand, { type: 'pm.ensure' }> => command.type === 'pm.ensure')
    expect(ensures).toHaveLength(1)
    expect(ensures[0]!.idempotencyKey.startsWith(`pm-ensure-confirm:${project.id}:`)).toBe(true)
    const attempts = flaky.attempts.filter((command): command is Extract<NodeCommand, { type: 'pm.ensure' }> =>
      command.type === 'pm.ensure')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.idempotencyKey).toBe(`pm-ensure:${project.id}`)
    expect(attempts[1]!.idempotencyKey).not.toBe(attempts[0]!.idempotencyKey)
  })

  it('retries a failed worker create instead of returning the failed record', async () => {
    setup('worker.create')
    await control.registerNode()
    const project = saveProject()
    const pm = await control.openProject(project.id)
    expect(pm.status).toBe('idle')
    const sessionId = 'worker-assignment-1'

    await expect(control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work'))
      .rejects.toThrow(/injected worker\.create failure/)
    expect(control.session(sessionId)).toMatchObject({ status: 'failed', createdAt: START, updatedAt: START })
    expect(control.store.get(KV.control.session(sessionId))).toMatchObject({ status: 'failed' })
    expect(node.sessions.has(sessionId)).toBe(false)

    clock = NEXT
    const worker = await control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    expect(worker.sessionId).toBe(sessionId)
    expect(worker.status).toBe('idle')
    expect(worker.createdAt).toBe(START)
    expect(worker.updatedAt).toBe(NEXT)
    expect(control.store.get(KV.control.session(sessionId))).toMatchObject({ status: 'idle', updatedAt: NEXT })
    expect(node.sessions.get(sessionId)).toMatchObject({ role: 'worker', assignmentId: 'assignment-1', status: 'idle' })
    expect(verifySessionToken(node.tokens.get(sessionId)!, SECRET)).toMatchObject({ sid: sessionId, aid: 'assignment-1', role: 'worker' })

    const creates = node.commands.filter((command): command is Extract<NodeCommand, { type: 'worker.create' }> => command.type === 'worker.create')
    expect(creates).toHaveLength(1)
    expect(creates[0]!.idempotencyKey.startsWith('worker-create-confirm:assignment-1:')).toBe(true)
    const attempts = flaky.attempts.filter((command): command is Extract<NodeCommand, { type: 'worker.create' }> =>
      command.type === 'worker.create')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.idempotencyKey).toBe('worker-create:assignment-1')
    expect(attempts[1]!.idempotencyKey).not.toBe(attempts[0]!.idempotencyKey)
  })

  it('gives every message and heartbeat a distinct key on a fixed clock', async () => {
    setup()
    await control.registerNode()
    const project = saveProject()
    const pm = await control.openProject(project.id)
    clock = START

    await control.sendMessage(pm.sessionId, 'a')
    await control.sendMessage(pm.sessionId, 'b')
    expect(node.messages.get(pm.sessionId)).toEqual(['a', 'b'])
    const sent = node.commands.filter((command): command is Extract<NodeCommand, { type: 'session.message' }> => command.type === 'session.message')
    expect(sent).toHaveLength(2)
    expect(new Set(sent.map(command => command.idempotencyKey)).size).toBe(2)

    await control.heartbeat()
    await control.heartbeat()
    const beats = node.commands.filter((command): command is Extract<NodeCommand, { type: 'node.heartbeat' }> => command.type === 'node.heartbeat')
    expect(beats).toHaveLength(2)
    expect(new Set(beats.map(command => command.idempotencyKey)).size).toBe(2)
  })

  it('answers 500/502 for a failed PM request and 200 once the node recovers', async () => {
    setup('pm.ensure')
    await control.registerNode()
    const project = saveProject()
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)
    const auth = { authorization: `Bearer ${API_TOKEN}` }
    const path = `${address.url}/v1/projects/${project.id}/pm`

    const refused = await fetch(path, { method: 'POST', headers: auth })
    expect(refused.status).not.toBe(200)
    expect([500, 502]).toContain(refused.status)
    expect(typeof ((await refused.json()) as { error?: unknown }).error).toBe('string')
    expect(control.session(project.pmSessionId)?.status).toBe('failed')
    expect(node.sessions.has(project.pmSessionId)).toBe(false)

    clock = NEXT
    const retried = await fetch(path, { method: 'POST', headers: auth })
    expect(retried.status).toBe(200)
    const body = (await retried.json()) as { session: { sessionId: string; status: string } }
    expect(body.session).toMatchObject({ sessionId: project.pmSessionId, status: 'idle' })
    expect(node.sessions.get(project.pmSessionId)?.status).toBe('idle')
    expect(JSON.stringify(body)).not.toContain(node.tokens.get(project.pmSessionId)!)
  })

  it('never answers 200 for a Session the control plane reports failed', async () => {
    setup()
    await control.registerNode()
    const project = saveProject()
    const pm = await control.openProject(project.id)
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)
    const auth = { authorization: `Bearer ${API_TOKEN}` }
    const path = `${address.url}/v1/projects/${project.id}/pm`

    const failed = vi.spyOn(control, 'openProject').mockResolvedValue({ ...pm, status: 'failed' })
    try {
      const refused = await fetch(path, { method: 'POST', headers: auth })
      expect(refused.status).toBe(502)
      expect(await refused.json()).toEqual({ error: 'The node could not create the PM Session' })
    } finally {
      failed.mockRestore()
    }

    expect((await fetch(path, { method: 'POST', headers: auth })).status).toBe(200)
  })
})
