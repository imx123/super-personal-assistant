/**
 * The retriever: the ranked recall of the long-term memory.
 *
 * The rules that are easier to state as records than as a running control plane are exercised on their own: the scope
 * that is filtered before anything is scored, the ranking that follows from the relevance and the weights, the fallback
 * that makes a Chinese question work, the way out when the semantic path is not there, and the counters that a read may
 * never move. The parts that have to happen through the real paths — the console's own read, the tool a Session calls
 * with its own token, the tool the node really registers — are exercised against a running control plane and a real
 * `FakeNode`.
 *
 * Nothing here pretends a use that did not happen: a memory becomes more useful only with a piece of evidence the
 * control plane itself holds, and the same piece of evidence is counted once however often it is offered.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { MEMORY_MANAGER_PROFILE, PM_PROFILE, ROUTER_PROFILE, WORKER_PROFILE } from '../src/control/roles.ts'
import { MEMORY_MANAGER_PROFILE_NAME } from '../src/memory/memory-manager.ts'
import { MemoryService, type MemoryHost } from '../src/memory/memory-service.ts'
import type { MemoryCaller, MemorySourceRecord, SourceRefKind } from '../src/memory/memory-scope.ts'
import { MemoryRetriever, type EmbeddingProvider, type MemoryRetrievalConfig, type MemoryRetrievalWeights }
  from '../src/memory/retriever.ts'
import { createDshPortHost, type DshPortFetch } from '../src/node/dsh-port-host.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { FetchControlPlaneServer as ControlPlaneServer, startFetchControlPlane } from './fixtures/fetch-servers.ts'

const API_TOKEN = 'retriever-api-token'
const VIEWER_TOKEN = 'retriever-viewer-token'
const SECRET = 'retriever-secret'
const START = '2026-11-19T08:00:00.000Z'
const NODE_ID = 'local'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode | undefined

/** The caller the console acts as: a person, not a Session. */
const operator: MemoryCaller = { role: 'operator', sessionId: '', nodeId: '', projectId: undefined, ticketId: undefined }

/** The PM of the Project `p1`, as a caller. */
const pmOfP1: MemoryCaller = { role: 'pm', sessionId: 'pm-p1', nodeId: NODE_ID, projectId: 'p1', ticketId: undefined }

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
 * The retriever on its own: one SQLite file, one host, one clock the test moves by hand.
 *
 * The memories are written the way the control plane writes them — a proposal, then a decision — so what the search
 * reads is what a person really decided and not a row a test typed in.
 */
class Bench {
  readonly db: DatabaseSync
  readonly service: MemoryService
  readonly retriever: MemoryRetriever | undefined
  /** The moment the service and the retriever read as "now". */
  at = START
  /** The records the control plane really holds. */
  readonly sources = new Map<string, MemorySourceRecord>()
  /** The Projects the control plane knows. */
  readonly projects: string[] = ['p1', 'p2']
  /** The machines the control plane knows. */
  readonly nodes: string[] = [NODE_ID]

  constructor(path?: string, options: {
    readonly config?: Partial<MemoryRetrievalConfig>
    readonly embeddingProvider?: EmbeddingProvider
    /** Whether the retriever is built at all: a database may hold memories before it exists. */
    readonly withRetriever?: boolean
  } = {}) {
    this.db = new DatabaseSync(path ?? ':memory:')
    this.service = new MemoryService(this.db, this.host())
    if (options.withRetriever === false) {
      this.retriever = undefined
      return
    }
    this.retriever = new MemoryRetriever(this.db, { now: () => this.at }, {
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.embeddingProvider === undefined ? {} : { embeddingProvider: options.embeddingProvider }),
    })
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
  remember(content: string, scope: { readonly scopeType: string; readonly scopeId: string },
    options: { readonly importance?: number } = {}): string {
    const proposed = this.service.submit({
      caller: operator,
      content,
      scope,
      ...(options.importance === undefined ? {} : { importance: options.importance }),
    })
    if (!proposed.ok) throw new Error(`The proposal was refused: ${proposed.reason}`)
    if (proposed.candidate === undefined) throw new Error('The proposal was not disclosed to this caller.')
    const decided = this.service.decide({
      caller: operator,
      candidateId: proposed.candidate.candidateId,
      decision: 'approve',
      expectedChecksum: proposed.candidate.checksum,
    })
    if (!decided.ok) throw new Error('The decision was refused.')
    if (decided.memory === undefined) throw new Error('The decision made no memory.')
    return decided.memory.memoryId
  }

  /** The counters of one memory, read from the table itself. */
  counters(memoryId: string): { utility: number; exposure: number; effective: number; disputed: number; status: string;
    confidence: number } {
    const row = this.db.prepare(
      'SELECT utility, exposure_count, effective_use_count, disputed_count, status, confidence '
      + 'FROM long_term_memories WHERE memory_id = ?').get(memoryId) as
      { utility: number; exposure_count: number; effective_use_count: number; disputed_count: number; status: string;
        confidence: number }
    return { utility: row.utility, exposure: row.exposure_count, effective: row.effective_use_count,
      disputed: row.disputed_count, status: row.status, confidence: row.confidence }
  }
}

// ─── the retriever, on its own ────────────────────────────────────────────────────────────────────────────────

describe('the retriever, on its own', () => {
  it('filters in the storage layer before it scores, before it embeds and before it bounds anything', async () => {
    const bench = new Bench()
    bench.remember('pnpm 是这个项目的包管理器', { scopeType: 'project', scopeId: 'project:p1' })
    // The memory of another Project is the better keyword match by far: it says the word many times.
    bench.remember('pnpm pnpm pnpm pnpm pnpm 是另一个项目的包管理器 pnpm pnpm pnpm',
      { scopeType: 'project', scopeId: 'project:p2' })

    const result = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })

    // The candidate set holds the caller's own rows and nothing else: the count is not the count of the whole table.
    expect(result.considered).toBe(1)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.scopeId).toBe('project:p1')
    // Nothing of the other Project is in the rows, the count, the snippets or the reasons.
    expect(JSON.stringify(result)).not.toContain('project:p2')
    expect(JSON.stringify(result)).not.toContain('另一个项目')
  })

  it('counts its statistics over the caller\'s own rows, so another scope cannot move a score', async () => {
    const bench = new Bench()
    bench.remember('这个项目统一使用 pnpm 作为包管理器。', { scopeType: 'project', scopeId: 'project:p1' })
    const before = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })
    expect(before.hits).toHaveLength(1)

    // Another Project's memory, the better keyword match by far: it says the word many times and it is long.
    bench.remember('pnpm pnpm pnpm pnpm pnpm 是另一个项目的包管理器 pnpm pnpm pnpm pnpm pnpm pnpm',
      { scopeType: 'project', scopeId: 'project:p2' })
    // A memory of this very Project that is no longer in force: it says the word too, and it is short.
    const stale = bench.remember('pnpm 这条已经不再生效了。', { scopeType: 'project', scopeId: 'project:p1' })
    bench.db.prepare("UPDATE long_term_memories SET status = 'needs_reverify' WHERE memory_id = ?").run(stale)
    // A proposal that waits for a decision: it is not a memory at all, and it says the word as well.
    bench.service.submit({ caller: operator, content: 'pnpm 这条还在队列里。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })

    const after = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })

    // The same question, the same scope and the same answer: the score, the reasons, the order and the count are all
    // exactly what they were. Nothing the caller may not read took part in any of them.
    expect(after.hits.map(hit => hit.memoryId)).toEqual(before.hits.map(hit => hit.memoryId))
    expect(after.hits.map(hit => hit.score)).toEqual(before.hits.map(hit => hit.score))
    expect(after.hits.map(hit => hit.reasons)).toEqual(before.hits.map(hit => hit.reasons))
    expect(after.hits.map(hit => hit.breakdown)).toEqual(before.hits.map(hit => hit.breakdown))
    expect(after.considered).toBe(before.considered)
    // And nothing of another scope is in the answer, not even in its words.
    expect(JSON.stringify(after)).not.toContain('project:p2')
    expect(JSON.stringify(after)).not.toContain('另一个项目')
  })

  it('does not let a crowd of fresh memories that do not match push the one that does out of the set', async () => {
    const bench = new Bench(undefined, { config: { candidateLimit: 5 } })
    const wanted = bench.remember('这个项目统一使用 pnpm 作为包管理器。', { scopeType: 'project', scopeId: 'project:p1' })
    // Twenty fresh memories of the very same scope, none of which carries the words of the question.
    for (let index = 0; index < 20; index += 1) {
      bench.remember(`第${index}条与问题无关的记忆，只说别的事情。`, { scopeType: 'project', scopeId: 'project:p1' })
    }

    const result = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })

    // The bound is taken after the keyword match, so the one row that answers the question is in the set.
    expect(result.hits.map(hit => hit.memoryId)).toEqual([wanted])
  })

  it('keeps a Chinese match inside the bound even when many newer memories do not match', async () => {
    const bench = new Bench(undefined, { config: { candidateLimit: 5 } })
    const wanted = bench.remember('这个项目统一使用 pnpm 作为包管理器。', { scopeType: 'project', scopeId: 'project:p1' })
    // Twenty fresh memories of the very same scope, none of which carries the words of the question.
    for (let index = 0; index < 20; index += 1) {
      bench.remember(`第${index}条与问题无关的记忆，只说别的事情。`, { scopeType: 'project', scopeId: 'project:p1' })
    }

    const result = await bench.retriever!.search({ caller: pmOfP1, query: '包管理器' })

    // The keyword index cannot read a Chinese question, so the words were compared one by one — and a row that was
    // found that way carries the words of the question just as much as a row the index matched. The bound may not cut it
    // in favour of twenty memories that say nothing about the question.
    expect(result.hits.map(hit => hit.memoryId)).toEqual([wanted])
    expect(result.hits[0]!.breakdown.coverage).toBe(1)
  })

  it('writes nothing while it searches, and leaves the index for the moment the database is opened', async () => {
    const bench = new Bench()
    const id = bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })
    const rows = 'SELECT seq, content, status, exposure_count, effective_use_count, utility FROM long_term_memories ORDER BY seq'
    const before = bench.db.prepare(rows).all()
    const indexBefore = bench.db.prepare('SELECT rowid, content FROM long_term_memories_fts ORDER BY rowid').all()

    const result = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })

    expect(result.hits).toHaveLength(1)
    expect(bench.db.prepare(rows).all()).toEqual(before)
    expect(bench.db.prepare('SELECT rowid, content FROM long_term_memories_fts ORDER BY rowid').all()).toEqual(indexBefore)
    expect(bench.counters(id).exposure).toBe(0)
    expect(bench.counters(id).utility).toBe(0)
  })

  it('does not repair the keyword index while it searches, but does when the database is opened', async () => {
    const bench = new Bench()
    const id = bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })
    // The index is damaged: the row is gone from it while the table still holds it.
    bench.db.exec('DELETE FROM long_term_memories_fts')

    const result = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })

    // The search wrote nothing, so the index is still damaged — and the memory is still found, by the comparison of
    // the terms, which needs no index at all.
    const indexed = bench.db.prepare('SELECT COUNT(*) AS total FROM long_term_memories_fts').get() as { total: number }
    expect(Number(indexed.total)).toBe(0)
    expect(result.hits.map(hit => hit.memoryId)).toEqual([id])

    // The repair belongs to the opening of the database, not to a read.
    const reopened = new MemoryRetriever(bench.db, { now: () => bench.at })
    expect(reopened.ensureIndex()).toBe(false)
    const after = await reopened.search({ caller: pmOfP1, query: 'pnpm' })
    expect(after.hits.map(hit => hit.memoryId)).toEqual([id])
  })

  it('ranks what is left by the relevance and by the weights of the fact', async () => {
    const bench = new Bench()
    // The same words in two Projects: the relevance of the two is the same, so the order is the weights' business.
    const important = bench.remember('统一使用 pnpm 作为包管理器', { scopeType: 'project', scopeId: 'project:p1' },
      { importance: 1 })
    const used = bench.remember('统一使用 pnpm 作为包管理器', { scopeType: 'project', scopeId: 'project:p2' })
    // The second one was really used: an Assignment of its own Project ended.
    bench.hold('assignment', 'a2', { at: START, authoritative: true, tainted: false, projectId: 'p2' })
    const credited = bench.service.creditEffectiveUse({ memoryIds: [used], evidence: { assignmentId: 'a2' } })
    expect(credited.ok).toBe(true)

    const byImportance = await bench.retriever!.search({ caller: operator, query: 'pnpm' })
    expect(byImportance.hits.map(hit => hit.memoryId)).toEqual([important, used])

    // The weights are the ranking: with the usefulness alone, the memory that was really used comes first.
    const byUtility = new MemoryRetriever(bench.db, { now: () => bench.at }, {
      config: { weights: { importance: 0, confidence: 0, freshness: 0, utility: 1 } },
    })
    const reranked = await byUtility.search({ caller: operator, query: 'pnpm' })
    expect(reranked.hits.map(hit => hit.memoryId)).toEqual([used, important])
  })

  it('finds a Chinese fact when the keyword index cannot read it', async () => {
    const bench = new Bench()
    bench.remember('这个项目统一使用 pnpm 作为包管理器，不要使用 npm。',
      { scopeType: 'project', scopeId: 'project:p1' })

    const result = await bench.retriever!.search({ caller: pmOfP1, query: '包管理器' })

    expect(result.hits).toHaveLength(1)
    const hit = result.hits[0]!
    expect(hit.breakdown.coverage).toBe(1)
    // The index did not match it at all: the words were compared one by one instead, and that is what found it.
    expect(hit.breakdown.lexical).toBeCloseTo(0.5, 6)
    expect(hit.reasons.join('')).toContain('相关性')
  })

  it('drops what is below the relevance floor, and the floor is replaceable', async () => {
    const bench = new Bench()
    bench.remember('这个项目统一使用 pnpm 作为包管理器。', { scopeType: 'project', scopeId: 'project:p1' })

    const lenient = await bench.retriever!.search({ caller: pmOfP1, query: '包管理器' })
    expect(lenient.hits).toHaveLength(1)
    expect(lenient.minRelevance).toBe(0.3)

    const strict = new MemoryRetriever(bench.db, { now: () => bench.at }, { config: { minRelevance: 0.9 } })
    const answer = await strict.search({ caller: pmOfP1, query: '包管理器' })
    expect(answer.hits).toHaveLength(0)
    expect(answer.minRelevance).toBe(0.9)
  })

  it('falls back to the keyword path when the semantic path is not there, and asks it once', async () => {
    let asked = 0
    const broken: EmbeddingProvider = {
      name: 'offline',
      dimensions: 2,
      embed: async () => { asked += 1; throw new Error('the provider is not reachable') },
    }
    const bench = new Bench(undefined, { embeddingProvider: broken })
    bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })

    const result = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })

    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toContain('向量编码接口不可用')
    // The search is an answer all the same, and the provider was asked once: it is not asked again while it cools down.
    expect(result.hits).toHaveLength(1)
    expect(asked).toBe(1)
  })

  it('gives the semantic path a short time, and goes on with the keyword path when it does not answer', async () => {
    let asked = 0
    const hanging: EmbeddingProvider = {
      name: 'hanging',
      dimensions: 2,
      embed: async () => {
        asked += 1
        return new Promise<readonly (readonly number[])[]>(() => { /* it never answers */ })
      },
    }
    const bench = new Bench(undefined, { embeddingProvider: hanging, config: { providerTimeoutMs: 50 } })
    bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })

    const result = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })

    // The search is an answer all the same: the keyword path carried it, and the answer says which way it went.
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toContain('向量编码接口超时')
    expect(result.hits).toHaveLength(1)
    expect(asked).toBe(1)

    // And the provider is not asked again while it cools down: a search that waits for it once more waits for it for
    // ever, and the keyword path carries every one of them.
    const again = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })
    expect(again.degraded).toBe(true)
    expect(again.degradedReason).toContain('向量编码接口超时')
    expect(asked).toBe(1)
  })

  it('asks the provider again after its cooldown, so a provider that came back is used without a restart', async () => {
    let asked = 0
    let healthy = false
    const flaky: EmbeddingProvider = {
      name: 'flaky',
      dimensions: 2,
      embed: async texts => {
        asked += 1
        if (!healthy) throw new Error('the provider is not reachable')
        return texts.map(() => [1, 0])
      },
    }
    const bench = new Bench(undefined, { embeddingProvider: flaky, config: { providerCooldownMs: 1000 } })
    bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })

    const broken = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })
    expect(broken.degraded).toBe(true)
    expect(broken.degradedReason).toContain('向量编码接口不可用')
    expect(broken.hits).toHaveLength(1)
    expect(asked).toBe(1)

    // While it cools down the provider is left alone: the keyword path carries the search, and it says why.
    const cooling = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })
    expect(cooling.degraded).toBe(true)
    expect(cooling.degradedReason).toContain('向量编码接口不可用')
    expect(asked).toBe(1)

    // The cooldown ends by itself, and the provider that has come back answers the next search as if nothing had
    // happened: a service that has to be repaired is not a service that has to be restarted.
    healthy = true
    bench.at = new Date(Date.parse(START) + 2000).toISOString()
    const healed = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })
    expect(asked).toBe(2)
    expect(healed.degraded).toBe(false)
    expect(healed.hits).toHaveLength(1)
    expect(healed.hits[0]!.breakdown.vector).toBeCloseTo(1, 6)
  })

  it('uses the semantic path when there is one, and says that it did not fall back', async () => {
    const fake: EmbeddingProvider = {
      name: 'fake',
      dimensions: 2,
      embed: async texts => texts.map(text => text.includes('pnpm') ? [1, 0] : [0, 1]),
    }
    const bench = new Bench(undefined, { embeddingProvider: fake })
    bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })

    const result = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })

    // The semantic path ran and answered: it is not one of the reasons the search fell back.
    expect(result.degradedReason).not.toContain('向量编码接口不可用')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.breakdown.vector).toBeCloseTo(1, 6)
  })

  it('finds the memory again after the database was opened afresh', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-retriever-'))
    const path = join(directory, 'control.sqlite')
    const first = new Bench(path)
    let id = ''
    try {
      id = first.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })
    } finally {
      // The file is closed even when the write failed: a database that is still open keeps its file, and the directory
      // may not be removed while it is.
      first.db.close()
    }

    const second = new Bench(path)
    try {
      const result = await second.retriever!.search({ caller: pmOfP1, query: 'pnpm' })
      expect(result.hits.map(hit => hit.memoryId)).toEqual([id])
    } finally {
      second.db.close()
    }
  })

  it('rebuilds the keyword index when it drifted away from the table it indexes', async () => {
    const bench = new Bench()
    const id = bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })
    // The index is damaged: the row is gone from it while the table still holds it.
    const indexed = bench.db.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'long_term_memories_fts'").get() as { name: string } | undefined
    if (indexed !== undefined) bench.db.exec('DELETE FROM long_term_memories_fts')

    const reopened = new MemoryRetriever(bench.db, { now: () => bench.at })
    const result = await reopened.search({ caller: pmOfP1, query: 'pnpm' })
    expect(result.hits.map(hit => hit.memoryId)).toEqual([id])
    // The index and the table agree again, so nothing is rebuilt a second time.
    expect(reopened.ensureIndex()).toBe(false)
  })

  it('indexes the memories a database held before the index existed', async () => {
    const bench = new Bench(undefined, { withRetriever: false })
    const id = bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })

    const retriever = new MemoryRetriever(bench.db, { now: () => bench.at })
    const result = await retriever.search({ caller: pmOfP1, query: 'pnpm' })
    expect(result.hits.map(hit => hit.memoryId)).toEqual([id])
  })

  it('never shows a proposal that waits, a memory that is not in force, or another Project', async () => {
    const bench = new Bench()
    // A proposal nobody decided about is not a memory and may not be recalled.
    bench.service.submit({ caller: operator, content: '这条还在队列里。',
      scope: { scopeType: 'project', scopeId: 'project:p1' } })
    const active = bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })
    const stale = bench.remember('这条已经不再生效了。', { scopeType: 'project', scopeId: 'project:p1' })
    const superseded = bench.remember('这条已经被新版本取代了。', { scopeType: 'project', scopeId: 'project:p1' })
    const foreign = bench.remember('这是别的项目的事实。', { scopeType: 'project', scopeId: 'project:p2' })
    bench.db.prepare("UPDATE long_term_memories SET status = 'needs_reverify' WHERE memory_id = ?").run(stale)
    bench.db.prepare("UPDATE long_term_memories SET status = 'superseded' WHERE memory_id = ?").run(superseded)

    const result = await bench.retriever!.search({ caller: pmOfP1, query: '项目' })

    expect(result.hits.map(hit => hit.memoryId)).toEqual([active])
    expect(result.considered).toBe(1)
    expect(JSON.stringify(result)).not.toContain('别的项目')
    // An id that was never given and an id that is not in force answer in exactly the same way.
    expect(bench.retriever!.read(pmOfP1, 'mem_000000000999').found).toBe(false)
    expect(bench.retriever!.read(pmOfP1, stale).found).toBe(false)
    expect(bench.retriever!.read(pmOfP1, foreign).found).toBe(false)
    expect(bench.retriever!.read(pmOfP1, active).found).toBe(true)
  })

  it('gains nothing by being read', async () => {
    const bench = new Bench()
    const id = bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })

    for (let index = 0; index < 5; index += 1) {
      await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })
    }

    const counters = bench.counters(id)
    expect(counters.utility).toBe(0)
    expect(counters.exposure).toBe(0)
    expect(counters.effective).toBe(0)
    // An exposure counts and nothing else: it never makes a memory more useful than it was.
    expect(bench.service.recordExposure(pmOfP1, [id])).toBe(1)
    const after = bench.counters(id)
    expect(after.exposure).toBe(1)
    expect(after.utility).toBe(0)
    expect(after.effective).toBe(0)
  })

  it('credits a memory only with evidence the control plane holds, and only once', () => {
    const bench = new Bench()
    const id = bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })

    // A claim nobody can check is not evidence.
    const claimed = bench.service.creditEffectiveUse({ memoryIds: [id], evidence: { reviewId: 'review-unknown' } })
    expect(claimed.ok).toBe(false)
    expect(claimed.ok === false && claimed.code).toBe('EVIDENCE_NOT_VERIFIED')
    // A review that is still waiting is not a conclusion either.
    bench.hold('review', 'review-waiting', { at: START, authoritative: false, tainted: false, projectId: 'p1' })
    const waiting = bench.service.creditEffectiveUse({ memoryIds: [id], evidence: { reviewId: 'review-waiting' } })
    expect(waiting.ok).toBe(false)
    expect(bench.counters(id).utility).toBe(0)

    // An accepted review is.
    bench.hold('review', 'review-accepted', { at: START, authoritative: true, tainted: false, projectId: 'p1' })
    const credited = bench.service.creditEffectiveUse({ memoryIds: [id], evidence: { reviewId: 'review-accepted' } })
    expect(credited.ok).toBe(true)
    expect(credited.ok && credited.credited[0]!.effectiveUseCount).toBe(1)
    expect(credited.ok && credited.credited[0]!.utility).toBeCloseTo(1 - Math.exp(-0.5), 6)
    expect(bench.counters(id).utility).toBeCloseTo(1 - Math.exp(-0.5), 6)

    // The same piece of evidence again changes nothing at all.
    const again = bench.service.creditEffectiveUse({ memoryIds: [id], evidence: { reviewId: 'review-accepted' } })
    expect(again.ok).toBe(true)
    expect(again.ok && again.credited[0]!.alreadyCredited).toBe(true)
    expect(bench.counters(id).effective).toBe(1)
    expect(bench.counters(id).utility).toBeCloseTo(1 - Math.exp(-0.5), 6)
  })

  it('counts one piece of evidence once, even after the database was opened afresh', () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-retriever-'))
    const path = join(directory, 'control.sqlite')
    const first = new Bench(path)
    let id = ''
    try {
      id = first.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })
      first.hold('assignment', 'a1', { at: START, authoritative: true, tainted: false, projectId: 'p1' })
      const credited = first.service.creditEffectiveUse({ memoryIds: [id], evidence: { assignmentId: 'a1' } })
      expect(credited.ok).toBe(true)
    } finally {
      // The file is closed even when the credit failed: a database that is still open keeps its file, and the next case
      // on the same file would find it locked.
      first.db.close()
    }

    const second = new Bench(path)
    try {
      // The control plane that was opened afresh holds the same records: the Assignment that ended is still a
      // conclusion it may lean on, and the credit of it is still the credit of one piece of evidence.
      second.hold('assignment', 'a1', { at: START, authoritative: true, tainted: false, projectId: 'p1' })
      const again = second.service.creditEffectiveUse({ memoryIds: [id], evidence: { assignmentId: 'a1' } })
      expect(again.ok).toBe(true)
      expect(again.ok && again.credited[0]!.alreadyCredited).toBe(true)
      expect(second.counters(id).effective).toBe(1)
    } finally {
      second.db.close()
    }
  })

  it('does not let the work of one Project credit the memory of another', () => {
    const bench = new Bench()
    const mine = bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })
    const theirs = bench.remember('另一个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p2' })
    bench.hold('assignment', 'a1', { at: START, authoritative: true, tainted: false, projectId: 'p1' })

    const credited = bench.service.creditEffectiveUse({ memoryIds: [mine, theirs], evidence: { assignmentId: 'a1' } })

    expect(credited.ok).toBe(true)
    expect(credited.ok && credited.credited.map(entry => entry.memoryId)).toEqual([mine])
    expect(bench.counters(mine).utility).toBeGreaterThan(0)
    expect(bench.counters(theirs).utility).toBe(0)
  })

  it('lowers the confidence of a memory a person calls misleading, and stops recalling it below the floor', async () => {
    const bench = new Bench()
    const id = bench.remember('这个项目统一用 pnpm。', { scopeType: 'project', scopeId: 'project:p1' })
    expect(bench.counters(id).confidence).toBeCloseTo(0.9, 6)

    // Only a person may say that a memory misled somebody.
    const refused = bench.service.disputeMemory({ caller: pmOfP1, memoryId: id, reason: '它说错了。' })
    expect(refused.ok).toBe(false)

    const disputed = bench.service.disputeMemory({ caller: operator, memoryId: id, reason: '它说错了。' })
    expect(disputed.ok).toBe(true)
    expect(bench.counters(id).confidence).toBeCloseTo(0.8, 6)
    expect(bench.counters(id).disputed).toBe(1)
    // The memory is still in force, and still recalled.
    const still = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })
    expect(still.hits.map(hit => hit.memoryId)).toEqual([id])

    // Enough disputes and it waits for somebody to look at it again instead of being injected.
    for (let index = 0; index < 6; index += 1) {
      bench.service.disputeMemory({ caller: operator, memoryId: id, reason: '还是不对。' })
    }
    expect(bench.counters(id).status).toBe('needs_reverify')
    const gone = await bench.retriever!.search({ caller: pmOfP1, query: 'pnpm' })
    expect(gone.hits).toHaveLength(0)
  })
})

// ─── the search, through the control plane ────────────────────────────────────────────────────────────────────

describe('the search, through the control plane', () => {
  /**
   * A control plane with a Router, a Project, its PM, one Ticket and its Worker.
   *
   * It is opened with the operator's own key and the read-only one, so the two halves of the console are both real. The
   * knobs of the recall are the deployment's own, so a test may give them here.
   */
  async function open(options: { readonly memoryRetrieval?: Partial<MemoryRetrievalConfig> } = {}):
    Promise<{ address: { url: string }; projectId: string; pmSessionId: string }> {
    directory = mkdtempSync(join(tmpdir(), 'superagent-retriever-plane-'))
    const root = join(directory, 'workspaces')
    node = new FakeNode({ nodeId: NODE_ID, root, now: () => START })
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
      workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50,
      ...(options.memoryRetrieval === undefined ? {} : { memoryRetrieval: options.memoryRetrieval }) })
    await control.registerNode()
    await control.ensureRouter()
    const project = control.createProjectFromOperator('控制台改造', '让操作员看得到状态')
    const pm = await control.openProject(project.id)
    server = new ControlPlaneServer(control, { token: API_TOKEN, viewerToken: VIEWER_TOKEN })
    const address = await server.listen(0)
    return { address, projectId: project.id, pmSessionId: pm.sessionId }
  }

  const get = (address: { url: string }, path: string, token: string): Promise<Response> =>
    fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })

  const post = (address: { url: string }, path: string, token: string, body: unknown): Promise<Response> =>
    fetch(`${address.url}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body) })

  /** The token the node issued for one Session. */
  function tokenOf(sessionId: string): string {
    const token = node?.tokens.get(sessionId)
    if (!token) throw new Error(`The FakeNode has no token for ${sessionId}`)
    return token
  }

  /** One memory of the Project, written by a person and decided by a person. */
  async function rememberOf(address: { url: string }, scopeId: string, content: string,
    options: { readonly importance?: number; readonly sourceRefs?: readonly { kind: string; id: string }[] } = {}):
    Promise<string> {
    const proposed = await post(address, '/v1/console/memory/candidates', API_TOKEN,
      { content, scopeType: 'project', scopeId,
        ...(options.importance === undefined ? {} : { importance: options.importance }),
        ...(options.sourceRefs === undefined ? {} : { sourceRefs: options.sourceRefs }) })
    const body = await proposed.json() as { candidate: { candidateId: string; checksum: string } }
    const decided = await post(address, `/v1/console/memory/candidates/${body.candidate.candidateId}/decision`,
      API_TOKEN, { decision: 'approve', checksum: body.candidate.checksum })
    expect(decided.status).toBe(200)
    const memories = await (await get(address, '/v1/console/memory/memories', API_TOKEN)).json() as
      { rows: { memoryId: string }[] }
    const memory = memories.rows[0]
    expect(memory).toBeDefined()
    return memory!.memoryId
  }

  /**
   * The two memories a ranking test ranks, and the order the search answered in.
   *
   * The two bodies carry the same words and are the same length, so the keyword path gives them the same relevance and
   * only the weights of the fact may tell them apart: the first one is important and leans on a record nobody can check,
   * the second one is trusted and says nothing about its own importance.
   */
  async function rankedBy(weights: MemoryRetrievalWeights): Promise<{ important: string; trusted: string;
    order: string[]; weights: MemoryRetrievalWeights; minRelevance: number }> {
    const { address, projectId } = await open({ memoryRetrieval: { weights } })
    const important = await rememberOf(address, `project:${projectId}`, '这个项目统一使用 pnpm 安装依赖。',
      { importance: 1, sourceRefs: [{ kind: 'ticket', id: 'ticket-nobody-holds' }] })
    const trusted = await rememberOf(address, `project:${projectId}`, '这个项目必须使用 pnpm 安装依赖。')
    const found = await get(address, '/v1/console/memory/search?q=pnpm', API_TOKEN)
    expect(found.status).toBe(200)
    const answer = await found.json() as { hits: { memoryId: string }[]; weights: MemoryRetrievalWeights;
      minRelevance: number }
    return { important, trusted, order: answer.hits.map(hit => hit.memoryId), weights: answer.weights,
      minRelevance: answer.minRelevance }
  }

  it('answers the console with the memories of this control plane', async () => {
    const { address, projectId } = await open()
    await rememberOf(address, `project:${projectId}`, '这个项目统一用 pnpm。')

    const found = await get(address, '/v1/console/memory/search?q=pnpm', API_TOKEN)
    expect(found.status).toBe(200)
    const answer = await found.json() as { hits: { memoryId: string; content: string }[]; considered: number }
    expect(answer.hits).toHaveLength(1)
    expect(answer.hits[0]!.content).toContain('pnpm')

    // The read-only viewer may read it too: it is a `GET`.
    expect((await get(address, '/v1/console/memory/search?q=pnpm', VIEWER_TOKEN)).status).toBe(200)
    // Without a credential there is no answer at all.
    expect((await fetch(`${address.url}/v1/console/memory/search?q=pnpm`)).status).toBe(401)
    // A question with no words is a question that was not asked.
    expect((await get(address, '/v1/console/memory/search?q=', API_TOKEN)).status).toBe(400)
  })

  it('lets only the operator mark a memory as misleading', async () => {
    const { address, projectId } = await open()
    const memoryId = await rememberOf(address, `project:${projectId}`, '这个项目统一用 pnpm。')

    // The read-only viewer may not write.
    const refused = await post(address, `/v1/console/memory/memories/${memoryId}/dispute`, VIEWER_TOKEN,
      { reason: '它说错了。' })
    expect(refused.status).toBe(403)

    const disputed = await post(address, `/v1/console/memory/memories/${memoryId}/dispute`, API_TOKEN,
      { reason: '它说错了。' })
    expect(disputed.status).toBe(200)
    const body = await disputed.json() as { memory: { confidence: number; disputedCount?: number } }
    expect(body.memory.confidence).toBeCloseTo(0.8, 6)
  })

  it('runs the search with the relevance floor the deployment set', async () => {
    const { address, projectId } = await open({ memoryRetrieval: { minRelevance: 0.9 } })
    await rememberOf(address, `project:${projectId}`, '这个项目统一用 pnpm。')

    const found = await get(address, '/v1/console/memory/search?q=pnpm', API_TOKEN)
    const answer = await found.json() as { hits: unknown[]; minRelevance: number }
    // The floor the deployment named is the floor the search ran with, and it is said out loud.
    expect(answer.minRelevance).toBe(0.9)
    // And what is below it is not a hit: the same memory is found when the floor is the default one.
    expect(answer.hits).toHaveLength(0)
  })

  it('reads the relevance floor and the weights of the recall from the environment, and fails fast on a bad value', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-retriever-env-'))
    const root = join(directory, 'workspaces')
    const env = { SUPERAGENT_CONTROL_TOKEN: API_TOKEN, SUPERAGENT_CONTROL_DB: join(directory, 'control.sqlite'),
      SUPERAGENT_WORKSPACE_ROOT: root, SUPERAGENT_NODE_ID: NODE_ID, SUPERAGENT_CONTROL_PORT: '0' }

    for (const value of ['soon', '-0.1', '1.5']) {
      await expect(startFetchControlPlane({ env: { ...env, SUPERAGENT_MEMORY_MIN_RELEVANCE: value },
        node: new FakeNode({ nodeId: NODE_ID, root, now: () => START }), heartbeatMs: 0 }))
        .rejects.toThrow('SUPERAGENT_MEMORY_MIN_RELEVANCE is invalid')
    }

    const started = await startFetchControlPlane({ env: { ...env, SUPERAGENT_MEMORY_MIN_RELEVANCE: '0.8',
      SUPERAGENT_MEMORY_WEIGHT_IMPORTANCE: '1' }, node: new FakeNode({ nodeId: NODE_ID, root, now: () => START }),
    heartbeatMs: 0 })
    try {
      // The settings are the deployment's own, and they are what the search runs with. The weight that was not named
      // keeps the default of the memory module.
      expect(started.control.memoryRetrievalConfig.minRelevance).toBe(0.8)
      expect(started.control.memoryRetrievalConfig.weights).toEqual({ importance: 1, confidence: 0.25,
        freshness: 0.25, utility: 0.15 })
    } finally {
      await started.close()
    }
  })

  it('orders the search by the weights the deployment set', async () => {
    const ranked = await rankedBy({ importance: 1, confidence: 0, freshness: 0, utility: 0 })

    // The search says which weights it ran with, and the important memory comes first.
    expect(ranked.weights).toEqual({ importance: 1, confidence: 0, freshness: 0, utility: 0 })
    expect(ranked.order).toEqual([ranked.important, ranked.trusted])
  })

  it('orders the same memories the other way when the deployment set the other weights', async () => {
    const ranked = await rankedBy({ importance: 0, confidence: 1, freshness: 0, utility: 0 })

    // The same two memories, the same relevance: the trusted one comes first now, because the confidence is what counts.
    expect(ranked.order).toEqual([ranked.trusted, ranked.important])
  })

  it('gives the PM its own Project and the memory manager no search of its own', async () => {
    const { address, projectId, pmSessionId } = await open()
    await rememberOf(address, `project:${projectId}`, '这个项目统一用 pnpm。')

    // The PM reads the memory of the Project it was really delegated.
    const seen = await get(address, '/v1/tools/memory/search?q=pnpm', tokenOf(pmSessionId))
    expect(seen.status).toBe(200)
    const answer = await seen.json() as { hits: { scopeId: string }[] }
    expect(answer.hits).toHaveLength(1)
    expect(answer.hits[0]!.scopeId).toBe(`project:${projectId}`)

    // The operator's own key opens no tool route: a Session token is the only authority there.
    expect((await get(address, '/v1/tools/memory/search?q=pnpm', API_TOKEN)).status).toBe(401)
  })

  it('registers the search tool for the Router, the PM and the Worker, and not for the memory manager', async () => {
    class FakeAgent {
      readonly tools = new Map<string, { name: string; description: string; parameters: unknown
        execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }>()
      readonly ctx = { tools: { register: (definition: { name: string; description: string; parameters: unknown
        execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }): (() => void) => {
        this.tools.set(definition.name, definition)
        return () => { this.tools.delete(definition.name) }
      } } }
    }

    directory = mkdtempSync(join(tmpdir(), 'superagent-retriever-node-'))
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
    const host = createDshPortHost({ context: { agents: { get: () => undefined },
      workspaceRegistry: { async archiveSession() {} } },
      nodeRuntime: { sessions }, nodeId: NODE_ID, root, controlUrl: 'http://control.test', fetch: fetchImpl })

    for (const [sessionId, role, profile] of [
      ['router', 'router', ROUTER_PROFILE],
      ['pm', 'pm', PM_PROFILE],
      ['worker', 'worker', WORKER_PROFILE],
    ] as const) {
      await host.ensureSession({ sessionId, workspace: join(root, sessionId), title: sessionId, role,
        profile, prompt: profile.prompt, sessionToken: 'token' })
      expect([...agents.get(sessionId)!.tools.keys()]).toContain('control_memory_search')
    }

    // The memory manager reviews candidates inside the scope of the one it was given: it may not search everything.
    await host.ensureSession({ sessionId: MEMORY_MANAGER_PROFILE_NAME, workspace: join(root, 'manager'),
      title: 'Memory Manager', role: 'manager', profile: MEMORY_MANAGER_PROFILE,
      prompt: MEMORY_MANAGER_PROFILE.prompt, sessionToken: 'token' })
    expect([...agents.get(MEMORY_MANAGER_PROFILE_NAME)!.tools.keys()]).not.toContain('control_memory_search')
    expect([...MEMORY_MANAGER_PROFILE.tools] as string[]).not.toContain('control_memory_search')
  })
})
