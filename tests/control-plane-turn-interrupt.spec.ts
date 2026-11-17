/**
 * A turn of one Session: the interrupt that ends it, and the messages that wait for the round that follows it.
 *
 * The interrupt ends the turn that runs right now and nothing else. The Session keeps its identity, its Assignment and
 * its Ticket; the messages that wait for the next turn stay where they are; and a turn that started after the operator's
 * request is never ended in its place.
 *
 * The Router's queue is the other half: a person may write while the Router is still answering, the message waits in the
 * order it was written, and the round that follows the one that runs now reads it. The queue is durable, so a reloaded
 * console explains it, and the node's own facts — the turn that took the message — are what make it read.
 *
 * Every test here runs against the FakeNode: a real DSH node is exercised by the acceptance run in an isolated
 * environment, not by this file.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ConsoleStore } from '../src/control/console-store.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { FakeNode, type FakeNodeOptions } from '../src/node/fake-node.ts'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeEvent } from '../src/shared/protocol.ts'

const SECRET = 'turn-interrupt-secret'
const API_TOKEN = 'turn-interrupt-token'
const VIEWER_TOKEN = 'turn-interrupt-viewer'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'
const ROUTER = 'router'

/** One message id, so a test can ask for the same message twice. */
const FIRST = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: ControllableNode
let address = { url: '', port: 0 }

/**
 * A FakeNode a test can steer.
 *
 * It republishes the fake's own events to its listeners, so the control plane and the test see the same stream, and it
 * lets a test publish an event of its own — the turn a node reports, for instance. A refusal can be armed per Session,
 * and a delivery can be held on a gate, so a test can act while a message is on its way.
 */
class ControllableNode extends FakeNode {
  /** When set, the next `session.message` to that Session fails with it, once. */
  readonly messageFailures = new Map<string, Error>()
  /** When set, a `session.message` to that Session waits for it. */
  readonly messageGates = new Map<string, Promise<void>>()
  /** When set, a `session.interrupt` to that Session fails with it. */
  readonly interruptFailures = new Map<string, Error>()
  /** When set, the node's own events are not republished: the control plane misses them, as it would after a lost stream. */
  muted = false
  private readonly subscribers = new Set<(event: NodeEvent) => void>()

  constructor(options: FakeNodeOptions) {
    super(options)
    // The fake's own events are republished here, so this node has exactly one stream of events.
    super.subscribe(event => {
      if (this.muted) return
      for (const listener of [...this.subscribers]) listener(event)
    })
  }

  override subscribe(listener: (event: NodeEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => { this.subscribers.delete(listener) }
  }

  override async send(command: NodeCommand): Promise<void> {
    if (command.type === 'session.message') {
      const gate = this.messageGates.get(command.sessionId)
      if (gate) await gate
      const failure = this.messageFailures.get(command.sessionId)
      if (failure) {
        this.messageFailures.delete(command.sessionId)
        throw failure
      }
    }
    if (command.type === 'session.interrupt') {
      const failure = this.interruptFailures.get(command.sessionId)
      if (failure) throw failure
    }
    return super.send(command)
  }

  /** Publish one event into the control plane, as a node would. */
  publish(event: NodeEvent): void { for (const listener of [...this.subscribers]) listener(event) }

  /** Publish the node's own liveness, as a node that came back would. */
  publishNodeStatus(online: boolean): void {
    this.publish({ type: 'node.status', protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID, sessionId: '',
      projectId: '', role: 'pm', seq: 0, at: START,
      status: { nodeId: NODE_ID, backend: 'dsh', version: '0.1.0', online, at: START } })
  }
}

function post(path: string, body: unknown = {}, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function get(path: string, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

/** Wait for a fact to become true. */
async function until(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** The Router's own state, as the console reads it. */
interface RouterView {
  queue?: { id: string; text: string; state: string; error?: string }[]
  messages: { role: string; text: string }[]
}

async function routerState(): Promise<RouterView> {
  const response = await get('/v1/console/router')
  expect(response.status).toBe(200)
  return await response.json() as RouterView
}

/** The queue rows of one message, by the words the person wrote. */
function rowsOf(state: RouterView, text: string): { id: string; text: string; state: string; error?: string }[] {
  return (state.queue ?? []).filter(entry => entry.text === text)
}

async function open(options: { capabilities?: readonly string[] } = {}): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-turn-interrupt-'))
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START, ...options })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50, ensureSettleTimeoutMs: 100 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
  address = await server.listen(0)
}

/**
 * Open the same control plane again, on the same files.
 *
 * The queue is the control plane's own durable record, so a restart reads it back: a message that waited for a turn is
 * still waiting after the process that queued it is gone.
 */
async function reopen(): Promise<void> {
  const root = join(directory, 'workspaces')
  // The old server goes first: a listener that outlives its control plane would keep the process alive.
  await server?.close().catch(() => {})
  server = undefined
  await control!.close()
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50, ensureSettleTimeoutMs: 100 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
  address = await server.listen(0)
}

/** A Project with its PM Session and `count` Tickets whose Workers run. */
async function projectWithWorkers(count = 1): Promise<{
  projectId: string
  pmSessionId: string
  tickets: { id: string; assignmentId: string; sessionId: string }[]
}> {
  control!.store.triggers.save({ id: 'trigger-1', source: 'internal', threads: [{ source: 'internal', id: 'thread-1' }],
    actor: { source: 'internal', id: 'operator' }, human: true, at: START, text: 'Build it', meta: {} })
  const project = control!.createProject('trigger-1', 'Project', 'Goal')
  const pm = await control!.openProject(project.id)
  const created = control!.engine.createProjectTickets(project.id, pm.sessionId,
    Array.from({ length: count }, (_, index) => ({ title: `Ticket ${index}`, goal: 'Do it' })))
  const tickets: { id: string; assignmentId: string; sessionId: string }[] = []
  for (const ticket of created) {
    const assignment = ticket.assignments.at(-1)!
    await until(() => control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.state === 'running',
      `the Worker of Ticket ${ticket.id} did not start`)
    tickets.push({ id: ticket.id, assignmentId: assignment.id, sessionId: `worker-${assignment.id}` })
  }
  return { projectId: project.id, pmSessionId: pm.sessionId, tickets }
}

/** Start the Router and wait until the node really holds it. */
async function startRouter(): Promise<void> {
  expect((await post('/v1/console/router/message', { text: '现在有什么在跑？' })).status).toBe(200)
  await until(() => node.sessions.get(ROUTER) !== undefined, 'the Router Session was not created')
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the Router queue', () => {
  it('keeps an interjection queued while the Router answers, and hands it over in order afterwards', async () => {
    await open()
    await startRouter()
    // The Router is answering now.
    const turn = node.holdTurn(ROUTER)
    expect(turn).toBe(1)

    // A person writes two more messages while the Router is answering.
    expect((await post('/v1/console/router/message', { text: '先停一下', id: FIRST })).status).toBe(200)
    expect((await post('/v1/console/router/message', { text: '改主意了', id: SECOND })).status).toBe(200)

    // The node received neither of them: they wait for the round that follows the one that runs now.
    expect(node.messages.get(ROUTER)).toHaveLength(1)

    // The console sees the queue, in the order the messages were written.
    const waiting = await routerState()
    expect(rowsOf(waiting, '先停一下')).toHaveLength(1)
    expect(rowsOf(waiting, '改主意了')).toHaveLength(1)
    expect(rowsOf(waiting, '先停一下')[0]!.state).toBe('queued')
    expect(rowsOf(waiting, '改主意了')[0]!.state).toBe('queued')
    // The order of the queue is the order they will be delivered in.
    const texts = (waiting.queue ?? []).map(entry => entry.text)
    expect(texts.indexOf('先停一下')).toBeLessThan(texts.indexOf('改主意了'))

    // The turn ends, and the queue follows on its own: nobody has to press send again.
    node.releaseTurn(ROUTER)
    await until(() => (node.messages.get(ROUTER) ?? []).length === 3, 'the queued messages were not delivered')
    const delivered = node.messages.get(ROUTER)!
    expect(delivered[1]).toContain('先停一下')
    expect(delivered[2]).toContain('改主意了')

    // The node took them: they are sent, and only a turn that reads them makes them read.
    const sent = await routerState()
    expect(rowsOf(sent, '先停一下')[0]!.state).toBe('sent')
    expect(rowsOf(sent, '改主意了')[0]!.state).toBe('sent')
    expect(rowsOf(sent, '先停一下')[0]!.state).not.toBe('read')
  })

  it('marks a message read only when a turn of the Router really took it', async () => {
    await open()
    await startRouter()
    await post('/v1/console/router/message', { text: '读我', id: FIRST })
    const state = await routerState()
    const entry = rowsOf(state, '读我')[0]!
    expect(entry.state).toBe('sent')

    // The node reports the turn that took the message, naming its id.
    node.publish({ type: 'session.event', protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID, sessionId: ROUTER,
      projectId: ROUTER, role: 'router', seq: 1, at: START, kind: 'turn-start', data: { turn: 1, inputIds: [entry.id] } })

    const read = await routerState()
    expect(rowsOf(read, '读我')[0]!.state).toBe('read')
  })

  it('keeps the queue across a reload, and never sends the same message twice', async () => {
    await open()
    await startRouter()
    node.holdTurn(ROUTER)
    await post('/v1/console/router/message', { text: '只发一次', id: FIRST })

    // A reload reads the queue from the control plane again: the state is the server's, not the browser's.
    const before = await routerState()
    expect(rowsOf(before, '只发一次')).toHaveLength(1)
    expect(rowsOf(before, '只发一次')[0]!.state).toBe('queued')

    // The same message id is the same message: it is not queued twice.
    const again = await post('/v1/console/router/message', { text: '只发一次', id: FIRST })
    expect(again.status).toBe(200)
    const after = await routerState()
    expect(rowsOf(after, '只发一次')).toHaveLength(1)

    // And the node receives it exactly once, whatever the browser repeats.
    node.releaseTurn(ROUTER)
    await until(() => (node.messages.get(ROUTER) ?? []).length === 2, 'the queued message was not delivered')
    expect(node.messages.get(ROUTER)!.filter(text => text.includes('只发一次'))).toHaveLength(1)
  })

  it('refuses the same message id with other words', async () => {
    await open()
    await startRouter()
    expect((await post('/v1/console/router/message', { text: '原话', id: FIRST })).status).toBe(200)

    // The same id with other words is a conflict: the queue holds one message under one id.
    const conflict = await post('/v1/console/router/message', { text: '另一句', id: FIRST })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: expect.stringContaining('already used') })

    // The message that was queued keeps its own words.
    const state = await routerState()
    expect(rowsOf(state, '原话')).toHaveLength(1)
    expect(rowsOf(state, '另一句')).toHaveLength(0)
  })

  it('queues one message when the same id arrives twice at once', async () => {
    await open()
    await startRouter()
    node.holdTurn(ROUTER)
    const [one, two] = await Promise.all([
      post('/v1/console/router/message', { text: '同一句', id: FIRST }),
      post('/v1/console/router/message', { text: '同一句', id: FIRST }),
    ])
    expect(one.status).toBe(200)
    expect(two.status).toBe(200)

    const state = await routerState()
    expect(rowsOf(state, '同一句')).toHaveLength(1)

    // And the node receives it once, whatever the browser did.
    node.releaseTurn(ROUTER)
    await until(() => (node.messages.get(ROUTER) ?? []).length === 2, 'the queued message was not delivered')
    expect(node.messages.get(ROUTER)!.filter(text => text.includes('同一句'))).toHaveLength(1)
  })

  it('says so when the node refuses a message, instead of losing it', async () => {
    await open()
    await startRouter()
    node.messageFailures.set(ROUTER, new Error('the node refused the message'))

    const response = await post('/v1/console/router/message', { text: '有人吗' })
    // The answer is not a success: the message never reached the Router, and the console is told so.
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('the node refused the message') })
    const state = await routerState()
    expect(rowsOf(state, '有人吗')).toHaveLength(1)
    expect(rowsOf(state, '有人吗')[0]!.state).toBe('failed')
    expect(rowsOf(state, '有人吗')[0]!.error).toContain('the node refused the message')
  })

  it('keeps the queue going after the node refused a message', async () => {
    await open()
    await startRouter()
    node.holdTurn(ROUTER)
    await post('/v1/console/router/message', { text: '第一条', id: FIRST })
    await post('/v1/console/router/message', { text: '第二条', id: SECOND })

    // The node refuses the first message and takes the second one: one refusal does not stop the queue.
    node.messageFailures.set(ROUTER, new Error('the node refused the message'))
    node.releaseTurn(ROUTER)

    // The refused message never reached the node; the one behind it did.
    await until(() => (node.messages.get(ROUTER) ?? []).length === 2, 'the second message was not delivered')
    const state = await routerState()
    expect(rowsOf(state, '第一条')[0]!.state).toBe('failed')
    expect(rowsOf(state, '第二条')[0]!.state).toBe('sent')
  })

  it('never overwrites a read message with a failure', async () => {
    await open()
    await startRouter()
    const gate = Promise.withResolvers<void>()
    node.messageGates.set(ROUTER, gate.promise)
    const posting = post('/v1/console/router/message', { text: '读我', id: FIRST })
    await until(async () => rowsOf(await routerState(), '读我')[0]?.state === 'sending', 'the message did not start')

    // A turn of the Router really takes the message while the delivery is still on its way.
    node.publish({ type: 'session.event', protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID, sessionId: ROUTER,
      projectId: ROUTER, role: 'router', seq: 1, at: START, kind: 'turn-start',
      data: { turn: 1, inputIds: [`router-msg-${FIRST}`] } })
    expect(rowsOf(await routerState(), '读我')[0]!.state).toBe('read')

    // The delivery fails afterwards: the read fact is the stronger one and is not overwritten.
    node.messageFailures.set(ROUTER, new Error('the node refused the message'))
    gate.resolve()
    await posting
    expect(rowsOf(await routerState(), '读我')[0]!.state).toBe('read')
  })

  it('refuses a message when the queue is full, and keeps the messages that are there', async () => {
    await open()
    await startRouter()
    node.holdTurn(ROUTER)
    // The queue holds a bounded number of messages; the one that does not fit is refused.
    let refused: { response: Response; text: string } | undefined
    for (let index = 0; index < 60 && refused === undefined; index++) {
      const text = `排队 ${index}`
      const response = await post('/v1/console/router/message', { text, id: randomUUID() })
      if (response.status !== 200) refused = { response, text }
    }
    expect(refused?.response.status).toBe(409)
    expect(await refused!.response.json()).toMatchObject({ error: expect.stringContaining('cannot take more') })

    // The messages that were already there keep their place: none of them was pushed out to make room, and the refused
    // one was never accepted.
    const state = await routerState()
    expect(rowsOf(state, refused!.text)).toHaveLength(0)
    expect(rowsOf(state, '排队 0')).toHaveLength(1)
    expect(rowsOf(state, '排队 0')[0]!.state).toBe('queued')
  })

  it('asks the node before it waits, so an old "running" cannot hold the queue', async () => {
    await open()
    await startRouter()
    node.holdTurn(ROUTER)
    await post('/v1/console/router/message', { text: '等着', id: FIRST })
    expect(rowsOf(await routerState(), '等着')[0]!.state).toBe('queued')

    // The control plane's own snapshot still says the Router is answering, but the node says it is free.
    node.sessions.get(ROUTER)!.status = 'idle'
    // The node reports that it is there: the queue looks again, and the node's own answer decides.
    node.publishNodeStatus(true)

    await until(async () => rowsOf(await routerState(), '等着')[0]?.state === 'sent', 'the message was not delivered')
  })

  it('keeps a message queued across a restart of the control plane', async () => {
    await open()
    await startRouter()
    node.holdTurn(ROUTER)
    await post('/v1/console/router/message', { text: '别丢', id: FIRST })
    expect(rowsOf(await routerState(), '别丢')[0]!.state).toBe('queued')

    await reopen()

    // The queue is the control plane's own durable record, so the message is still waiting after the restart.
    const state = await routerState()
    expect(rowsOf(state, '别丢')).toHaveLength(1)
    expect(rowsOf(state, '别丢')[0]!.state).toBe('queued')

    // And it goes out as soon as the Router is free again.
    node.releaseTurn(ROUTER)
    await until(() => (node.messages.get(ROUTER) ?? []).length === 2, 'the queued message was not delivered')
    expect(rowsOf(await routerState(), '别丢')[0]!.state).toBe('sent')
  })

  it('gives the Router its authority back after a restart, so its tool call still works', async () => {
    await open()
    await startRouter()
    node.holdTurn(ROUTER)
    await post('/v1/console/router/message', { text: '建个独立任务', id: FIRST })
    const requestId = `router-req-${FIRST}`

    await reopen()

    // The Router is free again, so the message goes out — with the request id it was written with.
    node.releaseTurn(ROUTER)
    await until(() => (node.messages.get(ROUTER) ?? []).length === 2, 'the queued message was not delivered')
    const delivered = node.messages.get(ROUTER)![1]!
    expect(delivered).toContain(requestId)

    // The Router acts for that message: the control plane knows the request again, so the call is not refused as
    // unknown.
    const token = node.tokens.get(ROUTER)!
    const response = await post('/v1/tools/router/dispatch', { requestId, title: '核对', goal: '核对数据' }, token)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ticket: { id: expect.any(String) } })
  })

  it('marks a message that was on its way when the process ended as unconfirmed', async () => {
    await open()
    await startRouter()
    const gate = Promise.withResolvers<void>()
    node.messageGates.set(ROUTER, gate.promise)
    const posting = post('/v1/console/router/message', { text: '半路', id: FIRST })
    await until(async () => rowsOf(await routerState(), '半路')[0]?.state === 'sending', 'the message did not start')

    // The control plane ends while the message is on its way: its outcome is unknown, not negative.
    await reopen()
    gate.resolve()
    await posting.catch(() => undefined)

    // The new process says honestly what it found: the receipt is missing, so the message is neither sent again nor
    // given a fresh authority.
    const state = await routerState()
    expect(rowsOf(state, '半路')).toHaveLength(1)
    expect(rowsOf(state, '半路')[0]!.state).toBe('unconfirmed')
  })
})

describe('the Router queue on its own', () => {
  it('drops only the messages that really ended, and keeps every message that still waits', async () => {
    const home = mkdtempSync(join(tmpdir(), 'superagent-router-queue-'))
    const store = new ConsoleStore(join(home, 'console.sqlite'))
    try {
      const row = (id: string, state: string): void => {
        store.addRouterMessage({ id, at: START, text: id, attachments: '', model: '', requestId: `req-${id}`,
          state, error: '' })
      }
      // The waiting message is the oldest one, and it is the one a careless prune would drop.
      row('waiting', 'queued')
      row('sending', 'sending')
      row('sent', 'sent')
      row('unconfirmed', 'unconfirmed')
      for (let index = 0; index < 5; index++) {
        row(`done-${index}`, index % 2 === 0 ? 'read' : 'failed')
      }

      store.pruneRouterMessages(2)

      // The messages that still wait are tasks, not history: they stay.
      expect(store.routerMessage('waiting')?.state).toBe('queued')
      expect(store.routerMessage('sending')?.state).toBe('sending')
      expect(store.routerMessage('sent')?.state).toBe('sent')
      expect(store.routerMessage('unconfirmed')?.state).toBe('unconfirmed')
      // The ended ones are history, and the oldest of them go first.
      expect(store.routerMessage('done-0')).toBeUndefined()
      expect(store.routerMessage('done-1')).toBeUndefined()
      expect(store.routerMessage('done-4')?.state).toBe('read')
    } finally {
      store.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the interrupt of a turn', () => {
  it('ends the turn that runs and leaves the Session alone', async () => {
    await open()
    await startRouter()
    const turn = node.holdTurn(ROUTER)

    const response = await post(`/v1/console/sessions/${ROUTER}/interrupt`, { reason: '换个方向' })
    expect(response.status).toBe(200)
    const answer = await response.json() as { interrupted: boolean; confirmed: boolean; turn: number }
    expect(answer.interrupted).toBe(true)
    expect(answer.confirmed).toBe(true)
    expect(answer.turn).toBe(turn)

    // The node really ended that turn, and the Session is still the same one.
    expect(node.sessions.get(ROUTER)?.status).toBe('idle')
    expect(control!.session(ROUTER)?.role).toBe('router')
    expect(control!.session(ROUTER)?.operatorStop).toBeUndefined()
  })

  it('never ends the turn that started after the request', async () => {
    await open()
    await startRouter()
    const turn = node.holdTurn(ROUTER)

    // The control plane's stream misses the events of the next turn, as it would after a gap: it still believes the
    // first turn is running.
    node.muted = true
    node.releaseTurn(ROUTER)
    const next = node.holdTurn(ROUTER)
    node.muted = false
    expect(next).toBe(turn + 1)

    const response = await post(`/v1/console/sessions/${ROUTER}/interrupt`, {})
    // The node refuses: it runs another turn than the one the request named, and that turn is not the operator's.
    expect(response.status).toBe(200)
    const answer = await response.json() as { interrupted: boolean; confirmed: boolean; error: string }
    expect(answer.interrupted).toBe(false)
    expect(answer.confirmed).toBe(false)
    expect(answer.error).toContain('was not interrupted')
    // The turn that was running is still running: the wrong one was never ended.
    expect(node.sessions.get(ROUTER)?.status).toBe('running')
  })

  it('never ends a turn that started after the operator acted', async () => {
    await open()
    await startRouter()
    const turn = node.holdTurn(ROUTER)

    // The operator acts on the turn it sees, and a new turn starts before the request arrives.
    node.muted = true
    node.releaseTurn(ROUTER)
    node.holdTurn(ROUTER)
    node.muted = false

    const response = await post(`/v1/console/sessions/${ROUTER}/interrupt`, { turn })
    expect(response.status).toBe(200)
    const answer = await response.json() as { interrupted: boolean; confirmed: boolean; error: string }
    expect(answer.interrupted).toBe(false)
    expect(answer.confirmed).toBe(false)
    expect(answer.error).toContain('was not interrupted')
    // The turn that runs now is still running.
    expect(node.sessions.get(ROUTER)?.status).toBe('running')
  })

  it('refuses a Session that runs no turn, and says which Session it was', async () => {
    await open()
    await startRouter()
    const response = await post(`/v1/console/sessions/${ROUTER}/interrupt`, {})
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('no running turn') })
  })

  it('refuses a node that cannot interrupt a turn, instead of pretending it did', async () => {
    await open({ capabilities: [] })
    await startRouter()
    node.holdTurn(ROUTER)

    const response = await post(`/v1/console/sessions/${ROUTER}/interrupt`, {})
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('cannot interrupt a turn') })
    // The turn is still running: nothing was ended.
    expect(node.sessions.get(ROUTER)?.status).toBe('running')
  })

  it('reports a node that refused the interrupt, without claiming the turn ended', async () => {
    await open()
    await startRouter()
    node.holdTurn(ROUTER)
    node.interruptFailures.set(ROUTER, new Error('the node is busy'))

    const response = await post(`/v1/console/sessions/${ROUTER}/interrupt`, {})
    expect(response.status).toBe(200)
    const answer = await response.json() as { interrupted: boolean; confirmed: boolean; error: string }
    expect(answer.interrupted).toBe(false)
    expect(answer.confirmed).toBe(false)
    expect(answer.error).toContain('the node is busy')
  })

  it('interrupts a turn without touching the Assignment, the Ticket or the Project', async () => {
    await open()
    const { projectId, tickets } = await projectWithWorkers(1)
    const ticket = tickets[0]!
    node.holdTurn(ticket.sessionId)

    const response = await post(`/v1/console/sessions/${ticket.sessionId}/interrupt`, {})
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ interrupted: true, confirmed: true })

    // The work is exactly where the interrupt left it.
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.state).toBe('running')
    expect(control!.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    expect(control!.store.tickets.get(ticket.id)?.manualStop).toBeUndefined()
    expect(control!.store.projects.get(projectId)?.status).toBe('active')
  })

  it('says something next when it interrupts, and keeps the two facts apart', async () => {
    await open()
    await startRouter()
    node.holdTurn(ROUTER)

    const response = await post(`/v1/console/sessions/${ROUTER}/interrupt`, { text: '换个方向' })
    expect(response.status).toBe(200)
    const answer = await response.json() as { interrupt: { interrupted: boolean }; delivered: string }
    expect(answer.interrupt.interrupted).toBe(true)
    // The turn really ended, and the message went out to the Router in the round that follows it.
    expect(answer.delivered).toBe('sent')
    await until(() => (node.messages.get(ROUTER) ?? []).length === 2, 'the message was not delivered')
    expect(node.messages.get(ROUTER)![1]).toContain('换个方向')
  })

  it('refuses a Session an operator stopped', async () => {
    await open()
    const { pmSessionId } = await projectWithWorkers(1)
    node.holdTurn(pmSessionId)
    expect((await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '停' })).status).toBe(200)

    // A stopped Session has no turn to interrupt: the stop is the operator's own word.
    const stopped = await post(`/v1/console/sessions/${pmSessionId}/interrupt`, {})
    expect(stopped.status).toBe(409)
    expect(await stopped.json()).toMatchObject({ error: expect.stringContaining('stopped by an operator') })
  })

  it('refuses a Session that was revoked', async () => {
    await open()
    const { pmSessionId } = await projectWithWorkers(1)
    node.holdTurn(pmSessionId)
    expect((await post(`/v1/console/sessions/${pmSessionId}/revoke`, { reason: '换人' })).status).toBe(200)

    const revoked = await post(`/v1/console/sessions/${pmSessionId}/interrupt`, {})
    expect(revoked.status).toBe(409)
    expect(await revoked.json()).toMatchObject({ error: expect.stringContaining('revoked') })
  })

  it('refuses the Worker of an Assignment that is no longer current', async () => {
    await open()
    const { projectId, pmSessionId, tickets } = await projectWithWorkers(1)
    const ticket = tickets[0]!
    const old = ticket.assignmentId
    // The person stops the Worker, approves its resume, and the PM starts a new Assignment over it.
    expect((await post(`/v1/console/assignments/${old}/stop`, { reason: '不做了' })).status).toBe(200)
    expect((await post(`/v1/console/tickets/${ticket.id}/resume`)).status).toBe(200)
    const revived = control!.engine.reviveProjectTicket(projectId, pmSessionId, ticket.id)
    const current = revived.assignments.at(-1)!.id
    expect(current).not.toBe(old)

    // The Session of the replaced Assignment may not interrupt the Worker that took its place.
    const response = await post(`/v1/console/sessions/worker-${old}/interrupt`, {})
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('replaced') })
    expect(node.sessions.get(`worker-${current}`)?.status).not.toBe('stopped')
  })

  it('keeps the write for the operator alone', async () => {
    await open()
    await startRouter()
    node.holdTurn(ROUTER)

    // A read-only viewer may read the facts, but it may not interrupt a turn.
    expect((await get('/v1/console/router', VIEWER_TOKEN)).status).toBe(200)
    const response = await post(`/v1/console/sessions/${ROUTER}/interrupt`, {}, VIEWER_TOKEN)
    expect(response.status).toBe(403)
    // The turn is still running.
    expect(node.sessions.get(ROUTER)?.status).toBe('running')
  })
})
