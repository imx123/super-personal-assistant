/**
 * The durable event history: the facts the control plane records, the ones it refuses to show, and the way it reads them
 * back.
 *
 * The service is exercised on its own for the rules that are easier to state as records than as a running control plane:
 * the idempotency of a fact, the five independent keys, the redaction on both sides and the keyset paging. The control
 * plane is exercised through its own real paths — a person's request, a Worker that starts, a report, a review, a stop, a
 * refused call, a scheduled run — so that what the history holds is what really happened and not a label somebody typed.
 *
 * The reads go over the real HTTP API: the console's own route and the Session-token route, each with the scope its caller
 * really has. A key of another Project reads nothing, exactly as a key that never existed reads nothing.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { PM_PROFILE, ROUTER_PROFILE, WORKER_PROFILE } from '../src/control/roles.ts'
import { EventHistoryService, type EventHistoryHost } from '../src/memory/event-history.ts'
import { createDshPortHost, type DshPortFetch } from '../src/node/dsh-port-host.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import type { SessionRecord } from '../src/shared/protocol.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'

const SECRET = 'event-history-secret'
const API_TOKEN = 'event-history-api-token'
const VIEWER_TOKEN = 'event-history-viewer-token'
const START = '2026-11-19T08:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode | undefined

/** Wait for the asynchronous Executor callbacks to settle the Store. */
async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A Session record, as the control plane keeps it. */
const sessionRecord = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: 'pm-1',
  projectId: 'p1',
  role: 'pm',
  nodeId: NODE_ID,
  workspace: '/workspaces/p1',
  status: 'idle',
  toolProfile: 'pm.v1',
  createdAt: START,
  updatedAt: START,
  ...over,
})

/** A Project of the bench, with the PM that manages it. */
const benchProject = (over: Partial<ProjectProfile> = {}): ProjectProfile => ({
  id: 'p1',
  title: 'Project',
  goal: 'Goal',
  status: 'active',
  decisionId: 'decision-1',
  pmSessionId: 'pm-1',
  mandate: {
    strength: 'explicit',
    policyVersion: 'bench/v1',
    basis: { via: 'listed', sender: 'alice' },
    actor: { source: 'main-session', id: 'alice' },
    scope: 'project:p1',
    projectId: 'p1',
    goal: 'Goal',
  },
  createdAt: START,
  updatedAt: START,
  ...over,
})

/** A Ticket of the bench, with the Assignments it holds. */
const benchTicket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 't1',
  title: 'Ticket',
  decisionId: 'decision-1',
  projectId: 'p1',
  mandate: {
    strength: 'explicit',
    policyVersion: 'bench/v1',
    basis: { via: 'listed', sender: 'alice' },
    actor: { source: 'main-session', id: 'alice' },
    scope: 'project:p1',
    projectId: 'p1',
    goal: 'Goal',
  },
  channels: [],
  assignments: [{ id: 'a1', state: 'running', createdAt: START }],
  inputs: [],
  undelivered: [],
  createdAt: START,
  updatedAt: START,
  origin: { triggerId: 'tr1', triggerIds: ['tr1'] },
  ...over,
} as unknown as Ticket)

/**
 * The service on its own: one SQLite file, one host, one clock the test moves by hand.
 */
class Bench {
  readonly db = new DatabaseSync(':memory:')
  readonly service: EventHistoryService
  /** The moment the service reads as "now". */
  at = START
  readonly sessions: SessionRecord[] = []
  readonly tickets: Ticket[] = []
  readonly projects: ProjectProfile[] = []

  constructor() {
    this.service = new EventHistoryService(this.db, this.host())
  }

  /** The host of the bench: the records the service reads and the clock it reads them at. */
  host(): EventHistoryHost {
    return {
      now: () => this.at,
      nodeId: () => NODE_ID,
      backendId: () => 'dsh',
      sessions: () => this.sessions,
      tickets: () => this.tickets,
      projects: () => this.projects,
      routerSessionId: () => 'router',
    }
  }

  /** Move the clock on, so two facts are a moment apart. */
  tick(seconds = 1): void {
    this.at = new Date(Date.parse(this.at) + seconds * 1000).toISOString()
  }
}

interface Opened {
  project: ProjectProfile
  pm: SessionRecord
  ticket: Ticket
  assignment: Assignment
  worker: string
  address: { url: string }
}

/**
 * A control plane with a Router, a Project made from a person's request, its PM, one Ticket and its Worker.
 */
async function open(options: { consoleEventRows?: number } = {}): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-event-history-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50,
    ...(options.consoleEventRows === undefined ? {} : { consoleEventRows: options.consoleEventRows }) })
  await control.registerNode()
  await control.ensureRouter()
  // The Project comes from a person's request: this is the path that records the trigger.
  const project = control.createProjectFromOperator('控制台改造', '让操作员看得到状态')
  const pm = await control.openProject(project.id)
  const [created] = control.engine.createProjectTickets(project.id, pm.sessionId, [{ title: '记忆页', goal: 'Do it' }])
  const assignment = created!.assignments[0]!
  await until(() => control!.store.tickets.get(created!.id)?.assignments.at(-1)?.state === 'running',
    'the Assignment did not start')
  server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
  const address = await server.listen(0)
  return { project, pm, ticket: control.store.tickets.get(created!.id)!, assignment,
    worker: `worker-${assignment.id}`, address }
}

/** A second Project of its own, with a PM and a Worker that belong to it. */
async function otherProject(): Promise<{ project: ProjectProfile; pm: SessionRecord; ticket: Ticket; worker: string }> {
  const project = control!.createProjectFromOperator('别人的项目', '别人的目标')
  const pm = await control!.openProject(project.id)
  const [created] = control!.engine.createProjectTickets(project.id, pm.sessionId, [{ title: '他们的工单', goal: 'Their goal' }])
  await until(() => control!.store.tickets.get(created!.id)?.assignments.at(-1)?.state === 'running',
    'the Assignment of the other Project did not start')
  return { project, pm, ticket: control!.store.tickets.get(created!.id)!, worker: `worker-${created!.assignments[0]!.id}` }
}

function tokenOf(sessionId: string): string {
  const token = node?.tokens.get(sessionId)
  if (!token) throw new Error(`The FakeNode has no token for ${sessionId}`)
  return token
}

function get(address: { url: string }, path: string, token: string): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

function post(address: { url: string }, path: string, token: string, body: unknown = {}): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body) })
}

/** One row of the durable history, as the console reads it. */
interface HistoryEntry {
  seq: number
  eventId: string
  kind: string
  at: string
  scopeKey: string
  ticketId: string
  projectId: string
  controlSessionId: string
  assignmentId: string
  sourceTable: string
  sourceId: string
  summary: string
  detail: Record<string, string>
}

/** One page of the durable history, as the console reads it. */
interface HistoryPage {
  rows: HistoryEntry[]
  nextCursor?: string
  hasMore: boolean
  total: number
  coverage: { since?: string; kinds: string[]; trimmed: boolean; retention: string }
}

async function readHistory(address: { url: string }, path: string, token: string): Promise<HistoryPage> {
  const response = await get(address, path, token)
  expect(response.status).toBe(200)
  return await response.json() as HistoryPage
}

/** The kinds the history holds, as the operator reads them. */
async function kindsOf(address: { url: string }): Promise<string[]> {
  const page = await readHistory(address, '/v1/console/memory/event-history?limit=100', API_TOKEN)
  return [...new Set(page.rows.map(row => row.kind))].sort()
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

describe('the durable event history, on its own', () => {
  it('writes a fact once, however often it is written', () => {
    const bench = new Bench()
    const fact = {
      kind: 'dispatch' as const,
      scope: { ticketId: 't1' },
      sourceTable: 'assignment',
      sourceId: 'a1',
      sourceSeq: 0,
      summary: '派工：Worker 开始执行这次尝试。',
    }
    bench.service.record(fact)
    bench.service.record(fact)
    bench.service.record(fact)
    const page = bench.service.forOperator({ ticketId: 't1' })
    expect(page.rows).toHaveLength(1)
    expect(page.total).toBe(1)
    expect(page.rows[0]!.sourceId).toBe('a1')
  })

  it('tells two facts of the same record apart by their ordinal', () => {
    const bench = new Bench()
    bench.service.recordReport({ state: 'progress', sourceTable: 'assignment', sourceId: 'a1', ticketId: 't1' })
    bench.service.recordReport({ state: 'ready', sourceTable: 'assignment', sourceId: 'a1', ticketId: 't1' })
    const page = bench.service.forOperator({ ticketId: 't1' })
    expect(page.rows).toHaveLength(2)
    expect(page.rows.map(row => row.summary)).toEqual(['报告：ready。', '报告：progress。'])
  })

  it('keeps the five keys apart', () => {
    const bench = new Bench()
    bench.service.record({ kind: 'review', scope: { ticketId: 't1', projectId: 'p1', controlSessionId: 'pm-1',
      assignmentId: 'a1' }, sourceTable: 'ticket', sourceId: 'r1', sourceSeq: 0, summary: '评审：PM 验收通过。' })
    const row = bench.service.forOperator({}).rows[0]!
    expect(row.ticketId).toBe('t1')
    expect(row.projectId).toBe('p1')
    expect(row.controlSessionId).toBe('pm-1')
    expect(row.assignmentId).toBe('a1')
    expect(row.scopeKey).toBe('ticket:t1')
    expect(bench.service.forOperator({ projectId: 'p1' }).rows).toHaveLength(1)
    expect(bench.service.forOperator({ controlSessionId: 'pm-1' }).rows).toHaveLength(1)
    expect(bench.service.forOperator({ assignmentId: 'a1' }).rows).toHaveLength(1)
    expect(bench.service.forOperator({ ticketId: 'other' }).rows).toHaveLength(0)
  })

  it('redacts what it stores and what it reads back', () => {
    const bench = new Bench()
    bench.service.record({ kind: 'error', scope: { ticketId: 't1' }, sourceTable: 'ticket', sourceId: 't1',
      summary: '失败：读不到 /home/me/.config/secret 这个文件。', detail: { diagnostic: 'token=abcdef123456' } })
    const row = bench.service.forOperator({}).rows[0]!
    expect(row.summary).not.toContain('/home/me')
    expect(row.summary).toContain('<path>')
    expect(row.detail.diagnostic).not.toContain('abcdef123456')

    // A row that was written by an older version of the module is redacted again on the way out.
    bench.db.prepare('INSERT INTO event_history_index (event_id, event_kind, at, scope_key, ticket_id, project_id, '
      + 'control_session_id, assignment_id, node_id, backend_id, source_table, source_id, source_seq, summary, detail, '
      + 'created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('old-row', 'error', bench.at, 'ticket:t1', 't1', '', '', '', NODE_ID, 'dsh', 'ticket', 't1', 0,
        '失败：C:\\Users\\me\\secret.txt 读不到。', '', bench.at)
    const old = bench.service.forOperator({}).rows.find(entry => entry.eventId === 'old-row')!
    expect(old.summary).not.toContain('Users')
    expect(old.summary).toContain('<path>')
  })

  it('pages without skipping a row or showing one twice, even when the moments are equal', () => {
    const bench = new Bench()
    for (let index = 0; index < 5; index += 1) {
      // Five facts at the very same moment: the order may not depend on the clock.
      bench.service.record({ kind: 'trigger', scope: { ticketId: `t${index}` }, sourceTable: 'trigger',
        sourceId: `trigger-${index}`, sourceSeq: 0, summary: `触发 ${index}` })
    }
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page += 1) {
      const answer = bench.service.forOperator({ limit: 2, ...(cursor === undefined ? {} : { cursor }) })
      seen.push(...answer.rows.map(row => row.eventId))
      expect(answer.total).toBe(5)
      cursor = answer.nextCursor
      if (cursor === undefined) break
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('says how far back it reaches and that it is never trimmed', () => {
    const bench = new Bench()
    expect(bench.service.coverage().since).toBeUndefined()
    expect(bench.service.coverage().trimmed).toBe(false)
    bench.tick()
    bench.service.record({ kind: 'trigger', scope: { projectId: 'p1' }, sourceTable: 'trigger', sourceId: 'trigger-1',
      sourceSeq: 0, summary: '触发：一次请求建成了项目。' })
    const coverage = bench.service.coverage()
    expect(coverage.since).toBe(bench.at)
    expect(coverage.kinds).toEqual(['trigger'])
    expect(coverage.trimmed).toBe(false)
    expect(coverage.retention).toContain('不会自动删除')
  })

  it('refuses a cursor it did not write and a limit it cannot honour', () => {
    const bench = new Bench()
    expect(() => bench.service.forOperator({ cursor: 'not-a-cursor' })).toThrow(/cursor/i)
    expect(() => bench.service.forOperator({ limit: 0 })).toThrow(/limit/i)
    expect(() => bench.service.forOperator({ limit: 1000 })).toThrow(/limit/i)
  })

  it('gives a reader only what its own Session owns', () => {
    const bench = new Bench()
    bench.projects.push(benchProject())
    bench.projects.push(benchProject({ id: 'p2', pmSessionId: 'pm-2' }))
    bench.sessions.push(sessionRecord({ sessionId: 'pm-1', role: 'pm', projectId: 'p1' }))
    bench.sessions.push(sessionRecord({ sessionId: 'pm-2', role: 'pm', projectId: 'p2' }))
    bench.sessions.push(sessionRecord({ sessionId: 'router', role: 'router', projectId: '' }))
    bench.service.record({ kind: 'trigger', scope: { projectId: 'p1' }, sourceTable: 'trigger', sourceId: 'trigger-1',
      sourceSeq: 0, summary: '触发：一次请求建成了项目。' })
    bench.service.record({ kind: 'trigger', scope: { projectId: 'p2' }, sourceTable: 'trigger', sourceId: 'trigger-2',
      sourceSeq: 0, summary: '触发：一次请求建成了项目。' })

    const mine = bench.service.forSession({ audience: 'pm', sessionId: 'pm-1' }, { projectId: 'p1' })
    expect(mine.ok).toBe(true)
    expect(mine.ok && mine.page.rows).toHaveLength(1)

    // A key of another Project reads nothing, exactly as a key that never existed reads nothing.
    const theirs = bench.service.forSession({ audience: 'pm', sessionId: 'pm-1' }, { projectId: 'p2' })
    expect(theirs.ok && theirs.page.rows).toHaveLength(0)
    expect(theirs.ok && theirs.page.total).toBe(0)

    // The Router reads the pool it manages.
    const pool = bench.service.forSession({ audience: 'router', sessionId: 'router' }, {})
    expect(pool.ok && pool.page.rows).toHaveLength(2)

    // A Session that was revoked reads nothing at all.
    bench.sessions[0]!.revokedAt = START
    const revoked = bench.service.forSession({ audience: 'pm', sessionId: 'pm-1' }, {})
    expect(revoked.ok).toBe(false)
    expect(!revoked.ok && revoked.code).toBe('NO_SCOPE')
  })

  it('tells a reader only the kinds and the oldest moment of its own scope', () => {
    const bench = new Bench()
    bench.projects.push(benchProject())
    bench.projects.push(benchProject({ id: 'p2', pmSessionId: 'pm-2' }))
    bench.sessions.push(sessionRecord({ sessionId: 'pm-1', role: 'pm', projectId: 'p1' }))
    bench.sessions.push(sessionRecord({ sessionId: 'pm-2', role: 'pm', projectId: 'p2' }))

    // The other Project's fact comes first: its kind and its moment are the two things a reader of p1 must not learn.
    bench.service.record({ kind: 'denial', scope: { projectId: 'p2' }, sourceTable: 'permission_denial_calls',
      sourceId: 'call-1', sourceSeq: 0, summary: '权限拒绝：control_router_summary（ROLE_TOOL_DENIED）。' })
    bench.tick()
    bench.service.record({ kind: 'trigger', scope: { projectId: 'p1' }, sourceTable: 'trigger', sourceId: 'trigger-1',
      sourceSeq: 0, summary: '触发：一次请求建成了项目。' })

    const mine = bench.service.forSession({ audience: 'pm', sessionId: 'pm-1' }, { projectId: 'p1' })
    expect(mine.ok).toBe(true)
    if (!mine.ok) return
    expect(mine.page.coverage.kinds).toEqual(['trigger'])
    expect(mine.page.coverage.since).toBe(bench.at)

    // The operator reads the whole index and is told about both.
    const all = bench.service.forOperator({})
    expect(all.coverage.kinds).toEqual(['denial', 'trigger'])
    expect(all.coverage.since).toBe(START)
  })

  it('answers a key of another Project exactly as it answers a key that never existed', () => {
    const bench = new Bench()
    bench.projects.push(benchProject())
    bench.projects.push(benchProject({ id: 'p2', pmSessionId: 'pm-2' }))
    bench.sessions.push(sessionRecord({ sessionId: 'pm-1', role: 'pm', projectId: 'p1' }))
    bench.service.record({ kind: 'trigger', scope: { projectId: 'p1' }, sourceTable: 'trigger', sourceId: 'trigger-1',
      sourceSeq: 0, summary: '触发：一次请求建成了项目。' })
    // The other Project's Ticket really exists: the answer must not say whether it does.
    bench.service.record({ kind: 'dispatch', scope: { ticketId: 't2', projectId: 'p2' }, sourceTable: 'assignment',
      sourceId: 'a2', sourceSeq: 0, summary: '派工：Worker 开始执行这次尝试。' })

    const foreign = bench.service.forSession({ audience: 'pm', sessionId: 'pm-1' }, { ticketId: 't2' })
    const unknown = bench.service.forSession({ audience: 'pm', sessionId: 'pm-1' }, { ticketId: 'never-existed' })
    expect(foreign.ok).toBe(true)
    expect(unknown.ok).toBe(true)
    if (!foreign.ok || !unknown.ok) return
    expect(foreign.page.rows).toHaveLength(0)
    expect(unknown.page.rows).toHaveLength(0)
    expect(foreign.page.total).toBe(0)
    expect(unknown.page.total).toBe(0)
    // The two answers are the same answer: the coverage of the reader's own scope, and nothing about the other key.
    expect(foreign.page.coverage).toEqual(unknown.page.coverage)
    expect(foreign.page.coverage.kinds).toEqual(['trigger'])
  })

  it('gives a Worker its current Ticket and nothing that merely names its Assignment or its Session', () => {
    const bench = new Bench()
    bench.projects.push(benchProject())
    bench.sessions.push(sessionRecord({ sessionId: 'pm-1', role: 'pm', projectId: 'p1' }))
    bench.sessions.push(sessionRecord({ sessionId: 'worker-1', role: 'worker', projectId: 'p1', assignmentId: 'a1' }))
    bench.tickets.push(benchTicket({ id: 't1', projectId: 'p1' }))
    bench.tickets.push(benchTicket({ id: 't2', projectId: 'p1', assignments: [{ id: 'a2', state: 'running', createdAt: START }] }))

    bench.service.record({ kind: 'dispatch', scope: { ticketId: 't1' }, sourceTable: 'assignment', sourceId: 'a1',
      sourceSeq: 0, summary: '派工：Worker 开始执行这次尝试。' })
    // A row that names the Assignment alone, one that names the Worker's Session alone and one of the neighbour's
    // Ticket: none of them is the Worker's own Ticket.
    bench.service.record({ kind: 'error', scope: { assignmentId: 'a1' }, sourceTable: 'assignment', sourceId: 'a1',
      sourceSeq: 1, summary: '失败：assignment_failed。' })
    bench.service.record({ kind: 'denial', scope: { controlSessionId: 'worker-1' },
      sourceTable: 'permission_denial_calls', sourceId: 'call-1', sourceSeq: 0,
      summary: '权限拒绝：control_report（ROLE_TOOL_DENIED）。' })
    bench.service.record({ kind: 'review', scope: { ticketId: 't2' }, sourceTable: 'ticket', sourceId: 'r1', sourceSeq: 0,
      summary: '评审：PM 验收通过。' })

    const mine = bench.service.forSession({ audience: 'worker', sessionId: 'worker-1' }, { ticketId: 't1' })
    expect(mine.ok).toBe(true)
    if (!mine.ok) return
    expect(mine.page.rows).toHaveLength(1)
    expect(mine.page.rows[0]!.kind).toBe('dispatch')
    expect(mine.page.total).toBe(1)
    // The kinds of the rows it may not read never reach it.
    expect(mine.page.coverage.kinds).toEqual(['dispatch'])
  })

  it('gives a PM its delegated Project and the Tickets that verifiably belong to it', () => {
    const bench = new Bench()
    bench.projects.push(benchProject())
    bench.projects.push(benchProject({ id: 'p2', pmSessionId: 'pm-2' }))
    bench.sessions.push(sessionRecord({ sessionId: 'pm-1', role: 'pm', projectId: 'p1' }))
    bench.sessions.push(sessionRecord({ sessionId: 'pm-2', role: 'pm', projectId: 'p2' }))
    bench.tickets.push(benchTicket({ id: 't1', projectId: 'p1' }))
    bench.tickets.push(benchTicket({ id: 't2', projectId: 'p2' }))

    // The Project's own fact, and an older row that names only the Ticket under it.
    bench.service.record({ kind: 'trigger', scope: { projectId: 'p1' }, sourceTable: 'trigger', sourceId: 'trigger-1',
      sourceSeq: 0, summary: '触发：一次请求建成了项目。' })
    bench.service.record({ kind: 'dispatch', scope: { ticketId: 't1' }, sourceTable: 'assignment', sourceId: 'a1',
      sourceSeq: 0, summary: '派工：Worker 开始执行这次尝试。' })
    // The other Project's fact.
    bench.service.record({ kind: 'review', scope: { ticketId: 't2', projectId: 'p2' }, sourceTable: 'ticket', sourceId: 'r2',
      sourceSeq: 0, summary: '评审：PM 验收通过。' })

    const project = bench.service.forSession({ audience: 'pm', sessionId: 'pm-1' }, { projectId: 'p1' })
    expect(project.ok).toBe(true)
    if (!project.ok) return
    expect(project.page.rows).toHaveLength(1)
    expect(project.page.rows[0]!.kind).toBe('trigger')

    // The older row that names only a Ticket of its Project is still its own.
    const older = bench.service.forSession({ audience: 'pm', sessionId: 'pm-1' }, { ticketId: 't1' })
    expect(older.ok).toBe(true)
    if (!older.ok) return
    expect(older.page.rows).toHaveLength(1)
    expect(older.page.rows[0]!.kind).toBe('dispatch')

    // The other Project's Ticket is not.
    const foreign = bench.service.forSession({ audience: 'pm', sessionId: 'pm-1' }, { ticketId: 't2' })
    expect(foreign.ok).toBe(true)
    if (!foreign.ok) return
    expect(foreign.page.rows).toHaveLength(0)
    expect(foreign.page.total).toBe(0)
    expect(foreign.page.coverage.kinds).toEqual(['dispatch', 'trigger'])
  })

  it('creates the table and its indexes once, and keeps them and the facts when it is opened again', () => {
    const bench = new Bench()
    bench.service.record({ kind: 'trigger', scope: { projectId: 'p1' }, sourceTable: 'trigger', sourceId: 'trigger-1',
      sourceSeq: 0, summary: '触发：一次请求建成了项目。' })

    const indexes = bench.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='event_history_index'").all() as { name: string }[]
    expect(indexes.map(row => row.name)).toContain('event_history_index_scope')
    expect(indexes.map(row => row.name)).toContain('event_history_index_ticket')

    // The same file opened again: the schema is not rebuilt and the facts are still there.
    const again = new EventHistoryService(bench.db, bench.host())
    expect(again.forOperator({}).rows).toHaveLength(1)
  })
})

describe('the durable event history of a running control plane', () => {
  it('records the facts the control plane\'s own paths produced', async () => {
    const { address, project, pm, ticket, assignment, worker } = await open()

    // The Worker reports: the report's state is kept, its text is not.
    expect((await post(address, '/v1/tools/worker/report', tokenOf(worker), { ticketId: ticket.id,
      report: { state: 'ready', summary: '做完了，路径是 /home/me/project' } })).status).toBe(200)
    await control!.settleDenials()

    // The PM reviews the result.
    const reviewed = control!.store.tickets.get(ticket.id)!
    const reviewId = reviewed.reviews?.[0]?.id ?? ''
    expect(reviewId).not.toBe('')
    await control!.pmReview(pm.sessionId, ticket.id, assignment.id, { action: 'accept', reviewId })

    // A second Ticket of the same Project, whose Worker a person stops: a manual stop is a fact of its own.
    const [second] = control!.engine.createProjectTickets(project.id, pm.sessionId, [{ title: '第二张', goal: 'Also do it' }])
    const other = second!.assignments[0]!
    await until(() => control!.store.tickets.get(second!.id)?.assignments.at(-1)?.state === 'running',
      'the second Assignment did not start')
    await control!.pmCancelWorker(pm.sessionId, second!.id, other.id, '不做了')

    // A scheduled run of the Project's own plan.
    const plan = control!.scheduler.createPlan({ projectId: project.id, name: '每夜巡检', rule: 'daily:02:00',
      message: '看一眼' })
    await control!.scheduler.runNow(plan.id)

    const kinds = await kindsOf(address)
    expect(kinds).toContain('trigger')
    expect(kinds).toContain('dispatch')
    expect(kinds).toContain('report')
    expect(kinds).toContain('review')
    expect(kinds).toContain('manual_stop')
    expect(kinds).toContain('schedule')

    const page = await readHistory(address, `/v1/console/memory/event-history?ticketId=${encodeURIComponent(ticket.id)}`,
      API_TOKEN)
    expect(page.rows.length).toBeGreaterThan(0)
    // The report's own words never come into the index.
    expect(JSON.stringify(page.rows)).not.toContain('/home/me/project')
    expect(page.coverage.trimmed).toBe(false)
    expect(page.coverage.since).toBeDefined()
  })

  it('records a call the permission guard refused', async () => {
    const { address, pm } = await open()

    // A PM may not call the Router's own tool: the refusal is recorded.
    expect((await get(address, '/v1/tools/router/summary', tokenOf(pm.sessionId))).status).toBe(403)
    await control!.settleDenials()

    const kinds = await kindsOf(address)
    expect(kinds).toContain('denial')
    const page = await readHistory(address, '/v1/console/memory/event-history?kind=denial', API_TOKEN)
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]!.summary).toContain('control_router_summary')
  })

  it('writes the same fact once when the call is retried', async () => {
    const { address, ticket, worker } = await open()

    const body = { ticketId: ticket.id, callKey: 'call-1', report: { state: 'progress', summary: '做了一半' } }
    expect((await post(address, '/v1/tools/worker/report', tokenOf(worker), body)).status).toBe(200)
    expect((await post(address, '/v1/tools/worker/report', tokenOf(worker), body)).status).toBe(200)

    const page = await readHistory(address, '/v1/console/memory/event-history?kind=report', API_TOKEN)
    expect(page.rows).toHaveLength(1)
  })

  it('keeps the history in the control plane\'s own file, where the console log cannot prune it', async () => {
    const { address } = await open({ consoleEventRows: 5 })

    // The console's own log is bounded; the history is not.
    for (let index = 0; index < 20; index += 1) {
      control!.consoleStore.appendEvent({ seq: 1000 + index, at: START, nodeId: NODE_ID, sessionId: 's1',
        type: 'session.event', kind: 'message', payload: '{}' })
    }
    control!.consoleStore.prune(START)
    expect(control!.consoleStore.eventCount()).toBeLessThan(20)

    const page = await readHistory(address, '/v1/console/memory/event-history', API_TOKEN)
    expect(page.rows.length).toBeGreaterThan(0)
    expect(page.coverage.trimmed).toBe(false)

    // The table is in the control plane's file and nowhere else.
    const business = new DatabaseSync(join(directory, 'control.sqlite'))
    const tables = business.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_history_index'").all()
    expect(tables).toHaveLength(1)
    business.close()
    const consoleDb = new DatabaseSync(join(directory, 'console.sqlite'))
    const elsewhere = consoleDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_history_index'").all()
    expect(elsewhere).toHaveLength(0)
    consoleDb.close()
  })

  it('keeps the history across a restart of the control plane', async () => {
    const { address } = await open()
    const before = await readHistory(address, '/v1/console/memory/event-history', API_TOKEN)
    expect(before.rows.length).toBeGreaterThan(0)

    // The control plane goes away and comes back on the same file: the facts are in the file, not in its memory.
    await server!.close()
    await control!.close()
    server = undefined
    control = undefined
    const root = join(directory, 'workspaces')
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID,
      node: new FakeNode({ nodeId: NODE_ID, root, now: () => START }), secret: SECRET, workspaceRoot: root,
      now: () => START })
    server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
    const again = await server.listen(0)

    const after = await readHistory(again, '/v1/console/memory/event-history', API_TOKEN)
    expect(after.rows.length).toBe(before.rows.length)
    expect(after.total).toBe(before.total)
  })

  it('gives one Project\'s history to nobody else', async () => {
    const { address, pm, ticket, worker } = await open()
    const theirs = await otherProject()

    // The operator sees both.
    const all = await readHistory(address, '/v1/console/memory/event-history?limit=100', API_TOKEN)
    expect(all.rows.length).toBeGreaterThan(0)

    // The PM of one Project asks about the other: it reads nothing, and the answer does not say that it is there.
    const foreign = await readHistory(address,
      `/v1/tools/memory/event-history?ticketId=${encodeURIComponent(theirs.ticket.id)}`, tokenOf(pm.sessionId))
    expect(foreign.rows).toHaveLength(0)
    expect(foreign.total).toBe(0)

    // Its own Ticket is there.
    const own = await readHistory(address,
      `/v1/tools/memory/event-history?ticketId=${encodeURIComponent(ticket.id)}`, tokenOf(pm.sessionId))
    expect(own.rows.length).toBeGreaterThan(0)

    // A Worker reads its own current Ticket and nothing else.
    const ownWorker = await readHistory(address,
      `/v1/tools/memory/event-history?ticketId=${encodeURIComponent(ticket.id)}`, tokenOf(worker))
    expect(ownWorker.rows.length).toBeGreaterThan(0)
    const foreignWorker = await readHistory(address,
      `/v1/tools/memory/event-history?ticketId=${encodeURIComponent(theirs.ticket.id)}`, tokenOf(worker))
    expect(foreignWorker.rows).toHaveLength(0)
    expect(foreignWorker.total).toBe(0)
  })

  it('refuses a Session that may read no history at all', async () => {
    const { address, worker } = await open()

    // A Worker that names no key asks for everything: the history is read by an exact key.
    const unscoped = await get(address, '/v1/tools/memory/event-history', tokenOf(worker))
    expect(unscoped.status).toBe(400)

    // A Session whose authority was revoked opens nothing, whatever its token says.
    await control!.revokeSession(worker, 'the operator withdrew it')
    const revoked = await get(address,
      '/v1/tools/memory/event-history?ticketId=whatever', tokenOf(worker))
    expect(revoked.status).toBe(401)
  })

  it('is a read: it writes nothing and starts nothing', async () => {
    const { address } = await open()
    const commands = node!.commands.length
    const before = (await readHistory(address, '/v1/console/memory/event-history', API_TOKEN)).total

    await readHistory(address, '/v1/console/memory/event-history', VIEWER_TOKEN)
    await get(address, '/v1/tools/memory/event-history?ticketId=t1', tokenOf('router'))

    expect(node!.commands.length).toBe(commands)
    expect((await readHistory(address, '/v1/console/memory/event-history', API_TOKEN)).total).toBe(before)
  })
})

/**
 * The tool the node registers for the three roles: the advertisement and the call it really makes.
 */
describe('the control_event_history_query tool', () => {
  /** A DSH Agent stand-in with exactly the registry surface `createDshPortHost` uses. */
  class FakeAgent {
    readonly tools = new Map<string, { name: string; description: string; parameters: unknown
      execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }>()
    readonly ctx = { tools: { register: (definition: { name: string; description: string; parameters: unknown
      execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }): (() => void) => {
      this.tools.set(definition.name, definition)
      return () => { this.tools.delete(definition.name) }
    } } }
  }

  it('is registered for the Router, the PM and the Worker, and it reads by an exact key', async () => {
    const { address, pm, worker } = await open()

    const agents = new Map<string, FakeAgent>()
    const prompts: { sessionId: string; text: string }[] = []
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string;
      signal?: AbortSignal } }[] = []
    const fetchImpl: DshPortFetch = async (url, init) => {
      calls.push({ url, init })
      const response = await fetch(`${address.url}${url.replace(/^https?:\/\/[^/]+/, '')}`,
        { method: init.method, headers: init.headers })
      return { ok: response.ok, status: response.status, text: async () => await response.text() }
    }
    const sessions = {
      async ensure(sessionId: string) {
        const agent = new FakeAgent()
        agents.set(sessionId, agent)
        return agent
      },
      async prompt(sessionId: string, _key: string, text: string) { prompts.push({ sessionId, text }) },
    }
    const root = join(directory, 'node')
    mkdirSync(root, { recursive: true })
    const host = createDshPortHost({ context: { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } },
      nodeRuntime: { sessions }, nodeId: NODE_ID, root, controlUrl: address.url, fetch: fetchImpl })

    for (const [sessionId, role, profile, token] of [
      ['router', 'router', ROUTER_PROFILE, tokenOf('router')],
      ['pm-1', 'pm', PM_PROFILE, tokenOf(pm.sessionId)],
      ['worker-1', 'worker', WORKER_PROFILE, tokenOf(worker)],
    ] as const) {
      await host.ensureSession({ sessionId, workspace: join(root, 'w'), title: 'Session', role,
        profile, prompt: profile.prompt, sessionToken: token })
      expect(agents.get(sessionId)!.tools.has('control_event_history_query'), sessionId).toBe(true)
      expect(profile.tools, sessionId).toContain('control_event_history_query')
      // The role prompt is not touched by this round: the tool is exposed, not injected into the bootstrap.
      const delivered = prompts.find(entry => entry.sessionId === sessionId)!.text
      expect(delivered).toContain(profile.prompt)
      expect(delivered).not.toContain('control_event_history_query')
    }

    const tool = agents.get('router')!.tools.get('control_event_history_query')!
    const answer = await tool.execute({ ticketId: 'ticket-1' }, { signal: new AbortController().signal })
    expect(answer).toBeDefined()
    const call = calls.find(entry => entry.url.includes('/v1/tools/memory/event-history'))!
    expect(call).toBeDefined()
    expect(call.init.method).toBe('GET')
    expect(call.url).toContain('ticketId=ticket-1')
    expect(call.init.headers.authorization).toBe(`Bearer ${tokenOf('router')}`)

    // A call that names no key is refused by the tool itself, before it reaches the control plane.
    await expect(tool.execute({}, { signal: new AbortController().signal })).rejects.toThrow(/exact key/i)
  })
})
