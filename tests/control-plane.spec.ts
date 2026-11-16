import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { verifySessionToken } from '../src/shared/session-token.ts'

const SECRET = 'control-test-secret'
const API_TOKEN = 'api-test-token'
const VIEWER_TOKEN = 'viewer-test-token'
let directory: string
let control: ControlPlane
let node: FakeNode
let server: ControlPlaneServer | undefined

function setup(): void {
  directory = mkdtempSync(join(tmpdir(), 'superagent-control-'))
  node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces') })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces') })
}

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: '2026-01-01T00:00:00.000Z', text: 'Build it',
    meta: {} }
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  if (directory) rmSync(directory, { recursive: true, force: true })
})

describe('control-plane kernel', () => {
  it('opens a PM Session on the FakeNode and keeps its token out of the Session record', async () => {
    setup()
    await control.registerNode()
    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    const session = await control.openProject(project.id)

    expect(session.sessionId).toBe(project.pmSessionId)
    expect(session.status).toBe('idle')
    expect(session.toolProfile).toBe('pm.v1')
    expect(node.sessions.get(project.pmSessionId)?.status).toBe('idle')
    const token = node.tokens.get(project.pmSessionId)
    expect(token).toBeTruthy()
    expect(verifySessionToken(token!, SECRET)).toMatchObject({ sid: project.pmSessionId, pid: project.id, role: 'pm',
      backend: 'dsh', nodeId: 'local' })
    expect(JSON.stringify(session)).not.toContain(token!)
  })

  it('refuses a project workspace outside the node root', async () => {
    setup()
    await control.registerNode()
    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    await expect(control.openProject(project.id, join(directory, 'outside'))).rejects.toThrow(/inside the control plane workspace root/)
    expect(control.sessions.size).toBe(0)
  })

  it('creates a worker with its assignment claim and drives message, cancel, archive and permission', async () => {
    setup()
    await control.registerNode()
    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    const pm = await control.openProject(project.id)
    const worker = await control.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')

    expect(worker.sessionId).toBe('worker-assignment-1')
    expect(worker.assignmentId).toBe('assignment-1')
    expect(node.tokens.get(worker.sessionId)).toBeTruthy()
    expect(verifySessionToken(node.tokens.get(worker.sessionId)!, SECRET)).toMatchObject({ aid: 'assignment-1', role: 'worker' })

    await control.sendMessage(pm.sessionId, 'hello')
    expect(node.messages.get(pm.sessionId)).toEqual(['hello'])
    expect(node.sessions.get(pm.sessionId)?.status).toBe('idle')

    await control.setPermission(worker.sessionId, 'read-only')
    expect(node.permissions.get(worker.sessionId)).toBe('read-only')

    await control.cancelSession(worker.sessionId, 'test done')
    expect(node.sessions.get(worker.sessionId)?.status).toBe('stopped')

    await control.archiveSession(worker.sessionId)
    expect(node.sessions.get(worker.sessionId)?.status).toBe('archived')
    expect(node.sessions.get(worker.sessionId)?.archivedAt).toBeTruthy()
    await expect(control.sendMessage(worker.sessionId, 'too late')).rejects.toThrow()
  })

  it('serves the minimal authenticated HTTP API', async () => {
    setup()
    await control.registerNode()
    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    const pm = await control.openProject(project.id)
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)
    const auth = { authorization: `Bearer ${API_TOKEN}` }

    expect((await fetch(`${address.url}/health`)).status).toBe(200)
    expect((await fetch(`${address.url}/v1/state`)).status).toBe(401)
    const state = await fetch(`${address.url}/v1/state`, { headers: auth })
    expect(state.status).toBe(200)
    expect(((await state.json()) as { sessions: unknown[] }).sessions).toHaveLength(1)

    const opened = await fetch(`${address.url}/v1/projects/${project.id}/pm`, { method: 'POST', headers: auth })
    expect(opened.status).toBe(200)
    expect(((await opened.json()) as { session: { sessionId: string } }).session.sessionId).toBe(pm.sessionId)

    const sent = await fetch(`${address.url}/v1/sessions/${pm.sessionId}/message`, { method: 'POST', headers: { ...auth,
      'content-type': 'application/json' }, body: JSON.stringify({ text: 'over HTTP' }) })
    expect(sent.status).toBe(200)
    expect(node.messages.get(pm.sessionId)).toContain('over HTTP')

    // The low-level archive of a PM Session keeps the semantics it always had: the Session is archived, whatever its
    // Project is doing. The operator's own archive lives under the console's namespace and has its own rules.
    const archived = await fetch(`${address.url}/v1/sessions/${pm.sessionId}/archive`, { method: 'POST', headers: auth })
    expect(archived.status).toBe(200)
    expect(node.sessions.get(pm.sessionId)?.status).toBe('archived')
  })
})

describe('project creation over HTTP', () => {
  /** The operator headers the API expects, with the JSON content type a create request carries. */
  function operator(): Record<string, string> {
    return { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' }
  }

  /** Serve the control plane over HTTP; the Project list starts empty, so the route is the only way in. */
  async function serve(viewer = false): Promise<string> {
    server = new ControlPlaneServer(control, viewer ? { token: API_TOKEN, viewerToken: VIEWER_TOKEN } : { token: API_TOKEN })
    const address = await server.listen(0)
    return address.url
  }

  it('creates a Project from an empty database and returns it', async () => {
    setup()
    await control.registerNode()
    const url = await serve()

    const response = await fetch(`${url}/v1/console/projects`, { method: 'POST', headers: operator(),
      body: JSON.stringify({ title: 'Ship the thing', goal: 'A working thing' }) })
    expect(response.status).toBe(201)
    const body = await response.json() as { project: { id: string; title: string; goal: string; status: string; pmSessionId: string } }
    expect(body.project).toMatchObject({ title: 'Ship the thing', goal: 'A working thing', status: 'active' })
    expect(body.project.pmSessionId).toBe(`pm-${body.project.id}`)

    // The Project is in the domain store, and the read route lists it.
    expect(control.store.projects.get(body.project.id)).toMatchObject({ title: 'Ship the thing', goal: 'A working thing' })
    const listed = await fetch(`${url}/v1/projects`, { headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(((await listed.json()) as { projects: unknown[] }).projects).toHaveLength(1)

    // The Project came through the domain: its own Thread holds the request's `project` Decision.
    const threads = control.store.threads.list()
    expect(threads).toHaveLength(1)
    expect(threads[0]!.pending).toEqual([])
    expect(threads[0]!.evaluating).toBeUndefined()
    const decisions = control.store.decisions.byThread(threads[0]!.key)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!).toMatchObject({ kind: 'project', projectId: body.project.id })

    // A request is not work: it started no Ticket, no Assignment and no Session.
    expect(control.tickets()).toHaveLength(0)
    expect(control.sessions.size).toBe(0)
    expect(node.sessions.size).toBe(0)
  })

  it('refuses a missing, wrong or read-only token and creates nothing', async () => {
    setup()
    await control.registerNode()
    const url = await serve(true)
    const payload = JSON.stringify({ title: 'Title', goal: 'Goal' })

    expect((await fetch(`${url}/v1/console/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })).status).toBe(401)
    expect((await fetch(`${url}/v1/console/projects`, { method: 'POST', headers: { authorization: 'Bearer not-the-token', 'content-type': 'application/json' }, body: payload })).status).toBe(401)
    const viewer = await fetch(`${url}/v1/console/projects`, { method: 'POST', headers: { authorization: `Bearer ${VIEWER_TOKEN}`, 'content-type': 'application/json' }, body: payload })
    expect(viewer.status).toBe(403)
    expect(await viewer.text()).toMatch(/read-only viewer/)
    expect(control.projects()).toHaveLength(0)
  })

  it('refuses a body without a non-empty title and goal', async () => {
    setup()
    await control.registerNode()
    const url = await serve()
    const send = async (body: unknown): Promise<Response> => fetch(`${url}/v1/console/projects`, { method: 'POST', headers: operator(), body: JSON.stringify(body) })

    expect((await send({})).status).toBe(400)
    expect((await send({ title: 'Title' })).status).toBe(400)
    expect((await send({ goal: 'Goal' })).status).toBe(400)
    expect((await send({ title: '   ', goal: 'Goal' })).status).toBe(400)
    expect((await send({ title: 'Title', goal: '   ' })).status).toBe(400)
    expect((await send({ title: 7, goal: 'Goal' })).status).toBe(400)
    expect((await send({ title: 'Title', goal: ['Goal'] })).status).toBe(400)
    const notAnObject = await fetch(`${url}/v1/console/projects`, { method: 'POST', headers: operator(), body: JSON.stringify([1, 2]) })
    expect(notAnObject.status).toBe(400)
    expect(control.projects()).toHaveLength(0)
  })

  it('keeps the created Project in the database across a restart', async () => {
    setup()
    await control.registerNode()
    const url = await serve()
    const created = await fetch(`${url}/v1/console/projects`, { method: 'POST', headers: operator(),
      body: JSON.stringify({ title: 'Persisted', goal: 'Stay' }) })
    const { project } = await created.json() as { project: { id: string } }

    await server!.close()
    server = undefined
    await control.close()
    // A new kernel on the same database finds the Project: it was written, not held in memory.
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
      workspaceRoot: join(directory, 'workspaces') })
    expect(control.projects().map(item => item.id)).toContain(project.id)
  })

  it('ensures the PM of a new Project only when asked', async () => {
    setup()
    await control.registerNode()
    const url = await serve()
    const created = await fetch(`${url}/v1/console/projects`, { method: 'POST', headers: operator(),
      body: JSON.stringify({ title: 'Managed', goal: 'Work' }) })
    const { project } = await created.json() as { project: { id: string; pmSessionId: string } }

    // Creating the Project started no Session; the PM comes up on its own route.
    expect(control.sessions.size).toBe(0)
    expect(node.sessions.size).toBe(0)

    const opened = await fetch(`${url}/v1/projects/${project.id}/pm`, { method: 'POST', headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(opened.status).toBe(200)
    const { session } = await opened.json() as { session: { sessionId: string; status: string } }
    expect(session.sessionId).toBe(project.pmSessionId)
    expect(session.status).toBe('idle')
    expect(node.sessions.get(project.pmSessionId)?.status).toBe('idle')
  })
})
