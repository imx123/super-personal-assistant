/**
 * 1B sign-off: the control-plane tool API that PM and Worker Sessions call with their own Session tokens, and the DSH
 * proxy tools the node registers for them.
 *
 * Two layers are covered: the HTTP routes over a real `ControlPlaneServer` (identity, Project/Ticket/Assignment rules,
 * status codes) and the node's `control_report` / `control_create_tickets` execution against a fake Agent tool registry
 * and a recorded `fetch`. One test wires the two together against the real server.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket, Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { PM_PROFILE, WORKER_PROFILE } from '../src/control/roles.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { createDshPortHost, type DshPortFetch } from '../src/node/dsh-port-host.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { issueSessionToken } from '../src/shared/session-token.ts'
import type { SessionRecord } from '../src/shared/protocol.ts'

const SECRET = 'tools-secret'
const API_TOKEN = 'tools-api-token'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode

function trigger(id: string): Trigger {
  return { id, source: 'main-session', threads: [{ source: 'main-session', id: `thread-${id}` }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

/** Wait for the asynchronous Executor callbacks to settle the Store. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface Opened {
  project: ProjectProfile
  pm: SessionRecord
  ticket: Ticket
  assignment: Assignment
  address: { url: string }
}

/** A Project whose PM and first Worker Session exist on the FakeNode, plus the tool API listening on a random port. */
async function open(): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-tools-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
  await control.registerNode()
  control.store.triggers.save(trigger('trigger-1'))
  const project = control.createProject('trigger-1', 'Project', 'Goal')
  const pm = await control.openProject(project.id)
  const [created] = control.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Ticket', goal: 'Do it' }])
  const assignment = created!.assignments[0]!
  await until(() => control!.store.tickets.get(created!.id)?.assignments.at(-1)?.state === 'running',
    'the Assignment did not start')
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  const address = await server.listen(0)
  return { project, pm, ticket: control.store.tickets.get(created!.id)!, assignment, address }
}

function tokenOf(sessionId: string): string {
  const token = node.tokens.get(sessionId)
  if (!token) throw new Error(`The FakeNode has no token for ${sessionId}`)
  return token
}

function post(address: { url: string }, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function get(address: { url: string }, path: string, token: string): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane tool API', () => {
  it('lets a PM create Tickets in its own Project', async () => {
    const { project, pm, address } = await open()

    const response = await post(address, '/v1/tools/pm/tickets', tokenOf(pm.sessionId), { tasks: [
      { title: 'Second', goal: 'Ship the second part', scope: 'only the API', note: 'route to the worker',
        threads: ['main-session:thread-2'] },
    ] })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { tickets: Ticket[] }
    expect(body.tickets).toHaveLength(1)
    const [ticket] = body.tickets
    expect(ticket).toMatchObject({ projectId: project.id, title: 'Second' })
    // The Ticket is real Engine state, not just an HTTP echo.
    expect(control!.store.tickets.get(ticket!.id)).toMatchObject({ projectId: project.id, title: 'Second' })
    expect(control!.store.triggers.get(ticket!.origin.triggerId)?.meta).toMatchObject({ title: 'Second',
      goal: 'Ship the second part', scope: 'only the API', note: 'route to the worker' })
  })

  it('creates Tickets in the Project its token names, not in another Project', async () => {
    const { address } = await open()
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const otherPm = await control!.openProject(other.id)

    const response = await post(address, '/v1/tools/pm/tickets', tokenOf(otherPm.sessionId),
      { tasks: [{ title: 'Only other', goal: 'G' }] })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { tickets: Ticket[] }
    expect(body.tickets[0]).toMatchObject({ projectId: other.id })
    expect(control!.store.tickets.get(body.tickets[0]!.id)?.projectId).toBe(other.id)
  })

  it('writes a Worker report onto the same Ticket and current Assignment', async () => {
    const { ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    const response = await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      assignmentId: assignment.id, report: { state: 'progress', summary: 'halfway there' } })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { ticket: Ticket }
    expect(body.ticket.id).toBe(ticket.id)
    expect(body.ticket.assignments.at(-1)?.id).toBe(assignment.id)
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.report)
      .toMatchObject({ state: 'progress', summary: 'halfway there' })
  })

  it('accepts a question with a blocked report and clears it with null', async () => {
    const { ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`

    const blocked = await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      report: { state: 'blocked', summary: 'needs a decision', question: 'Which branch?' } })
    expect(blocked.status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.attention).toMatchObject({ question: 'Which branch?' })

    const cleared = await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      report: { state: 'progress', summary: 'decided', question: null } })
    expect(cleared.status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.attention).toBeUndefined()
  })

  it('refuses the operator token, a wrong role, an expired token and an unknown Session', async () => {
    const { project, pm, ticket, assignment, address } = await open()
    const pmPath = '/v1/tools/pm/tickets'
    const workerPath = '/v1/tools/worker/report'
    const pmBody = { tasks: [{ title: 'T', goal: 'G' }] }
    const workerBody = { ticketId: ticket.id, report: { state: 'progress', summary: 's' } }

    // The control-plane API token is not a Session token and must never open a tool route.
    expect((await post(address, pmPath, API_TOKEN, pmBody)).status).toBe(401)
    // A Worker token cannot create Tickets; a PM token cannot report.
    expect((await post(address, pmPath, tokenOf(`worker-${assignment.id}`), pmBody)).status).toBe(403)
    expect((await post(address, workerPath, tokenOf(pm.sessionId), workerBody)).status).toBe(403)
    // A tampered signature is not trusted.
    expect((await post(address, pmPath, `${tokenOf(pm.sessionId)}x`, pmBody)).status).toBe(401)
    // An expired token is rejected even though its signature is valid.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const expired = issueSessionToken({ sid: pm.sessionId, pid: project.id, role: 'pm', backend: 'dsh', nodeId: NODE_ID },
      SECRET, 60, nowSeconds - 120)
    expect((await post(address, pmPath, expired, pmBody)).status).toBe(401)
    // A signed token for a Session this kernel does not know is refused too.
    const ghost = issueSessionToken({ sid: 'pm-ghost', pid: project.id, role: 'pm', backend: 'dsh', nodeId: NODE_ID },
      SECRET, 600)
    expect((await post(address, pmPath, ghost, pmBody)).status).toBe(401)
  })

  it('refuses an unknown or foreign Ticket, another Assignment and an invalid report', async () => {
    const { pm, ticket, assignment, address } = await open()
    const worker = `worker-${assignment.id}`
    const workerToken = tokenOf(worker)

    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: 'ticket-ghost',
      report: { state: 'progress', summary: 's' } })).status).toBe(400)
    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id, assignmentId: 'other',
      report: { state: 'progress', summary: 's' } })).status).toBe(403)
    // `waiting` is the Executor's state, never a Worker's claim.
    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id,
      report: { state: 'waiting', summary: 's' } })).status).toBe(400)
    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id,
      report: { state: 'progress', summary: '   ' } })).status).toBe(400)

    // A Ticket of another Project is unknown from this Worker's point of view.
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const [foreign] = control!.engine.createProjectTickets(other.id, other.pmSessionId, [{ title: 'Other', goal: 'G' }])
    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: foreign!.id,
      report: { state: 'progress', summary: 's' } })).status).toBe(400)

    // The PM path validates its own body before the Engine sees it.
    expect((await post(address, '/v1/tools/pm/tickets', tokenOf(pm.sessionId), { tasks: [] })).status).toBe(400)
    expect((await post(address, '/v1/tools/pm/tickets', tokenOf(pm.sessionId),
      { tasks: [{ title: 'T' }] })).status).toBe(400)
  })

  it('gives a PM its own Project and Tickets, and never another Project', async () => {
    const { project, pm, ticket, assignment, address } = await open()

    const response = await get(address, '/v1/tools/pm/context', tokenOf(pm.sessionId))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { project: Record<string, unknown>
      tickets: { id: string; title: string; status: string; assignment?: Record<string, unknown> }[] }

    // Exactly the safe Project fields: no Mandate, PM Session id, token or internal actor.
    expect(body.project).toEqual({ id: project.id, title: 'Project', goal: 'Goal', status: 'active' })
    expect(body.tickets).toHaveLength(1)
    expect(body.tickets[0]).toMatchObject({ id: ticket.id, title: 'Ticket', status: 'running' })
    expect(Object.keys(body.tickets[0]!).sort()).toEqual(['assignment', 'id', 'status', 'title'])
    expect(body.tickets[0]!.assignment).toEqual({ id: assignment.id, state: 'running' })

    // Another PM reads its own Project only: this Project's Ticket never appears in it.
    control!.store.triggers.save(trigger('trigger-2'))
    const other = control!.createProject('trigger-2', 'Other', 'Other goal')
    const otherPm = await control!.openProject(other.id)
    const [foreign] = control!.engine.createProjectTickets(other.id, otherPm.sessionId, [{ title: 'Foreign', goal: 'G' }])
    const otherBody = (await (await get(address, '/v1/tools/pm/context', tokenOf(otherPm.sessionId))).json()) as typeof body
    expect(otherBody.project.id).toBe(other.id)
    expect(otherBody.tickets.map(item => item.id)).toEqual([foreign!.id])
    expect(otherBody.tickets.map(item => item.id)).not.toContain(ticket.id)

    // A Worker token cannot read the PM context, and the operator token is not a Session token at all.
    expect((await get(address, '/v1/tools/pm/context', tokenOf(`worker-${assignment.id}`))).status).toBe(403)
    expect((await get(address, '/v1/tools/pm/context', API_TOKEN)).status).toBe(401)
  })

  it('derives the Ticket status a PM reads', async () => {
    const { project, pm, ticket, assignment, address } = await open()
    const workerToken = tokenOf(`worker-${assignment.id}`)
    const status = async (): Promise<string> => {
      const response = await get(address, '/v1/tools/pm/context', tokenOf(pm.sessionId))
      expect(response.status).toBe(200)
      const body = (await response.json()) as { tickets: { id: string; status: string }[] }
      return body.tickets.find(item => item.id === ticket.id)!.status
    }

    expect(await status()).toBe('running')

    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id,
      report: { state: 'blocked', summary: 'needs a person' } })).status).toBe(200)
    expect(await status()).toBe('blocked')

    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id,
      report: { state: 'progress', summary: 'unblocked' } })).status).toBe(200)
    expect(await status()).toBe('running')

    expect((await post(address, '/v1/tools/worker/report', workerToken, { ticketId: ticket.id,
      report: { state: 'ready', summary: 'done' } })).status).toBe(200)
    expect(await status()).toBe('completed')

    // An archived Project Ticket reads as archived, ahead of the end state it still records.
    control!.store.tickets.save({ ...control!.store.tickets.get(ticket.id)!,
      archived: { at: START, by: 'project', projectId: project.id } })
    expect(await status()).toBe('archived')
  })

  it('names the control tools in the role profiles', () => {
    expect(PM_PROFILE.tools).toContain('control_project')
    expect(PM_PROFILE.prompt).toContain('control_project')
    expect(PM_PROFILE.tools).toContain('control_create_tickets')
    expect(PM_PROFILE.prompt).toContain('control_create_tickets')
    expect(WORKER_PROFILE.tools).toContain('control_report')
    expect(WORKER_PROFILE.prompt).toContain('control_report')
  })
})

/** One tool the host registered into the fake Agent's scoped registry. */
interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

/** A DSH Agent stand-in with exactly the registry surface `createDshPortHost` uses. */
class FakeAgent {
  readonly tools = new Map<string, RegisteredTool>()
  registrations = 0
  readonly ctx = { tools: { register: (definition: RegisteredTool): (() => void) => {
    this.registrations++
    this.tools.set(definition.name, definition)
    return () => { this.tools.delete(definition.name) }
  } } }
}

interface RecordedCall {
  url: string
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
}

/** A recorded fetch whose answers a test supplies. */
function recorder(answer: (call: RecordedCall) => { ok: boolean; status: number; text(): Promise<string> }): {
  calls: RecordedCall[]
  fetch: DshPortFetch
} {
  const calls: RecordedCall[] = []
  const fetch: DshPortFetch = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return answer(call)
  }
  return { calls, fetch }
}

function jsonAnswer(value: unknown, status = 200): { ok: boolean; status: number; text(): Promise<string> } {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) }
}

/** A node root for the host's workspace check. */
function nodeRoot(): string {
  directory = mkdtempSync(join(tmpdir(), 'superagent-tool-host-'))
  const root = join(directory, 'node')
  mkdirSync(root, { recursive: true })
  return root
}

function toolHost(options: { root: string; controlUrl?: string; fetch?: DshPortFetch }): {
  host: ReturnType<typeof createDshPortHost>
  agents: Map<string, FakeAgent>
  prompts: { sessionId: string; key: string; text: string }[]
} {
  const agents = new Map<string, FakeAgent>()
  const prompts: { sessionId: string; key: string; text: string }[] = []
  const sessions = {
    async ensure(sessionId: string) {
      const agent = new FakeAgent()
      agents.set(sessionId, agent)
      return agent
    },
    async prompt(sessionId: string, key: string, text: string) { prompts.push({ sessionId, key, text }) },
  }
  const context = { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } }
  const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: 'node-1', root: options.root,
    ...(options.controlUrl === undefined ? {} : { controlUrl: options.controlUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
  return { host, agents, prompts }
}

const EXEC = { signal: new AbortController().signal }

describe('node control tools', () => {
  it('registers control_report and posts the report with the Session token', async () => {
    const root = nodeRoot()
    const { calls, fetch } = recorder(() => jsonAnswer({ ticket: { id: 'ticket-1' } }))
    const { host, agents, prompts } = toolHost({ root, controlUrl: 'http://control.test/', fetch })

    await host.ensureSession({ sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
      prompt: WORKER_PROFILE.prompt, sessionToken: 'worker-token', ticketId: 'ticket-1', assignmentId: 'assignment-1' })

    const agent = agents.get('worker-1')!
    expect([...agent.tools.keys()]).toEqual(['control_report'])
    // The usage note rides the role prompt, so the first turn knows the tool and this Session's Ticket.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.sessionId).toBe('worker-1')
    expect(prompts[0]!.key).toBe('profile:worker-1')
    expect(prompts[0]!.text).toContain(WORKER_PROFILE.prompt)
    expect(prompts[0]!.text).toContain('Use control_report')
    expect(prompts[0]!.text).toContain('Ticket ticket-1')
    expect(prompts[0]!.text).toContain('Assignment assignment-1')

    const tool = agent.tools.get('control_report')!
    const result = await tool.execute({ ticketId: 'ticket-1', state: 'progress', summary: 'halfway' }, EXEC)
    expect(result).toEqual({ ticket: { id: 'ticket-1' } })
    expect(calls).toHaveLength(1)
    // A trailing slash on the configured URL must not double up.
    expect(calls[0]!.url).toBe('http://control.test/v1/tools/worker/report')
    expect(calls[0]!.init).toMatchObject({ method: 'POST',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' } })
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ ticketId: 'ticket-1', assignmentId: 'assignment-1',
      report: { state: 'progress', summary: 'halfway' } })
  })

  it('registers control_create_tickets and posts the tasks', async () => {
    const root = nodeRoot()
    const { calls, fetch } = recorder(() => jsonAnswer({ tickets: [{ id: 'ticket-2' }] }))
    const { host, agents } = toolHost({ root, controlUrl: 'http://control.test', fetch })

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })

    const tool = agents.get('pm-1')!.tools.get('control_create_tickets')!
    const result = await tool.execute({ tasks: [{ title: 'T', goal: 'G', scope: 'S' }] }, EXEC)
    expect(result).toEqual({ tickets: [{ id: 'ticket-2' }] })
    expect(calls[0]!.url).toBe('http://control.test/v1/tools/pm/tickets')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer pm-token')
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ tasks: [{ title: 'T', goal: 'G', scope: 'S' }] })
  })

  it('registers control_project beside control_create_tickets and reads the context with a GET', async () => {
    const root = nodeRoot()
    const context = { project: { id: 'project-1', title: 'Project', goal: 'Goal', status: 'active' }, tickets: [
      { id: 'ticket-1', title: 'Ticket', status: 'running', assignment: { id: 'assignment-1', state: 'running' } }] }
    const { calls, fetch } = recorder(() => jsonAnswer(context))
    const { host, agents, prompts } = toolHost({ root, controlUrl: 'http://control.test', fetch })

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })

    const agent = agents.get('pm-1')!
    expect([...agent.tools.keys()]).toEqual(['control_project', 'control_create_tickets'])
    // The usage note names both tools, so the PM's first turn knows how to read and how to create.
    expect(prompts[0]!.text).toContain('Use control_project')
    expect(prompts[0]!.text).toContain('control_create_tickets')

    const tool = agent.tools.get('control_project')!
    expect(tool.parameters).toEqual({ type: 'object', additionalProperties: false, properties: {} })
    await expect(tool.execute({}, EXEC)).resolves.toEqual(context)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://control.test/v1/tools/pm/context')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.headers).toEqual({ authorization: 'Bearer pm-token' })
    // A GET must not carry a body at all, not even an empty one.
    expect(calls[0]!.init.body).toBeUndefined()
  })

  it('propagates a refused context read', async () => {
    const root = nodeRoot()
    const { fetch } = recorder(() => jsonAnswer({ error: 'A PM Session token is required' }, 403))
    const { host, agents } = toolHost({ root, controlUrl: 'http://control.test', fetch })
    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })

    await expect(agents.get('pm-1')!.tools.get('control_project')!.execute({}, EXEC))
      .rejects.toThrow('A PM Session token is required')
  })

  it('propagates the control plane refusal instead of swallowing it', async () => {
    const root = nodeRoot()
    const { fetch } = recorder(() => jsonAnswer({ error: 'Unknown ticket ticket-9' }, 400))
    const { host, agents } = toolHost({ root, controlUrl: 'http://control.test', fetch })
    await host.ensureSession({ sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
      prompt: WORKER_PROFILE.prompt, sessionToken: 'worker-token', ticketId: 'ticket-1', assignmentId: 'assignment-1' })

    await expect(agents.get('worker-1')!.tools.get('control_report')!.execute({ ticketId: 'ticket-9',
      state: 'progress', summary: 's' }, EXEC)).rejects.toThrow('Unknown ticket ticket-9')
  })

  it('keeps one registration per Agent and refreshes the token on a repeated ensure', async () => {
    const root = nodeRoot()
    const { calls, fetch } = recorder(() => jsonAnswer({ ticket: { id: 'ticket-1' } }))
    const { host, agents } = toolHost({ root, controlUrl: 'http://control.test', fetch })

    await host.ensureSession({ sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
      prompt: WORKER_PROFILE.prompt, sessionToken: 'first-token', ticketId: 'ticket-1', assignmentId: 'assignment-1' })
    await host.ensureSession({ sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
      prompt: WORKER_PROFILE.prompt, sessionToken: 'second-token', ticketId: 'ticket-1', assignmentId: 'assignment-1' })

    const agent = agents.get('worker-1')!
    // DSH refuses a duplicate tool name in one Agent layer, so the second ensure must not register again.
    expect(agent.registrations).toBe(1)
    await agent.tools.get('control_report')!.execute({ ticketId: 'ticket-1', state: 'progress', summary: 's' }, EXEC)
    expect(calls[0]!.init.headers.authorization).toBe('Bearer second-token')
  })

  it('registers nothing and sends no note without a control URL', async () => {
    const root = nodeRoot()
    const { host, agents, prompts } = toolHost({ root })

    await host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })

    expect(agents.get('pm-1')!.tools.size).toBe(0)
    expect(prompts).toEqual([{ sessionId: 'pm-1', key: 'profile:pm-1', text: PM_PROFILE.prompt }])
  })

  it('fails the ensure when the Agent has no tool registry, so inspection reports why', async () => {
    const root = nodeRoot()
    const sessions = { async ensure(sessionId: string) { return { id: sessionId } }, async prompt() {} }
    const context = { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } }
    const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: 'node-1', root,
      controlUrl: 'http://control.test', fetch: async () => jsonAnswer({}) })

    await expect(host.ensureSession({ sessionId: 'pm-1', workspace: 'project-1', title: 'Project', role: 'pm',
      prompt: PM_PROFILE.prompt, sessionToken: 'pm-token' })).rejects.toThrow('no tool registry')
    await expect(host.inspectSession('pm-1')).resolves.toMatchObject({ sessionId: 'pm-1', found: true, ready: false,
      error: expect.stringContaining('no tool registry') })
  })

  it('drives the real control-plane route from the registered control_report tool', async () => {
    const { project, ticket, assignment, address } = await open()
    const workerSession = `worker-${assignment.id}`
    const root = join(directory, 'node')
    mkdirSync(root, { recursive: true })
    const { host, agents } = toolHost({ root, controlUrl: address.url })

    await host.ensureSession({ sessionId: workerSession, workspace: join(root, project.id), title: 'Worker',
      role: 'worker', prompt: WORKER_PROFILE.prompt, sessionToken: tokenOf(workerSession), ticketId: ticket.id,
      assignmentId: assignment.id })

    const result = await agents.get(workerSession)!.tools.get('control_report')!
      .execute({ ticketId: ticket.id, state: 'progress', summary: 'from the tool' }, EXEC)

    expect(result).toMatchObject({ ticket: { id: ticket.id } })
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.report)
      .toMatchObject({ state: 'progress', summary: 'from the tool' })
  })
})
