/**
 * 1B sign-off: the control-plane tool API that PM and Worker Sessions call with their own Session tokens, and the DSH
 * proxy tools the node registers for them.
 *
 * Two layers are covered: the HTTP routes over a real `ControlPlaneServer` (identity, Project/Ticket/Assignment rules,
 * status codes) and the node's `control_report` / `control_create_tickets` execution against a fake Agent tool registry
 * and a recorded `fetch`. One test wires the two together against the real server.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket, Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { PM_PROFILE, WORKER_PROFILE } from '../src/control/roles.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { createDshPortHost, type DshPortFetch } from '../src/node/dsh-port-host.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { issueSessionToken } from '../src/shared/session-token.ts'
import type { NodeCommand, SessionRecord } from '../src/shared/protocol.ts'

const SECRET = 'tools-secret'
const API_TOKEN = 'tools-api-token'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: ControllableNode

function trigger(id: string): Trigger {
  return { id, source: 'main-session', threads: [{ source: 'main-session', id: `thread-${id}` }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

/** Wait for the asynchronous Executor callbacks to settle the Store. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A promise a test resolves by hand, so a command can be held where a race needs one. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, resolve: release }
}

/**
 * A FakeNode whose `worker.create` and `session.cancel` a test can hold or fail.
 *
 * The PM's cancel and the node's own work race in ways an in-process node answers too quickly to show: a creation that
 * outlives the cancel, a cancel the node refuses, and a stop the PM waits for before it may replace a Worker.
 */
class ControllableNode extends FakeNode {
  /** The commands that reached the node, in the order they were sent, before any gate held them. */
  readonly arriving: NodeCommand[] = []
  /** Held until it resolves, so `worker.create` waits for the test. */
  createGate: Promise<void> | undefined
  /** Held until it resolves, so `session.cancel` waits for the test. */
  cancelGate: Promise<void> | undefined
  /** When set, `session.cancel` fails with it. */
  cancelFailure: Error | undefined
  /** What one Session's cancel does, so one stop can be held while another is refused. */
  readonly cancels = new Map<string, { gate?: Promise<void>; failure?: Error }>()

  override async send(command: NodeCommand): Promise<void> {
    this.arriving.push(command)
    if (command.type === 'worker.create' && this.createGate) await this.createGate
    if (command.type === 'session.cancel') {
      const own = this.cancels.get(command.sessionId)
      if (own?.failure) throw own.failure
      if (own?.gate) await own.gate
      if (this.cancelFailure) throw this.cancelFailure
      if (this.cancelGate) await this.cancelGate
    }
    return super.send(command)
  }
}

interface Opened {
  project: ProjectProfile
  pm: SessionRecord
  ticket: Ticket
  assignment: Assignment
  address: { url: string }
}

/** A Project whose PM and first Worker Session exist on the FakeNode, plus the tool API listening on a random port. */
async function open(options: { stopCleanupTimeoutMs?: number; ensureSettleTimeoutMs?: number } = {}): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-tools-'))
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50,
    ...(options.stopCleanupTimeoutMs === undefined ? {} : { stopCleanupTimeoutMs: options.stopCleanupTimeoutMs }),
    ...(options.ensureSettleTimeoutMs === undefined ? {} : { ensureSettleTimeoutMs: options.ensureSettleTimeoutMs }) })
  await control.registerNode()
  control.store.triggers.save(trigger('trigger-1'))
  const project = control.createProject('trigger-1', 'Project', 'Goal')
  const pm = await control.openProject(project.id)
  const [created] = control.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Ticket', goal: 'Do it' }])
  const assignment = created!.assignments[0]!
  await until(() => control!.store.tickets.get(created!.id)?.assignments.at(-1)?.state === 'running',
    'the Assignment did not start')
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  const address = await server.listen(0)
  return { project, pm, ticket: control.store.tickets.get(created!.id)!, assignment, address }
}

function tokenOf(sessionId: string): string {
  const token = node.tokens.get(sessionId)
  if (!token) throw new Error(`The FakeNode has no token for ${sessionId}`)
  return token
}

function post(address: { url: string }, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function get(address: { url: string }, path: string, token: string): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane tool API', () => {
  it('lets a PM create Tickets in its own Project', async () => {
    const { project, pm, address } = await open()

    const response = await post(address, '/v1/tools/pm/tickets', tokenOf(pm.sessionId), { tasks: [
      { title: 'Second', goal: 'Ship the second part', scope: 'only the API', note: 'route to the worker',
        threads: ['main-session:thread-2'] },
    ] })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { tickets: Ticket[] }
    expect(body.tickets).toHaveLength(1)
    const [ticket] = body.tickets
    expect(ticket).toMatchObject({ projectId: project.id, title: 'Second' })
    // The Ticket is real Engine state, not just an HTTP echo.
    expect(control!.store.tickets.get(ticket!.id)).toMatchObject({ projectId: project.id, title: 'Second' })
    expect(control!.store.triggers.get(ticket!.origin.triggerId)?.meta).toMatchObject({ title: 'Second',
      goal: 'Ship the second part', scope: 'only the API', note: 'route to the worker' })
  })

  it('creates Tickets in the Project its token names, not in another Project', async () => {
    const { address } = await open()
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const otherPm = await control!.openProject(other.id)

    const response = await post(address, '/v1/tools/pm/tickets', tokenOf(otherPm.sessionId),
      { tasks: [{ title: 'Only other', goal: 'G' }] })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { tickets: Ticket[] }
    expect(body.tickets[0]).toMatchObject({ projectId: other.id })
    expect(control!.store.tickets.get(body.tickets[0]!.id)?.projectId).toBe(other.id)
  })

  it('writes a Worker report onto the same Ticket and current Assignment', async () => {
    const { ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    const response = await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      assignmentId: assignment.id, report: { state: 'progress', summary: 'halfway there' } })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { ticket: Ticket }
    expect(body.ticket.id).toBe(ticket.id)
    expect(body.ticket.assignments.at(-1)?.id).toBe(assignment.id)
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.report)
      .toMatchObject({ state: 'progress', summary: 'halfway there' })
  })

  it('accepts a question with a blocked report and clears it with null', async () => {
    const { ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    const blocked = await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      report: { state: 'blocked', summary: 'needs a decision', question: 'Which branch?' } })
    expect(blocked.status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.attention).toMatchObject({ question: 'Which branch?' })

    const cleared = await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      report: { state: 'progress', summary: 'decided', question: null } })
    expect(cleared.status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.attention).toBeUndefined()
  })

  it('refuses the operator token, a wrong role, an expired token and an unknown Session', async () => {
    const { project, pm, ticket, assignment, address } = await open()
    const pmPath = '/v1/tools/pm/tickets'
    const workerPath = '/v1/tools/worker/report'
    const pmBody = { tasks: [{ title: 'T', goal: 'G' }] }
    const workerBody = { ticketId: ticket.id, report: { state: 'progress', summary: 's' } }

    // The control-plane API token is not a Session token and must never open a tool route.
    expect((await post(address, pmPath, API_TOKEN, pmBody)).status).toBe(401)
    // A Worker token cannot create Tickets; a PM token cannot report.
    expect((await post(address, pmPath, tokenOf(`worker-${assignment.id}`), pmBody)).status).toBe(403)
    expect((await post(address, workerPath, tokenOf(pm.sessionId), workerBody)).status).toBe(403)
    // A tampered signature is not trusted.
    expect((await post(address, pmPath, `${tokenOf(pm.sessionId)}x`, pmBody)).status).toBe(401)
    // An expired token is rejected even though its signature is valid.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const expired = issueSessionToken({ sid: pm.sessionId, pid: project.id, role: 'pm', backend: 'dsh', nodeId: NODE_ID },
      SECRET, 60, nowSeconds - 120)
    expect((await post(address, pmPath, expired, pmBody)).status).toBe(401)
    // A signed token for a Session this kernel does not know is refused too.
    const ghost = issueSessionToken({ sid: 'pm-ghost', pid: project.id, role: 'pm', backend: 'dsh', nodeId: NODE_ID },
      SECRET, 600)
    expect((await post(address, pmPath, ghost, pmBody)).status).toBe(401)
  })

  it('refuses an unknown or foreign Ticket, another Assignment and an invalid report', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    const workerToken = tokenOf(worker)

    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: 'ticket-ghost',
      report: { state: 'progress', summary: 's' } })).status).toBe(400)
    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id, assignmentId: 'other',
      report: { state: 'progress', summary: 's' } })).status).toBe(403)
    // `waiting` is the Executor's state, never a Worker's claim.
    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id,
      report: { state: 'waiting', summary: 's' } })).status).toBe(400)
    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id,
      report: { state: 'progress', summary: '   ' } })).status).toBe(400)

    // A Ticket of another Project is unknown from this Worker's point of view.
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const [foreign] = control!.engine.createProjectTickets(other.id, other.pmSessionId, [{ title: 'Other', goal: 'G' }])
    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: foreign!.id,
      report: { state: 'progress', summary: 's' } })).status).toBe(400)

    // The PM path validates its own body before the Engine sees it.
    expect((await post(address, '/v1/tools/pm/tickets', tokenOf(pm.sessionId), { tasks: [] })).status).toBe(400)
    expect((await post(address, '/v1/tools/pm/tickets', tokenOf(pm.sessionId),
      { tasks: [{ title: 'T' }] })).status).toBe(400)
  })

  it('gives a PM its own Project and Tickets, and never another Project', async () => {
    const { project, pm, ticket, assignment, address } = await open()

    const response = await get(address, '/v1/tools/pm/context', tokenOf(pm.sessionId))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { project: Record<string, unknown>
      tickets: { id: string; title: string; status: string; assignment?: Record<string, unknown> }[] }

    // Exactly the safe Project fields: no Mandate, PM Session id, token or internal actor.
    expect(body.project).toEqual({ id: project.id, title: 'Project', goal: 'Goal', status: 'active' })
    expect(body.tickets).toHaveLength(1)
    expect(body.tickets[0]).toMatchObject({ id: ticket.id, title: 'Ticket', status: 'running' })
    expect(Object.keys(body.tickets[0]!).sort()).toEqual(['assignment', 'id', 'status', 'title'])
    expect(body.tickets[0]!.assignment).toEqual({ id: assignment.id, state: 'running',
      sessionId: `worker-${assignment.id}` })

    // Another PM reads its own Project only: this Project's Ticket never appears in it.
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const otherPm = await control!.openProject(other.id)
    const [foreign] = control!.engine.createProjectTickets(other.id, otherPm.sessionId, [{ title: 'Foreign', goal: 'G' }])
    const otherBody = (await (await get(address, '/v1/tools/pm/context', tokenOf(otherPm.sessionId))).json()) as typeof body
    expect(otherBody.project.id).toBe(other.id)
    expect(otherBody.tickets.map(item => item.id)).toEqual([foreign!.id])
    expect(otherBody.tickets.map(item => item.id)).not.toContain(ticket.id)

    // A Worker token cannot read the PM context, and the operator token is not a Session token at all.
    expect((await get(address, '/v1/tools/pm/context', tokenOf(`worker-${assignment.id}`))).status).toBe(403)
    expect((await get(address, '/v1/tools/pm/context', API_TOKEN)).status).toBe(401)
  })

  it('derives the Ticket status a PM reads', async () => {
    const { project, pm, ticket, assignment, address } = await open()
    const workerToken = tokenOf(`worker-${assignment.id}`)
    const status = async (): Promise<string> => {
      const response = await get(address, '/v1/tools/pm/context', tokenOf(pm.sessionId))
      expect(response.status).toBe(200)
      const body = (await response.json()) as { tickets: { id: string; status: string }[] }
      return body.tickets.find(item => item.id === ticket.id)!.status
    }

    expect(await status()).toBe('running')

    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id,
      report: { state: 'blocked', summary: 'needs a person' } })).status).toBe(200)
    expect(await status()).toBe('blocked')

    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id,
      report: { state: 'progress', summary: 'unblocked' } })).status).toBe(200)
    expect(await status()).toBe('running')

    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id,
      report: { state: 'ready', summary: 'done' } })).status).toBe(200)
    // A result waits for the PM's review: the Ticket stays open until the PM accepts it.
    expect(await status()).toBe('waiting')

    // An archived Project Ticket reads as archived, ahead of the end state it still records.
    control!.store.tickets.save({ ...control!.store.tickets.get(ticket.id)!,
      archived: { at: START, by: 'project', projectId: project.id } })
    expect(await status()).toBe('archived')
  })

  it('names the control tools in the role profiles', () => {
    expect(PM_PROFILE.tools).toContain('control_project')
    expect(PM_PROFILE.prompt).toContain('control_project')
    expect(PM_PROFILE.tools).toContain('control_create_tickets')
    expect(PM_PROFILE.prompt).toContain('control_create_tickets')
    expect(PM_PROFILE.tools).toContain('control_message_worker')
    expect(PM_PROFILE.prompt).toContain('control_message_worker')
    expect(PM_PROFILE.tools).toContain('control_cancel_worker')
    expect(PM_PROFILE.prompt).toContain('control_cancel_worker')
    expect(PM_PROFILE.tools).toContain('control_request_assignment')
    expect(PM_PROFILE.prompt).toContain('control_request_assignment')
    expect(PM_PROFILE.tools).toContain('control_review_result')
    expect(PM_PROFILE.prompt).toContain('control_review_result')
    expect(PM_PROFILE.tools).toContain('control_review_diff')
    expect(PM_PROFILE.prompt).toContain('control_review_diff')
    expect(WORKER_PROFILE.tools).toContain('control_report')
    expect(WORKER_PROFILE.prompt).toContain('control_report')
  })

  it('names no tool the standalone PM does not run', () => {
    // The profile is the role's whole capability set: every name in it must be a tool the node registers, and every
    // tool the node registers must be in it. The old plugin's nine `orchestrator_*` tools belong to that plugin's own
    // PM Session, which is registered and unchanged.
    expect([...PM_PROFILE.tools]).toEqual(['control_project', 'control_create_tickets', 'control_message_worker',
      'control_cancel_worker', 'control_request_assignment', 'control_review_result', 'control_review_diff',
      'control_project_report'])
    expect(PM_PROFILE.tools.some(name => name.startsWith('orchestrator_'))).toBe(false)
  })
})

/**
 * The PM's orchestration path: listing the work, messaging a Worker, stopping a Worker and asking for a new Assignment.
 *
 * Every rule is the domain's: the Ticket must belong to the caller's own Project, an Assignment the caller names must
 * still be current, a stop ends the Assignment in the Store and asks the node to stop the Session, and a new Assignment
 * starts only where the domain allows one.
 */
describe('PM orchestration tools', () => {
  it('lists the Assignments and the reports of the Project\'s own Tickets', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    expect((await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      report: { state: 'progress', summary: 'halfway there' } })).status).toBe(200)

    const response = await get(address, '/v1/tools/pm/context', tokenOf(pm.sessionId))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { tickets: { id: string; status: string
      assignment?: { id: string; state: string; sessionId: string; report?: { state: string; summary: string } } }[] }
    expect(body.tickets[0]).toMatchObject({ id: ticket.id, status: 'running' })
    expect(body.tickets[0]!.assignment).toMatchObject({ id: assignment.id, state: 'running',
      sessionId: `worker-${assignment.id}`, report: { state: 'progress', summary: 'halfway there' } })
  })

  it('delivers a PM message to the Worker of the current Assignment', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    const response = await post(address, '/v1/tools/pm/message', tokenOf(pm.sessionId),
      { ticketId: ticket.id, text: 'Use the new schema' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { delivered: string }
    expect(body.delivered).toBe('running')

    await until(() => (node.messages.get(worker)?.length ?? 0) > 0, 'the Worker did not receive the message')
    expect(node.messages.get(worker)![0]).toContain('Use the new schema')
    // The message is a Ticket Input, not new authority.
    expect(control!.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'note')).toBe(true)
  })

  it('ends the Assignment in the domain and stops the Worker Session on the node', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    const response = await post(address, '/v1/tools/pm/cancel', tokenOf(pm.sessionId),
      { ticketId: ticket.id, reason: 'the plan changed' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { stopped: boolean; assignment: { id: string; state: string; endedReason?: string } }
    expect(body.stopped).toBe(true)
    expect(body.assignment).toMatchObject({ id: assignment.id, state: 'ended', endedReason: 'stoppedByOperator' })
    // The stop is recorded under the Project, so the PM may ask for a new Assignment and a person's stop still stands.
    expect(control!.store.tickets.get(ticket.id)?.manualStop).toMatchObject({ scope: 'project', by: 'pm' })
    // The node really stopped the Worker Session.
    expect(node.commands.some(command => command.type === 'session.cancel' && command.sessionId === worker)).toBe(true)
    expect(node.sessions.get(worker)?.status).toBe('stopped')
  })

  it('reports a node that could not stop the Worker', async () => {
    const { pm, ticket, address } = await open()
    control!.markNodeOffline()

    const response = await post(address, '/v1/tools/pm/cancel', tokenOf(pm.sessionId), { ticketId: ticket.id })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { stopped: boolean; error?: string }
    expect(body.stopped).toBe(false)
    expect(body.error).toContain('offline')
    // The Assignment ended in the domain all the same, and the failure stays on the Ticket.
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.state).toBe('ended')
    expect(control!.store.tickets.get(ticket.id)?.stopFailure?.error).toBeTruthy()
    // The failure is visible to the PM that reads the Project.
    const context = (await (await get(address, '/v1/tools/pm/context', tokenOf(pm.sessionId))).json()) as {
      tickets: { id: string; stopFailure?: { error: string } }[] }
    expect(context.tickets[0]!.stopFailure?.error).toBeTruthy()
  })

  it('starts exactly one new Assignment after the PM stopped the Worker', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    expect((await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id })).status).toBe(200)

    const response = await post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { rule: string; assignment: { id: string } }
    expect(body.rule).toBe('revived')

    const current = control!.store.tickets.get(ticket.id)!
    expect(current.assignments).toHaveLength(2)
    expect(current.assignments[0]!.state).toBe('ended')
    expect(current.assignments[1]!.id).toBe(body.assignment.id)
    expect(current.manualStop).toBeUndefined()
    await until(() => control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.state === 'running',
      'the new Assignment did not start')
    // The new Worker runs in its own Session; the stopped one keeps its own.
    expect(node.sessions.get(`worker-${body.assignment.id}`)).toBeDefined()
    expect(body.assignment.id).not.toBe(assignment.id)
  })

  it('retries a stalled Worker with one new Assignment', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    expect((await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      report: { state: 'failed', summary: 'the build is broken' } })).status).toBe(200)

    const response = await post(address, '/v1/tools/pm/assignment', tokenOf(pm.sessionId), { ticketId: ticket.id })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { rule: string; assignment: { id: string } }
    expect(body.rule).toBe('retried')
    const current = control!.store.tickets.get(ticket.id)!
    expect(current.assignments).toHaveLength(2)
    expect(current.assignments[0]!.state).toBe('ended')
    expect(current.assignments[1]!.id).toBe(body.assignment.id)
  })

  it('answers a cancel with the Assignment it stopped, not the one a concurrent request started', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    // The node's stop is held, so the request below arrives while the cancel is still running.
    const gate = deferred()
    node.cancelGate = gate.promise

    const cancel = post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id })
    await until(() => node.arriving.some(command => command.type === 'session.cancel'), 'the cancel was never sent')
    const request = post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })
    gate.resolve()

    const cancelled = (await (await cancel).json()) as { stopped: boolean; assignment: { id: string } }
    const revived = (await (await request).json()) as { rule: string; assignment: { id: string } }
    // The cancel names the Assignment it stopped; it never reports the one the request started.
    expect(cancelled.stopped).toBe(true)
    expect(cancelled.assignment.id).toBe(assignment.id)
    expect(revived.rule).toBe('revived')
    expect(revived.assignment.id).not.toBe(assignment.id)
    const current = control!.store.tickets.get(ticket.id)!
    expect(current.assignments).toHaveLength(2)
    // The old Worker was stopped before its replacement was created.
    const order = node.arriving.map(command => command.type)
    expect(order.indexOf('session.cancel')).toBeLessThan(order.lastIndexOf('worker.create'))
  })

  it('waits for the confirmed stop of a stalled Worker before it starts its replacement', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    const worker = `worker-${assignment.id}`
    expect((await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      report: { state: 'failed', summary: 'the build is broken' } })).status).toBe(200)
    // The node's stop is held: the replacement must not start while the old Worker may still run.
    const gate = deferred()
    node.cancelGate = gate.promise

    const request = post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })
    await until(() => node.arriving.some(command => command.type === 'session.cancel'), 'the Worker was never stopped')
    // Only the first Worker's creation happened: the replacement waits for the stop.
    expect(node.arriving.filter(command => command.type === 'worker.create')).toHaveLength(1)
    gate.resolve()

    const response = await request
    expect(response.status).toBe(200)
    const body = (await response.json()) as { rule: string; assignment: { id: string } }
    expect(body.rule).toBe('retried')
    const current = control!.store.tickets.get(ticket.id)!
    expect(current.assignments).toHaveLength(2)
    expect(current.assignments[0]!.state).toBe('ended')
    expect(current.assignments[1]!.id).toBe(body.assignment.id)
    const order = node.arriving.map(command => command.type)
    expect(order.indexOf('session.cancel')).toBeLessThan(order.lastIndexOf('worker.create'))
  })

  it('refuses a new Assignment while the previous Worker was never confirmed stopped', async () => {
    const { pm, ticket, address } = await open()
    const token = tokenOf(pm.sessionId)
    node.cancelFailure = new Error('The node could not reach the Worker')

    const cancel = await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id })
    expect(cancel.status).toBe(200)
    const body = (await cancel.json()) as { stopped: boolean; error?: string }
    expect(body.stopped).toBe(false)
    expect(body.error).toBeTruthy()

    // The Assignment ended, but its Worker may still run: no new Assignment starts over it.
    const request = await post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })
    expect(request.status).toBe(400)
    const refused = (await request.json()) as { error: string }
    expect(refused.error).toContain('not confirmed stopped')
    expect(control!.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
    // The failure stays on the Ticket, where the PM reads it.
    expect(control!.store.tickets.get(ticket.id)?.stopFailure?.error).toBeTruthy()
  })

  it('confirms a failed stop when the PM stops that Worker again', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    node.cancelFailure = new Error('The node could not reach the Worker')
    expect((await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id })).status).toBe(200)

    // The node answers now, so the second stop confirms the first one.
    node.cancelFailure = undefined
    const again = await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id, assignmentId: assignment.id })
    expect(again.status).toBe(200)
    const body = (await again.json()) as { stopped: boolean; assignment: { id: string; state: string } }
    expect(body.stopped).toBe(true)
    expect(body.assignment.id).toBe(assignment.id)
    // The failure a confirmed stop supersedes is gone.
    expect(control!.store.tickets.get(ticket.id)?.stopFailure).toBeUndefined()

    // And now a new Assignment may start.
    const request = await post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })
    expect(request.status).toBe(200)
    expect(((await request.json()) as { rule: string }).rule).toBe('revived')
  })

  it('reports the redacted diagnostic of a stop the node refused', async () => {
    const { pm, ticket, address } = await open()
    node.cancelFailure = new Error('cannot stop /home/me/.config/gh token=abc123def456')

    const response = await post(address, '/v1/tools/pm/cancel', tokenOf(pm.sessionId), { ticketId: ticket.id })
    const body = (await response.json()) as { stopped: boolean; error?: string }
    expect(body.stopped).toBe(false)
    expect(body.error).not.toContain('/home/me')
    expect(body.error).not.toContain('abc123def456')
    // The answer is the Ticket's own redacted diagnostic, never the raw error.
    expect(body.error).toBe(control!.store.tickets.get(ticket.id)?.stopFailure?.error)
  })

  it('stops a Worker whose creation is still in flight, and never leaves it running', async () => {
    const { project, pm, address } = await open()
    const token = tokenOf(pm.sessionId)
    // The creation is held, so the cancel reaches the node before the Worker exists.
    const gate = deferred()
    node.createGate = gate.promise
    // A second Ticket whose Worker Session is still being created.
    const [second] = control!.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Second', goal: 'G' }])
    const assignmentId = second!.assignments[0]!.id

    const cancel = post(address, '/v1/tools/pm/cancel', token, { ticketId: second!.id })
    await until(() => node.arriving.some(command => command.type === 'worker.create'
      && command.assignmentId === assignmentId), 'the Worker was never created')
    // The stop waits for the creation, so no cancel reaches the node before the Worker exists.
    expect(node.arriving.some(command => command.type === 'session.cancel')).toBe(false)
    gate.resolve()

    const response = await cancel
    expect(response.status).toBe(200)
    const body = (await response.json()) as { stopped: boolean }
    expect(body.stopped).toBe(true)
    // The node created the Worker and stopped it again, in that order: no Worker is left running.
    const workerSession = `worker-${assignmentId}`
    expect(node.sessions.get(workerSession)?.status).toBe('stopped')
    const created = node.commands.findIndex(command => command.type === 'worker.create'
      && command.sessionId === workerSession)
    const stopped = node.commands.findIndex(command => command.type === 'session.cancel'
      && command.sessionId === workerSession)
    expect(created).toBeGreaterThanOrEqual(0)
    expect(stopped).toBeGreaterThan(created)
  })

  it('refuses a new Assignment while a creation is in flight and the stop is unconfirmed', async () => {
    const { project, pm, address } = await open({ ensureSettleTimeoutMs: 50 })
    const token = tokenOf(pm.sessionId)
    // The creation is held, so the stop cannot be confirmed.
    const gate = deferred()
    node.createGate = gate.promise
    const [second] = control!.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Second', goal: 'G' }])

    const cancel = await post(address, '/v1/tools/pm/cancel', token, { ticketId: second!.id })
    const body = (await cancel.json()) as { stopped: boolean; error?: string }
    expect(body.stopped).toBe(false)
    expect(body.error).toContain('not confirmed')

    // No new Assignment may start over a Worker that may still be created.
    const request = await post(address, '/v1/tools/pm/assignment', token, { ticketId: second!.id })
    expect(request.status).toBe(400)
    expect(control!.store.tickets.get(second!.id)?.assignments).toHaveLength(1)
    gate.resolve()
  })

  it('refuses a request that names a stale Assignment', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    expect((await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id })).status).toBe(200)
    expect((await post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })).status).toBe(200)
    const current = control!.store.tickets.get(ticket.id)!.assignments.at(-1)!
    expect(current.id).not.toBe(assignment.id)

    // A stale request starts no new attempt.
    const stale = await post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id, assignmentId: assignment.id })
    expect(stale.status).toBe(400)
    expect(control!.store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
  })

  it('refuses a new Assignment for a Worker that still works and for one a person stopped', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    // The Worker still works: it needs no new Assignment.
    expect((await post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })).status).toBe(400)
    // A person stopped the Worker: only a person may approve its resume.
    control!.engine.stopAssignment(ticket.id, assignment.id)
    expect((await post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })).status).toBe(403)
  })

  it('refuses a third Assignment when the second stop failed', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    const worker = `worker-${assignment.id}`
    // The first Worker stalls and is replaced by a second one.
    expect((await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      report: { state: 'failed', summary: 'the build is broken' } })).status).toBe(200)
    const first = await post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })
    expect(first.status).toBe(200)
    expect(((await first.json()) as { rule: string }).rule).toBe('retried')
    const second = control!.store.tickets.get(ticket.id)!.assignments.at(-1)!
    expect(second.id).not.toBe(assignment.id)

    // The node refuses to stop that second Worker.
    node.cancelFailure = new Error('The node could not reach the Worker')
    const stop = await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id, assignmentId: second.id })
    expect(stop.status).toBe(200)
    const stopped = (await stop.json()) as { stopped: boolean; error?: string }
    expect(stopped.stopped).toBe(false)

    // No third Assignment starts over a Worker that may still run: the second stop was never confirmed.
    const third = await post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })
    expect(third.status).toBe(400)
    expect(((await third.json()) as { error: string }).error).toContain('not confirmed stopped')
    expect(control!.store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
  })

  it('keeps an unconfirmed stop across a control-plane restart', async () => {
    const { pm, ticket, address } = await open()
    const token = tokenOf(pm.sessionId)
    node.cancelFailure = new Error('The node could not reach the Worker')
    const cancel = await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id })
    expect(cancel.status).toBe(200)
    expect(((await cancel.json()) as { stopped: boolean }).stopped).toBe(false)

    // The control plane restarts: its own memory of the stop is gone, but the Ticket keeps the open stop.
    await server!.close()
    server = undefined
    await control!.close()
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
      workspaceRoot: join(directory, 'workspaces'), now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const restarted = await server.listen(0)

    // The Worker may still run, so no new Assignment starts over it.
    const request = await post(restarted, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })
    expect(request.status).toBe(400)
    expect(((await request.json()) as { error: string }).error).toContain('not confirmed stopped')
    expect(control!.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
  })

  it('keeps the newer Assignment\'s stop diagnostics when an older stop answers late', async () => {
    const { project, pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    const worker = `worker-${assignment.id}`
    // The first stop waits for the node, so its answer arrives after the second Worker was started.
    const gate = deferred()
    node.cancels.set(worker, { gate: gate.promise })
    const cleanups: { ticketId: string; work: Promise<void> }[] = []
    control!.engine.stopProjectWorker(project.id, pm.sessionId, ticket.id, assignment.id, { cleanups })
    await until(() => node.arriving.some(command => command.type === 'session.cancel' && command.sessionId === worker),
      'the first cancel never reached the node')

    // A second Assignment starts over the ended one while that stop is still unanswered.
    const revived = control!.engine.reviveProjectTicket(project.id, pm.sessionId, ticket.id)
    const second = revived.assignments.at(-1)!
    // The node refuses to stop that second Worker.
    node.cancels.set(`worker-${second.id}`, { failure: new Error('The node could not reach the Worker') })
    const stop = await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id, assignmentId: second.id })
    expect(stop.status).toBe(200)
    expect(((await stop.json()) as { stopped: boolean }).stopped).toBe(false)
    expect(control!.store.tickets.get(ticket.id)?.stopFailure?.assignmentId).toBe(second.id)

    // The older stop answers now: it confirms its own Assignment and nothing else.
    gate.resolve()
    await cleanups[0]!.work
    const current = control!.store.tickets.get(ticket.id)!
    expect(current.stopFailure?.assignmentId).toBe(second.id)
    expect(current.stopPending?.assignmentId).toBe(second.id)
  })

  it('refuses a stale Assignment on the message and on the cancel', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    expect((await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id })).status).toBe(200)
    expect((await post(address, '/v1/tools/pm/assignment', token, { ticketId: ticket.id })).status).toBe(200)
    const current = control!.store.tickets.get(ticket.id)!.assignments.at(-1)!
    expect(current.id).not.toBe(assignment.id)

    // The Assignment that was replaced may neither carry a message into the new Worker nor stop it.
    expect((await post(address, '/v1/tools/pm/message', token, { ticketId: ticket.id, text: 'stale',
      assignmentId: assignment.id })).status).toBe(400)
    expect((await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id,
      assignmentId: assignment.id })).status).toBe(400)
    // The new Assignment is untouched by the refused calls.
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.state).not.toBe('ended')
  })

  it('refuses a Ticket of another Project on every PM route', async () => {
    const { pm, address } = await open()
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const [foreign] = control!.engine.createProjectTickets(other.id, other.pmSessionId, [{ title: 'Foreign', goal: 'G' }])
    const token = tokenOf(pm.sessionId)

    expect((await post(address, '/v1/tools/pm/message', token, { ticketId: foreign!.id, text: 'hi' })).status).toBe(400)
    expect((await post(address, '/v1/tools/pm/cancel', token, { ticketId: foreign!.id })).status).toBe(400)
    expect((await post(address, '/v1/tools/pm/assignment', token, { ticketId: foreign!.id })).status).toBe(400)
    // The foreign Ticket keeps its own Worker.
    expect(control!.store.tickets.get(foreign!.id)?.assignments.at(-1)?.state).not.toBe('ended')
  })

  it('refuses a Worker token, the operator token and an invalid body on the PM routes', async () => {
    const { pm, ticket, assignment, address } = await open()
    const workerToken = tokenOf(`worker-${assignment.id}`)
    for (const path of ['/v1/tools/pm/message', '/v1/tools/pm/cancel', '/v1/tools/pm/assignment']) {
      expect((await post(address, path, workerToken, { ticketId: ticket.id, text: 'x' })).status).toBe(403)
      expect((await post(address, path, API_TOKEN, { ticketId: ticket.id, text: 'x' })).status).toBe(401)
    }
    expect((await get(address, '/v1/tools/pm/context', workerToken)).status).toBe(403)
    expect((await get(address, '/v1/tools/pm/context', API_TOKEN)).status).toBe(401)
    // A body without the Ticket is a client error, not a silent success.
    expect((await post(address, '/v1/tools/pm/message', tokenOf(pm.sessionId), { text: 'x' })).status).toBe(400)
    expect((await post(address, '/v1/tools/pm/cancel', tokenOf(pm.sessionId), {})).status).toBe(400)
    expect((await post(address, '/v1/tools/pm/assignment', tokenOf(pm.sessionId), {})).status).toBe(400)
  })
})

/** One tool the host registered into the fake Agent's scoped registry. */
interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

/** A DSH Agent stand-in with exactly the registry surface `createDshPortHost` uses. */
class FakeAgent {
  readonly tools = new Map<string, RegisteredTool>()
  registrations = 0
  readonly ctx = { tools: { register: (definition: RegisteredTool): (() => void) => {
    this.registrations++
    this.tools.set(definition.name, definition)
    return () => { this.tools.delete(definition.name) }
  } } }
}

interface RecordedCall {
  url: string
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
}

/** A recorded fetch whose answers a test supplies. */
function recorder(answer: (call: RecordedCall) => { ok: boolean; status: number; text(): Promise<string> }): {
  calls: RecordedCall[]
  fetch: DshPortFetch
} {
  const calls: RecordedCall[] = []
  const fetch: DshPortFetch = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return answer(call)
  }
  return { calls, fetch }
}

function jsonAnswer(value: unknown, status = 200): { ok: boolean; status: number; text(): Promise<string> } {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) }
}

/** A node root for the host's workspace check. */
function nodeRoot(): string {
  directory = mkdtempSync(join(tmpdir(), 'superagent-tool-host-'))
  const root = join(directory, 'node')
  mkdirSync(root, { recursive: true })
  return root
}

function toolHost(options: { root: string; controlUrl?: string; fetch?: DshPortFetch }): {
  host: ReturnType<typeof createDshPortHost>
  agents: Map<string, FakeAgent>
  prompts: { sessionId: string; key: string; text: string }[]
} {
  const agents = new Map<string, FakeAgent>()
  const prompts: { sessionId: string; key: string; text: string }[] = []
  const sessions = {
    async ensure(sessionId: string) {
      const agent = new FakeAgent()
      agents.set(sessionId, agent)
      return agent
    },
    async prompt(sessionId: string, key: string, text: string) { prompts.push({ sessionId, key, text }) },
  }
  const context = { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } }
  const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: 'node-1', root: options.root,
    ...(options.controlUrl === undefined ? {} : { controlUrl: options.controlUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
  return { host, agents, prompts }
}

const EXEC = { signal: new AbortController().signal }

describe('node control tools', () => {
  it('registers control_report and posts the report with the Session token', async () => {
    const root = nodeRoot()
    const { calls, fetch } = recorder(() => jsonAnswer({ ticket: { id: 'ticket-1' } }))
    const { host, agents, prompts } = toolHost({ root, controlUrl: 'http://control.test/', fetch })

    await host.ensureSession({ sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
      profile: WORKER_PROFILE, prompt: WORKER_PROFILE.prompt, sessionToken: 'worker-token', ticketId: 'ticket-1', assignmentId: 'assignment-1' })

    const agent = agents.get('worker-1')!
    expect([...agent.tools.keys()]).toEqual(['control_report'])
    // The usage note rides the role prompt, so the first turn knows the tool and this Session's Ticket.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.sessionId).toBe('worker-1')
    expect(prompts[0]!.key).toBe('profile:worker-1')
    expect(prompts[0]!.text).toContain(WORKER_PROFILE.prompt)
    expect(prompts[0]!.text).toContain('Use control_report')
    expect(prompts[0]!.text).toContain('Ticket ticket-1')
    expect(prompts[0]!.text).toContain('Assignment assignment-1')

    const tool = agent.tools.get('control_report')!
    const result = await tool.execute({ ticketId: 'ticket-1', state: 'progress', summary: 'halfway' }, EXEC)
    expect(result).toEqual({ ticket: { id: 'ticket-1' } })
    expect(calls).toHaveLength(1)
    // A trailing slash on the configured URL must not double up.
    expect(calls[0]!.url).toBe('http://control.test/v1/tools/worker/report')
    expect(calls[0]!.init).toMatchObject({ method: 'POST',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' } })
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ ticketId: 'ticket-1', assignmentId: 'assignment-1',
      report: { state: 'progress', summary: 'halfway' } })
  })

  it('registers control_create_tickets and posts the tasks', async () => {
    const root = nodeRoot()
    const { calls, fetch } = recorder(() => jsonAnswer({ tickets: [{ id: 'ticket-2' }] }))
    const { host, agents } = toolHost({ root, controlUrl: 'http://control.test', fetch })

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      profile: PM_PROFILE, prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })

    const tool = agents.get('pm-1')!.tools.get('control_create_tickets')!
    const result = await tool.execute({ tasks: [{ title: 'T', goal: 'G', scope: 'S' }] }, EXEC)
    expect(result).toEqual({ tickets: [{ id: 'ticket-2' }] })
    expect(calls[0]!.url).toBe('http://control.test/v1/tools/pm/tickets')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer pm-token')
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ tasks: [{ title: 'T', goal: 'G', scope: 'S' }] })
  })

  it('registers control_project beside control_create_tickets and reads the context with a GET', async () => {
    const root = nodeRoot()
    const context = { project: { id: 'project-1', title: 'Project', goal: 'Goal', status: 'active' }, tickets: [
      { id: 'ticket-1', title: 'Ticket', status: 'running', assignment: { id: 'assignment-1', state: 'running' } }] }
    const { calls, fetch } = recorder(() => jsonAnswer(context))
    const { host, agents, prompts } = toolHost({ root, controlUrl: 'http://control.test', fetch })

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      profile: PM_PROFILE, prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })

    const agent = agents.get('pm-1')!
    expect([...agent.tools.keys()]).toEqual(['control_project', 'control_create_tickets', 'control_message_worker',
      'control_cancel_worker', 'control_request_assignment', 'control_review_result', 'control_review_diff',
      'control_project_report'])
    // The usage note names the tools, so the PM's first turn knows how to read, create and orchestrate.
    expect(prompts[0]!.text).toContain('Use control_project')
    expect(prompts[0]!.text).toContain('control_create_tickets')
    expect(prompts[0]!.text).toContain('control_message_worker')
    expect(prompts[0]!.text).toContain('control_cancel_worker')
    expect(prompts[0]!.text).toContain('control_request_assignment')
    expect(prompts[0]!.text).toContain('control_review_result')
    expect(prompts[0]!.text).toContain('control_review_diff')

    const tool = agent.tools.get('control_project')!
    expect(tool.parameters).toEqual({ type: 'object', additionalProperties: false, properties: {} })
    await expect(tool.execute({}, EXEC)).resolves.toEqual(context)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://control.test/v1/tools/pm/context')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.headers).toEqual({ authorization: 'Bearer pm-token' })
    // A GET must not carry a body at all, not even an empty one.
    expect(calls[0]!.init.body).toBeUndefined()
  })

  it('registers the PM orchestration tools and posts them to the control plane', async () => {
    const root = nodeRoot()
    const { calls, fetch } = recorder(() => jsonAnswer({ delivered: 'running' }))
    const { host, agents } = toolHost({ root, controlUrl: 'http://control.test', fetch })

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      profile: PM_PROFILE, prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })

    const agent = agents.get('pm-1')!
    await agent.tools.get('control_message_worker')!.execute({ ticketId: 'ticket-1', text: 'use the new schema' }, EXEC)
    expect(calls[0]!.url).toBe('http://control.test/v1/tools/pm/message')
    expect(calls[0]!.init).toMatchObject({ method: 'POST',
      headers: { authorization: 'Bearer pm-token', 'content-type': 'application/json' } })
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ ticketId: 'ticket-1', text: 'use the new schema' })

    await agent.tools.get('control_cancel_worker')!.execute({ ticketId: 'ticket-1', assignmentId: 'assignment-1',
      reason: 'the plan changed' }, EXEC)
    expect(calls[1]!.url).toBe('http://control.test/v1/tools/pm/cancel')
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({ ticketId: 'ticket-1', assignmentId: 'assignment-1',
      reason: 'the plan changed' })

    await agent.tools.get('control_request_assignment')!.execute({ ticketId: 'ticket-1' }, EXEC)
    expect(calls[2]!.url).toBe('http://control.test/v1/tools/pm/assignment')
    expect(JSON.parse(calls[2]!.init.body!)).toEqual({ ticketId: 'ticket-1' })

    await agent.tools.get('control_review_result')!.execute({ ticketId: 'ticket-1', assignmentId: 'assignment-1',
      reviewId: 'review-1', action: 'reject', reason: 'the tests are missing' }, EXEC)
    expect(calls[3]!.url).toBe('http://control.test/v1/tools/pm/review')
    expect(JSON.parse(calls[3]!.init.body!)).toEqual({ ticketId: 'ticket-1', assignmentId: 'assignment-1',
      reviewId: 'review-1', action: 'reject', reason: 'the tests are missing' })
  })

  it('refuses a PM orchestration call without the Ticket or the Assignment it names', async () => {
    const root = nodeRoot()
    const { calls, fetch } = recorder(() => jsonAnswer({ delivered: 'running' }))
    const { host, agents } = toolHost({ root, controlUrl: 'http://control.test', fetch })

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      profile: PM_PROFILE, prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })

    const agent = agents.get('pm-1')!
    await expect(agent.tools.get('control_message_worker')!.execute({ text: 'no ticket' }, EXEC))
      .rejects.toThrow('ticketId must be a non-empty string')
    await expect(agent.tools.get('control_cancel_worker')!.execute({ ticketId: 'ticket-1', assignmentId: '  ' }, EXEC))
      .rejects.toThrow('assignmentId must be a non-empty string')
    // A review needs the Assignment whose result it is about, the review it decides, and a rejection needs a reason.
    await expect(agent.tools.get('control_review_result')!.execute({ ticketId: 'ticket-1', action: 'accept' }, EXEC))
      .rejects.toThrow('assignmentId must be a non-empty string')
    await expect(agent.tools.get('control_review_result')!.execute({ ticketId: 'ticket-1', assignmentId: 'assignment-1',
      action: 'accept' }, EXEC)).rejects.toThrow('reviewId must be a non-empty string')
    await expect(agent.tools.get('control_review_result')!.execute({ ticketId: 'ticket-1', assignmentId: 'assignment-1',
      reviewId: 'review-1', action: 'reject' }, EXEC)).rejects.toThrow('a rejection needs a reason')
    await expect(agent.tools.get('control_review_result')!.execute({ ticketId: 'ticket-1', assignmentId: 'assignment-1',
      reviewId: 'review-1', action: 'maybe' }, EXEC)).rejects.toThrow('action must be "accept" or "reject"')
    // Nothing reached the control plane.
    expect(calls).toHaveLength(0)
  })

  it('propagates a refused context read', async () => {
    const root = nodeRoot()
    const { fetch } = recorder(() => jsonAnswer({ error: 'A PM Session token is required' }, 403))
    const { host, agents } = toolHost({ root, controlUrl: 'http://control.test', fetch })
    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      profile: PM_PROFILE, prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })

    await expect(agents.get('pm-1')!.tools.get('control_project')!.execute({}, EXEC))
      .rejects.toThrow('A PM Session token is required')
  })

  it('propagates the control plane refusal instead of swallowing it', async () => {
    const root = nodeRoot()
    const { fetch } = recorder(() => jsonAnswer({ error: 'Unknown ticket ticket-9' }, 400))
    const { host, agents } = toolHost({ root, controlUrl: 'http://control.test', fetch })
    await host.ensureSession({ sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
      profile: WORKER_PROFILE, prompt: WORKER_PROFILE.prompt, sessionToken: 'worker-token', ticketId: 'ticket-1', assignmentId: 'assignment-1' })

    await expect(agents.get('worker-1')!.tools.get('control_report')!.execute({ ticketId: 'ticket-9',
      state: 'progress', summary: 's' }, EXEC)).rejects.toThrow('Unknown ticket ticket-9')
  })

  it('keeps one registration per Agent and refreshes the token on a repeated ensure', async () => {
    const root = nodeRoot()
    const { calls, fetch } = recorder(() => jsonAnswer({ ticket: { id: 'ticket-1' } }))
    const { host, agents } = toolHost({ root, controlUrl: 'http://control.test', fetch })

    await host.ensureSession({ sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
      profile: WORKER_PROFILE, prompt: WORKER_PROFILE.prompt, sessionToken: 'first-token', ticketId: 'ticket-1', assignmentId: 'assignment-1' })
    await host.ensureSession({ sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
      profile: WORKER_PROFILE, prompt: WORKER_PROFILE.prompt, sessionToken: 'second-token', ticketId: 'ticket-1', assignmentId: 'assignment-1' })

    const agent = agents.get('worker-1')!
    // DSH refuses a duplicate tool name in one Agent layer, so the second ensure must not register again.
    expect(agent.registrations).toBe(1)
    await agent.tools.get('control_report')!.execute({ ticketId: 'ticket-1', state: 'progress', summary: 's' }, EXEC)
    expect(calls[0]!.init.headers.authorization).toBe('Bearer second-token')
  })

  it('registers nothing and sends no note without a control URL', async () => {
    const root = nodeRoot()
    const { host, agents, prompts } = toolHost({ root })

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      profile: PM_PROFILE, prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })

    expect(agents.get('pm-1')!.tools.size).toBe(0)
    expect(prompts).toEqual([{ sessionId: 'pm-1', key: 'profile:pm-1', text: PM_PROFILE.prompt }])
  })

  it('fails the ensure when the Agent has no tool registry, so inspection reports why', async () => {
    const root = nodeRoot()
    const sessions = { async ensure(sessionId: string) { return { id: sessionId } }, async prompt() {} }
    const context = { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } }
    const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: 'node-1', root,
      controlUrl: 'http://control.test', fetch: async () => jsonAnswer({}) })

    await expect(host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      profile: PM_PROFILE, prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })).rejects.toThrow('no tool registry')
    await expect(host.inspectSession('pm-1')).resolves.toMatchObject({ sessionId: 'pm-1', found: true, ready: false,
      error: expect.stringContaining('no tool registry') })
  })

  it('drives the real control-plane route from the registered control_report tool', async () => {
    const { project, ticket, assignment, address } = await open()
    const workerSession = `worker-${assignment.id}`
    const root = join(directory, 'node')
    mkdirSync(root, { recursive: true })
    const { host, agents } = toolHost({ root, controlUrl: address.url })

    await host.ensureSession({ sessionId: workerSession, workspace: join(root, project.id), title: 'Worker',
      role: 'worker', prompt: WORKER_PROFILE.prompt, profile: WORKER_PROFILE, sessionToken: tokenOf(workerSession),
      ticketId: ticket.id,
      assignmentId: assignment.id })

    const result = await agents.get(workerSession)!.tools.get('control_report')!
      .execute({ ticketId: ticket.id, state: 'progress', summary: 'from the tool' }, EXEC)

    expect(result).toMatchObject({ ticket: { id: ticket.id } })
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.report)
      .toMatchObject({ state: 'progress', summary: 'from the tool' })
  })
})
