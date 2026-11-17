/**
 * The console's message to a Worker Session, and the Router's message to a standalone Ticket.
 *
 * A message is bound to the Session it was written for: a Worker that a newer Assignment replaced never receives it, and
 * the Worker that took its place never receives it either — and no Input is written for a message that cannot be
 * delivered. The answer waits for the node's own confirmation, so a message the node refused is never reported as
 * delivered, while a message that is only queued keeps saying so. A standalone Ticket takes the same messages as a
 * Project's Ticket, and the old plugin's Project tools keep their own scope.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { NodeExecutor } from '../src/control/executor.ts'
import { UserError, type Assignment, type Ticket, type TicketInput, type Trigger } from '../src/core/index.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import type { NodeCommand } from '../src/shared/protocol.ts'

const SECRET = 'console-message-secret'
const API_TOKEN = 'console-message-token'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: ControllableNode
let address = { url: '', port: 0 }

/** A FakeNode whose `session.message` a test can refuse. */
class ControllableNode extends FakeNode {
  /** When set, a `session.message` to that Session fails with it. */
  readonly messageFailures = new Map<string, Error>()

  override async send(command: NodeCommand): Promise<void> {
    if (command.type === 'session.message') {
      const failure = this.messageFailures.get(command.sessionId)
      if (failure) throw failure
    }
    return super.send(command)
  }
}

function post(path: string, body: unknown = {}, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function get(path: string, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

/** A control plane with a node, listening on a random port. */
async function open(): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-console-message-'))
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  address = await server.listen(0)
}

function trigger(id: string, text: string, title = 'Standalone', goal = 'Do it'): Trigger {
  return { id, source: 'internal', threads: [{ source: 'internal', id: `thread-${id}` }],
    actor: { source: 'internal', id: 'operator' }, human: true, at: START, text, meta: { title, goal } }
}

/** A Project with its PM Session and one Ticket whose Worker runs. */
async function projectWithWorker(): Promise<{ projectId: string; pmSessionId: string; ticket: Ticket; assignment: Assignment }> {
  control!.store.triggers.save(trigger('trigger-1', 'Build it', 'Ticket', 'Do it'))
  const project = control!.createProject('trigger-1', 'Project', 'Goal')
  const pm = await control!.openProject(project.id)
  const [created] = control!.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Ticket', goal: 'Do it' }])
  const assignment = created!.assignments[0]!
  await vi.waitFor(() => expect(control!.session(`worker-${assignment.id}`)?.status).toBe('idle'))
  // The Ticket's own first message reached the Worker, so the Ticket waits for nothing.
  await vi.waitFor(() => expect(control!.store.tickets.get(created!.id)?.undelivered).toHaveLength(0))
  return { projectId: project.id, pmSessionId: pm.sessionId, ticket: control!.store.tickets.get(created!.id)!, assignment }
}

/** A standalone Ticket the Router owns: it belongs to no Project and has a Worker of its own. */
async function standaloneTicket(): Promise<{ ticket: Ticket; assignment: Assignment }> {
  const request = trigger('trigger-standalone', 'Check the numbers')
  control!.store.triggers.save(request)
  const ticketId = control!.store.atomic(() => {
    control!.engine.recordTriggerForRouting(request)
    const decision = control!.engine.decide('trigger-standalone', { kind: 'accept', title: 'Standalone',
      scope: 'Check the numbers', acknowledgement: 'Check the numbers', reason: { code: 'explicitRouted' } })
    if (!decision.ticketId) throw new Error('the trigger did not create a Ticket')
    return decision.ticketId
  })
  const assignment = control!.store.tickets.get(ticketId)!.assignments[0]!
  await vi.waitFor(() => expect(control!.session(`worker-${assignment.id}`)?.status).toBe('idle'))
  return { ticket: control!.store.tickets.get(ticketId)!, assignment }
}

/**
 * The moment a re-dispatch has happened but the old Worker's Session is still alive.
 *
 * The old Assignment is over and a newer one runs the Ticket, while the old Session was never told to stop: a message
 * written for the old Worker must not reach the new one.
 */
function replaceAssignment(ticketId: string, assignmentId: string): string {
  const ticket = control!.store.tickets.get(ticketId)!
  const fresh: Assignment = { id: `assignment-replacement-${ticket.assignments.length}`, state: 'running',
    createdAt: START, startedAt: START }
  const assignments = [...ticket.assignments.map(item => item.id === assignmentId
    ? { ...item, state: 'ended' as const, endedAt: START, endedReason: 'handedOff' } : item), fresh]
  control!.store.tickets.save({ ...ticket, assignments, updatedAt: START })
  return fresh.id
}

/** The messages one Worker Session really received. */
function workerMessages(sessionId: string): string[] {
  return node.messages.get(sessionId) ?? []
}

/** The texts of a Ticket's notes: the messages a person wrote to its Worker. */
function notes(ticket: Ticket): string[] {
  return ticket.inputs.flatMap(input => (input.kind === 'note' ? [input.text] : []))
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the console\'s message to a Worker Session', () => {
  it('delivers the message to the Worker that runs the Ticket', async () => {
    await open()
    const { ticket, assignment } = await projectWithWorker()
    const worker = `worker-${assignment.id}`

    const response = await post(`/v1/console/sessions/${worker}/message`, { text: '看这里' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sent: true, via: 'ticket', delivered: 'running' })

    // The Worker really has the message, and the Ticket keeps it as one of its Inputs.
    await vi.waitFor(() => expect(workerMessages(worker).join('\n')).toContain('看这里'))
    const stored = control!.store.tickets.get(ticket.id)!
    expect(notes(stored)).toEqual(['看这里'])
    // The Input left the waiting list: it was delivered, not merely queued.
    await vi.waitFor(() => expect(control!.store.tickets.get(ticket.id)?.undelivered).toHaveLength(0))
  })

  it('refuses a message to a Worker a newer Assignment replaced, and nobody receives it', async () => {
    await open()
    const { ticket, assignment } = await projectWithWorker()
    const oldWorker = `worker-${assignment.id}`
    const replacement = replaceAssignment(ticket.id, assignment.id)

    const response = await post(`/v1/console/sessions/${oldWorker}/message`, { text: '给接替者的话' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('newer Assignment') })

    // The Worker that took over received nothing, and the Ticket carries no Input of that message.
    expect(workerMessages(`worker-${replacement}`)).toEqual([])
    expect(workerMessages(oldWorker).join('\n')).not.toContain('给接替者的话')
    const stored = control!.store.tickets.get(ticket.id)!
    expect(notes(stored)).toHaveLength(0)
  })

  it('refuses a message that names another Assignment', async () => {
    await open()
    const { assignment } = await projectWithWorker()
    const worker = `worker-${assignment.id}`

    const response = await post(`/v1/console/sessions/${worker}/message`,
      { text: '写给别的执行记录', assignmentId: 'assignment-other' })
    expect(response.status).toBe(409)
    expect(workerMessages(worker)).toEqual([])
  })

  it('reports a message the node refused instead of a delivery that never happened', async () => {
    await open()
    const { ticket, assignment } = await projectWithWorker()
    const worker = `worker-${assignment.id}`
    node.messageFailures.set(worker, new Error('the node refused the message'))

    const response = await post(`/v1/console/sessions/${worker}/message`, { text: '送不到的消息' })
    // The node refused it: the answer is a failure, never a delivery.
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('refused the message') })

    // The message is still a Ticket Input that waits, so it is sent again when the node can take it.
    const stored = control!.store.tickets.get(ticket.id)!
    expect(notes(stored)).toEqual(['送不到的消息'])
    expect(stored.undelivered).toHaveLength(1)
    expect(stored.delivery?.error).toContain('refused the message')
  })

  it('delivers two messages with the same words, because they are two messages', async () => {
    await open()
    const { ticket, assignment } = await projectWithWorker()
    const worker = `worker-${assignment.id}`

    expect((await post(`/v1/console/sessions/${worker}/message`, { text: '同一句话' })).status).toBe(200)
    expect((await post(`/v1/console/sessions/${worker}/message`, { text: '同一句话' })).status).toBe(200)

    await vi.waitFor(() => expect(workerMessages(worker).filter(text => text.includes('同一句话'))).toHaveLength(2))
    const stored = control!.store.tickets.get(ticket.id)!
    expect(notes(stored)).toHaveLength(2)
  })

  it('tells the console that a Worker which cannot receive a message is not deliverable', async () => {
    await open()
    const { ticket, assignment } = await projectWithWorker()
    const worker = `worker-${assignment.id}`

    const before = await (await get('/v1/sessions')).json() as { sessions: { sessionId: string; deliverable?: boolean }[] }
    expect(before.sessions.find(session => session.sessionId === worker)?.deliverable).toBe(true)

    replaceAssignment(ticket.id, assignment.id)
    const after = await (await get('/v1/sessions')).json() as {
      sessions: { sessionId: string; deliverable?: boolean; unavailableReason?: string }[]
    }
    const view = after.sessions.find(session => session.sessionId === worker)!
    expect(view.deliverable).toBe(false)
    expect(view.unavailableReason).toBeTruthy()
  })
})

describe('the message to a standalone Ticket', () => {
  it('reaches the Worker of a standalone Ticket through the console', async () => {
    await open()
    const { ticket, assignment } = await standaloneTicket()
    const worker = `worker-${assignment.id}`
    expect(ticket.projectId).toBeUndefined()

    const response = await post(`/v1/console/sessions/${worker}/message`, { text: '再核对一次' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ via: 'ticket', delivered: 'running' })
    await vi.waitFor(() => expect(workerMessages(worker).join('\n')).toContain('再核对一次'))
  })

  it('reaches the Worker of a standalone Ticket through the Router', async () => {
    await open()
    const { ticket, assignment } = await standaloneTicket()
    const worker = `worker-${assignment.id}`

    const request = await post('/v1/console/router/message', { text: '给独立工单补一句' })
    const { requestId } = await request.json() as { requestId: string }
    const router = node.tokens.get('router')!
    const response = await post('/v1/tools/router/manage',
      { requestId, action: 'message_ticket', targetId: ticket.id, text: 'Router 的话' }, router)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ delivery: 'running', ticket: { id: ticket.id } })
    await vi.waitFor(() => expect(workerMessages(worker).join('\n')).toContain('Router 的话'))
  })

  it('keeps the old plugin\'s Project tools away from a standalone Ticket', async () => {
    await open()
    const { ticket } = await standaloneTicket()

    // The Project path refuses a Ticket that belongs to no Project, and the standalone path refuses a Project's Ticket.
    expect(() => control!.engine.messageTicket(ticket.id, '项目工具的话')).toThrow(new UserError('notProjectTicket'))
    const { projectId } = await projectWithWorker()
    const projectTicket = control!.tickets().find(item => item.projectId === projectId)!
    expect(() => control!.engine.messageTicketTo(projectTicket.id, '独立路径的话', { standalone: true }))
      .toThrow(new UserError('notStandaloneTicket'))

    // The Router may not reach a Project's Ticket through its own management route either.
    const request = await post('/v1/console/router/message', { text: '动项目里的工单' })
    const { requestId } = await request.json() as { requestId: string }
    const router = node.tokens.get('router')!
    const response = await post('/v1/tools/router/manage',
      { requestId, action: 'message_ticket', targetId: projectTicket.id, text: '不该送达' }, router)
    expect(response.status).toBe(400)
  })
})

describe('the delivery of one message', () => {
  it('names the delivery itself, so a repeated delivery is not executed twice', async () => {
    const keys: (string | undefined)[] = []
    const host = {
      createWorkerSession: async () => ({ sessionId: 'worker-a' }),
      sendMessage: async (_sessionId: string, _text: string, _inputIds?: readonly string[], idempotencyKey?: string) => {
        keys.push(idempotencyKey)
      },
      cancelSession: async () => {},
      assignmentStarted: () => {},
      assignmentFailed: () => {},
      taskPrompt: () => '',
      inputsDelivered: () => {},
      workerSessionId: () => 'worker-a',
      inputText: (input: TicketInput) => (input.kind === 'text' || input.kind === 'note' ? input.text : undefined),
    }
    const executor = new NodeExecutor(host)
    const assignment: Assignment = { id: 'assignment-a', state: 'running', createdAt: START }
    const ticket = { id: 'ticket-a', projectId: 'project-a',
      inputs: [{ id: 'input-a', kind: 'note', text: 'hello', at: START }],
      undelivered: ['input-a'], assignments: [assignment] } as unknown as Ticket

    executor.deliver(ticket, assignment)
    await vi.waitFor(() => expect(keys).toHaveLength(1))
    executor.deliver(ticket, assignment)
    await vi.waitFor(() => expect(keys).toHaveLength(2))

    // The same Inputs of the same Assignment are one message: the node executes the key at most once.
    expect(keys[0]).toBeTruthy()
    expect(keys[1]).toBe(keys[0])

    // Another message is another key, so it is executed as well.
    const other = { ...ticket,
      inputs: [...ticket.inputs, { id: 'input-b', kind: 'note', text: 'other', at: START }],
      undelivered: ['input-a', 'input-b'] } as unknown as Ticket
    executor.deliver(other, assignment)
    await vi.waitFor(() => expect(keys).toHaveLength(3))
    expect(keys[2]).not.toBe(keys[0])
  })
})
