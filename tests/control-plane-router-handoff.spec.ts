/**
 * The high-level Router's own handoff: a request for work that belongs to a Project reaches that Project's PM.
 *
 * The Fast Router carries out a message whose target it can read off the words. The high-level Router is a model, so
 * the control plane judges what it decides: the request has to ask for work, the Project has to be the one the request
 * names, and the instruction has to be the person's own words. A decision that fails any of these sends nothing, and the
 * record says which of them failed.
 *
 * The delivery itself is the control plane's: nobody confirms an ordinary task, the PM Session of the target Project
 * receives it, and the console shows the Project, the PM Session and how far the delivery really got. A request reaches
 * one PM only — a repeated call, a call after a restart and a call whose receipt was lost all lead to the same delivery,
 * and never to a second one.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { evaluateRouterHandoff, handoffWorkIntent, mentionedProjects, readRouterHandoffDecision,
  RouterHandoffError, tracedFromRequest, type RouterHandoffDecision } from '../src/control/router-handoff.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { NodeUnconfirmedError, type NodeCommand } from '../src/shared/protocol.ts'

const SECRET = 'router-handoff-secret'
const API_TOKEN = 'router-handoff-token'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: ControllableNode
let address = { url: '', port: 0 }
/** The clock the control plane reads; the tests move it when a request has to grow old. */
let clock = START

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

/** One handoff, as the console reads it. */
interface HandoffRecord {
  requestId: string
  kind: string
  at: string
  text: string
  projectId: string
  projectTitle: string
  pmSessionId: string
  pmStatus?: string
  instruction: string
  rationale: string
  stage: string
  reason: string
  detail: string
  error?: string
}

/** What one handoff became, as the Router's tool reads it. */
interface HandoffOutcome {
  outcome: string
  reason: string
  detail: string
  project?: { id: string; title: string }
  pm?: { sessionId: string; status: string }
  instruction?: string
}

function post(path: string, body: unknown = {}, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function get(path: string, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

/** Avoid ephemeral ports that fetch rejects before reaching the server. */
async function listenToolServer(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    server = new ControlPlaneServer(control!, { token: API_TOKEN })
    address = await server.listen(0)
    try {
      const health = await fetch(address.url + '/health')
      await health.text()
      if (health.ok) return
    } catch {
      // A blocked port needs a new listener.
    }
    await server.close()
    server = undefined
  }
  throw new Error('Could not listen on a port that fetch accepts')
}

/** A control plane with a node, listening on a random port. */
async function open(now: () => string = () => clock): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-router-handoff-'))
  const root = join(directory, 'workspaces')
  node = new ControllableNode({ nodeId: NODE_ID, root, now: () => clock })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now, confirmationTimeoutMs: 50 })
  await control.registerNode()
  await listenToolServer()
}

/** Restart the control plane against the same files, the way a crash and a restart do. */
async function reopen(now: () => string = () => clock): Promise<void> {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces'), now, confirmationTimeoutMs: 50 })
  await control.registerNode()
  await listenToolServer()
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

/**
 * The request a person's message became; the Router may act for it and only for it.
 *
 * The answer says which way the message went: a message the rules carried out itself never reaches the model, and a
 * message the rules were not sure about goes to the high-level Router.
 */
async function ask(text: string, attachments?: unknown[]): Promise<{ requestId: string; routed: boolean }> {
  const response = await post('/v1/console/router/message',
    attachments === undefined ? { text } : { text, attachments })
  expect(response.status).toBe(200)
  const body = await response.json() as { requestId: string; routing?: unknown }
  return { requestId: body.requestId, routed: body.routing !== undefined }
}

/** The Router's own tool call: the handoff it decided on. */
function handoff(requestId: string, decision: unknown): Promise<Response> {
  return post('/v1/tools/router/pm-handoff', { requestId, decision }, node.tokens.get('router')!)
}

/** The Router's own tool call: a relay proposal that waits for a person. */
function propose(requestId: string, projectId: string, instruction: string): Promise<Response> {
  return post('/v1/tools/router/pm-proposal', { requestId, projectId, instruction }, node.tokens.get('router')!)
}

/** The handoffs the console shows. */
async function handoffs(): Promise<HandoffRecord[]> {
  const state = (await (await get('/v1/console/router')).json()) as { handoffs?: HandoffRecord[] }
  return state.handoffs ?? []
}

/** The four conditions of a gate decision, all of them holding. */
function conditions(): unknown[] {
  return [
    { condition: 'multiple_independent_modules', met: true, evidence: '两个模块各自负责一块，没有交叉。' },
    { condition: 'reasonable_decoupling', met: true, evidence: '两个模块只共享一份文案清单，可以先后交付。' },
    { condition: 'genuine_parallelism', met: true, evidence: '两个模块没有前后依赖，可以同时开工。' },
    { condition: 'benefit_outweighs_coordination', met: true, evidence: '两块并行比串行省一轮联调，只多一次对齐会。' },
  ]
}

/** A gate decision the control plane may let through. */
const PARALLEL_DECISION = {
  title: '官网改版',
  goal: '把官网首页和文档站一起改完',
  requestAnchor: '把官网首页和文档站一起改完',
  modules: [
    { name: '首页模块', responsibility: '重写首页的布局与文案', independent: true,
      evidence: '首页模块只读写首页自己的文件，与文档站没有共享文件。', anchor: '首页' },
    { name: '文档站模块', responsibility: '补齐文档站的接口说明', independent: true,
      evidence: '文档站模块只改文档目录，首页模块不碰这些文件。', anchor: '文档站' },
  ],
  conditions: conditions(),
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
  clock = START
})

describe('the check on the high-level handoff', () => {
  const project = { id: 'project-weekly', title: '周报整理', status: 'active' }

  it('lets an ordinary task for a named project through', () => {
    const decision: RouterHandoffDecision = { projectId: project.id, instruction: '请在「周报整理」补充本周数据',
      rationale: '请求点名了周报整理这个项目。' }
    const verdict = evaluateRouterHandoff(decision, { text: '请在「周报整理」补充本周数据', projects: [project] })
    expect(verdict).toMatchObject({ allowed: true, reason: 'allowed', project: { id: project.id } })
    expect(verdict.instruction).toBe('请在「周报整理」补充本周数据')
  })

  it('refuses a request that asks for no work, that asks and that negates', () => {
    const decision: RouterHandoffDecision = { projectId: project.id, instruction: '周报整理',
      rationale: '请求提到了这个项目。' }
    // A greeting asks for nothing to be done.
    expect(evaluateRouterHandoff(decision, { text: '你好', projects: [project] }))
      .toMatchObject({ allowed: false, reason: 'no_work_instruction' })
    // A request to talk about the work is not a request to do it.
    expect(evaluateRouterHandoff(decision, { text: '解释一下这个周报整理的思路', projects: [project] }))
      .toMatchObject({ allowed: false, reason: 'discussion_only' })
    // A question is not an order.
    expect(evaluateRouterHandoff(decision, { text: '周报整理的进度怎么样', projects: [project] }))
      .toMatchObject({ allowed: false, reason: 'request_question' })
    // A negated request is not one either.
    expect(evaluateRouterHandoff(decision, { text: '不要在周报整理里加东西', projects: [project] }))
      .toMatchObject({ allowed: false, reason: 'request_negated' })
  })

  it('refuses a request that names no project and one that names two', () => {
    const decision: RouterHandoffDecision = { projectId: project.id, instruction: '补充本周数据',
      rationale: '请求要求补充数据。' }
    const monthly = { id: 'project-monthly', title: '月报整理', status: 'active' }
    const short = { id: 'project-report', title: '周报', status: 'active' }
    // The model picked a project the person never named.
    expect(evaluateRouterHandoff(decision, { text: '把本周的数据补齐', projects: [project] }))
      .toMatchObject({ allowed: false, reason: 'target_not_named' })
    // Two candidates are a question, not a delivery.
    expect(evaluateRouterHandoff(decision, { text: '把周报整理和月报整理都补齐', projects: [project, monthly] }))
      .toMatchObject({ allowed: false, reason: 'ambiguous_target' })
    expect(evaluateRouterHandoff(decision, { text: '请在「周报整理」和「周报」补充本周数据',
      projects: [project, short] })).toMatchObject({ allowed: false, reason: 'ambiguous_target' })
    // The model picked the wrong one of the two.
    expect(evaluateRouterHandoff({ ...decision, projectId: monthly.id },
      { text: '把周报整理和月报整理都补齐', projects: [project, monthly] }))
      .toMatchObject({ allowed: false, reason: 'ambiguous_target' })
  })

  it('refuses an instruction that is not the person\'s own words', () => {
    const decision: RouterHandoffDecision = { projectId: project.id,
      instruction: '把生产环境的数据库清空', rationale: '请求要求补充数据。' }
    expect(evaluateRouterHandoff(decision, { text: '请在「周报整理」补充本周数据', projects: [project] }))
      .toMatchObject({ allowed: false, reason: 'instruction_not_in_request' })
    // The words of the request are the words that may travel.
    expect(tracedFromRequest('请在「周报整理」补充本周数据', '请在「周报整理」补充本周数据')).toBe(true)
    expect(tracedFromRequest('把生产环境的数据库清空', '请在「周报整理」补充本周数据')).toBe(false)
    expect(tracedFromRequest('请在「周报整理」补充下周数据', '请在「周报整理」补充本周数据')).toBe(false)
    expect(tracedFromRequest('补充本周数据', '请在「周报整理」补充本周数据')).toBe(true)
  })

  it('refuses an instruction that reaches into another project', () => {
    const monthly = { id: 'project-monthly', title: '月报整理', status: 'active' }
    const decision: RouterHandoffDecision = { projectId: project.id,
      instruction: '请在「周报整理」补充本周数据，并把月报整理一起改了',
      rationale: '请求点名了周报整理这个项目。' }
    // The request names one Project; the instruction reaches into another one.
    expect(evaluateRouterHandoff(decision,
      { text: '请在「周报整理」补充本周数据', projects: [project, monthly] }))
      .toMatchObject({ allowed: false, reason: 'cross_project' })
  })

  it('refuses an instruction that wants a new authority or an irreversible scope', () => {
    const authority: RouterHandoffDecision = { projectId: project.id,
      instruction: '请在「周报整理」补充本周数据，需要新的令牌', rationale: '请求要求补充数据。' }
    expect(evaluateRouterHandoff(authority, { text: '请在「周报整理」补充本周数据，需要新的令牌', projects: [project] }))
      .toMatchObject({ allowed: false, reason: 'new_authority' })
    const irreversible: RouterHandoffDecision = { projectId: project.id,
      instruction: '请在「周报整理」补充本周数据，并删除旧数据', rationale: '请求要求补充数据。' }
    expect(evaluateRouterHandoff(irreversible,
      { text: '请在「周报整理」补充本周数据，并删除旧数据', projects: [project] }))
      .toMatchObject({ allowed: false, reason: 'irreversible_scope' })
  })

  it('binds a request to the project it created', () => {
    const decision: RouterHandoffDecision = { projectId: 'project-new', instruction: '把官网首页和文档站一起改完',
      rationale: '门禁放行后创建的项目。' }
    const facts = { text: '把官网首页和文档站一起改完', projects: [{ id: 'project-new', title: '官网改版', status: 'active' }] }
    // The Project of this request is the only one this request may reach.
    expect(evaluateRouterHandoff(decision, { ...facts, createdProjectId: 'project-new' }))
      .toMatchObject({ allowed: true })
    expect(evaluateRouterHandoff({ ...decision, projectId: 'project-other' },
      { ...facts, projects: [...facts.projects, { id: 'project-other', title: '其他项目', status: 'active' }],
        createdProjectId: 'project-new' }))
      .toMatchObject({ allowed: false, reason: 'created_project_mismatch' })
  })

  it('reads a decision it cannot judge as a refusal, not as a yes', () => {
    // A decision with a target, words and a reason reads as it is.
    expect(readRouterHandoffDecision({ projectId: 'p', instruction: '做这件事', rationale: '因为这样' }))
      .toEqual({ projectId: 'p', instruction: '做这件事', rationale: '因为这样' })
    // A decision without a target, without words, with too few words or without a reason.
    expect(() => readRouterHandoffDecision({ instruction: '做这件事', rationale: '因为这样' }))
      .toThrow(RouterHandoffError)
    expect(() => readRouterHandoffDecision({ projectId: 'p', rationale: '因为这样' }))
      .toThrow(RouterHandoffError)
    expect(() => readRouterHandoffDecision({ projectId: 'p', instruction: '做', rationale: '因为这样' }))
      .toThrow(RouterHandoffError)
    expect(() => readRouterHandoffDecision({ projectId: 'p', instruction: '做这件事', rationale: '好' }))
      .toThrow(RouterHandoffError)
  })

  it('reads what asks for work, and which projects a request names', () => {
    expect(handoffWorkIntent('请在「周报整理」补充本周数据')).toBe('ok')
    expect(handoffWorkIntent('你好')).toBe('no_work_instruction')
    expect(handoffWorkIntent('聊个笑话')).toBe('discussion_only')
    const weekly = { id: 'project-weekly', title: '周报整理', status: 'active' }
    const monthly = { id: 'project-monthly', title: '月报整理', status: 'active' }
    // The most specific name wins: "周报整理" beside "周报" is one mention, not two.
    expect(mentionedProjects('在周报整理里补数据', [weekly, { id: 'p', title: '周报', status: 'active' }]))
      .toEqual([weekly])
    expect(mentionedProjects('把周报整理和月报整理都补齐', [weekly, monthly])).toHaveLength(2)
  })
})

describe('the handoff in the control plane', () => {
  it('gives the work to the PM of the project the request names, without a confirmation', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    // The rule layer leaves this one alone: the request names a Project, but it does not say "tell the PM".
    const asked = await ask('请在「周报整理」补充本周数据')
    expect(asked.routed).toBe(false)
    const answered = await handoff(asked.requestId, { projectId,
      instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' })
    expect(answered.status).toBe(200)
    const outcome = await answered.json() as HandoffOutcome
    expect(outcome.outcome).toBe('delivered')
    expect(outcome.project).toEqual({ id: projectId, title: '周报整理' })
    expect(outcome.pm?.sessionId).toBe(pmSessionId)
    // The PM really received the person's own words, and nobody confirmed anything.
    const received = messagesOf(pmSessionId)
    expect(received).toHaveLength(1)
    expect(received[0]).toContain('请在「周报整理」补充本周数据')
    expect(received[0]).toContain('nobody confirmed it in the console')
    const secondRoute = await post('/v1/tools/router/dispatch', {
      requestId: asked.requestId, title: '另开工单', goal: '同一请求第二次派工',
    }, node.tokens.get('router')!)
    expect(secondRoute.status).toBe(400)
    expect(control!.tickets()).toEqual([])
    // The console shows the Project, the PM Session and how far the delivery got.
    const shown = await handoffs()
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ kind: 'handoff', projectId, pmSessionId, stage: 'assigned',
      instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' })
  })

  it('sends the same request only once', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    const asked = await ask('请在「周报整理」补充本周数据')
    const decision = { projectId, instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' }
    const first = await handoff(asked.requestId, decision)
    expect((await first.json() as HandoffOutcome).outcome).toBe('delivered')
    const again = await handoff(asked.requestId, decision)
    expect(again.status).toBe(200)
    expect((await again.json() as HandoffOutcome).outcome).toBe('delivered')
    expect(messagesOf(pmSessionId)).toHaveLength(1)
    expect(await handoffs()).toHaveLength(1)
  })

  it('refuses a request that is gone, and answers a call after a restart with the receipt it has', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    const asked = await ask('请在「周报整理」补充本周数据')
    const decision = { projectId, instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' }
    expect((await (await handoff(asked.requestId, decision)).json() as HandoffOutcome).outcome).toBe('delivered')

    await reopen()
    const again = await handoff(asked.requestId, decision)
    expect(again.status).toBe(200)
    expect((await again.json() as HandoffOutcome).outcome).toBe('delivered')
    // The work was not sent a second time.
    expect(messagesOf(pmSessionId)).toHaveLength(1)
    expect(await handoffs()).toHaveLength(1)
  })

  it('refuses a request that grew too old to authorize anything', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    const asked = await ask('请在「周报整理」补充本周数据')
    // The window in which a request may still act is the one it was given.
    clock = new Date(Date.parse(START) + 20 * 60 * 1000).toISOString()
    const answered = await handoff(asked.requestId, { projectId,
      instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' })
    expect(answered.status).toBe(400)
    expect(messagesOf(pmSessionId)).toEqual([])
    expect(await handoffs()).toEqual([])
  })

  it('refuses a decision for a project the request does not name, and for one it names twice', async () => {
    await open()
    const weekly = await projectWithPm('周报整理')
    const monthly = await projectWithPm('月报整理')
    const asked = await ask('请在「周报整理」补充本周数据')
    const refused = await handoff(asked.requestId, { projectId: monthly.projectId,
      instruction: '请在「周报整理」补充本周数据', rationale: '模型选了另一个项目。' })
    expect(refused.status).toBe(200)
    expect((await refused.json() as HandoffOutcome).outcome).toBe('refused')
    expect(messagesOf(weekly.pmSessionId)).toEqual([])
    expect(messagesOf(monthly.pmSessionId)).toEqual([])
    expect((await handoffs()).at(-1)).toMatchObject({ stage: 'refused', reason: 'target_mismatch' })

    // Two candidates are a question for the person, not a delivery.
    const both = await ask('把周报整理和月报整理都补齐')
    const ambiguous = await handoff(both.requestId, { projectId: weekly.projectId,
      instruction: '把周报整理和月报整理都补齐', rationale: '请求提到了两个项目。' })
    expect(ambiguous.status).toBe(200)
    expect((await ambiguous.json() as HandoffOutcome).outcome).toBe('refused')
    expect(messagesOf(weekly.pmSessionId)).toEqual([])
    expect(messagesOf(monthly.pmSessionId)).toEqual([])
    expect((await handoffs()).at(-1)).toMatchObject({ stage: 'refused', reason: 'ambiguous_target' })
  })

  it('refuses a decision whose instruction is not the person\'s own words', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    const asked = await ask('请在「周报整理」补充本周数据')
    const refused = await handoff(asked.requestId, { projectId,
      instruction: '把周报整理里的历史数据全部删除', rationale: '模型自己加了一句话。' })
    expect(refused.status).toBe(200)
    const outcome = await refused.json() as HandoffOutcome
    expect(outcome.outcome).toBe('refused')
    expect(outcome.reason).toBe('instruction_not_in_request')
    expect(messagesOf(pmSessionId)).toEqual([])
  })

  it('does not carry the files the person attached into the PM', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    const asked = await ask('请在「周报整理」补充本周数据', [{ name: 'work/数据.txt', text: '本周的原始数据在附件里' }])
    const refused = await handoff(asked.requestId, { projectId,
      instruction: '把附件里的数据导入周报整理', rationale: '请求要求补充数据。' })
    expect(refused.status).toBe(200)
    expect((await refused.json() as HandoffOutcome).outcome).toBe('refused')
    expect(messagesOf(pmSessionId)).toEqual([])
  })

  it('opens no tool for a PM token, and no delivery for a PM that may not be used', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    const asked = await ask('请在「周报整理」补充本周数据')
    // Only the Router's own token opens the handoff.
    const forbidden = await post('/v1/tools/router/pm-handoff', { requestId: asked.requestId,
      decision: { projectId, instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' } },
    node.tokens.get(pmSessionId)!)
    expect(forbidden.status).toBe(403)
    // A PM an operator stopped takes no work.
    await post(`/v1/console/sessions/${pmSessionId}/cancel`, { reason: '这个 PM 先停一下' })
    const stopped = await handoff(asked.requestId, { projectId,
      instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' })
    expect(stopped.status).toBe(200)
    expect((await stopped.json() as HandoffOutcome).outcome).toBe('failed')
    expect(messagesOf(pmSessionId)).toEqual([])
    expect((await handoffs())[0]).toMatchObject({ stage: 'failed', reason: 'pm_stopped' })
  })

  it('does not deliver to a project that is over or to a PM whose authority was withdrawn', async () => {
    await open()
    const ended = await projectWithPm('周报整理')
    await post(`/v1/console/projects/${ended.projectId}/stop`, { reason: '做完了' })
    const asked = await ask('请在「周报整理」补充本周数据')
    const refused = await handoff(asked.requestId, { projectId: ended.projectId,
      instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' })
    expect((await refused.json() as HandoffOutcome).outcome).toBe('failed')
    expect(messagesOf(ended.pmSessionId)).toEqual([])

    const revoked = await projectWithPm('月报整理')
    await post(`/v1/console/sessions/${revoked.pmSessionId}/revoke`, { reason: '换人' })
    const other = await ask('请在「月报整理」补充本月数据')
    const refusedToo = await handoff(other.requestId, { projectId: revoked.projectId,
      instruction: '请在「月报整理」补充本月数据', rationale: '请求点名了月报整理这个项目。' })
    expect((await refusedToo.json() as HandoffOutcome).outcome).toBe('failed')
    expect(messagesOf(revoked.pmSessionId)).toEqual([])
  })

  it('says so when the node refuses the delivery, and does not claim that the work arrived', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    node.messageFailures.set(pmSessionId, new Error('the node refused the message'))
    const asked = await ask('请在「周报整理」补充本周数据')
    const answered = await handoff(asked.requestId, { projectId,
      instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' })
    expect((await answered.json() as HandoffOutcome).outcome).toBe('failed')
    expect(messagesOf(pmSessionId)).toEqual([])
    expect((await handoffs())[0]).toMatchObject({ stage: 'failed' })
  })

  it('says so when nobody confirmed the delivery, and does not send it again', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    node.messageFailures.set(pmSessionId, new NodeUnconfirmedError('the node did not answer the message'))
    const asked = await ask('请在「周报整理」补充本周数据')
    const answered = await handoff(asked.requestId, { projectId,
      instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' })
    expect((await answered.json() as HandoffOutcome).outcome).toBe('unconfirmed')
    expect(messagesOf(pmSessionId)).toEqual([])
    expect((await handoffs())[0]).toMatchObject({ stage: 'unconfirmed' })
    // The same request is not tried a second time.
    const again = await handoff(asked.requestId, { projectId,
      instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' })
    expect((await again.json() as HandoffOutcome).outcome).toBe('unconfirmed')
    expect(messagesOf(pmSessionId)).toEqual([])
  })

  it('keeps a relay proposal and a handoff apart', async () => {
    await open()
    const { projectId, pmSessionId } = await projectWithPm('周报整理')
    const asked = await ask('请在「周报整理」补充本周数据')
    // A request that waits for a person does not also reach a PM behind the person's back.
    const proposed = await propose(asked.requestId, projectId, '请在「周报整理」补充本周数据')
    expect(proposed.status).toBe(200)
    const refused = await handoff(asked.requestId, { projectId,
      instruction: '请在「周报整理」补充本周数据', rationale: '请求点名了周报整理这个项目。' })
    expect(refused.status).toBe(400)
    expect(messagesOf(pmSessionId)).toEqual([])
  })

  it('gives the brief of a gate-created project to that project\'s PM and to nobody else', async () => {
    await open()
    const asked = await ask('把官网首页和文档站一起改完')
    const answered = await post('/v1/tools/router/project-gate',
      { requestId: asked.requestId, decision: PARALLEL_DECISION }, node.tokens.get('router')!)
    expect(answered.status).toBe(200)
    const outcome = await answered.json() as { outcome: string; project: { id: string; title: string }
      pm: { sessionId: string } }
    expect(outcome.outcome).toBe('created')
    // The brief goes to the PM of the Project the request created.
    const received = messagesOf(outcome.pm.sessionId)
    expect(received).toHaveLength(1)
    expect(received[0]).toContain('把官网首页和文档站一起改完')
    expect(received[0]).toContain(outcome.project.title)
    // The Router created no Ticket for that Project: the PM does that itself.
    expect(control!.tickets().filter(ticket => ticket.projectId === outcome.project.id)).toEqual([])
    // The record says which kind of handoff it was.
    const shown = await handoffs()
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ kind: 'brief', projectId: outcome.project.id, stage: 'assigned',
      pmSessionId: outcome.pm.sessionId })
    // A second handoff for the same request does not send the work again: the receipt it already has is the answer.
    const again = await handoff(asked.requestId, { projectId: outcome.project.id,
      instruction: '把官网首页和文档站一起改完', rationale: '门禁放行后创建的项目。' })
    expect(again.status).toBe(200)
    expect((await again.json() as HandoffOutcome).outcome).toBe('delivered')
    expect(messagesOf(outcome.pm.sessionId)).toHaveLength(1)
    // Another instruction for the same request is refused: one request is one delivery.
    const other = await handoff(asked.requestId, { projectId: outcome.project.id,
      instruction: '把官网首页和文档站一起改完，再补一份说明', rationale: '模型又想加一件事。' })
    expect(other.status).toBe(400)
    expect(messagesOf(outcome.pm.sessionId)).toHaveLength(1)
  })

  it('preserves work and constraints outside the gate evidence anchor', async () => {
    await open()
    const text = '把官网首页和文档站一起改完。只在当前项目目录改动，先更新静态样例。'
    const asked = await ask(text)
    const answer = await post('/v1/tools/router/project-gate',
      { requestId: asked.requestId, decision: PARALLEL_DECISION }, node.tokens.get('router')!)
    expect(answer.status).toBe(200)
    const outcome = await answer.json() as { pm: { sessionId: string } }
    expect(messagesOf(outcome.pm.sessionId)).toHaveLength(1)
    expect(messagesOf(outcome.pm.sessionId)[0]).toContain(text)
  })

  it('keeps a project the person asked to create and wait idle', async () => {
    await open()
    const asked = await ask('把官网首页和文档站一起改完，只创建项目待命')
    const answered = await post('/v1/tools/router/project-gate',
      { requestId: asked.requestId, decision: { ...PARALLEL_DECISION, requestAnchor: '只创建项目待命' } },
    node.tokens.get('router')!)
    expect(answered.status).toBe(200)
    const outcome = await answered.json() as { outcome: string; project: { id: string }
      pm: { sessionId: string } }
    expect(outcome.outcome).toBe('created')
    // The PM is there and waits: no brief was published to it.
    expect(messagesOf(outcome.pm.sessionId)).toEqual([])
    expect((await handoffs())[0]).toMatchObject({ kind: 'brief', stage: 'refused', reason: 'create_only_request' })
  })
})
