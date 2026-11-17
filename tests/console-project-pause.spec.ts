/**
 * A Project's hard pause, and what the console says about it.
 *
 * The pause is written either way — the Project is paused, whatever the node does — but a Worker the node did not confirm
 * as stopped is named, with the reason the control plane has. The console says so instead of showing a pause that reads
 * as a clean stop, and the wording of the Project actions that stop Workers keeps its own success.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { pauseWording, projectWording } from '../src/console/pages.tsx'
import { FakeNode } from '../src/node/fake-node.ts'
import type { NodeCommand } from '../src/shared/protocol.ts'

const SECRET = 'console-pause-secret'
const API_TOKEN = 'console-pause-token'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: ControllableNode
let address = { url: '', port: 0 }

/** A FakeNode whose `session.cancel` a test can refuse. */
class ControllableNode extends FakeNode {
  /** When set, a `session.cancel` to that Session fails with it. */
  readonly cancelFailures = new Map<string, Error>()

  override async send(command: NodeCommand): Promise<void> {
    if (command.type === 'session.cancel') {
      const failure = this.cancelFailures.get(command.sessionId)
      if (failure) throw failure
    }
    return super.send(command)
  }
}

function post(path: string, body: unknown = {}, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function open(): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-console-pause-'))
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  address = await server.listen(0)
}

/** A Project with its PM Session and one Ticket whose Worker runs. */
async function projectWithWorker(): Promise<{ projectId: string; ticketId: string; worker: string }> {
  control!.store.triggers.save({ id: 'trigger-1', source: 'internal', threads: [{ source: 'internal', id: 'thread-1' }],
    actor: { source: 'internal', id: 'operator' }, human: true, at: START, text: 'Build it', meta: {} })
  const project = control!.createProject('trigger-1', 'Project', 'Goal')
  const pm = await control!.openProject(project.id)
  const [created] = control!.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Ticket', goal: 'Do it' }])
  const assignment = created!.assignments[0]!
  await vi.waitFor(() => expect(control!.session(`worker-${assignment.id}`)?.status).toBe('idle'))
  await vi.waitFor(() => expect(control!.store.tickets.get(created!.id)?.undelivered).toHaveLength(0))
  return { projectId: project.id, ticketId: created!.id, worker: `worker-${assignment.id}` }
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('a Project hard pause', () => {
  it('names the Worker the node did not confirm as stopped, and keeps the pause', async () => {
    await open()
    const { projectId, ticketId, worker } = await projectWithWorker()
    node.cancelFailures.set(worker, new Error('the node refused the stop'))

    const response = await post(`/v1/console/projects/${projectId}/pause`, { paused: true, mode: 'hard' })
    expect(response.status).toBe(200)
    const answer = await response.json() as {
      project: { status: string }
      workers: { stopped: string[]; failures: { ticketId: string; error: string }[] }
    }
    // The pause is written: the Project is paused even though a Worker may still run.
    expect(answer.project.status).toBe('paused')
    // The Worker the node refused is named, with the reason, and it is not counted as stopped.
    expect(answer.workers.stopped).toEqual([])
    expect(answer.workers.failures).toHaveLength(1)
    expect(answer.workers.failures[0]!.ticketId).toBe(ticketId)
    expect(answer.workers.failures[0]!.error).toContain('refused the stop')
  })

  it('counts a Worker the node confirmed as stopped', async () => {
    await open()
    const { projectId, ticketId } = await projectWithWorker()

    const response = await post(`/v1/console/projects/${projectId}/pause`, { paused: true, mode: 'hard' })
    expect(response.status).toBe(200)
    const answer = await response.json() as {
      project: { status: string }
      workers: { stopped: string[]; failures: { ticketId: string; error: string }[] }
    }
    expect(answer.project.status).toBe('paused')
    expect(answer.workers.stopped).toEqual([ticketId])
    expect(answer.workers.failures).toEqual([])
  })
})

describe('the wording of a pause in the console', () => {
  it('says that the pause is saved and names the Worker that was not confirmed', () => {
    const wording = pauseWording({ project: { status: 'paused' },
      workers: { stopped: [], failures: [{ ticketId: 'ticket-1', error: 'the node refused the stop' }] } })
    expect(wording).toContain('项目已暂停')
    expect(wording).toContain('未确认停止')
    expect(wording).toContain('the node refused the stop')
  })

  it('says that the Workers stopped when they did', () => {
    expect(pauseWording({ project: { status: 'paused' }, workers: { stopped: ['ticket-1'], failures: [] } }))
      .toContain('1 个 Worker 已停止')
    expect(pauseWording({ project: { status: 'paused' }, workers: { stopped: [], failures: [] } }))
      .toBe('项目已暂停')
  })

  it('keeps the wording of the Project actions that stop Workers', () => {
    expect(projectWording('项目已结束', { stopped: ['a', 'b'], failures: [] })).toBe('项目已结束，2 个 Worker 已停止')
    expect(projectWording('项目已结束', { stopped: ['a'], failures: ['b: the node refused'] }))
      .toBe('项目已结束，但有 1 个 Worker 未确认停止')
    expect(projectWording('项目已归档', { stopped: [], failures: [] })).toBe('项目已归档')
  })
})
