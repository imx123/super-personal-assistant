/**
 * The call-level idempotency of a Worker's report.
 *
 * A report is one tool invocation, and the invocation has its own id: the node sends it, and the control plane records
 * the report and that id in one transaction. A replayed call is therefore the same call — it changes nothing and wakes
 * the PM once — while a new call is a new fact, whatever it says. A call that comes back with a different payload is a
 * conflict, not a replay.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const SECRET = 'report-secret'
const API_TOKEN = 'report-api-token'
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

/** Wait for a fact to become true. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * A control plane with a node, listening on a random port.
 *
 * The ordinary progress reports go out at once here: this file is about the call ledger — how often a fact reaches the
 * PM — and a throttle would hide what the ledger does.
 */
async function open(): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-report-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: 'local', root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50, reportProgressIntervalMs: 0 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  address = await server.listen(0)
}

/** A Project with its PM and one Ticket whose Worker Session runs. */
async function projectWithWorker(): Promise<
  { projectId: string; pmSessionId: string; ticketId: string; assignmentId: string; workerToken: string }> {
  const created = await post('/v1/console/projects', { title: '报告项目', goal: '把工作做完' })
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
  return { projectId: project.id, pmSessionId: session.sessionId, ticketId, assignmentId,
    workerToken: tokenOf(`worker-${assignmentId}`) }
}

/** The Session token the node holds. */
function tokenOf(sessionId: string): string {
  const token = node.tokens.get(sessionId)
  if (!token) throw new Error(`No token for ${sessionId}`)
  return token
}

/** One report, sent with the call's own id. */
function report(workerToken: string, ticketId: string, callKey: string, state: string, summary: string): Promise<Response> {
  return fetch(`${address.url}/v1/tools/worker/report`, { method: 'POST',
    headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ticketId, report: { state, summary }, callKey }) })
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the call-level idempotency of a Worker report', () => {
  it('writes a replayed call once and wakes the PM once', async () => {
    await open()
    const { pmSessionId, ticketId, workerToken } = await projectWithWorker()

    const first = await report(workerToken, ticketId, 'call-1', 'progress', '做了一半')
    expect(first.status).toBe(200)
    await until(() => (node.messages.get(pmSessionId)?.length ?? 0) > 0, 'the PM was not notified')
    await until(() => control!.pmNotifications()[0]?.state === 'sent', 'the wake-up was not recorded as sent')

    // The very same call again: the report is not written twice and the PM is not woken twice.
    const replay = await report(workerToken, ticketId, 'call-1', 'progress', '做了一半')
    expect(replay.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(node.messages.get(pmSessionId)).toHaveLength(1)
    expect(control!.pmNotifications()[0]).toMatchObject({ state: 'skipped' })
    // The replay is recorded as what it was: the same call.
    const audit = control!.auditEntries({ limit: 10 })
    expect(audit.some(entry => entry.action === 'duplicate')).toBe(true)
  })

  it('refuses a call that comes back with a different payload', async () => {
    await open()
    const { pmSessionId, ticketId, workerToken } = await projectWithWorker()

    expect((await report(workerToken, ticketId, 'call-1', 'progress', '做了一半')).status).toBe(200)
    await until(() => (node.messages.get(pmSessionId)?.length ?? 0) > 0, 'the PM was not notified')
    const conflict = await report(workerToken, ticketId, 'call-1', 'progress', '做了别的')
    expect(conflict.status).toBe(400)
    // The first report is still the one that was written.
    expect(control!.store.tickets.get(ticketId)?.assignments.at(-1)?.report?.summary).toBe('做了一半')
    // The refused call wrote nothing, so it woke nobody either.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(node.messages.get(pmSessionId)).toHaveLength(1)
  })

  it('remembers every report content it has seen, however many there are', async () => {
    await open()
    const { pmSessionId, ticketId, workerToken } = await projectWithWorker()

    // Many different contents: each one is a new fact and wakes the PM once.
    for (let index = 0; index < 40; index += 1) {
      expect((await report(workerToken, ticketId, `call-${index}`, 'progress', `第 ${index} 步`)).status).toBe(200)
    }
    await until(() => (node.messages.get(pmSessionId)?.length ?? 0) >= 40, 'the PM was not woken for every content')

    // The oldest content is still remembered: the record of what the superior knows is durable and is not bounded by a
    // number of reports, so the same fact never wakes the PM a second time.
    expect((await report(workerToken, ticketId, 'call-old', 'progress', '第 0 步')).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(node.messages.get(pmSessionId)).toHaveLength(40)
    expect(control!.pmNotifications()[0]).toMatchObject({ state: 'skipped' })
    expect(control!.pmNotifications()[0]!.reason).toContain('already knows')
  })

  it('does not wake the PM a second time after a restart of the control plane', async () => {
    await open()
    const { pmSessionId, ticketId, workerToken } = await projectWithWorker()
    expect((await report(workerToken, ticketId, 'call-1', 'progress', '做了一半')).status).toBe(200)
    await until(() => (node.messages.get(pmSessionId)?.length ?? 0) > 0, 'the PM was not notified')

    await server?.close()
    server = undefined
    await control?.close()
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
      workspaceRoot: join(directory, 'workspaces'), now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    address = await server.listen(0)

    const before = node.messages.get(pmSessionId)?.length ?? 0
    const replay = await report(workerToken, ticketId, 'call-1', 'progress', '做了一半')
    expect(replay.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 50))
    // The ledger outlived the restart, so the replay woke nobody.
    expect(node.messages.get(pmSessionId)?.length ?? 0).toBe(before)
  })

  it('gives a new review round its own fact, even with the same text', async () => {
    await open()
    const { pmSessionId, ticketId, assignmentId, workerToken } = await projectWithWorker()

    expect((await report(workerToken, ticketId, 'call-1', 'ready', '做完了')).status).toBe(200)
    await until(() => (node.messages.get(pmSessionId)?.length ?? 0) > 0, 'the PM was not notified')
    const firstReview = control!.store.tickets.get(ticketId)?.reviews?.at(-1)
    expect(firstReview?.state).toBe('pending')

    // The PM rejects the result, and the Worker reports the same text again: that is a new round, not a replay.
    const rejected = await fetch(`${address.url}/v1/tools/pm/review`, { method: 'POST',
      headers: { authorization: `Bearer ${tokenOf(pmSessionId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId, assignmentId, reviewId: firstReview!.id, action: 'reject', reason: '再做一次' }) })
    expect(rejected.status).toBe(200)

    const again = await report(workerToken, ticketId, 'call-2', 'ready', '做完了')
    expect(again.status).toBe(200)
    const secondReview = control!.store.tickets.get(ticketId)?.reviews?.at(-1)
    expect(secondReview!.id).not.toBe(firstReview!.id)
    expect(secondReview?.state).toBe('pending')
    // The PM is woken for the new round: the text alone never decides that.
    await until(() => (node.messages.get(pmSessionId)?.length ?? 0) > 1, 'the PM was not woken for the new round')
  })

  it('keeps the older behaviour for a node that sends no call id', async () => {
    await open()
    const { pmSessionId, ticketId, workerToken } = await projectWithWorker()
    const body = { ticketId, report: { state: 'progress', summary: '做了一半' } }

    expect((await fetch(`${address.url}/v1/tools/worker/report`, { method: 'POST',
      headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body) })).status).toBe(200)
    await until(() => (node.messages.get(pmSessionId)?.length ?? 0) > 0, 'the PM was not notified')

    // The same content again: the report is written again, and the PM is not woken again.
    expect((await fetch(`${address.url}/v1/tools/worker/report`, { method: 'POST',
      headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body) })).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(node.messages.get(pmSessionId)).toHaveLength(1)
    expect(control!.pmNotifications()[0]).toMatchObject({ state: 'skipped' })
  })
})
