/**
 * One simulated DSH chain: a PM creates a Ticket through the tool API, NodeExecutor starts its Worker,
 * and the Worker reports back through its own tool API onto the same Ticket and Assignment.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const SECRET = 'e2e-secret'
const API_TOKEN = 'e2e-api-token'
const START = '2026-01-01T00:00:00.000Z'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function post(url: string, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function open(): Promise<{ url: string; projectId: string; pmSessionId: string }> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-e2e-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: 'local', root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
  await control.registerNode()
  control.store.triggers.save(trigger())
  const project = control.createProject('trigger-1', 'Project', 'Project goal')
  const pm = await control.openProject(project.id)
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  const address = await server.listen(0)
  return { url: address.url, projectId: project.id, pmSessionId: pm.sessionId }
}

function tokenOf(sessionId: string): string {
  const token = node.tokens.get(sessionId)
  if (!token) throw new Error(`No token for ${sessionId}`)
  return token
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('simulated DSH chain', () => {
  it('PM ticket → NodeExecutor Worker → Worker report on the same Ticket and Assignment', async () => {
    const { url, projectId, pmSessionId } = await open()
    const pmToken = tokenOf(pmSessionId)

    const created = await post(url, '/v1/tools/pm/tickets', pmToken, { tasks: [
      { title: 'Ship it', goal: 'Ship the feature', scope: 'only the API', note: 'keep it small' },
    ] })
    expect(created.status).toBe(200)
    const body = (await created.json()) as { tickets: { id: string }[] }
    const ticketId = body.tickets[0]!.id

    await until(() => {
      const ticket = control!.store.tickets.get(ticketId)
      return ticket?.assignments.at(-1)?.state === 'running'
    }, 'the Worker Assignment did not start')
    const ticket = control!.store.tickets.get(ticketId)!
    const assignment = ticket.assignments.at(-1)!
    expect(ticket.projectId).toBe(projectId)
    expect(assignment.state).toBe('running')
    const workerSessionId = `worker-${assignment.id}`
    expect(node.sessions.get(workerSessionId)?.status).toBe('idle')
    const create = node.commands.find(command => command.type === 'worker.create' && command.assignmentId === assignment.id)
    expect(create).toMatchObject({ type: 'worker.create' })
    if (create?.type === 'worker.create') {
      expect(create.prompt).toContain('Ticket: Ship it')
      expect(create.prompt).toContain('Goal: Ship the feature')
      expect(create.prompt).toContain('Scope: only the API')
      expect(create.prompt).toContain('Note: keep it small')
    }

    const workerToken = tokenOf(workerSessionId)
    const reported = await post(url, '/v1/tools/worker/report', workerToken, { ticketId, assignmentId: assignment.id,
      report: { state: 'ready', summary: 'done' } })
    expect(reported.status).toBe(200)
    const after = control!.store.tickets.get(ticketId)!
    expect(after.assignments.at(-1)?.report).toMatchObject({ state: 'ready', summary: 'done' })
    expect(after.ended?.outcome).toBe('completed')
    expect(after.assignments.at(-1)?.id).toBe(assignment.id)
  })

  it('refuses a report from another Assignment and leaves the Ticket unchanged', async () => {
    const { url, pmSessionId } = await open()
    const created = await post(url, '/v1/tools/pm/tickets', tokenOf(pmSessionId), { tasks: [
      { title: 'Ship it', goal: 'Ship the feature' },
    ] })
    const { tickets } = (await created.json()) as { tickets: { id: string }[] }
    const ticketId = tickets[0]!.id
    await until(() => control!.store.tickets.get(ticketId)?.assignments.at(-1)?.state === 'running', 'worker start')
    const assignment = control!.store.tickets.get(ticketId)!.assignments.at(-1)!
    const workerToken = tokenOf(`worker-${assignment.id}`)

    const refused = await post(url, '/v1/tools/worker/report', workerToken, { ticketId, assignmentId: 'other',
      report: { state: 'ready', summary: 'wrong' } })
    expect([400, 403]).toContain(refused.status)
    expect(control!.store.tickets.get(ticketId)?.ended).toBeUndefined()
    expect(control!.store.tickets.get(ticketId)?.assignments.at(-1)?.report).toBeUndefined()
  })
})
