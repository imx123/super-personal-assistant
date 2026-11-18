/**
 * P2-C control-plane roles over HTTP: the operator token keeps every read and write, an optional viewer token opens
 * only the reads, and anything else is 401. The viewer role exists so a panel can follow the control plane without
 * holding the secret that can create Sessions and move Tickets.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer, startFetchControlPlane } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const OPERATOR_TOKEN = 'control-operator-token'
const VIEWER_TOKEN = 'control-viewer-token'
const SECRET = 'control-auth-test-secret'
const NOW = '2026-01-01T00:00:00.000Z'
const OPERATOR = { authorization: `Bearer ${OPERATOR_TOKEN}` }
const VIEWER = { authorization: `Bearer ${VIEWER_TOKEN}` }

interface Fixture {
  project: ReturnType<ControlPlane['createProject']>
  pm: Awaited<ReturnType<ControlPlane['openProject']>>
  worker: Awaited<ReturnType<ControlPlane['createWorkerSession']>>
}

/** One write route the API exposes, with the body a real client would send. */
interface Write {
  name: string
  method: 'POST' | 'PUT' | 'DELETE'
  path(fixture: Fixture): string
  body?: Record<string, unknown> | ((fixture: Fixture) => Record<string, unknown>)
  /**
   * The status the operator's call answers with; a create route answers 201, the other writes 200.
   *
   * A route that needs something that does not exist answers 404, and the matrix says so rather than pretending the
   * write happened.
   */
  status?: number
}

/** Every write the control plane can perform; a viewer must be refused all of them. */
const WRITES: Write[] = [
  { name: 'node registration', method: 'POST', path: () => '/v1/nodes/register',
    body: { version: '0.1.0', capabilities: ['dsh'] } },
  { name: 'node heartbeat', method: 'POST', path: () => '/v1/nodes/local/heartbeat', body: { online: true } },
  // The low-level routes: the semantics they always had.
  { name: 'PM creation', method: 'POST', path: fixture => `/v1/projects/${fixture.project.id}/pm` },
  { name: 'Worker creation', method: 'POST', path: fixture => `/v1/projects/${fixture.project.id}/workers`,
    body: { assignmentId: 'assignment-auth', ticketId: 'ticket-auth', prompt: 'Do the work' } },
  { name: 'session message', method: 'POST', path: fixture => `/v1/sessions/${fixture.pm.sessionId}/message`,
    body: { text: 'hello' } },
  { name: 'session permission', method: 'PUT', path: fixture => `/v1/sessions/${fixture.worker.sessionId}/permission`,
    body: { permission: 'read-only' } },
  // The console's own namespace: the human actions on a Project and a Session.
  { name: 'console session message', method: 'POST',
    path: fixture => `/v1/console/sessions/${fixture.pm.sessionId}/message`, body: { text: 'hello' } },
  { name: 'console project creation', method: 'POST', path: () => '/v1/console/projects',
    body: { title: 'A new project', goal: 'Do the work' }, status: 201 },
  { name: 'console project pause', method: 'POST', path: fixture => `/v1/console/projects/${fixture.project.id}/pause`,
    body: { paused: true, mode: 'hard' } },
  { name: 'console project memory', method: 'POST', path: fixture => `/v1/console/projects/${fixture.project.id}/memory`,
    body: { text: 'remember this' }, status: 201 },
  { name: 'console project archive', method: 'POST', path: fixture => `/v1/console/projects/${fixture.project.id}/archive` },
  { name: 'console project unarchive', method: 'POST',
    path: fixture => `/v1/console/projects/${fixture.project.id}/unarchive` },
  { name: 'console project stop', method: 'POST', path: fixture => `/v1/console/projects/${fixture.project.id}/stop`,
    body: { reason: 'done' } },
  { name: 'console session cancel', method: 'POST',
    path: fixture => `/v1/console/sessions/${fixture.worker.sessionId}/cancel`, body: { reason: 'done' } },
  { name: 'console session archive', method: 'POST',
    path: fixture => `/v1/console/sessions/${fixture.worker.sessionId}/archive` },
  { name: 'console session permission', method: 'PUT',
    path: fixture => `/v1/console/sessions/${fixture.worker.sessionId}/permission`, body: { permission: 'read-only' } },
  { name: 'console session revoke', method: 'POST',
    path: fixture => `/v1/console/sessions/${fixture.worker.sessionId}/revoke`, body: { reason: 'done' } },
  { name: 'router message', method: 'POST', path: () => '/v1/console/router/message', body: { text: 'hello' } },
  // The Router's proposal is confirmed by a person, so it is a console write like any other: the proposal below does
  // not exist, and the honest answer to that is 404.
  { name: 'router proposal confirm', method: 'POST',
    path: () => '/v1/console/router/proposal/router-prop-00000000-0000-4000-8000-000000000000/confirm', status: 404 },
  { name: 'router proposal cancel', method: 'POST',
    path: () => '/v1/console/router/proposal/router-prop-00000000-0000-4000-8000-000000000000/cancel', status: 404 },
  { name: 'reconciliation', method: 'POST', path: () => '/v1/console/reconcile/run' },
  // The scheduled plans are console writes like any other. The plan the routes below name does not exist, so the honest
  // answer to them is 404 — a viewer is refused before the route is even reached.
  { name: 'console schedule creation', method: 'POST', path: () => '/v1/console/schedules',
    body: fixture => ({ projectId: fixture.project.id, name: 'A scheduled task', rule: 'every:1h', message: 'look at the backlog' }),
    status: 201 },
  { name: 'console schedule edit', method: 'PUT', path: () => '/v1/console/schedules/sched-missing-task',
    body: { name: 'renamed' }, status: 404 },
  { name: 'console schedule pause', method: 'POST', path: () => '/v1/console/schedules/sched-missing-task/pause',
    status: 404 },
  { name: 'console schedule resume', method: 'POST', path: () => '/v1/console/schedules/sched-missing-task/resume',
    status: 404 },
  { name: 'console schedule run', method: 'POST', path: () => '/v1/console/schedules/sched-missing-task/run', status: 404 },
  { name: 'console schedule delete', method: 'DELETE', path: () => '/v1/console/schedules/sched-missing-task', status: 404 },
  // The low-level stop and archive come last: they end the PM Session the other writes still need.
  { name: 'session cancel', method: 'POST', path: fixture => `/v1/sessions/${fixture.pm.sessionId}/cancel`,
    body: { reason: 'done' } },
  { name: 'session archive', method: 'POST', path: fixture => `/v1/sessions/${fixture.pm.sessionId}/archive` },
]

let directory = ''
let node: FakeNode
let control: ControlPlane
let server: ControlPlaneServer | undefined

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: NOW, text: 'Build it', meta: {} }
}

/** Register the node, seed one Project with a PM and a Worker, and listen with the requested token set. */
async function serve(options: { viewer?: boolean } = {}): Promise<{ url: string; fixture: Fixture }> {
  await control.registerNode()
  control.store.triggers.save(trigger())
  const project = control.createProject('trigger-1', 'Project', 'Goal')
  const pm = await control.openProject(project.id)
  const worker = await control.createWorkerSession(project.id, 'assignment-auth', 'ticket-auth', 'Do the work')
  server = new ControlPlaneServer(control, options.viewer === false
    ? { token: OPERATOR_TOKEN }
    : { token: OPERATOR_TOKEN, viewerToken: VIEWER_TOKEN })
  const address = await server.listen(0)
  return { url: address.url, fixture: { project, pm, worker } }
}

/** Issue one write route with one bearer token, draining the answer so the connection is reusable. */
async function send(url: string, write: Write, fixture: Fixture,
  auth: Record<string, string>): Promise<{ status: number; body: string }> {
  const body = typeof write.body === 'function' ? write.body(fixture) : write.body
  const response = await fetch(`${url}${write.path(fixture)}`, {
    method: write.method,
    headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.text() }
}

async function read(url: string, path: string, auth?: Record<string, string>): Promise<{ status: number; body: string }> {
  const response = await fetch(`${url}${path}`, auth === undefined ? {} : { headers: auth })
  return { status: response.status, body: await response.text() }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-control-auth-'))
  node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces') })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces') })
})

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane read-only viewer', () => {
  it('keeps /health public and lets a viewer read state, projects, tickets, sessions, events and the stream', async () => {
    const { url, fixture } = await serve()
    const reads = ['/v1/state', '/v1/projects', '/v1/tickets', '/v1/sessions', '/v1/events',
      '/v1/console/schedules', `/v1/sessions/${fixture.pm.sessionId}`]

    for (const path of reads) {
      const viewer = await read(url, path, VIEWER)
      expect(viewer.status, `${path} must be readable by a viewer`).toBe(200)
      // Read models never carry a bearer token: the kernel strips Session tokens before storing a record.
      expect(viewer.body).not.toContain(VIEWER_TOKEN)
      expect(viewer.body).not.toContain(OPERATOR_TOKEN)
      const operator = await read(url, path, OPERATOR)
      expect(operator.status, `${path} must stay readable by the operator`).toBe(200)
    }

    // The event stream is one of those reads, and a viewer may follow it.
    const abort = new AbortController()
    const stream = await fetch(`${url}/v1/events/stream?after=0`, { headers: VIEWER, signal: abort.signal })
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    await stream.body?.cancel().catch(() => {})
    abort.abort()

    expect((await fetch(`${url}/health`)).status).toBe(200)
  })

  it('refuses every viewer write with 403 and leaves the kernel untouched, while the operator performs them', async () => {
    const { url, fixture } = await serve()
    const sessions = control.sessions.size
    const events = control.events.length
    const registrations = node.registrations.length

    for (const write of WRITES) {
      const response = await send(url, write, fixture, VIEWER)
      expect(response.status, `${write.name} must be refused for a viewer`).toBe(403)
      expect(response.body).toMatch(/read-only viewer/)
      expect(response.body).not.toContain(VIEWER_TOKEN)
      expect(response.body).not.toContain(OPERATOR_TOKEN)
    }

    // A refused write is not a silent one: no Session, event or node command came out of the eight requests.
    expect(control.sessions.size).toBe(sessions)
    expect(control.events).toHaveLength(events)
    expect(node.registrations).toHaveLength(registrations)
    expect(node.messages.get(fixture.pm.sessionId)).toBeUndefined()
    expect(node.permissions.size).toBe(0)
    expect(control.session(fixture.pm.sessionId)).toMatchObject({ status: 'idle' })

    for (const write of WRITES) {
      const response = await send(url, write, fixture, OPERATOR)
      expect(response.status, `${write.name} must be allowed for the operator`).toBe(write.status ?? 200)
    }
    expect(node.messages.get(fixture.pm.sessionId)).toContain('hello')
    expect(node.permissions.get(fixture.worker.sessionId)).toBe('read-only')
    expect(control.session(fixture.pm.sessionId)).toMatchObject({ status: 'archived' })
  })

  it('answers 401 for a missing, wrong, Session or unconfigured viewer token and keeps the tools routes session-only',
    async () => {
      const { url, fixture } = await serve({ viewer: false })
      const state = '/v1/state'

      expect((await fetch(`${url}${state}`)).status).toBe(401)
      expect((await read(url, state, { authorization: 'Bearer not-the-control-token' })).status).toBe(401)
      expect((await read(url, state, { authorization: 'Bearer ' })).status).toBe(401)
      // No viewer token is configured, so that secret means nothing at all.
      expect((await read(url, state, VIEWER)).status).toBe(401)

      // A Session token is authority for `/v1/tools/*` only.
      const sessionToken = node.tokens.get(fixture.pm.sessionId)!
      expect((await read(url, state, { authorization: `Bearer ${sessionToken}` })).status).toBe(401)
      // Neither control-plane token may open a tool route, and the viewer one is not even a Session token.
      const tools = await read(url, '/v1/tools/pm/context', VIEWER)
      expect(tools.status).toBe(401)
      expect(tools.body).not.toContain(VIEWER_TOKEN)
      expect((await read(url, '/v1/tools/pm/context', OPERATOR)).status).toBe(401)

      expect((await fetch(`${url}/health`)).status).toBe(200)
    })

  it('rejects a viewer token equal to the operator token and leaves no database lock behind', async () => {
    // Policy: one secret cannot mean two roles, so the pair is refused instead of silently treated as the operator.
    expect(() => new ControlPlaneServer(control, { token: OPERATOR_TOKEN, viewerToken: OPERATOR_TOKEN }))
      .toThrow(/must differ from the control-plane API token/)

    const env = {
      SUPERAGENT_CONTROL_TOKEN: OPERATOR_TOKEN,
      SUPERAGENT_CONTROL_VIEWER_TOKEN: OPERATOR_TOKEN,
      SUPERAGENT_CONTROL_DB: join(directory, 'equal', 'control.sqlite'),
      SUPERAGENT_WORKSPACE_ROOT: join(directory, 'equal', 'workspaces'),
      SUPERAGENT_NODE_ID: 'local',
      SUPERAGENT_CONTROL_PORT: '0',
    }
    const startNode = new FakeNode({ nodeId: 'local', root: join(directory, 'equal', 'workspaces') })
    await expect(startFetchControlPlane({ env, node: startNode, heartbeatMs: 0 })).rejects.toThrow(/must differ/)

    // The refused startup closed the kernel it had already opened: the same database starts immediately, with no lock.
    const recovered = await startFetchControlPlane({ env: { ...env, SUPERAGENT_CONTROL_VIEWER_TOKEN: VIEWER_TOKEN },
      node: startNode, heartbeatMs: 0 })
    try {
      expect((await read(recovered.address.url, '/v1/state', VIEWER)).status).toBe(200)
    } finally {
      await recovered.close()
    }
  })

  it('reads SUPERAGENT_CONTROL_VIEWER_TOKEN when startControlPlane builds the server', async () => {
    const env = {
      SUPERAGENT_CONTROL_TOKEN: OPERATOR_TOKEN,
      SUPERAGENT_CONTROL_VIEWER_TOKEN: VIEWER_TOKEN,
      SUPERAGENT_CONTROL_DB: join(directory, 'started', 'control.sqlite'),
      SUPERAGENT_WORKSPACE_ROOT: join(directory, 'started', 'workspaces'),
      SUPERAGENT_NODE_ID: 'local',
      SUPERAGENT_CONTROL_PORT: '0',
    }
    const startNode = new FakeNode({ nodeId: 'local', root: join(directory, 'started', 'workspaces') })
    const running = await startFetchControlPlane({ env, node: startNode, heartbeatMs: 0 })
    try {
      expect((await read(running.address.url, '/v1/state', VIEWER)).status).toBe(200)
      const refused = await fetch(`${running.address.url}/v1/nodes/local/heartbeat`, { method: 'POST', headers: VIEWER })
      expect(refused.status).toBe(403)
      expect(await refused.text()).toMatch(/read-only viewer/)
      const beat = await fetch(`${running.address.url}/v1/nodes/local/heartbeat`, { method: 'POST', headers: OPERATOR })
      expect(beat.status).toBe(200)

      // The standalone entry point creates a Project on its own empty database: no Trigger was seeded into it.
      const created = await fetch(`${running.address.url}/v1/console/projects`, { method: 'POST',
        headers: { ...OPERATOR, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'From the entry point', goal: 'Do the work' }) })
      expect(created.status).toBe(201)
      const { project } = await created.json() as { project: { id: string; title: string } }
      expect(project.title).toBe('From the entry point')
      const projects = await read(running.address.url, '/v1/projects', VIEWER)
      expect(projects.status).toBe(200)
      expect(projects.body).toContain(project.id)
    } finally {
      await running.close()
    }
  })
})
