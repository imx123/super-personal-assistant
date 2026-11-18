/**
 * The control plane's audit trail.
 *
 * It records what really happened — a Project that was created, a Ticket the PM dispatched, an Assignment that started,
 * a Worker that reported, a PM that accepted, a node that came or went — so the console's activity list shows facts and
 * not decoration. It never holds a token, a raw diff or the body of a request.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const SECRET = 'audit-test-secret'
const API_TOKEN = 'audit-api-token'
const START = '2026-01-01T00:00:00.000Z'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A control plane on an empty database, with its node registered. */
async function open(): Promise<ControlPlane> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-audit-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: 'local', root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
  await control.registerNode()
  return control
}

/** The token of one Session. */
function tokenOf(sessionId: string): string {
  const token = node.tokens.get(sessionId)
  if (!token) throw new Error(`No token for ${sessionId}`)
  return token
}

/** One request to the control plane with a Session token. */
function post(url: string, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('control-plane audit trail', () => {
  it('records the project, the dispatch, the report, the review and the node', async () => {
    const plane = await open()
    server = new ControlPlaneServer(plane, { token: API_TOKEN })
    const address = await server.listen(0)

    // The node registered itself: its liveness is a fact worth keeping.
    expect(plane.auditEntries({ kind: 'node' }).map(entry => entry.action)).toContain('online')

    const project = plane.createProjectFromOperator('A project', 'Do the work')
    expect(plane.auditEntries({ kind: 'project' }).map(entry => entry.action)).toContain('created')

    const pm = await plane.openProject(project.id)
    expect(plane.auditEntries({ kind: 'project' }).map(entry => entry.action)).toContain('pm-ready')

    const created = await post(address.url, '/v1/tools/pm/tickets', tokenOf(pm.sessionId), { tasks: [
      { title: 'Ship it', goal: 'Ship the feature' },
    ] })
    expect(created.status).toBe(200)
    const { tickets } = (await created.json()) as { tickets: { id: string }[] }
    const ticketId = tickets[0]!.id
    expect(plane.auditEntries({ kind: 'ticket' }).map(entry => entry.action)).toContain('created')

    await until(() => plane.store.tickets.get(ticketId)?.assignments.at(-1)?.state === 'running', 'the worker start')
    const assignment = plane.store.tickets.get(ticketId)!.assignments.at(-1)!
    const assignmentEntries = plane.auditEntries({ kind: 'assignment' })
    expect(assignmentEntries.map(entry => entry.action)).toContain('started')
    expect(assignmentEntries[0]!.targetId).toBe(assignment.id)

    const workerSessionId = `worker-${assignment.id}`
    const reported = await post(address.url, '/v1/tools/worker/report', tokenOf(workerSessionId),
      { ticketId, assignmentId: assignment.id, report: { state: 'ready', summary: 'done' } })
    expect(reported.status).toBe(200)
    const reports = plane.auditEntries({ kind: 'report' })
    expect(reports.map(entry => entry.action)).toContain('ready')
    expect(reports[0]!.actor).toBe('worker')

    const review = plane.store.tickets.get(ticketId)!.reviews!.at(-1)!
    const accepted = await post(address.url, '/v1/tools/pm/review', tokenOf(pm.sessionId),
      { ticketId, assignmentId: assignment.id, reviewId: review.id, action: 'accept' })
    expect(accepted.status).toBe(200)
    const reviews = plane.auditEntries({ kind: 'review' })
    expect(reviews.map(entry => entry.action)).toContain('accepted')
    expect(reviews[0]!.actor).toBe('pm')

    // The trail holds facts, not credentials.
    const whole = JSON.stringify(plane.auditEntries({ limit: 200 }))
    expect(whole).not.toContain(SECRET)
    expect(whole).not.toContain(API_TOKEN)
    expect(whole).not.toContain(tokenOf(pm.sessionId))
    expect(whole).not.toContain(tokenOf(workerSessionId))
  })

  it('keeps the trail across a restart of the control plane', async () => {
    const plane = await open()
    plane.createProjectFromOperator('A project', 'Do the work')
    const before = plane.auditEntries({ limit: 100 })
    expect(before.length).toBeGreaterThan(0)

    await plane.close()
    control = undefined

    const root = join(directory, 'workspaces')
    const restarted = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local',
      node: new FakeNode({ nodeId: 'local', root, now: () => START }), secret: SECRET, workspaceRoot: root,
      now: () => START, confirmationTimeoutMs: 50 })
    control = restarted
    const after = restarted.auditEntries({ limit: 100 })
    expect(after.length).toBe(before.length)
    expect(after[0]!.seq).toBe(before[0]!.seq)
  })

  it('answers the audit route with the newest entries first and refuses an impossible limit', async () => {
    const plane = await open()
    plane.createProjectFromOperator('A project', 'Do the work')
    plane.createProjectFromOperator('Another project', 'Do more work')
    server = new ControlPlaneServer(plane, { token: API_TOKEN })
    const address = await server.listen(0)

    const read = await fetch(`${address.url}/v1/audit?limit=2`, { headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(read.status).toBe(200)
    const { entries } = (await read.json()) as { entries: { seq: number }[] }
    expect(entries.length).toBe(2)
    expect(entries[0]!.seq).toBeGreaterThan(entries[1]!.seq)

    const refused = await fetch(`${address.url}/v1/audit?limit=abc`, { headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(refused.status).toBe(400)
    const unauthorized = await fetch(`${address.url}/v1/audit`)
    expect(unauthorized.status).toBe(401)
  })
})
