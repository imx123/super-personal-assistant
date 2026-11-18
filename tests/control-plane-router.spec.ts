/**
 * The Router: the console's own conversation with a real Agent on the node.
 *
 * The Router is a Session of its own — one that belongs to no Project, has a workspace of its own and a token of its own.
 * It comes up with the first message a person sends, so nobody has to go to another page first; it keeps that Session
 * across messages, and a reconnecting node gets the same Session id again instead of a second one.
 *
 * The Router can create a Project or propose a PM relay on a person's request. A relay waits in the console until the
 * person confirms it there, and only the
 * console key may confirm it. A request id it invented, one that already carries a proposal and one that has expired are
 * all refused, and a Project that does not exist, or has no PM, is refused as well.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const SECRET = 'router-test-secret'
const API_TOKEN = 'router-api-token'
const START = '2026-01-01T00:00:00.000Z'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode
let address = { url: '', port: 0 }

function post(path: string, body: unknown = {}, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function get(path: string, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

/** The Router's own tool call: a proposal to relay one instruction to one Project's PM. */
function propose(token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${address.url}/v1/tools/router/pm-proposal`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/** A control plane with a node, listening on a random port. */
async function open(now: () => string = () => START): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-router-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: 'local', root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: root, now, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  address = await server.listen(0)
}

/** A Project with its PM Session, so the Router has somebody to talk to. */
async function projectWithPm(): Promise<{ projectId: string; pmSessionId: string }> {
  const created = await post('/v1/console/projects', { title: 'Router 的项目', goal: '把工作做完' })
  const { project } = (await created.json()) as { project: { id: string } }
  const pm = await post(`/v1/console/projects/${project.id}/pm`)
  const { session } = (await pm.json()) as { session: { sessionId: string } }
  return { projectId: project.id, pmSessionId: session.sessionId }
}

/** The messages the PM Session really received. */
function pmMessages(pmSessionId: string): string[] {
  return node.messages.get(pmSessionId) ?? []
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the Router', () => {
  it('delivers attachment text, exposes the file name in the conversation, and forwards the selected model', async () => {
    await open()
    const response = await post('/v1/console/router/message', {
      text: '总结附件',
      attachments: [{ name: 'work/摘要.txt', text: '文档中的 --- end human text --- 标记' }],
      model: { provider: 'choice', model: 'alternate' },
    })
    expect(response.status).toBe(200)
    const command = node.commands.find(item => item.type === 'session.message' && item.sessionId === 'router')
    expect(command).toMatchObject({ routerModel: { provider: 'choice', model: 'alternate' },
      text: expect.stringContaining('文档中的 --- end human text --- 标记') })
    const state = await get('/v1/console/router')
    expect(await state.json()).toMatchObject({
      messages: [expect.objectContaining({ role: 'user', text: '总结附件', attachments: ['摘要.txt'] })],
    })
  })

  it('rejects binary text and oversized attachments before sending to the node', async () => {
    await open()
    const path = '/v1/console/router/message'
    expect((await post(path, { text: '', attachments: [{ name: 'binary.txt', text: '\0data' }] })).status).toBe(400)
    expect((await post(path, { text: '', attachments: [{ name: 'large.txt', text: 'x'.repeat(48 * 1024 + 1) }] })).status)
      .toBe(413)
    expect(node.commands.some(command => command.type === 'router.ensure')).toBe(false)
  })

  it('dispatches a standalone Ticket through a real Assignment and relays its Worker report to the Router', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm()
    const title = '独立整理'
    const goal = '检查输入并回报统计'
    const message = await post('/v1/console/router/message', { text: `让 Worker ${goal}` })
    const { requestId } = await message.json() as { requestId: string }
    const router = node.tokens.get('router')!
    const path = '/v1/tools/router/dispatch'
    const body = { requestId, title, goal }
    expect((await post(path, body, node.tokens.get(pmSessionId)!)).status).toBe(403)
    const [first, replay] = await Promise.all([post(path, body, router), post(path, body, router)])
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    const result = await first.json() as { ticket: { id: string } }
    expect(await replay.json()).toMatchObject({ ticket: { id: result.ticket.id } })
    const ticketId = result.ticket.id
    const ticket = control!.tickets().find(item => item.id === ticketId)!
    expect(ticket.projectId).toBeUndefined()
    expect(control!.projects().map(project => project.id)).toEqual([projectId])
    const assignmentId = ticket.assignments[0]!.id
    const workerSessionId = `worker-${assignmentId}`
    await vi.waitFor(() => expect(control!.session(workerSessionId)?.status).toBe('idle'))
    const launches = node.commands.filter(command => command.type === 'worker.create')
    expect(launches).toHaveLength(1)
    expect(launches[0]).toMatchObject({ assignmentId, ticketId, prompt: expect.stringContaining(goal) })
    expect((await post(path, { ...body, title: '重复的另一张工单' }, router)).status).toBe(400)
    expect((await post('/v1/tools/router/projects', body, router)).status).toBe(400)
    const worker = node.tokens.get(workerSessionId)!
    expect((await post('/v1/tools/worker/report', { ticketId: 'wrong-ticket', assignmentId,
      report: { state: 'ready', summary: '拒收' } }, worker)).status).toBe(400)
    const response = await post('/v1/tools/worker/report', { ticketId, assignmentId,
      report: { state: 'ready', summary: '独立结果 42' }, callKey: 'ready-call' }, worker)
    expect(response.status).toBe(200)
    expect(control!.tickets().find(item => item.id === ticketId)?.ended?.outcome).toBe('completed')
    await vi.waitFor(() => expect(node.messages.get('router')).toEqual(expect.arrayContaining([
      expect.stringContaining('独立结果 42'),
    ])))
    expect(pmMessages(pmSessionId).join('\n')).not.toContain('独立结果 42')
    const summary = await get('/v1/tools/router/summary', router)
    expect(await summary.json()).toMatchObject({ standaloneTickets: [{ id: ticketId, status: 'completed' }] })
  })

  it('manages a standalone Ticket without granting its Router authority over a PM Ticket', async () => {
    await open()
    const { pmSessionId } = await projectWithPm()
    const [projectTicket] = control!.pmCreateTickets(pmSessionId, [{ title: '项目工作', goal: '项目范围内的工作' }])
    const ask = async (text: string): Promise<string> => {
      const response = await post('/v1/console/router/message', { text })
      return (await response.json() as { requestId: string }).requestId
    }
    const requestId = await ask('让独立 Worker 做一个核对')
    const token = node.tokens.get('router')!
    const made = await post('/v1/tools/router/dispatch', { requestId, title: '核对', goal: '核对数据' }, token)
    const { ticket } = await made.json() as { ticket: { id: string } }
    const path = '/v1/tools/router/manage'
    const foreign = await post(path, { requestId: await ask('停止项目里的 Worker'),
      action: 'stop_ticket', targetId: projectTicket!.id }, token)
    expect(foreign.status).toBe(400)
    const own = await post(path, { requestId: await ask('停止核对'),
      action: 'stop_ticket', targetId: ticket.id }, token)
    expect(own.status).toBe(200)
    expect(await own.json()).toMatchObject({ stopped: true, ticket: { id: ticket.id, status: 'stopped' } })
    expect(control!.tickets().find(item => item.id === projectTicket!.id)?.ended).toBeUndefined()
  })

  it('relays one Project summary from its PM and keeps it visible in the Router summary', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm()
    const summary = '第一阶段已验收'
    const token = node.tokens.get(pmSessionId)!
    const report = () => post('/v1/tools/pm/project-report', { summary }, token)
    const [first, replay] = await Promise.all([report(), report()])
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(await first.json())
    await vi.waitFor(() => expect(node.messages.get('router')?.filter(text =>
      text.startsWith('[superagent: project report]'))).toHaveLength(1))
    const router = node.tokens.get('router')!
    expect((await post('/v1/tools/pm/project-report', { summary }, router)).status).toBe(403)
    const state = await get('/v1/tools/router/summary', router)
    expect(await state.json()).toMatchObject({ projects: [{ id: projectId, latestReport: { summary } }] })
  })

  it('creates one Project from a human request and returns the same Project on a concurrent replay', async () => {
    await open()
    const title = '周报整理'
    const goal = '汇总本周的工作进展'
    const message = await post('/v1/console/router/message', { text: `创建项目「${title}」，目标是${goal}` })
    const { requestId } = await message.json() as { requestId: string }
    const token = node.tokens.get('router')!
    const path = '/v1/tools/router/projects'
    expect((await post(path, { requestId: 'unknown', title, goal }, token)).status).toBe(400)
    expect((await post(path, { requestId, title, goal })).status).toBe(401)
    const responses = await Promise.all([
      post(path, { requestId, title, goal }, token),
      post(path, { requestId, title, goal }, token),
    ])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    const [made, replayed] = await Promise.all(responses.map(response => response.json())) as {
      project: { id: string; title: string; goal: string }
    }[]
    expect(made).toEqual(replayed)
    expect(control!.projects()).toMatchObject([made!.project])
    expect(control!.tickets()).toEqual([])
    expect(made).toMatchObject({ pm: { status: 'idle' } })
    expect(node.commands.filter(command => command.type === 'pm.ensure')).toHaveLength(1)
    expect((await post(path, { requestId, title: '另一个项目', goal }, token)).status).toBe(400)
    await control!.archiveProject(made!.project.id)
    const archivedReplay = await post(path, { requestId, title, goal }, token)
    expect(await archivedReplay.json()).toMatchObject({
      project: { id: made!.project.id },
      pm: { status: 'unconfirmed', error: expect.stringContaining('archived') },
    })
    expect(node.commands.filter(command => command.type === 'pm.ensure')).toHaveLength(1)
  })

  it('comes up with the first message and keeps the same Session afterwards', async () => {
    await open()
    const before = await get('/v1/console/router')
    expect(before.status).toBe(200)
    const empty = (await before.json()) as { session?: { sessionId: string }; messages: unknown[] }
    expect(empty.session).toBeUndefined()
    expect(empty.messages).toEqual([])

    const sent = await post('/v1/console/router/message', { text: '现在有什么在跑？' })
    expect(sent.status).toBe(200)
    const answer = (await sent.json()) as { sent: boolean; requestId: string }
    expect(answer.sent).toBe(true)
    expect(answer.requestId).toMatch(/^router-req-[0-9a-f-]{36}$/)

    // The node holds the Router as a Session of its own, and the control plane records it.
    expect(node.sessions.get('router')?.role).toBe('router')
    expect(control!.session('router')?.role).toBe('router')
    // The Router belongs to no Project and works in a workspace of its own.
    expect(control!.session('router')?.workspace.endsWith('router')).toBe(true)
    expect(control!.session('router')?.projectId).toBe('router')

    // A second message reuses that Session: the node is asked for it once.
    await post('/v1/console/router/message', { text: '还有别的吗？' })
    const ensures = node.commands.filter(command => command.type === 'router.ensure')
    expect(ensures).toHaveLength(1)
  })

  it('shows the conversation the node really reported, without repeating the person\'s own words', async () => {
    await open()
    await post('/v1/console/router/message', { text: '现在有什么在跑？' })

    // The node reports the person's message and the model's answer as message events.
    node.simulateMessage('router', 'assistant', '有一个 Worker 正在执行一个工单。')

    const state = (await (await get('/v1/console/router')).json()) as {
      messages: { role: string; text: string; requestId?: string }[]
    }
    expect(state.messages).toHaveLength(2)
    // The person's own words, not the envelope the Router received.
    expect(state.messages[0]).toMatchObject({ role: 'user', text: '现在有什么在跑？' })
    expect(state.messages[0]!.requestId).toMatch(/^router-req-[0-9a-f-]{36}$/)
    expect(state.messages[1]).toMatchObject({ role: 'assistant', text: '有一个 Worker 正在执行一个工单。' })
  })

  it('gives the Router its own tools and nothing else', async () => {
    await open()
    await post('/v1/console/router/message', { text: '现在有什么在跑？' })
    const token = node.tokens.get('router')!

    // The Router reads the running state with its own token.
    const summary = await get('/v1/tools/router/summary', token)
    expect(summary.status).toBe(200)
    const facts = (await summary.json()) as { projects: unknown[]; counts: { projects: number } }
    expect(facts.counts.projects).toBe(0)

    // The Router's token opens neither the PM's tools nor the worker's.
    expect((await get('/v1/tools/pm/context', token)).status).toBe(403)
    // Nor the operator's routes.
    expect((await get('/v1/console/projects', token)).status).toBe(401)
  })

  it('proposes instead of delivering: nothing reaches the PM until a person confirms it', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm()
    await post('/v1/console/router/message', { text: '告诉这个项目的 PM 先做第二步' })
    const { requestId } = (await (await post('/v1/console/router/message',
      { text: '再补充一句：注意别动数据库' })).json()) as { requestId: string }
    const token = node.tokens.get('router')!

    const proposed = await propose(token, { requestId, projectId, instruction: '先做第二步' })
    expect(proposed.status).toBe(200)
    const body = (await proposed.json()) as { status: string; proposalId: string; projectId: string
      projectTitle: string; instruction: string }
    expect(body.status).toBe('pending')
    expect(body.proposalId).toMatch(/^router-prop-[0-9a-f-]{36}$/)
    expect(body.projectId).toBe(projectId)
    expect(body.instruction).toBe('先做第二步')

    // Nothing was delivered: the PM has not heard of it.
    expect(pmMessages(pmSessionId)).toEqual([])

    // The console shows the proposal, with the text that would really be sent.
    const state = (await (await get('/v1/console/router')).json()) as {
      proposal?: { id: string; projectId: string; instruction: string }
    }
    expect(state.proposal?.id).toBe(body.proposalId)
    expect(state.proposal?.instruction).toBe('先做第二步')

    // The Router's own token may not confirm it: only a person with the console key may.
    const confirmed = await fetch(`${address.url}/v1/console/router/proposal/${body.proposalId}/confirm`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}' })
    expect(confirmed.status).toBe(401)
    expect(pmMessages(pmSessionId)).toEqual([])

    // The person confirms it, and only then does the PM hear about it.
    const sent = await post(`/v1/console/router/proposal/${body.proposalId}/confirm`)
    expect(sent.status).toBe(200)
    const answer = (await sent.json()) as { delivered: boolean }
    expect(answer.delivered).toBe(true)
    expect(pmMessages(pmSessionId).some(text => text.includes('先做第二步'))).toBe(true)
  })

  it('refuses a second proposal for the same request, an unknown request id and an invented one', async () => {
    await open()
    const { projectId } = await projectWithPm()
    await post('/v1/console/router/message', { text: '告诉这个项目的 PM 一句话' })
    const { requestId } = (await (await post('/v1/console/router/message',
      { text: '再补充一句' })).json()) as { requestId: string }
    const token = node.tokens.get('router')!

    // A Project that does not exist is refused, and the request stays open: nothing was proposed.
    const elsewhere = await propose(token, { requestId, projectId: 'no-such-project', instruction: '做点什么' })
    expect(elsewhere.status).toBe(400)

    expect((await propose(token, { requestId, projectId, instruction: '做点什么' })).status).toBe(200)
    // One request carries at most one proposal.
    expect((await propose(token, { requestId, projectId, instruction: '再来一次' })).status).toBe(400)

    // A request id nobody made is refused, and so is one that was never a request at all.
    const unknown = await propose(token, { requestId: 'router-req-9999', projectId, instruction: '做点什么' })
    expect(unknown.status).toBe(400)
    const invented = await propose(token, { requestId: 'not-a-request', projectId, instruction: '做点什么' })
    expect(invented.status).toBe(400)
  })

  it('refuses a proposal for a Project that is over', async () => {
    await open()
    const { projectId } = await projectWithPm()
    await post('/v1/console/router/message', { text: '告诉这个项目的 PM 一句话' })
    const { requestId } = (await (await post('/v1/console/router/message',
      { text: '再补充一句' })).json()) as { requestId: string }
    const token = node.tokens.get('router')!

    await post(`/v1/console/projects/${projectId}/stop`, { reason: '做完了' })
    const proposed = await propose(token, { requestId, projectId, instruction: '再做一点' })
    expect(proposed.status).toBe(400)
  })

  it('refuses a proposal whose Project lost its PM between the proposal and the confirmation', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm()
    await post('/v1/console/router/message', { text: '告诉这个项目的 PM 一句话' })
    const { requestId } = (await (await post('/v1/console/router/message',
      { text: '再补充一句' })).json()) as { requestId: string }
    const token = node.tokens.get('router')!

    const proposed = await propose(token, { requestId, projectId, instruction: '做点什么' })
    const { proposalId } = (await proposed.json()) as { proposalId: string }

    // The PM Session's authority is taken away before the person confirms.
    expect((await post(`/v1/console/sessions/${pmSessionId}/revoke`, { reason: '换人' })).status).toBe(200)

    const confirmed = await post(`/v1/console/router/proposal/${proposalId}/confirm`)
    expect(confirmed.status).toBe(400)
    expect(pmMessages(pmSessionId)).toEqual([])
  })

  it('sends the instruction only once: a second confirmation is refused, and a cancel sends nothing', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm()
    await post('/v1/console/router/message', { text: '告诉这个项目的 PM 一句话' })
    const { requestId } = (await (await post('/v1/console/router/message',
      { text: '再补充一句' })).json()) as { requestId: string }
    const token = node.tokens.get('router')!

    const first = await propose(token, { requestId, projectId, instruction: '做点什么' })
    const { proposalId } = (await first.json()) as { proposalId: string }
    expect((await post(`/v1/console/router/proposal/${proposalId}/confirm`)).status).toBe(200)
    expect(pmMessages(pmSessionId)).toHaveLength(1)

    // The instruction was really sent: a second confirmation cannot send it again.
    const again = await post(`/v1/console/router/proposal/${proposalId}/confirm`)
    expect(again.status).toBe(409)
    expect(pmMessages(pmSessionId)).toHaveLength(1)

    // A cancelled proposal sends nothing at all.
    const second = (await (await post('/v1/console/router/message', { text: '还有一条' })).json()) as { requestId: string }
    const cancelled = await propose(token, { requestId: second.requestId, projectId, instruction: '别发' })
    const { proposalId: cancelledId } = (await cancelled.json()) as { proposalId: string }
    expect((await post(`/v1/console/router/proposal/${cancelledId}/cancel`)).status).toBe(200)
    expect(pmMessages(pmSessionId)).toHaveLength(1)
    // A cancelled proposal cannot be confirmed afterwards either.
    expect((await post(`/v1/console/router/proposal/${cancelledId}/confirm`)).status).toBe(409)
    expect(pmMessages(pmSessionId)).toHaveLength(1)
  })

  it('delivers once when two confirmations arrive at the same time', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm()
    await post('/v1/console/router/message', { text: '告诉这个项目的 PM 一句话' })
    const { requestId } = (await (await post('/v1/console/router/message',
      { text: '再补充一句' })).json()) as { requestId: string }
    const token = node.tokens.get('router')!

    const proposed = await propose(token, { requestId, projectId, instruction: '只发一次' })
    const { proposalId } = (await proposed.json()) as { proposalId: string }

    const [first, second] = await Promise.all([
      post(`/v1/console/router/proposal/${proposalId}/confirm`),
      post(`/v1/console/router/proposal/${proposalId}/confirm`),
    ])
    const statuses = [first.status, second.status].sort((a, b) => a - b)
    // Exactly one confirmation carries the instruction; the other is refused.
    expect(statuses).toEqual([200, 409])
    expect(pmMessages(pmSessionId)).toHaveLength(1)
  })

  it('lets a proposal expire instead of delivering it later', async () => {
    let clock = Date.parse(START)
    await open(() => new Date(clock).toISOString())
    const { projectId, pmSessionId } = await projectWithPm()
    await post('/v1/console/router/message', { text: '告诉这个项目的 PM 一句话' })
    const { requestId } = (await (await post('/v1/console/router/message',
      { text: '再补充一句' })).json()) as { requestId: string }
    const token = node.tokens.get('router')!

    const proposed = await propose(token, { requestId, projectId, instruction: '过期了' })
    const { proposalId } = (await proposed.json()) as { proposalId: string }

    // Half an hour later the proposal may no longer be confirmed.
    clock += 30 * 60 * 1000
    const confirmed = await post(`/v1/console/router/proposal/${proposalId}/confirm`)
    expect(confirmed.status).toBe(409)
    expect(pmMessages(pmSessionId)).toEqual([])
  })

  it('keeps a plain conversation free of side effects, and restores it after a restart', async () => {
    await open()
    const { pmSessionId } = await projectWithPm()
    await post('/v1/console/router/message', { text: '现在有什么在跑？' })
    node.simulateMessage('router', 'assistant', '有一个 Worker 正在执行一个工单。')

    // An ordinary question proposes nothing and delivers nothing.
    const state = (await (await get('/v1/console/router')).json()) as { proposal?: unknown; messages: unknown[] }
    expect(state.proposal).toBeUndefined()
    expect(pmMessages(pmSessionId)).toEqual([])

    // A restart keeps the conversation — it lives in the event log — but no proposal survives it.
    await server?.close()
    server = undefined
    await control?.close()
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
      workspaceRoot: join(directory, 'workspaces'), now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    address = await server.listen(0)

    const restored = (await (await get('/v1/console/router')).json()) as { proposal?: unknown; messages: unknown[] }
    expect(restored.messages.length).toBeGreaterThan(0)
    expect(restored.proposal).toBeUndefined()
  })

  it('refuses a message with no text and keeps the Router out of the reconciliation', async () => {
    await open()
    expect((await post('/v1/console/router/message', { text: '   ' })).status).toBe(400)

    await post('/v1/console/router/message', { text: '你好' })
    const run = await post('/v1/console/reconcile/run')
    expect(run.status).toBe(200)
    const { result } = (await run.json()) as { result: { findings: { sessionId: string }[] } }
    // The Router is not an orphan: it belongs to no Assignment and no Project, so nothing may touch it.
    expect(result.findings.find(finding => finding.sessionId === 'router')).toBeUndefined()
  })
})
