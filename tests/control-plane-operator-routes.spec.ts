/**
 * The operator's own routes: a Project's lifecycle, a Session's actions by its role, and the revocation of a Session.
 *
 * Every action here goes through the domain's own primitives: a pause stops the Project's Workers through the one
 * primitive a person's stop uses, and a Worker is stopped through its Ticket. A PM Session is stopped on its own — the
 * Session is gone, and the Project it manages is left exactly as it was; ending that Project is a separate decision and
 * lives on the Project's own route. A revocation takes the Session's authority away for good: neither the token it holds
 * nor the grace refresh nor a re-ensure may bring it back.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const SECRET = 'operator-secret'
const API_TOKEN = 'operator-api-token'
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

function put(path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'PUT', headers: { authorization: `Bearer ${API_TOKEN}`,
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

/** A control plane with a node, listening on a random port. */
async function open(): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-operator-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: 'local', root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  address = await server.listen(0)
}

/** A Project with its PM and one Ticket whose Worker Session runs. */
async function projectWithWorker(workspace?: string): Promise<
  { projectId: string; pmSessionId: string; ticketId: string; assignmentId: string }> {
  const created = await post('/v1/console/projects', { title: '操作员项目', goal: '把工作做完', workspace })
  const { project } = (await created.json()) as { project: { id: string } }
  const pm = await post(`/v1/console/projects/${project.id}/pm`)
  const { session } = (await pm.json()) as { session: { sessionId: string } }
  const tickets = await fetch(`${address.url}/v1/tools/pm/tickets`, { method: 'POST',
    headers: { authorization: `Bearer ${tokenOf(session.sessionId)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: [{ title: '做一件事', goal: '做完它' }] }) })
  const { tickets: createdTickets } = (await tickets.json()) as { tickets: { id: string }[] }
  const ticketId = createdTickets[0]!.id
  await until(() => control!.store.tickets.get(ticketId)?.assignments.at(-1)?.state === 'running',
    'the Worker Assignment did not start')
  const assignmentId = control!.store.tickets.get(ticketId)!.assignments.at(-1)!.id
  return { projectId: project.id, pmSessionId: session.sessionId, ticketId, assignmentId }
}

/** The Session token the node holds. */
function tokenOf(sessionId: string): string {
  const token = node.tokens.get(sessionId)
  if (!token) throw new Error(`No token for ${sessionId}`)
  return token
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the operator routes', () => {
  it('uses the configured project directory for the PM and its Workers and shows it in the console', async () => {
    await open()
    const root = join(directory, 'workspaces')
    const workspace = join(root, 'existing project')
    mkdirSync(workspace)
    const { projectId, pmSessionId, assignmentId } = await projectWithWorker(workspace)

    expect(node.sessions.get(pmSessionId)?.workspace).toBe(workspace)
    expect(node.sessions.get(`worker-${assignmentId}`)?.workspace).toBe(workspace)
    const listed = await fetch(`${address.url}/v1/console/projects`, { headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(await listed.json()).toMatchObject({ workspaceRoot: root, projects: [{ id: projectId, workspace }] })
    expect((await post(`/v1/console/projects/${projectId}/pm`, { workspace: join(root, 'other') })).status).toBe(409)
  })

  it('rejects invalid workspace paths before creating a project', async () => {
    await open()
    const root = join(directory, 'workspaces')
    const outside = join(directory, 'outside')
    mkdirSync(outside)
    const file = join(root, 'a file')
    writeFileSync(file, 'not a directory')

    for (const workspace of ['relative-path', outside, file]) {
      expect((await post('/v1/console/projects', { title: '操作员项目', goal: '把工作做完', workspace })).status).toBe(400)
    }
    expect(control!.projects()).toHaveLength(0)
    expect(node.sessions.size).toBe(0)
  })

  it('keeps selected directories inside the workspace root even when a directory link is present', async ({ skip }) => {
    await open()
    const outside = join(directory, 'outside')
    mkdirSync(outside)
    const link = join(directory, 'workspaces', 'linked directory')
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        skip(true, 'Windows sandbox does not allow junctions')
        return
      }
      throw error
    }
    expect((await post('/v1/console/projects', { title: '操作员项目', goal: '把工作做完',
      workspace: join(link, 'new project') })).status).toBe(400)
    expect(control!.projects()).toHaveLength(0)
  })

  it('pauses and resumes a Project through the domain', async () => {
    await open()
    const { projectId } = await projectWithWorker()

    const paused = await post(`/v1/console/projects/${projectId}/pause`, { paused: true, mode: 'hard' })
    expect(paused.status).toBe(200)
    const pausedBody = (await paused.json()) as { project: { status: string; pauseMode?: string } }
    expect(pausedBody.project.status).toBe('paused')
    expect(pausedBody.project.pauseMode).toBe('hard')
    expect(control!.store.projects.get(projectId)?.status).toBe('paused')

    const resumed = await post(`/v1/console/projects/${projectId}/pause`, { paused: false })
    expect(resumed.status).toBe(200)
    expect(control!.store.projects.get(projectId)?.status).toBe('active')
  })

  it('ends and archives a Project through the domain', async () => {
    await open()
    const { projectId, assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`

    const archived = await post(`/v1/console/projects/${projectId}/archive`)
    expect(archived.status).toBe(200)
    expect(control!.store.projects.get(projectId)?.status).toBe('archived')
    // The archive ends the Assignment, archives the Ticket and stops the Worker on the node.
    expect(control!.store.tickets.list().find(ticket => ticket.projectId === projectId)?.archived).toBeDefined()
    expect(node.sessions.get(workerSession)?.status).toBe('archived')

    const restored = await post(`/v1/console/projects/${projectId}/unarchive`)
    expect(restored.status).toBe(200)
    expect(control!.store.projects.get(projectId)?.status).toBe('active')
  })

  it('ends a Project and its Tickets when it is stopped', async () => {
    await open()
    const { projectId, assignmentId } = await projectWithWorker()

    const stopped = await post(`/v1/console/projects/${projectId}/stop`, { reason: '做完了' })
    expect(stopped.status).toBe(200)
    expect(control!.store.projects.get(projectId)?.status).toBe('ended')
    expect(control!.store.tickets.list().find(ticket => ticket.projectId === projectId)?.ended).toBeDefined()
    await until(() => node.sessions.get(`worker-${assignmentId}`)?.status === 'stopped',
      'the Worker Session was not stopped')
  })

  it('refuses a pause of an unknown Project and a mode that does not exist', async () => {
    await open()
    expect((await post('/v1/console/projects/nope/pause', { paused: true })).status).toBe(404)
    const created = await post('/v1/console/projects', { title: '模式', goal: '目标' })
    const { project } = (await created.json()) as { project: { id: string } }
    expect((await post(`/v1/console/projects/${project.id}/pause`, { paused: true, mode: 'sideways' })).status).toBe(400)
  })

  it('delivers an operator message to a PM directly and to a Worker through its Ticket', async () => {
    await open()
    const { pmSessionId, ticketId, assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`

    const toPm = await post(`/v1/console/sessions/${pmSessionId}/message`, { text: '进展如何' })
    expect(toPm.status).toBe(200)
    expect(node.messages.get(pmSessionId)).toContain('进展如何')

    const toWorker = await post(`/v1/console/sessions/${workerSession}/message`, { text: '先做第二步' })
    expect(toWorker.status).toBe(200)
    // The message is a Ticket Input, so the domain keeps it and delivers it to the current Assignment.
    const ticket = control!.store.tickets.get(ticketId)!
    expect(ticket.inputs.some(input => input.kind === 'note' && input.text === '先做第二步')).toBe(true)
    await until(() => (node.messages.get(workerSession) ?? []).includes('先做第二步'),
      'the message did not reach the Worker')
  })

  it('stops a Worker through its Ticket and stops a PM Session on its own', async () => {
    await open()
    const { projectId, pmSessionId, ticketId, assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`

    const stopped = await post(`/v1/console/sessions/${workerSession}/cancel`, { reason: '不做了' })
    expect(stopped.status).toBe(200)
    // The Assignment ends in the domain and the node confirms the Worker is gone.
    expect(control!.store.tickets.get(ticketId)?.assignments.at(-1)?.state).toBe('ended')
    expect(node.sessions.get(workerSession)?.status).toBe('stopped')
    // The Ticket stays open: stopping one Worker is not ending its Ticket.
    expect(control!.store.tickets.get(ticketId)?.ended).toBeUndefined()

    // A PM Session is stopped on its own: the Session is gone, and the Project it manages is left exactly as it was.
    const stoppedPm = await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: 'PM 到此为止' })
    expect(stoppedPm.status).toBe(200)
    expect(node.sessions.get(pmSessionId)?.status).toBe('stopped')
    expect(control!.store.projects.get(projectId)?.status).toBe('active')
    expect(control!.store.tickets.get(ticketId)?.ended).toBeUndefined()
  })

  it('keeps the low-level Session routes on their own semantics', async () => {
    await open()
    const { projectId, pmSessionId, assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`

    // The low-level cancel stops the Session on the node and changes nothing else: the Project it manages keeps going.
    const cancelled = await post(`/v1/sessions/${pmSessionId}/cancel`, { reason: '先停一下' })
    expect(cancelled.status).toBe(200)
    expect(control!.store.projects.get(projectId)?.status).toBe('active')
    expect(node.sessions.get(pmSessionId)?.status).toBe('stopped')

    // The low-level archive archives the Session, whatever its Project is doing.
    const archived = await post(`/v1/sessions/${workerSession}/archive`)
    expect(archived.status).toBe(200)
    expect(node.sessions.get(workerSession)?.status).toBe('archived')
  })

  it('refuses to archive a Session that still runs its work', async () => {
    await open()
    const { pmSessionId, assignmentId } = await projectWithWorker()
    const workerSession = `worker-${assignmentId}`

    // The Worker still runs its Assignment: archiving it would leave the domain behind.
    expect((await post(`/v1/console/sessions/${workerSession}/archive`)).status).toBe(409)
    // The PM's Project is still active: archiving it would leave the Project without its PM.
    expect((await post(`/v1/console/sessions/${pmSessionId}/archive`)).status).toBe(409)
  })

  it('sets the permission of a Session on the node', async () => {
    await open()
    const { pmSessionId } = await projectWithWorker()
    const response = await put(`/v1/console/sessions/${pmSessionId}/permission`, { permission: 'read-only' })
    expect(response.status).toBe(200)
    expect(node.permissions.get(pmSessionId)).toBe('read-only')
  })

  it('revokes a Session for good: the token, the grace refresh and every re-ensure stop working', async () => {
    await open()
    const { pmSessionId } = await projectWithWorker()
    const token = tokenOf(pmSessionId)

    const revoked = await post(`/v1/console/sessions/${pmSessionId}/revoke`, { reason: '换人' })
    expect(revoked.status).toBe(200)
    const body = (await revoked.json()) as { revoked: boolean; tokenVersion: number }
    expect(body.revoked).toBe(true)
    expect(body.tokenVersion).toBeGreaterThanOrEqual(2)

    // The token the Session held opens nothing, and the grace refresh does not reach it either.
    const context = await fetch(`${address.url}/v1/tools/pm/context`, { headers: { authorization: `Bearer ${token}` } })
    expect(context.status).toBe(401)
    const refreshed = await fetch(`${address.url}/v1/tools/token/refresh`, { method: 'POST',
      headers: { authorization: `Bearer ${token}` } })
    expect(refreshed.status).toBe(401)

    // A message must not bring the authority back, and no new token is issued.
    const message = await post(`/v1/console/sessions/${pmSessionId}/message`, { text: '还在吗' })
    expect(message.status).toBe(409)
    expect(node.messages.get(pmSessionId)).toBeUndefined()
    expect(control!.session(pmSessionId)?.revokedAt).toBeDefined()

    // The PM of a revoked Project cannot be started again.
    const project = control!.projects().find(item => item.pmSessionId === pmSessionId)!
    expect((await post(`/v1/console/projects/${project.id}/pm`)).status).toBe(409)
  })

  it('keeps a revoked Session revoked across a restart of the control plane', async () => {
    await open()
    const { pmSessionId } = await projectWithWorker()
    const token = tokenOf(pmSessionId)
    expect((await post(`/v1/console/sessions/${pmSessionId}/revoke`, { reason: '换人' })).status).toBe(200)

    await server?.close()
    server = undefined
    await control?.close()
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
      workspaceRoot: join(directory, 'workspaces'), now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    address = await server.listen(0)

    const context = await fetch(`${address.url}/v1/tools/pm/context`, { headers: { authorization: `Bearer ${token}` } })
    expect(context.status).toBe(401)
    expect(control.session(pmSessionId)?.revokedAt).toBeDefined()
  })
})
