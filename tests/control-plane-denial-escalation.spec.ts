/**
 * The permission denial guard of the control plane and the escalation it starts.
 *
 * A denial here is a fact about a refusal a guard decided: the role profile refused a tool, a call reached outside the
 * Session's Project, or the node's own tool guard refused a call. Nothing is guessed — an ordinary failure of the work
 * behind a tool, a malformed argument, a node that is offline, a token that may be refreshed and a Worker's own `blocked`
 * report are all facts about something else, and none of them is counted.
 *
 * The counters live in the control plane's own file: a burst of the same refusal in one turn is one effective denial, a
 * replay of one call is neither audited nor counted twice, one set of walls makes one review, and a review that waits for a
 * superior that could not be reached stays pending instead of waking anybody.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket, Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { PM_PROFILE, ROUTER_PROFILE, WORKER_PROFILE, profileFor, roleToolDecision } from '../src/control/roles.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const SECRET = 'denial-secret'
const API_TOKEN = 'denial-api-token'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode
/** The clock of the control plane, which a test moves when a window has to pass. */
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

interface Opened {
  project: ProjectProfile
  pm: { sessionId: string }
  ticket: Ticket
  assignment: Assignment
  worker: string
  address: { url: string }
}

/** A Project whose PM and first Worker Session exist, plus the tool API listening on a random port. */
async function open(options: { denialThreshold?: number; denialWindowMs?: number
  denialCooldownMs?: number; denialFuseLimit?: number } = {}): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-denial-'))
  clock = START
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => clock, confirmationTimeoutMs: 50,
    ...(options.denialThreshold === undefined ? {} : { denialThreshold: options.denialThreshold }),
    ...(options.denialWindowMs === undefined ? {} : { denialWindowMs: options.denialWindowMs }),
    ...(options.denialCooldownMs === undefined ? {} : { denialCooldownMs: options.denialCooldownMs }),
    ...(options.denialFuseLimit === undefined ? {} : { denialFuseLimit: options.denialFuseLimit }) })
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

/** A standalone Ticket the Router owns: it belongs to no Project and has a Worker of its own. */
async function standalone(): Promise<{ ticket: Ticket; assignment: Assignment; worker: string }> {
  const request = trigger('trigger-standalone')
  control!.store.triggers.save(request)
  const ticketId = control!.store.atomic(() => {
    control!.engine.recordTriggerForRouting(request)
    const decision = control!.engine.decide('trigger-standalone', { kind: 'accept', title: 'Standalone',
      scope: 'Check the numbers', acknowledgement: 'Check the numbers', reason: { code: 'explicitRouted' } })
    if (!decision.ticketId) throw new Error('the trigger did not create a Ticket')
    return decision.ticketId
  })
  const assignment = control!.store.tickets.get(ticketId)!.assignments[0]!
  await until(() => control!.session(`worker-${assignment.id}`)?.status === 'idle', 'the Worker did not start')
  return { ticket: control!.store.tickets.get(ticketId)!, assignment, worker: `worker-${assignment.id}` }
}

function tokenOf(sessionId: string): string {
  const token = node.tokens.get(sessionId)
  if (!token) throw new Error(`The FakeNode has no token for ${sessionId}`)
  return token
}

/** One call the guard refuses, as the node's proxy tool makes it. */
function refuse(address: { url: string }, token: string, path: string, callId?: string): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(callId === undefined ? {} : { 'x-superagent-call-id': callId }) },
    body: JSON.stringify({}) })
}

/** The refusals the escalator recorded, as the console reads them. */
function reviews(): ReturnType<ControlPlane['denialReviews']> { return control!.denialReviews() }

/**
 * The system permission denial review a Session received.
 *
 * The inbox of a Session holds more than the review: a Worker's own report reaches its PM as well, and the review is the
 * one message that names the refusal. It is selected by what it says, so a test never reads the wrong message.
 */
function denialReviewMessage(sessionId: string): string {
  const message = (node.messages.get(sessionId) ?? []).find(text => text.includes('System permission denial review'))
  if (message === undefined) throw new Error(`The Session ${sessionId} received no permission denial review`)
  return message
}

/** The counters the escalator holds. */
function counters(): ReturnType<ControlPlane['denialCounters']> { return control!.denialCounters() }

/** The audit of the refused calls, as the escalator's own table holds it. */
function calls(): { call_id: string; turn_id: string; tool_name: string; reason_code: string;
  control_session_id: string; summary: string }[] {
  return control!.store.db.prepare('SELECT * FROM permission_denial_calls ORDER BY rowid').all() as
    { call_id: string; turn_id: string; tool_name: string; reason_code: string; control_session_id: string;
      summary: string }[]
}

/** Move the clock of the control plane forward. */
function advance(milliseconds: number): void {
  clock = new Date(Date.parse(clock) + milliseconds).toISOString()
}

/**
 * A review of a Worker's refusal, with the PM of the Project as its superior.
 *
 * The fixture is the one the whole file shares: a Project whose Worker really runs, three refused calls in three turns of
 * its own, and the review that the window those calls hold makes. The turns are set and settled as the other tests do, so
 * the refusals are attributed to the work that runs now.
 */
async function reviewed(): Promise<Opened & { reviewId: string }> {
  const opened = await open()
  for (let index = 0; index < 3; index += 1) {
    node.holdTurn(opened.worker)
    await refuse(opened.address, tokenOf(opened.worker), '/v1/tools/pm/tickets', `call-${index}`)
    await control!.settleDenials()
  }
  await until(() => reviews().length > 0, 'no review was made')
  return { ...opened, reviewId: reviews()[0]!.noticeId }
}

/** The authorization applications the escalator holds. */
function applications(): ReturnType<ControlPlane['denialAuthorizations']> { return control!.denialAuthorizations() }

/** The call a PM or the Router makes to raise an authorization application about one review. */
function applyFor(address: { url: string }, token: string, reviewId: string, callId?: string): Promise<Response> {
  return fetch(`${address.url}/v1/tools/denial/authorization`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...(callId === undefined ? {} : { 'x-superagent-call-id': callId }) },
    body: JSON.stringify({ reviewId }) })
}

/** The operator's decision on one application, through the console's own route. */
function decide(address: { url: string }, applicationId: string, decision: string): Promise<Response> {
  return fetch(`${address.url}/v1/console/denials/authorizations`, { method: 'POST',
    headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ applicationId, decision }) })
}

/** The console's own view of the permission denials. */
async function panel(address: { url: string }): Promise<{ reviews: { noticeId: string; taskContext: string }[];
  applications: { applicationId: string }[] }> {
  const answer = await fetch(`${address.url}/v1/console/denials?limit=24`,
    { headers: { authorization: `Bearer ${API_TOKEN}` } })
  return answer.json() as Promise<{ reviews: { noticeId: string; taskContext: string }[];
    applications: { applicationId: string }[] }>
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the role profile decides the tool', () => {
  it('reads the deny list before the allow list', () => {
    const both = { name: 'test.v1', prompt: '', tools: ['write', 'read'], deny: ['write'], permission: 'read-only' }

    // The explicit refusal wins over the allow list, and a name neither list names is refused as well.
    expect(roleToolDecision(both, 'write')).toMatchObject({ allowed: false, reasonCode: 'ROLE_TOOL_DENIED' })
    expect(roleToolDecision(both, 'read')).toMatchObject({ allowed: true })
    expect(roleToolDecision(both, 'bash')).toMatchObject({ allowed: false, reasonCode: 'ROLE_TOOL_DENIED' })
    // A profile this control plane does not know grants nothing.
    expect(roleToolDecision(undefined, 'read')).toMatchObject({ allowed: false, reasonCode: 'ROLE_TOOL_DENIED' })
  })

  it('knows the profile of every role the control plane runs', () => {
    expect(profileFor(PM_PROFILE.name)?.name).toBe(PM_PROFILE.name)
    expect(profileFor(WORKER_PROFILE.name)?.name).toBe(WORKER_PROFILE.name)
    expect(profileFor(ROUTER_PROFILE.name)?.name).toBe(ROUTER_PROFILE.name)
    expect(profileFor('no-such-profile')).toBeUndefined()
  })
})

describe('the guard of the control plane tool ingress', () => {
  it('refuses a tool the role may not use and records the refusal', async () => {
    const { project, worker, address } = await open()

    const answer = await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', 'call-1')

    expect(answer.status).toBe(403)
    await control!.settleDenials()
    expect(counters()).toHaveLength(1)
    expect(counters()[0]).toMatchObject({ controlSessionId: worker, role: 'worker', windowCount: 1,
      nodeId: NODE_ID, backendId: 'dsh', managerTarget: `pm:${project.id}`, projectId: project.id })
    expect(calls()).toHaveLength(1)
    expect(calls()[0]).toMatchObject({ tool_name: 'control_create_tickets', reason_code: 'ROLE_TOOL_DENIED' })
  })

  it('counts a replayed call once and audits it once', async () => {
    const { worker, address } = await open()

    const first = await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', 'call-1')
    await control!.settleDenials()
    // The very same call again — the retry after a token refresh, or a request that was sent twice.
    const second = await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', 'call-1')
    await control!.settleDenials()

    // Both requests were really refused; only the second one changed nothing.
    expect(first.status).toBe(403)
    expect(second.status).toBe(403)
    expect(calls()).toHaveLength(1)
    expect(counters()[0]?.windowCount).toBe(1)
  })

  it('audits every call of a burst and ends the turn without a caller-proved identity', async () => {
    const { worker, address } = await open()
    node.holdTurn(worker)

    // No call id at all: the request names itself, so five refusals are five calls and not one replay.
    for (let index = 0; index < 5; index += 1) {
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets')
      await control!.settleDenials()
    }

    // Every call is audited, the burst is one effective denial, and the turn that keeps hitting the wall is ended.
    expect(calls()).toHaveLength(5)
    expect(counters()[0]?.windowCount).toBe(1)
    const interrupts = node.commands.filter(command => command.type === 'session.interrupt')
    expect(interrupts).toHaveLength(1)
    expect(interrupts[0]).toMatchObject({ sessionId: worker })
  })

  it('folds a burst of the same refusal in one turn into one effective denial', async () => {
    const { worker, address } = await open()
    const turn = node.holdTurn(worker)

    for (let index = 0; index < 5; index += 1) {
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }

    // Every refusal is audited, but the window holds one effective denial: five parallel calls are one wall.
    expect(calls()).toHaveLength(5)
    expect(calls().every(call => call.turn_id === String(turn))).toBe(true)
    expect(counters()[0]?.windowCount).toBe(1)
    // One denial is not a review.
    expect(reviews()).toHaveLength(0)
  })

  it('records a call that reaches outside the Session\'s own Project as a scope violation', async () => {
    const { project, ticket, worker, address } = await open()
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const otherPm = await control!.openProject(other.id)
    const [foreign] = control!.engine.createProjectTickets(other.id, otherPm.sessionId,
      [{ title: 'Foreign', goal: 'G' }])
    await until(() => control!.store.tickets.get(foreign!.id)?.assignments.at(-1)?.state === 'running',
      'the foreign Assignment did not start')

    const answer = await fetch(`${address.url}/v1/tools/worker/report`, { method: 'POST',
      headers: { authorization: `Bearer ${tokenOf(worker)}`, 'content-type': 'application/json',
        'x-superagent-call-id': 'scope-1' },
      body: JSON.stringify({ ticketId: foreign!.id, report: { state: 'progress', summary: 'x' } }) })

    // The other Project's Ticket is unknown to the caller: the refusal says nothing about it.
    expect(answer.status).toBe(400)
    await control!.settleDenials()
    expect(calls()).toHaveLength(1)
    expect(calls()[0]).toMatchObject({ reason_code: 'PROJECT_SCOPE_VIOLATION', tool_name: 'control_report' })
    // The record never carries the other Project's identity: it names the caller's own scope and nothing else.
    expect(counters()[0]).toMatchObject({ projectId: project.id, controlSessionId: worker })
    expect(ticket.id).not.toBe(foreign!.id)
  })

  it('records a PM call that reached outside its own Project and refuses it like an unknown Ticket', async () => {
    const { project, pm, address } = await open()
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const otherPm = await control!.openProject(other.id)
    const [foreign] = control!.engine.createProjectTickets(other.id, otherPm.sessionId,
      [{ title: 'Foreign', goal: 'G' }])
    await until(() => control!.store.tickets.get(foreign!.id)?.assignments.at(-1)?.state === 'running',
      'the foreign Assignment did not start')
    const turn = node.holdTurn(pm.sessionId)

    const token = tokenOf(pm.sessionId)
    const message = (ticketId: string, callId: string): Promise<Response> => fetch(`${address.url}/v1/tools/pm/message`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'x-superagent-call-id': callId }, body: JSON.stringify({ ticketId, text: 'do it' }) })

    const foreignAnswer = await message(foreign!.id, 'pm-foreign')
    const missingAnswer = await message('no-such-ticket', 'pm-missing')

    // The other Project's Ticket and a Ticket that does not exist are refused the same way: the answer says nothing
    // about whether another Project's work exists, and only echoes the id the caller named itself.
    expect(foreignAnswer.status).toBe(400)
    expect(missingAnswer.status).toBe(400)
    expect((await foreignAnswer.text()).replace(foreign!.id, '<ticket>'))
      .toBe((await missingAnswer.text()).replace('no-such-ticket', '<ticket>'))

    await control!.settleDenials()
    // Only the call that really reached outside the caller's own Project is counted.
    expect(calls()).toHaveLength(1)
    expect(calls()[0]).toMatchObject({ reason_code: 'PROJECT_SCOPE_VIOLATION', tool_name: 'control_message_worker',
      control_session_id: pm.sessionId, turn_id: String(turn) })
    expect(counters()).toHaveLength(1)
    expect(counters()[0]).toMatchObject({ controlSessionId: pm.sessionId, role: 'pm', projectId: project.id,
      managerTarget: 'router' })
    // The record names the caller's own scope and never the other Project's work.
    expect(calls()[0]!.summary).not.toContain(foreign!.id)
    expect(counters()[0]!.projectId).not.toBe(other.id)
  })
})

describe('the escalation of the denials', () => {
  it('wakes the PM of the Project once when the window holds three effective denials', async () => {
    const { pm, worker, address } = await open()

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }

    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()[0]).toMatchObject({ kind: 'system_denial_review', status: 'notified',
      controlSessionId: worker, role: 'worker', targetSessionId: pm.sessionId, targetRole: 'pm',
      reasonCode: 'ROLE_TOOL_DENIED', toolName: 'control_create_tickets', denialCount: 3, nodeId: NODE_ID,
      backendId: 'dsh' })
    // The superior heard about it once, and the message says what it may and may not do.
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
    const message = node.messages.get(pm.sessionId)![0]!
    expect(message).toContain('The refused calls are still refused')
    expect(message).toContain('You may not grant the access yourself')
  })

  it('makes one review per window and no second wake', async () => {
    const { pm, worker, address } = await open()

    for (let index = 0; index < 5; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }

    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()).toHaveLength(1)
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
  })

  it('makes a second review in a later window', async () => {
    const { pm, worker, address } = await open()

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }
    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()).toHaveLength(1)

    // The window passes and the cooldown is over: a new wall is a new review.
    advance(11 * 60_000)
    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `later-${index}`)
      await control!.settleDenials()
    }

    await until(() => reviews().length > 1, 'the later window made no review')
    expect(reviews()).toHaveLength(2)
    expect(node.messages.get(pm.sessionId)).toHaveLength(2)
  })

  it('escalates a standalone Worker to the Router', async () => {
    const { address } = await open()
    const { worker } = await standalone()

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }

    await until(() => reviews().length > 0, 'no review was made')
    // The review names the Session it goes to; the scope it is counted in names the superior of that scope.
    expect(reviews()[0]).toMatchObject({ kind: 'system_denial_review', controlSessionId: worker, role: 'worker',
      targetSessionId: 'router', targetRole: 'router' })
    expect(counters()[0]).toMatchObject({ managerTarget: 'router' })
    await until(() => reviews()[0]?.status === 'notified', 'the Router was not told')
    expect(node.messages.get('router')).toHaveLength(1)
  })

  it('escalates a PM to the Router', async () => {
    const { pm, address } = await open()

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(pm.sessionId)
      await refuse(address, tokenOf(pm.sessionId), '/v1/tools/router/dispatch', `call-${index}`)
      await control!.settleDenials()
    }

    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()[0]).toMatchObject({ kind: 'system_denial_review', controlSessionId: pm.sessionId, role: 'pm',
      targetSessionId: 'router', targetRole: 'router' })
    expect(node.messages.get('router')).toHaveLength(1)
  })

  it('writes an operator alert for the Router itself and wakes nobody', async () => {
    const { address } = await open()

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn('router')
      await refuse(address, tokenOf('router'), '/v1/tools/worker/report', `call-${index}`)
      await control!.settleDenials()
    }

    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()[0]).toMatchObject({ kind: 'operator_denial_alert', status: 'notified',
      controlSessionId: 'router', role: 'router', targetSessionId: '', targetRole: 'operator' })
    // The Router is the top of the ladder: there is nobody above it but the operator, and the operator reads the console.
    expect(node.messages.get('router')).toBeUndefined()
  })

  it('leaves the review pending when the superior was stopped by an operator', async () => {
    const { pm, worker, address } = await open()
    await control!.stopSessionByOperator(pm.sessionId, '停')

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }

    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()[0]).toMatchObject({ status: 'pending_manager_online', targetSessionId: pm.sessionId })
    // The PM a person put to rest is never brought back by a review.
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
  })

  it('ends the turn that kept hitting the same wall, and only that turn', async () => {
    const { worker, address } = await open()
    const turn = node.holdTurn(worker)

    for (let index = 0; index < 5; index += 1) {
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }

    const interrupts = node.commands.filter(command => command.type === 'session.interrupt')
    expect(interrupts).toHaveLength(1)
    expect(interrupts[0]).toMatchObject({ sessionId: worker, turn })
    // The Session is not stopped: it keeps its identity, its authority and its inbox.
    expect(control!.session(worker)?.status).not.toBe('stopped')
    expect(control!.session(worker)?.operatorStop).toBeUndefined()
  })

  it('leaves a later turn alone', async () => {
    const { worker, address } = await open()

    node.holdTurn(worker)
    for (let index = 0; index < 5; index += 1) {
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }
    expect(node.commands.filter(command => command.type === 'session.interrupt')).toHaveLength(1)

    // A turn that starts afterwards is a new turn: it has its own fuse and is never ended by the old one.
    node.holdTurn(worker)
    for (let index = 0; index < 4; index += 1) {
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `later-${index}`)
      await control!.settleDenials()
    }
    expect(node.commands.filter(command => command.type === 'session.interrupt')).toHaveLength(1)
  })

  it('makes no second review about the same walls', async () => {
    const { pm, worker, address } = await open({ denialCooldownMs: 60_000, denialFuseLimit: 10 })
    const walls = ['/v1/tools/pm/tickets', '/v1/tools/pm/message', '/v1/tools/pm/review']

    // Three walls in one turn: the PM hears about them once.
    node.holdTurn(worker)
    for (const [index, path] of walls.entries()) {
      await refuse(address, tokenOf(worker), path, `wall-${index}`)
      await control!.settleDenials()
    }
    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()).toHaveLength(1)
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)

    // The cooldown is over, but the model hits the very same walls again: this scope has been told about this wall, and
    // a review is not made twice about the same one.
    advance(2 * 60_000)
    for (const [index, path] of walls.entries()) {
      await refuse(address, tokenOf(worker), path, `again-${index}`)
      await control!.settleDenials()
    }

    expect(reviews()).toHaveLength(1)
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
  })

  it('slides its window instead of resetting it at the first refusal', async () => {
    const { worker, address } = await open({ denialWindowMs: 10 * 60_000, denialCooldownMs: 0 })

    // The window always covers the last ten minutes of the scope's own history: a refusal that arrives while the scope
    // is still active joins the count it belongs to, and the older numbers do not disappear when a new one arrives.
    node.holdTurn(worker)
    await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', 'a-0')
    await control!.settleDenials()
    expect(counters()[0]?.windowCount).toBe(1)

    advance(5 * 60_000)
    node.holdTurn(worker)
    await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', 'b-0')
    await control!.settleDenials()
    expect(counters()[0]?.windowCount).toBe(2)

    // The first refusal is now outside the window, but the second one is inside it: the count does not start again at
    // one, it slides.
    advance(6 * 60_000)
    node.holdTurn(worker)
    await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', 'c-0')
    await control!.settleDenials()
    expect(counters()[0]?.windowCount).toBe(2)

    advance(1 * 60_000)
    node.holdTurn(worker)
    await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', 'd-0')
    await control!.settleDenials()
    // The window holds the two refusals that are still inside it and the new one, so the threshold is reached: a window
    // that reset at the first refusal would have needed three more refusals for that.
    expect(counters()[0]?.windowCount).toBe(3)
    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()).toHaveLength(1)
  })
})

describe('what is not a denial', () => {
  it('counts no ordinary failure of the work behind a tool', async () => {
    const { ticket, assignment, worker, address } = await open()
    const token = tokenOf(worker)

    // A report whose payload the domain refuses: a malformed argument is a fact about the argument.
    const malformed = await fetch(`${address.url}/v1/tools/worker/report`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: ticket.id, assignmentId: assignment.id,
        report: { state: 'nonsense', summary: 'x' } }) })
    expect(malformed.status).toBe(400)

    // A report about a Ticket that does not exist: an unknown Ticket is not a scope violation.
    const unknown = await fetch(`${address.url}/v1/tools/worker/report`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: 'no-such-ticket', report: { state: 'progress', summary: 'x' } }) })
    expect(unknown.status).toBe(400)

    // The Worker's own blocked report: it travels the report channel and never touches these counters.
    const blocked = await fetch(`${address.url}/v1/tools/worker/report`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: ticket.id, assignmentId: assignment.id,
        report: { state: 'blocked', summary: 'needs a person' }, callKey: 'report-1' }) })
    expect(blocked.status).toBe(200)

    await control!.settleDenials()
    expect(counters()).toHaveLength(0)
    expect(reviews()).toHaveLength(0)
  })

  it('counts no refusal of another node, of another turn or of another reason code', async () => {
    const { worker } = await open()
    const turn = node.holdTurn(worker)

    // A fact of another node: the node this control plane talks to is the only one whose refusals are facts here.
    node.simulateGuardDenial(worker, 'write', 'ROLE_TOOL_DENIED', { turnId: String(turn), nodeId: 'another-node' })
    // A fact of another backend.
    node.simulateGuardDenial(worker, 'write', 'ROLE_TOOL_DENIED', { turnId: String(turn), backend: 'another-backend' })
    // A fact about a turn that is over.
    node.simulateGuardDenial(worker, 'write', 'ROLE_TOOL_DENIED', { turnId: String(turn + 99) })
    // A fact that names a reason code this model does not know: it is not a permission denial.
    node.simulateGuardDenial(worker, 'write', 'INVALID_TOOL_ARGS', { turnId: String(turn) })
    // A fact with no tool at all.
    node.simulateGuardDenial(worker, '', 'ROLE_TOOL_DENIED', { turnId: String(turn) })

    await control!.settleDenials()
    expect(counters()).toHaveLength(0)
    expect(calls()).toHaveLength(0)
    expect(reviews()).toHaveLength(0)
  })

  it('counts no refusal of another Assignment or of a turn that does not run', async () => {
    const { worker } = await open()
    const turn = node.holdTurn(worker)

    // A fact about another Assignment: the Session does not run it, so the fact is not this Session's work.
    node.simulateGuardDenial(worker, 'write', 'ROLE_TOOL_DENIED', { turnId: String(turn),
      assignmentId: 'another-assignment' })
    // A fact about no turn at all: it cannot be attributed to the work that runs now.
    node.simulateGuardDenial(worker, 'write', 'ROLE_TOOL_DENIED', { turnId: '' })

    await control!.settleDenials()
    expect(counters()).toHaveLength(0)
    expect(calls()).toHaveLength(0)
    expect(reviews()).toHaveLength(0)
  })

  it('counts a refusal of the node\'s own guard', async () => {
    const { worker } = await open()
    const turn = node.holdTurn(worker)

    node.simulateGuardDenial(worker, 'write', 'WORKSPACE_OUT_OF_BOUNDS', { turnId: String(turn) })
    await control!.settleDenials()

    expect(calls()).toHaveLength(1)
    expect(calls()[0]).toMatchObject({ tool_name: 'write', reason_code: 'WORKSPACE_OUT_OF_BOUNDS',
      turn_id: String(turn) })
    expect(counters()[0]).toMatchObject({ controlSessionId: worker, windowCount: 1 })
  })

  it('counts a replayed refusal of the node\'s own guard once', async () => {
    const { worker } = await open()
    const turn = node.holdTurn(worker)

    // The very same refusal again, with the very same identity of the call: the control plane gives every event its own
    // sequence, so the sequence is not what tells two calls apart — the identity of the call is.
    node.simulateGuardDenial(worker, 'write', 'WORKSPACE_OUT_OF_BOUNDS', { turnId: String(turn), callId: 'call-1' })
    await control!.settleDenials()
    node.simulateGuardDenial(worker, 'write', 'WORKSPACE_OUT_OF_BOUNDS', { turnId: String(turn), callId: 'call-1' })
    await control!.settleDenials()

    expect(calls()).toHaveLength(1)
    expect(counters()[0]).toMatchObject({ controlSessionId: worker, windowCount: 1 })
    expect(reviews()).toHaveLength(0)
  })

  it('counts the refusals of two Sessions that use the same identity apart', async () => {
    const { address } = await open()
    const { worker } = await standalone()

    // Two Sessions that send the same identity are two calls: neither of them may suppress the other's fact.
    await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', 'same-call')
    await control!.settleDenials()
    await refuse(address, tokenOf('router'), '/v1/tools/worker/report', 'same-call')
    await control!.settleDenials()

    expect(calls()).toHaveLength(2)
  })
})

describe('the durability of the denials', () => {
  it('keeps the counters and the reviews across a restart and wakes nobody twice', async () => {
    const { pm, worker, address } = await open()

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }
    await until(() => reviews().length > 0, 'no review was made')
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)

    // The control plane comes back on the same file.
    await server!.close()
    server = undefined
    await control!.close()
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
      workspaceRoot: join(directory, 'workspaces'), now: () => clock, confirmationTimeoutMs: 50 })
    await control.registerNode()
    await control.settleDenials()
    server = new ControlPlaneServer(control, { token: API_TOKEN })

    // The record is still there, and the review that already arrived is not carried out again.
    expect(reviews()).toHaveLength(1)
    expect(reviews()[0]).toMatchObject({ status: 'notified' })
    expect(counters()[0]).toMatchObject({ windowCount: 3 })
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
  })

  it('carries a pending review out again once the superior is reachable', async () => {
    const { pm, worker, address } = await open()
    await control!.stopSessionByOperator(pm.sessionId, '停')

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }
    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()[0]).toMatchObject({ status: 'pending_manager_online' })

    // A person resumes the PM, and the control plane comes back.
    await control!.resumeSessionByOperator(pm.sessionId)
    await server!.close()
    server = undefined
    await control!.close()
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
      workspaceRoot: join(directory, 'workspaces'), now: () => clock, confirmationTimeoutMs: 50 })
    await control.registerNode()
    await control.settleDenials()
    server = new ControlPlaneServer(control, { token: API_TOKEN })

    expect(reviews()[0]).toMatchObject({ status: 'notified' })
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
  })

  it('carries a waiting review out as soon as the manager is resumed', async () => {
    const { pm, worker, address } = await open()
    await control!.stopSessionByOperator(pm.sessionId, '停')

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }
    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()[0]).toMatchObject({ status: 'pending_manager_online' })

    // A person resumes the manager: the review waits for exactly that, and it goes out now — without a restart.
    await control!.resumeSessionByOperator(pm.sessionId)
    await control!.settleDenials()

    expect(reviews()[0]).toMatchObject({ status: 'notified' })
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
  })

  it('never sends a review again whose outcome is unknown', async () => {
    const { pm, worker, address } = await open()
    await control!.stopSessionByOperator(pm.sessionId, '停')

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }
    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()[0]).toMatchObject({ status: 'pending_manager_online' })

    // The control plane stopped while the review was on its way: the outcome is unknown, so the review is never sent
    // again on a guess — not by the resume of the manager, and not by the recovery of a later run.
    control!.store.db.prepare("UPDATE permission_denial_reviews SET status = 'dispatching' WHERE notice_id = ?")
      .run(reviews()[0]!.noticeId)
    await control!.resumeSessionByOperator(pm.sessionId)
    await control!.settleDenials()
    expect(node.messages.get(pm.sessionId)).toBeUndefined()

    await server!.close()
    server = undefined
    await control!.close()
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
      workspaceRoot: join(directory, 'workspaces'), now: () => clock, confirmationTimeoutMs: 50 })
    await control.registerNode()
    await control.settleDenials()

    expect(reviews()[0]).toMatchObject({ status: 'unconfirmed' })
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
  })

  it('does not wake a superior for a refusal whose Session has moved on', async () => {
    const { pm, worker, address } = await open()
    await control!.stopSessionByOperator(pm.sessionId, '停')

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }
    await until(() => reviews().length > 0, 'no review was made')
    expect(reviews()[0]).toMatchObject({ status: 'pending_manager_online' })

    // The Session that was refused is stopped by a person: its denial is no longer a fact about the work that runs.
    await control!.stopSessionByOperator(worker, '停')
    await control!.resumeSessionByOperator(pm.sessionId)
    await control!.settleDenials()

    expect(reviews()[0]).toMatchObject({ status: 'pending_manager_online' })
    expect(node.messages.get(pm.sessionId)).toBeUndefined()
  })
})

describe('the task context a review carries', () => {
  it('shows the phase of its own work and none of the words of the task', async () => {
    const { pm, worker, address } = await open()

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }
    await until(() => reviews().length > 0, 'no review was made')

    const message = denialReviewMessage(pm.sessionId)
    // The projection says which phase the governed work is in, in the control plane's own controlled fields.
    expect(message).toContain('Task context (this scope\'s own work only):')
    expect(message).toContain('Ticket phase open')
    expect(message).toContain('Assignment phase running')
    expect(message).toContain('latest own report none')
    expect(message).toContain('review state none')
    expect(message).toContain('Project phase active')
    // The goal of the Ticket is the word of a person and a model: it never reaches the review.
    expect(message).not.toContain('Do it')
    // A path is a location, not a fact about the work: it never reaches the review either.
    expect(message).not.toContain(directory)
  })

  it('shows the latest report of its own scope and none of its words', async () => {
    const { pm, worker, ticket, address } = await open()

    const report = await fetch(`${address.url}/v1/tools/worker/report`, { method: 'POST',
      headers: { authorization: `Bearer ${tokenOf(worker)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: ticket.id, report: { state: 'progress', summary: 'working on it' } }) })
    expect(report.status).toBe(200)

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }
    await until(() => reviews().length > 0, 'no review was made')

    // The PM's inbox holds the Worker's own report as well; the review is the message that names the refusal.
    const message = denialReviewMessage(pm.sessionId)
    expect(message).toContain('latest own report progress')
    // The summary is the Worker's own word: it never reaches the review.
    expect(message).not.toContain('working on it')
  })

  it('shows the same projection in the console', async () => {
    const { address } = await reviewed()

    const view = reviews()[0]!
    expect(view.taskContext).toContain('Ticket phase open')
    expect(view.taskContext).toContain('Project phase active')
    // The console's own panel carries the very same projection.
    const shown = await panel(address)
    expect(shown.reviews[0]!.taskContext).toContain('Ticket phase open')
  })
})

describe('the review id the superior is told', () => {
  it('names the review in the message the PM received', async () => {
    const { pm, reviewId } = await reviewed()
    await until(() => reviews()[0]?.status === 'notified', 'the PM was not told')

    // The message names the review itself: the transport's idempotency key is a field of the wire and never reaches the
    // model, so a message that only said "this review's id" would have named nothing to apply for.
    const message = denialReviewMessage(pm.sessionId)
    expect(message).toContain(`Review id: ${reviewId}.`)
    expect(message).toContain('control_request_authorization')
    // The id in the message is the very id the control plane persisted.
    expect(reviews()[0]!.noticeId).toBe(reviewId)
  })

  it('names the review in the message the Router received', async () => {
    const { address } = await open()
    const { worker } = await standalone()

    for (let index = 0; index < 3; index += 1) {
      node.holdTurn(worker)
      await refuse(address, tokenOf(worker), '/v1/tools/pm/tickets', `call-${index}`)
      await control!.settleDenials()
    }
    await until(() => reviews().length > 0, 'no review was made')
    await until(() => reviews()[0]?.status === 'notified', 'the Router was not told')

    // The Router is the superior of a standalone Worker's denials, and it is told the very same id.
    const message = denialReviewMessage('router')
    expect(message).toContain(`Review id: ${reviews()[0]!.noticeId}.`)
  })
})

describe('the human authorization application', () => {
  it('lets the manager of the review raise one and shows it in the console', async () => {
    const { pm, worker, address, reviewId } = await reviewed()

    const answer = await applyFor(address, tokenOf(pm.sessionId), reviewId, 'auth-1')
    expect(answer.status).toBe(200)
    const application = (await answer.json() as { application: { applicationId: string; status: string;
      applicantSessionId: string; applicantRole: string; controlSessionId: string; reasonCode: string;
      toolName: string; denialCount: number } }).application
    expect(application).toMatchObject({ status: 'pending', applicantSessionId: pm.sessionId, applicantRole: 'pm',
      controlSessionId: worker, reasonCode: 'ROLE_TOOL_DENIED', toolName: 'control_create_tickets', denialCount: 3 })
    expect(applications()).toHaveLength(1)
    // The console's own panel shows the application.
    expect((await panel(address)).applications).toHaveLength(1)
  })

  it('keeps one application per review and a retry is clean', async () => {
    const { pm, address, reviewId } = await reviewed()

    const first = await applyFor(address, tokenOf(pm.sessionId), reviewId, 'auth-1')
    const second = await applyFor(address, tokenOf(pm.sessionId), reviewId, 'auth-2')
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const one = (await first.json() as { application: { applicationId: string } }).application
    const two = (await second.json() as { application: { applicationId: string } }).application
    expect(two.applicationId).toBe(one.applicationId)
    expect(applications()).toHaveLength(1)
  })

  it('refuses a Worker, another PM and a review id that names nothing', async () => {
    const { pm, worker, address, reviewId } = await reviewed()

    // A Worker is never the manager of a review.
    expect((await applyFor(address, tokenOf(worker), reviewId)).status).toBe(403)
    // Another PM manages another Project: this review is not its own.
    control!.store.triggers.save(trigger('trigger-other'))
    const other = control!.createProject('trigger-other', 'Other', 'Other goal')
    const otherPm = await control!.openProject(other.id)
    expect((await applyFor(address, tokenOf(otherPm.sessionId), reviewId)).status).toBe(403)
    // A review id that names no review at all.
    expect((await applyFor(address, tokenOf(pm.sessionId), 'denial-review-nothing')).status).toBe(403)

    expect(applications()).toHaveLength(0)
  })

  it('refuses a manager that was stopped by an operator', async () => {
    const { pm, address, reviewId } = await reviewed()
    await control!.stopSessionByOperator(pm.sessionId, '停')

    expect((await applyFor(address, tokenOf(pm.sessionId), reviewId)).status).toBe(403)
    expect(applications()).toHaveLength(0)
  })

  it('records the operator decision and grants nothing at all', async () => {
    const { pm, worker, ticket, address, reviewId } = await reviewed()
    const raised = await applyFor(address, tokenOf(pm.sessionId), reviewId, 'auth-1')
    const application = (await raised.json() as { application: { applicationId: string } }).application

    // The authority the work holds before the decision.
    const pmTools = [...PM_PROFILE.tools]
    const workerTools = [...WORKER_PROFILE.tools]
    const mandate = control!.store.tickets.get(ticket.id)?.mandate.allowTools
    const callsBefore = calls().length

    const answer = await decide(address, application.applicationId, 'acknowledged')
    expect(answer.status).toBe(200)
    expect(applications()[0]).toMatchObject({ status: 'acknowledged', decision: 'acknowledged' })

    // Nothing was granted: the roles, the Mandate and the refusals are exactly as they were.
    expect([...PM_PROFILE.tools]).toEqual(pmTools)
    expect([...WORKER_PROFILE.tools]).toEqual(workerTools)
    expect(control!.session(worker)?.toolProfile).toBe(WORKER_PROFILE.name)
    expect(control!.store.tickets.get(ticket.id)?.mandate.allowTools).toEqual(mandate)
    expect(calls()).toHaveLength(callsBefore)
    // The refused call was not replayed: the superior heard about it once and once only.
    expect(node.messages.get(pm.sessionId)).toHaveLength(1)
  })

  it('refuses a decision on an application that does not exist', async () => {
    const { address } = await reviewed()

    const answer = await decide(address, 'no-such-application', 'acknowledged')
    expect(answer.status).toBe(400)
  })

  it('keeps one decision for the same request and audits it once', async () => {
    const { pm, address, reviewId } = await reviewed()
    const raised = await applyFor(address, tokenOf(pm.sessionId), reviewId, 'auth-1')
    const application = (await raised.json() as { application: { applicationId: string } }).application

    const first = await decide(address, application.applicationId, 'acknowledged')
    expect(first.status).toBe(200)
    const decidedAt = applications()[0]!.decidedAt
    expect(applications()[0]).toMatchObject({ status: 'acknowledged', decision: 'acknowledged' })

    // The same decision again is the same decision: the record stands as it is, and the trail holds one line for it.
    const second = await decide(address, application.applicationId, 'acknowledged')
    expect(second.status).toBe(200)
    expect(applications()[0]).toMatchObject({ status: 'acknowledged', decision: 'acknowledged', decidedAt })
    const decisions = control!.auditEntries({ kind: 'denial' })
      .filter(entry => entry.action === 'authorization-decided')
    expect(decisions).toHaveLength(1)
  })
})

describe('the Mandate that was exceeded', () => {
  /** Narrow the PM Mandate of one Project to the read tools. */
  function narrowMandate(projectId: string): void {
    const stored = control!.store.projects.get(projectId)!
    control!.store.projects.save({ ...stored, mandate: { ...stored.mandate, allowTools: ['read', 'grep'] } })
  }

  /** The PM's own call that creates Tickets. */
  function createTickets(address: { url: string }, token: string, tasks: unknown, callId?: string): Promise<Response> {
    return fetch(`${address.url}/v1/tools/pm/tickets`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        ...(callId === undefined ? {} : { 'x-superagent-call-id': callId }) },
      body: JSON.stringify({ tasks }) })
  }

  it('records a task that asks for more tools than the PM Mandate holds', async () => {
    const { project, pm, address } = await open()
    narrowMandate(project.id)

    const answer = await createTickets(address, tokenOf(pm.sessionId),
      [{ title: 'Wider', goal: 'Do it', allow_tools: ['read', 'bash'] }], 'mandate-1')

    // The caller sees the ordinary answer: an invalid task, with the same status and the same body as before.
    expect(answer.status).toBe(400)
    expect(await answer.json()).toEqual({
      error: 'Invalid Project ticket task: allow_tools cannot widen the PM Mandate: bash',
    })

    // The control plane knows what happened, and counts it as what it is.
    await control!.settleDenials()
    expect(calls()).toHaveLength(1)
    expect(calls()[0]).toMatchObject({ reason_code: 'MANDATE_EXCEEDED', tool_name: 'control_create_tickets',
      control_session_id: pm.sessionId })
  })

  it('counts no malformed tool list', async () => {
    const { project, pm, address } = await open()
    narrowMandate(project.id)

    // A tool that does not exist.
    const unknown = await createTickets(address, tokenOf(pm.sessionId),
      [{ title: 'Unknown', goal: 'Do it', allow_tools: ['read', 'no_such_tool'] }], 'malformed-1')
    expect(unknown.status).toBe(400)
    // The same tool twice.
    const duplicate = await createTickets(address, tokenOf(pm.sessionId),
      [{ title: 'Duplicate', goal: 'Do it', allow_tools: ['read', 'read'] }], 'malformed-2')
    expect(duplicate.status).toBe(400)

    await control!.settleDenials()
    // A malformed list is a fact about the argument, not about the delegation: it is not counted.
    expect(calls()).toHaveLength(0)
    expect(counters()).toHaveLength(0)
    expect(reviews()).toHaveLength(0)
  })

  it('counts a replayed call once', async () => {
    const { project, pm, address } = await open()
    narrowMandate(project.id)
    const tasks = [{ title: 'Wider', goal: 'Do it', allow_tools: ['read', 'bash'] }]

    await createTickets(address, tokenOf(pm.sessionId), tasks, 'mandate-1')
    await control!.settleDenials()
    await createTickets(address, tokenOf(pm.sessionId), tasks, 'mandate-1')
    await control!.settleDenials()

    expect(calls()).toHaveLength(1)
  })

  it('carries the narrowed Mandate to the Worker Session', async () => {
    const { project, pm, address } = await open()
    narrowMandate(project.id)

    const answer = await createTickets(address, tokenOf(pm.sessionId),
      [{ title: 'Narrow', goal: 'Do it', allow_tools: ['read'] }], 'narrow-1')
    expect(answer.status).toBe(200)

    // The Worker of the new Ticket runs under the narrowed Mandate.
    await until(() => node.commands.filter(command => command.type === 'worker.create').length >= 2,
      'the Worker of the narrowed Ticket did not start')
    const created = node.commands.filter(command => command.type === 'worker.create').at(-1)!
    expect(created.profile.mandateTools).toBeDefined()
    expect(created.profile.mandateTools).toContain('read')
    expect(created.profile.mandateTools).not.toContain('bash')
    // The Session's own report tool is not governed by the Mandate.
    expect(created.profile.mandateTools).toContain('control_report')
  })

  it('keeps the whole tool set of a Ticket whose Mandate names no list', async () => {
    const { pm, address } = await open()

    const answer = await createTickets(address, tokenOf(pm.sessionId),
      [{ title: 'Plain', goal: 'Do it' }], 'plain-1')
    expect(answer.status).toBe(200)

    await until(() => node.commands.filter(command => command.type === 'worker.create').length >= 2,
      'the Worker of the second Ticket did not start')
    const created = node.commands.filter(command => command.type === 'worker.create').at(-1)!
    expect(created.profile.mandateTools).toBeUndefined()
  })
})
