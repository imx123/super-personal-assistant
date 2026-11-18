/**
 * The live state of the control plane: what it shows, to whom, and what it refuses to show.
 *
 * The routes are read over the real HTTP API against a real `FakeNode`, so the answer is the control plane's own: the
 * node's liveness is the resolver's word, the work is the domain's, and the credentials are the ones a Session really
 * holds. The pure service is exercised on its own as well, for the rules that are easier to state as records than as a
 * running control plane: a list that was cut, and a Worker whose Assignment was replaced.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket, Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { LiveStateService, type LiveStateHost } from '../src/memory/live-state.ts'
import { PM_PROFILE, ROUTER_PROFILE, WORKER_PROFILE } from '../src/control/roles.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { createDshPortHost, type DshPortFetch } from '../src/node/dsh-port-host.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { issueSessionToken } from '../src/shared/session-token.ts'
import type { SessionRecord } from '../src/shared/protocol.ts'

const SECRET = 'live-state-secret'
const API_TOKEN = 'live-state-api-token'
const VIEWER_TOKEN = 'live-state-viewer-token'
const START = '2026-11-19T08:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode | undefined
let clock = START

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

interface Opened {
  project: ProjectProfile
  pm: SessionRecord
  ticket: Ticket
  assignment: Assignment
  worker: string
  address: { url: string }
}

/**
 * A control plane with a Router, a Project, its PM, one Ticket and its Worker, listening with an operator and a viewer
 * token.
 */
async function open(): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-live-state-'))
  clock = START
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: NODE_ID, root, now: () => clock })
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
  server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
  const address = await server.listen(0)
  return { project, pm, ticket: control.store.tickets.get(created!.id)!, assignment,
    worker: `worker-${assignment.id}`, address }
}

/** A second Project of its own, with a PM and a Worker that belong to it. */
async function otherProject(): Promise<{ project: ProjectProfile; pm: SessionRecord; ticket: Ticket; worker: string }> {
  control!.store.triggers.save(trigger('trigger-other'))
  const project = control!.createProject('trigger-other', 'Other', 'Other goal')
  const pm = await control!.openProject(project.id)
  const [created] = control!.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Theirs', goal: 'Theirs' }])
  await until(() => control!.store.tickets.get(created!.id)?.assignments.at(-1)?.state === 'running',
    'the Assignment of the other Project did not start')
  return { project, pm, ticket: control!.store.tickets.get(created!.id)!, worker: `worker-${created!.assignments[0]!.id}` }
}

function tokenOf(sessionId: string): string {
  const token = node?.tokens.get(sessionId)
  if (!token) throw new Error(`The FakeNode has no token for ${sessionId}`)
  return token
}

function get(address: { url: string }, path: string, token: string): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

function post(address: { url: string }, path: string, token: string): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
}

/** The live state as the control plane answered it. */
interface Answer {
  at: string
  audience: string
  nodes: { rows: { nodeId: string; connection: string; backends: { availability: string }[] }[]; total: number; omitted: number }
  projects: { rows: { projectId: string; title: string }[]; total: number; omitted: number }
  tickets: { rows: { ticketId: string; title: string }[]; total: number; omitted: number }
  assignments: { rows: { assignmentId: string; ticketId: string; epoch: number }[]; total: number; omitted: number }
  sessions: { rows: { sessionId: string; role: string }[]; total: number; omitted: number }
  schedules: { rows: { planId: string; name: string }[]; total: number; omitted: number }
}

async function readLiveState(address: { url: string }, token: string): Promise<Answer> {
  const response = await get(address, '/v1/console/memory/live-state', token)
  expect(response.status).toBe(200)
  return await response.json() as Answer
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  node = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the live state of the control plane', () => {
  it('answers the console read to the operator and to the read-only viewer', async () => {
    const { address, project } = await open()

    const operator = await readLiveState(address, API_TOKEN)
    expect(operator.audience).toBe('operator')
    expect(operator.at).toBe(START)
    expect(operator.projects.rows.map(entry => entry.projectId)).toContain(project.id)
    expect(operator.tickets.total).toBe(1)

    // The viewer may read it: it is a `GET`, and the viewer is the read half of the operator's own key.
    const viewer = await readLiveState(address, VIEWER_TOKEN)
    expect(viewer.audience).toBe('operator')

    // No credential at all is refused before the route is reached.
    const anonymous = await fetch(`${address.url}/v1/console/memory/live-state`)
    expect(anonymous.status).toBe(401)
  })

  it('is a read: it answers a GET and refuses a write', async () => {
    const { address } = await open()

    expect((await post(address, '/v1/console/memory/live-state', API_TOKEN)).status).toBe(404)
    // A tool route authenticates the acting Session, so the operator's own key never reaches it at all.
    expect((await post(address, '/v1/tools/memory/live-state', API_TOKEN)).status).toBe(401)
    expect((await post(address, '/v1/tools/memory/live-state', tokenOf('router'))).status).toBe(404)
  })

  it('writes nothing and sends no command to the node', async () => {
    const { address } = await open()
    const commands = node!.commands.length
    const events = control!.consoleStore.eventCount()
    const tickets = JSON.stringify(control!.store.tickets.list())
    const projects = JSON.stringify(control!.store.projects.list())

    await readLiveState(address, API_TOKEN)
    await get(address, '/v1/tools/memory/live-state', tokenOf('router'))

    expect(node!.commands.length).toBe(commands)
    expect(control!.consoleStore.eventCount()).toBe(events)
    expect(JSON.stringify(control!.store.tickets.list())).toBe(tickets)
    expect(JSON.stringify(control!.store.projects.list())).toBe(projects)
  })

  it('shows the Router the pool it manages and the PM only its own Project', async () => {
    const { address, project, pm, ticket, worker } = await open()
    const other = await otherProject()

    const router = await (await get(address, '/v1/tools/memory/live-state', tokenOf('router'))).json() as Answer
    expect(router.audience).toBe('router')
    expect(router.projects.rows.map(entry => entry.projectId)).toContain(project.id)
    expect(router.projects.rows.map(entry => entry.projectId)).toContain(other.project.id)
    expect(router.tickets.rows.map(entry => entry.ticketId)).toContain(ticket.id)
    expect(router.tickets.rows.map(entry => entry.ticketId)).toContain(other.ticket.id)
    // The Router knows its own state; the pool around it is the work.
    expect(router.sessions.rows.map(entry => entry.sessionId)).not.toContain('router')

    const manager = await (await get(address, '/v1/tools/memory/live-state', tokenOf(pm.sessionId))).json() as Answer
    expect(manager.audience).toBe('pm')
    expect(manager.projects.rows.map(entry => entry.projectId)).toEqual([project.id])
    expect(manager.tickets.rows.map(entry => entry.ticketId)).toEqual([ticket.id])
    expect(manager.sessions.rows.map(entry => entry.sessionId)).toContain(worker)
    // Another Project is not in the answer at all: not its Ticket, not its Worker, not its Project.
    const text = JSON.stringify(manager)
    expect(text).not.toContain(other.project.id)
    expect(text).not.toContain(other.ticket.id)
  })

  it('shows a Worker only its own Assignment, its Ticket and the Project of that Ticket', async () => {
    const { address, project, ticket, assignment, worker } = await open()
    const other = await otherProject()

    const answer = await (await get(address, '/v1/tools/memory/live-state', tokenOf(worker))).json() as Answer
    expect(answer.audience).toBe('worker')
    expect(answer.tickets.rows.map(entry => entry.ticketId)).toEqual([ticket.id])
    expect(answer.assignments.rows.map(entry => entry.assignmentId)).toEqual([assignment.id])
    expect(answer.sessions.rows.map(entry => entry.sessionId)).toEqual([worker])
    expect(answer.projects.rows.map(entry => entry.projectId)).toEqual([project.id])
    // The Worker sees its own node and nothing else.
    expect(answer.nodes.rows.map(entry => entry.nodeId)).toEqual([NODE_ID])
    const text = JSON.stringify(answer)
    expect(text).not.toContain(other.project.id)
    expect(text).not.toContain(other.ticket.id)
  })

  it('refuses a token that is invalid, stale or revoked', async () => {
    const { address, pm } = await open()

    // A token that names no Session.
    const unknown = await get(address, '/v1/tools/memory/live-state', 'not-a-token')
    expect(unknown.status).toBe(401)

    // The operator's own key opens no tool route: a Session token is the only authority there.
    expect((await get(address, '/v1/tools/memory/live-state', API_TOKEN)).status).toBe(401)

    // The credential one generation behind: the refresh retired it.
    const stale = tokenOf(pm.sessionId)
    const fresh = control!.refreshToolToken(pm.sessionId)
    expect((await get(address, '/v1/tools/memory/live-state', stale)).status).toBe(401)
    expect((await get(address, '/v1/tools/memory/live-state', fresh)).status).toBe(200)

    // A revoked Session opens nothing, whatever its token says.
    await control!.revokeSession(pm.sessionId, 'the operator withdrew it')
    expect((await get(address, '/v1/tools/memory/live-state', fresh)).status).toBe(401)
  })

  it('refuses a Worker whose Ticket a person stopped', async () => {
    const { address, ticket, worker } = await open()

    const ticketRecord = control!.store.tickets.get(ticket.id)!
    ticketRecord.manualStop = { at: clock, scope: 'worker', by: 'user' }
    control!.store.tickets.save(ticketRecord)

    const response = await get(address, '/v1/tools/memory/live-state', tokenOf(worker))
    expect(response.status).toBe(403)
  })

  it('refuses a Session that only claims the Assignment of the real Worker', async () => {
    const { address, project, assignment, worker } = await open()

    // Another Session record claims the same Assignment. It is a record, not the Worker the Assignment belongs to: the
    // Assignment is the authoritative `worker-<assignmentId>` Session's work, and this one may not read it.
    const impostor: SessionRecord = {
      sessionId: 'worker-impostor', projectId: project.id, assignmentId: assignment.id, role: 'worker',
      nodeId: NODE_ID, workspace: join(directory, 'workspaces', 'impostor'), status: 'running',
      toolProfile: WORKER_PROFILE.name, createdAt: clock, updatedAt: clock,
    }
    control!.sessions.set(impostor.sessionId, impostor)
    const token = issueSessionToken({ sid: impostor.sessionId, pid: impostor.projectId, aid: impostor.assignmentId,
      role: 'worker', backend: 'dsh', nodeId: NODE_ID }, SECRET, 3600)

    const refused = await get(address, '/v1/tools/memory/live-state', token)
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain('is not the Worker of the Assignment')

    // The Worker that really runs the Assignment still reads its own state.
    const answer = await (await get(address, '/v1/tools/memory/live-state', tokenOf(worker))).json() as Answer
    expect(answer.audience).toBe('worker')
    expect(answer.assignments.rows.map(entry => entry.assignmentId)).toEqual([assignment.id])
  })

  it('refuses a PM Session that belongs to another node', async () => {
    const { address } = await open()

    // A Project of its own, with the PM Session id the delegation gives it.
    control!.store.triggers.save(trigger('trigger-third'))
    const third = control!.createProject('trigger-third', 'Third', 'Third goal')

    // The delegation is right, but the record belongs to another machine: a record of another node is not this control
    // plane's Session, and the work it would read is that machine's.
    const foreign: SessionRecord = {
      sessionId: third.pmSessionId, projectId: third.id, role: 'pm', nodeId: 'another-node',
      workspace: join(directory, 'workspaces', 'third'), status: 'running', toolProfile: PM_PROFILE.name,
      createdAt: clock, updatedAt: clock,
    }
    control!.sessions.set(foreign.sessionId, foreign)
    const token = issueSessionToken({ sid: foreign.sessionId, pid: foreign.projectId, role: 'pm', backend: 'dsh',
      nodeId: foreign.nodeId }, SECRET, 3600)

    const refused = await get(address, '/v1/tools/memory/live-state', token)
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain('belongs to the node another-node')
  })

  it('refuses a PM Session whose record names another Project', async () => {
    const { address, project } = await open()

    // A Project of its own, with the PM Session id the delegation gives it.
    control!.store.triggers.save(trigger('trigger-third'))
    const third = control!.createProject('trigger-third', 'Third', 'Third goal')

    // The record of that PM names the first Project instead: a Session may not read the state of a Project it does not
    // manage.
    const record: SessionRecord = {
      sessionId: third.pmSessionId, projectId: project.id, role: 'pm', nodeId: NODE_ID,
      workspace: join(directory, 'workspaces', 'third'), status: 'running', toolProfile: PM_PROFILE.name,
      createdAt: clock, updatedAt: clock,
    }
    control!.sessions.set(record.sessionId, record)
    const token = issueSessionToken({ sid: record.sessionId, pid: record.projectId, role: 'pm', backend: 'dsh',
      nodeId: NODE_ID }, SECRET, 3600)

    const refused = await get(address, '/v1/tools/memory/live-state', token)
    expect(refused.status).toBe(403)
    // Nothing of the Project it may not manage crosses the boundary.
    expect(await refused.text()).not.toContain(third.id)

    // A record that names a Project this control plane does not have names the work of another one: it is refused too.
    const foreign: SessionRecord = { ...record, projectId: 'project-elsewhere' }
    control!.sessions.set(foreign.sessionId, foreign)
    const foreignToken = issueSessionToken({ sid: foreign.sessionId, pid: foreign.projectId, role: 'pm', backend: 'dsh',
      nodeId: NODE_ID }, SECRET, 3600)

    const refusedForeign = await get(address, '/v1/tools/memory/live-state', foreignToken)
    expect(refusedForeign.status).toBe(403)
    expect(await refusedForeign.text()).toContain('does not manage the Project')
  })

  it('names only the Assignment that runs now for each Ticket', async () => {
    const { address, ticket, assignment } = await open()

    // A Ticket that was worked on before: the earlier attempt is history, and the history is the event history's own
    // business, not a row of the state.
    const record = control!.store.tickets.get(ticket.id)!
    record.assignments.unshift({ id: 'assignment-old', state: 'ended', createdAt: clock, endedAt: clock,
      sessionId: 'worker-assignment-old' })
    control!.store.tickets.save(record)

    const answer = await readLiveState(address, API_TOKEN)
    expect(answer.assignments.rows.map(entry => entry.assignmentId)).toEqual([assignment.id])
    expect(answer.assignments.total).toBe(1)
    // The epoch still counts the attempts the Ticket had, so a Ticket on its second try says so.
    expect(answer.assignments.rows[0]?.epoch).toBe(2)
  })

  it('says a node it has never heard of is unknown and never available', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-live-state-'))
    const root = join(directory, 'workspaces')
    node = new FakeNode({ nodeId: NODE_ID, root, now: () => clock })
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
      workspaceRoot: root, now: () => clock, confirmationTimeoutMs: 50 })
    // The node never registered: the control plane has never heard of it.
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)

    const answer = await readLiveState(address, API_TOKEN)
    expect(answer.nodes.rows[0]?.connection).toBe('unknown')
    expect(answer.nodes.rows[0]?.backends[0]?.availability).toBe('unknown')
  })

  it('follows the node from online to offline and back, and never reports a stale online', async () => {
    const { address, pm } = await open()

    expect((await readLiveState(address, API_TOKEN)).nodes.rows[0]?.connection).toBe('online')
    expect((await readLiveState(address, API_TOKEN)).nodes.rows[0]?.backends[0]?.availability).toBe('available')

    await control!.heartbeat(false)
    const offline = await readLiveState(address, API_TOKEN)
    expect(offline.nodes.rows[0]?.connection).toBe('offline')
    expect(offline.nodes.rows[0]?.backends[0]?.availability).toBe('unavailable')

    await control!.heartbeat(true)
    const online = await readLiveState(address, API_TOKEN)
    expect(online.nodes.rows[0]?.connection).toBe('online')
    expect(online.nodes.rows[0]?.backends[0]?.availability).toBe('available')

    // A read needs no node: the facts it answers with are the control plane's own.
    await control!.heartbeat(false)
    const response = await get(address, '/v1/tools/memory/live-state', tokenOf(pm.sessionId))
    expect(response.status).toBe(200)
  })

  it('holds no path, no token, no report text and no scheduled note', async () => {
    const { address, project, ticket } = await open()
    control!.scheduler.createPlan({ projectId: project.id, name: 'Nightly', rule: 'daily:02:00',
      message: 'the secret note of the plan' })
    control!.engine.report(ticket.id, { state: 'progress', summary: 'the secret report text' })

    const body = await (await get(address, '/v1/console/memory/live-state', API_TOKEN)).text()
    expect(body).not.toContain(join(directory, 'workspaces'))
    expect(body).not.toContain('the secret note of the plan')
    expect(body).not.toContain('the secret report text')
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain(API_TOKEN)
  })
})

/**
 * The service on its own: the rules that are easier to state as records than as a running control plane.
 */
describe('the live state service', () => {
  /** A host with nothing but what a test writes into it. */
  const host = (over: Partial<LiveStateHost> = {}): LiveStateHost => ({
    now: over.now ?? (() => '2026-11-19T08:00:00.000Z'),
    nodeId: over.nodeId ?? (() => 'local'),
    liveNodeSnapshots: over.liveNodeSnapshots ?? (() => []),
    sessions: over.sessions ?? (() => []),
    tickets: over.tickets ?? (() => []),
    projects: over.projects ?? (() => []),
    plans: over.plans ?? (() => []),
    routerSessionId: over.routerSessionId ?? (() => 'router'),
  })

  /** A Ticket with two Assignments, the second one replacing the first. */
  const replaced = (): Ticket => ({
    id: 't1',
    title: 'Ticket',
    decisionId: 'd1',
    mandate: { actor: { source: 'main-session', id: 'alice' }, basis: { source: 'main-session', id: 'alice', kind: 'explicit' },
      rules: [], strength: 'explicit', allowTools: [], source: 'main-session' },
    channels: [],
    assignments: [
      { id: 'a1', state: 'ended', createdAt: '2026-11-19T07:00:00.000Z' },
      { id: 'a2', state: 'running', createdAt: '2026-11-19T07:30:00.000Z' },
    ],
    inputs: [],
    undelivered: [],
    createdAt: '2026-11-19T07:00:00.000Z',
    updatedAt: '2026-11-19T07:30:00.000Z',
    origin: { triggerId: 'tr1', triggerIds: ['tr1'] },
  } as unknown as Ticket)

  it('cuts a list that is too long and says how many rows it left out', () => {
    const tickets = Array.from({ length: 60 }, (_, index) => ({
      ...replaced(), id: `t${index}`, title: `Ticket ${index}`,
    }))
    const service = new LiveStateService(host({ tickets: () => tickets }))
    const snapshot = service.operator()
    expect(snapshot.tickets.rows).toHaveLength(50)
    expect(snapshot.tickets.total).toBe(60)
    expect(snapshot.tickets.omitted).toBe(10)
  })

  it('refuses a Worker whose Assignment was replaced', () => {
    const ticket = replaced()
    const record: SessionRecord = {
      sessionId: 'worker-a1', projectId: 't1', assignmentId: 'a1', role: 'worker', nodeId: 'local',
      workspace: '/w', status: 'idle', toolProfile: 'worker.v1',
      createdAt: '2026-11-19T07:00:00.000Z', updatedAt: '2026-11-19T07:00:00.000Z',
    }
    const service = new LiveStateService(host({ tickets: () => [ticket], sessions: () => [record] }))
    const result = service.forSession({ audience: 'worker', sessionId: 'worker-a1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_ASSIGNMENT')
  })

  it('refuses a Session whose role is not the one it claims', () => {
    const record: SessionRecord = {
      sessionId: 'pm-1', projectId: 'p1', role: 'pm', nodeId: 'local', workspace: '/w', status: 'idle',
      toolProfile: 'pm.v1', createdAt: '2026-11-19T07:00:00.000Z', updatedAt: '2026-11-19T07:00:00.000Z',
    }
    const service = new LiveStateService(host({ sessions: () => [record] }))
    const result = service.forSession({ audience: 'router', sessionId: 'pm-1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ROLE_MISMATCH')
  })

  it('refuses a Session of another node and keeps a legacy record that names none', () => {
    const ticket = replaced()
    const record: SessionRecord = {
      sessionId: 'worker-a2', projectId: 't1', assignmentId: 'a2', role: 'worker', nodeId: 'another-node',
      workspace: '/w', status: 'idle', toolProfile: 'worker.v1',
      createdAt: '2026-11-19T07:00:00.000Z', updatedAt: '2026-11-19T07:00:00.000Z',
    }
    const foreign = new LiveStateService(host({ tickets: () => [ticket], sessions: () => [record] }))
    const refused = foreign.forSession({ audience: 'worker', sessionId: 'worker-a2' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('NO_SCOPE')

    // A record from before the binding existed names no node at all: it is left alone, and it reads its own work.
    const legacy: SessionRecord = { ...record, nodeId: '' }
    const local = new LiveStateService(host({ tickets: () => [ticket], sessions: () => [legacy] }))
    const result = local.forSession({ audience: 'worker', sessionId: 'worker-a2' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.snapshot.assignments.rows.map(entry => entry.assignmentId)).toEqual(['a2'])
  })

  it('never calls a backend available when the node is unknown', () => {
    const service = new LiveStateService(host({
      liveNodeSnapshots: () => [{ nodeId: 'local', isPrimary: true, connectionStatus: 'reconnecting',
        backends: [{ backendId: 'dsh', kind: 'dsh', available: true,
          capabilities: { turnInterrupt: false, twoStageReceipt: false, sessionResume: true, gitReviewDiff: true } }] }],
    }))
    const snapshot = service.operator()
    expect(snapshot.nodes.rows[0]?.connection).toBe('unknown')
    expect(snapshot.nodes.rows[0]?.backends[0]?.availability).toBe('unknown')
  })
})

/**
 * The tool the node registers for the three roles: the advertisement and the call it really makes.
 */
describe('the control_live_state tool', () => {
  /** A DSH Agent stand-in with exactly the registry surface `createDshPortHost` uses. */
  class FakeAgent {
    readonly tools = new Map<string, { name: string; description: string; parameters: unknown
      execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }>()
    readonly ctx = { tools: { register: (definition: { name: string; description: string; parameters: unknown
      execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }): (() => void) => {
      this.tools.set(definition.name, definition)
      return () => { this.tools.delete(definition.name) }
    } } }
  }

  interface RecordedCall {
    url: string
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
  }

  it('is registered for the Router, the PM and the Worker, and it reads the live state with a GET', async () => {
    const { address, pm, worker } = await open()

    const agents = new Map<string, FakeAgent>()
    const prompts: { sessionId: string; text: string }[] = []
    const calls: RecordedCall[] = []
    const fetchImpl: DshPortFetch = async (url, init) => {
      calls.push({ url, init })
      const response = await fetch(`${address.url}${url.replace(/^https?:\/\/[^/]+/, '')}`,
        { method: init.method, headers: init.headers })
      return { ok: response.ok, status: response.status, text: async () => await response.text() }
    }
    const sessions = {
      async ensure(sessionId: string) {
        const agent = new FakeAgent()
        agents.set(sessionId, agent)
        return agent
      },
      async prompt(sessionId: string, _key: string, text: string) { prompts.push({ sessionId, text }) },
    }
    const root = join(directory, 'node')
    mkdirSync(root, { recursive: true })
    const host = createDshPortHost({ context: { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } },
      nodeRuntime: { sessions }, nodeId: NODE_ID, root, controlUrl: address.url, fetch: fetchImpl })

    for (const [sessionId, role, profile, token] of [
      ['router', 'router', ROUTER_PROFILE, tokenOf('router')],
      ['pm-1', 'pm', PM_PROFILE, tokenOf(pm.sessionId)],
      ['worker-1', 'worker', WORKER_PROFILE, tokenOf(worker)],
    ] as const) {
      await host.ensureSession({ sessionId, workspace: join(root, 'w'), title: 'Session', role,
        profile, prompt: profile.prompt, sessionToken: token })
      expect(agents.get(sessionId)!.tools.has('control_live_state'), sessionId).toBe(true)
      expect(profile.tools, sessionId).toContain('control_live_state')
      // The role prompt is not touched by this round: the tool is exposed, not injected into the bootstrap.
      const delivered = prompts.find(entry => entry.sessionId === sessionId)!.text
      expect(delivered).toContain(profile.prompt)
      expect(delivered).not.toContain('control_live_state')
    }

    const tool = agents.get('router')!.tools.get('control_live_state')!
    const answer = await tool.execute({}, { signal: new AbortController().signal }) as Answer
    expect(answer.audience).toBe('router')
    const call = calls.find(entry => entry.url.endsWith('/v1/tools/memory/live-state'))!
    expect(call).toBeDefined()
    expect(call.init.method).toBe('GET')
    expect(call.init.headers.authorization).toBe(`Bearer ${tokenOf('router')}`)
  })
})
