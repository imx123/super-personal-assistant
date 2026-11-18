/**
 * The reconciliation of the Assignments against the Sessions the node really holds.
 *
 * The reconciler cleans up only what it can prove: a Worker the node confirms is still running although its Assignment
 * is over. Everything else is reported and left alone — a Worker the node does not have, a Session whose creation is
 * still in flight, and every Session of a node that cannot be reached.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const SECRET = 'reconcile-secret'
const API_TOKEN = 'reconcile-api-token'
const START = '2026-01-01T00:00:00.000Z'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode
let address = { url: '', port: 0 }

function post(path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${API_TOKEN}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function get(path: string): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${API_TOKEN}` } })
}

/** Wait for a fact to become true. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A control plane with a node, listening on a random port. */
async function open(): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-reconcile-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: 'local', root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  address = await server.listen(0)
}

/** A Project with its PM and one Ticket whose Worker Session runs. */
async function projectWithWorker(): Promise<
  { projectId: string; pmSessionId: string; ticketId: string; assignmentId: string }> {
  const created = await post('/v1/console/projects', { title: '对账项目', goal: '把工作做完' })
  const { project } = (await created.json()) as { project: { id: string } }
  const pm = await post(`/v1/projects/${project.id}/pm`)
  const { session } = (await pm.json()) as { session: { sessionId: string } }
  const tickets = await fetch(`${address.url}/v1/tools/pm/tickets`, { method: 'POST',
    headers: { authorization: `Bearer ${tokenOf(session.sessionId)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: [{ title: '做一件事', goal: '做完它' }] }) })
  const { tickets: createdTickets } = (await tickets.json()) as { tickets: { id: string }[] }
  const ticketId = createdTickets[0]!.id
  await until(() => control!.store.tickets.get(ticketId)?.assignments.at(-1)?.state === 'running',
    'the Worker Assignment did not start')
  const assignmentId = control!.store.tickets.get(ticketId)!.assignments.at(-1)!.id
  return { projectId: project.id, pmSessionId: session.sessionId, ticketId, assignmentId }
}

/** The Session token the node holds. */
function tokenOf(sessionId: string): string {
  const token = node.tokens.get(sessionId)
  if (!token) throw new Error(`No token for ${sessionId}`)
  return token
}

/**
 * End the Assignment in the domain without telling the node.
 *
 * This is the state a crash between the two leaves behind: the domain says the work is over, the node still runs the
 * Worker. Only the store is touched; the node is left alone on purpose.
 */
function endAssignmentInTheDomain(ticketId: string, assignmentId: string): void {
  control!.store.atomic(() => {
    const ticket = control!.store.tickets.get(ticketId)!
    const assignment = ticket.assignments.find(item => item.id === assignmentId)!
    assignment.state = 'ended'
    assignment.endedAt = START
    assignment.endedReason = 'the test ended it in the domain only'
    control!.store.tickets.save(ticket)
  })
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the orphan reconciliation', () => {
  it('stops and archives a Worker the node still runs although its Assignment is over', async () => {
    await open()
    const { ticketId, assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`
    endAssignmentInTheDomain(ticketId, assignmentId)

    const response = await post('/v1/console/reconcile/run')
    expect(response.status).toBe(200)
    const { result } = (await response.json()) as {
      result: { nodeOnline: boolean; checked: number; findings: { kind: string; action: string; outcome: string }[] }
    }
    expect(result.nodeOnline).toBe(true)
    expect(result.checked).toBeGreaterThan(0)
    const finding = result.findings.find(item => item.kind === 'orphan-worker')
    expect(finding).toBeDefined()
    expect(finding!.outcome).toBe('ok')

    // The leftover Worker is gone from the node and archived there.
    expect(node.sessions.get(workerSession)?.status).toBe('archived')
    expect(control!.session(workerSession)?.status).toBe('archived')
  })

  it('leaves a Worker that still runs its Assignment alone', async () => {
    await open()
    const { assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`

    const response = await post('/v1/console/reconcile/run')
    const { result } = (await response.json()) as { result: { findings: { kind: string }[] } }
    expect(result.findings.filter(item => item.kind === 'orphan-worker')).toHaveLength(0)
    expect(node.sessions.get(workerSession)?.status).toBe('idle')
  })

  it('leaves the Worker of a paused Project alone: a pause is not an end', async () => {
    await open()
    const { projectId, assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`

    // A soft pause keeps the running Assignments; only a hard pause stops the Workers.
    const paused = await post(`/v1/console/projects/${projectId}/pause`, { paused: true, mode: 'soft' })
    expect(paused.status).toBe(200)

    const response = await post('/v1/console/reconcile/run')
    const { result } = (await response.json()) as { result: { findings: { kind: string }[] } }
    expect(result.findings.filter(item => item.kind === 'orphan-worker')).toHaveLength(0)
    // The Worker still holds its place on the node: a paused Project is not an ended one.
    expect(node.sessions.get(workerSession)?.status).toBe('idle')
    expect(control!.store.projects.get(projectId)?.status).toBe('paused')
  })

  it('reports a Worker the node does not have and never dispatches one in its place', async () => {
    await open()
    const { assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`
    // The node lost the Session while the domain still waits for the Assignment.
    node.sessions.delete(workerSession)
    const creates = node.commands.filter(command => command.type === 'worker.create').length

    const response = await post('/v1/console/reconcile/run')
    const { result } = (await response.json()) as {
      result: { findings: { kind: string; outcome: string; action: string }[] }
    }
    const finding = result.findings.find(item => item.kind === 'missing-worker')
    expect(finding).toBeDefined()
    expect(finding!.outcome).toBe('reported')
    expect(finding!.action).toBe('none')
    // A re-dispatch is the PM's decision: the reconciler starts nothing.
    expect(node.commands.filter(command => command.type === 'worker.create')).toHaveLength(creates)
  })

  it('skips the whole round when the node is offline', async () => {
    await open()
    const { ticketId, assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`
    endAssignmentInTheDomain(ticketId, assignmentId)
    control!.markNodeOffline()

    const response = await post('/v1/console/reconcile/run')
    const { result } = (await response.json()) as {
      result: { nodeOnline: boolean; checked: number; findings: unknown[] }
    }
    expect(result.nodeOnline).toBe(false)
    expect(result.checked).toBe(0)
    expect(result.findings).toHaveLength(0)
    // Nothing was touched: the Worker is still there.
    expect(node.sessions.get(workerSession)?.status).toBe('idle')
  })

  it('does the same thing twice: the second run finds nothing left to clean', async () => {
    await open()
    const { ticketId, assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`
    endAssignmentInTheDomain(ticketId, assignmentId)

    const first = await post('/v1/console/reconcile/run')
    const firstBody = (await first.json()) as { result: { findings: { kind: string }[] } }
    expect(firstBody.result.findings.filter(item => item.kind === 'orphan-worker')).toHaveLength(1)

    const second = await post('/v1/console/reconcile/run')
    const secondBody = (await second.json()) as { result: { findings: { kind: string }[] } }
    expect(secondBody.result.findings.filter(item => item.kind === 'orphan-worker')).toHaveLength(0)
    expect(node.sessions.get(workerSession)?.status).toBe('archived')
  })

  it('keeps the runs and says what it could not see', async () => {
    await open()
    await post('/v1/console/reconcile/run')
    const latest = await get('/v1/console/reconcile/latest')
    const body = (await latest.json()) as { run: { id: number; boundary: string; checked: number } | null }
    expect(body.run).not.toBeNull()
    expect(body.run!.id).toBeGreaterThan(0)
    expect(body.run!.boundary).toContain('没有会话枚举')

    const runs = await get('/v1/console/reconcile/runs')
    const runsBody = (await runs.json()) as { runs: unknown[] }
    expect(runsBody.runs.length).toBeGreaterThan(0)
  })
})
