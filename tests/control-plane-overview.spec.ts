/**
 * The counts the console's home page shows.
 *
 * Every number is a fact of the domain, read by the kernel that owns it. A Worker that is idle is not executing, and a
 * capability the control plane does not have is named as absent instead of being counted as a zero.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane, type ControlPlaneOverview } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const SECRET = 'overview-test-secret'
const API_TOKEN = 'overview-api-token'
const START = '2026-01-01T00:00:00.000Z'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('control-plane overview', () => {
  it('counts the work that is really going on and leaves an idle Worker out', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-overview-'))
    const root = join(directory, 'workspaces')
    node = new FakeNode({ nodeId: 'local', root, now: () => START })
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
      workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()
    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    const pm = await control.openProject(project.id)

    const overview = control.overview()
    expect(overview.counts.projects).toBe(1)
    expect(overview.counts.nodes).toBe(1)
    // Nothing is running yet: the PM is idle and no Ticket exists.
    expect(overview.runningTickets).toBe(0)
    expect(overview.runningWorkers).toBe(0)
    expect(overview.pendingReviews).toBe(0)
    // The capabilities that are not connected are named, not counted. The scheduler is connected: it holds no plan yet,
    // and its counts say so instead of guessing.
    expect(overview.features).toEqual({ router: false, schedules: true })
    expect(overview.schedules).toMatchObject({ plans: 0, enabled: 0, failed: 0, delivered: 0 })

    // The PM creates a Ticket; the Executor starts its Worker, which is then idle between turns.
    const tickets = control.pmCreateTickets(pm.sessionId, [{ title: 'Ship it', goal: 'Ship the feature' }])
    const ticketId = tickets[0]!.id
    await until(() => control!.store.tickets.get(ticketId)?.assignments.at(-1)?.state === 'running', 'the worker start')

    const working = control.overview()
    expect(working.runningTickets).toBe(1)
    // The Worker's Session is idle, and an idle Worker is not executing.
    expect(working.runningWorkers).toBe(0)
    expect(working.counts.tickets).toBe(1)
    expect(working.counts.sessions).toBe(2)

    // The result waits for the PM: the Ticket that waits is counted, not the Worker.
    const assignment = control.store.tickets.get(ticketId)!.assignments.at(-1)!
    control.workerReport(`worker-${assignment.id}`, ticketId, assignment.id, { state: 'ready', summary: 'done' })
    expect(control.overview().pendingReviews).toBe(1)
  })

  it('answers the overview route with the same facts and refuses an unauthenticated call', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-overview-api-'))
    const root = join(directory, 'workspaces')
    node = new FakeNode({ nodeId: 'local', root, now: () => START })
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
      workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)

    expect((await fetch(`${address.url}/v1/overview`)).status).toBe(401)
    const response = await fetch(`${address.url}/v1/overview`, { headers: { authorization: `Bearer ${API_TOKEN}` } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as ControlPlaneOverview
    expect(body.counts.nodes).toBe(1)
    expect(body.features.router).toBe(false)
    expect(body.events.seq).toBeGreaterThan(0)
    expect(body.retention.eventRows).toBeGreaterThan(0)
    // The answer carries no credential.
    expect(JSON.stringify(body)).not.toContain(API_TOKEN)
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })
})
