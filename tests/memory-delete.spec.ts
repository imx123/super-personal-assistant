/**
 * The permanent deletion of a long-term memory.
 *
 * The decision the user took is a deletion and not a suppression: the body of the memory goes away with the row that
 * held it, together with the copies of those words that wait in the queue, the entries the keyword index holds and the
 * claims that named it. Nothing of the deleted fact is kept — no fingerprint, no archived copy, no tombstone — and the
 * history around it keeps its own rules.
 *
 * These tests exercise the parts that are easier to state as records than as a running control plane: the rows that go
 * with the memory, the copies that stay, the index that loses its words and the ledger that stops replaying a block that
 * carries a body which is gone. The parts that have to happen through the real paths — the console's own read, the tool
 * a Session calls with its own token, the browser's own confirmation — are exercised against a running control plane and
 * a real `FakeNode`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { MemoryService, type MemoryHost } from '../src/memory/memory-service.ts'
import type { MemoryCaller, MemorySourceRecord, SourceRefKind } from '../src/memory/memory-scope.ts'
import { MemoryRetriever } from '../src/memory/retriever.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'

const API_TOKEN = 'delete-api-token'
const VIEWER_TOKEN = 'delete-viewer-token'
const SECRET = 'delete-secret'
const START = '2026-11-19T08:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode | undefined

/** The caller the console acts as: a person, not a Session. */
const operator: MemoryCaller = { role: 'operator', sessionId: '', nodeId: '', projectId: undefined, ticketId: undefined }

/** The Router of this control plane, as a caller. */
const router: MemoryCaller = { role: 'router', sessionId: 'router', nodeId: NODE_ID, projectId: undefined, ticketId: undefined }

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  node = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

/**
 * The memory service and its keyword index on one SQLite file.
 *
 * The memories are written the way the control plane writes them — a proposal, then a decision by a person — so what is
 * read back is what a person really decided and not a row a test typed in.
 */
class Bench {
  readonly db: DatabaseSync
  readonly service: MemoryService
  readonly retriever: MemoryRetriever
  /** The moment the service and the retriever read as "now". */
  at = START
  /** The records the control plane really holds. */
  readonly sources = new Map<string, MemorySourceRecord>()
  /** The Projects the control plane knows. */
  readonly projects: string[] = ['p1', 'p2']
  /** The machines the control plane knows. */
  readonly nodes: string[] = [NODE_ID]

  constructor(path?: string) {
    this.db = new DatabaseSync(path ?? ':memory:')
    this.service = new MemoryService(this.db, this.host())
    this.retriever = new MemoryRetriever(this.db, { now: () => this.at })
  }

  /** The host of the bench: the records the service reads and the clock it reads them at. */
  host(): MemoryHost {
    return {
      now: () => this.at,
      nodeId: () => NODE_ID,
      backendId: () => 'dsh',
      nodeIds: () => this.nodes,
      projectIds: () => this.projects,
      source: (kind, id) => this.sources.get(`${kind}:${id}`),
    }
  }

  /** One record the control plane really holds. */
  hold(kind: SourceRefKind, id: string, record: MemorySourceRecord): void {
    this.sources.set(`${kind}:${id}`, record)
  }

  /**
   * One memory, written the way the control plane writes it: a proposal, then a decision by a person.
   *
   * It answers the id of the memory that came out of it.
   */
  remember(content: string, scope: { readonly scopeType: string; readonly scopeId: string }): string {
    const proposed = this.service.submit({ caller: operator, content, scope })
    if (!proposed.ok) throw new Error(`The proposal was refused: ${proposed.reason}`)
    if (proposed.candidate === undefined) throw new Error('The proposal was not disclosed to this caller.')
    const decided = this.service.decide({
      caller: operator,
      candidateId: proposed.candidate.candidateId,
      decision: 'approve',
      expectedChecksum: proposed.candidate.checksum,
    })
    if (!decided.ok) throw new Error(`The decision was refused: ${decided.reason}`)
    if (decided.memory === undefined) throw new Error('The decision made no memory.')
    return decided.memory.memoryId
  }

  /** The checksum of one memory, as the console reads it. */
  checksum(memoryId: string): string {
    const before = this.service.readMemory(operator, memoryId)
    return before.found ? before.memory.checksum : ''
  }

  /** The tables this file holds. */
  tables(): string[] {
    return (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as
      { name: string }[]).map(row => row.name)
  }

  /** The rows of the keyword index, as the index itself holds them. */
  indexed(): { rowid: number; content: string }[] {
    return this.db.prepare('SELECT rowid, content FROM long_term_memories_fts ORDER BY rowid').all() as
      { rowid: number; content: string }[]
  }

  /** Every row of the memory table, as the table holds it. */
  memories(): { content: string; status: string; content_fingerprint: string }[] {
    return this.db.prepare('SELECT content, status, content_fingerprint FROM long_term_memories ORDER BY seq').all() as
      { content: string; status: string; content_fingerprint: string }[]
  }

  /** The rows the keyword index still answers with for a word. */
  matches(term: string): { rowid: number }[] {
    return this.db.prepare('SELECT rowid FROM long_term_memories_fts WHERE long_term_memories_fts MATCH ?')
      .all(`"${term}"`) as { rowid: number }[]
  }
}

// ─── the service, on its own ───────────────────────────────────────────────────────────────────────────────

describe('the permanent deletion, on its own', () => {
  it('takes the body, the copies of it and the index entries with it', () => {
    const bench = new Bench()
    const memoryId = bench.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })
    // A proposal of the very same words waits in the queue: it is a copy of the body.
    bench.hold('operator_message', 'msg-1', { at: START, authoritative: false, tainted: false,
      text: '这个项目统一使用 pnpm 安装依赖' })
    const waiting = bench.service.submit({ caller: router, content: '这个项目统一使用 pnpm 安装依赖',
      scope: { scopeType: 'project', scopeId: 'project:p1' },
      sourceRefs: [{ kind: 'operator_message', id: 'msg-1' }] })
    if (!waiting.ok || waiting.candidate === undefined) throw new Error('The proposal was refused.')

    // The index holds the words of the memory before the deletion.
    expect(bench.indexed().map(row => row.content)).toContain('这个项目统一使用 pnpm 安装依赖')

    const deleted = bench.service.deleteMemory({ caller: operator, memoryId, expectedChecksum: bench.checksum(memoryId),
      reason: '操作员显式永久删除' })
    expect(deleted.ok).toBe(true)

    // The body is gone: not from the memory table, not from the queue, not from the index.
    expect(bench.memories()).toEqual([])
    const candidates = bench.db.prepare('SELECT content FROM memory_candidates').all() as { content: string }[]
    expect(JSON.stringify(candidates)).not.toContain('pnpm')
    expect(bench.indexed()).toEqual([])
    // The words are gone from the index too: it answers with nothing for them any more.
    expect(bench.matches('pnpm')).toEqual([])
  })

  it('keeps no tombstone and no fingerprint of what it deleted', () => {
    const bench = new Bench()
    const memoryId = bench.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })
    const fingerprint = bench.db.prepare('SELECT content_fingerprint FROM long_term_memories WHERE memory_id = ?')
      .get(memoryId) as { content_fingerprint: string }

    bench.service.deleteMemory({ caller: operator, memoryId, expectedChecksum: bench.checksum(memoryId) })

    // There is no table that would keep a fingerprint of the deleted fact.
    expect(bench.tables()).not.toContain('memory_tombstones')
    // And nothing that is left holds that fingerprint.
    const kept = bench.db.prepare('SELECT content_fingerprint FROM long_term_memories').all() as
      { content_fingerprint: string }[]
    expect(kept.map(row => row.content_fingerprint)).not.toContain(fingerprint.content_fingerprint)
  })

  it('keeps the other scope and the other body, and keeps the old tickets alone', () => {
    const bench = new Bench()
    const deleted = bench.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })
    const otherScope = bench.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p2' })
    const otherBody = bench.remember('这个项目统一使用 npm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })

    bench.service.deleteMemory({ caller: operator, memoryId: deleted, expectedChecksum: bench.checksum(deleted) })

    const kept = bench.memories()
    expect(kept.map(row => row.content)).toEqual(['这个项目统一使用 pnpm 安装依赖', '这个项目统一使用 npm 安装依赖'])
    expect(bench.service.readMemory(operator, otherScope).found).toBe(true)
    expect(bench.service.readMemory(operator, otherBody).found).toBe(true)
  })

  it('does not let a review that was dispatched before the deletion revive the body', () => {
    const bench = new Bench()
    const memoryId = bench.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })
    // A proposal of the same words waits in the queue, and the manager was woken for it.
    bench.hold('operator_message', 'msg-1', { at: START, authoritative: false, tainted: false,
      text: '这个项目统一使用 pnpm 安装依赖' })
    const waiting = bench.service.submit({ caller: router, content: '这个项目统一使用 pnpm 安装依赖',
      scope: { scopeType: 'project', scopeId: 'project:p1' },
      sourceRefs: [{ kind: 'operator_message', id: 'msg-1' }] })
    if (!waiting.ok || waiting.candidate === undefined) throw new Error('The proposal was refused.')
    const candidateId = waiting.candidate.candidateId

    bench.service.deleteMemory({ caller: operator, memoryId, expectedChecksum: bench.checksum(memoryId) })

    // The review that was already under way cannot decide about a candidate that is gone.
    const decided = bench.service.decide({ caller: operator, candidateId, decision: 'approve',
      expectedChecksum: waiting.candidate.checksum })
    expect(decided.ok).toBe(false)
    // And the memory did not come back through it.
    expect(bench.memories()).toEqual([])
  })

  it('lets the same fact be proposed again, and gives it a new id', () => {
    const bench = new Bench()
    const memoryId = bench.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })
    bench.service.deleteMemory({ caller: operator, memoryId, expectedChecksum: bench.checksum(memoryId) })

    const again = bench.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })
    // The id sequence only grows: the new memory is not the old one.
    expect(again).not.toBe(memoryId)
    expect(again > memoryId).toBe(true)
  })

  it('keeps the index free of the deleted words after the database is opened again', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'superagent-delete-')), 'control.sqlite')
    const bench = new Bench(file)
    const memoryId = bench.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })
    bench.service.deleteMemory({ caller: operator, memoryId, expectedChecksum: bench.checksum(memoryId) })
    bench.db.close()

    // The database is opened again, and the index is rebuilt from the table: the deleted body does not come back.
    const again = new Bench(file)
    expect(again.indexed()).toEqual([])
    expect(again.matches('pnpm')).toEqual([])
    expect(again.memories()).toEqual([])
    again.db.close()
    rmSync(join(file, '..'), { recursive: true, force: true })
  })

  it('stops replaying a block that carries a body which was deleted', () => {
    const bench = new Bench()
    const memoryId = bench.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })
    // A turn carried this memory: the ledger holds the block it really sent.
    bench.service.recordInjection({
      injectionId: 'inj-1',
      sessionId: 'router',
      role: 'router',
      assignmentId: '',
      ticketId: '',
      projectId: '',
      nodeId: NODE_ID,
      generation: '1.0.0',
      deliveryId: 'router-msg:1',
      block: '<context_reference_data>\n这个项目统一使用 pnpm 安装依赖\n</context_reference_data>',
      memoryIds: [memoryId],
      provisionalIds: [],
    })

    bench.service.deleteMemory({ caller: operator, memoryId, expectedChecksum: bench.checksum(memoryId) })

    // The snapshot that carried the deleted body is withdrawn: it may not go out again.
    const row = bench.db.prepare('SELECT block, memory_ids FROM memory_context_injections WHERE injection_id = ?')
      .get('inj-1') as { block: string; memory_ids: string }
    expect(row.block).toBe('')
    expect(row.memory_ids).toBe('[]')
  })

  it('takes the rows that are not in force away as well: a waiting review and an old version', () => {
    // **A fact that waits for a review.** It is called misleading often enough, so it stops being injected on its own and
    // waits for somebody to look at it again. Its body is still in the running library, and a person has to be able to
    // make it go.
    const bench = new Bench()
    const memoryId = bench.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })
    for (let index = 0; index < 7; index += 1) {
      const disputed = bench.service.disputeMemory({ caller: operator, memoryId })
      if (!disputed.ok) throw new Error(`The dispute was refused: ${disputed.reason}`)
    }
    const waiting = bench.service.readMemory(operator, memoryId, { includeInactive: true })
    expect(waiting.found).toBe(true)
    if (!waiting.found) return
    expect(waiting.memory.status).toBe('needs_reverify')
    // The recall and the read by id still answer with the memories that are in force, and with nothing else.
    expect(bench.service.readMemory(operator, memoryId).found).toBe(false)

    const deleted = bench.service.deleteMemory({ caller: operator, memoryId, expectedChecksum: waiting.memory.checksum })
    expect(deleted.ok).toBe(true)
    expect(bench.memories()).toEqual([])

    // **An old version.** The row a newer one replaced keeps its history, and it is still in the running library with its
    // body in it. It goes the same way, and the version that is in force is a fact of its own and stays.
    const other = new Bench()
    const oldId = other.remember('这个项目统一使用 pnpm 安装依赖', { scopeType: 'project', scopeId: 'project:p1' })
    const before = other.service.readMemory(operator, oldId)
    if (!before.found) throw new Error('The memory was not written.')
    const edited = other.service.editMemory({ caller: operator, memoryId: oldId,
      expectedChecksum: before.memory.checksum, content: '这个项目统一使用 pnpm 安装依赖，并且要跑测试' })
    expect(edited.ok).toBe(true)
    const old = other.service.readMemory(operator, oldId, { includeInactive: true })
    expect(old.found).toBe(true)
    if (!old.found) return
    expect(old.memory.status).toBe('superseded')

    const removed = other.service.deleteMemory({ caller: operator, memoryId: oldId, expectedChecksum: old.memory.checksum })
    expect(removed.ok).toBe(true)
    // The version that is in force is another fact: it is still there.
    expect(other.memories().map(row => row.content)).toEqual(['这个项目统一使用 pnpm 安装依赖，并且要跑测试'])
  })
})

// ─── through the real control plane ───────────────────────────────────────────────────────────────────────

describe('the permanent deletion, through the control plane', () => {
  /**
   * A control plane with a node and one Project, listening on a random port.
   *
   * The console's own key may write; the viewer's may only read. The Project has its PM, so the tool a Session calls
   * with its own token can be exercised as well.
   */
  async function open(): Promise<{ address: { url: string }; projectId: string; pmSessionId: string }> {
    directory = mkdtempSync(join(tmpdir(), 'superagent-delete-plane-'))
    const root = join(directory, 'workspaces')
    node = new FakeNode({ nodeId: NODE_ID, root, now: () => START })
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
      workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()
    await control.ensureRouter()
    const project = control.createProjectFromOperator('控制台改造', '让操作员看得到状态')
    const pm = await control.openProject(project.id)
    server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
    const address = await server.listen(0)
    return { address, projectId: project.id, pmSessionId: pm.sessionId }
  }

  /** The token the node issued for one Session. */
  function tokenOf(sessionId: string): string {
    const token = node?.tokens.get(sessionId)
    if (!token) throw new Error(`The node issued no token for ${sessionId}`)
    return token
  }

  async function get(address: { url: string }, path: string, token = API_TOKEN): Promise<Response> {
    return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
  }

  async function post(address: { url: string }, path: string, body: unknown, token = API_TOKEN): Promise<Response> {
    return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  /**
   * One memory, written by a person and decided by a person.
   *
   * It answers the memory as the console reads it, with the checksum a governance act has to name.
   */
  async function rememberOf(address: { url: string }, projectId: string, content: string):
    Promise<{ memoryId: string; checksum: string }> {
    const proposed = await post(address, '/v1/console/memory/candidates',
      { content, scopeType: 'project', scopeId: `project:${projectId}` })
    const body = await proposed.json() as { candidate: { candidateId: string; checksum: string } }
    const decided = await post(address, `/v1/console/memory/candidates/${body.candidate.candidateId}/decision`,
      { decision: 'approve', checksum: body.candidate.checksum })
    expect(decided.status).toBe(200)
    const memories = await (await get(address, '/v1/console/memory/memories')).json() as
      { rows: { memoryId: string; checksum: string }[] }
    const memory = memories.rows[0]
    expect(memory).toBeDefined()
    return memory!
  }

  it('answers an unknown id and a deleted one with the same 404 and the same words', async () => {
    const { address, projectId } = await open()
    const memory = await rememberOf(address, projectId, '这个项目统一使用 pnpm 安装依赖')

    const deleted = await post(address, `/v1/console/memory/memories/${memory.memoryId}/delete`,
      { checksum: memory.checksum })
    expect(deleted.status).toBe(200)

    const unknown = await get(address, '/v1/console/memory/memories/mem_000000999999')
    const gone = await get(address, `/v1/console/memory/memories/${memory.memoryId}`)
    expect(unknown.status).toBe(404)
    expect(gone.status).toBe(404)
    expect(await gone.text()).toBe(await unknown.text())
  })

  it('refuses the viewer and a stale checksum, and changes nothing when it refuses', async () => {
    const { address, projectId } = await open()
    const memory = await rememberOf(address, projectId, '这个项目统一使用 pnpm 安装依赖')

    // The read-only viewer may not delete.
    const refused = await post(address, `/v1/console/memory/memories/${memory.memoryId}/delete`,
      { checksum: memory.checksum }, VIEWER_TOKEN)
    expect(refused.status).toBe(403)

    // A checksum of an older version is refused as well.
    const stale = await post(address, `/v1/console/memory/memories/${memory.memoryId}/delete`,
      { checksum: 'not-the-current-checksum' })
    expect(stale.status).toBe(409)

    // Nothing changed: the memory is still there.
    expect((await get(address, `/v1/console/memory/memories/${memory.memoryId}`)).status).toBe(200)
  })

  it('does not let the search answer with a memory that was deleted', async () => {
    const { address, projectId } = await open()
    const memory = await rememberOf(address, projectId, '这个项目统一使用 pnpm 安装依赖')
    await post(address, `/v1/console/memory/memories/${memory.memoryId}/delete`, { checksum: memory.checksum })

    const found = await (await get(address, '/v1/console/memory/search?q=pnpm')).json() as
      { hits: { memoryId: string }[] }
    expect(found.hits).toEqual([])
  })

  it('takes the row off the console\'s own list, so the page shows the truth after it', async () => {
    const { address, projectId } = await open()
    const memory = await rememberOf(address, projectId, '这个项目统一使用 pnpm 安装依赖')

    const deleted = await post(address, `/v1/console/memory/memories/${memory.memoryId}/delete`,
      { checksum: memory.checksum })
    expect(deleted.status).toBe(200)
    // The answer says what is gone and never what it said.
    const raw = await deleted.text()
    const answer = JSON.parse(raw) as { deleted: { memoryId: string; removedMemories: number } }
    expect(answer.deleted.memoryId).toBe(memory.memoryId)
    expect(answer.deleted.removedMemories).toBeGreaterThanOrEqual(1)
    expect(raw).not.toContain('pnpm')

    // The list the page reads again does not hold it any more.
    const list = await (await get(address, '/v1/console/memory/memories')).json() as
      { rows: { memoryId: string }[] }
    expect(list.rows.map(row => row.memoryId)).not.toContain(memory.memoryId)
  })

  it('leaves the work itself alone: the Ticket, the Session and the event history are still there', async () => {
    const { address, projectId, pmSessionId } = await open()
    const memory = await rememberOf(address, projectId, '这个项目统一使用 pnpm 安装依赖')

    // The PM dispatches a Ticket: the work of the Project has records of its own.
    const tickets = await post(address, '/v1/tools/pm/tickets',
      { tasks: [{ title: '做一件事', goal: '做完它' }] }, tokenOf(pmSessionId))
    expect(tickets.status).toBe(200)
    const created = await tickets.json() as { tickets: { id: string }[] }
    const ticketId = created.tickets[0]!.id
    const historyBefore = await (await get(address, '/v1/console/memory/event-history')).json() as
      { rows: { eventId: string }[] }

    await post(address, `/v1/console/memory/memories/${memory.memoryId}/delete`, { checksum: memory.checksum })

    // The work is untouched: the Ticket, the Session of the PM and the durable event history are all still there.
    expect(control!.store.tickets.get(ticketId)).toBeDefined()
    expect(control!.sessions.get(pmSessionId)).toBeDefined()
    const historyAfter = await (await get(address, '/v1/console/memory/event-history')).json() as
      { rows: { eventId: string }[] }
    for (const row of historyBefore.rows) {
      expect(historyAfter.rows.some(other => other.eventId === row.eventId)).toBe(true)
    }
  })

  it('answers a read by id — for a Session too — with the same not-found as an unknown id', async () => {
    const { address, projectId, pmSessionId } = await open()
    const memory = await rememberOf(address, projectId, '这个项目统一使用 pnpm 安装依赖')
    const pmToken = tokenOf(pmSessionId)

    // The PM reads that one memory by its id, with its own token.
    const read = await get(address, `/v1/tools/memory/search?memoryId=${memory.memoryId}`, pmToken)
    expect(read.status).toBe(200)
    const found = await read.json() as { memory: { memoryId: string; content: string } }
    expect(found.memory.memoryId).toBe(memory.memoryId)

    await post(address, `/v1/console/memory/memories/${memory.memoryId}/delete`, { checksum: memory.checksum })

    // The deleted id and an id that was never given are one answer, on the Session's path as well.
    const gone = await get(address, `/v1/tools/memory/search?memoryId=${memory.memoryId}`, pmToken)
    const unknown = await get(address, '/v1/tools/memory/search?memoryId=mem_000000999999', pmToken)
    expect(gone.status).toBe(404)
    expect(unknown.status).toBe(404)
    const goneText = await gone.text()
    expect(goneText).toBe(await unknown.text())
    expect(goneText).toContain('记忆不存在或已被用户删除')
  })

  it('answers the search of the past and the read of one memory, and refuses a request that names both', async () => {
    const { address, projectId, pmSessionId } = await open()
    const memory = await rememberOf(address, projectId, '这个项目统一使用 pnpm 安装依赖')
    const pmToken = tokenOf(pmSessionId)

    // The search of the past still answers: it asks for the memories that answer a question.
    const searched = await get(address, '/v1/tools/memory/search?q=pnpm', pmToken)
    expect(searched.status).toBe(200)
    const hits = await searched.json() as { hits: { memoryId: string }[] }
    expect(hits.hits.map(hit => hit.memoryId)).toContain(memory.memoryId)

    // One memory by its id: the same answer as before.
    const read = await get(address, `/v1/tools/memory/search?memoryId=${memory.memoryId}`, pmToken)
    expect(read.status).toBe(200)

    // A request that names both asks for two different things at once, and a parameter that is there but empty asks for
    // nothing: both are refused.
    const both = await get(address, `/v1/tools/memory/search?q=pnpm&memoryId=${memory.memoryId}`, pmToken)
    expect(both.status).toBe(400)
    const empty = await get(address, '/v1/tools/memory/search?memoryId=', pmToken)
    expect(empty.status).toBe(400)
  })

  it('shows the rows that are not in force when they are asked for, and deletes one of them the same way', async () => {
    const { address, projectId } = await open()
    const memory = await rememberOf(address, projectId, '这个项目统一使用 pnpm 安装依赖')

    // A new version: the old one keeps its history and leaves the recall.
    const edited = await post(address, `/v1/console/memory/memories/${memory.memoryId}/edit`,
      { content: '这个项目统一使用 pnpm 安装依赖，并且要跑测试', checksum: memory.checksum })
    expect(edited.status).toBe(200)
    const versions = await edited.json() as { memory: { memoryId: string };
      replaced: { memoryId: string; checksum: string } }

    // The list holds the memories that are in force; the old version is not among them.
    const active = await (await get(address, '/v1/console/memory/memories')).json() as { rows: { memoryId: string }[] }
    expect(active.rows.map(row => row.memoryId)).toEqual([versions.memory.memoryId])

    // Asked for, the rows that are not in force are shown beside them, each with its own state.
    const all = await (await get(address, '/v1/console/memory/memories?includeInactive=true')).json() as
      { rows: { memoryId: string; status: string }[] }
    expect(all.rows.map(row => row.memoryId).sort())
      .toEqual([versions.memory.memoryId, versions.replaced.memoryId].sort())
    expect(all.rows.find(row => row.memoryId === versions.replaced.memoryId)?.status).toBe('superseded')

    // The old version is deleted the same way: the version that was read is the version the act is made on.
    const deleted = await post(address, `/v1/console/memory/memories/${versions.replaced.memoryId}/delete`,
      { checksum: versions.replaced.checksum })
    expect(deleted.status).toBe(200)

    const left = await (await get(address, '/v1/console/memory/memories?includeInactive=true')).json() as
      { rows: { memoryId: string }[] }
    expect(left.rows.map(row => row.memoryId)).toEqual([versions.memory.memoryId])
  })
})
