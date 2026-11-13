/** Phase 1B: the control plane's Engine Assignments become Worker Sessions on the node. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { KV } from '../src/kv.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import type { NodeCommand, NodeEvent, NodePort, SessionInspection } from '../src/shared/protocol.ts'

const SECRET = 'executor-secret'
const START = '2026-01-01T00:00:00.000Z'

let directory = ''
let control: ControlPlane | undefined

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

function openControl(node: NodePort): ControlPlane {
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces'), now: () => START, confirmationTimeoutMs: 100 })
  return control
}

function createProject(plane: ControlPlane): ReturnType<ControlPlane['createProject']> {
  plane.store.triggers.save(trigger())
  return plane.createProject('trigger-1', 'Project', 'Goal')
}

/** Wait for the asynchronous Executor callbacks to settle the store. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A node that refuses `worker.create` and otherwise behaves like the FakeNode. */
class RefusingWorkerCreate implements NodePort {
  readonly commands: NodeCommand[] = []

  constructor(readonly inner: FakeNode) {}

  async send(command: NodeCommand): Promise<void> {
    this.commands.push(command)
    if (command.type === 'worker.create') throw new Error('node refused worker.create')
    await this.inner.send(command)
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }

  async inspect(sessionId: string): Promise<SessionInspection> {
    return this.inner.inspect(sessionId)
  }
}

/** A node that refuses every `session.message`, so an Input delivery fails after the Worker Session exists. */
class RejectingMessages implements NodePort {
  constructor(readonly inner: FakeNode) {}

  async send(command: NodeCommand): Promise<void> {
    if (command.type === 'session.message') throw new Error('message delivery refused')
    await this.inner.send(command)
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    return this.inner.subscribe(listener)
  }

  async inspect(sessionId: string): Promise<SessionInspection> {
    return this.inner.inspect(sessionId)
  }
}

afterEach(async () => {
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane NodeExecutor', () => {
  it('creates the Worker Session and marks the Assignment running', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-executor-'))
    const node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START })
    const plane = openControl(node)
    const project = createProject(plane)

    const [ticket] = plane.engine.createProjectTickets(project.id, project.pmSessionId, [{ title: 'T', goal: 'G' }])
    const assignment = ticket!.assignments[0]!
    await until(() => plane.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state === 'running',
      'the Assignment did not reach running')

    const creates = node.commands.filter((command): command is Extract<NodeCommand, { type: 'worker.create' }> =>
      command.type === 'worker.create')
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({ sessionId: `worker-${assignment.id}`, projectId: project.id,
      assignmentId: assignment.id, ticketId: ticket!.id })
    // The Worker's brief is the Ticket's task facts, not only its short title.
    expect(creates[0]!.prompt).toContain('Ticket: T')
    expect(creates[0]!.prompt).toContain('Goal: G')
    expect(creates[0]!.prompt).toContain('Source: T: G')
    expect(plane.session(`worker-${assignment.id}`)).toMatchObject({ status: 'idle', role: 'worker',
      assignmentId: assignment.id })
    expect(plane.store.get(KV.control.session(`worker-${assignment.id}`))).toMatchObject({ status: 'idle' })
    expect(plane.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running')
  })

  it('delivers the waiting text input to the Assignment Worker Session', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-executor-'))
    const node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START })
    const plane = openControl(node)
    const project = createProject(plane)

    const [ticket] = plane.engine.createProjectTickets(project.id, project.pmSessionId, [{ title: 'T', goal: 'G' }])
    const assignment = ticket!.assignments[0]!
    await until(() => plane.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state === 'running',
      'the Assignment did not reach running before delivery')

    plane.engine.messageTicket(ticket!.id, 'more context for this Ticket')
    await until(() => node.messages.get(`worker-${assignment.id}`)?.includes('more context for this Ticket') === true,
      'the waiting input was not delivered')

    expect(node.messages.get(`worker-${assignment.id}`)).toContain('more context for this Ticket')
  })

  it('reports a refused worker.create as a failed Assignment instead of leaving it pending silently', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-executor-'))
    const node = new RefusingWorkerCreate(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'),
      now: () => START }))
    const plane = openControl(node)
    const project = createProject(plane)

    const [ticket] = plane.engine.createProjectTickets(project.id, project.pmSessionId, [{ title: 'T', goal: 'G' }])
    const assignment = ticket!.assignments[0]!
    await until(() => plane.store.tickets.get(ticket!.id)?.assignments.at(-1)?.report?.state === 'failed',
      'the failed Assignment was not reported')

    expect(node.commands.filter(command => command.type === 'worker.create')).toHaveLength(1)
    expect(node.inner.sessions.has(`worker-${assignment.id}`)).toBe(false)
    expect(plane.session(`worker-${assignment.id}`)).toMatchObject({ status: 'failed' })
    expect(plane.store.tickets.get(ticket!.id)?.assignments.at(-1)).toMatchObject({
      id: assignment.id,
      report: { state: 'failed', summary: expect.stringContaining('node refused worker.create') },
    })
  })

  it('starts the Worker from the Project task meta, not only its title', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-executor-'))
    const node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START })
    const plane = openControl(node)
    const project = createProject(plane)

    const [ticket] = plane.engine.createProjectTickets(project.id, project.pmSessionId,
      [{ title: 'Login', goal: 'Fix the auth flow', scope: 'src/auth', note: 'Keep the existing tests' }])
    await until(() => node.commands.some(command => command.type === 'worker.create'),
      'the Worker Session was not created')
    const create = node.commands.find((command): command is Extract<NodeCommand, { type: 'worker.create' }> =>
      command.type === 'worker.create')!

    expect(create.prompt).toContain('Ticket: Login')
    expect(create.prompt).toContain('Goal: Fix the auth flow')
    expect(create.prompt).toContain('Scope: src/auth')
    expect(create.prompt).toContain('Note: Keep the existing tests')
    expect(create.prompt).toContain('Assignment: Fix the auth flow')
    expect(create.prompt).toContain('Source: Login: Fix the auth flow')
    expect(plane.store.tickets.get(ticket!.id)?.undelivered).toEqual([])

    // A Trigger with no meta still gives the Worker the labelled fields and a source, never only a title.
    const bare = plane.taskPrompt({ ...ticket!, origin: { triggerId: 'missing-trigger', triggerIds: ['missing-trigger'] } })
    expect(bare).not.toBe(`Ticket: ${ticket!.title}`)
    expect(bare).toContain('Ticket: Login')
    expect(bare).toContain('Assignment:')
    expect(bare).toContain('Source:')
  })

  it('sends each note Input once and clears the undelivered ids after the send', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-executor-'))
    const node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START })
    const plane = openControl(node)
    const project = createProject(plane)

    const [ticket] = plane.engine.createProjectTickets(project.id, project.pmSessionId, [{ title: 'T', goal: 'G' }])
    const assignment = ticket!.assignments[0]!
    const sessionId = `worker-${assignment.id}`
    await until(() => plane.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state === 'running',
      'the Assignment did not reach running before delivery')

    // Back-to-back notes: both deliveries overlap, and neither may repeat the other's Input.
    plane.engine.messageTicket(ticket!.id, 'first note')
    plane.engine.messageTicket(ticket!.id, 'second note')
    await until(() => node.messages.get(sessionId)?.some(text => text.includes('second note')) === true,
      'the second note was not delivered')
    await until(() => plane.store.tickets.get(ticket!.id)?.undelivered.length === 0,
      'the notes stayed undelivered after their sends')

    const deliveredText = (node.messages.get(sessionId) ?? []).join('\n')
    expect(deliveredText.match(/first note/g)).toHaveLength(1)
    expect(deliveredText.match(/second note/g)).toHaveLength(1)
    expect(plane.store.tickets.get(ticket!.id)?.inputs.map(input => input.kind)).toEqual(expect.arrayContaining(['note']))
  })

  it('does not clear undelivered Inputs when the send fails', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-executor-'))
    const node = new RejectingMessages(new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'),
      now: () => START }))
    const plane = openControl(node)
    const project = createProject(plane)

    const [ticket] = plane.engine.createProjectTickets(project.id, project.pmSessionId, [{ title: 'T', goal: 'G' }])
    const assignment = ticket!.assignments[0]!
    await until(() => plane.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state === 'running',
      'the Assignment did not reach running before delivery')
    const delivered = vi.spyOn(plane.engine, 'inputsDelivered')

    plane.engine.messageTicket(ticket!.id, 'cannot be delivered')
    await until(() => plane.store.tickets.get(ticket!.id)?.delivery?.error?.includes('message delivery refused') === true,
      'the failed delivery was not recorded')

    expect(delivered).not.toHaveBeenCalled()
    expect(plane.store.tickets.get(ticket!.id)?.undelivered).toHaveLength(1)
    expect(plane.store.tickets.get(ticket!.id)?.assignments.at(-1)?.report).toBeUndefined()
  })
})
