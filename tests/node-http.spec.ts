import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { HttpNodePort } from '../src/control/http-node.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { startNodeHttpServer } from '../src/node/http-server.ts'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeEvent } from '../src/shared/protocol.ts'

const NODE_TOKEN = 'node-http-test-token'
const CONTROL_SECRET = 'control-http-test-secret'
const NOW = '2026-01-01T00:00:00.000Z'

let directory = ''
let node: FakeNode
let server: Awaited<ReturnType<typeof startNodeHttpServer>>
let control: ControlPlane
const unsubscribes: (() => void)[] = []

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: NOW, text: 'Build it', meta: {} }
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

/** Send heartbeats until every stream saw one: after that the SSE connections are open and later events cannot be missed. */
async function warmUp(...streams: NodeEvent[][]): Promise<void> {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    await control.heartbeat()
    await sleep(30)
    if (streams.every(events => events.length > 0)) return
  }
  throw new Error('the node event streams did not open')
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-node-http-'))
  node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces') })
  server = await startNodeHttpServer({ node, token: NODE_TOKEN, port: 0 })
  const port = new HttpNodePort({ url: server.url, token: NODE_TOKEN })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node: port, secret: CONTROL_SECRET,
    workspaceRoot: join(directory, 'workspaces') })
  await control.registerNode()
})

afterEach(async () => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
  await control?.close().catch(() => {})
  await server?.close().catch(() => {})
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('node HTTP transport', () => {
  it('drives the PM and Worker lifecycle over HTTP and streams the node events back over SSE', async () => {
    const events: NodeEvent[] = []
    const client = new HttpNodePort({ url: server.url, token: NODE_TOKEN })
    unsubscribes.push(client.subscribe(event => events.push(event)))
    await warmUp(events)

    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    const pm = await control.openProject(project.id)

    expect(pm.sessionId).toBe(project.pmSessionId)
    expect(node.sessions.get(pm.sessionId)).toMatchObject({ projectId: project.id, role: 'pm', nodeId: 'local', status: 'idle' })
    expect(node.sessions.get(pm.sessionId)?.workspace).toBe(pm.workspace)

    await control.sendMessage(pm.sessionId, 'hello over HTTP')
    expect(node.messages.get(pm.sessionId)).toEqual(['hello over HTTP'])

    const worker = await control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    expect(node.sessions.get(worker.sessionId)).toMatchObject({ role: 'worker', assignmentId: 'assignment-1', status: 'idle' })

    await control.cancelSession(worker.sessionId, 'test done')
    expect(node.sessions.get(worker.sessionId)?.status).toBe('stopped')
    await control.archiveSession(worker.sessionId)
    expect(node.sessions.get(worker.sessionId)?.status).toBe('archived')
    expect(node.sessions.get(worker.sessionId)?.archivedAt).toBeTruthy()

    await waitFor(() => events.some(event => event.type === 'session.status' && event.status === 'archived'))
    await waitFor(() => control.session(worker.sessionId)?.status === 'archived')
    await expect(control.sendMessage(worker.sessionId, 'too late')).rejects.toThrow(/not running/)

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'session.status', sessionId: pm.sessionId, status: 'running' }),
      expect.objectContaining({ type: 'session.event', sessionId: pm.sessionId, kind: 'message',
        data: { text: 'hello over HTTP' } }),
      expect.objectContaining({ type: 'session.status', sessionId: worker.sessionId, status: 'stopped' }),
      expect.objectContaining({ type: 'session.status', sessionId: worker.sessionId, status: 'archived' }),
    ]))
    const seqs = events.map(event => event.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
  })

  it('requires the node token and rejects malformed or invalid commands with 400', async () => {
    const command: NodeCommand = { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: 'local', idempotencyKey: 'unauthorized-cancel',
      at: NOW, type: 'session.cancel', sessionId: 'missing' }
    const auth = { authorization: `Bearer ${NODE_TOKEN}`, 'content-type': 'application/json' }

    const anonymous = await fetch(`${server.url}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command) })
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ error: expect.any(String) })

    const wrong = await fetch(`${server.url}/commands`, { method: 'POST', headers: { ...auth, authorization: 'Bearer wrong' },
      body: JSON.stringify(command) })
    expect(wrong.status).toBe(401)
    expect((await fetch(`${server.url}/events`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(`${server.url}/health`)).status).toBe(200)

    const malformed = await fetch(`${server.url}/commands`, { method: 'POST', headers: auth, body: '{' })
    expect(malformed.status).toBe(400)
    const wrongVersion = await fetch(`${server.url}/commands`, { method: 'POST', headers: auth,
      body: JSON.stringify({ ...command, protocolVersion: 99 }) })
    expect(wrongVersion.status).toBe(400)
    const rejected = await fetch(`${server.url}/commands`, { method: 'POST', headers: auth,
      body: JSON.stringify({ ...command, idempotencyKey: 'unknown-session-message', type: 'session.message', text: 'hello' }) })
    expect(rejected.status).toBe(400)

    expect(node.commands.some(entry => entry.idempotencyKey === command.idempotencyKey)).toBe(false)
    expect(node.commands.some(entry => entry.idempotencyKey === 'unknown-session-message')).toBe(true)
    expect(node.registrations).toHaveLength(1)
  })

  it('fans events out to every listener and stops delivery after unsubscribe', async () => {
    const first = new HttpNodePort({ url: server.url, token: NODE_TOKEN })
    const second = new HttpNodePort({ url: server.url, token: NODE_TOKEN })
    const firstEvents: NodeEvent[] = []
    const secondEvents: NodeEvent[] = []
    const unsubscribeFirst = first.subscribe(event => firstEvents.push(event))
    const unsubscribeSecond = second.subscribe(event => secondEvents.push(event))
    unsubscribes.push(unsubscribeFirst, unsubscribeSecond)

    await warmUp(firstEvents, secondEvents)
    expect(firstEvents.length).toBeGreaterThan(0)
    expect(secondEvents.length).toBeGreaterThan(0)

    const firstBefore = firstEvents.length
    const secondBefore = secondEvents.length
    await control.heartbeat()
    await waitFor(() => firstEvents.length > firstBefore && secondEvents.length > secondBefore)
    expect(firstEvents.at(-1)).toMatchObject({ type: 'node.status' })
    expect(secondEvents.at(-1)).toMatchObject({ type: 'node.status' })

    unsubscribeFirst()
    unsubscribeSecond()
    await sleep(150)
    const firstAfter = firstEvents.length
    const secondAfter = secondEvents.length
    await control.heartbeat()
    await sleep(250)
    expect(firstEvents).toHaveLength(firstAfter)
    expect(secondEvents).toHaveLength(secondAfter)
  })
})
