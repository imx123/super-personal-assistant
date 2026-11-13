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

    const archived = await fetch(`${address.url}/v1/sessions/${pm.sessionId}/archive`, { method: 'POST', headers: auth })
    expect(archived.status).toBe(200)
    expect(node.sessions.get(pm.sessionId)?.status).toBe('archived')
  })
})
