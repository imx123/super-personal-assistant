/**
 * The stream digests a superior asks for.
 *
 * A digest is an increment of what a lower Session did: the tools it called, the files it changed inside its own
 * workspace and the tail of the last thing its model said. It is never a copy of the conversation, it never calls a
 * model, and it never grants anything.
 *
 * The authority is downwards only. A Router may watch a live PM or a current standalone Worker, a PM may watch the
 * current Worker of its own Project, and a Worker may watch nothing. A refusal says nothing about whether the target
 * exists.
 *
 * The watermark is what makes the delivery an increment: it moves only when the digest really went out — or when it may
 * have gone out and its receipt is missing, because a digest that may have arrived is never sent again.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket, Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { NodeUnconfirmedError, NODE_PROTOCOL_VERSION, type NodeCommand } from '../src/shared/protocol.ts'

const SECRET = 'stream-secret'
const API_TOKEN = 'stream-api-token'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'
/** The shortest interval a subscription may ask for; the default is two minutes. */
const MINUTE = 60_000

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: ControllableNode
/** The clock of the control plane, which a test moves when an interval has to pass. */
let clock = START

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
 * A FakeNode whose `session.message` a test can hold or lose.
 *
 * A message that is on its way and a message the node refused are different facts for the superior: the first is unknown
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
  worker: string
  address: { url: string }
}

/**
 * A Project whose PM and two Worker Sessions exist, plus the tool API listening on a random port.
 *
 * Two Tickets are created on purpose: a test that watches one Worker must see that the other one stays quiet.
 */
async function open(): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-stream-'))
  clock = START
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => clock, confirmationTimeoutMs: 50 })
  await control.registerNode()
  await control.ensureRouter()
  control.store.triggers.save(trigger('trigger-1'))
  const project = control.createProject('trigger-1', 'Project', 'Goal')
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

/** A second Ticket of the same Project, with a Worker of its own. */
async function secondTicket(projectId: string, pmSessionId: string): Promise<{ ticket: Ticket; worker: string }> {
  const [created] = control!.engine.createProjectTickets(projectId, pmSessionId,
    [{ title: 'Second', goal: 'Do the other thing' }])
  await until(() => control!.store.tickets.get(created!.id)?.assignments.at(-1)?.state === 'running',
    'the second Assignment did not start')
  const ticket = control!.store.tickets.get(created!.id)!
  return { ticket, worker: `worker-${ticket.assignments[0]!.id}` }
}

/** A standalone Ticket the Router owns: it belongs to no Project and has a Worker of its own. */
async function standalone(): Promise<{ ticket: Ticket; worker: string }> {
  const request = trigger('trigger-standalone')
  control!.store.triggers.save(request)
  const ticketId = control!.store.atomic(() => {
    control!.engine.recordTriggerForRouting(request)
    const decision = control!.engine.decide('trigger-standalone', { kind: 'accept', title: 'Standalone',
      scope: 'Check the numbers', acknowledgement: 'Check the numbers', reason: { code: 'explicitRouted' } })
    if (!decision.ticketId) throw new Error('the trigger did not create a Ticket')
    return decision.ticketId
  })
  const ticket = control!.store.tickets.get(ticketId)!
  const assignment = ticket.assignments[0]!
  await until(() => control!.session(`worker-${assignment.id}`)?.status === 'idle', 'the Worker did not start')
  return { ticket, worker: `worker-${assignment.id}` }
}

/** A Project of its own, with a PM and a Worker that belong to it. */
async function otherProject(): Promise<{ project: ProjectProfile; pm: { sessionId: string }; worker: string }> {
  control!.store.triggers.save(trigger('trigger-other'))
  const project = control!.createProject('trigger-other', 'Other', 'Other goal')
  const pm = await control!.openProject(project.id)
  const [created] = control!.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Theirs', goal: 'Theirs' }])
  await until(() => control!.store.tickets.get(created!.id)?.assignments.at(-1)?.state === 'running',
    'the Assignment of the other Project did not start')
  return { project, pm, worker: `worker-${created!.assignments[0]!.id}` }
}

/** Start the control plane again on the same file, as a restart of the process would. */
async function restart(): Promise<{ url: string }> {
  await server!.close()
  server = undefined
  await control!.close()
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces'), now: () => clock, confirmationTimeoutMs: 50 })
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

/** The PM's own subscription to the stream of one Session. */
function subscribe(address: { url: string }, pm: string, sessionId: string, intervalSeconds?: number): Promise<Response> {
  return post(address, '/v1/tools/stream/subscribe', tokenOf(pm),
    { sessionId, ...(intervalSeconds === undefined ? {} : { intervalSeconds }) })
}

/** The PM's own end of one subscription. */
function unsubscribe(address: { url: string }, pm: string, sessionId: string): Promise<Response> {
  return post(address, '/v1/tools/stream/unsubscribe', tokenOf(pm), { sessionId })
}

/** Move the clock of the control plane forward. */
function advance(milliseconds: number): void {
  clock = new Date(Date.parse(clock) + milliseconds).toISOString()
}

/** The digests one Session received. */
function digestsOf(sessionId: string): string[] {
  return (node.messages.get(sessionId) ?? []).filter(text => text.includes('[superagent: session stream digest]'))
}

/** The durable subscription records, as the table holds them. */
function records(): { subscription_id: string; status: string; interval_seconds: number; last_pushed_seq: number;
  digest_status: string; next_due_at: string }[] {
  const rows = control!.store.db.prepare('SELECT * FROM session_stream_subscriptions ORDER BY created_at').all() as
    Record<string, unknown>[]
  return rows.map(row => ({
    subscription_id: String(row.subscription_id ?? ''),
    status: String(row.status ?? ''),
    interval_seconds: Number(row.interval_seconds ?? 0),
    last_pushed_seq: Number(row.last_pushed_seq ?? 0),
    digest_status: String(row.digest_status ?? ''),
    next_due_at: String(row.next_due_at ?? ''),
  }))
}

/** The audit of the refused calls, as the escalator's own table holds it. */
function denials(): { tool_name: string; reason_code: string; control_session_id: string }[] {
  const rows = control!.store.db.prepare('SELECT * FROM permission_denial_calls').all() as Record<string, unknown>[]
  return rows.map(row => ({
    tool_name: String(row.tool_name ?? ''),
    reason_code: String(row.reason_code ?? ''),
    control_session_id: String(row.control_session_id ?? ''),
  }))
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('who may watch whom', () => {
  it('refuses a Worker that tries to watch a Session', async () => {
    const { address, worker, ticket } = await open()

    const response = await subscribe(address, worker, worker)
    await control!.settleDenials()

    expect(response.status).toBe(403)
    // The refusal is typed: the role profile is the authority, and it counts as the denial it is.
    expect(denials()).toEqual([{ tool_name: 'control_subscribe_session_stream', reason_code: 'ROLE_TOOL_DENIED',
      control_session_id: worker }])
    expect(control!.denialCounters()).toHaveLength(1)
    expect(ticket.id).toBeTruthy()
  })

  it('lets a PM watch the current Worker of its own Project', async () => {
    const { address, pm, worker } = await open()

    const response = await subscribe(address, pm.sessionId, worker)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { subscription: { status: string; targetSessionId: string
      intervalSeconds: number; subscriberSessionId: string } }
    expect(body.subscription).toMatchObject({ status: 'active', targetSessionId: worker, intervalSeconds: 120 })
    // The subscriber is the token's own Session; the request never names it.
    expect(body.subscription.subscriberSessionId).toBe(pm.sessionId)
  })

  it('lets the Router watch a live PM and a current standalone Worker', async () => {
    const { address, pm } = await open()
    const router = 'router'

    expect((await subscribe(address, router, pm.sessionId)).status).toBe(200)
    const lone = await standalone()
    expect((await subscribe(address, router, lone.worker)).status).toBe(200)
  })

  it('refuses a PM that reaches into another Project, without saying what is there', async () => {
    const { address, pm } = await open()
    const other = await otherProject()

    const response = await subscribe(address, pm.sessionId, other.worker)
    await control!.settleDenials()

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).not.toContain(other.project.id)
    expect(body.error).not.toContain(other.worker)
    // The refusal that reached outside the caller's own scope is typed and counted.
    expect(denials()).toEqual([{ tool_name: 'control_subscribe_session_stream',
      reason_code: 'PROJECT_SCOPE_VIOLATION', control_session_id: pm.sessionId }])
  })

  it('refuses the Router a Worker of a Project, because that Worker belongs to the PM', async () => {
    const { address, pm, worker } = await open()
    const router = 'router'

    const response = await subscribe(address, router, worker)
    await control!.settleDenials()

    expect(response.status).toBe(403)
    // The Router reaches outside its own subordinates, but it has no Project of its own: this is an ordinary refusal.
    expect(denials()).toHaveLength(0)
    expect(pm.sessionId).toBeTruthy()
  })

  it('refuses an unknown Session without saying whether it exists', async () => {
    const { address, pm } = await open()

    const response = await subscribe(address, pm.sessionId, 'worker-does-not-exist')
    await control!.settleDenials()

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('That Session may not be subscribed by this Session')
    // A plain refusal is not a permission denial: it says nothing about a boundary that was crossed.
    expect(denials()).toHaveLength(0)
  })

  it('refuses a Worker whose Assignment was replaced', async () => {
    const { address, pm, ticket, assignment, worker } = await open()
    // A newer Assignment took the work: the Worker that ran it is a different life.
    const record = control!.store.tickets.get(ticket.id)!
    control!.store.tickets.save({ ...record, assignments: [...record.assignments,
      { id: 'assignment-newer', state: 'running', createdAt: START }] })

    const response = await subscribe(address, pm.sessionId, worker)

    expect(response.status).toBe(403)
    expect(assignment.id).toBeTruthy()
  })
})

describe('what a digest says', () => {
  it('reports the tools, the changed files and the tail of the model text of the child', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    node.simulateToolFact(worker, 'write', 'succeeded', { changedPaths: ['src/answer.ts'] })
    node.simulateToolFact(worker, 'write', 'failed', { callId: 'call-2' })
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-3' })
    node.simulateMessage(worker, 'assistant', 'The answer is written and the check passed.')
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    const digests = digestsOf(pm.sessionId)
    expect(digests).toHaveLength(1)
    const digest = digests[0]!
    expect(digest).toContain('[superagent: session stream digest]')
    expect(digest).toContain(`Session: ${worker}`)
    expect(digest).toContain('write (2 calls, 1 failed)')
    expect(digest).toContain('read (1 call)')
    expect(digest).toContain('src/answer.ts')
    expect(digest).toContain('The answer is written and the check passed.')
    // The envelope says that the digest is a fact and grants nothing.
    expect(digest).toContain('grants no authority')
    // The quoted text is fenced as data.
    expect(digest).toContain('--- begin session text ---')
    expect(digest).toContain('--- end session text ---')
    // The stable reference of the child's own panel is part of it.
    expect(digest).toContain(`/v1/console/sessions/${encodeURIComponent(worker)}`)
  })

  it('counts the same backend event once', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    node.simulateToolFact(worker, 'bash', 'succeeded', { callId: 'call-1' })
    node.simulateToolFact(worker, 'bash', 'succeeded', { callId: 'call-1' })
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    expect(digestsOf(pm.sessionId)[0]).toContain('bash (1 call)')
  })

  it('bounds the quoted tail of the model text and keeps the secrets out of it', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    const long = `${'x'.repeat(400)} token=abcdefghijklmnop`
    node.simulateMessage(worker, 'assistant', long)
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    const digest = digestsOf(pm.sessionId)[0]!
    const quoted = digest.split('--- begin session text ---')[1]!.split('--- end session text ---')[0]!
    expect(quoted.length).toBeLessThanOrEqual(320)
    expect(quoted).not.toContain('abcdefghijklmnop')
  })

  it('leaves a path that is not inside the workspace out of the digest', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    node.simulateToolFact(worker, 'write', 'succeeded', { changedPaths: ['../outside.ts', '/etc/passwd', 'src/ok.ts'] })
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    const digest = digestsOf(pm.sessionId)[0]!
    expect(digest).toContain('src/ok.ts')
    expect(digest).not.toContain('outside.ts')
    expect(digest).not.toContain('etc/passwd')
  })

  it('never sends a digest of a range that holds nothing worth reporting', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    // A person's message and a status change are activity, but they are not facts about the work.
    node.simulateMessage(worker, 'user', 'please fix it')
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    expect(digestsOf(pm.sessionId)).toHaveLength(0)
  })

  it('starts without a history: what happened before the subscription is not part of the first digest', async () => {
    const { address, pm, worker } = await open()

    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'before' })
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    expect(digestsOf(pm.sessionId)).toHaveLength(0)
    // The watermark started at the log's high water mark, so the earlier call is behind it.
    expect(records()[0]!.last_pushed_seq).toBeGreaterThan(0)
  })
})

describe('which Session hears it', () => {
  it('reports the Worker that was watched and stays quiet about the other one', async () => {
    const { address, pm, project, worker } = await open()
    const other = await secondTicket(project.id, pm.sessionId)
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    node.simulateToolFact(other.worker, 'read', 'succeeded', { callId: 'call-other' })
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-watched' })
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    const digests = digestsOf(pm.sessionId)
    expect(digests).toHaveLength(1)
    expect(digests[0]).toContain(`Session: ${worker}`)
    expect(digests[0]).not.toContain(other.worker)
  })

  it('stops the digests at once when the subscription ends', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    expect((await unsubscribe(address, pm.sessionId, worker)).status).toBe(200)
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-after' })
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    expect(digestsOf(pm.sessionId)).toHaveLength(0)
    expect(records()[0]!.status).toBe('unsubscribed')
  })

  it('does not send a digest that is on its way when the subscription ends', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-1' })

    // The node came back: the PM's record is confirmed under an older generation, so the digest has to ensure the
    // Session again before it goes out. The ensure is what the superior's request races with.
    control!.nodeReconnected()
    const release = node.holdEnsures()
    advance(2 * MINUTE)
    const running = control!.runStreamDigests()
    await until(() => node.heldEnsures.length > 0, 'the target was not ensured again')

    expect((await unsubscribe(address, pm.sessionId, worker)).status).toBe(200)
    release()
    await running

    // The check that runs immediately before the transport read the subscription's own state and refused the digest.
    expect(digestsOf(pm.sessionId)).toHaveLength(0)
    expect(records()[0]!.digest_status).toBe('failed')
  })

  it('makes the subscription terminal when the child ends, and never follows a successor', async () => {
    const { address, pm, ticket, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    const watermark = records()[0]!.last_pushed_seq

    // The Ticket ended: the child has no work any more.
    const record = control!.store.tickets.get(ticket.id)!
    control!.store.tickets.save({ ...record, ended: { at: START, by: 'executor', outcome: 'completed' } })
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    expect(records()[0]!.status).toBe('terminal')
    // A successor never inherits the subscription: the watermark of the old one stays where it was.
    expect(records()[0]!.last_pushed_seq).toBe(watermark)
    expect(digestsOf(pm.sessionId)).toHaveLength(0)
  })

  it('makes the subscription terminal when the child is stopped by an operator', async () => {
    const { address, pm, ticket, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    control!.session(worker)!.operatorStop = { at: START, by: 'operator', state: 'confirmed' }
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    expect(records()[0]!.status).toBe('terminal')
    expect(digestsOf(pm.sessionId)).toHaveLength(0)
  })

  it('makes the subscription terminal when the child is revoked', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    control!.session(worker)!.revokedAt = START
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    expect(records()[0]!.status).toBe('terminal')
  })
})

describe('the rhythm of a digest', () => {
  it('is a no-op when it is repeated: nothing is replayed and nothing is skipped', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-1' })
    advance(2 * MINUTE)
    await control!.runStreamDigests()
    expect(digestsOf(pm.sessionId)).toHaveLength(1)
    const watermark = records()[0]!.last_pushed_seq

    // The same subscription again: it keeps its watermark and its rhythm.
    const response = await subscribe(address, pm.sessionId, worker)
    expect(response.status).toBe(200)
    expect(records()[0]!.last_pushed_seq).toBe(watermark)
    expect(records()).toHaveLength(1)

    advance(2 * MINUTE)
    await control!.runStreamDigests()
    // The range was already reported, so nothing goes out a second time.
    expect(digestsOf(pm.sessionId)).toHaveLength(1)
  })

  it('changes the interval without moving the watermark', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    const watermark = records()[0]!.last_pushed_seq

    const response = await subscribe(address, pm.sessionId, worker, 45)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { subscription: { intervalSeconds: number } }
    expect(body.subscription.intervalSeconds).toBe(45)
    expect(records()[0]!.last_pushed_seq).toBe(watermark)
    expect(records()[0]!.interval_seconds).toBe(45)
  })

  it('keeps an interval inside the bounds the deployment allows', async () => {
    const { address, pm, worker } = await open()

    const response = await subscribe(address, pm.sessionId, worker, 5)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { subscription: { intervalSeconds: number } }
    expect(body.subscription.intervalSeconds).toBe(30)
  })

  it('merges the ranges it missed into one digest', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-1' })
    // Three intervals pass without a tick: the ranges are merged, not replayed one after another.
    advance(10 * MINUTE)
    await control!.runStreamDigests()

    expect(digestsOf(pm.sessionId)).toHaveLength(1)
  })

  it('runs one tick at a time', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-1' })
    advance(2 * MINUTE)

    await Promise.all([control!.runStreamDigests(), control!.runStreamDigests(), control!.runStreamDigests()])

    expect(digestsOf(pm.sessionId)).toHaveLength(1)
  })
})

describe('when the delivery does not go out', () => {
  it('keeps the range and sends it later as one digest', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-1' })

    // The node refuses the message: the digest did not go out, so the range stays.
    node.failures.set(pm.sessionId, new Error('the node refused the message'))
    advance(2 * MINUTE)
    await control!.runStreamDigests()
    expect(digestsOf(pm.sessionId)).toHaveLength(0)
    const watermark = records()[0]!.last_pushed_seq

    node.failures.delete(pm.sessionId)
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    // The range was never reported, so it is reported now — once, and as one digest.
    expect(digestsOf(pm.sessionId)).toHaveLength(1)
    expect(records()[0]!.last_pushed_seq).toBeGreaterThan(watermark)
  })

  it('keeps a digest whose receipt is missing as unconfirmed and never sends it again', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-1' })

    node.failures.set(pm.sessionId, new NodeUnconfirmedError('the receipt was lost'))
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    expect(records()[0]!.digest_status).toBe('unconfirmed')
    const watermark = records()[0]!.last_pushed_seq

    // The digest may have arrived: it is not sent again, and the watermark moved on.
    node.failures.delete(pm.sessionId)
    advance(2 * MINUTE)
    await control!.runStreamDigests()
    expect(digestsOf(pm.sessionId)).toHaveLength(0)
    expect(records()[0]!.last_pushed_seq).toBe(watermark)
  })

  it('does not repeat a digest after a restart', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-1' })
    advance(2 * MINUTE)
    await control!.runStreamDigests()
    expect(digestsOf(pm.sessionId)).toHaveLength(1)
    const watermark = records()[0]!.last_pushed_seq

    const restarted = await restart()
    node.messages.clear()

    advance(2 * MINUTE)
    await control!.runStreamDigests()

    // The subscription of the previous run is running again with the watermark it had reached, so the range it already
    // reported is not reported a second time.
    expect(records()[0]!.status).toBe('active')
    expect(records()[0]!.last_pushed_seq).toBeGreaterThanOrEqual(watermark)
    expect(digestsOf(pm.sessionId)).toHaveLength(0)
    expect(restarted.url).toBeTruthy()
  })

  it('marks a digest that was on its way when the control plane stopped as unconfirmed', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-1' })

    // The state a control plane leaves behind when it stops while a digest is on its way: the claim is written and the
    // message never left. The recovery reads it back and says that the outcome is unknown.
    const watermark = records()[0]!.last_pushed_seq
    control!.store.db.prepare(
      "UPDATE session_stream_subscriptions SET digest_status = 'dispatching', digest_key = 'stream-digest:in-flight', "
      + 'digest_end_seq = ? WHERE subscription_id = ?').run(watermark + 1, records()[0]!.subscription_id)

    await restart()

    // The record of the previous run says that the outcome is unknown, the watermark moved past the range it covered
    // and the digest is never sent again.
    expect(records()[0]!.digest_status).toBe('unconfirmed')
    expect(records()[0]!.last_pushed_seq).toBe(watermark + 1)
    advance(2 * MINUTE)
    await control!.runStreamDigests()
    expect(digestsOf(pm.sessionId)).toHaveLength(0)
  })

  it('sends the newest facts only after a reconnect', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'old' })
    node.simulateMessage(worker, 'assistant', 'the old answer')
    await restart()
    node.messages.clear()
    node.simulateToolFact(worker, 'write', 'succeeded', { callId: 'new', changedPaths: ['src/new.ts'] })
    advance(10 * MINUTE)
    await control!.runStreamDigests()

    const digests = digestsOf(pm.sessionId)
    expect(digests).toHaveLength(1)
    expect(digests[0]).toContain('src/new.ts')
  })
})

describe('the record of a subscription', () => {
  it('names the scope, the state and the reference the console shows', async () => {
    const { address, pm, project, ticket, assignment, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    const view = control!.streamSubscriptions()[0]!
    expect(view).toMatchObject({ subscriberSessionId: pm.sessionId, subscriberRole: 'pm', targetSessionId: worker,
      targetRole: 'worker', targetProjectId: project.id, targetTicketId: ticket.id,
      targetAssignmentId: assignment.id, status: 'active', intervalSeconds: 120 })
    expect(view.contextRef).toBe(`/v1/console/sessions/${encodeURIComponent(worker)}`)
  })

  it('is read by the console through its own route', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    const response = await fetch(`${address.url}/v1/console/stream-subscriptions`,
      { headers: { authorization: `Bearer ${API_TOKEN}` } })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { subscriptions: { targetSessionId: string }[] }
    expect(body.subscriptions[0]!.targetSessionId).toBe(worker)
  })
})

describe('what a digest may quote', () => {
  it('never quotes a fact that came from another node', async () => {
    const { address, pm, project, assignment, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    // The event carries the session id of the watched Worker, but it came from another machine.
    node.simulateEvent({
      protocolVersion: NODE_PROTOCOL_VERSION, nodeId: 'another-node', sessionId: worker, projectId: project.id,
      role: 'worker', assignmentId: assignment.id, type: 'tool.fact',
      fact: { toolName: 'write', outcome: 'succeeded', callId: 'call-foreign', changedPaths: ['secret.txt'] },
    })
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-own' })
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    const digest = digestsOf(pm.sessionId)[0]!
    expect(digest).toContain('read (1 call)')
    expect(digest).not.toContain('secret.txt')
    expect(digest).not.toContain('write')
  })

  it('never quotes a fact that belongs to another Assignment', async () => {
    const { address, pm, project, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    // The node is the right one, but the fact names the Assignment of another life of the Worker.
    node.simulateEvent({
      protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID, sessionId: worker, projectId: project.id,
      role: 'worker', assignmentId: 'assignment-of-another-life', type: 'tool.fact',
      fact: { toolName: 'write', outcome: 'succeeded', callId: 'call-foreign', changedPaths: ['secret.txt'] },
    })
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-own' })
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    const digest = digestsOf(pm.sessionId)[0]!
    expect(digest).toContain('read (1 call)')
    expect(digest).not.toContain('secret.txt')
    expect(digest).not.toContain('write')
  })

  it('never quotes a fact that another backend made', async () => {
    const { address, pm, project, assignment, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    node.simulateEvent({
      protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID, sessionId: worker, projectId: project.id,
      role: 'worker', assignmentId: assignment.id, type: 'tool.fact',
      fact: { toolName: 'write', outcome: 'succeeded', callId: 'call-foreign', backend: 'another-backend',
        changedPaths: ['secret.txt'] },
    })
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-own' })
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    const digest = digestsOf(pm.sessionId)[0]!
    expect(digest).toContain('read (1 call)')
    expect(digest).not.toContain('secret.txt')
    expect(digest).not.toContain('write')
  })

  it('never quotes a row of the log that came from another node', async () => {
    const { address, pm, project, assignment, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    // A row of another node is already in the log: the aggregation reads the source of every row it quotes.
    const seq = control!.consoleStore.nextEventSeq()
    control!.consoleStore.appendEvent({ seq, at: START, nodeId: 'another-node', sessionId: worker, type: 'tool.fact',
      kind: '', payload: JSON.stringify({ protocolVersion: NODE_PROTOCOL_VERSION, nodeId: 'another-node',
        sessionId: worker, projectId: project.id, role: 'worker', assignmentId: assignment.id, type: 'tool.fact',
        fact: { toolName: 'write', outcome: 'succeeded', callId: 'call-foreign', changedPaths: ['secret.txt'] } }) })
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-own' })
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    const digest = digestsOf(pm.sessionId)[0]!
    expect(digest).toContain('read (1 call)')
    expect(digest).not.toContain('secret.txt')
    expect(digest).not.toContain('write')
  })

  it('never quotes a row of the log that names another Assignment', async () => {
    const { address, pm, project, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    const seq = control!.consoleStore.nextEventSeq()
    control!.consoleStore.appendEvent({ seq, at: START, nodeId: NODE_ID, sessionId: worker, type: 'tool.fact',
      kind: '', payload: JSON.stringify({ protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID,
        sessionId: worker, projectId: project.id, role: 'worker', assignmentId: 'assignment-of-another-life',
        type: 'tool.fact',
        fact: { toolName: 'write', outcome: 'succeeded', callId: 'call-foreign', changedPaths: ['secret.txt'] } }) })
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-own' })
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    const digest = digestsOf(pm.sessionId)[0]!
    expect(digest).toContain('read (1 call)')
    expect(digest).not.toContain('secret.txt')
    expect(digest).not.toContain('write')
  })

  it('keeps the quoted text and the reference whole when the lists are long', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)

    node.simulateToolFact(worker, 'bash', 'succeeded', { callId: 'bash-1' })
    node.simulateToolFact(worker, 'bash', 'failed', { callId: 'bash-2' })
    node.simulateToolFact(worker, 'bash', 'succeeded', { callId: 'bash-3' })
    for (let index = 0; index < 20; index += 1) {
      node.simulateToolFact(worker, `tool-${String(index).padStart(2, '0')}-${'x'.repeat(50)}`, 'succeeded',
        { callId: `long-${index}`, changedPaths: [`src/${'nested/'.repeat(24)}file-${index}.ts`] })
    }
    node.simulateMessage(worker, 'assistant', 'the last thing the model said')
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    const digest = digestsOf(pm.sessionId)[0]!
    expect(digest.length).toBeLessThanOrEqual(4000)
    // The counts of a tool are still the child's own.
    expect(digest).toContain('bash (3 calls, 1 failed)')
    // The quoted text is whole, and the reference is the last line: nothing was cut off at the end.
    expect(digest).toContain('--- begin session text ---')
    expect(digest).toContain('--- end session text ---')
    expect(digest.trimEnd().endsWith(`/v1/console/sessions/${encodeURIComponent(worker)}`)).toBe(true)
  })
})

describe('when the delivery may not go out', () => {
  it('does not even ensure the Session when the subscription is over before the delivery', async () => {
    const { address, pm, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-1' })

    const ensuresBefore = node.commands.filter(command => command.type === 'pm.ensure').length
    // The node came back, so the Session would have to be ensured again before the digest goes out.
    control!.nodeReconnected()
    advance(2 * MINUTE)
    const running = control!.runStreamDigests()
    // The subscription ends while the digest is on its way: the check that runs before the transport reads the
    // subscription's own state, and the Session is never woken up for a digest that will not go out.
    control!.unsubscribeSessionStream(pm.sessionId, worker)
    await running

    expect(node.commands.filter(command => command.type === 'pm.ensure')).toHaveLength(ensuresBefore)
    expect(digestsOf(pm.sessionId)).toHaveLength(0)
    expect(records()[0]!.digest_status).toBe('failed')
  })

  it('keeps the range and the rhythm when the resolution itself fails', async () => {
    const { address, pm, project, worker } = await open()
    expect((await subscribe(address, pm.sessionId, worker)).status).toBe(200)
    node.simulateToolFact(worker, 'read', 'succeeded', { callId: 'call-1' })

    // The resolution reads the Project of the superior, and a Project that cannot be read makes the resolution fail.
    const whole = control!.store.projects.get(project.id)!
    control!.store.db.prepare('UPDATE project SET value = ? WHERE id = ?').run('{not json', project.id)
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    expect(digestsOf(pm.sessionId)).toHaveLength(0)
    expect(records()[0]!.status).toBe('active')
    expect(records()[0]!.digest_status).toBe('failed')

    // The range stayed where it was, and the subscription is still running: the next tick sends it.
    control!.store.projects.save(whole)
    advance(2 * MINUTE)
    await control!.runStreamDigests()

    expect(digestsOf(pm.sessionId)).toHaveLength(1)
    expect(digestsOf(pm.sessionId)[0]).toContain('read (1 call)')
  })
})
