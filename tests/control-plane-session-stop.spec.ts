/**
 * An operator's stop of a Session: how far it reaches, what it leaves running, and what must not bring it back.
 *
 * A PM Session and a Router Session are stopped on their own: the Project of a PM keeps its Tickets and its Workers,
 * and a Router's Tickets and PM Mandates stay as they were. A Worker is stopped through its Ticket, and the two
 * actions — ending one Assignment and cancelling a whole Ticket — are separate.
 *
 * The stop is durable: an ensure, a message, a scheduled task, a report, a reconnect or a restart of the control plane
 * must not bring a stopped Session back. Only an explicit resume does, and it retires the credential that was in
 * circulation during the stop.
 *
 * Every test here runs against the FakeNode: a real DSH node is exercised by the acceptance run in an isolated
 * environment, not by this file.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import type { NodeCommand } from '../src/shared/protocol.ts'

const SECRET = 'session-stop-secret'
const API_TOKEN = 'session-stop-token'
const VIEWER_TOKEN = 'session-stop-viewer'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: ControllableNode
let address = { url: '', port: 0 }

/** A FakeNode whose `session.cancel` a test can refuse, and whose `pm.ensure` a test can hold back. */
class ControllableNode extends FakeNode {
  /** When set, a `session.cancel` to that Session fails with it. */
  readonly cancelFailures = new Map<string, Error>()
  /** When set, a `session.cancel` to that Session is taken but reported with no status of its own. */
  readonly silentCancels = new Set<string>()
  /** When set, a `pm.ensure` for that Session fails with it, and the node holds no such Session afterwards. */
  readonly ensureFailures = new Map<string, Error>()
  /** When set, an `pm.ensure` waits for it before the node answers. */
  gate: Promise<void> | undefined
  /** The commands the node is holding back, so a test can see that they arrived. */
  readonly held: NodeCommand[] = []

  override async send(command: NodeCommand): Promise<void> {
    if (command.type === 'session.cancel') {
      const failure = this.cancelFailures.get(command.sessionId)
      if (failure) throw failure
      if (this.silentCancels.has(command.sessionId)) {
        // The node takes the stop and reports nothing: the receipt is all the control plane gets.
        const session = this.sessions.get(command.sessionId)
        if (session) {
          session.status = 'stopped'
          session.updatedAt = new Date().toISOString()
        }
        return
      }
    }
    if (command.type === 'pm.ensure') {
      const failure = this.ensureFailures.get(command.sessionId)
      if (failure) {
        // The node refused the creation and holds no Session: the control plane must not claim one.
        this.sessions.delete(command.sessionId)
        throw failure
      }
      if (this.gate !== undefined) {
        this.held.push(command)
        await this.gate
      }
    }
    return super.send(command)
  }
}

function post(path: string, body: unknown = {}, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function get(path: string, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

/** Wait for a fact to become true. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A promise a test resolves by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function open(): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-session-stop-'))
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50, ensureSettleTimeoutMs: 100 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
  address = await server.listen(0)
}

/**
 * Open the same control plane again, on the same files.
 *
 * The domain's store and the console's own file are what a restart reads back; the node is the same one, so the node's
 * own Sessions are still there — which is exactly what a restart must not undo.
 */
async function reopen(): Promise<void> {
  const root = join(directory, 'workspaces')
  await control!.close()
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50, ensureSettleTimeoutMs: 100 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
  address = await server.listen(0)
}

/** A Project with its PM Session and `count` Tickets whose Workers run. */
async function projectWithWorkers(count = 2): Promise<{
  projectId: string
  pmSessionId: string
  tickets: { id: string; assignmentId: string; sessionId: string }[]
}> {
  control!.store.triggers.save({ id: 'trigger-1', source: 'internal', threads: [{ source: 'internal', id: 'thread-1' }],
    actor: { source: 'internal', id: 'operator' }, human: true, at: START, text: 'Build it', meta: {} })
  const project = control!.createProject('trigger-1', 'Project', 'Goal')
  const pm = await control!.openProject(project.id)
  const created = control!.engine.createProjectTickets(project.id, pm.sessionId,
    Array.from({ length: count }, (_, index) => ({ title: `Ticket ${index}`, goal: 'Do it' })))
  const tickets: { id: string; assignmentId: string; sessionId: string }[] = []
  for (const ticket of created) {
    const assignment = ticket.assignments.at(-1)!
    await until(() => control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.state === 'running',
      `the Worker of Ticket ${ticket.id} did not start`)
    tickets.push({ id: ticket.id, assignmentId: assignment.id, sessionId: `worker-${assignment.id}` })
  }
  return { projectId: project.id, pmSessionId: pm.sessionId, tickets }
}

/** The Session token the node holds. */
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

describe('the stop of a PM Session', () => {
  it('leaves the Project, its Tickets and its Workers exactly as they were', async () => {
    await open()
    const { projectId, pmSessionId, tickets } = await projectWithWorkers(2)

    const response = await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '这个 PM 先停一下' })
    expect(response.status).toBe(200)
    const answer = await response.json() as { cancelled: boolean; scope: string; confirmed: boolean }
    expect(answer.cancelled).toBe(true)
    expect(answer.scope).toBe('session')
    expect(answer.confirmed).toBe(true)

    // The PM Session is gone on the node.
    expect(node.sessions.get(pmSessionId)?.status).toBe('stopped')
    // The Project is not ended, not paused and not archived: stopping a PM is not a decision about its Project.
    const project = control!.store.projects.get(projectId)!
    expect(project.status).toBe('active')
    expect(project.pauseMode).toBeUndefined()
    // The Tickets are untouched and their Workers keep running.
    for (const ticket of tickets) {
      expect(control!.store.tickets.get(ticket.id)?.ended).toBeUndefined()
      expect(control!.store.tickets.get(ticket.id)?.manualStop).toBeUndefined()
      expect(node.sessions.get(ticket.sessionId)?.status).not.toBe('stopped')
    }
  })

  it('records a notice for the Router that names the work it left running', async () => {
    await open()
    const { pmSessionId, tickets } = await projectWithWorkers(2)

    await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' })

    const response = await get('/v1/console/stops?superiorKind=router')
    expect(response.status).toBe(200)
    const { stops } = await response.json() as { stops: { target: { kind: string; id: string }; scope: string
      state: string; actor: string; affected: string[]; unaffected: string[]; superior: { kind: string } }[] }
    expect(stops).toHaveLength(1)
    const notice = stops[0]!
    expect(notice.target.kind).toBe('session')
    expect(notice.target.id).toBe(pmSessionId)
    expect(notice.scope).toBe('session')
    expect(notice.state).toBe('confirmed')
    expect(notice.actor).toBe('operator')
    expect(notice.superior.kind).toBe('router')
    expect(notice.affected).toEqual([pmSessionId])
    // The notice names the work that keeps running, and nothing of another Project.
    for (const ticket of tickets) {
      expect(notice.unaffected).toContain(ticket.id)
      expect(notice.unaffected).toContain(ticket.sessionId)
    }
    // The Router reads it in its own state: it is the logical superior of a PM Session.
    const routerState = await get('/v1/console/router')
    const router = await routerState.json() as { stops?: { target: { id: string } }[] }
    expect(router.stops).toHaveLength(1)
    expect(router.stops![0]!.target.id).toBe(pmSessionId)
  })

  it('is not undone by an ensure, a message or a scheduled task', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithWorkers(1)
    await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' })

    // The console may not start the PM again.
    expect((await post(`/v1/console/projects/${projectId}/pm`)).status).toBe(409)
    // The low-level ensure refuses too.
    await expect(control!.openProject(projectId)).rejects.toThrow(/stopped by an operator/)
    // The PM takes no message.
    expect((await post(`/v1/console/sessions/${pmSessionId}/message`, { text: '还在吗' })).status).toBe(409)
    await expect(control!.sendMessage(pmSessionId, '还在吗')).rejects.toThrow(/not running/)
    // A scheduled task fails and says why, rather than waking a Session a person put to rest.
    const plan = control!.createSchedule({ projectId, name: 'daily', rule: 'every:1h', message: 'check' })
    const outcome = await control!.scheduler.runNow(plan.id)
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('stopped by an operator')
  })

  it('survives a restart of the control plane', async () => {
    await open()
    const { projectId, pmSessionId, tickets } = await projectWithWorkers(1)
    await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' })

    await reopen()

    // The marker is still there, so the Session is not brought back by anything that follows the restart.
    expect(control!.session(pmSessionId)?.operatorStop?.state).toBe('confirmed')
    await expect(control!.openProject(projectId)).rejects.toThrow(/stopped by an operator/)
    expect((await post(`/v1/console/projects/${projectId}/pm`)).status).toBe(409)
    // The Project's work is exactly where the stop left it.
    expect(control!.store.projects.get(projectId)?.status).toBe('active')
    expect(node.sessions.get(tickets[0]!.sessionId)?.status).not.toBe('stopped')
  })

  it('reports a stop the node did not confirm as not stopped, and keeps the operator\'s intent', async () => {
    await open()
    const { pmSessionId } = await projectWithWorkers(1)
    node.cancelFailures.set(pmSessionId, new Error('the node refused the stop'))

    const response = await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' })
    expect(response.status).toBe(200)
    const answer = await response.json() as { cancelled: boolean; confirmed: boolean; error?: string }
    // The answer does not claim a stop that did not happen.
    expect(answer.cancelled).toBe(false)
    expect(answer.confirmed).toBe(false)
    expect(answer.error).toContain('refused the stop')
    // The operator's intent is kept, open and reconcilable, and the Session stays unusable.
    const stop = control!.session(pmSessionId)?.operatorStop
    expect(stop?.state).toBe('requested')
    expect(stop?.error).toContain('refused the stop')
    expect((await post(`/v1/console/sessions/${pmSessionId}/message`, { text: '还在吗' })).status).toBe(409)
  })
})

describe('the stop of the Router Session', () => {
  it('changes no Ticket and no PM Mandate', async () => {
    await open()
    const { projectId, pmSessionId, tickets } = await projectWithWorkers(1)
    await post('/v1/console/router/message', { text: '你好' })
    const mandate = structuredClone(control!.store.tickets.get(tickets[0]!.id)?.mandate)

    const response = await post('/v1/console/sessions/router/cancel', { reason: '先停一下' })
    expect(response.status).toBe(200)
    const answer = await response.json() as { cancelled: boolean; scope: string }
    expect(answer.cancelled).toBe(true)
    expect(answer.scope).toBe('session')

    // The Router is gone on the node.
    expect(node.sessions.get('router')?.status).toBe('stopped')
    // The Project, its PM and its Ticket are exactly as they were, and the PM Mandate is untouched.
    expect(control!.store.projects.get(projectId)?.status).toBe('active')
    expect(node.sessions.get(pmSessionId)?.status).not.toBe('stopped')
    expect(control!.store.tickets.get(tickets[0]!.id)?.ended).toBeUndefined()
    expect(control!.store.tickets.get(tickets[0]!.id)?.mandate).toEqual(mandate)
  })

  it('keeps the Router from being brought back by a message', async () => {
    await open()
    await post('/v1/console/router/message', { text: '你好' })
    await post('/v1/console/sessions/router/cancel', { reason: '先停一下' })

    expect((await post('/v1/console/router/message', { text: '还在吗' })).status).toBe(409)
    await expect(control!.ensureRouter()).rejects.toThrow(/stopped by an operator/)
    // The Router's own notice is addressed to the operator: it has no Session above it.
    const operatorNotices = await get('/v1/console/stops?superiorKind=operator')
    const { stops } = await operatorNotices.json() as {
      stops: { superior: { kind: string }; target: { id: string } }[]
    }
    expect(stops).toHaveLength(1)
    expect(stops[0]!.superior.kind).toBe('operator')
    expect(stops[0]!.target.id).toBe('router')
  })
})

describe('the stop of a Worker', () => {
  it('ends the Assignment, leaves the Ticket open and keeps the other Worker running', async () => {
    await open()
    const { pmSessionId, tickets } = await projectWithWorkers(2)
    const stopped = tickets[0]!

    const response = await post(`/v1/console/assignments/${stopped.assignmentId}/stop`, { reason: '不做了' })
    expect(response.status).toBe(200)
    const answer = await response.json() as { stopped: boolean; scope: string; confirmed: boolean; ticketId: string }
    expect(answer.stopped).toBe(true)
    expect(answer.scope).toBe('assignment')
    expect(answer.ticketId).toBe(stopped.id)

    // The Assignment ended; the Ticket did not.
    expect(control!.store.tickets.get(stopped.id)?.assignments.at(-1)?.state).toBe('ended')
    expect(control!.store.tickets.get(stopped.id)?.ended).toBeUndefined()
    expect(node.sessions.get(stopped.sessionId)?.status).toBe('stopped')
    // The other Worker of the same Project keeps running.
    expect(node.sessions.get(tickets[1]!.sessionId)?.status).not.toBe('stopped')
    expect(control!.store.tickets.get(tickets[1]!.id)?.assignments.at(-1)?.state).toBe('running')
    // The notice is addressed to the PM, the logical superior of that Worker.
    const pmNotices = await get(`/v1/console/stops?superiorKind=pm&superiorId=${pmSessionId}`)
    const { stops } = await pmNotices.json() as {
      stops: { scope: string; affected: string[]; unaffected: string[] }[]
    }
    expect(stops).toHaveLength(1)
    expect(stops[0]!.scope).toBe('assignment')
    expect(stops[0]!.affected).toContain(stopped.sessionId)
    expect(stops[0]!.unaffected).toContain(tickets[1]!.id)
    // And the PM reads it in its own context, without anything of another Project in it.
    const pmContext = await fetch(`${address.url}/v1/tools/pm/context`,
      { headers: { authorization: `Bearer ${tokenOf(pmSessionId)}` } })
    const context = await pmContext.json() as { stops?: { scope: string; affected: string[] }[] }
    expect(context.stops).toHaveLength(1)
    expect(context.stops![0]!.scope).toBe('assignment')
    expect(context.stops![0]!.affected).toContain(stopped.sessionId)
  })

  it('is not undone by the PM, by an automatic retry or by the low-level paths', async () => {
    await open()
    const { projectId, pmSessionId, tickets } = await projectWithWorkers(1)
    const stopped = tickets[0]!
    await post(`/v1/console/assignments/${stopped.assignmentId}/stop`, { reason: '不做了' })

    // The PM may not revive a Worker a person stopped: only a person may approve the resume.
    const revive = await fetch(`${address.url}/v1/tools/pm/assignment`, { method: 'POST',
      headers: { authorization: `Bearer ${tokenOf(pmSessionId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: stopped.id }) })
    expect(revive.status).toBe(403)
    // And an automatic retry may not replace it either.
    expect(() => control!.engine.retryTicket(stopped.id)).toThrow(/stopped by a person/)

    // The low-level send path does not reach the stopped Worker either.
    expect((await post(`/v1/console/sessions/${stopped.sessionId}/message`, { text: '继续' })).status).toBe(409)
    await expect(control!.sendMessage(stopped.sessionId, '继续')).rejects.toThrow(/not running/)
    // Nor does the low-level ensure: a stopped Worker is not created again behind the operator's back.
    await expect(control!.createWorkerSession(projectId, stopped.assignmentId, stopped.id)).rejects.toThrow(/has ended/)
    expect(node.sessions.get(stopped.sessionId)?.status).toBe('stopped')
  })

  it('refuses a stop of an Assignment a newer one replaced', async () => {
    await open()
    const { projectId, pmSessionId, tickets } = await projectWithWorkers(1)
    const ticket = tickets[0]!
    const old = ticket.assignmentId
    // The person stops the Worker, approves its resume, and the PM starts a new Assignment over it.
    await post(`/v1/console/assignments/${old}/stop`, { reason: '不做了' })
    expect((await post(`/v1/console/tickets/${ticket.id}/resume`)).status).toBe(200)
    const revived = control!.engine.reviveProjectTicket(projectId, pmSessionId, ticket.id)
    const current = revived.assignments.at(-1)!.id
    expect(current).not.toBe(old)

    // The Session of the replaced Assignment cannot stop the Worker that took its place.
    const response = await post(`/v1/console/assignments/${old}/stop`, { reason: '晚了' })
    expect(response.status).toBe(409)
    expect(node.sessions.get(`worker-${current}`)?.status).not.toBe('stopped')
  })

  it('answers a repeated stop with the state it already has', async () => {
    await open()
    const { tickets } = await projectWithWorkers(1)
    const stopped = tickets[0]!
    expect((await post(`/v1/console/assignments/${stopped.assignmentId}/stop`, { reason: '不做了' })).status).toBe(200)

    const again = await post(`/v1/console/assignments/${stopped.assignmentId}/stop`, { reason: '还是不做' })
    expect(again.status).toBe(200)
    const answer = await again.json() as { stopped: boolean; scope: string }
    expect(answer.stopped).toBe(true)
    expect(answer.scope).toBe('assignment')
    expect(node.sessions.get(stopped.sessionId)?.status).toBe('stopped')
  })

  it('ends the whole Ticket when the Ticket itself is cancelled', async () => {
    await open()
    const { tickets } = await projectWithWorkers(2)
    const cancelled = tickets[0]!

    const response = await post(`/v1/console/tickets/${cancelled.id}/cancel`, { reason: '这个工单不做了' })
    expect(response.status).toBe(200)
    const answer = await response.json() as { stopped: boolean; scope: string }
    expect(answer.stopped).toBe(true)
    expect(answer.scope).toBe('ticket')

    expect(control!.store.tickets.get(cancelled.id)?.ended?.outcome).toBe('stopped')
    expect(node.sessions.get(cancelled.sessionId)?.status).toBe('stopped')
    // The other Worker of the same Project keeps running: a Ticket cancel reaches one Ticket only.
    expect(node.sessions.get(tickets[1]!.sessionId)?.status).not.toBe('stopped')
    expect(control!.store.tickets.get(tickets[1]!.id)?.ended).toBeUndefined()
  })

  it('is not undone by a restart of the control plane', async () => {
    await open()
    const { projectId, tickets } = await projectWithWorkers(1)
    const stopped = tickets[0]!
    await post(`/v1/console/assignments/${stopped.assignmentId}/stop`, { reason: '不做了' })

    await reopen()

    // The stop is still there: neither the low-level ensure nor the message path brings the Worker back.
    await expect(control!.createWorkerSession(projectId, stopped.assignmentId, stopped.id)).rejects.toThrow(/has ended/)
    expect(node.sessions.get(stopped.sessionId)?.status).toBe('stopped')
    expect(control!.store.tickets.get(stopped.id)?.assignments.at(-1)?.state).toBe('ended')
  })

  it('stops a standalone Ticket\'s Worker and leaves the notice for the Router', async () => {
    await open()
    const sent = await post('/v1/console/router/message', { text: '帮我做一件事' })
    const { requestId } = await sent.json() as { requestId: string }
    const dispatched = await fetch(`${address.url}/v1/tools/router/dispatch`, { method: 'POST',
      headers: { authorization: `Bearer ${tokenOf('router')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, title: '独立工单', goal: '做完它' }) })
    expect(dispatched.status).toBe(200)
    const { ticket } = await dispatched.json() as { ticket: { id: string } }
    await until(() => control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.state === 'running',
      'the Worker of the standalone Ticket did not start')
    const assignmentId = control!.store.tickets.get(ticket.id)!.assignments.at(-1)!.id
    const sessionId = `worker-${assignmentId}`

    const response = await post(`/v1/console/assignments/${assignmentId}/stop`, { reason: '不做了' })
    expect(response.status).toBe(200)
    expect(node.sessions.get(sessionId)?.status).toBe('stopped')
    // The standalone Ticket stays open: stopping one Worker is not ending its Ticket.
    expect(control!.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    // Its logical superior is the Router, because the Ticket belongs to no Project.
    const routerNotices = await get('/v1/console/stops?superiorKind=router')
    const { stops } = await routerNotices.json() as {
      stops: { scope: string; superior: { kind: string }; affected: string[] }[]
    }
    expect(stops).toHaveLength(1)
    expect(stops[0]!.scope).toBe('assignment')
    expect(stops[0]!.superior.kind).toBe('router')
    expect(stops[0]!.affected).toContain(sessionId)
  })

  it('is not cleared by a soft or a hard pause of the Project', async () => {
    await open()
    const { projectId, pmSessionId, tickets } = await projectWithWorkers(2)
    const stopped = tickets[0]!
    await post(`/v1/console/assignments/${stopped.assignmentId}/stop`, { reason: '不做了' })

    // A Project soft pause keeps the execution going; it does not clear the stop a person put on one Worker.
    const soft = await post(`/v1/console/projects/${projectId}/pause`, { paused: true, mode: 'soft' })
    expect(soft.status).toBe(200)
    expect(control!.store.tickets.get(stopped.id)?.manualStop?.scope).toBe('worker')
    expect(node.sessions.get(tickets[1]!.sessionId)?.status).not.toBe('stopped')

    // A Project hard pause stops the Project's Workers; it does not clear that stop either.
    const hard = await post(`/v1/console/projects/${projectId}/pause`, { paused: true, mode: 'hard' })
    expect(hard.status).toBe(200)
    expect(control!.store.tickets.get(stopped.id)?.manualStop?.scope).toBe('worker')
    // And the PM still may not revive that Worker on its own.
    const revive = await fetch(`${address.url}/v1/tools/pm/assignment`, { method: 'POST',
      headers: { authorization: `Bearer ${tokenOf(pmSessionId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: stopped.id }) })
    expect(revive.status).toBe(403)
  })
})

describe('the resume of a stopped Session', () => {
  it('is the operator\'s own act and retires the credential of the stop', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithWorkers(1)
    const oldToken = tokenOf(pmSessionId)
    await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' })

    const response = await post(`/v1/console/sessions/${pmSessionId}/resume`, { reason: '继续' })
    expect(response.status).toBe(200)
    const answer = await response.json() as { resumed: boolean; session: { sessionId: string }; tokenVersion: number }
    expect(answer.resumed).toBe(true)
    expect(answer.session.sessionId).toBe(pmSessionId)
    expect(answer.tokenVersion).toBeGreaterThanOrEqual(2)

    // The Session works again, under the same id and the same Project.
    expect((await post(`/v1/console/sessions/${pmSessionId}/message`, { text: '继续' })).status).toBe(200)
    expect(control!.store.projects.get(projectId)?.status).toBe('active')
    // The credential that was in circulation during the stop opens nothing after the resume.
    const call = await fetch(`${address.url}/v1/tools/pm/context`, { headers: { authorization: `Bearer ${oldToken}` } })
    expect(call.status).toBe(401)
    // And the new one works.
    const fresh = await fetch(`${address.url}/v1/tools/pm/context`,
      { headers: { authorization: `Bearer ${tokenOf(pmSessionId)}` } })
    expect(fresh.status).toBe(200)
  })

  it('refuses a Session that was not stopped, and a Session that was revoked', async () => {
    await open()
    const { pmSessionId } = await projectWithWorkers(1)

    // Nothing to resume.
    expect((await post(`/v1/console/sessions/${pmSessionId}/resume`)).status).toBe(409)

    await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' })
    await post(`/v1/console/sessions/${pmSessionId}/revoke`, { reason: '换人' })
    // A revocation is for good: a resume must not hand that authority back.
    const resumed = await post(`/v1/console/sessions/${pmSessionId}/resume`)
    expect(resumed.status).toBe(409)
  })

  it('resumes a Worker only through its Ticket, and only once the stop is confirmed', async () => {
    await open()
    const { tickets } = await projectWithWorkers(1)
    const stopped = tickets[0]!
    await post(`/v1/console/assignments/${stopped.assignmentId}/stop`, { reason: '不做了' })

    // The resume clears the person's stop and starts nothing.
    const response = await post(`/v1/console/tickets/${stopped.id}/resume`, { reason: '继续' })
    expect(response.status).toBe(200)
    expect(control!.store.tickets.get(stopped.id)?.manualStop).toBeUndefined()
    expect(node.sessions.get(stopped.sessionId)?.status).toBe('stopped')
  })
})

describe('who may stop and resume a Session', () => {
  it('keeps the viewer token and the Session tokens out of the operator\'s actions', async () => {
    await open()
    const { pmSessionId } = await projectWithWorkers(1)

    // The viewer may read, never write.
    expect((await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' }, VIEWER_TOKEN)).status).toBe(403)
    // A Session token is not the operator's authority.
    expect((await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' },
      tokenOf(pmSessionId))).status).toBe(401)
    expect((await post(`/v1/console/sessions/${pmSessionId}/resume`, { reason: '继续' },
      tokenOf(pmSessionId))).status).toBe(401)
    // The PM's own tools cannot stop or resume either.
    const pmToken = tokenOf(pmSessionId)
    const tool = await fetch(`${address.url}/v1/tools/pm/assignment`, { method: 'POST',
      headers: { authorization: `Bearer ${pmToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: 'any' }) })
    expect(tool.status).not.toBe(200)
  })
})

describe('an ensure that races with a stop', () => {
  it('does not bring the Session back', async () => {
    await open()
    control!.store.triggers.save({ id: 'trigger-1', source: 'internal', threads: [{ source: 'internal', id: 'thread-1' }],
      actor: { source: 'internal', id: 'operator' }, human: true, at: START, text: 'Build it', meta: {} })
    const project = control!.createProject('trigger-1', 'Project', 'Goal')

    // The node holds the creation back, so the stop lands while the ensure is still in flight.
    const gate = deferred()
    node.gate = gate.promise
    const ensure = control!.openProject(project.id)
    const ensured = expect(ensure).rejects.toThrow(/stopped by an operator/)
    await until(() => node.held.some(command => command.type === 'pm.ensure'), 'the PM ensure did not reach the node')

    const stopping = post(`/v1/console/sessions/${project.pmSessionId}/cancel`, { reason: '停' })
    // The creation is released while the stop is on its way, so the two really do overlap.
    setTimeout(() => gate.resolve(), 50)

    const response = await stopping
    expect(response.status).toBe(200)
    // The ensure that was in flight does not answer with a Session the operator stopped.
    await ensured
    // And the node holds no running Session for it.
    expect(node.sessions.get(project.pmSessionId)?.status).toBe('stopped')
    expect(control!.session(project.pmSessionId)?.operatorStop?.state).toBe('confirmed')
  })
})

describe('the resume of a Session that is still stopped', () => {
  it('refuses a Session whose stop the node did not confirm', async () => {
    await open()
    const { pmSessionId } = await projectWithWorkers(1)
    node.cancelFailures.set(pmSessionId, new Error('the node refused the stop'))

    const stopped = await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' })
    expect(stopped.status).toBe(200)
    expect((await stopped.json() as { confirmed: boolean }).confirmed).toBe(false)

    // The Session may still be running, so it is not resumed behind the operator's back.
    const resumed = await post(`/v1/console/sessions/${pmSessionId}/resume`, { reason: '继续' })
    expect(resumed.status).toBe(409)
    // The operator's stop is still there, open and reconcilable.
    const stop = control!.session(pmSessionId)?.operatorStop
    expect(stop?.state).toBe('requested')
    expect(stop?.error).toContain('refused the stop')
  })

  it('keeps the stop when the node cannot bring the Session back', async () => {
    await open()
    const { pmSessionId } = await projectWithWorkers(1)
    await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' })

    // The node refuses the creation the resume needs.
    node.ensureFailures.set(pmSessionId, new Error('the node refused the creation'))
    const resumed = await post(`/v1/console/sessions/${pmSessionId}/resume`, { reason: '继续' })
    expect(resumed.status).not.toBe(200)
    // The Session stays stopped: the resume did not undo the operator's stop.
    expect(control!.session(pmSessionId)?.operatorStop?.state).toBe('confirmed')
    // And it takes no message.
    expect((await post(`/v1/console/sessions/${pmSessionId}/message`, { text: '还在吗' })).status).toBe(409)
  })

  it('refuses the PM of a Project that has ended', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithWorkers(1)
    await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' })
    control!.engine.stopProject(projectId, '这个项目结束了')

    const resumed = await post(`/v1/console/sessions/${pmSessionId}/resume`, { reason: '继续' })
    expect(resumed.status).toBe(409)
    // The stop is untouched: an ended Project gets no PM back.
    expect(control!.session(pmSessionId)?.operatorStop?.state).toBe('confirmed')
  })
})

describe('the Worker the domain stopped', () => {
  it('is not created again, whatever the Session record says', async () => {
    await open()
    const { projectId, pmSessionId, tickets } = await projectWithWorkers(1)
    const ticket = tickets[0]!
    // The PM stops its own Worker: the domain records the stop, and no operator marker exists on the Session.
    control!.engine.stopProjectWorker(projectId, pmSessionId, ticket.id, ticket.assignmentId)
    expect(control!.store.tickets.get(ticket.id)?.manualStop).toBeDefined()

    // The Worker must not be created over a Worker the domain stopped.
    await expect(control!.createWorkerSession(projectId, ticket.assignmentId, ticket.id)).rejects.toThrow(/has ended/)
  })

  it('is not created again for a Ticket that has ended', async () => {
    await open()
    const { projectId, tickets } = await projectWithWorkers(1)
    const ticket = tickets[0]!
    await post(`/v1/console/tickets/${ticket.id}/cancel`, { reason: '不做了' })

    await expect(control!.createWorkerSession(projectId, ticket.assignmentId, ticket.id)).rejects.toThrow(/ended/)
  })

  it('rejects binding an existing Assignment to a different project or ticket', async () => {
    await open()
    const { projectId, tickets } = await projectWithWorkers(1)
    const ticket = tickets[0]!
    const other = control!.createProjectFromOperator('Other project', 'Other scope')
    await expect(control!.createWorkerSession(other.id, ticket.assignmentId, ticket.id))
      .rejects.toThrow(/does not belong/)
    await expect(control!.createWorkerSession(projectId, ticket.assignmentId, 'wrong-ticket'))
      .rejects.toThrow(/does not belong/)
  })

  it('records the confirmation the node\'s own answer is, without waiting for a status', async () => {
    await open()
    const { tickets } = await projectWithWorkers(1)
    const stopped = tickets[0]!
    // The node takes the stop and reports no status of its own: the receipt is all the control plane gets.
    node.silentCancels.add(stopped.sessionId)

    const response = await post(`/v1/console/assignments/${stopped.assignmentId}/stop`, { reason: '不做了' })
    expect(response.status).toBe(200)
    expect((await response.json() as { confirmed: boolean }).confirmed).toBe(true)
    // The receipt is the confirmation: the Session carries a confirmed stop.
    expect(control!.session(stopped.sessionId)?.operatorStop?.state).toBe('confirmed')
  })

  it('clears the open stop of a Worker the operator stops again', async () => {
    await open()
    const { tickets } = await projectWithWorkers(1)
    const stopped = tickets[0]!
    // The first stop is not confirmed: the node refuses it.
    node.cancelFailures.set(stopped.sessionId, new Error('the node refused the stop'))
    const first = await post(`/v1/console/assignments/${stopped.assignmentId}/stop`, { reason: '不做了' })
    expect(first.status).toBe(200)
    expect((await first.json() as { stopped: boolean }).stopped).toBe(false)
    expect(control!.store.tickets.get(stopped.id)?.stopFailure).toBeDefined()

    // The operator stops the same Worker again, and this time the node confirms.
    node.cancelFailures.delete(stopped.sessionId)
    const again = await post(`/v1/console/assignments/${stopped.assignmentId}/stop`, { reason: '还是不做' })
    expect(again.status).toBe(200)
    expect((await again.json() as { stopped: boolean }).stopped).toBe(true)
    // The open stop is gone: the Worker is really gone now, so the Ticket may be resumed.
    const ticket = control!.store.tickets.get(stopped.id)
    expect(ticket?.stopFailure).toBeUndefined()
    expect(ticket?.stopPending).toBeUndefined()
    expect((await post(`/v1/console/tickets/${stopped.id}/resume`)).status).toBe(200)
  })
})
