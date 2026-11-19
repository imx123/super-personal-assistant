/**
 * The long-term memory: the queue of proposals, the memories a decision made of them, and what a caller may not do.
 *
 * The service is exercised on its own for the rules that are easier to state as records than as a running control plane:
 * the idempotency of a proposal, the scope of a caller, the trust that is derived from the records a proposal names,
 * the redaction on both sides and the checksum that stops two people deciding about the same proposal twice. The
 * control plane is exercised through its own real paths — the console's own routes and the records the control plane
 * really holds — so that what the memory holds is what really happened and not a label somebody typed.
 *
 * The deletion of a memory is not part of this: it has its own file (`tests/memory-delete.spec.ts`), because it is a
 * different kind of act — one that takes a body away — and it deserves assertions of its own.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { MemoryService, type MemoryHost } from '../src/memory/memory-service.ts'
import type { MemoryCaller, MemorySourceRecord, SourceRefKind } from '../src/memory/memory-scope.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'

const API_TOKEN = 'memory-api-token'
const VIEWER_TOKEN = 'memory-viewer-token'
const START = '2026-11-19T08:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode | undefined

/** The caller the console acts as: a person, not a Session. */
const operator: MemoryCaller = { role: 'operator', sessionId: '', nodeId: '', projectId: undefined, ticketId: undefined }

/** The Router of this control plane, as a caller. */
const router: MemoryCaller = { role: 'router', sessionId: 'router', nodeId: NODE_ID, projectId: undefined,
  ticketId: undefined }

/** A PM of the Project `p1`, as a caller. */
const pm: MemoryCaller = { role: 'pm', sessionId: 'pm-p1', nodeId: NODE_ID, projectId: 'p1', ticketId: undefined }

/** A Worker of the Ticket `t1`, as a caller. */
const worker: MemoryCaller = { role: 'worker', sessionId: 'worker-a1', nodeId: NODE_ID, projectId: 'p1', ticketId: 't1' }

/**
 * The service on its own: one SQLite file, one host, one clock the test moves by hand.
 *
 * The host holds the records a source reference may name. A record the host does not hold is a record the control plane
 * cannot check, and the fact that leans on it loses its trust.
 */
class Bench {
  readonly db: DatabaseSync
  readonly service: MemoryService
  /** The moment the service reads as "now". */
  at = START
  /** The records the control plane really holds. */
  readonly sources = new Map<string, MemorySourceRecord>()
  /** The Projects the control plane knows. */
  readonly projects: string[] = ['p1']
  /** The machines the control plane knows. */
  readonly nodes: string[] = [NODE_ID]

  constructor(path?: string) {
    this.db = new DatabaseSync(path ?? ':memory:')
    this.service = new MemoryService(this.db, this.host())
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

  /** Move the clock on, so two moments are a moment apart. */
  tick(seconds = 1): void {
    this.at = new Date(Date.parse(this.at) + seconds * 1000).toISOString()
  }
}

/** The answer of a proposal, narrowed to the part a test reads. */
function submitted(result: ReturnType<MemoryService['submit']>): { candidateId: string; status: string;
  sourceTrust: string; provisionalSameSession: boolean } {
  if (!result.ok) throw new Error(`The proposal was refused: ${result.reason}`)
  if (result.candidate === undefined) throw new Error('The proposal was not disclosed to this caller.')
  return {
    candidateId: result.candidate.candidateId,
    status: result.candidate.status,
    sourceTrust: result.candidate.sourceTrust,
    provisionalSameSession: result.candidate.provisionalSameSession,
  }
}

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

describe('the memory service, on its own', () => {
  it('writes one candidate for one proposal, however often it is offered', () => {
    const bench = new Bench()
    const first = bench.service.submit({ caller: operator, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const second = bench.service.submit({ caller: operator, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(submitted(second).candidateId).toBe(submitted(first).candidateId)
    expect(second.ok && second.duplicate).toBe(true)
    expect(bench.service.listCandidates(operator).total).toBe(1)
  })

  it('keeps the same words apart when they belong to another scope', () => {
    const bench = new Bench()
    bench.service.submit({ caller: operator, content: '统一用 pnpm。', scope: { scopeType: 'project', scopeId: 'project:p1' } })
    bench.service.submit({ caller: operator, content: '统一用 pnpm。', scope: { scopeType: 'user_global', scopeId: 'global' } })
    expect(bench.service.listCandidates(operator).total).toBe(2)
  })

  it('refuses a body that carries a path or a secret', () => {
    const bench = new Bench()
    const path = bench.service.submit({ caller: operator, content: '源码在 C:\\Users\\max\\project 里。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    expect(path.ok).toBe(false)
    expect(path.ok === false && path.code).toBe('REDACTION_REJECTED')
    const secret = bench.service.submit({ caller: operator, content: '模型密钥是 sk-abcdefghijklmnopqrstuvwxyz。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    expect(secret.ok).toBe(false)
    expect(secret.ok === false && secret.code).toBe('REDACTION_REJECTED')
    // Nothing was written: a refused proposal leaves no row behind.
    expect(bench.service.listCandidates(operator).total).toBe(0)
  })

  it('refuses a proposal outside the caller’s own scope', () => {
    const bench = new Bench()
    const global = bench.service.submit({ caller: worker, content: '以后都用 pnpm。',
      scope: { scopeType: 'user_global', scopeId: 'global' } })
    expect(global.ok).toBe(false)
    expect(global.ok === false && global.code).toBe('SCOPE_NOT_PERMITTED')
    const foreign = bench.service.submit({ caller: worker, content: '这个项目用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p2' } })
    expect(foreign.ok).toBe(false)
    expect(foreign.ok === false && foreign.code).toBe('SCOPE_NOT_PERMITTED')
  })

  it('never lets a fact whose sources could not be checked become a global one', () => {
    const bench = new Bench()
    // The control plane holds no such review, so the fact that leans on it is not a verified conclusion.
    const result = bench.service.submit({ caller: pm, content: '这个项目改用 vitest。',
      scope: { scopeType: 'user_global', scopeId: 'global' },
      sourceRefs: [{ kind: 'review', id: 'review-1', summary: '评审通过' }] })
    expect(submitted(result).sourceTrust).toBe('external_tainted')
    expect(submitted(result).status).toBe('pending_human_confirm')
    const decision = bench.service.decide({ caller: operator, candidateId: submitted(result).candidateId,
      decision: 'approve', expectedChecksum: bench.service.listCandidates(operator).rows[0]!.checksum })
    expect(decision.ok).toBe(false)
    expect(decision.ok === false && decision.code).toBe('GLOBAL_PROMOTION_REFUSED')
    expect(bench.service.listMemories(operator).total).toBe(0)
  })

  it('takes the trust of a fact from the records it names, not from what the caller says', () => {
    const bench = new Bench()
    bench.hold('review', 'review-1', { at: START, authoritative: true, tainted: false, projectId: 'p1' })
    bench.hold('delivery', 'delivery-1', { at: START, authoritative: false, tainted: false })
    const verified = bench.service.submit({ caller: pm, content: '这个项目改用 vitest。',
      scope: { scopeType: 'project', scopeId: 'project:p1' },
      sourceRefs: [{ kind: 'review', id: 'review-1', summary: '评审通过' }] })
    expect(submitted(verified).sourceTrust).toBe('verified_execution')
    // A record the control plane holds but did not confirm is an observation, not a conclusion.
    const unverified = bench.service.submit({ caller: pm, content: '这个项目用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' },
      sourceRefs: [{ kind: 'delivery', id: 'delivery-1', summary: '报告摘要' }] })
    expect(submitted(unverified).sourceTrust).toBe('external_tainted')
  })

  it('keeps a proposal out of the trusted list until a decision says otherwise', () => {
    const bench = new Bench()
    const result = bench.service.submit({ caller: operator, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const candidate = bench.service.listCandidates(operator).rows[0]!
    expect(bench.service.listMemories(operator).total).toBe(0)
    const decision = bench.service.decide({ caller: operator, candidateId: candidate.candidateId,
      decision: 'approve', expectedChecksum: candidate.checksum })
    expect(decision.ok).toBe(true)
    expect(decision.ok && decision.code).toBe('APPROVED')
    const memories = bench.service.listMemories(operator)
    expect(memories.total).toBe(1)
    expect(memories.rows[0]!.content).toBe('这个项目统一用 pnpm。')
    expect(memories.rows[0]!.status).toBe('active')
  })

  it('lets only the session that heard the person read a proposal while it waits', () => {
    const bench = new Bench()
    bench.hold('operator_message', 'msg-1', { at: START, authoritative: false, tainted: false })
    const result = bench.service.submit({ caller: router, content: '以后都用 pnpm。',
      scope: { scopeType: 'user_global', scopeId: 'global' },
      sourceRefs: [{ kind: 'operator_message', id: 'msg-1', summary: '主窗口的原话' }] })
    expect(submitted(result).sourceTrust).toBe('operator_explicit')
    expect(submitted(result).provisionalSameSession).toBe(true)
    expect(bench.service.provisionalFor('router')).toHaveLength(1)
    // Another Session never sees the pending proposal of this one.
    expect(bench.service.provisionalFor('pm-p1')).toHaveLength(0)
    expect(bench.service.provisionalFor('worker-a1')).toHaveLength(0)
    // A Session reads only its own proposals, never the queue of another one.
    expect(bench.service.listCandidates(pm).total).toBe(0)
  })

  it('refuses a decision made on a candidate that changed since it was read', () => {
    const bench = new Bench()
    bench.service.submit({ caller: operator, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const candidate = bench.service.listCandidates(operator).rows[0]!
    bench.service.decide({ caller: operator, candidateId: candidate.candidateId, decision: 'approve',
      expectedChecksum: candidate.checksum })
    // The candidate has moved on, so a decision made on the older version is refused.
    const stale = bench.service.decide({ caller: operator, candidateId: candidate.candidateId, decision: 'reject',
      expectedChecksum: candidate.checksum })
    expect(stale.ok).toBe(false)
    expect(stale.ok === false && stale.code).toBe('STALE_CANDIDATE')
  })

  it('merges a repeated fact into the memory that is already there', () => {
    const bench = new Bench()
    bench.service.submit({ caller: operator, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const first = bench.service.listCandidates(operator).rows[0]!
    bench.service.decide({ caller: operator, candidateId: first.candidateId, decision: 'approve',
      expectedChecksum: first.checksum })
    // The same words, offered again with another source: one memory, and the source is added to it.
    bench.service.submit({ caller: operator, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' },
      sourceRefs: [{ kind: 'ticket', id: 't2', summary: '另一张工单' }] })
    const second = bench.service.listCandidates(operator).rows.find(row => row.candidateId !== first.candidateId)!
    const decision = bench.service.decide({ caller: operator, candidateId: second.candidateId, decision: 'approve',
      expectedChecksum: second.checksum })
    expect(decision.ok).toBe(true)
    expect(decision.ok && decision.code).toBe('MERGED')
    const memories = bench.service.listMemories(operator)
    expect(memories.total).toBe(1)
    expect(memories.rows[0]!.sourceRefs).toHaveLength(1)
    expect(bench.service.listCandidates(operator).rows.find(row => row.candidateId === second.candidateId)!.status)
      .toBe('duplicate')
  })

  it('keeps the version that was replaced and names the one that replaced it', () => {
    const bench = new Bench()
    bench.service.submit({ caller: operator, content: '这个项目用 npm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const first = bench.service.listCandidates(operator).rows[0]!
    bench.service.decide({ caller: operator, candidateId: first.candidateId, decision: 'approve',
      expectedChecksum: first.checksum })
    const memory = bench.service.listMemories(operator).rows[0]!
    bench.service.submit({ caller: operator, content: '这个项目改用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const second = bench.service.listCandidates(operator).rows.find(row => row.candidateId !== first.candidateId)!
    const decision = bench.service.decide({ caller: operator, candidateId: second.candidateId, decision: 'supersede',
      expectedChecksum: second.checksum, memoryId: memory.memoryId })
    expect(decision.ok).toBe(true)
    expect(decision.ok && decision.code).toBe('SUPERSEDED')
    const active = bench.service.listMemories(operator)
    expect(active.total).toBe(1)
    expect(active.rows[0]!.supersedesId).toBe(memory.memoryId)
    const old = bench.service.readMemory(operator, memory.memoryId, { includeInactive: true })
    expect(old.found).toBe(true)
    expect(old.found && old.memory.status).toBe('superseded')
    expect(old.found && old.memory.deprecatedAt).not.toBe('')
  })

  it('holds both ends of a conflict and refuses to raise it twice', () => {
    const bench = new Bench()
    bench.service.submit({ caller: operator, content: '这个项目用 npm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const first = bench.service.listCandidates(operator).rows[0]!
    bench.service.decide({ caller: operator, candidateId: first.candidateId, decision: 'approve',
      expectedChecksum: first.checksum })
    const memory = bench.service.listMemories(operator).rows[0]!
    bench.service.submit({ caller: operator, content: '这个项目用 yarn。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const second = bench.service.listCandidates(operator).rows.find(row => row.candidateId !== first.candidateId)!
    const held = bench.service.decide({ caller: operator, candidateId: second.candidateId, decision: 'conflict',
      expectedChecksum: second.checksum, memoryId: memory.memoryId })
    expect(held.ok).toBe(true)
    expect(held.ok && held.code).toBe('CONFLICT_HELD')
    // Neither end is in force while the conflict is open.
    expect(bench.service.listMemories(operator).total).toBe(0)
    // The same conflict may not be raised a second time.
    bench.service.submit({ caller: operator, content: '这个项目用 bun。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const third = bench.service.listCandidates(operator).rows.find(row =>
      row.candidateId !== first.candidateId && row.candidateId !== second.candidateId)!
    const again = bench.service.decide({ caller: operator, candidateId: third.candidateId, decision: 'conflict',
      expectedChecksum: third.checksum, memoryId: memory.memoryId })
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.code).toBe('CONFLICT_ALREADY_OPEN')
  })

  it('reads a memory by its id and says nothing about an id that was never given', () => {
    const bench = new Bench()
    bench.service.submit({ caller: operator, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const candidate = bench.service.listCandidates(operator).rows[0]!
    bench.service.decide({ caller: operator, candidateId: candidate.candidateId, decision: 'approve',
      expectedChecksum: candidate.checksum })
    const memory = bench.service.listMemories(operator).rows[0]!
    expect(bench.service.readMemory(operator, memory.memoryId).found).toBe(true)
    const unknown = bench.service.readMemory(operator, 'mem_000000000999')
    expect(unknown.found).toBe(false)
    // A memory of another project is not there for a caller that owns only its own.
    const stranger: MemoryCaller = { role: 'pm', sessionId: 'pm-p2', nodeId: NODE_ID, projectId: 'p2',
      ticketId: undefined }
    expect(bench.service.readMemory(stranger, memory.memoryId).found).toBe(false)
    expect(bench.service.listMemories(stranger).total).toBe(0)
  })

  it('keeps the tables and the rows across a reopen of the database', () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-memory-'))
    const path = join(directory, 'control.sqlite')
    const first = new Bench(path)
    first.service.submit({ caller: operator, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const candidate = first.service.listCandidates(operator).rows[0]!
    first.service.decide({ caller: operator, candidateId: candidate.candidateId, decision: 'approve',
      expectedChecksum: candidate.checksum })
    first.db.close()

    const second = new Bench(path)
    expect(second.service.listMemories(operator).total).toBe(1)
    expect(second.service.listMemories(operator).rows[0]!.content).toBe('这个项目统一用 pnpm。')
    // The ids keep counting: an id is never handed out twice.
    second.service.submit({ caller: operator, content: '另一条事实。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    expect(second.service.listCandidates(operator).rows[0]!.candidateId).not.toBe(candidate.candidateId)
    second.db.close()
  })

  it('keeps a raw secret out of what it hands back', () => {
    const bench = new Bench()
    bench.hold('ticket', 't1', { at: START, authoritative: true, tainted: false, projectId: 'p1' })
    bench.service.submit({ caller: pm, content: '这个项目的测试命令是 npm test。',
      scope: { scopeType: 'project', scopeId: 'project:p1' },
      sourceRefs: [{ kind: 'ticket', id: 't1', summary: '工单里的 token: sk-abcdefghijklmnopqrstuvwxyz' }] })
    const candidate = bench.service.listCandidates(operator).rows[0]!
    expect(candidate.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(candidate.sourceRefs[0]!.summary).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(JSON.stringify(candidate)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
  })

  it('never shows one Session the row of a proposal another Session made', () => {
    const bench = new Bench()
    const first = bench.service.submit({ caller: router, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    expect(first.ok).toBe(true)
    // The Session that proposed it reads its own row again.
    const own = bench.service.submit({ caller: router, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    expect(own.ok).toBe(true)
    expect(own.ok && own.duplicate).toBe(true)
    expect(own.ok && own.candidate?.candidateId).toBe(submitted(first).candidateId)
    // Another Session is told that the proposal is already there, and nothing else: no row, no checksum, no sources.
    const stranger = bench.service.submit({ caller: pm, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    expect(stranger.ok).toBe(true)
    expect(stranger.ok && stranger.duplicate).toBe(true)
    expect(stranger.ok && stranger.candidate).toBeUndefined()
    // The operator reads the whole queue, so the operator sees the row.
    const seen = bench.service.submit({ caller: operator, content: '这个项目统一用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    expect(seen.ok && seen.candidate?.candidateId).toBe(submitted(first).candidateId)
  })

  it('keeps a fact that came from outside from touching the global scope', () => {
    const bench = new Bench()
    // A trusted global memory is already in force.
    bench.service.submit({ caller: operator, content: '统一用 pnpm。',
      scope: { scopeType: 'user_global', scopeId: 'global' } })
    const trusted = bench.service.listCandidates(operator).rows[0]!
    bench.service.decide({ caller: operator, candidateId: trusted.candidateId, decision: 'approve',
      expectedChecksum: trusted.checksum })
    const memory = bench.service.listMemories(operator).rows[0]!
    expect(memory.status).toBe('active')
    // A fact that came from outside waits for a person and may not touch the global scope by any way.
    const tainted = bench.service.submit({ caller: pm, content: '以后都用 pnpm。',
      scope: { scopeType: 'user_global', scopeId: 'global' },
      sourceRefs: [{ kind: 'review', id: 'review-unknown', summary: '评审通过' }] })
    expect(submitted(tainted).sourceTrust).toBe('external_tainted')
    const candidate = bench.service.listCandidates(operator).rows.find(row =>
      row.candidateId === submitted(tainted).candidateId)!
    for (const decision of ['approve', 'merge', 'conflict', 'supersede'] as const) {
      const refused = bench.service.decide({ caller: operator, candidateId: candidate.candidateId, decision,
        expectedChecksum: candidate.checksum, memoryId: memory.memoryId })
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('GLOBAL_PROMOTION_REFUSED')
    }
    // The global memory is untouched: it is still in force, and nothing was written beside it.
    const memories = bench.service.listMemories(operator)
    expect(memories.total).toBe(1)
    expect(memories.rows[0]!.memoryId).toBe(memory.memoryId)
    expect(memories.rows[0]!.status).toBe('active')
  })

  it('refuses a conflict against a memory of another scope', () => {
    const bench = new Bench()
    bench.service.submit({ caller: operator, content: '统一用 pnpm。',
      scope: { scopeType: 'user_global', scopeId: 'global' } })
    const first = bench.service.listCandidates(operator).rows[0]!
    bench.service.decide({ caller: operator, candidateId: first.candidateId, decision: 'approve',
      expectedChecksum: first.checksum })
    const memory = bench.service.listMemories(operator).rows[0]!
    bench.service.submit({ caller: operator, content: '这个项目用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const second = bench.service.listCandidates(operator).rows.find(row => row.candidateId !== first.candidateId)!
    const refused = bench.service.decide({ caller: operator, candidateId: second.candidateId, decision: 'conflict',
      expectedChecksum: second.checksum, memoryId: memory.memoryId })
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('SCOPE_MISMATCH')
    // The global memory is still in force: a candidate of another scope never touched it.
    const memories = bench.service.listMemories(operator)
    expect(memories.total).toBe(1)
    expect(memories.rows[0]!.status).toBe('active')
  })

  it('lets only a person decide about a candidate that waits for a human confirmation', () => {
    const bench = new Bench()
    const manager: MemoryCaller = { role: 'manager', sessionId: 'manager', nodeId: NODE_ID, projectId: undefined,
      ticketId: undefined }
    // A global fact always waits for a person.
    const result = bench.service.submit({ caller: operator, content: '统一用 pnpm。',
      scope: { scopeType: 'user_global', scopeId: 'global' } })
    expect(submitted(result).status).toBe('pending_human_confirm')
    const candidate = bench.service.listCandidates(operator).rows[0]!
    // The manager reviews, but it may not make a fact that waits for a person effective.
    for (const decision of ['approve', 'merge', 'conflict', 'supersede'] as const) {
      const refused = bench.service.decide({ caller: manager, candidateId: candidate.candidateId, decision,
        expectedChecksum: candidate.checksum, memoryId: 'mem_000000000001' })
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('NOT_PERMITTED')
    }
    // Nothing was written, and the candidate is still the one that was read.
    expect(bench.service.listMemories(operator).total).toBe(0)
    expect(bench.service.listCandidates(operator).rows[0]!.checksum).toBe(candidate.checksum)
    // The operator may.
    const decided = bench.service.decide({ caller: operator, candidateId: candidate.candidateId, decision: 'approve',
      expectedChecksum: candidate.checksum })
    expect(decided.ok).toBe(true)
    expect(decided.ok && decided.code).toBe('APPROVED')
    expect(bench.service.listMemories(operator).total).toBe(1)
  })

  it('keeps the caller’s own text out of a source reference the control plane could not check', () => {
    const bench = new Bench()
    const result = bench.service.submit({ caller: pm, content: '这个项目改用 vitest。',
      scope: { scopeType: 'project', scopeId: 'project:p1' },
      sourceRefs: [{ kind: 'ticket', id: 'C:\\Users\\max\\token.txt', at: '2020-01-01T00:00:00.000Z',
        summary: '一张工单' }] })
    expect(submitted(result).sourceTrust).toBe('external_tainted')
    const candidate = bench.service.listCandidates(operator).rows[0]!
    const ref = candidate.sourceRefs[0]!
    expect(ref.verified).toBe(false)
    // The moment the caller claimed is not the control plane's clock, so it is not kept.
    expect(ref.at).toBe('')
    // The id is bounded and stripped of everything that is not part of an id.
    expect(ref.id).not.toContain('\\')
    expect(ref.id).not.toContain('Users')
    expect(ref.id.length).toBeLessThanOrEqual(128)
    expect(JSON.stringify(candidate)).not.toContain('token.txt')
  })

  it('does not let a fact of one project lean on the record of another', () => {
    const bench = new Bench()
    bench.projects.push('p2')
    bench.hold('review', 'review-1', { at: START, authoritative: true, tainted: false, projectId: 'p1' })
    const own = bench.service.submit({ caller: pm, content: '这个项目用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p1' },
      sourceRefs: [{ kind: 'review', id: 'review-1', summary: '评审通过' }] })
    expect(submitted(own).sourceTrust).toBe('verified_execution')
    // The same record may not back a fact about another project.
    const other = bench.service.submit({ caller: operator, content: '另一个项目用 pnpm。',
      scope: { scopeType: 'project', scopeId: 'project:p2' },
      sourceRefs: [{ kind: 'review', id: 'review-1', summary: '评审通过' }] })
    expect(submitted(other).sourceTrust).toBe('external_tainted')
  })
})

describe('the memory service, through the control plane', () => {
  /** A control plane with a Router, a Project and its PM. */
  async function open(): Promise<{ url: string; scopeId: string; auditId: string }> {
    directory = mkdtempSync(join(tmpdir(), 'superagent-memory-plane-'))
    const root = join(directory, 'workspaces')
    node = new FakeNode({ nodeId: NODE_ID, root, now: () => START })
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: 'memory-secret',
      workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()
    await control.ensureRouter()
    const project = control.createProjectFromOperator('控制台改造', '让操作员看得到状态')
    await control.openProject(project.id)
    // The node's own registration is a fact the control plane really holds: an audit row with its own sequence.
    const audit = control.auditEntries({ limit: 1 })[0]!
    server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
    const address = await server.listen(0)
    return { url: address.url, scopeId: `project:${project.id}`, auditId: String(audit.seq) }
  }

  const get = (url: string, path: string, token: string): Promise<Response> =>
    fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } })

  const post = (url: string, path: string, token: string, body: unknown): Promise<Response> =>
    fetch(`${url}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body) })

  /**
   * A control plane whose Worker really runs, and in which one external event really woke it.
   *
   * The wake-up is a row of the coordination outbox: the record a fact would lean on when it claims that an observation
   * from outside says so. It is made here rather than written by hand, so the fact that leans on it is checked against
   * the same delivery the control plane really sent.
   */
  async function openWithWorker(): Promise<{ url: string; scopeId: string; deliveryId: string }> {
    directory = mkdtempSync(join(tmpdir(), 'superagent-memory-plane-'))
    const root = join(directory, 'workspaces')
    node = new FakeNode({ nodeId: NODE_ID, root, now: () => START })
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: 'memory-secret',
      workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()
    await control.ensureRouter()
    const project = control.createProjectFromOperator('控制台改造', '让操作员看得到状态')
    const pm = await control.openProject(project.id)
    const [created] = control.engine.createProjectTickets(project.id, pm.sessionId,
      [{ title: '记忆页', goal: '记一笔' }])
    const assignment = created!.assignments[0]!
    await until(() => control!.store.tickets.get(created!.id)?.assignments.at(-1)?.state === 'running',
      'the Assignment did not start')
    await control.createExternalSubscription({ sourceId: 'synthetic-group-chat', eventTypes: ['group.message'],
      fields: [{ path: 'text', op: 'contains', value: '回滚' }], targetSessionId: `worker-${assignment.id}` })
    await control.emitSyntheticEvent({ sourceId: 'synthetic-group-chat', eventId: 'evt-1', eventType: 'group.message',
      payload: { groupId: 'group-release', text: '请回滚' } })
    const delivery = control.coordinationDeliveries().find(row => row.kind === 'external_wakeup')
    if (delivery === undefined) throw new Error('The wake-up was not delivered')
    server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
    const address = await server.listen(0)
    return { url: address.url, scopeId: `project:${project.id}`, deliveryId: delivery.deliveryId }
  }

  it('never lets an external wake-up back a fact the control plane can trust', async () => {
    const { url, scopeId, deliveryId } = await openWithWorker()
    const proposed = await post(url, '/v1/console/memory/candidates', API_TOKEN,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'delivery', id: deliveryId, summary: '一次唤醒' }] })
    expect(proposed.status).toBe(201)
    const body = await proposed.json() as { candidate: { sourceTrust: string; status: string;
      sourceRefs: { id: string; verified: boolean }[] } }
    // The wake-up carried an observation from outside: the fact that leans on it stays untrusted, whatever proposed it.
    expect(body.candidate.sourceTrust).toBe('external_tainted')
    expect(body.candidate.status).toBe('pending_human_confirm')
    expect(body.candidate.sourceRefs.find(ref => ref.id === deliveryId)!.verified).toBe(true)
  })

  it('answers the console with the queue and the memories', async () => {
    const { url, scopeId } = await open()
    const proposed = await post(url, '/v1/console/memory/candidates', API_TOKEN,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId })
    expect(proposed.status).toBe(201)
    const body = await proposed.json() as { candidate: { candidateId: string; checksum: string; status: string } }
    expect(body.candidate.status).toBe('queued')

    const queue = await get(url, '/v1/console/memory/candidates', API_TOKEN)
    expect(queue.status).toBe(200)
    const page = await queue.json() as { rows: { candidateId: string }[]; total: number }
    expect(page.total).toBe(1)
    expect(page.rows[0]!.candidateId).toBe(body.candidate.candidateId)

    // The read-only viewer may read the queue as well.
    const seen = await get(url, '/v1/console/memory/candidates', VIEWER_TOKEN)
    expect(seen.status).toBe(200)

    // Nothing is in force until the decision says so.
    const before = await get(url, '/v1/console/memory/memories', API_TOKEN)
    expect(((await before.json()) as { total: number }).total).toBe(0)

    const decided = await post(url, `/v1/console/memory/candidates/${body.candidate.candidateId}/decision`, API_TOKEN,
      { decision: 'approve', checksum: body.candidate.checksum })
    expect(decided.status).toBe(200)
    const after = await get(url, '/v1/console/memory/memories', API_TOKEN)
    const memories = await after.json() as { rows: { content: string }[]; total: number }
    expect(memories.total).toBe(1)
    expect(memories.rows[0]!.content).toBe('这个项目统一用 pnpm。')
  })

  it('refuses the read-only viewer a write and refuses an unauthenticated call', async () => {
    const { url, scopeId } = await open()
    const byViewer = await post(url, '/v1/console/memory/candidates', VIEWER_TOKEN,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId })
    expect(byViewer.status).toBe(403)
    const anonymous = await post(url, '/v1/console/memory/candidates', 'wrong-token',
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId })
    expect(anonymous.status).toBe(401)
  })

  it('refuses a decision made on a candidate that changed', async () => {
    const { url, scopeId } = await open()
    const proposed = await post(url, '/v1/console/memory/candidates', API_TOKEN,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId })
    const body = await proposed.json() as { candidate: { candidateId: string; checksum: string } }
    const stale = await post(url, `/v1/console/memory/candidates/${body.candidate.candidateId}/decision`, API_TOKEN,
      { decision: 'approve', checksum: 'not-the-checksum' })
    expect(stale.status).toBe(409)
    const unknown = await post(url, '/v1/console/memory/candidates/cand_000000000999/decision', API_TOKEN,
      { decision: 'approve', checksum: body.candidate.checksum })
    expect(unknown.status).toBe(404)
  })

  it('refuses a body that carries a path or a secret, and writes nothing', async () => {
    const { url, scopeId } = await open()
    const refused = await post(url, '/v1/console/memory/candidates', API_TOKEN,
      { content: '源码在 C:\\Users\\max\\project 里。', scopeType: 'project', scopeId })
    expect(refused.status).toBe(400)
    const queue = await get(url, '/v1/console/memory/candidates', API_TOKEN)
    expect(((await queue.json()) as { total: number }).total).toBe(0)
  })

  it('checks the records a proposal names against what the control plane really holds', async () => {
    const { url, scopeId, auditId } = await open()
    const proposed = await post(url, '/v1/console/memory/candidates', API_TOKEN,
      { content: '这个项目统一用 pnpm。', scopeType: 'project', scopeId,
        sourceRefs: [{ kind: 'audit', id: auditId, summary: '一次操作事实' },
          { kind: 'audit', id: '999999', summary: '另一次操作事实' }] })
    expect(proposed.status).toBe(201)
    const body = await proposed.json() as {
      candidate: { sourceTrust: string; sourceRefs: { id: string; verified: boolean }[] }
    }
    // The record the control plane holds is verified; the one it does not hold is marked, and the fact is tainted.
    expect(body.candidate.sourceRefs.find(ref => ref.id === auditId)!.verified).toBe(true)
    expect(body.candidate.sourceRefs.find(ref => ref.id === '999999')!.verified).toBe(false)
    expect(body.candidate.sourceTrust).toBe('external_tainted')
    // A kind the control plane cannot look up is refused rather than stored as if it were a fact.
    const unknown = await post(url, '/v1/console/memory/candidates', API_TOKEN,
      { content: '另一条事实。', scopeType: 'project', scopeId, sourceRefs: [{ kind: 'nowhere', id: 'x' }] })
    expect(unknown.status).toBe(400)
  })
})
