/**
 * Phase 4: the Project PM reviews a Worker's result before its Ticket ends.
 *
 * A `ready` report of a control-plane Ticket opens a review instead of ending the Ticket: the Ticket waits for the PM,
 * bound to the Assignment that produced the result and to the review's own id. The PM accepts it — the Ticket ends as
 * `completed` — or rejects it with a reason that goes back to the same Assignment, which keeps working and reports its
 * new result as a new round.
 *
 * A decision names the round it decides, so a decision that arrives late never decides the round that waits now: the
 * same Assignment may have several rounds, and each has its own id.
 *
 * The old plugin's own `ready` → `completed` is unchanged: the review is the standalone control plane's policy, and the
 * domain tests keep the old behaviour covered.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket, TicketReview, Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import type { NodeCommand, SessionRecord } from '../src/shared/protocol.ts'

const SECRET = 'review-secret'
const API_TOKEN = 'review-api-token'
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

/** Wait for the asynchronous Executor callbacks and the node's delivery to settle. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * A FakeNode whose `session.message` a test can refuse.
 *
 * A revision request the node refuses leaves the Worker without the reason it needs, which is a fact the PM must see
 * rather than a silent success.
 */
class ControllableNode extends FakeNode {
  /** When set, a `session.message` to that Session fails with it. */
  readonly messageFailures = new Map<string, Error>()

  override async send(command: NodeCommand): Promise<void> {
    if (command.type === 'session.message') {
      const failure = this.messageFailures.get(command.sessionId)
      if (failure) throw failure
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
async function open(): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-review-'))
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
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

/** The Worker Session of one Assignment. */
function workerOf(assignment: Assignment): string {
  return `worker-${assignment.id}`
}

/** Report a result from the Worker of one Assignment. */
async function report(address: { url: string }, ticket: Ticket, assignment: Assignment, state: string, summary: string):
Promise<Response> {
  return post(address, '/v1/tools/worker/report', tokenOf(workerOf(assignment)), { ticketId: ticket.id,
    assignmentId: assignment.id, report: { state, summary } })
}

/** The rounds of the Ticket, oldest first. */
function reviewsOf(ticketId: string): TicketReview[] {
  return control!.store.tickets.get(ticketId)?.reviews ?? []
}

/** The id of the round that waits for the PM's decision. */
function pendingReviewId(ticketId: string): string {
  const review = reviewsOf(ticketId).findLast(item => item.state === 'pending')
  if (!review) throw new Error('The Ticket waits for no review')
  return review.id
}

/** The PM's decision about one round of a Ticket. */
function decide(address: { url: string }, pm: SessionRecord, ticket: Ticket, assignment: Assignment, reviewId: string,
  action: string, reason?: string): Promise<Response> {
  return post(address, '/v1/tools/pm/review', tokenOf(pm.sessionId), {
    ticketId: ticket.id, assignmentId: assignment.id, reviewId, action, ...(reason === undefined ? {} : { reason }) })
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the Project PM reviews a Worker result', () => {
  it('keeps the Ticket open for the review and ends it as completed when the PM accepts', async () => {
    const { pm, ticket, assignment, address } = await open()
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)

    // The result is written and the Ticket waits for the PM: nothing ended it.
    const waiting = control!.store.tickets.get(ticket.id)!
    expect(waiting.ended).toBeUndefined()
    expect(waiting.assignments.at(-1)?.state).toBe('running')
    expect(waiting.reviews?.at(-1)).toMatchObject({ state: 'pending', assignmentId: assignment.id,
      summary: 'the feature is done' })
    const reviewId = waiting.reviews!.at(-1)!.id

    // The PM reads the review in its own Project, with the id its decision names.
    const context = (await (await get(address, '/v1/tools/pm/context', tokenOf(pm.sessionId))).json()) as {
      tickets: { id: string; status: string; review?: { id: string; state: string; assignmentId: string; summary?: string } }[] }
    expect(context.tickets[0]).toMatchObject({ id: ticket.id, status: 'waiting' })
    expect(context.tickets[0]!.review).toMatchObject({ id: reviewId, state: 'pending', assignmentId: assignment.id,
      summary: 'the feature is done' })

    // The PM accepts the result.
    const accepted = await decide(address, pm, ticket, assignment, reviewId, 'accept')
    expect(accepted.status).toBe(200)
    const body = (await accepted.json()) as { review: { id: string; state: string }; ticket: Ticket }
    expect(body.review).toMatchObject({ id: reviewId, state: 'accepted' })

    // The Ticket ends as completed, and the accepted Worker really stops on the node.
    const ended = control!.store.tickets.get(ticket.id)!
    expect(ended.ended?.outcome).toBe('completed')
    expect(ended.assignments.at(-1)?.state).toBe('ended')
    await until(() => node.sessions.get(workerOf(assignment))?.status === 'stopped', 'the Worker was not stopped')
  })

  it('sends the reason back to the same Assignment, which reports its new result', async () => {
    const { pm, ticket, assignment, address } = await open()
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const first = pendingReviewId(ticket.id)

    const rejected = await decide(address, pm, ticket, assignment, first, 'reject', 'the tests are missing')
    expect(rejected.status).toBe(200)
    const body = (await rejected.json()) as { review: { id: string; state: string; reason?: string }; delivered: string }
    expect(body.review).toMatchObject({ id: first, state: 'rejected', reason: 'the tests are missing' })
    expect(body.delivered).toBe('running')

    // The Ticket stays open with the same Assignment: no second Worker was created beside it.
    const rejectedTicket = control!.store.tickets.get(ticket.id)!
    expect(rejectedTicket.ended).toBeUndefined()
    expect(rejectedTicket.assignments).toHaveLength(1)
    expect(rejectedTicket.assignments.at(-1)?.state).toBe('running')

    // The Worker receives the reason.
    await until(() => (node.messages.get(workerOf(assignment))?.length ?? 0) > 0, 'the Worker did not receive the reason')
    const message = node.messages.get(workerOf(assignment))![0]!
    expect(message).toContain('the tests are missing')
    expect(message).toContain('rejected')

    // The Worker reports its new result, and a new review waits for the PM.
    expect((await report(address, ticket, assignment, 'ready', 'now with tests')).status).toBe(200)
    const reviewed = control!.store.tickets.get(ticket.id)!
    expect(reviewed.reviews).toHaveLength(2)
    expect(reviewed.reviews?.at(0)).toMatchObject({ state: 'rejected', reason: 'the tests are missing' })
    expect(reviewed.reviews?.at(-1)).toMatchObject({ state: 'pending', assignmentId: assignment.id,
      summary: 'now with tests' })
    const second = pendingReviewId(ticket.id)
    // The new round has its own id: the old one decides nothing.
    expect(second).not.toBe(first)

    // The PM accepts the new result.
    const accepted = await decide(address, pm, ticket, assignment, second, 'accept')
    expect(accepted.status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  })

  it('refuses an acceptance that no Worker result waits for', async () => {
    const { pm, ticket, assignment, address } = await open()

    // No result waits for review, so no round names one.
    const response = await decide(address, pm, ticket, assignment, 'review-does-not-exist', 'accept')
    expect(response.status).toBe(400)

    // The Ticket is untouched: no review, no end.
    const stored = control!.store.tickets.get(ticket.id)!
    expect(stored.ended).toBeUndefined()
    expect(stored.reviews).toBeUndefined()
    expect(stored.assignments.at(-1)?.state).toBe('running')
  })

  it('refuses a decision that names no review at all', async () => {
    const { pm, ticket, assignment, address } = await open()
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)

    const response = await post(address, '/v1/tools/pm/review', tokenOf(pm.sessionId),
      { ticketId: ticket.id, assignmentId: assignment.id, action: 'accept' })
    expect(response.status).toBe(400)

    // The review still waits for the PM.
    expect(control!.store.tickets.get(ticket.id)?.reviews?.at(-1)).toMatchObject({ state: 'pending' })
  })

  it('refuses a stale Assignment, a foreign Ticket and a Worker token without changing the Ticket', async () => {
    const { pm, ticket, assignment, address } = await open()
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const reviewId = pendingReviewId(ticket.id)
    const token = tokenOf(pm.sessionId)

    // Another Assignment's result is not the result under review.
    const stale = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: 'assignment-other', reviewId, action: 'accept' })
    expect(stale.status).toBe(400)
    expect(((await stale.json()) as { error: string }).error).toContain('another Assignment')

    // A Ticket of another Project is unknown to this PM.
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const otherPm = await control!.openProject(other.id)
    const [foreign] = control!.engine.createProjectTickets(other.id, otherPm.sessionId, [{ title: 'Foreign', goal: 'G' }])
    const foreignReview = await post(address, '/v1/tools/pm/review', token,
      { ticketId: foreign!.id, assignmentId: 'assignment-other', reviewId, action: 'accept' })
    expect(foreignReview.status).toBe(400)

    // A Worker token cannot review anything.
    const workerReview = await post(address, '/v1/tools/pm/review', tokenOf(workerOf(assignment)),
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId, action: 'accept' })
    expect(workerReview.status).toBe(403)

    // Nothing changed: the review still waits for the PM.
    const stored = control!.store.tickets.get(ticket.id)!
    expect(stored.ended).toBeUndefined()
    expect(stored.reviews?.at(-1)).toMatchObject({ state: 'pending', assignmentId: assignment.id })
  })

  it('keeps the review across a control-plane restart', async () => {
    const { pm, ticket, assignment, address } = await open()
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const reviewId = pendingReviewId(ticket.id)

    // The control plane restarts: the review is a durable fact of the Ticket, not of the process.
    await server!.close()
    server = undefined
    await control!.close()
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
      workspaceRoot: join(directory, 'workspaces'), now: () => START, confirmationTimeoutMs: 50 })
    await control!.registerNode()
    server = new ControlPlaneServer(control!, { token: API_TOKEN })
    const restarted = await server.listen(0)
    expect(control!.store.tickets.get(ticket.id)?.reviews?.at(-1))
      .toMatchObject({ state: 'pending', assignmentId: assignment.id, id: reviewId })

    // The PM accepts the result after the restart.
    const accepted = await post(restarted, '/v1/tools/pm/review', tokenOf(pm.sessionId),
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId, action: 'accept' })
    expect(accepted.status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  })

  it('answers a repeated decision with the same result and refuses a contradicting one', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const reviewId = pendingReviewId(ticket.id)

    // The same rejection twice: one decision, one revision request.
    const first = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId, action: 'reject', reason: 'the tests are missing' })
    expect(first.status).toBe(200)
    await until(() => (node.messages.get(workerOf(assignment))?.length ?? 0) > 0, 'the Worker did not receive the reason')
    const again = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId, action: 'reject', reason: 'the tests are missing' })
    expect(again.status).toBe(200)
    expect(((await again.json()) as { review: { id: string; state: string } }).review)
      .toMatchObject({ id: reviewId, state: 'rejected' })
    expect(node.messages.get(workerOf(assignment))).toHaveLength(1)

    // Another reason contradicts the decision that was made.
    const other = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId, action: 'reject', reason: 'the docs are missing' })
    expect(other.status).toBe(400)
    expect(control!.store.tickets.get(ticket.id)?.reviews?.at(-1)).toMatchObject({ state: 'rejected',
      reason: 'the tests are missing' })

    // A rejection is not an acceptance: the refused decision changed nothing.
    const accepted = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId, action: 'accept' })
    expect(accepted.status).toBe(400)
    expect(control!.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  })

  it('answers a repeated acceptance with the same result', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const reviewId = pendingReviewId(ticket.id)

    const first = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId, action: 'accept' })
    expect(first.status).toBe(200)
    const again = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId, action: 'accept' })
    expect(again.status).toBe(200)
    expect(((await again.json()) as { review: { id: string; state: string } }).review)
      .toMatchObject({ id: reviewId, state: 'accepted' })
    expect(control!.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  })

  it('never lets a late decision reach the round that waits now', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const first = pendingReviewId(ticket.id)

    // The PM rejects the first round, and the Worker reports the same text again.
    const rejected = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId: first, action: 'reject', reason: 'the tests are missing' })
    expect(rejected.status).toBe(200)
    await until(() => (node.messages.get(workerOf(assignment))?.length ?? 0) > 0, 'the Worker did not receive the reason')
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const second = pendingReviewId(ticket.id)
    // The same text in a new round is a new round: it has its own id.
    expect(second).not.toBe(first)
    expect(reviewsOf(ticket.id)).toHaveLength(2)

    // The old acceptance does not accept the new round.
    const late = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId: first, action: 'accept' })
    expect(late.status).toBe(400)
    expect(control!.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    expect(control!.store.tickets.get(ticket.id)?.reviews?.at(-1)).toMatchObject({ id: second, state: 'pending' })

    // The old rejection is answered as it was made, and it decides nothing of the round that waits now.
    const again = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId: first, action: 'reject', reason: 'the tests are missing' })
    expect(again.status).toBe(200)
    expect(((await again.json()) as { review: { id: string; state: string } }).review)
      .toMatchObject({ id: first, state: 'rejected' })
    // The Worker was not asked to revise twice, and the new round still waits for the PM.
    expect(node.messages.get(workerOf(assignment))).toHaveLength(1)
    expect(control!.store.tickets.get(ticket.id)?.reviews?.at(-1)).toMatchObject({ id: second, state: 'pending' })
    expect(control!.store.tickets.get(ticket.id)?.ended).toBeUndefined()

    // The round that waits is decided by naming it.
    const accepted = await post(address, '/v1/tools/pm/review', token,
      { ticketId: ticket.id, assignmentId: assignment.id, reviewId: second, action: 'accept' })
    expect(accepted.status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  })

  it('keeps the round when the same result is reported again', async () => {
    const { pm, ticket, assignment, address } = await open()
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const reviewId = pendingReviewId(ticket.id)

    // The same result again: it is the same round, so its id still decides it.
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    expect(reviewsOf(ticket.id)).toHaveLength(1)
    expect(pendingReviewId(ticket.id)).toBe(reviewId)

    const accepted = await decide(address, pm, ticket, assignment, reviewId, 'accept')
    expect(accepted.status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  })

  it('gives a new round to a result whose content changed', async () => {
    const { pm, ticket, assignment, address } = await open()
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const first = pendingReviewId(ticket.id)

    // The Worker reports something else: the round that waits is withdrawn and a new one takes its place.
    expect((await report(address, ticket, assignment, 'ready', 'now with tests')).status).toBe(200)
    const second = pendingReviewId(ticket.id)
    expect(second).not.toBe(first)
    expect(reviewsOf(ticket.id).at(0)).toMatchObject({ id: first, state: 'withdrawn' })
    expect(reviewsOf(ticket.id).at(-1)).toMatchObject({ id: second, state: 'pending', summary: 'now with tests' })

    // The withdrawn round decides nothing.
    const late = await decide(address, pm, ticket, assignment, first, 'accept')
    expect(late.status).toBe(400)
    expect(control!.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    expect(control!.store.tickets.get(ticket.id)?.reviews?.at(-1)).toMatchObject({ id: second, state: 'pending' })

    const accepted = await decide(address, pm, ticket, assignment, second, 'accept')
    expect(accepted.status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  })

  it('points the PM at the review when it hears the result', async () => {
    const { pm, ticket, assignment, address } = await open()
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const reviewId = pendingReviewId(ticket.id)

    await until(() => (node.messages.get(pm.sessionId)?.length ?? 0) > 0, 'the PM was not notified')
    const message = node.messages.get(pm.sessionId)![0]!
    // The message announces the fact and the review that follows from it; it never decides anything itself.
    expect(message).toContain('control_review_result')
    expect(message).toContain('waits for your review')
    // The message points at the read-only diff as well: the PM decides on the report and the workspace snapshot together.
    expect(message).toContain('control_review_diff')
    // It names the review the decision is about.
    expect(message).toContain(reviewId)
  })

  it('wakes the PM again for a new round with the same text', async () => {
    const { pm, ticket, assignment, address } = await open()
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const first = pendingReviewId(ticket.id)
    await until(() => (node.messages.get(pm.sessionId)?.length ?? 0) > 0, 'the PM was not notified')

    // The PM rejects the round, and the Worker reports the same text again.
    const rejected = await decide(address, pm, ticket, assignment, first, 'reject', 'the tests are missing')
    expect(rejected.status).toBe(200)
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const second = pendingReviewId(ticket.id)
    expect(second).not.toBe(first)

    // The same text in a new round is a new fact: the PM hears about it again.
    await until(() => (node.messages.get(pm.sessionId)?.length ?? 0) > 1, 'the PM was not woken for the new round')
    const message = node.messages.get(pm.sessionId)![1]!
    expect(message).toContain(second)
  })

  it('drops the review when the PM stops the Worker', async () => {
    const { pm, ticket, assignment, address } = await open()
    const token = tokenOf(pm.sessionId)
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const reviewId = pendingReviewId(ticket.id)

    // The PM stops that Worker: the result it reported is no longer under review.
    expect((await post(address, '/v1/tools/pm/cancel', token, { ticketId: ticket.id })).status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.reviews?.at(-1)).toMatchObject({ state: 'withdrawn' })

    // And the review cannot be accepted any more.
    const accepted = await decide(address, pm, ticket, assignment, reviewId, 'accept')
    expect(accepted.status).toBe(400)
  })

  it('reports a revision request the node refused', async () => {
    const { pm, ticket, assignment, address } = await open()
    // The Worker has a result the PM reviews: the revision request needs one to speak of.
    expect((await report(address, ticket, assignment, 'ready', 'the feature is done')).status).toBe(200)
    const reviewId = pendingReviewId(ticket.id)
    node.messageFailures.set(workerOf(assignment), new Error('the node is busy'))

    const rejected = await decide(address, pm, ticket, assignment, reviewId, 'reject', 'the tests are missing')
    expect(rejected.status).toBe(200)
    const body = (await rejected.json()) as { review: { state: string }; error?: string }
    // The decision stands, and the failure of the delivery is stated instead of hidden.
    expect(body.review.state).toBe('rejected')
    expect(body.error).toContain('the node is busy')
    // The failure is the Ticket's own fact, which the PM reads in its Project.
    expect(control!.store.tickets.get(ticket.id)?.delivery?.error).toContain('the node is busy')
  })
})
