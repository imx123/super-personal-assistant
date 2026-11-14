/** Phase 2-B2: a Worker turn's Input ids reach the control plane, which records those Inputs as read. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeEvent, type NodePort } from '../src/shared/protocol.ts'

const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'
const THREAD = { source: 'main-session', id: 'thread-1' }
type Message = Extract<NodeCommand, { type: 'session.message' }>
/** A Trigger Input, the kind of Input that carries `readAt` (see `TicketInput` in the model). */
interface TriggerInput { id: string; readAt?: string | null; deliveredTo?: string }

let directory = ''
let control: ControlPlane | undefined
let node: EventNode | undefined

/** A FakeNode a test can also publish node events from, so the kernel sees facts the fake did not produce itself. */
class EventNode implements NodePort {
  private readonly listeners = new Set<(event: NodeEvent) => void>()
  private readonly unsubscribers: (() => void)[] = []
  constructor(readonly inner: FakeNode) {
    this.unsubscribers.push(inner.subscribe(event => { for (const listener of this.listeners) listener(event) }))
  }
  send(command: NodeCommand): Promise<void> { return this.inner.send(command) }
  subscribe(listener: (event: NodeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(event: NodeEvent): void { for (const listener of [...this.listeners]) listener(event) }
  close(): void { for (const unsubscribe of this.unsubscribers) unsubscribe() }
}

async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function trigger(id: string, text: string): Trigger {
  return { id, source: THREAD.source, threads: [THREAD], actor: { source: THREAD.source, id: 'alice' }, human: true,
    at: START, text, meta: {} }
}

/** A Project with one running Ticket, whose Worker Session the FakeNode hosts. */
interface Fixture {
  plane: ControlPlane
  node: EventNode
  ticketId: string
  assignmentId: string
  sessionId: string
}

async function open(): Promise<Fixture> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-inputs-read-'))
  const inner = new FakeNode({ nodeId: NODE_ID, root: join(directory, 'workspaces'), now: () => START })
  const wrapper = new EventNode(inner)
  node = wrapper
  const plane = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node: wrapper,
    secret: 'inputs-secret', workspaceRoot: join(directory, 'workspaces'), now: () => START, confirmationTimeoutMs: 50 })
  control = plane
  await plane.registerNode()
  plane.store.triggers.save(trigger('trigger-1', 'Build it'))
  const project = plane.createProject('trigger-1', 'Project', 'Goal')
  const pm = await plane.openProject(project.id)
  const [ticket] = plane.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Ticket', goal: 'Do it' }])
  const ticketId = ticket!.id
  await until(() => plane.store.tickets.get(ticketId)?.assignments.at(-1)?.state === 'running', 'the worker start')
  const assignmentId = plane.store.tickets.get(ticketId)!.assignments.at(-1)!.id
  return { plane, node: wrapper, ticketId, assignmentId, sessionId: `worker-${assignmentId}` }
}

/** The `session.message` commands the node received, in order. */
function messages(fixture: Fixture): Message[] {
  return fixture.node.inner.commands.filter((command): command is Message => command.type === 'session.message')
}

/** One trigger Input of the Ticket, by the Trigger that put it there. */
function inputOf(fixture: Fixture, triggerId: string): TriggerInput {
  const ticket = fixture.plane.store.tickets.get(fixture.ticketId)!
  const input = ticket.inputs.find(item => item.kind === 'trigger' && item.triggerId === triggerId)
  if (!input) throw new Error(`the trigger Input of ${triggerId} is missing`)
  return input as TriggerInput
}

/** Emit one `turn-start` the way a node republishes what its backend did. */
function turnStart(fixture: Fixture, data: unknown, assignmentId = fixture.assignmentId, sessionId = fixture.sessionId): void {
  fixture.node.emit({ type: 'session.event', protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID,
    sessionId, projectId: '', assignmentId, role: 'worker', seq: 1, at: START, kind: 'turn-start', data })
}

/** Attach one person's message to the Ticket and wait until its delivery reached the node and the Ticket. */
async function deliver(fixture: Fixture, triggerId: string, text: string): Promise<Message> {
  const before = messages(fixture).length
  fixture.plane.store.triggers.save(trigger(triggerId, text))
  fixture.plane.engine.attach(fixture.ticketId, triggerId)
  await until(() => messages(fixture).length > before, `the Input of ${triggerId} was not delivered`)
  await until(() => fixture.plane.store.tickets.get(fixture.ticketId)?.undelivered.length === 0,
    'the delivery was not recorded on the Ticket')
  return messages(fixture).at(-1)!
}

afterEach(async () => {
  node?.close()
  node = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane Inputs read', () => {
  it('records the Input a turn start names, from the id the delivered message carried', async () => {
    const fixture = await open()
    const message = await deliver(fixture, 'trigger-2', 'a first message')
    const input = inputOf(fixture, 'trigger-2')

    // The delivery names its Input and only it, so the node can report exactly what the turn took.
    expect(message).toMatchObject({ sessionId: fixture.sessionId })
    expect(message.inputIds).toEqual([input.id])
    // Delivered, not yet read: the id waits in the Session until its turn takes it.
    expect(input.readAt).toBe(null)
    expect(input.deliveredTo).toBe(fixture.assignmentId)

    turnStart(fixture, { turn: 1, inputIds: message.inputIds })

    expect(inputOf(fixture, 'trigger-2').readAt).toBe(START)
    expect(fixture.plane.store.tickets.get(fixture.ticketId)?.undelivered).toEqual([])
  })

  it('keeps the ids of two consecutive Inputs apart and records both once their turn starts', async () => {
    const fixture = await open()
    const first = await deliver(fixture, 'trigger-2', 'a first message')
    const second = await deliver(fixture, 'trigger-3', 'a second message')

    // Each delivery names its own Input: neither send repeats nor drops the other's id.
    expect(first.inputIds).toHaveLength(1)
    expect(second.inputIds).toHaveLength(1)
    expect(first.inputIds).not.toEqual(second.inputIds)
    expect(inputOf(fixture, 'trigger-2').readAt).toBe(null)
    expect(inputOf(fixture, 'trigger-3').readAt).toBe(null)

    turnStart(fixture, { turn: 2, inputIds: [...first.inputIds!, ...second.inputIds!] })

    expect(inputOf(fixture, 'trigger-2').readAt).toBe(START)
    expect(inputOf(fixture, 'trigger-3').readAt).toBe(START)
  })

  it('ignores a turn start it cannot attribute to a Session, and still records one that names no Inputs', async () => {
    const fixture = await open()
    const message = await deliver(fixture, 'trigger-2', 'a first message')

    // The kernel attributes a turn through its Session record; one for a Session it does not run changes nothing.
    fixture.node.emit({ type: 'session.event', protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID,
      sessionId: 'worker-ghost', projectId: '', assignmentId: 'replaced-assignment', role: 'worker', seq: 1, at: START,
      kind: 'turn-start', data: { turn: 1, inputIds: message.inputIds } })
    expect(inputOf(fixture, 'trigger-2').readAt).toBe(null)

    // A turn that names no Inputs is still a turn fact: the Assignment's Interrupted mark clears exactly as before.
    const ticket = fixture.plane.store.tickets.get(fixture.ticketId)!
    ticket.assignments.at(-1)!.interruptedAt = START
    fixture.plane.store.tickets.save(ticket)
    turnStart(fixture, { turn: 2 })
    expect(fixture.plane.store.tickets.get(fixture.ticketId)?.assignments.at(-1)?.interruptedAt).toBeUndefined()
    expect(inputOf(fixture, 'trigger-2').readAt).toBe(null)
  })

  it('reads only the strings of a reported id list and ignores a payload that is not one', async () => {
    const fixture = await open()
    const message = await deliver(fixture, 'trigger-2', 'a first message')
    const id = message.inputIds![0]!

    for (const data of [{ turn: 1, inputIds: 'not-an-array' }, { turn: 2, inputIds: ['', 7, null] }, { turn: 3 }, 'bogus']) {
      turnStart(fixture, data)
      expect(inputOf(fixture, 'trigger-2').readAt).toBe(null)
    }

    turnStart(fixture, { turn: 4, inputIds: [42, id, ''] })
    expect(inputOf(fixture, 'trigger-2').readAt).toBe(START)
  })

  it('does not let a replaced Worker’s late turn mark the current Assignment’s Input read', async () => {
    const fixture = await open()
    const message = await deliver(fixture, 'trigger-2', 'a first message')
    const inputId = message.inputIds![0]!
    const readAt = (id: string): string | null | undefined => {
      const input = fixture.plane.store.tickets.get(fixture.ticketId)!.inputs.find(item => item.id === id)
      return input?.kind === 'trigger' ? input.readAt : undefined
    }

    // The Worker is replaced: its Assignment ended and a new one runs the Ticket, with its own Input waiting.
    const stored = fixture.plane.store.tickets.get(fixture.ticketId)!
    const replaced = stored.assignments.at(-1)!
    replaced.state = 'ended'
    stored.assignments.push({ id: 'replacement', state: 'running', createdAt: START })
    stored.inputs.push({ id: 'new-input', kind: 'trigger', triggerId: 'trigger-2', at: START, readAt: null,
      deliveredTo: 'replacement' })
    fixture.plane.store.tickets.save(stored)

    // A late turn of the replaced Worker's Session names the new Assignment's Input; it never took it, so it reads nothing.
    turnStart(fixture, { turn: 2, inputIds: [inputId, 'new-input'] }, replaced.id)
    expect(readAt(inputId)).toBe(null)
    expect(readAt('new-input')).toBe(null)

    // The current Assignment's own turn still records the Input it names.
    fixture.plane.sessions.set('worker-replacement', { ...fixture.plane.session(fixture.sessionId)!,
      sessionId: 'worker-replacement', assignmentId: 'replacement' })
    turnStart(fixture, { turn: 1, inputIds: [inputId] }, 'replacement', 'worker-replacement')
    expect(readAt(inputId)).toBe(START)
    expect(readAt('new-input')).toBe(null)
  })
})
