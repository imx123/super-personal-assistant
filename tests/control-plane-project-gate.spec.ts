/**
 * The Project Gate: the four conditions a request must meet before the control plane may create a Project on its own.
 *
 * The gate is judged, not believed. A person who asks for a Project gets one — that is the human's own authority, and the
 * gate never touches it. A model that decides on its own gets a decision that is checked here: all four conditions have to
 * hold, each on its own evidence, the evidence has to be about the modules the decision names, and the decision has to
 * quote the person's own request. "It is complex", "it will take a long time" and "there are many sub-tasks" are not
 * evidence of any of them, and a request that only chats or asks about a plan asks for no work at all.
 *
 * The controlled samples below are the decisioner's own table: four requests that must be refused and two that may go
 * through. They are deterministic, so they say what the gate does and not what a model happened to say.
 *
 * A refusal creates nothing at all — no Project, no PM, no Ticket, no Session — and leaves a record that names the human
 * request and the condition that failed. A decision that did create a Project is recorded once, so a repeated call, a call
 * after a restart and a call whose receipt was lost all lead to the same Project and never to a second one.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ConsoleStore } from '../src/control/console-store.ts'
import { evaluateProjectGate, explicitProjectRequest, ProjectGateError, readProjectGateDecision, workAuthorization,
  type ProjectGateDecision } from '../src/control/project-gate.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const SECRET = 'project-gate-secret'
const API_TOKEN = 'project-gate-token'
const START = '2026-01-01T00:00:00.000Z'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode
let address = { url: '', port: 0 }

/** One decision of the gate, as the console reads it. */
interface GateRecord {
  requestId: string
  attempt: number
  text: string
  outcome: string
  reason: string
  detail: string
  conditions: { condition: string; met: boolean; evidence: string }[]
  modules: { name: string; responsibility: string; independent: boolean; evidence: string; anchor: string }[]
  failedCondition?: string
  existingProject?: { id: string; title: string }
  projectId?: string
  pmSessionId?: string
  pmStatus?: string
  error?: string
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
  directory = mkdtempSync(join(tmpdir(), 'superagent-project-gate-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: 'local', root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
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
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces'), now, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  address = await server.listen(0)
}

/** The request a person's message became; the Router may act for it and only for it. */
async function ask(text: string): Promise<string> {
  const response = await post('/v1/console/router/message', { text })
  expect(response.status).toBe(200)
  return (await response.json() as { requestId: string }).requestId
}

/** The Router's own tool call: the decision it proposes to the gate. */
function gate(requestId: string, decision: unknown): Promise<Response> {
  return post('/v1/tools/router/project-gate', { requestId, decision }, node.tokens.get('router')!)
}

/** The decisions of the gate, as the console shows them. */
async function gates(): Promise<GateRecord[]> {
  const state = (await (await get('/v1/console/router')).json()) as { gates?: GateRecord[] }
  return state.gates ?? []
}

/** The Router's own tool call: a Project a person asked for. */
function createProject(requestId: string, title: string, goal: string): Promise<Response> {
  return post('/v1/tools/router/projects', { requestId, title, goal }, node.tokens.get('router')!)
}

/** The Router's own tool call: an independent Ticket for one request. */
function dispatch(requestId: string, title: string, goal: string): Promise<Response> {
  return post('/v1/tools/router/dispatch', { requestId, title, goal }, node.tokens.get('router')!)
}

/** The Router's own tool call: a management action for one request. */
function manage(requestId: string, action: string, targetId: string): Promise<Response> {
  return post('/v1/tools/router/manage', { requestId, action, targetId }, node.tokens.get('router')!)
}

/** The Router's own tool call: a relay proposal to the PM of one Project. */
function propose(requestId: string, projectId: string, instruction: string): Promise<Response> {
  return post('/v1/tools/router/pm-proposal', { requestId, projectId, instruction }, node.tokens.get('router')!)
}

/**
 * Write down a decision that was never finished, the way a control plane that stopped in the middle leaves it.
 *
 * The record is the control plane's own fact: the decision was written down before the Project was, so a process that
 * died between the two leaves exactly this behind.
 */
function leaveHalfMadeDecision(requestId: string, text: string): void {
  const store = new ConsoleStore(join(directory, 'console.sqlite'))
  try {
    store.addProjectGate({ requestId, attempt: 1, at: START, text, title: '官网改版',
      goal: '把官网首页和文档站一起改完', outcome: 'creating', reason: 'allowed',
      detail: '四项条件都成立，每项都有可核对的理由。', conditions: '[]', modules: '[]',
      failedCondition: '', existingProject: '', projectId: '', pmSessionId: '', pmStatus: '', error: '' })
  } finally {
    store.close()
  }
}

/** A Project with its PM Session, so the Router has somebody to talk to. */
async function projectWithPm(title: string): Promise<{ projectId: string; pmSessionId: string }> {
  const created = await post('/v1/console/projects', { title, goal: '把工作做完' })
  const { project } = (await created.json()) as { project: { id: string } }
  const pm = await post(`/v1/console/projects/${project.id}/pm`)
  const { session } = (await pm.json()) as { session: { sessionId: string } }
  return { projectId: project.id, pmSessionId: session.sessionId }
}

/** The four conditions of a decision, all of them holding, with the evidence each one names. */
function conditions(evidence: Record<string, string>, met: Record<string, boolean> = {}): ProjectGateDecision['conditions'] {
  return [
    { condition: 'multiple_independent_modules', met: met.multiple_independent_modules ?? true,
      evidence: evidence.multiple_independent_modules ?? '两个模块各自负责一块，没有交叉。' },
    { condition: 'reasonable_decoupling', met: met.reasonable_decoupling ?? true,
      evidence: evidence.reasonable_decoupling ?? '两个模块只共享一份文案清单，可以先后交付。' },
    { condition: 'genuine_parallelism', met: met.genuine_parallelism ?? true,
      evidence: evidence.genuine_parallelism ?? '两个模块没有前后依赖，可以同时开工。' },
    { condition: 'benefit_outweighs_coordination', met: met.benefit_outweighs_coordination ?? true,
      evidence: evidence.benefit_outweighs_coordination ?? '两块并行比串行省一轮联调，只多一次对齐会。' },
  ]
}

/** The two modules every sample but the one-module one is made of. */
function modules(independent = true): ProjectGateDecision['modules'] {
  return [
    { name: '首页模块', responsibility: '重写首页的布局与文案', independent,
      evidence: '首页模块只读写首页自己的文件，与文档站没有共享文件。', anchor: '首页' },
    { name: '文档站模块', responsibility: '补齐文档站的接口说明', independent,
      evidence: '文档站模块只改文档目录，首页模块不碰这些文件。', anchor: '文档站' },
  ]
}

/** A decision the gate may let through. */
const PARALLEL_DECISION: ProjectGateDecision = {
  title: '官网改版',
  goal: '把官网首页和文档站一起改完',
  requestAnchor: '把官网首页和文档站一起改完',
  modules: modules(),
  conditions: conditions({}),
}

/** A second group of tasks that may go through: the payment flow and the invoice page. */
const SECOND_PARALLEL_DECISION: ProjectGateDecision = {
  title: '支付改造',
  goal: '把支付流程和账单页面一起换掉',
  requestAnchor: '把支付流程和账单页面一起换掉',
  modules: [
    { name: '支付流程模块', responsibility: '替换支付网关的调用', independent: true,
      evidence: '支付流程模块只改网关封装，账单页面不引用它。', anchor: '支付流程' },
    { name: '账单页面模块', responsibility: '重做账单列表页', independent: true,
      evidence: '账单页面模块只改页面组件，支付流程模块不依赖它。', anchor: '账单页面' },
  ],
  conditions: conditions({
    multiple_independent_modules: '支付流程模块和账单页面模块各自负责一块，没有交叉。',
    reasonable_decoupling: '支付流程模块与账单页面模块只共享一份字段清单，可以先后交付。',
    genuine_parallelism: '支付流程模块和账单页面模块没有前后依赖，可以同时开工。',
    benefit_outweighs_coordination: '两块并行比串行省一轮回归，协调只多一次字段对齐。',
  }),
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the four conditions of the gate', () => {
  it('refuses automatic creation with the exact title of an existing project', () => {
    const existing = { id: 'project-existing', title: PARALLEL_DECISION.title, status: 'active' }
    expect(evaluateProjectGate(PARALLEL_DECISION, { text: PARALLEL_DECISION.requestAnchor, projects: [existing] }))
      .toMatchObject({ allowed: false, reason: 'existing_project', existingProject: { id: existing.id } })
  })

  it('refuses a work that is only long-running, only complex, not decoupled, or not worth the coordination', () => {
    const facts = { text: '把官网首页和文档站一起改完', projects: [] }
    // Long and hard is not evidence that the work may be split.
    const longOnly: ProjectGateDecision = { ...PARALLEL_DECISION, conditions: conditions({
      genuine_parallelism: '这项工作很复杂，要长期运行很久才做得完',
    }) }
    expect(evaluateProjectGate(longOnly, facts)).toMatchObject({ allowed: false,
      reason: 'complexity_is_not_evidence', failedCondition: 'genuine_parallelism' })
    // Complex, but one thing that cannot be taken apart.
    const complexOnly: ProjectGateDecision = { ...PARALLEL_DECISION,
      modules: [{ name: '改版模块', responsibility: '把首页和文档站一起改完', independent: false,
        evidence: '首页和文档站必须一起改，拆开就做不成。', anchor: '首页' }] }
    expect(evaluateProjectGate(complexOnly, facts)).toMatchObject({ allowed: false, reason: 'not_multiple_modules' })
    // Two modules, but they share what they work on and cannot move apart.
    const coupled: ProjectGateDecision = { ...PARALLEL_DECISION,
      modules: modules(false) }
    expect(evaluateProjectGate(coupled, facts)).toMatchObject({ allowed: false, reason: 'module_not_independent',
      failedCondition: 'reasonable_decoupling' })
    // The work may be split, but the coordination costs more than the parallel gain.
    const notWorthIt: ProjectGateDecision = { ...PARALLEL_DECISION,
      conditions: conditions({}, { benefit_outweighs_coordination: false }) }
    expect(evaluateProjectGate(notWorthIt, facts)).toMatchObject({ allowed: false, reason: 'condition_not_met',
      failedCondition: 'benefit_outweighs_coordination' })
  })

  it('lets two groups of suitable parallel tasks through, each with its own reason', () => {
    const facts = { text: '把官网首页和文档站一起改完', projects: [] }
    const first = evaluateProjectGate(PARALLEL_DECISION, facts)
    expect(first.allowed).toBe(true)
    expect(first.reason).toBe('allowed')
    expect(first.conditions).toHaveLength(4)
    expect(first.modules.map(module => module.name)).toEqual(['首页模块', '文档站模块'])
    const second = evaluateProjectGate(SECOND_PARALLEL_DECISION, { text: '把支付流程和账单页面一起换掉', projects: [] })
    expect(second.allowed).toBe(true)
    expect(second.modules.map(module => module.name)).toEqual(['支付流程模块', '账单页面模块'])
  })

  it('refuses a request that negates, one that asks and one whose command is only quoted', () => {
    const facts = { text: '把官网首页和文档站一起改完', projects: [] }
    expect(evaluateProjectGate(PARALLEL_DECISION, { ...facts, text: '不要动首页和文档站' }))
      .toMatchObject({ allowed: false, reason: 'request_negated' })
    expect(evaluateProjectGate(PARALLEL_DECISION, { ...facts, text: '首页和文档站能一起改吗？' }))
      .toMatchObject({ allowed: false, reason: 'request_question' })
    expect(evaluateProjectGate(PARALLEL_DECISION, { ...facts, text: '把「创建一个项目」这句话发给我' }))
      .toMatchObject({ allowed: false, reason: 'quoted_command' })
  })

  it('refuses a request that only talks: a chat, a plan to talk about and a talk about the work', () => {
    // A greeting asks for nothing to be built.
    expect(evaluateProjectGate(PARALLEL_DECISION, { text: '你好', projects: [] }))
      .toMatchObject({ allowed: false, reason: 'no_work_instruction' })
    expect(evaluateProjectGate(PARALLEL_DECISION, { text: '聊个笑话', projects: [] }))
      .toMatchObject({ allowed: false, reason: 'discussion_only' })
    // An explanation of a plan asks for no work either, however many modules the decision names.
    expect(evaluateProjectGate(PARALLEL_DECISION, { text: '解释一下这个重构方案', projects: [] }))
      .toMatchObject({ allowed: false, reason: 'discussion_only' })
    expect(evaluateProjectGate(PARALLEL_DECISION, { text: '分析一下首页和文档站的关系', projects: [] }))
      .toMatchObject({ allowed: false, reason: 'discussion_only' })
    // A request that asks for work in another part of it is still a request for work.
    expect(evaluateProjectGate({ ...PARALLEL_DECISION, requestAnchor: '把首页和文档站一起改完' },
      { text: '讨论一下方案，然后把首页和文档站一起改完', projects: [] })).toMatchObject({ allowed: true })
  })

  it('reads the request itself: what asks for work and what only talks about it', () => {
    // The bounded rule in one place: the request has to carry a word that asks for work, and it must not be a request
    // that only talks about it. This says nothing about the four conditions.
    expect(workAuthorization('把官网首页和文档站一起改完')).toBe('ok')
    expect(workAuthorization('Rewrite the homepage and the docs')).toBe('ok')
    expect(workAuthorization('你好')).toBe('no_work_instruction')
    expect(workAuthorization('Tell me a joke')).toBe('discussion_only')
    expect(workAuthorization('聊个笑话')).toBe('discussion_only')
    expect(workAuthorization('解释一下这个重构方案')).toBe('discussion_only')
    expect(workAuthorization('Explain the refactoring plan')).toBe('discussion_only')
    // A request that asks for work in another part of it is still a request for work.
    expect(workAuthorization('讨论一下方案，然后把首页和文档站一起改完')).toBe('ok')
    expect(workAuthorization('discuss the plan, then rewrite the homepage')).toBe('ok')
  })

  it('refuses a decision whose modules are not in the request, however true its four findings are', () => {
    const facts = { text: '把官网首页和文档站一起改完', projects: [] }
    // Four true findings, and modules that come from another piece of work.
    const elsewhere: ProjectGateDecision = { ...SECOND_PARALLEL_DECISION,
      requestAnchor: '把官网首页和文档站一起改完' }
    expect(evaluateProjectGate(elsewhere, facts)).toMatchObject({ allowed: false,
      reason: 'module_anchor_not_in_request' })
    // The anchors are real words of the request, but they are not the words of these modules.
    const mislabelled: ProjectGateDecision = { ...SECOND_PARALLEL_DECISION,
      requestAnchor: '把官网首页和文档站一起改完',
      modules: [
        { name: '支付流程模块', responsibility: '替换支付网关的调用', independent: true,
          evidence: '支付流程模块只改网关封装，账单页面不引用它。', anchor: '首页' },
        { name: '账单页面模块', responsibility: '重做账单列表页', independent: true,
          evidence: '账单页面模块只改页面组件，支付流程模块不依赖它。', anchor: '文档站' },
      ] }
    expect(evaluateProjectGate(mislabelled, facts)).toMatchObject({ allowed: false, reason: 'module_not_grounded' })
    // Two modules that quote the same words are one module said twice.
    const twice: ProjectGateDecision = { ...PARALLEL_DECISION,
      modules: [
        { name: '首页模块', responsibility: '重写首页的布局与文案', independent: true,
          evidence: '首页模块只读写首页自己的文件。', anchor: '首页' },
        { name: '首页文案模块', responsibility: '重写首页的文案', independent: true,
          evidence: '首页文案模块只读写首页自己的文案。', anchor: '首页' },
      ] }
    expect(evaluateProjectGate(twice, facts)).toMatchObject({ allowed: false, reason: 'module_anchor_duplicated' })
    // The request anchor itself is a quote of the request.
    const invented: ProjectGateDecision = { ...PARALLEL_DECISION, requestAnchor: '把支付网关一起换掉' }
    expect(evaluateProjectGate(invented, facts)).toMatchObject({ allowed: false, reason: 'anchor_not_in_request' })
  })

  it('reads a decision it cannot judge as a refusal, not as a yes', () => {
    expect(() => readProjectGateDecision({ title: 'x', goal: 'y', requestAnchor: '把首页改完', modules: [], conditions: [] }))
      .toThrow(ProjectGateError)
    // A condition that answers "unknown" is not an answer.
    expect(() => readProjectGateDecision({ title: 'x', goal: 'y', requestAnchor: '把首页改完', modules: modules(),
      conditions: [{ condition: 'genuine_parallelism', met: 'unknown', evidence: '大概是吧' }] }))
      .toThrow(ProjectGateError)
    // A condition that is not one of the four is not a condition.
    expect(() => readProjectGateDecision({ title: 'x', goal: 'y', requestAnchor: '把首页改完', modules: modules(),
      conditions: [{ condition: 'vibes', met: true, evidence: '感觉可以' }] }))
      .toThrow(ProjectGateError)
    // An evidence too short to check is no evidence.
    expect(() => readProjectGateDecision({ title: 'x', goal: 'y', requestAnchor: '把首页改完', modules: modules(),
      conditions: conditions({ genuine_parallelism: '好' }) }))
      .toThrow(ProjectGateError)
    // A decision that quotes nobody's words is not a decision about this request.
    expect(() => readProjectGateDecision({ title: 'x', goal: 'y', modules: modules(), conditions: conditions({}) }))
      .toThrow(ProjectGateError)
    expect(() => readProjectGateDecision({ title: 'x', goal: 'y', requestAnchor: '把首页改完',
      modules: [{ name: '首页模块', responsibility: '重写首页', independent: true, evidence: '只改首页自己的文件。' }],
      conditions: conditions({}) }))
      .toThrow(ProjectGateError)
  })

  it('reads the person\'s own words, not the model\'s claim about them', () => {
    expect(explicitProjectRequest('创建一个项目，把首页和文档站一起改完')).toBe(true)
    expect(explicitProjectRequest('新建一个项目叫「官网改版」')).toBe(true)
    expect(explicitProjectRequest('Create a project for the website rework')).toBe(true)
    // A request that only asks, that negates or that quotes a command does not ask for a Project.
    expect(explicitProjectRequest('能创建一个项目吗？')).toBe(false)
    expect(explicitProjectRequest('不要创建项目了')).toBe(false)
    expect(explicitProjectRequest('把「创建一个项目」这句话发给我')).toBe(false)
    // A request that asks for a document is not a request for a Project.
    expect(explicitProjectRequest('建立项目文档')).toBe(false)
    // A negation of something else does not take the request away.
    expect(explicitProjectRequest('创建一个项目，不要动别的')).toBe(true)
  })
})

describe('the gate in the control plane', () => {
  it('creates the Project and its PM when all four conditions hold, and records the decision', async () => {
    await open()
    const requestId = await ask('把官网首页和文档站一起改完')
    const answered = await gate(requestId, PARALLEL_DECISION)
    expect(answered.status).toBe(200)
    const outcome = await answered.json() as { outcome: string; project: { id: string; title: string }
      pm: { sessionId: string; status: string }; conditions: unknown[] }
    expect(outcome.outcome).toBe('created')
    expect(outcome.project.title).toBe('官网改版')
    expect(outcome.pm.sessionId).toBe(`pm-${outcome.project.id}`)
    expect(control!.projects()).toHaveLength(1)
    expect(node.commands.filter(command => command.type === 'pm.ensure')).toHaveLength(1)

    // The record names the human request, the four findings, the Project and the PM.
    const records = await gates()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ requestId, outcome: 'created', projectId: outcome.project.id,
      pmSessionId: outcome.pm.sessionId })
    expect(records[0]!.conditions).toHaveLength(4)
    expect(records[0]!.modules.map(module => module.name)).toEqual(['首页模块', '文档站模块'])
    // The audit says it too.
    expect(control!.auditEntries({ kind: 'project' })
      .some(entry => entry.action === 'gate-created' && entry.outcome === 'ok')).toBe(true)
  })

  it('creates nothing at all when one condition does not hold, and says which one', async () => {
    await open()
    const requestId = await ask('把官网首页和文档站一起改完')
    const answered = await gate(requestId, { ...PARALLEL_DECISION,
      conditions: conditions({}, { benefit_outweighs_coordination: false }) })
    expect(answered.status).toBe(200)
    const outcome = await answered.json() as { outcome: string; reason: string; failedCondition: string }
    expect(outcome.outcome).toBe('refused')
    expect(outcome.reason).toBe('condition_not_met')
    expect(outcome.failedCondition).toBe('benefit_outweighs_coordination')
    // Nothing was created: no Project, no PM, no Ticket.
    expect(control!.projects()).toEqual([])
    expect(control!.tickets()).toEqual([])
    expect(node.commands.some(command => command.type === 'pm.ensure')).toBe(false)
    // The refusal is a record, so that a person may ask why nothing happened.
    const records = await gates()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'refused', reason: 'condition_not_met',
      failedCondition: 'benefit_outweighs_coordination' })
  })

  it('checks the four conditions on the server, whatever the model says', async () => {
    await open()
    const requestId = await ask('把官网首页和文档站一起改完')
    // A decision with only two conditions, a "maybe" answer and no evidence at all.
    const answered = await gate(requestId, { title: '官网改版', goal: '改完首页和文档站',
      modules: [{ name: '首页模块', responsibility: '改首页', independent: 'yes', evidence: '' }],
      conditions: [{ condition: 'multiple_independent_modules', met: true, evidence: '有两块' }] })
    expect(answered.status).toBe(200)
    const outcome = await answered.json() as { outcome: string; reason: string }
    expect(outcome.outcome).toBe('refused')
    expect(control!.projects()).toEqual([])
  })

  it('creates nothing at all for a request that only chats or asks about a plan', async () => {
    await open()
    // A greeting, a joke and an explanation of a plan: three requests that ask for no work.
    for (const text of ['你好', '聊个笑话', '解释一下这个重构方案']) {
      const requestId = await ask(text)
      const answered = await gate(requestId, PARALLEL_DECISION)
      expect(answered.status).toBe(200)
      const outcome = await answered.json() as { outcome: string; reason: string }
      expect(outcome.outcome).toBe('refused')
      expect(['no_work_instruction', 'discussion_only']).toContain(outcome.reason)
    }
    // No Project, no PM, no Ticket, no Session: nothing happened at all.
    expect(control!.projects()).toEqual([])
    expect(control!.tickets()).toEqual([])
    expect(node.commands.some(command => command.type === 'pm.ensure')).toBe(false)
    expect((await gates()).every(record => record.outcome === 'refused')).toBe(true)
  })

  it('creates nothing at all for a decision that leaves the request behind', async () => {
    await open()
    const requestId = await ask('把官网首页和文档站一起改完')
    // Four true findings, and a piece of work the request never mentions.
    const answered = await gate(requestId, { ...SECOND_PARALLEL_DECISION, requestAnchor: '把官网首页和文档站一起改完' })
    expect(answered.status).toBe(200)
    const outcome = await answered.json() as { outcome: string; reason: string }
    expect(outcome.outcome).toBe('refused')
    expect(outcome.reason).toBe('module_anchor_not_in_request')
    expect(control!.projects()).toEqual([])
    expect(control!.tickets()).toEqual([])
    expect(node.commands.some(command => command.type === 'pm.ensure')).toBe(false)
  })

  it('creates one Project for one request, however often the decision is repeated', async () => {
    await open()
    const requestId = await ask('把官网首页和文档站一起改完')
    const [first, replay] = await Promise.all([gate(requestId, PARALLEL_DECISION), gate(requestId, PARALLEL_DECISION)])
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    const made = await first.json() as { project: { id: string } }
    expect(await replay.json()).toMatchObject({ outcome: 'created', project: { id: made.project.id } })
    expect(control!.projects()).toHaveLength(1)
    expect(node.commands.filter(command => command.type === 'pm.ensure')).toHaveLength(1)
    // One decision, one record: the second call did not write a second "creating" row.
    expect(await gates()).toHaveLength(1)
  })

  it('gives one request one result: no second Ticket, no other Project, and the same Project may be tended', async () => {
    await open()
    const requestId = await ask('把官网首页和文档站一起改完')
    const answered = await gate(requestId, PARALLEL_DECISION)
    expect(answered.status).toBe(200)
    const made = await answered.json() as { project: { id: string; title: string; goal: string } }

    // The request may not dispatch a second, independent Ticket.
    expect((await dispatch(requestId, '别的事', '另一件工作')).status).toBe(400)
    // It may not manage another Project either.
    expect((await manage(requestId, 'archive_project', 'some-other-project')).status).toBe(400)
    // It may not make a second Project with another title.
    expect((await createProject(requestId, '另一个项目', '另一件工作')).status).toBe(400)

    // The Project it made is its own: the PM may be started again and one relay may be proposed to it.
    const started = await createProject(requestId, made.project.title, made.project.goal)
    expect(started.status).toBe(200)
    expect((await started.json() as { project: { id: string } }).project.id).toBe(made.project.id)
    expect((await propose(requestId, made.project.id, '先做首页模块')).status).toBe(200)

    expect(control!.projects()).toHaveLength(1)
    expect(control!.tickets()).toEqual([])
  })

  it('refuses a gate decision for a request that already created a Project by the person\'s own words', async () => {
    await open()
    const requestId = await ask('创建一个项目「官网改版」，把首页和文档站一起改完')
    const created = await createProject(requestId, '官网改版', '把首页和文档站一起改完')
    expect(created.status).toBe(200)
    const made = await created.json() as { project: { id: string } }

    // The gate may not add a second Project to the same request.
    const answered = await gate(requestId, PARALLEL_DECISION)
    expect(answered.status).toBe(400)
    expect(control!.projects()).toHaveLength(1)
    expect(control!.projects()[0]!.id).toBe(made.project.id)
    expect(await gates()).toEqual([])
  })

  it('answers the same request with the durable receipt after a restart, and creates nothing', async () => {
    await open()
    const requestId = await ask('把官网首页和文档站一起改完')
    const answered = await gate(requestId, PARALLEL_DECISION)
    expect(answered.status).toBe(200)
    const made = await answered.json() as { project: { id: string } }
    const ensures = node.commands.filter(command => command.type === 'pm.ensure').length

    await reopen()
    // The request is gone with the process, but the decision really ran: the same request id is answered with the
    // receipt that was written down, and nothing is created and no command is sent.
    const replay = await gate(requestId, PARALLEL_DECISION)
    expect(replay.status).toBe(200)
    const outcome = await replay.json() as { outcome: string; project: { id: string } }
    expect(outcome.outcome).toBe('created')
    expect(outcome.project.id).toBe(made.project.id)
    expect(control!.projects()).toHaveLength(1)
    expect(node.commands.filter(command => command.type === 'pm.ensure')).toHaveLength(ensures)
    // The record of the old decision is still there to read.
    const records = await gates()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ requestId, outcome: 'created', projectId: made.project.id })
  })

  it('gives an unknown request no authority at all', async () => {
    await open()
    await control!.ensureRouter()
    const answered = await gate('router-req-00000000-0000-4000-8000-000000000000', PARALLEL_DECISION)
    expect(answered.status).toBe(400)
    expect(control!.projects()).toEqual([])
    expect(await gates()).toEqual([])
  })

  it('answers a decision that was left half-made with the truth the domain holds', async () => {
    await open()
    const requestId = await ask('创建一个项目「官网改版」，把首页和文档站一起改完')
    const created = await createProject(requestId, '官网改版', '把首页和文档站一起改完')
    expect(created.status).toBe(200)
    const made = await created.json() as { project: { id: string } }

    // The control plane stopped between writing the decision down and finishing it.
    await server?.close().catch(() => {})
    server = undefined
    await control?.close().catch(() => {})
    control = undefined
    leaveHalfMadeDecision(requestId, '创建一个项目「官网改版」，把首页和文档站一起改完')

    await reopen()
    // The Project of this request really exists, so the decision is answered with it — and nothing is made twice.
    const answered = await gate(requestId, PARALLEL_DECISION)
    expect(answered.status).toBe(200)
    const outcome = await answered.json() as { outcome: string; project: { id: string } }
    expect(outcome.outcome).toBe('created')
    expect(outcome.project.id).toBe(made.project.id)
    expect(control!.projects()).toHaveLength(1)
  })

  it('refuses a decision that was left half-made and cannot be confirmed, and never makes it again', async () => {
    await open()
    const requestId = await ask('把官网首页和文档站一起改完')

    // The control plane stopped between writing the decision down and creating the Project.
    await server?.close().catch(() => {})
    server = undefined
    await control?.close().catch(() => {})
    control = undefined
    leaveHalfMadeDecision(requestId, '把官网首页和文档站一起改完')

    await reopen()
    // Nothing can be confirmed, so the decision is refused rather than carried out again.
    const answered = await gate(requestId, PARALLEL_DECISION)
    expect(answered.status).toBe(200)
    const outcome = await answered.json() as { outcome: string; reason: string }
    expect(outcome.outcome).toBe('refused')
    expect(outcome.reason).toBe('creation_unconfirmed')
    expect(control!.projects()).toEqual([])
    expect(node.commands.some(command => command.type === 'pm.ensure')).toBe(false)
  })

  it('does not build a second Project for a request that names one that already exists', async () => {
    await open()
    const existing = await projectWithPm('官网改版')
    const requestId = await ask('把项目「官网改版」的首页和文档站一起改完')
    const answered = await gate(requestId, { ...PARALLEL_DECISION, title: '官网改版二' })
    expect(answered.status).toBe(200)
    const outcome = await answered.json() as { outcome: string; reason: string; existingProject: { id: string } }
    expect(outcome.outcome).toBe('refused')
    expect(outcome.reason).toBe('existing_project')
    expect(outcome.existingProject.id).toBe(existing.projectId)
    expect(control!.projects()).toHaveLength(1)
    expect((await gates())[0]).toMatchObject({ outcome: 'refused', reason: 'existing_project' })
  })

  it('keeps the human\'s own request for a Project working, and the gate out of it', async () => {
    await open()
    const requestId = await ask('创建一个项目「官网改版」，把首页和文档站一起改完')
    const answered = await createProject(requestId, '官网改版', '把首页和文档站一起改完')
    expect(answered.status).toBe(200)
    const made = await answered.json() as { project: { id: string }; pm: { sessionId: string } }
    expect(made.project.id).toBeTruthy()
    expect(made.pm.sessionId).toBe(`pm-${made.project.id}`)
    expect(control!.projects()).toHaveLength(1)
    // The gate was never asked: a person who asked for a Project gets one without the four conditions.
    expect(await gates()).toEqual([])
  })

  it('refuses to create a Project for a request that never asked for one', async () => {
    await open()
    const requestId = await ask('把官网首页和文档站一起改完')
    const answered = await createProject(requestId, '官网改版', '把首页和文档站一起改完')
    expect(answered.status).toBe(400)
    expect(await answered.json()).toMatchObject({ error: expect.stringContaining('control_router_project_gate') })
    expect(control!.projects()).toEqual([])
  })

  it('records the way a message travelled: a rule that acted, and a model that answered', async () => {
    await open()
    await projectWithPm('周报整理')
    await projectWithPm('月报')
    // A message the rules carried out themselves: no model turn starts for it.
    const fast = await post('/v1/console/router/message', { text: '创建一个隔离的示例文件 hello.txt，写入 hello。' })
    expect(fast.status).toBe(200)
    await vi.waitFor(() => expect(control!.tickets()).toHaveLength(1), { timeout: 5000 })
    expect(node.commands.some(command => command.type === 'session.message' && command.sessionId === 'router')).toBe(false)

    // An ordinary conversation and an escalation are both recorded, and both name why.
    await ask('现在有什么在跑？')
    await ask('同时告诉项目「周报整理」和项目「月报」把登录改成 SSO')
    const state = (await (await get('/v1/console/router')).json()) as {
      routes?: { path: string; outcome: string; reason: string }[]
    }
    const model = (state.routes ?? []).filter(receipt => receipt.path === 'model')
    expect(model.map(receipt => receipt.reason)).toEqual(['question', 'multiple_targets'])
    expect(model.every(receipt => receipt.outcome === 'escalate' || receipt.outcome === 'ordinary_reply')).toBe(true)
    expect((state.routes ?? []).some(receipt => receipt.path === 'fast')).toBe(true)
  })
})
