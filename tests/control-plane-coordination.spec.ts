/**
 * The coordination of the reports a Worker and a PM make.
 *
 * A report is routed to the Session that has to act on it — the PM of the Worker's own Project, or the Router for a
 * standalone Worker — and the delivery is recorded durably, so a restart neither loses the record nor repeats the
 * delivery. An ordinary progress report waits for its interval when one is configured and keeps only the newest value;
 * every other report is a state change and goes out at once.
 *
 * The three generations are kept apart: the node's trust, the Assignment's lifecycle and the credential's own version.
 * A refresh of a credential is not a change of life, so it never invalidates a delivery — and a stop and an explicit
 * resume are a change of life, so a delivery that was queued for the old one is refused.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket, Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer, startFetchControlPlane } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { NodeUnconfirmedError, type NodeCommand } from '../src/shared/protocol.ts'

const SECRET = 'coordination-secret'
const API_TOKEN = 'coordination-api-token'
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

/** Wait for an asynchronous callback and a delivery to settle. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * A FakeNode whose `session.message` a test can hold, refuse or lose.
 *
 * A message that is on its way and a message the node refused are different facts for the PM: the first is unknown
 * until its receipt arrives, the second never happened.
 */
class ControllableNode extends FakeNode {
  /** The messages that wait for the test to let them go. */
  private readonly holds = new Map<string, Promise<void>>()
  /** When set, a `session.message` to that Session fails with it. */
  readonly failures = new Map<string, Error>()
  /** The ensures that wait for the test to let them go. */
  private ensureHold: Promise<void> | undefined
  /** The kinds of the ensures that are held right now. */
  readonly heldEnsures: string[] = []

  /** Hold every message to one Session until the returned function is called. */
  hold(sessionId: string): () => void {
    let release = (): void => {}
    const waiting = new Promise<void>(resolve => { release = () => resolve(undefined) })
    this.holds.set(sessionId, waiting)
    return release
  }

  /** Hold every ensure the control plane sends until the returned function is called. */
  holdEnsures(): () => void {
    let release = (): void => {}
    const waiting = new Promise<void>(resolve => { release = () => resolve(undefined) })
    this.ensureHold = waiting
    return release
  }

  override async send(command: NodeCommand): Promise<void> {
    if (command.type === 'session.message') {
      const failure = this.failures.get(command.sessionId)
      if (failure) throw failure
      const held = this.holds.get(command.sessionId)
      if (held) await held
    }
    const ensureHold = this.ensureHold
    if (ensureHold !== undefined && (command.type === 'pm.ensure' || command.type === 'router.ensure')) {
      this.heldEnsures.push(command.type)
      await ensureHold
    }
    return super.send(command)
  }
}

interface Opened {
  project: ProjectProfile
  pm: { sessionId: string }
  ticket: Ticket
  assignment: Assignment
  address: { url: string }
}

/**
 * A Project whose PM and first Worker Session exist on the FakeNode, plus the tool API listening on a random port.
 *
 * `progressIntervalMs` is the throttle of the ordinary progress reports; `now` is the clock of the control plane, which
 * a test moves when a delivery has to wait for its interval.
 */
async function open(options: { progressIntervalMs?: number; now?: () => string } = {}): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-coordination-'))
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: options.now ?? (() => START), confirmationTimeoutMs: 50,
    ...(options.progressIntervalMs === undefined ? {} : { reportProgressIntervalMs: options.progressIntervalMs }) })
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

/** Start the control plane again on the same file, as a restart of the process would. */
async function restart(): Promise<{ url: string }> {
  await server!.close()
  server = undefined
  await control!.close()
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces'), now: () => START, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  return server.listen(0)
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
  state: string, summary: string, callKey?: string): Promise<Response> {
  return post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId, assignmentId,
    report: { state, summary }, ...(callKey === undefined ? {} : { callKey }) })
}

/** The durable record of one delivery, as the table holds it. */
function recordOf(deliveryId: string): Record<string, unknown> {
  const row = control!.store.db.prepare('SELECT * FROM coordination_deliveries WHERE delivery_id = ?')
    .get(deliveryId) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error(`There is no delivery ${deliveryId}`)
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

describe('the coordination of a Worker report', () => {
  it('delivers a blocked report to the PM of its own Project and records where it went', async () => {
    const { project, pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision',
      'call-1')).status).toBe(200)
    await until(() => (node.messages.get(pm.sessionId)?.length ?? 0) > 0, 'the PM was not notified')
    await until(() => control!.pmNotifications()[0]?.state === 'sent', 'the delivery was not recorded as sent')

    // The record names the target, the source and the node the report came from, and says it reached the inbox.
    const delivery = control!.coordinationDeliveries()[0]!
    expect(delivery).toMatchObject({ kind: 'worker_report', status: 'delivered_inbox',
      projectId: project.id, ticketId: ticket.id, assignmentId: assignment.id, reportKind: 'blocked',
      sourceSessionId: worker, targetSessionId: pm.sessionId, targetRole: 'pm',
      nodeId: NODE_ID, backendId: 'dsh', attemptCount: 1 })
    // The three generations are kept apart: a PM that never restarted has no lifecycle generation of its own, the node's
    // trust has moved on since this control plane started, and the credential was never replaced.
    expect(delivery.expectedAssignmentEpoch).toBe(0)
    expect(delivery.expectedNodeTrustEpoch).toBeGreaterThan(0)
    expect(delivery.expectedToolTokenVersion).toBe(0)

    // The message itself names the source of the report, so the PM knows where the fact came from.
    const message = node.messages.get(pm.sessionId)![0]!
    expect(message).toContain(`Reported by node: ${NODE_ID}`)
    expect(message).toContain('Reported by backend: dsh')
  })

  it('never lets a report reach a Session that has no business reading it', async () => {
    const { project, pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const otherPm = await control!.openProject(other.id)
    const [foreign] = control!.engine.createProjectTickets(other.id, otherPm.sessionId, [{ title: 'Foreign', goal: 'G' }])
    await until(() => control!.store.tickets.get(foreign!.id)?.assignments.at(-1)?.state === 'running',
      'the foreign Assignment did not start')

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'only here', 'call-1')).status).toBe(200)
    await until(() => (node.messages.get(pm.sessionId)?.length ?? 0) > 0, 'the PM was not notified')

    // The other Project's PM heard nothing, and the Router heard nothing either: the report belongs to this Project.
    expect(node.messages.get(otherPm.sessionId)).toBeUndefined()
    expect(node.messages.get('router')).toBeUndefined()
    expect(control!.coordinationDeliveries()[0]).toMatchObject({ targetSessionId: pm.sessionId, projectId: project.id })
  })

  it('holds an ordinary progress report back when an interval is configured, and keeps only the newest value', async () => {
    const { pm, ticket, assignment, address } = await open({ progressIntervalMs: 60_000 })
    const worker = `worker-${assignment.id}`

    // The first progress report has nothing to wait for: it goes out at once.
    expect((await report(address, worker, ticket.id, assignment.id, 'progress', 'first step', 'call-1')).status).toBe(200)
    await until(() => (node.messages.get(pm.sessionId)?.length ?? 0) > 0, 'the first progress was not delivered')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the first progress was not recorded')

    // The next one arrives inside the interval: it waits, and only the newest value is kept.
    expect((await report(address, worker, ticket.id, assignment.id, 'progress', 'second step', 'call-2')).status).toBe(200)
    await until(() => control!.coordinationDeliveries().length > 1, 'the second progress was not recorded')
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
    const held = control!.coordinationDeliveries().find(row => row.status === 'accepted_pending')!
    expect(held).toMatchObject({ reportKind: 'progress', status: 'accepted_pending', targetSessionId: pm.sessionId })
    expect(held.dueAt).not.toBe('')
    // The held-back delivery is the newest one, and it carries the newest text.
    expect(recordOf(held.deliveryId).payload).toContain('second step')
    // The report itself is written: only the delivery waits.
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.summary).toBe('second step')
  })

  it('delivers a report whose target an operator stopped to nobody, and says the target was blocked', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    await control!.stopSessionByOperator(pm.sessionId, '停')

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'needs a person', 'call-1')).status).toBe(200)
    await until(() => control!.coordinationDeliveries()[0]?.status !== 'accepted_pending', 'the delivery was not settled')

    // The PM was not woken: a Session a person put to rest is never brought back by a report.
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
    expect(control!.pmNotifications()[0]).toMatchObject({ state: 'skipped' })
    const delivery = control!.coordinationDeliveries()[0]!
    expect(delivery).toMatchObject({ status: 'blocked_target_inactive', targetSessionId: pm.sessionId })
    expect(delivery.error).toContain('stopped by an operator')
  })

  it('keeps the record of a delivery across a restart and does not deliver the same report twice', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision',
      'call-1')).status).toBe(200)
    await until(() => (node.messages.get(pm.sessionId)?.length ?? 0) > 0, 'the PM was not notified')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery was not recorded')

    const restarted = await restart()

    // The record is still there: the console can show what happened and when.
    expect(control!.coordinationDeliveries()[0]).toMatchObject({ status: 'delivered_inbox',
      ticketId: ticket.id, assignmentId: assignment.id, targetSessionId: pm.sessionId })

    // The same report again is the same fact: the superior is not woken a second time.
    expect((await report(restarted, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision',
      'call-1')).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
  })

  it('does not deliver a report twice when the same content arrives under a new call', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'the same words', 'call-1')).status).toBe(200)
    await until(() => (node.messages.get(pm.sessionId)?.length ?? 0) > 0, 'the PM was not notified')
    await until(() => control!.pmNotifications()[0]?.state === 'sent', 'the delivery was not recorded as sent')

    // A different call with the same words is one fact: the PM already knows it.
    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'the same words', 'call-2')).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
    expect(control!.pmNotifications()[0]).toMatchObject({ state: 'skipped' })
    expect(control!.pmNotifications()[0]!.reason).toContain('already knows')
  })
})

describe('the throttle of the ordinary progress reports', () => {
  it('holds an ordinary progress report back by default', async () => {
    // The default is a minute: a Worker that reports after every step does not wake its superior for every step.
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    expect((await report(address, worker, ticket.id, assignment.id, 'progress', 'first step', 'call-1')).status).toBe(200)
    await until(() => (node.messages.get(pm.sessionId)?.length ?? 0) > 0, 'the first progress was not delivered')
    expect((await report(address, worker, ticket.id, assignment.id, 'progress', 'second step', 'call-2')).status).toBe(200)
    await until(() => control!.coordinationDeliveries().length > 1, 'the second progress was not recorded')

    const held = control!.coordinationDeliveries().find(row => row.status === 'accepted_pending')!
    expect(held).toMatchObject({ reportKind: 'progress', targetSessionId: pm.sessionId })
    expect(held.dueAt).not.toBe('')
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
  })

  it('reads SUPERAGENT_REPORT_PROGRESS_INTERVAL_MS at startup and fails fast on an invalid value', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-coordination-start-'))
    const root = join(directory, 'workspaces')
    const env = { SUPERAGENT_CONTROL_TOKEN: API_TOKEN, SUPERAGENT_CONTROL_DB: join(directory, 'control.sqlite'),
      SUPERAGENT_WORKSPACE_ROOT: root, SUPERAGENT_NODE_ID: NODE_ID, SUPERAGENT_CONTROL_PORT: '0' }

    for (const value of ['soon', '-1', '1.5']) {
      await expect(startFetchControlPlane({ env: { ...env, SUPERAGENT_REPORT_PROGRESS_INTERVAL_MS: value },
        node: new FakeNode({ nodeId: NODE_ID, root, now: () => START }), heartbeatMs: 0 }))
        .rejects.toThrow('SUPERAGENT_REPORT_PROGRESS_INTERVAL_MS is invalid')
    }

    const started = await startFetchControlPlane({ env: { ...env, SUPERAGENT_REPORT_PROGRESS_INTERVAL_MS: '0' },
      node: new FakeNode({ nodeId: NODE_ID, root, now: () => START }), heartbeatMs: 0 })
    try {
      // The setting is the throttle of the ordinary progress reports: zero delivers every one of them at once.
      expect(started.control.reportProgressIntervalMs).toBe(0)
    } finally {
      await started.close()
    }
  })

  it('holds a second progress report back while the first one is still on its way', async () => {
    const { pm, ticket, assignment, address } = await open({ progressIntervalMs: 60_000 })
    const worker = `worker-${assignment.id}`
    const release = node.hold(pm.sessionId)

    expect((await report(address, worker, ticket.id, assignment.id, 'progress', 'first step', 'call-1')).status).toBe(200)
    // The first report is on its way: the delivery is claimed, and its receipt has not arrived yet.
    await until(() => control!.coordinationDeliveries()[0]?.status === 'dispatching', 'the first delivery was not claimed')
    // The deliveries are read newest first, so the one that is on its way is named while it is the only one.
    const first = control!.coordinationDeliveries()[0]!.deliveryId

    expect((await report(address, worker, ticket.id, assignment.id, 'progress', 'second step', 'call-2')).status).toBe(200)
    await until(() => control!.coordinationDeliveries().length > 1, 'the second report was not recorded')

    // The second report waits: the interval is measured from the delivery that is really on its way, not only from the
    // ones the node confirmed.
    const held = control!.coordinationDeliveries().find(row => row.status === 'accepted_pending')!
    expect(held).toMatchObject({ reportKind: 'progress', targetSessionId: pm.sessionId })
    expect(held.dueAt).not.toBe('')

    release()
    await until(() => control!.coordinationDeliveries().find(row => row.deliveryId === first)?.status === 'delivered_inbox',
      'the first delivery did not land')
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
  })

  it('never sends a held progress report after the fact that replaced it', async () => {
    const { pm, ticket, assignment, address } = await open({ progressIntervalMs: 60_000 })
    const worker = `worker-${assignment.id}`

    // The first progress report goes at once: it has nothing to wait for.
    expect((await report(address, worker, ticket.id, assignment.id, 'progress', 'first step', 'call-1')).status).toBe(200)
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the first progress was not delivered')

    // The second one waits for the interval.
    expect((await report(address, worker, ticket.id, assignment.id, 'progress', 'second step', 'call-2')).status).toBe(200)
    await until(() => control!.coordinationDeliveries().length > 1, 'the second progress was not recorded')

    // A blocker arrives: it is a state change the PM has to see at once.
    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'needs a decision', 'call-3')).status).toBe(200)
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the blocker was not delivered')

    // The held progress was taken by the blocker: it is never sent, so the PM never reads an old fact after the new one.
    const held = control!.coordinationDeliveries().find(row => row.reportKind === 'progress' && row.status !== 'delivered_inbox')!
    expect(held.status).toBe('superseded')
    const messages = (node.messages.get(pm.sessionId) ?? []).join('\n')
    expect(messages).toContain('first step')
    expect(messages).toContain('needs a decision')
    expect(messages).not.toContain('second step')
  })
})

describe('the durable record of a delivery', () => {
  it('keeps an unconfirmed delivery unconfirmed across a restart, and never sends it again', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    // The node took the message and never confirmed it: the outcome is unknown.
    node.failures.set(pm.sessionId, new NodeUnconfirmedError('the node did not answer the message'))

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'needs a decision', 'call-1')).status).toBe(200)
    await until(() => control!.coordinationDeliveries()[0]?.status === 'unconfirmed', 'the delivery was not left unconfirmed')

    const restarted = await restart()

    // The record is still there, and the outcome is still unknown.
    expect(control!.coordinationDeliveries()[0]).toMatchObject({ status: 'unconfirmed' })

    // The same fact under a new call is not sent again: the message may have landed, and a second copy is not a repair.
    expect((await report(restarted, worker, ticket.id, assignment.id, 'blocked', 'needs a decision', 'call-2')).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
    expect(control!.coordinationDeliveries()[0]).toMatchObject({ status: 'unconfirmed' })
  })

  it('refuses a delivery that was queued before the target was stopped and resumed', async () => {
    let clock = START
    const { pm, ticket, assignment, address } = await open({ progressIntervalMs: 3000, now: () => clock })
    const worker = `worker-${assignment.id}`

    // The first progress report goes at once.
    expect((await report(address, worker, ticket.id, assignment.id, 'progress', 'first step', 'call-1')).status).toBe(200)
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the first progress was not delivered')
    // The second one waits for the interval.
    expect((await report(address, worker, ticket.id, assignment.id, 'progress', 'second step', 'call-2')).status).toBe(200)
    await until(() => control!.coordinationDeliveries().length > 1, 'the second progress was not recorded')
    const held = control!.coordinationDeliveries().find(row => row.status === 'accepted_pending')!

    // A person stops the PM and resumes it: the Session comes back with a new life.
    await control!.stopSessionByOperator(pm.sessionId, '休息')
    await control!.resumeSessionByOperator(pm.sessionId, '继续')
    // The clock moves past the interval, so the queued report is due.
    clock = new Date(Date.parse(START) + 60_000).toISOString()

    // The queued report belonged to the life that is over: it is refused when it goes out.
    await until(() => control!.coordinationDeliveries().find(row => row.deliveryId === held.deliveryId)?.status
      === 'rejected_stale_or_revoked', 'the queued delivery was not refused', 10_000)
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
  })

  it('refuses a report whose source moved on while the target was ensured again', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    // The node came back: the PM's record is confirmed under an older generation, so the delivery has to ensure the
    // Session again before the message goes out.
    control!.nodeReconnected()
    const release = node.holdEnsures()

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'needs a decision', 'call-1')).status).toBe(200)
    await until(() => node.heldEnsures.length > 0, 'the target was not ensured again')

    // While the ensure is on its way, the work the report was about moves on: a newer Assignment took it.
    const record = control!.store.tickets.get(ticket.id)!
    control!.store.tickets.save({ ...record, assignments: [...record.assignments,
      { id: 'assignment-newer', state: 'running', createdAt: START }] })

    release()
    // The report is about a Worker that does not run any more: it is refused at the last moment before the wire, and
    // the PM never hears it.
    await until(() => control!.coordinationDeliveries()[0]?.status === 'rejected_stale_or_revoked',
      'the delivery was not refused', 10_000)
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
  })

  it('refuses a report whose Worker lost its authority while the target was ensured again', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    // The node came back: the PM's record is confirmed under an older generation, so the delivery has to ensure the
    // Session again before the message goes out.
    control!.nodeReconnected()
    const release = node.holdEnsures()

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'needs a decision', 'call-1')).status).toBe(200)
    await until(() => node.heldEnsures.length > 0, 'the target was not ensured again')

    // While the ensure is on its way, the Worker that made the report loses its authority.
    control!.session(worker)!.revokedAt = START

    release()
    // The report has no source any more: it is refused at the last moment before the wire, and the PM never hears it.
    await until(() => control!.coordinationDeliveries()[0]?.status === 'rejected_stale_or_revoked',
      'the delivery was not refused', 10_000)
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
  })

  it('refuses a delivery whose target lost its authority while it was ensured again', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    // The node came back: the PM's record is confirmed under an older generation, so the delivery has to ensure the
    // Session again before the message goes out.
    control!.nodeReconnected()
    const release = node.holdEnsures()

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'needs a decision', 'call-1')).status).toBe(200)
    await until(() => node.heldEnsures.length > 0, 'the target was not ensured again')

    // While the ensure is on its way, the PM Session is bound to another node: the record and the node no longer agree.
    control!.session(pm.sessionId)!.nodeId = 'other-node'

    release()
    // The target has no authority here any more: the wake-up is refused before it goes out, and the PM never hears it.
    await until(() => control!.coordinationDeliveries()[0]?.status === 'rejected_stale_or_revoked',
      'the delivery was not refused', 10_000)
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
  })

  it('holds a report back when the Project is paused while the delivery is on its way, and sends it on the resume',
    async () => {
      const { project, pm, ticket, assignment, address } = await open()
      const worker = `worker-${assignment.id}`
      // The node came back: the PM's record is confirmed under an older generation, so the delivery has to ensure the
      // Session again before the message goes out.
      control!.nodeReconnected()
      const release = node.holdEnsures()

      // The Worker reports a result that waits for the PM's review.
      expect((await report(address, worker, ticket.id, assignment.id, 'ready', 'the work is done', 'call-1')).status).toBe(200)
      await until(() => node.heldEnsures.length > 0, 'the target was not ensured again')

      // While the ensure is on its way, the Project is paused: a paused Project has no PM to wake.
      await control!.pauseProject(project.id, true)
      release()

      // The wake-up waits for the resume: the PM is not woken behind the pause, and the review waits with it.
      await until(() => control!.coordinationDeliveries()[0]?.status === 'deferred_for_resume',
        'the delivery was not held', 10_000)
      expect(node.messages.get(pm.sessionId)).toBeUndefined()
      expect(control!.pmNotifications()[0]).toMatchObject({ state: 'pending' })

      // The resume carries the very same delivery out again, under its own key.
      await control!.pauseProject(project.id, false)
      await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox',
        'the wake-up was not sent', 10_000)
      expect(node.messages.get(pm.sessionId)).toHaveLength(1)
    })

  it('shows the delivery status in the console over HTTP, and keeps it after a restart', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    node.failures.set(pm.sessionId, new Error('the node is busy'))

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'the secret plan', 'call-1')).status).toBe(200)
    await until(() => control!.coordinationDeliveries()[0]?.status === 'failed_permanent', 'the failure was not recorded')

    const response = await fetch(`${address.url}/v1/console/coordination/deliveries`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(response.status).toBe(200)
    const text = await response.text()
    const body = JSON.parse(text) as { deliveries: Record<string, unknown>[] }
    // The console sees the facts of the delivery: the target, the state, the node and the reason.
    expect(body.deliveries[0]).toMatchObject({ status: 'failed_permanent', targetSessionId: pm.sessionId,
      nodeId: NODE_ID, backendId: 'dsh', kind: 'worker_report', ticketId: ticket.id })
    expect(String(body.deliveries[0]!.error)).toContain('the node is busy')
    // The body of the report is not part of the console's answer: the stored message is the Worker's own text.
    expect(text).not.toContain('the secret plan')

    const restarted = await restart()
    const after = await fetch(`${restarted.url}/v1/console/coordination/deliveries`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(after.status).toBe(200)
    const afterBody = await after.json() as { deliveries: Record<string, unknown>[] }
    expect(afterBody.deliveries[0]).toMatchObject({ status: 'failed_permanent', targetSessionId: pm.sessionId })
  })
})

describe('the callback that carries a report', () => {
  it('refuses a callback whose Session belongs to another node', async () => {
    const { ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    // The Session record says it belongs to another node: the token and the record no longer agree, and the report is
    // about work on this node.
    control!.session(worker)!.nodeId = 'other-node'

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'needs a decision', 'call-1')).status).toBe(401)
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toBeUndefined()
    expect(control!.coordinationDeliveries()).toHaveLength(0)
  })

  it('refuses a callback of a Worker whose Assignment was replaced', async () => {
    const { ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    // A newer Assignment took the work: the old Worker may not report on it any more.
    const ticketRecord = control!.store.tickets.get(ticket.id)!
    control!.store.tickets.save({ ...ticketRecord, assignments: [...ticketRecord.assignments,
      { id: 'assignment-newer', state: 'running', createdAt: START }] })

    expect((await report(address, worker, ticket.id, assignment.id, 'blocked', 'needs a decision', 'call-1')).status).toBe(400)
    expect(control!.coordinationDeliveries()).toHaveLength(0)
  })
})

describe('the report of a PM about its own Project', () => {
  it('sends a blocker to the Router at once and holds an ordinary progress report back', async () => {
    const { pm, address } = await open({ progressIntervalMs: 60_000 })
    const token = tokenOf(pm.sessionId)

    // The Router does not exist yet: the report starts it, the way a person's message does.
    expect((await post(address, '/v1/tools/pm/project-report', token, { summary: 'first milestone' })).status).toBe(200)
    await until(() => (node.messages.get('router')?.length ?? 0) > 0, 'the Router was not told')
    const first = node.messages.get('router')![0]!
    // The PM's own text is fenced and bounded: it is data the Router reads, never an instruction it follows.
    expect(first).toContain('--- begin project text ---')
    expect(first).toContain('first milestone')

    // The next ordinary progress report waits for the interval.
    expect((await post(address, '/v1/tools/pm/project-report', token, { summary: 'second milestone' })).status).toBe(200)
    await until(() => control!.coordinationDeliveries().length > 1, 'the second report was not recorded')
    const held = control!.coordinationDeliveries().find(row => row.status === 'accepted_pending')!
    expect(held).toMatchObject({ kind: 'pm_report', reportKind: 'progress' })

    // A blocker is a state change: it goes out at once, and it takes the place of the held report.
    expect((await post(address, '/v1/tools/pm/project-report', token,
      { summary: 'blocked on the schema', kind: 'blocked' })).status).toBe(200)
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the blocker was not delivered')
    const messages = (node.messages.get('router') ?? []).join('\n')
    expect(messages).toContain('blocked on the schema')
    expect(messages).toContain('Report kind: blocked')
    expect(messages).not.toContain('second milestone')
  })

  it('refuses a report kind it does not know', async () => {
    const { pm, address } = await open()
    const token = tokenOf(pm.sessionId)
    const response = await post(address, '/v1/tools/pm/project-report', token, { summary: 'x', kind: 'nonsense' })
    expect(response.status).toBe(400)
  })

  it('does not send a report of a PM to the Router after its Project was paused', async () => {
    let clock = START
    const { project, pm, address } = await open({ progressIntervalMs: 3000, now: () => clock })
    const token = tokenOf(pm.sessionId)

    // The first progress report goes at once: it has nothing to wait for.
    expect((await post(address, '/v1/tools/pm/project-report', token, { summary: 'first milestone' })).status).toBe(200)
    await until(() => (node.messages.get('router')?.length ?? 0) > 0, 'the Router was not told')

    // The next one waits for the interval.
    expect((await post(address, '/v1/tools/pm/project-report', token, { summary: 'second milestone' })).status).toBe(200)
    await until(() => control!.coordinationDeliveries().length > 1, 'the second report was not recorded')
    const held = control!.coordinationDeliveries().find(row => row.status === 'accepted_pending')!
    expect(held).toMatchObject({ kind: 'pm_report', reportKind: 'progress' })

    // The Project is paused while the report waits.
    await control!.pauseProject(project.id, true)
    // The clock moves past the interval, so the queued report is due.
    clock = new Date(Date.parse(START) + 60_000).toISOString()

    // The report is about a Project that is paused: it is not sent, and the Router never hears it.
    await until(() => control!.coordinationDeliveries().find(row => row.deliveryId === held.deliveryId)?.status
      === 'blocked_target_inactive', 'the queued report was not blocked', 10_000)
    const messages = (node.messages.get('router') ?? []).join('\n')
    expect(messages).toContain('first milestone')
    expect(messages).not.toContain('second milestone')
  })
})
