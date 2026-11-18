/**
 * The durable outbox of the coordination deliveries.
 *
 * Six kinds of work travel between the Sessions of one control plane — the Router's handoff, the Worker's report, the
 * PM's report, the stream digest, the denial review and the external wake-up — and they share one table and one
 * recovery. The recovery is the part that must not lie.
 *
 * A delivery that never left the control plane is sent again under the very key the node knows it by, so the node
 * executes it at most once. A delivery that was on its way is asked about: the node is the only one that knows whether
 * the message arrived, and it answers with what it can *prove*. A delivery whose outcome cannot be proven stays
 * unconfirmed — it is shown in the console, and it is never sent again on a guess.
 *
 * The tests below drive the real control plane against a FakeNode over a real SQLite file that is closed and reopened,
 * so what is checked is what a restart would really find.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket, Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { DeliveryOutbox, type DeliveryRevalidation } from '../src/control/delivery-outbox.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import type { DeliveryEvidence, NodeCommand } from '../src/shared/protocol.ts'

const SECRET = 'delivery-outbox-secret'
const API_TOKEN = 'delivery-outbox-token'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'
/** The request a person makes: it names the Project, so the rule layer leaves it to the Router. */
const REQUEST = '请在「周报整理」补充本周数据'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: ControllableNode
/** The clock of the control plane, which a test moves when something has to run out. */
let clock = START

function trigger(id: string): Trigger {
  return { id, source: 'main-session', threads: [{ source: 'main-session', id: `thread-${id}` }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

/** Wait for an asynchronous callback to settle. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * A FakeNode that records what it was asked about a delivery.
 *
 * The questions are the point of the recovery: the control plane asks the node about the exact key of the exact
 * Session, and the record shows whether it asked at all and about what.
 */
class ControllableNode extends FakeNode {
  /** The questions the node was asked about a delivery. */
  readonly asked: { sessionId: string; deliveryKey: string }[] = []
  /** The messages that wait for the test to let them go, by Session. */
  private readonly holds = new Map<string, Promise<void>>()

  /** Hold every message to one Session until the returned function is called. */
  hold(sessionId: string): () => void {
    let release = (): void => {}
    const waiting = new Promise<void>(resolve => { release = () => resolve(undefined) })
    this.holds.set(sessionId, waiting)
    return release
  }

  override async send(command: NodeCommand): Promise<void> {
    if (command.type === 'session.message') {
      const held = this.holds.get(command.sessionId)
      if (held) await held
    }
    return super.send(command)
  }

  override async evidence(sessionId: string, deliveryKey: string): Promise<DeliveryEvidence> {
    this.asked.push({ sessionId, deliveryKey })
    return super.evidence(sessionId, deliveryKey)
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
async function open(options: { evidence?: 'authoritative' | 'unknown' } = {}): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-outbox-'))
  clock = START
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START,
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }) })
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

/** The kinds the outbox holds, newest first. */
function kinds(): string[] {
  const rows = control!.store.db.prepare('SELECT kind FROM coordination_deliveries ORDER BY seq').all() as
    Record<string, unknown>[]
  return rows.map(row => String(row['kind'] ?? ''))
}

/**
 * The key the node knows one delivery by, read from the durable row.
 *
 * The console view does not carry it: the key is the node's own name for the delivery, and the console shows what
 * happened to a delivery rather than what the node calls it.
 */
function keyOf(deliveryId: string): string {
  return String(rowOf(deliveryId)['idempotency_key'] ?? '')
}

/** Write a fact into the table, as a fault injection would. */
function writeRow(patch: Record<string, unknown>, deliveryId: string): void {
  const keys = Object.keys(patch)
  const values = keys.map(key => patch[key] as SQLInputValue)
  control!.store.db.prepare(`UPDATE coordination_deliveries SET ${keys.map(key => `${key} = ?`).join(', ')} `
    + 'WHERE delivery_id = ?').run(...values, deliveryId)
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the outbox of the coordination deliveries', () => {
  it('writes a delivery down before the message goes out', async () => {
    const { ticket, assignment, worker, pm, address } = await open()
    const release = node.hold(pm.sessionId)

    const pending = report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'dispatching', 'the delivery was not claimed')

    // The record exists while the message is on its way: the delivery is a fact before it is a receipt.
    const row = control!.coordinationDeliveries()[0]!
    expect(row).toMatchObject({ kind: 'worker_report', status: 'dispatching', targetSessionId: pm.sessionId,
      ticketId: ticket.id, assignmentId: assignment.id, reportKind: 'blocked' })

    release()
    await pending
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
  })

  it('shows the delivery in the console without the body of the report', async () => {
    const { ticket, assignment, worker, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')

    const response = await fetch(`${address.url}/v1/console/coordination/deliveries?limit=10`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } })
    const body = await response.json() as { deliveries: Record<string, unknown>[] }
    expect(body.deliveries[0]).toMatchObject({ kind: 'worker_report', status: 'delivered_inbox',
      reportKind: 'blocked' })
    // The stored message is the lower-trust text of the Worker: the console shows what happened, not what it said.
    expect(JSON.stringify(body)).not.toContain('the schema needs a decision')
  })

  it('sends a delivery that was never sent again under the very key the node knows it by', async () => {
    const { ticket, assignment, worker, pm, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!
    const key = keyOf(delivery.deliveryId)

    // The control plane died before the message left it: the record says the delivery never went out.
    writeRow({ status: 'accepted_pending', attempt_count: 0, dispatched_at: '' }, delivery.deliveryId)
    await restart()

    const after = control!.coordinationDeliveries()[0]!
    expect(after.status).toBe('delivered_inbox')
    expect(after.attemptCount).toBe(1)
    // The node was asked to execute the very same key again, so the message itself arrives once and not twice.
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(1)
    expect(key).toBeTruthy()
  })

  it('asks the node about a delivery that was on its way, and settles what the node can prove', async () => {
    const { ticket, assignment, worker, pm, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    // The control plane died while the message was on its way: the outcome is unknown until the node is asked.
    writeRow({ status: 'dispatching' }, delivery.deliveryId)
    await restart()

    // The node is asked about the exact key in the exact Session the delivery was made for.
    expect(node.asked).toContainEqual({ sessionId: pm.sessionId, deliveryKey: keyOf(delivery.deliveryId) })
    const after = control!.coordinationDeliveries()[0]!
    // The fake read the message right away, so the node can prove that a turn consumed it.
    expect(['consumed_turn', 'delivered_inbox']).toContain(after.status)
    // The message is not sent again: the node already holds it.
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(1)
  })

  it('sends a delivery again once when the node proves it never arrived, and never twice', async () => {
    const { ticket, assignment, worker, pm, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    // A key the node holds no record of: the node can prove that it never received this one.
    writeRow({ status: 'dispatching', idempotency_key: 'coordination:never-received' }, delivery.deliveryId)
    await restart()

    const after = control!.coordinationDeliveries()[0]!
    expect(after.status).toBe('delivered_inbox')
    expect(after.attemptCount).toBe(2)
    expect(after.resendCount).toBe(1)
    // The one controlled re-send carried the very key the delivery was made under.
    expect(node.asked).toContainEqual({ sessionId: pm.sessionId, deliveryKey: 'coordination:never-received' })
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(2)
  })

  it('leaves a delivery unconfirmed when the node cannot prove anything, and never sends it again', async () => {
    const { ticket, assignment, worker, pm, address } = await open({ evidence: 'unknown' })
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    writeRow({ status: 'dispatching', idempotency_key: 'coordination:never-received' }, delivery.deliveryId)
    await restart()

    const after = control!.coordinationDeliveries()[0]!
    // The outcome is unknown, and an unknown outcome is never a licence to send the message again.
    expect(after.status).toBe('unconfirmed')
    expect(after.resendCount).toBe(0)
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(1)
  })

  it('closes a delivery whose authority is gone instead of sending it', async () => {
    const { ticket, assignment, worker, pm, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    // The PM that was to hear the report lost its authority: the report may not reach it any more.
    await control!.revokeSession(pm.sessionId, 'the operator withdrew the authority')
    writeRow({ status: 'accepted_pending', attempt_count: 0 }, delivery.deliveryId)
    await restart()

    const after = control!.coordinationDeliveries()[0]!
    expect(after.status).toBe('rejected_stale_or_revoked')
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(1)
  })

  it('closes a delivery whose message ran out', async () => {
    const { ticket, assignment, worker, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    // The message life is its own: a message that ran out is stale, whatever the authority says.
    writeRow({ status: 'accepted_pending', attempt_count: 0, expires_at: '2020-01-01T00:00:00.000Z' },
      delivery.deliveryId)
    await restart()

    const after = control!.coordinationDeliveries()[0]!
    expect(after.status).toBe('failed_permanent')
    expect(after.error).toContain('ran out')
  })

  it('never asks another node about a delivery', async () => {
    const { ticket, assignment, worker, pm, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    // The delivery names another node: this control plane may not ask its own node about it, and it may not send it.
    writeRow({ status: 'dispatching', node_id: 'another-node' }, delivery.deliveryId)
    await restart()

    const after = control!.coordinationDeliveries()[0]!
    expect(after.status).toBe('rejected_stale_or_revoked')
    expect(node.asked).toHaveLength(0)
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(1)
  })

  it('keeps the old rows and the old open states when the table is brought to its new shape', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-outbox-old-'))
    const root = join(directory, 'workspaces')
    const path = join(directory, 'control.sqlite')
    // A file of the shape this coordination had before it knew the other kinds.
    const older = new DatabaseSync(path)
    older.exec(`
      CREATE TABLE coordination_deliveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        at TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        project_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        review_id TEXT NOT NULL,
        report_kind TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        target_role TEXT NOT NULL,
        node_id TEXT NOT NULL,
        backend_id TEXT NOT NULL,
        expected_assignment_epoch INTEGER NOT NULL,
        expected_tool_token_version INTEGER NOT NULL,
        expected_node_trust_epoch INTEGER NOT NULL,
        source_assignment_epoch INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        dispatched_at TEXT NOT NULL,
        due_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        error TEXT NOT NULL);
      INSERT INTO coordination_deliveries (delivery_id, kind, at, status, idempotency_key, dedup_key, scope,
        project_id, ticket_id, assignment_id, review_id, report_kind, content_digest, source_session_id,
        target_session_id, target_role, node_id, backend_id, expected_assignment_epoch, expected_tool_token_version,
        expected_node_trust_epoch, source_assignment_epoch, attempt_count, dispatched_at, due_at, payload, error)
      VALUES ('coordination-old', 'worker_report', '${START}', 'delivered_inbox', 'coordination:old', 'old-dedup',
        '', 'project-old', 'ticket-old', 'assignment-old', '', 'blocked', 'digest-old', 'worker-old', 'pm-old', 'pm',
        '${NODE_ID}', 'dsh', 1, 0, 0, 1, 1, '${START}', '', 'the old body', '');
    `)
    older.close()

    node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START })
    control = new ControlPlane({ dbPath: path, nodeId: NODE_ID, node, secret: SECRET, workspaceRoot: root,
      now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()

    // The old row is still there, with the columns of the new shape added beside it.
    const row = rowOf('coordination-old')
    expect(row['kind']).toBe('worker_report')
    expect(row['status']).toBe('delivered_inbox')
    expect(row['payload']).toBe('the old body')
    expect(row['context']).toBe('')
    expect(row['expires_at']).toBe('')
    expect(row['resend_count']).toBe(0)
    expect(row['evidence']).toBe('')
  })
})

describe('the claim of one delivery', () => {
  it('lets only one of two callers send it, and sends it again at most once', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-outbox-claim-'))
    const store = new Store(join(directory, 'control.sqlite'))
    /** How many messages really went out. */
    let sends = 0
    const outbox = new DeliveryOutbox(store, {
      now: () => START,
      nodeId: () => NODE_ID,
      backendId: () => 'dsh',
      deliver: async () => { sends += 1 },
      // The node proves that it never received the message: that is the one answer that permits another attempt.
      evidence: async () => ({ state: 'absent' }),
      evidenceSupported: () => true,
    })
    outbox.register({
      kind: 'worker_report',
      revalidate: () => ({ ok: true }),
      payloadOf: row => row.payload,
    })
    const row = outbox.accept({
      kind: 'worker_report',
      idempotencyKey: 'coordination:claim-test',
      dedupKey: 'worker_report:claim-test',
      scope: 'test',
      projectId: '',
      ticketId: 'ticket-1',
      assignmentId: 'assignment-1',
      sourceSessionId: 'worker-assignment-1',
      targetSessionId: 'pm-1',
      targetRole: 'pm',
      nodeId: NODE_ID,
      backendId: 'dsh',
      expectedAssignmentEpoch: 1,
      expectedToolTokenVersion: 0,
      expectedNodeTrustEpoch: 0,
      payload: 'the message',
      context: { kind: 'worker_report', ticketId: 'ticket-1', assignmentId: 'assignment-1',
        reportKind: 'blocked', reviewId: '' },
    })

    // Two callers claim the same delivery at the same moment: the claim is a conditional write, so only one of them
    // may send it.
    expect(outbox.claim(row.deliveryId, ['accepted_pending'])).toBe(true)
    expect(outbox.claim(row.deliveryId, ['accepted_pending'])).toBe(false)

    // The delivery was on its way when the control plane stopped, and the node proves it never arrived: two recoveries
    // meet it at the same moment, and exactly one controlled re-send goes out.
    await Promise.all([outbox.recover(), outbox.recover()])
    expect(sends).toBe(1)
    const settled = outbox.row(row.deliveryId)!
    expect(settled.status).toBe('delivered_inbox')
    expect(settled.resendCount).toBe(1)
    expect(settled.attemptCount).toBe(2)

    // A third recovery finds nothing open: the delivery is settled and it is never sent again.
    await outbox.recover()
    expect(sends).toBe(1)
    store.close()
  })

  it('gives the re-send back when the target is paused before the transport, and sends it once afterwards', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-outbox-fence-'))
    const store = new Store(join(directory, 'control.sqlite'))
    /** How many messages really went out. */
    let sends = 0
    /** How many times the authority was read. */
    let checks = 0
    const outbox = new DeliveryOutbox(store, {
      now: () => START,
      nodeId: () => NODE_ID,
      backendId: () => 'dsh',
      // The same two checks the real door runs: before the target is ensured, and right before the transport.
      deliver: async (_sessionId, _text, _key, validateForSend, validateBeforeEnsure) => {
        validateBeforeEnsure?.()
        validateForSend?.()
        sends += 1
      },
      // The node proves that it never received the message: that is the one answer that permits another attempt.
      evidence: async () => ({ state: 'absent' }),
      evidenceSupported: () => true,
    })
    outbox.register({
      kind: 'worker_report',
      // The Project is paused while the re-send is on its way: the check right before the transport refuses it.
      revalidate: (): DeliveryRevalidation => {
        checks += 1
        if (checks === 3) {
          return { ok: false, outcome: 'closed', status: 'deferred_for_resume', reason: 'the Project is paused' }
        }
        return { ok: true }
      },
      payloadOf: row => row.payload,
    })
    const row = outbox.accept({
      kind: 'worker_report',
      idempotencyKey: 'coordination:fence-test',
      dedupKey: 'worker_report:fence-test',
      scope: 'test',
      projectId: '',
      ticketId: 'ticket-1',
      assignmentId: 'assignment-1',
      sourceSessionId: 'worker-assignment-1',
      targetSessionId: 'pm-1',
      targetRole: 'pm',
      nodeId: NODE_ID,
      backendId: 'dsh',
      expectedAssignmentEpoch: 1,
      expectedToolTokenVersion: 0,
      expectedNodeTrustEpoch: 0,
      payload: 'the message',
      context: { kind: 'worker_report', ticketId: 'ticket-1', assignmentId: 'assignment-1',
        reportKind: 'blocked', reviewId: '' },
    })

    // The delivery was on its way when the control plane stopped, and the node proves it never arrived: the one
    // controlled re-send is carried out — and the target is paused while it is on its way.
    expect(outbox.claim(row.deliveryId, ['accepted_pending'])).toBe(true)
    await outbox.recover()

    // The re-send was claimed and then refused before the wire: it never left, so the one re-send the proof permits is
    // not spent, and the delivery keeps its place on the wire.
    const fenced = outbox.row(row.deliveryId)!
    expect(fenced.status).toBe('dispatching')
    expect(fenced.resendCount).toBe(0)
    expect(fenced.attemptCount).toBe(2)
    expect(sends).toBe(0)

    // The next recovery carries the one re-send out, and it is counted: there is no third transport.
    await outbox.recover()
    const sent = outbox.row(row.deliveryId)!
    expect(sent.status).toBe('delivered_inbox')
    expect(sent.resendCount).toBe(1)
    expect(sends).toBe(1)
    store.close()
  })
})

describe('the report that was on its way when the Project was paused', () => {
  it('keeps the evidence of a message the node holds, and never sends it again', async () => {
    const { project, ticket, assignment, worker, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    // The control plane stopped while the message was on its way: the receipt never arrived, and the record says that
    // the message was on its way rather than that it was never sent.
    writeRow({ status: 'dispatching' }, delivery.deliveryId)
    // And the Project was paused before the control plane started again.
    await control!.pauseProject(project.id, true)
    await restart()

    // The node proves that the message arrived: the evidence is kept, and the delivery is not a report that waits for a
    // resume — it is a report the PM already has. It was never sent a second time.
    const after = control!.coordinationDeliveries()[0]!
    expect(['consumed_turn', 'delivered_inbox']).toContain(after.status)
    expect(after.attemptCount).toBe(1)

    // The resume carries nothing out: the PM is not told a second time, and the delivery was not touched.
    await control!.pauseProject(project.id, false)
    const resumed = control!.coordinationDeliveries()[0]!
    expect(['consumed_turn', 'delivered_inbox']).toContain(resumed.status)
    expect(resumed.attemptCount).toBe(1)
  })

  it('leaves a report unconfirmed when the node cannot prove anything, and never sends it again', async () => {
    const { project, ticket, assignment, worker, address } = await open({ evidence: 'unknown' })
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    // The control plane stopped while the message was on its way, and the node cannot prove anything about it.
    writeRow({ status: 'dispatching' }, delivery.deliveryId)
    await control!.pauseProject(project.id, true)
    await restart()

    // The outcome stays unknown: the delivery waits for evidence, and it is not a report that waits for a resume.
    const after = control!.coordinationDeliveries()[0]!
    expect(after.status).toBe('unconfirmed')
    expect(after.attemptCount).toBe(1)

    // The resume carries nothing out: an unknown outcome is never a licence to send the message again.
    await control!.pauseProject(project.id, false)
    const resumed = control!.coordinationDeliveries()[0]!
    expect(resumed.status).toBe('unconfirmed')
    expect(resumed.attemptCount).toBe(1)
  })

  it('resumes an ordinary report that never left the control plane', async () => {
    const { project, ticket, assignment, worker, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    // The control plane died before the message left it: the record says the delivery never went out.
    writeRow({ status: 'accepted_pending', attempt_count: 0, dispatched_at: '' }, delivery.deliveryId)
    // And the Project was paused before the control plane started again.
    await control!.pauseProject(project.id, true)
    await restart()

    // The report waits for the resume: it was never sent, so it may be sent again.
    expect(control!.coordinationDeliveries()[0]?.status).toBe('deferred_for_resume')

    // The resume carries the very same delivery out again, under its own key.
    await control!.pauseProject(project.id, false)
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the report was not resumed')
  })

  it('keeps a report the node proved it never received on the wire, and re-sends it once on the resume', async () => {
    const { project, ticket, assignment, worker, pm, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    // The control plane stopped while the message was on its way, and the node holds no record of that key: it can prove
    // that the message never arrived.
    writeRow({ status: 'dispatching', idempotency_key: 'coordination:never-received' }, delivery.deliveryId)
    // And the Project was paused before the control plane started again.
    await control!.pauseProject(project.id, true)
    await restart()

    // The delivery was on its way, so it does not fall back into a class that says its message never left: the one
    // re-send the proof permits is still owed, and the delivery keeps its place on the wire.
    const waiting = control!.coordinationDeliveries()[0]!
    expect(waiting.status).toBe('dispatching')
    expect(waiting.attemptCount).toBe(1)
    expect(waiting.resendCount).toBe(0)
    expect(waiting.evidence).toBe('absent')

    // The resume carries the one re-send out, under the very key the delivery was made under.
    await control!.pauseProject(project.id, false)
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the report was not resumed')
    const resumed = control!.coordinationDeliveries()[0]!
    expect(resumed.attemptCount).toBe(2)
    expect(resumed.resendCount).toBe(1)
    // The node was asked about the exact key in the exact Session, and the one re-send carried that very key.
    expect(node.asked).toContainEqual({ sessionId: pm.sessionId, deliveryKey: 'coordination:never-received' })
    // The message reached the PM once more: the one re-send is the last transport, and there is no third one.
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(2)
  })

  it('closes a report whose one re-send was already made, and never sends it again', async () => {
    const { project, ticket, assignment, worker, pm, address } = await open()
    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries()[0]?.status === 'delivered_inbox', 'the delivery did not settle')
    const delivery = control!.coordinationDeliveries()[0]!

    // The one re-send the proof of absence permits was already made, and the node proves again that the message never
    // arrived: the budget is spent.
    writeRow({ status: 'dispatching', idempotency_key: 'coordination:never-received', attempt_count: 2, resend_count: 1 },
      delivery.deliveryId)
    await control!.pauseProject(project.id, true)
    await restart()

    // The budget is spent: the outcome stays unknown, and the delivery is never sent again.
    const after = control!.coordinationDeliveries()[0]!
    expect(after.status).toBe('unconfirmed')
    expect(after.attemptCount).toBe(2)
    expect(after.resendCount).toBe(1)

    // The resume carries nothing out: an unknown outcome is never a licence to send the message again.
    await control!.pauseProject(project.id, false)
    const resumed = control!.coordinationDeliveries()[0]!
    expect(resumed.status).toBe('unconfirmed')
    expect(resumed.attemptCount).toBe(2)
    expect(node.messages.get(pm.sessionId) ?? []).toHaveLength(1)
  })
})

describe('the kinds of coordination in one table', () => {
  it('records a report of a Worker and a report of a PM', async () => {
    const { ticket, assignment, worker, pm, address } = await open()
    // A PM reports about its own Project to the Router, so the Router has to be there.
    await control!.ensureRouter()

    await report(address, worker, ticket.id, assignment.id, 'blocked', 'the schema needs a decision', 'call-1')
    await until(() => control!.coordinationDeliveries().length === 1, 'the report was not recorded')
    await post(address, '/v1/tools/pm/project-report', tokenOf(pm.sessionId),
      { summary: 'the Project is blocked on a decision', kind: 'blocked' })
    await until(() => control!.coordinationDeliveries().length === 2, 'the PM report was not recorded')

    expect(kinds()).toEqual(['worker_report', 'pm_report'])
  })

  it('records a denial review and an external wake-up', async () => {
    const { worker, address } = await open()

    // Three real refusals, each in a turn of its own, make one review of the direct superior.
    for (let index = 0; index < 3; index += 1) {
      const turn = node.holdTurn(worker)
      node.simulateGuardDenial(worker, 'write', 'ROLE_TOOL_DENIED', { turnId: String(turn), callId: `call-${index}` })
      await control!.settleDenials()
    }
    await until(() => kinds().includes('denial_review'), 'the review was not recorded')

    // A Worker may watch itself: the event wakes its own Assignment and nobody else. The subscription names the rule
    // it watches for — a real condition of the payload of the source — and the event below is the one that holds it.
    const created = await post(address, '/v1/tools/external/subscriptions', tokenOf(worker),
      { sourceId: 'synthetic-sms', eventTypes: ['sms.received'],
        fields: [{ path: 'text', op: 'contains', value: 'the build broke' }], targetSessionId: worker })
    expect(created.status).toBe(200)
    await post(address, '/v1/console/events/synthetic-emit', API_TOKEN,
      { sourceId: 'synthetic-sms', eventId: 'evt-1', eventType: 'sms.received', payload: { text: 'the build broke' } })
    await until(() => kinds().includes('external_wakeup'), 'the wake-up was not recorded')

    expect(kinds()).toContain('denial_review')
    expect(kinds()).toContain('external_wakeup')
  })

  it('records a stream digest and an automatic handoff', async () => {
    const { worker, pm, address } = await open()

    // The PM watches the Worker it governs.
    const subscribed = await post(address, '/v1/tools/stream/subscribe', tokenOf(pm.sessionId), { sessionId: worker })
    expect(subscribed.status).toBe(200)
    node.simulateToolFact(worker, 'write', 'succeeded', { changedPaths: ['src/answer.ts'] })
    node.simulateMessage(worker, 'assistant', 'The answer is written.')
    clock = new Date(Date.parse(START) + 5 * 60_000).toISOString()
    await control!.runStreamDigests()
    await until(() => kinds().includes('stream_digest'), 'the digest was not recorded')

    // The Router hands a request to the PM of a Project, and nobody confirms it in the console.
    await control!.ensureRouter()
    const asked = await post(address, '/v1/console/router/message', API_TOKEN, { text: REQUEST })
    const request = (await asked.json()) as { requestId: string }
    const handed = await post(address, '/v1/tools/router/pm-handoff', tokenOf('router'),
      { requestId: request.requestId, decision: { projectId: (await control!.projects())[0]!.id,
        instruction: REQUEST, rationale: '请求点名了周报整理这个项目。' } })
    expect(handed.status).toBe(200)
    await until(() => kinds().includes('auto_handoff'), 'the handoff was not recorded')

    expect(kinds()).toContain('stream_digest')
    expect(kinds()).toContain('auto_handoff')
  })

  it('creates no outbox work for a relay proposal that waits for a person', async () => {
    const { address } = await open()
    await control!.ensureRouter()
    const asked = await post(address, '/v1/console/router/message', API_TOKEN, { text: REQUEST })
    const request = (await asked.json()) as { requestId: string }
    const proposed = await post(address, '/v1/tools/router/pm-proposal', tokenOf('router'),
      { requestId: request.requestId, projectId: (await control!.projects())[0]!.id, instruction: REQUEST })
    expect(proposed.status).toBe(200)

    // A proposal that waits for a person is not a delivery: nothing is written, and nothing is sent.
    expect(kinds()).toEqual([])
  })
})
