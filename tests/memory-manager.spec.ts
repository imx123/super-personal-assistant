/**
 * The memory manager: the queue of reviews, the authority of the system role that runs them, and the daily inspection.
 *
 * The rules that are easier to state as records than as a running control plane are exercised on their own: the job
 * queue, the generations a job is bound to, and the refusals a stale, a foreign or a finished call meets. Everything that
 * has to happen through the real paths — the node really registering the tools, the manager really being woken, the
 * decision really reaching the memory service, the inspection really writing down what it did — is exercised against a
 * running control plane and a real `FakeNode`.
 *
 * Nothing here pretends a run that did not happen: a review that was refused, an inspection whose node was offline and
 * an inspection the control plane was interrupted in the middle of all say what they are.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane, MEMORY_MANAGER_SESSION_ID } from '../src/control/control-plane.ts'
import { MEMORY_MANAGER_PROFILE, PM_PROFILE, ROUTER_PROFILE, WORKER_PROFILE } from '../src/control/roles.ts'
import { MEMORY_MANAGER_TOOLS, MemoryManager, type MemoryManagerHost, type MemoryManagerSession } from '../src/memory/memory-manager.ts'
import { createDshPortHost, type DshPortFetch } from '../src/node/dsh-port-host.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import type { NodeCommand } from '../src/shared/protocol.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'

const API_TOKEN = 'manager-api-token'
const VIEWER_TOKEN = 'manager-viewer-token'
const SECRET = 'manager-secret'
const START = '2026-11-19T08:00:00.000Z'
const NODE_ID = 'local'
/** A message id the Router may quote: the person really wrote it. */
const PERSON_MESSAGE = 'router-msg-11111111-1111-4111-8111-111111111111'
/** The id of that message, as the person sent it. */
const PERSON_REQUEST = '11111111-1111-4111-8111-111111111111'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode | undefined

/** Wait for an asynchronous step of the control plane to settle. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  node = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

// ─── the role ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the memory manager role', () => {
  it('holds the four review tools and nothing else', () => {
    expect(MEMORY_MANAGER_PROFILE.name).toBe('memory_manager.v1')
    expect([...MEMORY_MANAGER_PROFILE.tools]).toEqual([...MEMORY_MANAGER_TOOLS])
    const tools = [...MEMORY_MANAGER_PROFILE.tools] as string[]
    // The four tools are the review, the query, the decision and the bounded return — and nothing else.
    expect(tools).toContain('memory_service_review_candidate')
    expect(tools).toContain('memory_service_search_memories')
    expect(tools).toContain('memory_service_decide')
    expect(tools).toContain('memory_service_return_candidate')
    // No workspace, no terminal, no network, no dispatch, no control and no message of its own.
    for (const forbidden of ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'web_search', 'web_fetch',
      'subagent', 'send_message', 'control_report', 'control_create_tickets', 'control_project',
      'control_message_worker', 'control_live_state', 'control_event_history_query', 'control_memory_search',
      'control_memory_propose']) {
      expect(tools, forbidden).not.toContain(forbidden)
    }
    const denied = [...MEMORY_MANAGER_PROFILE.deny] as string[]
    expect(denied).toContain('write')
    expect(denied).toContain('bash')
    expect(MEMORY_MANAGER_PROFILE.permission).toBe('read-only')
  })

  it('gives the other roles their own tools and the proposal path, and the Worker nothing new', () => {
    expect([...PM_PROFILE.tools] as string[]).toContain('control_memory_propose')
    expect([...ROUTER_PROFILE.tools] as string[]).toContain('control_memory_propose')
    // The Worker's report semantics are unchanged: it proposes nothing and decides nothing.
    expect([...WORKER_PROFILE.tools] as string[]).not.toContain('control_memory_propose')
    expect([...WORKER_PROFILE.tools] as string[]).not.toContain('memory_service_decide')
  })

  it('registers exactly the four tools on the manager Session of a real node', async () => {
    class FakeAgent {
      readonly tools = new Map<string, { name: string; description: string; parameters: unknown
        execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }>()
      readonly ctx = { tools: { register: (definition: { name: string; description: string; parameters: unknown
        execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }): (() => void) => {
        this.tools.set(definition.name, definition)
        return () => { this.tools.delete(definition.name) }
      } } }
    }

    directory = mkdtempSync(join(tmpdir(), 'superagent-manager-node-'))
    const root = join(directory, 'node')
    mkdirSync(root, { recursive: true })
    const agents = new Map<string, FakeAgent>()
    const sessions = {
      async ensure(sessionId: string) {
        const agent = new FakeAgent()
        agents.set(sessionId, agent)
        return agent
      },
      async prompt() { /* the fake node has no model */ },
    }
    const fetchImpl: DshPortFetch = async () => ({ ok: true, status: 200, text: async () => '{}' })
    const host = createDshPortHost({ context: { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } },
      nodeRuntime: { sessions }, nodeId: NODE_ID, root, controlUrl: 'http://control.test', fetch: fetchImpl })

    await host.ensureSession({ sessionId: MEMORY_MANAGER_SESSION_ID, workspace: join(root, 'w'), title: 'Memory Manager',
      role: 'manager', profile: MEMORY_MANAGER_PROFILE, prompt: MEMORY_MANAGER_PROFILE.prompt, sessionToken: 'token' })

    expect([...agents.get(MEMORY_MANAGER_SESSION_ID)!.tools.keys()]).toEqual([...MEMORY_MANAGER_TOOLS])
  })
})

// ─── the manager, on its own ───────────────────────────────────────────────────────────────────────────────────

describe('the memory manager, on its own', () => {
  /** The manager on its own: one SQLite file, one host, one clock the test moves by hand. */
  class Bench {
    readonly db = new DatabaseSync(':memory:')
    readonly manager: MemoryManager
    at = START
    epoch = 7
    online = true
    readonly sessions = new Map<string, MemoryManagerSession>()

    constructor() {
      this.manager = new MemoryManager(this.db, this.host())
    }

    host(): MemoryManagerHost {
      return {
        now: () => this.at,
        nodeId: () => NODE_ID,
        backendId: () => 'dsh',
        trustEpoch: () => this.epoch,
        nodeOnline: () => this.online,
        session: sessionId => this.sessions.get(sessionId),
      }
    }

    /** One Session the control plane really holds. */
    hold(session: MemoryManagerSession): void {
      this.sessions.set(session.sessionId, session)
    }
  }

  /** The manager Session, as the control plane holds it. */
  const manager = (over: Partial<MemoryManagerSession> = {}): MemoryManagerSession => ({
    sessionId: MEMORY_MANAGER_SESSION_ID, role: 'manager', nodeId: NODE_ID, toolProfile: 'memory_manager.v1',
    tokenVersion: 0, status: 'idle', ...over,
  })

  /** The caller, as the control plane authenticated it. */
  const caller = (over: Partial<{ sessionId: string; nodeId: string; tokenVersion: number; trustEpoch: number }> = {}) => ({
    sessionId: MEMORY_MANAGER_SESSION_ID, nodeId: NODE_ID, tokenVersion: 0, trustEpoch: 7, ...over,
  })

  it('prepares one job for one candidate and refuses a second one', () => {
    const bench = new Bench()
    const first = bench.manager.prepareReview({ candidateId: 'cand_1', checksum: 'sum-1', scopeType: 'project',
      scopeId: 'project:p1', sourceKeys: ['review:r1'] })
    expect(first.ok).toBe(true)
    const second = bench.manager.prepareReview({ candidateId: 'cand_1', checksum: 'sum-1', scopeType: 'project',
      scopeId: 'project:p1', sourceKeys: ['review:r1'] })
    expect(second.ok).toBe(false)
    expect(second.ok === false && second.code).toBe('REVIEW_ALREADY_ACTIVE')
  })

  it('binds the job to the Session it was dispatched to, under the generation of the node', () => {
    const bench = new Bench()
    const prepared = bench.manager.prepareReview({ candidateId: 'cand_1', checksum: 'sum-1', scopeType: 'project',
      scopeId: 'project:p1', sourceKeys: [] })
    if (!prepared.ok) throw new Error('the job was not prepared')
    const bound = bench.manager.bindDispatch(prepared.job.jobId, MEMORY_MANAGER_SESSION_ID)
    expect(bound.ok).toBe(true)
    expect(bound.ok && bound.job.sessionId).toBe(MEMORY_MANAGER_SESSION_ID)
    expect(bound.ok && bound.job.generation).toBe('7')
  })

  it('refuses a call that is not the Session the job was dispatched to', () => {
    const bench = new Bench()
    bench.hold(manager())
    const prepared = bench.manager.prepareReview({ candidateId: 'cand_1', checksum: 'sum-1', scopeType: 'project',
      scopeId: 'project:p1', sourceKeys: [] })
    if (!prepared.ok) throw new Error('the job was not prepared')
    bench.manager.bindDispatch(prepared.job.jobId, 'another-session')
    const answer = bench.manager.authorize(caller(), { jobId: prepared.job.jobId, candidateId: 'cand_1',
      checksum: 'sum-1' })
    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.code).toBe('JOB_NOT_BOUND')
  })

  it('refuses a call of an older generation, of a finished job and of another candidate', () => {
    const bench = new Bench()
    bench.hold(manager())
    const prepared = bench.manager.prepareReview({ candidateId: 'cand_1', checksum: 'sum-1', scopeType: 'project',
      scopeId: 'project:p1', sourceKeys: [] })
    if (!prepared.ok) throw new Error('the job was not prepared')
    bench.manager.bindDispatch(prepared.job.jobId, MEMORY_MANAGER_SESSION_ID)

    // The node re-registered: the job was prepared for an older generation.
    bench.epoch = 8
    const stale = bench.manager.authorize(caller({ trustEpoch: 8 }), { jobId: prepared.job.jobId, candidateId: 'cand_1',
      checksum: 'sum-1' })
    expect(stale.ok === false && stale.code).toBe('JOB_STALE')
    bench.epoch = 7

    // Another candidate and another version are refused as well.
    const other = bench.manager.authorize(caller(), { jobId: prepared.job.jobId, candidateId: 'cand_2',
      checksum: 'sum-1' })
    expect(other.ok === false && other.code).toBe('CANDIDATE_MISMATCH')
    const version = bench.manager.authorize(caller(), { jobId: prepared.job.jobId, candidateId: 'cand_1',
      checksum: 'sum-2' })
    expect(version.ok === false && version.code).toBe('CHECKSUM_MISMATCH')

    // A finished job is finished: it may not be finished twice.
    bench.manager.finishReview(prepared.job.jobId, 'completed', 'done')
    const finished = bench.manager.authorize(caller(), { jobId: prepared.job.jobId, candidateId: 'cand_1',
      checksum: 'sum-1' })
    expect(finished.ok === false && finished.code).toBe('JOB_FINISHED')
  })

  it('refuses a call whose candidate changed since the job was prepared', () => {
    const bench = new Bench()
    bench.hold(manager())
    const prepared = bench.manager.prepareReview({ candidateId: 'cand_1', checksum: 'sum-1', scopeType: 'project',
      scopeId: 'project:p1', sourceKeys: ['review:r1'] })
    if (!prepared.ok) throw new Error('the job was not prepared')
    bench.manager.bindDispatch(prepared.job.jobId, MEMORY_MANAGER_SESSION_ID)
    // The candidate now carries another version and another set of sources.
    const changed = bench.manager.authorize(caller(), { jobId: prepared.job.jobId, candidateId: 'cand_1',
      checksum: 'sum-1', live: { checksum: 'sum-9', sourceKeys: ['review:r1'] } })
    expect(changed.ok === false && changed.code).toBe('CHECKSUM_MISMATCH')
    const resourced = bench.manager.authorize(caller(), { jobId: prepared.job.jobId, candidateId: 'cand_1',
      checksum: 'sum-1', live: { checksum: 'sum-1', sourceKeys: ['review:r2'] } })
    expect(resourced.ok === false && resourced.code).toBe('SOURCE_MISMATCH')
  })

  it('refuses a revoked, a stopped, a foreign and an outdated Session', () => {
    const bench = new Bench()
    const prepared = bench.manager.prepareReview({ candidateId: 'cand_1', checksum: 'sum-1', scopeType: 'project',
      scopeId: 'project:p1', sourceKeys: [] })
    if (!prepared.ok) throw new Error('the job was not prepared')
    bench.manager.bindDispatch(prepared.job.jobId, MEMORY_MANAGER_SESSION_ID)

    bench.hold(manager({ revokedAt: START }))
    expect(bench.manager.authorize(caller(), { jobId: prepared.job.jobId, candidateId: 'cand_1', checksum: 'sum-1' })
      .ok === false).toBe(true)

    bench.hold(manager({ operatorStop: { at: START } }))
    const stopped = bench.manager.authorize(caller(), { jobId: prepared.job.jobId, candidateId: 'cand_1', checksum: 'sum-1' })
    expect(stopped.ok === false && stopped.code).toBe('SESSION_STOPPED')

    bench.hold(manager({ nodeId: 'another-node' }))
    const foreign = bench.manager.authorize(caller(), { jobId: prepared.job.jobId, candidateId: 'cand_1', checksum: 'sum-1' })
    expect(foreign.ok === false && foreign.code).toBe('SESSION_FOREIGN')

    bench.hold(manager({ tokenVersion: 3 }))
    const outdated = bench.manager.authorize(caller({ tokenVersion: 0 }), { jobId: prepared.job.jobId, candidateId: 'cand_1',
      checksum: 'sum-1' })
    expect(outdated.ok === false && outdated.code).toBe('SESSION_STALE')

    bench.hold(manager({ role: 'pm', toolProfile: 'pm.v1' }))
    const other = bench.manager.authorize(caller(), { jobId: prepared.job.jobId, candidateId: 'cand_1', checksum: 'sum-1' })
    expect(other.ok === false && other.code).toBe('NOT_A_MANAGER')
  })

  it('writes down an inspection that was under way when the process ended as interrupted', () => {
    const bench = new Bench()
    const started = bench.manager.startMaintenance({ runId: 'run-1', at: START, nextAt: START })
    expect(started.state).toBe('attempted')
    expect(bench.manager.interruptUnfinishedMaintenance()).toBe(1)
    const after = bench.manager.maintenanceById('run-1')!
    expect(after.state).toBe('interrupted')
    expect(after.finishedAt).not.toBe('')
    // A second start finds nothing left to interrupt.
    expect(bench.manager.interruptUnfinishedMaintenance()).toBe(0)
  })
})

// ─── the manager, through the control plane ─────────────────────────────────────────────────────────────────────

describe('the memory manager, through the control plane', () => {
  /**
   * A node that takes its time to bring the memory manager up.
   *
   * The inspection has a budget, and a node that is slow to answer the manager's ensure spends it: the run that ran out
   * of time is written down as unfinished, never as a success.
   */
  class SlowNode extends FakeNode {
    async send(command: NodeCommand): Promise<void> {
      if (command.type === 'memory_manager.ensure') {
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      await super.send(command)
    }
  }

  /** A control plane with a Router, a Project and its PM. */
  async function open(options: { memoryMaintenanceEnabled?: boolean; memoryMaintenanceTimeoutMs?: number;
    slowManager?: boolean; reviewTimeoutMs?: number; clock?: { at: string } } = {}):
  Promise<{ url: string; scopeId: string; pmSessionId: string }> {
    directory = mkdtempSync(join(tmpdir(), 'superagent-manager-plane-'))
    const root = join(directory, 'workspaces')
    node = options.slowManager
      ? new SlowNode({ nodeId: NODE_ID, root, now: () => START })
      : new FakeNode({ nodeId: NODE_ID, root, now: () => START })
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
      workspaceRoot: root, now: () => options.clock?.at ?? START, confirmationTimeoutMs: 50,
      ...(options.memoryMaintenanceEnabled === undefined ? {} : { memoryMaintenanceEnabled: options.memoryMaintenanceEnabled }),
      ...(options.memoryMaintenanceTimeoutMs === undefined ? {} : { memoryMaintenanceTimeoutMs: options.memoryMaintenanceTimeoutMs }),
      ...(options.reviewTimeoutMs === undefined ? {} : { memoryReviewTimeoutMs: options.reviewTimeoutMs }) })
    await control.registerNode()
    await control.ensureRouter()
    const project = control.createProjectFromOperator('记忆管理员', '让受限角色审一遍候选')
    const pm = await control.openProject(project.id)
    server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
    const address = await server.listen(0)
    return { url: address.url, scopeId: `project:${project.id}`, pmSessionId: pm.sessionId }
  }

  const get = (url: string, path: string, token: string): Promise<Response> =>
    fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } })

  const post = (url: string, path: string, token: string, body: unknown): Promise<Response> =>
    fetch(`${url}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body) })

  /** One candidate of the queue, as the console answered with it. */
  interface CandidateAnswer {
    candidateId: string
    checksum: string
    status: string
    sourceTrust: string
    returnedToSessionId: string
    revisionCount: number
    reevaluations: number
  }

  /**
   * The person's own words, which the Router may quote.
   *
   * The words are the ones the proposals quote: a fact that claims to be the person's own has to be found in the message
   * the person wrote, and the summary a proposer writes about that message is not the message.
   */
  async function personSays(): Promise<void> {
    await control!.sendToRouter('以后这个项目统一用 pnpm。这个项目统一用 pnpm，不要用 npm。', [], undefined,
      { id: PERSON_REQUEST })
    await until(() => (control!.routerState().queue ?? []).some(row => row.id === PERSON_MESSAGE),
      'the person\'s message was not recorded')
  }

  /** The job the manager was woken for. */
  async function jobOf(url: string, candidateId: string): Promise<{ jobId: string; state: string }> {
    const answer = await get(url, '/v1/console/memory/reviews', API_TOKEN)
    const rows = (await answer.json()) as { rows: { jobId: string; candidateId: string; state: string }[] }
    const row = rows.rows.find(entry => entry.candidateId === candidateId)
    if (row === undefined) throw new Error(`The candidate ${candidateId} has no review job`)
    return { jobId: row.jobId, state: row.state }
  }

  it('wakes the manager for a proposal, lets it read the candidate and decides about it', async () => {
    const { url, scopeId } = await open()
    await personSays()
    const routerToken = node!.tokens.get('router')!

    // The Router proposes the fact the person stated, and names the record it came from.
    const proposed = await post(url, '/v1/tools/memory/propose', routerToken,
      { content: '这个项目统一用 pnpm，不要用 npm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'operator_message', id: PERSON_MESSAGE, summary: '主窗口的原话' }] })
    expect(proposed.status).toBe(201)
    const candidate = (await proposed.json()) as { candidate: CandidateAnswer }
    expect(candidate.candidate.status).toBe('queued')
    expect(candidate.candidate.sourceTrust).toBe('operator_explicit')

    // The manager is woken on the node, under its own profile.
    await until(() => node!.commands.some(command => command.type === 'memory_manager.ensure'),
      'the memory manager was not woken')
    const ensured = node!.commands.find(command => command.type === 'memory_manager.ensure')!
    expect(ensured.type === 'memory_manager.ensure' && ensured.profile.name).toBe('memory_manager.v1')
    expect(ensured.type === 'memory_manager.ensure' && ensured.profile.tools).toEqual([...MEMORY_MANAGER_TOOLS])

    const job = await jobOf(url, candidate.candidate.candidateId)
    expect(job.state).toBe('dispatched')
    const managerToken = node!.tokens.get(MEMORY_MANAGER_SESSION_ID)!

    // The manager reads the candidate it was woken for.
    const review = await post(url, '/v1/tools/memory/review', managerToken, { jobId: job.jobId })
    expect(review.status).toBe(200)
    const reviewed = (await review.json()) as { candidate: CandidateAnswer; job: { candidateId: string } }
    expect(reviewed.job.candidateId).toBe(candidate.candidate.candidateId)
    expect(reviewed.candidate.checksum).toBe(candidate.candidate.checksum)

    // The search stays inside the scope of the candidate.
    const search = await post(url, '/v1/tools/memory/search', managerToken, { jobId: job.jobId, query: 'pnpm' })
    expect(search.status).toBe(200)

    // The manager decides, and the decision reaches the memory service.
    const decided = await post(url, '/v1/tools/memory/decide', managerToken,
      { jobId: job.jobId, candidateId: candidate.candidate.candidateId,
        checksum: reviewed.candidate.checksum, decision: 'approve' })
    expect(decided.status).toBe(200)
    expect(((await decided.json()) as { code: string }).code).toBe('APPROVED')

    const memories = await get(url, '/v1/console/memory/memories', API_TOKEN)
    const page = (await memories.json()) as { rows: { content: string }[]; total: number }
    expect(page.total).toBe(1)
    expect(page.rows[0]!.content).toBe('这个项目统一用 pnpm，不要用 npm。')
  })

  it('refuses a second decision about the same job', async () => {
    const { url, scopeId } = await open()
    await personSays()
    const routerToken = node!.tokens.get('router')!
    const proposed = await post(url, '/v1/tools/memory/propose', routerToken,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'operator_message', id: PERSON_MESSAGE, summary: '主窗口的原话' }] })
    const candidate = (await proposed.json()) as { candidate: CandidateAnswer }
    await until(() => node!.tokens.has(MEMORY_MANAGER_SESSION_ID), 'the memory manager was not woken')
    const job = await jobOf(url, candidate.candidate.candidateId)
    const managerToken = node!.tokens.get(MEMORY_MANAGER_SESSION_ID)!
    const first = await post(url, '/v1/tools/memory/decide', managerToken,
      { jobId: job.jobId, candidateId: candidate.candidate.candidateId, checksum: candidate.candidate.checksum,
        decision: 'approve' })
    expect(first.status).toBe(200)
    // The same job may not be decided twice, and the same version may not be decided twice either.
    const second = await post(url, '/v1/tools/memory/decide', managerToken,
      { jobId: job.jobId, candidateId: candidate.candidate.candidateId, checksum: candidate.candidate.checksum,
        decision: 'reject' })
    expect(second.status).toBe(409)
  })

  it('refuses a manager that is not the Session the job was dispatched to', async () => {
    const { url, scopeId } = await open()
    await personSays()
    const routerToken = node!.tokens.get('router')!
    const proposed = await post(url, '/v1/tools/memory/propose', routerToken,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'operator_message', id: PERSON_MESSAGE, summary: '主窗口的原话' }] })
    const candidate = (await proposed.json()) as { candidate: CandidateAnswer }
    await until(() => node!.tokens.has(MEMORY_MANAGER_SESSION_ID), 'the memory manager was not woken')
    const job = await jobOf(url, candidate.candidate.candidateId)

    // The Router's own token may not use the manager's tools at all.
    const asRouter = await post(url, '/v1/tools/memory/review', routerToken, { jobId: job.jobId })
    expect(asRouter.status).toBe(403)

    // An unknown job is nothing at all.
    const managerToken = node!.tokens.get(MEMORY_MANAGER_SESSION_ID)!
    const unknown = await post(url, '/v1/tools/memory/review', managerToken, { jobId: 'memjob-nope' })
    expect(unknown.status).toBe(404)
  })

  it('leaves a candidate that waits for a person to the person', async () => {
    const { url, scopeId } = await open()
    // A fact nobody could check: the proposal waits for a person, and the manager may not decide it.
    const pmToken = node!.tokens.get(control!.projects()[0]!.pmSessionId)!
    const proposed = await post(url, '/v1/tools/memory/propose', pmToken,
      { content: '这个项目也许该用 pnpm。', scopeType: 'project', scopeId })
    expect(proposed.status).toBe(201)
    const candidate = (await proposed.json()) as { candidate: CandidateAnswer }
    expect(candidate.candidate.sourceTrust).toBe('external_tainted')
    expect(candidate.candidate.status).toBe('pending_human_confirm')

    // The manager is not even woken for it.
    expect(node!.commands.some(command => command.type === 'memory_manager.ensure')).toBe(false)

    // The operator's own decision still works.
    const decided = await post(url, `/v1/console/memory/candidates/${candidate.candidate.candidateId}/decision`,
      API_TOKEN, { decision: 'approve', checksum: candidate.candidate.checksum })
    expect(decided.status).toBe(200)
  })

  it('does not take the person\'s own words out of the summary of a source', async () => {
    const { url, scopeId } = await open()
    await personSays()
    const routerToken = node!.tokens.get('router')!
    // The words are only in the line the proposer wrote about the record: they are not in the person's message, so they
    // are not the person's own words.
    const proposed = await post(url, '/v1/tools/memory/propose', routerToken,
      { content: '这个项目统一用 yarn，不要用 npm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'operator_message', id: PERSON_MESSAGE, summary: '这个项目统一用 yarn，不要用 npm。' }] })
    expect(proposed.status).toBe(201)
    const candidate = (await proposed.json()) as { candidate: CandidateAnswer }
    expect(candidate.candidate.sourceTrust).toBe('external_tainted')
    expect(candidate.candidate.status).toBe('pending_human_confirm')

    // And the manager is not woken for it: it is not a fact it may judge.
    expect(node!.commands.some(command => command.type === 'memory_manager.ensure')).toBe(false)
  })

  it('refuses a proposal about another Project, and one that leans on another Project\'s record', async () => {
    const { url, scopeId } = await open()
    await personSays()
    const pmSessionId = control!.projects()[0]!.pmSessionId
    const pmToken = node!.tokens.get(pmSessionId)!
    // Another Project's scope is not this PM's to write about.
    const other = control!.createProjectFromOperator('另一个项目', '别的活')
    const foreign = await post(url, '/v1/tools/memory/propose', pmToken,
      { content: '另一个项目统一用 pnpm。', scopeType: 'project', scopeId: `project:${other.id}` })
    expect(foreign.status).toBe(400)

    // And a record of another Project may not back this PM's fact, however true it is.
    const otherPm = await control!.openProject(other.id)
    const [ticket] = control!.engine.createProjectTickets(other.id, otherPm.sessionId,
      [{ title: '别的工单', goal: '别的活' }])
    const borrowed = await post(url, '/v1/tools/memory/propose', pmToken,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'ticket', id: ticket!.id, summary: '另一张工单' }] })
    expect(borrowed.status).toBe(400)
  })

  it('sends a candidate back at most once, and never wakes the Session that proposed it', async () => {
    const { url, scopeId, pmSessionId } = await open()
    await personSays()
    const routerToken = node!.tokens.get('router')!
    const proposed = await post(url, '/v1/tools/memory/propose', routerToken,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'operator_message', id: PERSON_MESSAGE, summary: '主窗口的原话' }] })
    const candidate = (await proposed.json()) as { candidate: CandidateAnswer }
    await until(() => node!.tokens.has(MEMORY_MANAGER_SESSION_ID), 'the memory manager was not woken')
    const job = await jobOf(url, candidate.candidate.candidateId)
    const managerToken = node!.tokens.get(MEMORY_MANAGER_SESSION_ID)!
    const before = node!.commands.filter(command => command.type === 'session.message'
      && command.sessionId === 'router').length

    const returned = await post(url, '/v1/tools/memory/return', managerToken,
      { jobId: job.jobId, candidateId: candidate.candidate.candidateId, checksum: candidate.candidate.checksum,
        reason: '缺少这个约定的适用范围。' })
    expect(returned.status).toBe(200)

    // The request is passive: nobody was woken and no message went to the Session that proposed it.
    const messages = node!.commands.filter(command => command.type === 'session.message'
      && command.sessionId === 'router')
    expect(messages).toHaveLength(before)
    expect(node!.commands.some(command => command.type === 'session.message'
      && command.sessionId === pmSessionId)).toBe(false)

    // The candidate remembers that it went back, and to whom.
    const queue = await get(url, '/v1/console/memory/candidates', API_TOKEN)
    const page = (await queue.json()) as { rows: CandidateAnswer[] }
    const row = page.rows.find(entry => entry.candidateId === candidate.candidate.candidateId)!
    expect(row.revisionCount).toBe(1)
    expect(row.returnedToSessionId).not.toBe('')
  })

  it('writes down a review nobody decided about, and lets an ordinary retry through', async () => {
    const clock = { at: START }
    const { url, scopeId } = await open({ clock, reviewTimeoutMs: 60_000 })
    await personSays()
    const routerToken = node!.tokens.get('router')!
    const proposed = await post(url, '/v1/tools/memory/propose', routerToken,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'operator_message', id: PERSON_MESSAGE, summary: '主窗口的原话' }] })
    const candidate = (await proposed.json()) as { candidate: CandidateAnswer }
    await until(() => node!.tokens.has(MEMORY_MANAGER_SESSION_ID), 'the memory manager was not woken')
    const job = await jobOf(url, candidate.candidate.candidateId)
    const managerToken = node!.tokens.get(MEMORY_MANAGER_SESSION_ID)!

    // The manager never calls its decision tool: the job runs out of time.
    clock.at = new Date(Date.parse(START) + 120_000).toISOString()
    const decided = await post(url, '/v1/tools/memory/decide', managerToken,
      { jobId: job.jobId, candidateId: candidate.candidate.candidateId, checksum: candidate.candidate.checksum,
        decision: 'approve' })
    expect(decided.status).toBe(409)

    // The record says the review did not finish, and it says why.
    const reviews = await get(url, '/v1/console/memory/reviews', API_TOKEN)
    const rows = (await reviews.json()) as { rows: { jobId: string; state: string; detail: string }[] }
    const row = rows.rows.find(entry => entry.jobId === job.jobId)!
    expect(row.state).toBe('failed')
    expect(row.detail).not.toBe('')

    // And the retry of the same candidate is an ordinary one: a new job, prepared as usual.
    const run = await post(url, '/v1/console/memory/maintenance/run', API_TOKEN, {})
    expect(run.status).toBe(200)
    const again = await jobOf(url, candidate.candidate.candidateId)
    expect(again.jobId).not.toBe(job.jobId)
    expect(again.state).toBe('dispatched')
  })

  it('lets the proposer say a candidate once more, and only once', async () => {
    const { url, scopeId } = await open()
    await personSays()
    const routerToken = node!.tokens.get('router')!
    const proposed = await post(url, '/v1/tools/memory/propose', routerToken,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'operator_message', id: PERSON_MESSAGE, summary: '主窗口的原话' }] })
    const candidate = (await proposed.json()) as { candidate: CandidateAnswer }
    await until(() => node!.tokens.has(MEMORY_MANAGER_SESSION_ID), 'the memory manager was not woken')
    const job = await jobOf(url, candidate.candidate.candidateId)
    const managerToken = node!.tokens.get(MEMORY_MANAGER_SESSION_ID)!

    // The manager cannot judge the candidate and sends it back.
    const returned = await post(url, '/v1/tools/memory/return', managerToken,
      { jobId: job.jobId, candidateId: candidate.candidate.candidateId, checksum: candidate.candidate.checksum,
        reason: '缺少这个约定的适用范围。' })
    expect(returned.status).toBe(200)

    // The candidate now carries the version the request captured.
    const queue = await get(url, '/v1/console/memory/candidates', API_TOKEN)
    const page = (await queue.json()) as { rows: CandidateAnswer[] }
    const row = page.rows.find(entry => entry.candidateId === candidate.candidate.candidateId)!
    expect(row.returnedToSessionId).toBe('router')
    const version = row.checksum
    expect(version).not.toBe(candidate.candidate.checksum)

    // The proposer says it once more: the same candidate goes back into the queue. It names the record the new words
    // came from, and the words are checked against it exactly as they were the first time.
    const again = await post(url, '/v1/tools/memory/propose', routerToken,
      { content: '这个项目统一用 pnpm，不要用 npm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'operator_message', id: PERSON_MESSAGE, summary: '主窗口的原话' }],
        candidateId: row.candidateId, checksum: version })
    expect(again.status).toBe(201)
    const reevaluated = (await again.json()) as { candidate: CandidateAnswer }
    expect(reevaluated.candidate.candidateId).toBe(row.candidateId)
    expect(reevaluated.candidate.status).toBe('queued')
    expect(reevaluated.candidate.reevaluations).toBe(1)

    // One round only: the request is spent, and nobody was woken to say it again.
    const third = await post(url, '/v1/tools/memory/propose', routerToken,
      { content: '这个项目统一用 pnpm，不要用 npm。', scopeType: 'project', scopeId,
        candidateId: row.candidateId, checksum: version })
    expect(third.status).toBe(403)
  })

  it('hands the reason back to the proposer as data, with the version it captured', async () => {
    const { url, scopeId } = await open()
    await personSays()
    const routerToken = node!.tokens.get('router')!
    const proposed = await post(url, '/v1/tools/memory/propose', routerToken,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'operator_message', id: PERSON_MESSAGE, summary: '主窗口的原话' }] })
    const candidate = (await proposed.json()) as { candidate: CandidateAnswer }
    await until(() => node!.tokens.has(MEMORY_MANAGER_SESSION_ID), 'the memory manager was not woken')
    const job = await jobOf(url, candidate.candidate.candidateId)
    const managerToken = node!.tokens.get(MEMORY_MANAGER_SESSION_ID)!
    const returned = await post(url, '/v1/tools/memory/return', managerToken,
      { jobId: job.jobId, candidateId: candidate.candidate.candidateId, checksum: candidate.candidate.checksum,
        reason: '缺少这个约定的适用范围。' })
    expect(returned.status).toBe(200)

    // The request waits until the proposer takes a message of its own.
    await control!.sendMessage('router', '还有别的活吗？')
    const texts = node!.commands
      .filter(command => command.type === 'session.message' && command.sessionId === 'router')
      .map(command => command.type === 'session.message' ? command.text : '')
    const fenced = texts.find(text => text.includes('<memory_return_data>'))
    expect(fenced).toBeDefined()
    // The reason is quoted as data: it is fenced, and it cannot close the fence it is written in.
    expect(fenced!).toContain('缺少这个约定的适用范围。')
    expect(fenced!.split('<memory_return_data>')).toHaveLength(2)
    expect(fenced!.split('</memory_return_data>')).toHaveLength(2)
  })

  it('writes down the inspection it really ran', async () => {
    const { url, scopeId } = await open()
    // A candidate a person offered at the console: it waits in the queue, and the inspection is what picks it up.
    await post(url, '/v1/console/memory/candidates', API_TOKEN,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId })

    const run = await post(url, '/v1/console/memory/maintenance/run', API_TOKEN, {})
    expect(run.status).toBe(200)
    const answer = (await run.json()) as { run: { state: string; checked: number; nextAt: string; summary: string } }
    // The node was there and the run finished: it says so.
    expect(answer.run.state).toBe('succeeded')
    expect(answer.run.checked).toBeGreaterThan(0)
    expect(answer.run.nextAt).not.toBe('')

    // The record is persisted, and a viewer may read it.
    const records = await get(url, '/v1/console/memory/maintenance', VIEWER_TOKEN)
    expect(records.status).toBe(200)
    const page = (await records.json()) as { rows: { state: string; nextAt: string }[] }
    expect(page.rows[0]!.state).toBe('succeeded')
    expect(page.rows[0]!.nextAt).not.toBe('')

    // The read-only viewer may not run one.
    const byViewer = await post(url, '/v1/console/memory/maintenance/run', VIEWER_TOKEN, {})
    expect(byViewer.status).toBe(403)
  })

  it('writes down an inspection it could not run as what it was', async () => {
    const { url } = await open()
    control!.markNodeOffline()
    const run = await post(url, '/v1/console/memory/maintenance/run', API_TOKEN, {})
    expect(run.status).toBe(200)
    const answer = (await run.json()) as { run: { state: string; summary: string } }
    // The node was offline: the run did not happen, and it does not say it did.
    expect(answer.run.state).toBe('skipped_offline')
    expect(answer.run.summary).not.toBe('')
  })

  it('writes down an inspection that was switched off as what it was', async () => {
    const { url } = await open({ memoryMaintenanceEnabled: false })
    const run = await post(url, '/v1/console/memory/maintenance/run', API_TOKEN, {})
    expect(run.status).toBe(200)
    const answer = (await run.json()) as { run: { state: string } }
    expect(answer.run.state).toBe('skipped_disabled')
  })

  it('writes down an inspection that ran out of time as unfinished', async () => {
    const { url, scopeId } = await open({ memoryMaintenanceTimeoutMs: 20, slowManager: true })
    // A candidate the inspection has work for: waking the manager is what takes too long.
    await post(url, '/v1/console/memory/candidates', API_TOKEN,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId })
    const run = await post(url, '/v1/console/memory/maintenance/run', API_TOKEN, {})
    expect(run.status).toBe(200)
    const answer = (await run.json()) as { run: { state: string; summary: string } }
    expect(answer.run.state).toBe('failed')
    expect(answer.run.summary).toContain('超时')
  })

  it('writes down an inspection the control plane was interrupted in as interrupted', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-manager-restart-'))
    const root = join(directory, 'workspaces')
    const dbPath = join(directory, 'control.sqlite')
    const first = new ControlPlane({ dbPath, nodeId: NODE_ID, node: new FakeNode({ nodeId: NODE_ID, root, now: () => START }),
      secret: SECRET, workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
    await first.registerNode()
    await first.close()

    // A run that was under way when the process ended: its outcome is unknown, and it says so.
    const db = new DatabaseSync(dbPath)
    db.prepare(`INSERT INTO memory_maintenance_runs
      (run_id, at, state, node_id, backend_id, checked, duplicates, conflicts, expired, stale, summary, detail,
       next_at, prepared_at, finished_at)
      VALUES ('mem-maint-old', '2026-11-19T08:00:00.000Z', 'attempted', 'local', 'dsh', 0, 0, 0, 0, 0, '', '',
       '2026-11-20T08:00:00.000Z', '2026-11-19T08:00:00.000Z', '')`).run()
    db.close()

    const second = new ControlPlane({ dbPath, nodeId: NODE_ID, node: new FakeNode({ nodeId: NODE_ID, root, now: () => START }),
      secret: SECRET, workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
    await second.registerNode()
    const row = second.memoryMaintenanceRunsForOperator().find(entry => entry.runId === 'mem-maint-old')
    expect(row?.state).toBe('interrupted')
    expect(row?.finishedAt).not.toBe('')
    await second.close()
  })

  it('keeps the earlier routes working', async () => {
    const { url, scopeId } = await open()
    const proposed = await post(url, '/v1/console/memory/candidates', API_TOKEN,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId })
    expect(proposed.status).toBe(201)
    const body = (await proposed.json()) as { candidate: CandidateAnswer }
    expect(body.candidate.status).toBe('queued')
    const queue = await get(url, '/v1/console/memory/candidates', API_TOKEN)
    expect(((await queue.json()) as { total: number }).total).toBe(1)
    const decided = await post(url, `/v1/console/memory/candidates/${body.candidate.candidateId}/decision`, API_TOKEN,
      { decision: 'approve', checksum: body.candidate.checksum })
    expect(decided.status).toBe(200)
    const memories = await get(url, '/v1/console/memory/memories', API_TOKEN)
    expect(((await memories.json()) as { total: number }).total).toBe(1)
  })
})
