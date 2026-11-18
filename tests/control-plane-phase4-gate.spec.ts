/**
 * The Phase 4 gate: the faults every coordination path has to survive.
 *
 * Five paths reach a node through the one resolver: the dispatch of a Worker and the handoff of a request, the command
 * on a Session and the intervention in its turn, the report of a Worker or a PM, the digest of a stream and the review
 * of a denial, and the wake-up an external observation caused. Each of them has to survive the same six faults — a
 * target that is gone, a life that was replaced, an authority that was withdrawn, a person who stopped the target, a
 * node that is not there and a receipt that never arrived — and each of them has to say which of the six happened.
 *
 * The faults that a path can reach on its own are checked where the path lives: the coordination of the reports in
 * `control-plane-coordination.spec.ts`, the recovery of the deliveries in `control-plane-delivery-outbox.spec.ts`, the
 * escalation of the denials in `control-plane-denial-escalation.spec.ts`, the digests of a stream in
 * `control-plane-stream-subscriptions.spec.ts` and the wake-ups of an external event in
 * `control-plane-event-subscriptions.spec.ts`. What is left — and what this file holds — are the two cells no path
 * covered on its own: a node that is not there, and the handoff that was on its way when the control plane stopped.
 *
 * The crash is injected the way the accepted P4-5 run injected it: the durable row is written back to the state the
 * process died in, and the control plane is started again on the very same file. Nothing else is faked — the node is a
 * real FakeNode, the transport is the real one, and the SQLite file is closed and reopened.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SQLInputValue } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket, Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { NodeUnconfirmedError, type NodeCommand } from '../src/shared/protocol.ts'

const SECRET = 'phase4-gate-secret'
const API_TOKEN = 'phase4-gate-token'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'
/** The request a person makes: it names the Project, so the rule layer leaves it to the Router. */
const REQUEST = '请在「周报整理」补充本周数据'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: ControllableNode
/** The clock of the control plane. */
let clock = START

function trigger(id: string): Trigger {
  return { id, source: 'main-session', threads: [{ source: 'main-session', id: `thread-${id}` }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

/** Wait for an asynchronous callback to settle. */
async function until(predicate: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * A FakeNode whose `session.message` a test can refuse, lose or refuse to confirm.
 *
 * The three are different facts for the superior: a message that was refused never happened, a message whose receipt
 * was lost may have arrived, and a message that went out is a fact the node can prove.
 */
class ControllableNode extends FakeNode {
  /** When set, a `session.message` to that Session fails with it. */
  readonly failures = new Map<string, Error>()

  override async send(command: NodeCommand): Promise<void> {
    if (command.type === 'session.message') {
      const failure = this.failures.get(command.sessionId)
      if (failure) throw failure
    }
    return super.send(command)
  }
}

interface Opened {
  project: ProjectProfile
  pm: { sessionId: string }
  ticket: Ticket
  assignment: Assignment
  worker: string
  address: { url: string }
}

/**
 * A Project whose PM and first Worker Session exist on the FakeNode, plus the tool API listening on a random port.
 */
async function open(): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-phase4-gate-'))
  clock = START
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => clock, confirmationTimeoutMs: 50 })
  await control.registerNode()
  control.store.triggers.save(trigger('trigger-1'))
  const project = control.createProject('trigger-1', '周报整理', 'Goal')
  const pm = await control.openProject(project.id)
  const [created] = control.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Ticket', goal: 'Do it' }])
  const assignment = created!.assignments[0]!
  await until(() => control!.store.tickets.get(created!.id)?.assignments.at(-1)?.state === 'running',
    'the Assignment did not start')
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  const address = await server.listen(0)
  return { project, pm, ticket: control.store.tickets.get(created!.id)!, assignment,
    worker: `worker-${assignment.id}`, address }
}

/** Start the control plane again on the same file, as a restart of the process would. */
async function restart(): Promise<void> {
  await server!.close()
  server = undefined
  await control!.close()
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces'), now: () => clock, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  await server.listen(0)
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

/** One Worker report, sent through the tool API the node uses. */
function report(address: { url: string }, worker: string, ticketId: string, assignmentId: string,
  state: string, summary: string, callKey: string): Promise<Response> {
  return post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId, assignmentId,
    report: { state, summary }, callKey })
}

/** The durable record of one delivery, as the table holds it. */
function rowOf(deliveryId: string): Record<string, unknown> {
  const row = control!.store.db.prepare('SELECT * FROM coordination_deliveries WHERE delivery_id = ?')
    .get(deliveryId) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error(`There is no delivery ${deliveryId}`)
  return row
}

/** Write a fact into the table, as a fault injection would. */
function writeRow(patch: Record<string, unknown>, deliveryId: string): void {
  const keys = Object.keys(patch)
  const values = keys.map(key => patch[key] as SQLInputValue)
  control!.store.db.prepare(`UPDATE coordination_deliveries SET ${keys.map(key => `${key} = ?`).join(', ')} `
    + 'WHERE delivery_id = ?').run(...values, deliveryId)
}

/** The delivery of one kind, the one the table holds. */
function deliveryOf(kind: string): Record<string, unknown> {
  const row = control!.store.db.prepare('SELECT * FROM coordination_deliveries WHERE kind = ? ORDER BY seq')
    .get(kind) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error(`There is no delivery of the kind ${kind}`)
  return row
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the node that is not there', () => {
  it('blocks a report whose PM is unreachable, and keeps the target it named', async () => {
    const { pm, ticket, assignment, worker, address } = await open()

    // The node went away underneath the control plane: the command that would leave for it may not.
    await control!.heartbeat(false)

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'needs a person', 'call-1')).status).toBe(200)
    await until(() => control!.coordinationDeliveries()[0]?.status !== 'accepted_pending',
      'the delivery was not settled')

    // The report itself was written: only the delivery waits. The PM was not woken, and the node got nothing.
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.summary).toBe('needs a person')
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
    const delivery = control!.coordinationDeliveries()[0]!
    expect(delivery).toMatchObject({ status: 'blocked_node_unavailable', targetSessionId: pm.sessionId })
    expect(delivery.error).toMatch(/offline/i)
  })

  it('blocks the wake-up an external observation caused, and keeps the subscription alive', async () => {
    const { worker, address } = await open()

    // A Worker may watch itself: the event wakes its own Assignment and nobody else.
    const created = await post(address, '/v1/tools/external/subscriptions', tokenOf(worker),
      { sourceId: 'synthetic-sms', eventTypes: ['sms.received'],
        fields: [{ path: 'text', op: 'contains', value: 'the build broke' }], targetSessionId: worker })
    expect(created.status).toBe(200)

    await control!.heartbeat(false)
    const emitted = await post(address, '/v1/console/events/synthetic-emit', API_TOKEN,
      { sourceId: 'synthetic-sms', eventId: 'evt-1', eventType: 'sms.received', payload: { text: 'the build broke' } })
    expect(emitted.status).toBe(200)
    const result = (await emitted.json()) as { result?: { delivered?: string[]; blocked?: string[] } }

    // The Worker was not woken: the event waits for the node to be back, and the subscription is not over.
    expect(result.result?.delivered ?? []).toHaveLength(0)
    expect(result.result?.blocked ?? []).toHaveLength(1)
    expect(node.messages.get(worker)).toBeUndefined()
    const row = control!.store.db.prepare('SELECT status, reason FROM external_event_subscriptions').get() as
      Record<string, unknown>
    expect(String(row['status'])).not.toBe('expired_by_scope')
  })

  it('leaves a denial review pending and wakes nobody', async () => {
    const { pm, worker } = await open()

    // The node is gone before the refusals arrive: a fact that already arrived is not refused by the liveness of the
    // other direction, but nothing may leave for the superior.
    await control!.heartbeat(false)
    for (let index = 0; index < 3; index += 1) {
      const turn = node.holdTurn(worker)
      node.simulateGuardDenial(worker, 'write', 'ROLE_TOOL_DENIED', { turnId: String(turn), callId: `call-${index}` })
      await control!.settleDenials()
    }
    await until(() => control!.denialReviews().length === 1, 'the review was not made')

    // The review waits for the superior to be reachable, and nobody was woken.
    const review = control!.denialReviews()[0]!
    expect(review.status).toBe('pending_manager_online')
    expect(review.targetSessionId).toBe(pm.sessionId)
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
    // Nothing went on the wire, so there is no delivery of it.
    expect(control!.coordinationDeliveries().filter(row => row.kind === 'denial_review')).toHaveLength(0)
  })

  it('keeps the digest of a stream for the moment the node is back', async () => {
    const { pm, worker, address } = await open()

    const subscribed = await post(address, '/v1/tools/stream/subscribe', tokenOf(pm.sessionId), { sessionId: worker })
    expect(subscribed.status).toBe(200)
    node.simulateToolFact(worker, 'write', 'succeeded', { changedPaths: ['src/answer.ts'] })
    node.simulateMessage(worker, 'assistant', 'The answer is written.')

    await control!.heartbeat(false)
    clock = new Date(Date.parse(START) + 5 * 60_000).toISOString()
    await control!.runStreamDigests()

    await until(() => control!.coordinationDeliveries().some(row => row.kind === 'stream_digest'),
      'the digest was not recorded')
    // The digest never left this control plane, and the superior was not woken: the range waits for the next tick.
    const digest = control!.coordinationDeliveries().find(row => row.kind === 'stream_digest')!
    expect(digest.status).toBe('accepted_pending')
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
    const row = control!.store.db.prepare('SELECT digest_status, digest_reason FROM session_stream_subscriptions')
      .get() as Record<string, unknown>
    expect(String(row['digest_status'])).toBe('failed')
    expect(String(row['digest_reason'])).toMatch(/offline/i)
  })
})

describe('the handoff that was on its way', () => {
  /** The Router hands a request to the PM of a Project, and the delivery of that handoff is written down. */
  async function handOff(address: { url: string }): Promise<string> {
    await control!.ensureRouter()
    const asked = await post(address, '/v1/console/router/message', API_TOKEN, { text: REQUEST })
    const request = (await asked.json()) as { requestId: string }
    const handed = await post(address, '/v1/tools/router/pm-handoff', tokenOf('router'),
      { requestId: request.requestId, decision: { projectId: (await control!.projects())[0]!.id,
        instruction: REQUEST, rationale: '请求点名了周报整理这个项目。' } })
    expect(handed.status).toBe(200)
    await until(() => control!.coordinationDeliveries().some(row => row.kind === 'auto_handoff'),
      'the handoff was not recorded')
    return request.requestId
  }

  it('sends a handoff that never left the control plane again under the very key the node knows it by', async () => {
    const { pm, address } = await open()
    const requestId = await handOff(address)
    const delivery = deliveryOf('auto_handoff')
    expect(delivery['status']).toBe('delivered_inbox')

    // The control plane died before the message left it: the record says the delivery never went out, and the handoff
    // is still on its way.
    writeRow({ status: 'accepted_pending', attempt_count: 0, dispatched_at: '' }, String(delivery['delivery_id']))
    control!.consoleStore.updateRouterHandoff(requestId, { stage: 'routing' })
    await restart()

    const after = deliveryOf('auto_handoff')
    expect(after['status']).toBe('delivered_inbox')
    expect(after['attempt_count']).toBe(1)
    expect(after['resend_count']).toBe(0)
    // The node was asked to execute the very same key again, so the work itself arrives once and not twice.
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(1)
    expect(control!.consoleStore.routerHandoff(requestId)?.stage).toBe('assigned')
  })

  it('closes a handoff whose PM lost its authority, and sends nothing', async () => {
    const { pm, address } = await open()
    const requestId = await handOff(address)
    const delivery = deliveryOf('auto_handoff')
    writeRow({ status: 'accepted_pending', attempt_count: 0, dispatched_at: '' }, String(delivery['delivery_id']))
    control!.consoleStore.updateRouterHandoff(requestId, { stage: 'routing' })

    // The PM that was to hear the work lost its authority: the work may not reach it any more.
    await control!.revokeSession(pm.sessionId, '换人')
    await restart()

    const after = deliveryOf('auto_handoff')
    expect(after['status']).toBe('rejected_stale_or_revoked')
    expect(String(after['error'])).toContain('revoked')
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(1)
  })

  it('closes a handoff whose PM a person stopped, and sends nothing', async () => {
    const { pm, address } = await open()
    const requestId = await handOff(address)
    const delivery = deliveryOf('auto_handoff')
    writeRow({ status: 'accepted_pending', attempt_count: 0, dispatched_at: '' }, String(delivery['delivery_id']))
    control!.consoleStore.updateRouterHandoff(requestId, { stage: 'routing' })

    // A Session a person put to rest is never brought back by a handoff.
    await control!.stopSessionByOperator(pm.sessionId, '停')
    await restart()

    const after = deliveryOf('auto_handoff')
    expect(after['status']).toBe('blocked_target_inactive')
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(1)
  })

  it('closes a handoff whose Project is no longer active, and sends nothing', async () => {
    const { project, pm, address } = await open()
    const requestId = await handOff(address)
    const delivery = deliveryOf('auto_handoff')
    writeRow({ status: 'accepted_pending', attempt_count: 0, dispatched_at: '' }, String(delivery['delivery_id']))
    control!.consoleStore.updateRouterHandoff(requestId, { stage: 'routing' })

    await control!.pauseProject(project.id, true)
    await restart()

    const after = deliveryOf('auto_handoff')
    expect(after['status']).toBe('blocked_target_inactive')
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(1)
  })

  it('never sends a handoff again whose receipt was lost', async () => {
    const { pm, address } = await open()

    // The node took the message and never confirmed it: the outcome is unknown, and an unknown outcome is never a
    // licence to send the message again.
    node.failures.set(pm.sessionId, new NodeUnconfirmedError('the node did not confirm the delivery'))
    const requestId = await handOff(address)

    const delivery = deliveryOf('auto_handoff')
    expect(delivery['status']).toBe('unconfirmed')
    expect(control!.consoleStore.routerHandoff(requestId)?.stage).toBe('unconfirmed')

    await restart()
    const after = deliveryOf('auto_handoff')
    expect(after['status']).toBe('unconfirmed')
    expect(after['resend_count']).toBe(0)
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(0)
  })
})
