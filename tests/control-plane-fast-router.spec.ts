/**
 * The Fast Router: an obvious request carried out by the control plane itself.
 *
 * A message that plainly names its target never reaches the Router's model: the control plane reads the authoritative
 * facts, matches the words and does the work itself — a standalone Ticket with its own Worker, an instruction for the
 * PM of one Project, a continuation of a Ticket the Router owns, an answer taken from the record itself. Everything else
 * is left to the high-level Router, and the receipt says which rule read the message and how far it got.
 *
 * The rules are narrow on purpose: a question, a negation, a quoted command, an ambiguous target, a name that is only
 * part of a longer word and a Ticket that has ended are all left to the model, and a message that names two Projects
 * never reaches one of them by accident.
 *
 * The fast route never runs ahead of the queue: it acts in the place the Router's own queue gives it, it never acts
 * behind a stopped Router, and a delivery that was already tried is never handed to the model to try again.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { fastRoute, type FastRouteFacts } from '../src/control/fast-router.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { NodeUnconfirmedError, type NodeCommand } from '../src/shared/protocol.ts'

const SECRET = 'fast-router-secret'
const API_TOKEN = 'fast-router-token'
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

/** One routing, as the console reads it. */
interface Receipt {
  requestId: string
  outcome: string
  stage: string
  reason: string
  detail: string
  target?: { kind: string; id: string; title: string }
  ticketId?: string
  sessionId?: string
  sessionStatus?: string
  error?: string
  answer?: string
}

function post(path: string, body: unknown = {}, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function get(path: string, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

/** A control plane with a node, listening on a random port. */
async function open(now: () => string = () => START): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-fast-router-'))
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  address = await server.listen(0)
}

/** Restart the control plane against the same files, the way a crash and a restart do. */
async function reopen(now: () => string = () => START): Promise<void> {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces'), now, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  address = await server.listen(0)
}

/** A Project with its PM Session, so the Router has somebody to talk to. */
async function projectWithPm(title: string): Promise<{ projectId: string; pmSessionId: string }> {
  const created = await post('/v1/console/projects', { title, goal: '把工作做完' })
  const { project } = (await created.json()) as { project: { id: string } }
  const pm = await post(`/v1/console/projects/${project.id}/pm`)
  const { session } = (await pm.json()) as { session: { sessionId: string } }
  return { projectId: project.id, pmSessionId: session.sessionId }
}

/** The messages a Session really received. */
function messagesOf(sessionId: string): string[] { return node.messages.get(sessionId) ?? [] }

/** The routings the console shows. */
async function routes(): Promise<Receipt[]> {
  const state = (await (await get('/v1/console/router')).json()) as { routes?: Receipt[] }
  return state.routes ?? []
}

/** The message the person sent, and what it became. */
async function send(text: string, id?: string): Promise<{ sent: boolean; queued: boolean; routing?: Receipt }> {
  const response = await post('/v1/console/router/message', id === undefined ? { text } : { text, id })
  expect(response.status).toBe(200)
  return await response.json() as { sent: boolean; queued: boolean; routing?: Receipt }
}

/** The Worker Session of one Ticket. */
function workerOf(ticketId: string): string {
  const ticket = control!.tickets().find(item => item.id === ticketId)
  expect(ticket).toBeDefined()
  return `worker-${ticket!.assignments[0]!.id}`
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the rules of the fast router', () => {
  const facts: FastRouteFacts = {
    tickets: [
      { id: 'aaaaaaaabbbbccccddddeeeeffff0000', title: '独立整理', ended: false, archived: false },
      { id: '11111111222233334444555566667777', title: '结束的工单', ended: true, archived: false },
    ],
    projects: [
      { id: 'project-weekly', title: '周报整理', status: 'active' },
      { id: 'project-monthly', title: '月报', status: 'active' },
      { id: 'project-paused', title: '暂停的项目', status: 'paused' },
    ],
  }

  const table: { text: string; outcome: string; reason: string }[] = [
    // An independent task of its own, in Chinese and in English.
    { text: '创建一个隔离的示例文件，写入 hello', outcome: 'standalone_ticket', reason: 'standalone_task' },
    { text: '创建一个隔离的示例文件 hello.txt，写入 hello。', outcome: 'standalone_ticket', reason: 'standalone_task' },
    { text: '创建一个独立工单，写入 hello', outcome: 'standalone_ticket', reason: 'standalone_task' },
    { text: 'Create an isolated sample file with hello in it', outcome: 'standalone_ticket', reason: 'standalone_task' },
    { text: 'Create a standalone ticket to write a hello script', outcome: 'standalone_ticket', reason: 'standalone_task' },
    { text: 'Write a standalone ticket for the release notes', outcome: 'standalone_ticket', reason: 'standalone_task' },
    // A task without a goal is not a task yet.
    { text: '创建一个独立工单', outcome: 'escalate', reason: 'missing_goal' },
    // Two tasks in one message are two things.
    { text: '创建一个独立工单并创建一个独立脚本', outcome: 'escalate', reason: 'multiple_tasks' },
    { text: 'Create a standalone ticket and create a script', outcome: 'escalate', reason: 'multiple_tasks' },
    // A negation, a question and a quoted command are not orders.
    { text: '创建一个隔离的示例文件，不要动别的', outcome: 'ordinary_reply', reason: 'negation' },
    { text: "don't create a standalone ticket", outcome: 'ordinary_reply', reason: 'negation' },
    { text: '创建一个隔离的示例文件？', outcome: 'ordinary_reply', reason: 'question' },
    { text: 'Can you create a standalone ticket?', outcome: 'ordinary_reply', reason: 'question' },
    { text: '把「创建一个独立工单」这句话发给我', outcome: 'ordinary_reply', reason: 'conversation' },
    // A Ticket of the Router's own may be continued; one that has ended may not.
    { text: '继续工单 aaaaaaaabbbbccccddddeeeeffff0000', outcome: 'existing_ticket', reason: 'explicit_ticket_id' },
    { text: '继续工单 11111111222233334444555566667777', outcome: 'escalate', reason: 'ticket_ended' },
    // A Ticket that is only mentioned is an ambiguity, not a continuation.
    { text: '工单 aaaaaaaabbbbccccddddeeeeffff0000', outcome: 'escalate', reason: 'ambiguous_target' },
    // One Project may be told something; two may not be picked between.
    { text: '告诉项目「周报整理」把登录改成 SSO', outcome: 'existing_project_pm', reason: 'explicit_project' },
    { text: 'Tell the 「月报」 project to change the login to SSO', outcome: 'existing_project_pm', reason: 'explicit_project' },
    { text: '同时告诉项目「周报整理」和项目「月报」把登录改成 SSO', outcome: 'escalate', reason: 'multiple_targets' },
    // A Project that is not active takes no instruction.
    { text: '告诉项目「暂停的项目」把登录改成 SSO', outcome: 'escalate', reason: 'project_unavailable' },
    // A question about a Project is answered from the authoritative state, not handed to its PM.
    { text: '看看项目「周报整理」的进度', outcome: 'ordinary_reply', reason: 'read_only' },
    // A question about a thing named by its id is answered by the record itself.
    { text: '工单 aaaaaaaabbbbccccddddeeeeffff0000 现在什么状态？', outcome: 'read_only', reason: 'read_only_id' },
    // A name that is only part of a longer word, or only talked about, is no target at all.
    { text: '请解释周报整理这个项目的状态', outcome: 'escalate', reason: 'needs_model' },
    { text: '为什么周报整理最近没动静？', outcome: 'ordinary_reply', reason: 'question' },
    { text: '请说说项目进展', outcome: 'ordinary_reply', reason: 'conversation' },
    // A target this control plane does not hold is not a near miss for another one.
    { text: '告诉项目「不存在的项目」做事', outcome: 'escalate', reason: 'needs_model' },
    { text: '告诉项目「月报整理」把登录改成 SSO', outcome: 'escalate', reason: 'needs_model' },
    // A scope nobody may undo, and a request for more authority, are left to the model and the person.
    { text: '告诉项目「周报整理」删除所有用户数据', outcome: 'escalate', reason: 'irreversible_scope' },
    { text: '告诉项目「周报整理」给它新的权限', outcome: 'escalate', reason: 'new_authority' },
    // A conversation is a conversation.
    { text: '你好', outcome: 'ordinary_reply', reason: 'conversation' },
    { text: '现在有什么在跑？', outcome: 'ordinary_reply', reason: 'question' },
  ]

  it('reads the obvious requests and leaves everything else to the high-level Router', () => {
    for (const row of table) {
      expect(fastRoute(row.text, facts), row.text).toMatchObject({ outcome: row.outcome, reason: row.reason })
    }
  })

  it('never acts without the target it found in the authoritative facts', () => {
    // A Ticket id nobody holds is no target at all.
    expect(fastRoute('继续工单 99999999999999999999999999999999', facts))
      .toMatchObject({ outcome: 'escalate' })
    // A Project that does not exist is no target either.
    expect(fastRoute('告诉项目「不存在的项目」做事', facts)).toMatchObject({ outcome: 'escalate' })
    // Without any Project, a name is just a word.
    expect(fastRoute('告诉项目「周报整理」做事', { tickets: [], projects: [] }))
      .toMatchObject({ outcome: 'escalate', reason: 'needs_model' })
  })

  it('reads a message without a target as a question or a conversation, never as work', () => {
    expect(fastRoute('帮我总结一下这个项目', facts)).toMatchObject({ outcome: 'escalate', reason: 'needs_model' })
    expect(fastRoute('谢谢', facts)).toMatchObject({ outcome: 'ordinary_reply' })
    expect(fastRoute('   ', facts)).toMatchObject({ outcome: 'ordinary_reply', reason: 'empty_message' })
  })

  it('never reads a quoted command as an order, and never reads a name inside a quotation as a target', () => {
    // The quoted words are data: the instruction inside them is not the person's own order, so nothing is dispatched.
    expect(fastRoute('把「继续工单 aaaaaaaabbbbccccddddeeeeffff0000」这句话发给我', facts))
      .toMatchObject({ outcome: 'escalate', reason: 'ambiguous_target' })
    // A Project that is only talked about is not a target either.
    expect(fastRoute('「周报整理」这个项目最近怎么样', facts))
      .toMatchObject({ outcome: 'escalate', reason: 'ambiguous_target' })
  })

  it('keeps a quoted file content in the task exactly as it was written', () => {
    const decision = fastRoute('创建一个独立工单，写入「hello world」', facts)
    expect(decision).toMatchObject({ outcome: 'standalone_ticket', reason: 'standalone_task' })
    expect(decision.goal).toContain('「hello world」')
  })
})

describe('the fast router of the control plane', () => {
  it('carries an independent task out itself, without a Router turn', async () => {
    await open()
    const answer = await send('创建一个隔离的示例文件，写入 hello')
    expect(answer.routing).toMatchObject({ outcome: 'standalone_ticket', stage: 'queued', reason: 'standalone_task' })

    // The Router never read the message: no model turn started. Its Session is there — the Worker of a Ticket the Router
    // owns reports back to it — but nothing was delivered to it.
    expect(node.commands.some(command => command.type === 'session.message' && command.sessionId === 'router')).toBe(false)
    expect(node.commands.filter(command => command.type === 'router.ensure')).toHaveLength(1)
    // The message is not in the Router's queue either: it never waited for a turn, and the receipt shows it once.
    const state = (await (await get('/v1/console/router')).json()) as { queue?: unknown[] }
    expect(state.queue ?? []).toEqual([])

    // The Ticket is the Router's own, and its Worker was asked to start.
    const tickets = control!.tickets()
    expect(tickets).toHaveLength(1)
    expect(tickets[0]!.projectId).toBeUndefined()
    const worker = workerOf(tickets[0]!.id)
    await vi.waitFor(() => expect(control!.session(worker)?.status).toBe('idle'))

    // The console shows the target and the real state of the Worker.
    await vi.waitFor(async () => expect((await routes())[0]?.stage).toBe('assigned'), { timeout: 5000 })
    const shown = await routes()
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ outcome: 'standalone_ticket', stage: 'assigned', ticketId: tickets[0]!.id,
      sessionId: worker, sessionStatus: 'idle' })
  })

  it('continues a Ticket of its own when the message names it', async () => {
    await open()
    const first = await send('创建一个隔离的示例文件，写入 hello')
    const ticketId = first.routing!.ticketId!
    const worker = workerOf(ticketId)
    await vi.waitFor(() => expect(control!.session(worker)?.status).toBe('idle'))
    // The Assignment runs, so a message for that Ticket reaches a Worker that is there.
    await vi.waitFor(() => expect(control!.tickets().find(item => item.id === ticketId)!.assignments[0]!.state)
      .toBe('running'))

    const answer = await send(`继续工单 ${ticketId}`)
    expect(answer.routing).toMatchObject({ outcome: 'existing_ticket', stage: 'assigned', ticketId })
    expect(messagesOf(worker).some(text => text.includes(`继续工单 ${ticketId}`))).toBe(true)
    // The Router's own conversation is untouched by a continuation.
    expect(messagesOf('router')).toEqual([])
  })

  it('brings the Worker\'s report back to its own Ticket and to the Router', async () => {
    await open()
    const first = await send('创建一个隔离的示例文件，写入 hello')
    const ticketId = first.routing!.ticketId!
    const ticket = control!.tickets().find(item => item.id === ticketId)!
    const assignmentId = ticket.assignments[0]!.id
    const worker = `worker-${assignmentId}`
    await vi.waitFor(() => expect(control!.session(worker)?.status).toBe('idle'))
    await vi.waitFor(() => expect(control!.tickets().find(item => item.id === ticketId)!.assignments[0]!.state)
      .toBe('running'))

    // The Worker reports its result: the report belongs to the Ticket it worked on.
    const reported = await post('/v1/tools/worker/report', { ticketId, assignmentId,
      report: { state: 'ready', summary: '独立结果 42' }, callKey: 'ready-call' }, node.tokens.get(worker)!)
    expect(reported.status).toBe(200)
    expect(control!.tickets().find(item => item.id === ticketId)?.ended?.outcome).toBe('completed')
    // And it comes back to the Router, which tells the person about it.
    await vi.waitFor(() => expect(messagesOf('router').some(text => text.includes('独立结果 42'))).toBe(true))
  })

  it('hands an instruction to the PM of the one Project it names', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    const answer = await send('告诉项目「周报整理」把登录改成 SSO')
    expect(answer.routing).toMatchObject({ outcome: 'existing_project_pm', stage: 'assigned', sessionId: pmSessionId,
      target: { kind: 'project', id: projectId, title: '周报整理' } })

    // The PM received the instruction, and only the instruction.
    const received = messagesOf(pmSessionId)
    expect(received).toHaveLength(1)
    expect(received[0]).toContain('把登录改成 SSO')
    // The Router never read it, so no conversation was needed at all.
    expect(node.commands.some(command => command.type === 'session.message' && command.sessionId === 'router')).toBe(false)
  })

  it('gives every Project its own instruction and never the other one', async () => {
    await open()
    const weekly = await projectWithPm('周报')
    const monthly = await projectWithPm('月报')
    await send('告诉项目「月报」把登录改成 SSO')
    expect(messagesOf(monthly.pmSessionId).some(text => text.includes('把登录改成 SSO'))).toBe(true)
    expect(messagesOf(weekly.pmSessionId)).toEqual([])
  })

  it('leaves an ambiguous message to the high-level Router and to nobody else', async () => {
    await open()
    const weekly = await projectWithPm('周报')
    const monthly = await projectWithPm('月报')
    const answer = await send('同时告诉项目「周报」和项目「月报」把登录改成 SSO')
    expect(answer.routing).toBeUndefined()
    expect(messagesOf(weekly.pmSessionId)).toEqual([])
    expect(messagesOf(monthly.pmSessionId)).toEqual([])
    // The conversation is kept: the model reads the message and the authoritative state.
    expect(messagesOf('router').some(text => text.includes('把登录改成 SSO'))).toBe(true)
    const shown = await routes()
    expect(shown.at(-1)).toMatchObject({ outcome: 'escalate', reason: 'multiple_targets' })
  })

  it('keeps an ordinary question in the conversation and out of the work', async () => {
    await open()
    const answer = await send('现在有什么在跑？')
    expect(answer.routing).toBeUndefined()
    expect(answer.sent).toBe(true)
    expect(messagesOf('router').some(text => text.includes('现在有什么在跑？'))).toBe(true)
    expect(control!.tickets()).toEqual([])
    expect(control!.projects()).toEqual([])
  })

  it('never creates a Project of its own', async () => {
    await open()
    const answer = await send('创建一个独立的项目')
    expect(answer.routing).toBeUndefined()
    expect(control!.projects()).toEqual([])
    expect(control!.tickets()).toEqual([])
  })

  it('never revives a Ticket that has ended', async () => {
    await open()
    const first = await send('创建一个隔离的示例文件，写入 hello')
    const ticketId = first.routing!.ticketId!
    const worker = workerOf(ticketId)
    await vi.waitFor(() => expect(control!.session(worker)?.status).toBe('idle'))

    const cleanups: { ticketId: string; work: Promise<void> }[] = []
    control!.engine.stopTicket(ticketId, '结束', cleanups)
    await Promise.all(cleanups.map(cleanup => cleanup.work))

    const answer = await send(`继续工单 ${ticketId}`)
    expect(answer.routing).toBeUndefined()
    const ticket = control!.tickets().find(item => item.id === ticketId)!
    expect(ticket.ended).toBeDefined()
    expect(ticket.assignments).toHaveLength(1)
    const shown = await routes()
    expect(shown.at(-1)).toMatchObject({ outcome: 'escalate', reason: 'ticket_ended' })
  })

  it('does not hand an instruction to a Project that is over', async () => {
    await open()
    const stopped = await projectWithPm('周报整理')
    await post(`/v1/console/projects/${stopped.projectId}/stop`, { reason: '做完了' })
    const answer = await send('告诉项目「周报整理」把登录改成 SSO')
    expect(answer.routing).toBeUndefined()
    expect(messagesOf(stopped.pmSessionId)).toEqual([])
    const shown = await routes()
    expect(shown.at(-1)).toMatchObject({ outcome: 'escalate', reason: 'project_unavailable' })
  })

  it('does not report a delivery the node refused, and does not hand the message to the model', async () => {
    await open()
    const { pmSessionId } = await projectWithPm('周报整理')
    node.messageFailures.set(pmSessionId, new Error('the node refused the message'))
    const answer = await send('告诉项目「周报整理」把登录改成 SSO')
    // The receipt says what really happened, and the message stops there: the model would read the same words and
    // deliver them a second time.
    expect(answer.routing).toMatchObject({ outcome: 'existing_project_pm', stage: 'failed' })
    expect(messagesOf(pmSessionId)).toEqual([])
    expect(messagesOf('router')).toEqual([])
    const shown = await routes()
    expect(shown.at(-1)).toMatchObject({ outcome: 'existing_project_pm', stage: 'failed' })
    expect(shown.at(-1)!.error).toContain('refused the message')
  })

  it('does not hand a message nobody confirmed to the model, and does not try it again', async () => {
    await open()
    const { pmSessionId } = await projectWithPm('周报整理')
    node.messageFailures.set(pmSessionId, new NodeUnconfirmedError('the node did not answer the message'))
    const id = '11111111-2222-4333-8444-888888888888'
    const answer = await send('告诉项目「周报整理」把登录改成 SSO', id)
    // A missing receipt is not a refusal and not a delivery: the routing says so, and it is not repeated.
    expect(answer.routing).toMatchObject({ outcome: 'existing_project_pm', stage: 'unconfirmed' })
    expect(messagesOf(pmSessionId)).toEqual([])
    expect(messagesOf('router')).toEqual([])

    const again = await send('告诉项目「周报整理」把登录改成 SSO', id)
    expect(again.routing).toMatchObject({ outcome: 'existing_project_pm', stage: 'unconfirmed' })
    expect(messagesOf('router')).toEqual([])
  })

  it('does not hand an instruction to a PM that may not be used', async () => {
    await open()
    const revoked = await projectWithPm('月报')
    await post(`/v1/console/sessions/${revoked.pmSessionId}/revoke`, { reason: '换人' })
    const answer = await send('告诉项目「月报」把登录改成 SSO')
    expect(answer.routing).toMatchObject({ outcome: 'existing_project_pm', stage: 'failed' })
    expect(messagesOf(revoked.pmSessionId)).toEqual([])
    // The delivery was already tried, so the message does not go to the Router either.
    expect(messagesOf('router')).toEqual([])
  })

  it('answers a question about a thing named by its id from the record alone', async () => {
    await open()
    const first = await send('创建一个隔离的示例文件，写入 hello')
    const ticketId = first.routing!.ticketId!
    await vi.waitFor(() => expect(control!.session(workerOf(ticketId))?.status).toBe('idle'))

    const answer = await send(`工单 ${ticketId} 现在什么状态？`)
    expect(answer.routing).toMatchObject({ outcome: 'read_only', stage: 'assigned' })
    expect(answer.routing!.answer).toContain(ticketId)
    // No model turn and no dispatch: the record answered the question.
    expect(node.commands.some(command => command.type === 'session.message' && command.sessionId === 'router')).toBe(false)
    expect(messagesOf('router')).toEqual([])
    expect(control!.tickets()).toHaveLength(1)
  })

  it('never carries out a fast route behind a stopped Router', async () => {
    await open()
    // The Router Session has to be there before it can be stopped: a fast-routed task ensures it.
    const first = await send('创建一个隔离的示例文件，写入 hello')
    const ticketId = first.routing!.ticketId!
    await vi.waitFor(() => expect(control!.session(workerOf(ticketId))?.status).toBe('idle'))
    const stopped = await post('/v1/console/sessions/router/cancel', { reason: '先停一下' })
    expect(stopped.status).toBe(200)

    // The Router takes no message, and the fast route is not a way around it: the same refusal the conversation gives.
    const refused = await post('/v1/console/router/message', { text: '创建一个隔离的示例文件，写入 bye' })
    expect(refused.status).toBe(409)
    expect(control!.tickets()).toHaveLength(1)
    expect(messagesOf('router')).toEqual([])
  })

  it('holds a fast route that is waiting in the queue while the Router is stopped', async () => {
    await open()
    await send('第一条消息')
    node.holdTurn('router')
    await send('创建一个隔离的示例文件，写入 hello')
    await post('/v1/console/sessions/router/cancel', { reason: '先停一下' })
    node.releaseTurn('router')
    await vi.waitFor(async () => {
      const state = (await (await get('/v1/console/router')).json()) as { queue?: { error?: string }[] }
      expect(state.queue?.some(entry => entry.error?.includes('stopped by an operator'))).toBe(true)
    }, { timeout: 5000 })
    // The fast route is still only a claim: nothing was dispatched behind the operator's back.
    expect(control!.tickets()).toEqual([])
    expect((await routes()).at(-1)).toMatchObject({ outcome: 'standalone_ticket', stage: 'accepted' })
  })

  it('keeps the queue in order while the Router is busy, and never lets a later task overtake an earlier one', async () => {
    await open()
    await send('第一条消息')
    node.holdTurn('router')
    await send('第二条消息')
    await send('创建一个隔离的示例文件，写入 hello')
    // The fast route waits behind the message that was written first: nothing was dispatched.
    expect(control!.tickets()).toEqual([])

    node.releaseTurn('router')
    await vi.waitFor(() => expect(control!.tickets()).toHaveLength(1), { timeout: 5000 })
    // The earlier message reached the Router first.
    const received = messagesOf('router')
    expect(received.some(text => text.includes('第二条消息'))).toBe(true)
  })

  it('carries one message out once, however often the browser repeats it', async () => {
    await open()
    const id = '11111111-2222-4333-8444-555555555555'
    const [first, second] = await Promise.all([
      post('/v1/console/router/message', { id, text: '创建一个隔离的示例文件，写入 hello' }),
      post('/v1/console/router/message', { id, text: '创建一个隔离的示例文件，写入 hello' }),
    ])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(control!.tickets()).toHaveLength(1)
    expect(await routes()).toHaveLength(1)
  })

  it('refuses the same message id under other words', async () => {
    await open()
    const id = '11111111-2222-4333-8444-666666666666'
    expect((await post('/v1/console/router/message', { id, text: '创建一个隔离的示例文件，写入 hello' })).status).toBe(200)
    const other = await post('/v1/console/router/message', { id, text: '创建一个隔离的示例文件，写入 bye' })
    expect(other.status).toBe(409)
    expect(control!.tickets()).toHaveLength(1)
  })

  it('does not create a second Ticket after a restart', async () => {
    await open()
    const id = '11111111-2222-4333-8444-777777777777'
    const first = await send('创建一个隔离的示例文件，写入 hello', id)
    const ticketId = first.routing!.ticketId!
    expect(control!.tickets()).toHaveLength(1)

    await reopen()

    const again = await send('创建一个隔离的示例文件，写入 hello', id)
    expect(again.routing).toMatchObject({ outcome: 'standalone_ticket', ticketId })
    expect(control!.tickets()).toHaveLength(1)
    expect(await routes()).toHaveLength(1)
  })

  it('keeps the Router queue in order, whether the Router is idle or busy', async () => {
    await open()
    await send('第一条消息')
    await send('第二条消息')
    const idle = messagesOf('router')
    expect(idle.some(text => text.includes('第一条消息'))).toBe(true)
    expect(idle.findIndex(text => text.includes('第一条消息')))
      .toBeLessThan(idle.findIndex(text => text.includes('第二条消息')))

    node.holdTurn('router')
    await send('第三条消息')
    await send('第四条消息')
    // A busy Router keeps both messages: they wait for the turn that follows the one that runs.
    expect(messagesOf('router')).toHaveLength(2)
    node.releaseTurn('router')
    await vi.waitFor(() => expect(messagesOf('router')).toHaveLength(4), { timeout: 5000 })
    const busy = messagesOf('router')
    expect(busy.findIndex(text => text.includes('第三条消息')))
      .toBeLessThan(busy.findIndex(text => text.includes('第四条消息')))
  })

  it('keeps a message with files in the conversation, where the files are', async () => {
    await open()
    const response = await post('/v1/console/router/message', { text: '创建一个隔离的示例文件', attachments: [
      { name: 'work/说明.txt', text: '说明内容' }] })
    expect(response.status).toBe(200)
    const answer = await response.json() as { routing?: Receipt }
    expect(answer.routing).toBeUndefined()
    expect(messagesOf('router').some(text => text.includes('说明内容'))).toBe(true)
    expect(control!.tickets()).toEqual([])
  })

  it('costs no high-level turn where the old path costs one', async () => {
    await open()
    /** The messages that only a conversation with the Router needs: one model turn each. */
    const turns = (): number => node.commands.filter(command => command.type === 'session.message'
      && command.sessionId === 'router').length

    await send('创建一个隔离的示例文件，写入 hello')
    const fast = turns()
    await send('现在有什么在跑？')
    const slow = turns()
    // The obvious request costs no Router turn at all; the conversation costs the one it always cost.
    expect(fast).toBe(0)
    expect(slow).toBeGreaterThan(fast)
  })
})
