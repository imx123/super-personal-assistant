/**
 * The retriever: the ranked recall of the long-term memory.
 *
 * **The storage layer filters first.** The rows a search may look at are chosen in one SQL statement, and that statement
 * carries the caller's own scopes and the state a memory must be in to be recalled: `status = 'active'` and the
 * `(scope_type, scope_id)` pairs the caller may read. The bound that follows is taken over that set and never over a set
 * that was gathered first and filtered afterwards — a busy Project elsewhere may not take the place of this caller's own
 * memories, and a memory of another Project may not be counted, shown, explained or counted in the fallback at all.
 *
 * **The statistics come from the caller's own rows.** The keyword path is a BM25, and every number behind it — how many
 * rows the question is asked of, how many of them carry a word, how long they are on average — is counted over the
 * caller's own rows and over nothing else. Another Project's memory, a memory that waits for a decision and a memory
 * that is no longer in force are not in the corpus, so they cannot move a score or an order: the same question asked of
 * the same scope answers the same way whatever else the control plane happens to hold. The index itself still holds every
 * memory and still answers which rows carry the words of the question (`MATCH`); only the numbers behind the order are
 * the caller's own.
 *
 * **Two paths, one ranking.** The lexical path is the keyword index and the BM25 of the caller's own rows, and it is
 * deterministic: the same database and the same question give the same order. The semantic path is optional and
 * pluggable: a provider that turns text into numbers and nothing else — no prompt, no generation, no dialogue. When no
 * provider is configured, or the one that is configured is not there, the search falls back to the lexical path, says
 * that it did (`degraded`), and is never blocked by it: the provider is asked once per search, it is given a short time
 * to answer, and a provider that fails or that never answers is left alone for a while. That while is a cooldown and not
 * a verdict: the search after it may find the provider healthy again, so a service that has to be repaired does not have
 * to be restarted to be repaired.
 *
 * **The fallback is what makes Chinese work.** FTS5's `unicode61` tokenizer reads a run of Chinese characters as one
 * token, so a Chinese question finds nothing in an index built that way. The fallback compares the terms of the question
 * with the body of each candidate directly — the same terms, the same order, the same answer every time — and it only
 * ever looks at the rows the caller's own scopes allow. A row the fallback found carries the words of the question just
 * as much as a row the index matched, so the bound keeps it the same way: the one memory that answers the question is
 * never cut in favour of a hundred that do not answer it.
 *
 * **A read never changes what it read.** The retriever writes nothing: the counters of a memory — how often it was
 * exposed, how often it was really used, how much it is worth — belong to the service that writes memories, and a search
 * that raised the worth of what it found would be a search that pays for being read. The keyword index is checked when
 * the database is opened and never in the middle of a search; a memory written afterwards is indexed by the trigger of
 * the memory table itself, in the very transaction that wrote it.
 *
 * **The index belongs to the table it indexes.** The keyword index is written by triggers on the memory table, so it
 * changes in the same transaction as the memory it holds and may never drift away from it; a database that was opened
 * before this module existed, or one whose index was damaged, is rebuilt from the table itself when it is opened.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { allowedScopes, parseSourceRefs, type MemoryCaller, type MemoryScopeSet, type MemorySourceRef } from './memory-scope.ts'

/**
 * A provider that turns text into numbers.
 *
 * It encodes and nothing else: there is no prompt in it, no generation, no dialogue and no answer. A provider that is not
 * configured is not an error — the search says that it fell back and carries on.
 */
export interface EmbeddingProvider {
  /** The name of the provider, for the answer's own explanation. */
  readonly name: string
  /** How many numbers one vector holds. */
  readonly dimensions: number
  /** Encode a batch of texts. The answer is one vector per text, in the same order. */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}

/** The weights of the inner priority of a memory. */
export interface MemoryRetrievalWeights {
  /** How much the importance of a fact counts. */
  readonly importance: number
  /** How much the confidence of a fact counts. */
  readonly confidence: number
  /** How much the freshness of a fact counts. */
  readonly freshness: number
  /** How much the usefulness of a fact counts. */
  readonly utility: number
}

/** The knobs of the retrieval, all of them replaceable. */
export interface MemoryRetrievalConfig {
  /** The lowest relevance a hit may have; below it, it is not a hit at all. */
  readonly minRelevance: number
  /** The weights of the inner priority `P`. */
  readonly weights: MemoryRetrievalWeights
  /** How much of the score is the relevance alone; the rest is the priority of the fact. */
  readonly alpha: number
  /** The decay per day, by the kind of the fact: a preference stays, a device fact goes fast. */
  readonly decay: {
    readonly user_global: number
    readonly project: number
    readonly node_env: number
  }
  /** The freshness under which a hit is marked as waiting for a new verification. */
  readonly staleFreshness: number
  /** The most hits one search returns. */
  readonly limit: number
  /** The most rows one search scores, inside the caller's own scopes. */
  readonly candidateLimit: number
  /** The share of the relevance the lexical path carries when both paths run. */
  readonly lexicalShare: number
  /** The factor a hit with an open conflict is multiplied by. */
  readonly conflictPenalty: number
  /** How long the semantic path may take before the keyword path answers alone, in milliseconds. */
  readonly providerTimeoutMs: number
  /**
   * How long the semantic path is left alone after it failed, in milliseconds.
   *
   * The cooldown is finite on purpose: a provider that is out is not asked again at once, and it is not written off for
   * ever either. After the cooldown, the next search asks it again and may find it well.
   */
  readonly providerCooldownMs: number
}

/**
 * The retrieval as it runs when nothing says otherwise.
 *
 * The numbers are the ones the contract names: the relevance floor of `0.30`, the weights `0.35 / 0.25 / 0.25 / 0.15`
 * and the `0.5` that gives the relevance half of the score. They are here and not buried in the code so that they may be
 * replaced and compared.
 */
export const DEFAULT_MEMORY_RETRIEVAL_CONFIG: MemoryRetrievalConfig = {
  minRelevance: 0.30,
  weights: { importance: 0.35, confidence: 0.25, freshness: 0.25, utility: 0.15 },
  alpha: 0.5,
  decay: { user_global: 0, project: 0.005, node_env: 0.02 },
  staleFreshness: 0.5,
  limit: 5,
  candidateLimit: 500,
  lexicalShare: 0.6,
  conflictPenalty: 0.5,
  providerTimeoutMs: 2000,
  providerCooldownMs: 30_000,
}

/** The most hits one search may return. */
export const MEMORY_SEARCH_LIMIT = 20

/** The most rows one search may look at. */
export const MEMORY_SEARCH_CANDIDATE_LIMIT = 500

/**
 * The numbers a deployment may set, and the ranges they must lie in.
 *
 * The ranges are the ones the contract names: a relevance floor and a weight are shares of something, so they lie in
 * `[0, 1]`. A deployment that names a number outside its range is refused at startup rather than quietly changing the
 * ranking of every memory the control plane holds.
 */
export const MEMORY_RETRIEVAL_BOUNDS = {
  /** The relevance floor `R_min`. */
  minRelevance: { min: 0, max: 1 },
  /** One weight of the inner priority `P`. */
  weight: { min: 0, max: 1 },
} as const

/** One request to recall the memory. */
export interface MemorySearchRequest {
  /** The caller, as the control plane authenticated it. The scopes follow from it and from nothing else. */
  readonly caller: MemoryCaller
  /** The words to look for. */
  readonly query: string
  /** The most hits to return. */
  readonly limit?: number
  /** Narrow the search to one scope, when the caller may read it. */
  readonly scope?: { readonly scopeType: string; readonly scopeId: string }
}

/** The numbers behind one score, so that a person may check them. */
export interface MemoryScoreBreakdown {
  /** The relevance of the hit, in `[0, 1]`. */
  readonly relevance: number
  /** The relevance the keyword path found. */
  readonly lexical: number
  /** The relevance the semantic path found; zero when there was no such path. */
  readonly vector: number
  /** The share of the question's terms the body carries. */
  readonly coverage: number
  /** The inner priority of the fact, in `[0, 1]`. */
  readonly priority: number
  readonly importance: number
  readonly confidence: number
  readonly freshness: number
  readonly utility: number
  readonly weights: MemoryRetrievalWeights
}

/** One memory the search found. */
export interface MemoryHit {
  readonly memoryId: string
  readonly scopeType: string
  readonly scopeId: string
  /** The body of the memory, already redacted. */
  readonly content: string
  /** The confidence of the fact. */
  readonly confidence: number
  /** The importance of the fact. */
  readonly importance: number
  /** The usefulness of the fact. */
  readonly utility: number
  /** The freshness of the fact, in `[0, 1]`. */
  readonly freshness: number
  /** The score the hit is ordered by. */
  readonly score: number
  readonly lastVerifiedAt: string
  readonly sourceTrust: string
  readonly sourceRefs: readonly MemorySourceRef[]
  /** Whether an open conflict touches this fact. */
  readonly conflictWarning: boolean
  /** Whether the fact is waiting for a new verification. */
  readonly staleWarning: boolean
  /** Whether the fact came from outside and may not be believed as it stands. */
  readonly tainted: boolean
  /** Whether a person pinned this fact. */
  readonly pinned: boolean
  /** The numbers behind the score. */
  readonly breakdown: MemoryScoreBreakdown
  /** The same numbers in words. */
  readonly reasons: readonly string[]
}

/** The answer of one search. */
export interface MemorySearchResult {
  readonly hits: readonly MemoryHit[]
  /** Whether the search had to leave a path out. */
  readonly degraded: boolean
  /** Why it did. */
  readonly degradedReason: string
  /** The moment the answer was made. */
  readonly asOf: string
  /** How many rows the search looked at — the caller's own rows and nothing else. */
  readonly considered: number
  /** The relevance floor the search ran with. */
  readonly minRelevance: number
  /** The weights the search ran with. */
  readonly weights: MemoryRetrievalWeights
}

/** One memory, read by its id. */
export interface MemoryReadView {
  readonly memoryId: string
  readonly scopeType: string
  readonly scopeId: string
  readonly content: string
  readonly status: string
  readonly sourceTrust: string
  readonly sourceRefs: readonly MemorySourceRef[]
  readonly confidence: number
  readonly importance: number
  readonly utility: number
  readonly lastVerifiedAt: string
}

/** The answer of a read of one memory. */
export type MemoryReadResult =
  | { readonly found: true; readonly memory: MemoryReadView }
  | { readonly found: false }

/** What the retriever asks of the control plane it runs in. */
export interface MemoryRetrieverHost {
  /** The control plane's own clock. */
  now(): string
}

/**
 * The triggers that keep the keyword index in step with the memories.
 *
 * The index is a table of its own beside the memories, and the triggers keep it in step: a memory that is written is
 * indexed in the same transaction, a memory that is changed is indexed again, and a memory that is deleted leaves the
 * index. The triggers fire on the content alone, so counting an exposure or refreshing a verification does not rewrite
 * the index.
 *
 * The index is created the way every other table of this control plane is created: idempotently, and without a version of
 * its own. A database that never had it gets it, and a database that has it keeps it.
 */
const TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS long_term_memories_fts_insert AFTER INSERT ON long_term_memories BEGIN
  INSERT INTO long_term_memories_fts(rowid, content) VALUES (new.seq, new.content);
END;
CREATE TRIGGER IF NOT EXISTS long_term_memories_fts_delete AFTER DELETE ON long_term_memories BEGIN
  DELETE FROM long_term_memories_fts WHERE rowid = old.seq;
END;
CREATE TRIGGER IF NOT EXISTS long_term_memories_fts_update AFTER UPDATE OF content ON long_term_memories BEGIN
  DELETE FROM long_term_memories_fts WHERE rowid = old.seq;
  INSERT INTO long_term_memories_fts(rowid, content) VALUES (new.seq, new.content);
END;
`

/** The half of the relevance the keyword path may not give away on its own. */
const LEXICAL_FLOOR = 0.5

/** The point at which the strength of a keyword match stops mattering much. */
const BM25_SATURATION = 4

/** One row of the memories, as the search reads it. */
interface EligibleRow {
  readonly seq: number
  readonly memoryId: string
  readonly scopeType: string
  readonly scopeId: string
  readonly content: string
  readonly sourceTrust: string
  readonly sourceRefs: readonly MemorySourceRef[]
  readonly importance: number
  readonly confidence: number
  readonly utility: number
  readonly pinned: boolean
  readonly conflictWithId: string
  readonly lastVerifiedAt: string
}

/** What the keyword path found about one row. */
interface LexicalScore {
  /** The share of the question's terms the body carries. */
  readonly coverage: number
  /** The strength of the keyword match, as BM25 counts it over the caller's own rows. */
  readonly bm25: number
  /** The same strength, mapped into `[0, 1]`. */
  readonly bm25Norm: number
  /** The relevance the keyword path gives this row. */
  readonly lexical: number
  /** Whether the keyword index itself matched this row: a row it cannot read has no BM25 strength. */
  readonly matched: boolean
}

/**
 * The corpus one question is asked of.
 *
 * Every number in it is counted over the caller's own rows: how many there are, how long they are on average and how
 * many of them carry each word of the question. Nothing outside the caller's scopes is in it, so nothing outside the
 * caller's scopes can move a score.
 */
interface Corpus {
  /** How many rows the question is asked of. */
  readonly rows: number
  /** The average length of those rows, in tokens. */
  readonly avgLength: number
  /** How many of those rows carry each word of the question. */
  readonly documentFrequency: ReadonlyMap<string, number>
}

/**
 * The retriever of one control plane.
 *
 * It reads the memories of this control plane's own file and answers with the ones the caller may see. It writes nothing,
 * reaches no network of its own and calls no model.
 */
export class MemoryRetriever {
  private readonly config: MemoryRetrievalConfig
  private readonly provider: EmbeddingProvider | undefined
  private readonly onError: (error: unknown) => void
  /** Whether this SQLite build knows FTS5 at all. */
  private ftsAvailable = true
  /** The moment the semantic path may be asked again; a provider that is out is left alone until then. */
  private providerCooldownUntil = 0
  /** Why the semantic path is out, when it is out. */
  private providerReason = ''
  private depth = 0

  constructor(private readonly db: DatabaseSync, private readonly host: MemoryRetrieverHost,
    options: {
      readonly config?: Partial<MemoryRetrievalConfig>
      readonly embeddingProvider?: EmbeddingProvider
      readonly onError?: (error: unknown) => void
    } = {}) {
    this.config = mergeConfig(options.config)
    this.provider = options.embeddingProvider
    this.onError = options.onError ?? (() => {})
    this.migrate()
    this.ensureIndex()
  }

  /**
   * The knobs the search runs with, as they are in force right now.
   *
   * They are here so that a deployment may see what it configured: the search answers with the same numbers it scored
   * with, and a person may compare the two.
   */
  get retrievalConfig(): MemoryRetrievalConfig { return this.config }

  /**
   * Make sure the index is there, and that it holds what the table holds.
   *
   * The table of the index is created the way every other table of this control plane is created: idempotently, and
   * without a version of its own. The triggers that keep it in step are created with it, so a memory that is written
   * afterwards is indexed in the same transaction.
   *
   * A SQLite build without FTS5 is not a broken control plane: the keyword index is then left out and the search falls
   * back to the comparison of the terms, which needs nothing of the extension.
   */
  private migrate(): void {
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS long_term_memories_fts USING fts5(content, tokenize='unicode61')")
    } catch (error) {
      this.ftsAvailable = false
      this.onError(error)
      return
    }
    try {
      this.db.exec(TRIGGERS)
    } catch (error) {
      // The triggers need the table of the memories. Without it there is nothing to keep in step, and the index is
      // rebuilt from the table whenever the database is opened again.
      this.onError(error)
    }
  }

  /**
   * Bring the keyword index back in step with the table it indexes.
   *
   * The index and the table are written together, so they may not differ; but a database that was opened before this
   * module existed has rows the index never saw, and a damaged index has rows the table does not. Both are found by
   * comparing what the two hold, and both are answered by rebuilding the index from the table — the table is the truth
   * and the index is only a way to find things in it.
   *
   * It answers whether it had to rebuild anything.
   */
  ensureIndex(): boolean {
    if (!this.ftsAvailable) return false
    let expected = ''
    let stored = ''
    try {
      expected = this.digestOfMemories()
      stored = this.digestOfIndex()
    } catch (error) {
      this.onError(error)
      return false
    }
    if (expected === stored) return false
    this.rebuildIndex()
    return true
  }

  /** Write the index again from the table it indexes. */
  private rebuildIndex(): void {
    if (!this.ftsAvailable) return
    try {
      this.transaction(() => {
        this.db.exec('DELETE FROM long_term_memories_fts')
        this.db.exec('INSERT INTO long_term_memories_fts(rowid, content) SELECT seq, content FROM long_term_memories')
      })
    } catch (error) {
      this.onError(error)
    }
  }

  /** What the table of the memories holds, as one digest. */
  private digestOfMemories(): string {
    const rows = this.db.prepare('SELECT seq, content FROM long_term_memories ORDER BY seq').all() as
      { seq: number, content: string }[]
    return digestOf(rows.map(row => `${row.seq} ${row.content}`))
  }

  /** What the index holds, as one digest. */
  private digestOfIndex(): string {
    const rows = this.db.prepare('SELECT rowid, content FROM long_term_memories_fts ORDER BY rowid').all() as
      { rowid: number, content: string }[]
    return digestOf(rows.map(row => `${row.rowid} ${row.content}`))
  }

  // ─── the search ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Recall the memories that answer a question.
   *
   * The order of the work is the one the contract names: the rows the caller may read are chosen in SQL first, then the
   * two paths run inside that set, then the relevance is normalized, the floor is applied and the score is made.
   *
   * The bound comes after the scope and after the keyword match, never before them: a hundred fresh memories that do not
   * carry the words of the question may not push the one that does out of the set, and the statistics the keyword path
   * counts are the ones of the caller's own rows either way.
   *
   * The answer says what it could not do: `degraded` is true when the semantic path was not there, and the reason says
   * which way the search went instead. A search that fell back is a complete answer, not a broken one.
   */
  async search(input: MemorySearchRequest): Promise<MemorySearchResult> {
    const asOf = this.host.now()
    const nowMs = momentOf(asOf)
    const query = input.query.trim()
    const limit = this.limitOf(input.limit)
    const scopes = allowedScopes(input.caller)
    const authorized = this.authorizedRows(scopes, input.scope)
    const base = {
      asOf,
      considered: authorized.length,
      minRelevance: this.config.minRelevance,
      weights: this.config.weights,
    }
    if (authorized.length === 0 || query === '') {
      const reasons: string[] = []
      if (this.provider === undefined) reasons.push(NO_PROVIDER_REASON)
      else if (this.providerCooldownUntil > nowMs) reasons.push(this.providerReason)
      if (!this.ftsAvailable) reasons.push(NO_KEYWORD_INDEX_REASON)
      return {
        ...base,
        degraded: reasons.length > 0,
        degradedReason: reasons.join(' '),
        hits: [],
      }
    }

    const lexical = this.lexicalScores(authorized, query, scopes, input.scope)
    const candidates = this.candidateSet(authorized, lexical)
    const semantic = await this.semanticScores(candidates, query, nowMs)
    const conflicted = this.conflictedMemories()

    const scored: MemoryHit[] = []
    for (const row of candidates) {
      const lex = lexical.get(row.seq)
      const vector = semantic.scores.get(row.seq) ?? 0
      const lexicalScore = lex?.lexical ?? 0
      const relevance = semantic.used
        ? clamp01(this.config.lexicalShare * lexicalScore + (1 - this.config.lexicalShare) * vector)
        : lexicalScore
      if (relevance < this.config.minRelevance) continue

      const freshness = this.freshnessOf(row, nowMs)
      const importance = clamp01(row.importance)
      const confidence = clamp01(row.confidence)
      const utility = clamp01(row.utility)
      const priority = this.config.weights.importance * importance
        + this.config.weights.confidence * confidence
        + this.config.weights.freshness * freshness
        + this.config.weights.utility * utility
      const conflict = row.conflictWithId !== '' || conflicted.has(row.memoryId)
      let score = relevance * (this.config.alpha + (1 - this.config.alpha) * priority)
      if (conflict) score *= this.config.conflictPenalty
      const stale = freshness < this.config.staleFreshness
      const tainted = row.sourceTrust === 'external_tainted'

      const breakdown: MemoryScoreBreakdown = {
        relevance, lexical: lexicalScore, vector, coverage: lex?.coverage ?? 0, priority,
        importance, confidence, freshness, utility, weights: this.config.weights,
      }
      scored.push({
        memoryId: row.memoryId,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        content: row.content,
        confidence, importance, utility, freshness, score,
        lastVerifiedAt: row.lastVerifiedAt,
        sourceTrust: row.sourceTrust,
        sourceRefs: row.sourceRefs,
        conflictWarning: conflict,
        staleWarning: stale,
        tainted,
        pinned: row.pinned,
        breakdown,
        reasons: this.reasonsOf(breakdown, { stale, tainted, conflict, vectorUsed: semantic.used }),
      })
    }

    scored.sort(compareHits)
    const reasons: string[] = []
    if (semantic.degraded) reasons.push(semantic.reason)
    if (!this.ftsAvailable) reasons.push(NO_KEYWORD_INDEX_REASON)
    return {
      ...base,
      degraded: reasons.length > 0,
      degradedReason: reasons.join(' '),
      hits: scored.slice(0, limit),
    }
  }

  /**
   * The rows a search may look at, chosen in one statement.
   *
   * The state a memory must be in to be recalled and the scopes the caller may read are in the same `WHERE`, so the
   * set may only ever hold rows the caller was allowed to see. Nothing of another Project is read, and nothing of
   * another Project is counted.
   *
   * The set is not bounded here: the keyword path counts its statistics over these rows and over nothing else, and a
   * bound taken here would make those statistics depend on which rows happened to be the newest. The bound is taken
   * later, after the keyword match.
   */
  private authorizedRows(scopes: MemoryScopeSet, filter: { scopeType: string; scopeId: string } | undefined): EligibleRow[] {
    const scope = scopeClause(scopes, 'm')
    if (scope === undefined) return []
    const clauses = ["m.status = 'active'", scope.sql]
    const params: SQLInputValue[] = [...scope.params]
    if (filter !== undefined) {
      clauses.push('m.scope_type = ?', 'm.scope_id = ?')
      params.push(filter.scopeType, filter.scopeId)
    }
    const rows = this.db.prepare(
      `SELECT m.seq, m.memory_id, m.scope_type, m.scope_id, m.content, m.source_trust, m.source_refs, m.importance,
              m.confidence, m.utility, m.pinned, m.conflict_with_id, m.last_verified_at
         FROM long_term_memories m
        WHERE ${clauses.join(' AND ')}
        ORDER BY m.pinned DESC, m.last_verified_at DESC, m.seq DESC`).all(...params) as Record<string, SQLInputValue>[]
    return rows.map(row => ({
      seq: Number(row.seq),
      memoryId: String(row.memory_id),
      scopeType: String(row.scope_type),
      scopeId: String(row.scope_id),
      content: String(row.content),
      sourceTrust: String(row.source_trust),
      sourceRefs: parseSourceRefs(String(row.source_refs ?? '')),
      importance: Number(row.importance),
      confidence: Number(row.confidence),
      utility: Number(row.utility),
      pinned: Number(row.pinned) === 1,
      conflictWithId: String(row.conflict_with_id ?? ''),
      lastVerifiedAt: String(row.last_verified_at),
    }))
  }

  /**
   * The rows one search scores, in the order the bound may cut them.
   *
   * Every row that carries the words of the question comes first, the strongest of them before the others; the rows that
   * carry none of them follow in the order the storage layer gave them. The bound is therefore taken after the scope and
   * after the words were compared: a hundred fresh memories that do not carry the words of the question may not push the
   * one that does out of the set.
   *
   * "Carries the words" is the one thing both paths agree on: the keyword index matched the row, or the comparison of
   * the terms found the words in its body. A Chinese question is answered by the second one alone, so a bound that only
   * knew about the index would cut the one memory that answers the question in favour of a hundred that say nothing
   * about it.
   *
   * The order inside the first group is the relevance the rows actually have, not the age of them: the strongest match
   * is scored first, and the rows that tie keep the order the storage layer gave them.
   */
  private candidateSet(authorized: readonly EligibleRow[], lexical: ReadonlyMap<number, LexicalScore>): EligibleRow[] {
    const carrying: EligibleRow[] = []
    const rest: EligibleRow[] = []
    for (const row of authorized) {
      const score = lexical.get(row.seq)
      if (score !== undefined && (score.matched || score.coverage > 0)) carrying.push(row)
      else rest.push(row)
    }
    carrying.sort((left, right) => (lexical.get(right.seq)?.lexical ?? 0) - (lexical.get(left.seq)?.lexical ?? 0))
    return [...carrying, ...rest].slice(0, this.config.candidateLimit)
  }

  /**
   * What the keyword path found about every candidate.
   *
   * The strength of the match comes from a BM25 counted over the caller's own rows, and the share of the question's
   * terms the body carries comes from the comparison of the terms. The two are put together, and a body the index did
   * not match at all — a Chinese question, most of the time — keeps the share alone.
   *
   * The comparison is one of substrings, and it is the same rule for every row: a term that is part of a longer word
   * counts as carried. That is what makes the Chinese pairs work at all, since a pair is never a word of its own; the
   * BM25 counts whole words only, so a body that carries the term inside a longer word is carried but not strong.
   */
  private lexicalScores(authorized: readonly EligibleRow[], query: string, scopes: MemoryScopeSet,
    filter: { scopeType: string; scopeId: string } | undefined): Map<number, LexicalScore> {
    const scores = new Map<number, LexicalScore>()
    const terms = queryTerms(query)
    const matched = this.matchedSeqs(query, scopes, filter)
    const corpus = corpusOf(authorized, terms)
    for (const row of authorized) {
      const body = normalizeForSearch(row.content)
      const carried = terms.filter(term => body.includes(term)).length
      const coverage = terms.length === 0 ? 0 : carried / terms.length
      const isMatched = matched.has(row.seq)
      const strength = isMatched ? bm25Of(row, terms, corpus) : 0
      const norm = strength / (strength + BM25_SATURATION)
      scores.set(row.seq, {
        coverage,
        bm25: strength,
        bm25Norm: norm,
        lexical: coverage * (LEXICAL_FLOOR + (1 - LEXICAL_FLOOR) * norm),
        matched: isMatched,
      })
    }
    return scores
  }

  /**
   * The rows the keyword index says carry the words of the question.
   *
   * The query is the same one the index holds, and the scopes of the caller are in the same statement, so the index is
   * asked about the caller's own rows only. The index answers which rows match and nothing else: the numbers behind the
   * order are counted over the caller's own rows, so that another Project's memory cannot move a score.
   *
   * A query the index refuses is not an error — the comparison of the terms carries the answer on its own.
   */
  private matchedSeqs(query: string, scopes: MemoryScopeSet,
    filter: { scopeType: string; scopeId: string } | undefined): Set<number> {
    const found = new Set<number>()
    if (!this.ftsAvailable) return found
    const scope = scopeClause(scopes, 'm')
    if (scope === undefined) return found
    const match = ftsQuery(query)
    if (match === '') return found
    const clauses = ['long_term_memories_fts MATCH ?', "m.status = 'active'", scope.sql]
    const params: SQLInputValue[] = [match, ...scope.params]
    if (filter !== undefined) {
      clauses.push('m.scope_type = ?', 'm.scope_id = ?')
      params.push(filter.scopeType, filter.scopeId)
    }
    try {
      const rows = this.db.prepare(
        `SELECT long_term_memories_fts.rowid AS seq
           FROM long_term_memories_fts
           JOIN long_term_memories m ON m.seq = long_term_memories_fts.rowid
          WHERE ${clauses.join(' AND ')}`).all(...params) as { seq: number }[]
      for (const row of rows) found.add(Number(row.seq))
    } catch (error) {
      this.onError(error)
    }
    return found
  }

  /**
   * What the semantic path found, when there is one.
   *
   * The provider is asked once per search and is never waited for twice: a provider that is not there, that fails or
   * that never answers leaves the search with the keyword path and says so. The answer of a provider that holds fewer
   * vectors than texts is used for as many as it holds and no further.
   *
   * A provider that failed is left alone for a while, and the while ends by itself: the search after the cooldown asks it
   * again, and a provider that has come back answers as if nothing had happened. A service that has to be repaired is
   * therefore not a service that has to be restarted.
   */
  private async semanticScores(candidates: readonly EligibleRow[], query: string, nowMs: number): Promise<{
    scores: Map<number, number>
    used: boolean
    degraded: boolean
    reason: string
  }> {
    if (this.provider === undefined) {
      return { scores: new Map(), used: false, degraded: true, reason: NO_PROVIDER_REASON }
    }
    if (this.providerCooldownUntil > nowMs) {
      // The provider is cooling down. It is not asked again yet, and the search says why it went on without it.
      return { scores: new Map(), used: false, degraded: true, reason: this.providerReason }
    }
    let vectors: readonly (readonly number[])[]
    try {
      vectors = await this.withTimeout(this.provider.embed([query, ...candidates.map(row => row.content)]),
        this.config.providerTimeoutMs)
    } catch (error) {
      this.onError(error)
      this.providerReason = error instanceof ProviderTimeoutError ? PROVIDER_TIMEOUT_REASON : PROVIDER_FAILED_REASON
      this.providerCooldownUntil = nowMs + this.config.providerCooldownMs
      return { scores: new Map(), used: false, degraded: true, reason: this.providerReason }
    }
    const head = vectors[0]
    if (head === undefined || head.length === 0) {
      this.providerReason = PROVIDER_FAILED_REASON
      this.providerCooldownUntil = nowMs + this.config.providerCooldownMs
      return { scores: new Map(), used: false, degraded: true, reason: PROVIDER_FAILED_REASON }
    }
    // The provider answered: it is well, and the next search may ask it again.
    this.providerCooldownUntil = 0
    this.providerReason = ''
    const scores = new Map<number, number>()
    for (const [index, row] of candidates.entries()) {
      const vector = vectors[index + 1]
      if (vector === undefined || vector.length === 0) continue
      scores.set(row.seq, clamp01(cosine(head, vector)))
    }
    return { scores, used: true, degraded: false, reason: '' }
  }

  /**
   * A wait with a bound.
   *
   * The work is asked once and the wait is short: a provider that never answers loses the race and the search goes on
   * with the keyword path alone. The work itself is not cancelled — it is simply not waited for any more.
   */
  private async withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
    const bound = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0
    if (bound === 0) return work
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          // The timer is cleared as soon as the race is over, so it never outlives the call that made it.
          timer = setTimeout(() => reject(new ProviderTimeoutError()), bound)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * The memories an open conflict touches.
   *
   * A memory that is held by a conflict is not a candidate in the first place; this is about a memory that is still in
   * force and still stands next to a conflict somebody has not settled.
   */
  private conflictedMemories(): Set<string> {
    const rows = this.db.prepare(
      "SELECT memory_id, other_memory_id FROM memory_conflicts WHERE state = 'open'").all() as
      { memory_id: string, other_memory_id: string }[]
    const ids = new Set<string>()
    for (const row of rows) {
      if (row.memory_id !== '') ids.add(row.memory_id)
      if (row.other_memory_id !== '') ids.add(row.other_memory_id)
    }
    return ids
  }

  /**
   * The freshness of a fact, measured from the last time it was verified.
   *
   * The moment it was written is not the moment it was checked, and the second one is the one that counts: a fact that
   * was checked yesterday is fresher than a fact that was written yesterday and never looked at again. The decay is
   * chosen by the kind of the fact: a preference of the person stays, a fact about a machine goes faster than a fact
   * about a Project.
   */
  private freshnessOf(row: EligibleRow, nowMs: number): number {
    const verified = Date.parse(row.lastVerifiedAt)
    if (Number.isNaN(verified)) return 0
    const days = Math.max(0, (nowMs - verified) / 86_400_000)
    const lambda = this.lambdaOf(row.scopeType)
    if (lambda <= 0) return 1
    return clamp01(Math.exp(-lambda * days))
  }

  /** The decay of one kind of fact. */
  private lambdaOf(scopeType: string): number {
    if (scopeType === 'user_global') return this.config.decay.user_global
    if (scopeType === 'node_env') return this.config.decay.node_env
    return this.config.decay.project
  }

  /** The words that say why a hit is where it is. */
  private reasonsOf(breakdown: MemoryScoreBreakdown, flags: {
    readonly stale: boolean
    readonly tainted: boolean
    readonly conflict: boolean
    readonly vectorUsed: boolean
  }): string[] {
    const reasons: string[] = []
    reasons.push(`相关性 ${breakdown.relevance.toFixed(2)}（关键词 ${breakdown.lexical.toFixed(2)}`
      + `${flags.vectorUsed ? `，向量 ${breakdown.vector.toFixed(2)}` : ''}，命中 ${(breakdown.coverage * 100).toFixed(0)}% 的词）`)
    reasons.push(`内在优先级 ${breakdown.priority.toFixed(2)}（重要性 ${breakdown.importance.toFixed(2)}、`
      + `置信度 ${breakdown.confidence.toFixed(2)}、新鲜度 ${breakdown.freshness.toFixed(2)}、效用 ${breakdown.utility.toFixed(2)}）`)
    if (flags.stale) reasons.push('新鲜度已陈旧，注入时标注「待核验时效」。')
    if (flags.tainted) reasons.push('外部来源，不可信；注入时保留不可信警示。')
    if (flags.conflict) reasons.push('存在未决冲突，已按配置降权。')
    return reasons
  }

  // ─── one memory by its id ────────────────────────────────────────────────────────────────────────────────────

  /**
   * One memory, read by its id.
   *
   * A memory that is not in force is not there as far as this read is concerned, and an id that was never given is
   * answered in exactly the same way: the answer does not say whether the id ever existed, and it does not say whether
   * the id was forgotten or never was.
   */
  read(caller: MemoryCaller, memoryId: string): MemoryReadResult {
    if (memoryId === '') return { found: false }
    const scopes = allowedScopes(caller)
    const scope = scopeClause(scopes, 'm')
    if (scope === undefined) return { found: false }
    const row = this.db.prepare(
      `SELECT m.memory_id, m.scope_type, m.scope_id, m.content, m.status, m.source_trust, m.source_refs, m.confidence,
              m.importance, m.utility, m.last_verified_at
         FROM long_term_memories m
        WHERE m.memory_id = ? AND m.status = 'active' AND ${scope.sql}`).get(memoryId, ...scope.params) as
      Record<string, SQLInputValue> | undefined
    if (row === undefined) return { found: false }
    return {
      found: true,
      memory: {
        memoryId: String(row.memory_id),
        scopeType: String(row.scope_type),
        scopeId: String(row.scope_id),
        content: String(row.content),
        status: String(row.status),
        sourceTrust: String(row.source_trust),
        sourceRefs: parseSourceRefs(String(row.source_refs ?? '')),
        confidence: Number(row.confidence),
        importance: Number(row.importance),
        utility: Number(row.utility),
        lastVerifiedAt: String(row.last_verified_at),
      },
    }
  }

  /** The most hits one search may return. */
  private limitOf(limit: number | undefined): number {
    if (limit === undefined) return this.config.limit
    if (!Number.isInteger(limit) || limit < 1) return this.config.limit
    return Math.min(limit, MEMORY_SEARCH_LIMIT)
  }

  /**
   * One transaction, or none.
   *
   * A savepoint is used rather than a bare transaction, so the retriever may be called from inside a transaction of the
   * domain and still leave it to that transaction to decide what is kept.
   */
  private transaction<T>(work: () => T): T {
    const name = `retriever_atomic_${this.depth++}`
    this.db.exec(`SAVEPOINT ${name}`)
    try {
      const result = work()
      this.db.exec(`RELEASE ${name}`)
      return result
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`)
      this.db.exec(`RELEASE ${name}`)
      throw error
    } finally {
      this.depth--
    }
  }
}

/** The words that say that no semantic path was there. */
const NO_PROVIDER_REASON = '没有配置向量编码接口，检索退回关键词路径。'

/** The words that say that the semantic path failed. */
const PROVIDER_FAILED_REASON = '向量编码接口不可用，检索退回关键词路径。'

/** The words that say that the semantic path did not answer in time. */
const PROVIDER_TIMEOUT_REASON = '向量编码接口超时，检索退回关键词路径。'

/** The words that say that this SQLite build knows no keyword index. */
const NO_KEYWORD_INDEX_REASON = '这个 SQLite 没有全文索引，检索退回逐词比对。'

/** How fast the count of a word grows. The usual BM25 constant. */
const BM25_K1 = 1.2

/** How much the length of a body counts against it. The usual BM25 constant. */
const BM25_B = 0.75

/**
 * The wait that ran out.
 *
 * It says one thing and one thing only: the provider did not answer in the time it was given. The search answers with the
 * keyword path and says so.
 */
class ProviderTimeoutError extends Error {
  constructor() {
    super('the embedding provider did not answer in time')
    this.name = 'ProviderTimeoutError'
  }
}

/**
 * The corpus one question is asked of, counted over the caller's own rows.
 *
 * How many rows there are, how long they are on average and how many of them carry each word of the question: all three
 * are counted here and nowhere else. A row of another Project, a row that waits for a decision and a row that is no
 * longer in force are not in the set, so they cannot move a score or an order.
 */
function corpusOf(rows: readonly EligibleRow[], terms: readonly string[]): Corpus {
  const documentFrequency = new Map<string, number>()
  let total = 0
  for (const row of rows) {
    const tokens = documentTokens(row.content)
    total += tokens.length
    if (terms.length === 0) continue
    const carried = new Set(tokens)
    for (const term of terms) {
      if (!carried.has(term)) continue
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }
  return { rows: rows.length, avgLength: rows.length === 0 ? 0 : total / rows.length, documentFrequency }
}

/**
 * The strength of one row's keyword match, as BM25 counts it over the caller's own rows.
 *
 * The numbers behind it — how many rows the question is asked of, how many of them carry the word, how long they are on
 * average — come from the corpus of the caller's own rows. A word that no row of the corpus carries scores nothing, and
 * a row that carries no word of the question scores nothing either.
 */
function bm25Of(row: EligibleRow, terms: readonly string[], corpus: Corpus): number {
  if (corpus.rows === 0 || corpus.avgLength <= 0) return 0
  const tokens = documentTokens(row.content)
  if (tokens.length === 0) return 0
  let score = 0
  for (const term of terms) {
    const frequency = corpus.documentFrequency.get(term) ?? 0
    if (frequency === 0) continue
    let count = 0
    for (const token of tokens) if (token === term) count += 1
    if (count === 0) continue
    // The inverse document frequency, always positive: a word every row carries is worth little, but it is not worth
    // nothing, and a word that one row of many carries is worth a great deal.
    const idf = Math.log(1 + (corpus.rows - frequency + 0.5) / (frequency + 0.5))
    const length = 1 - BM25_B + BM25_B * (tokens.length / corpus.avgLength)
    score += idf * ((count * (BM25_K1 + 1)) / (count + BM25_K1 * length))
  }
  return score
}

/**
 * The order two hits are put in.
 *
 * The score comes first; then the facts that do not change: a pinned memory before an unpinned one, a memory that was
 * verified later before one that was not, and the id of the memory last of all, so two hits that are equal in every
 * other way keep the same order for ever.
 */
export function compareHits(left: MemoryHit, right: MemoryHit): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
  if (left.lastVerifiedAt !== right.lastVerifiedAt) return left.lastVerifiedAt < right.lastVerifiedAt ? 1 : -1
  if (left.memoryId !== right.memoryId) return left.memoryId < right.memoryId ? -1 : 1
  return 0
}

/**
 * The clause that holds the scopes of a reader.
 *
 * The rows it names are the rows the reader may read, and no other. A reader that may read nothing at all is answered
 * with a clause that matches nothing.
 */
function scopeClause(scopes: MemoryScopeSet, table: string): { sql: string; params: SQLInputValue[] } | undefined {
  if (scopes.all) return { sql: '1 = 1', params: [] }
  if (scopes.scopes.length === 0) return { sql: '1 = 0', params: [] }
  const parts = scopes.scopes.map(() => `(${table}.scope_type = ? AND ${table}.scope_id = ?)`).join(' OR ')
  const params: SQLInputValue[] = []
  for (const scope of scopes.scopes) params.push(scope.scopeType, scope.scopeId)
  return { sql: `(${parts})`, params }
}

/** The configuration of the retrieval, with the parts that were given. */
function mergeConfig(over: Partial<MemoryRetrievalConfig> | undefined): MemoryRetrievalConfig {
  if (over === undefined) return DEFAULT_MEMORY_RETRIEVAL_CONFIG
  return {
    minRelevance: unitOr(over.minRelevance, DEFAULT_MEMORY_RETRIEVAL_CONFIG.minRelevance),
    weights: {
      importance: unitOr(over.weights?.importance, DEFAULT_MEMORY_RETRIEVAL_CONFIG.weights.importance),
      confidence: unitOr(over.weights?.confidence, DEFAULT_MEMORY_RETRIEVAL_CONFIG.weights.confidence),
      freshness: unitOr(over.weights?.freshness, DEFAULT_MEMORY_RETRIEVAL_CONFIG.weights.freshness),
      utility: unitOr(over.weights?.utility, DEFAULT_MEMORY_RETRIEVAL_CONFIG.weights.utility),
    },
    alpha: unitOr(over.alpha, DEFAULT_MEMORY_RETRIEVAL_CONFIG.alpha),
    decay: {
      user_global: numberOr(over.decay?.user_global, DEFAULT_MEMORY_RETRIEVAL_CONFIG.decay.user_global),
      project: numberOr(over.decay?.project, DEFAULT_MEMORY_RETRIEVAL_CONFIG.decay.project),
      node_env: numberOr(over.decay?.node_env, DEFAULT_MEMORY_RETRIEVAL_CONFIG.decay.node_env),
    },
    staleFreshness: unitOr(over.staleFreshness, DEFAULT_MEMORY_RETRIEVAL_CONFIG.staleFreshness),
    limit: Math.max(1, Math.trunc(numberOr(over.limit, DEFAULT_MEMORY_RETRIEVAL_CONFIG.limit))),
    candidateLimit: Math.min(Math.max(1, Math.trunc(numberOr(over.candidateLimit,
      DEFAULT_MEMORY_RETRIEVAL_CONFIG.candidateLimit))), MEMORY_SEARCH_CANDIDATE_LIMIT),
    lexicalShare: unitOr(over.lexicalShare, DEFAULT_MEMORY_RETRIEVAL_CONFIG.lexicalShare),
    conflictPenalty: unitOr(over.conflictPenalty, DEFAULT_MEMORY_RETRIEVAL_CONFIG.conflictPenalty),
    providerTimeoutMs: Math.max(0, numberOr(over.providerTimeoutMs, DEFAULT_MEMORY_RETRIEVAL_CONFIG.providerTimeoutMs)),
    providerCooldownMs: Math.max(0, numberOr(over.providerCooldownMs,
      DEFAULT_MEMORY_RETRIEVAL_CONFIG.providerCooldownMs)),
  }
}

/** A number that was given, or the one that was expected. */
function numberOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return value
}

/**
 * A share of something, in `[0, 1]`.
 *
 * A number outside the range is not a share: it is a typo, and it is brought back inside the range rather than allowed to
 * change the ranking of every memory in a way nobody asked for.
 */
function unitOr(value: number | undefined, fallback: number): number {
  const number = numberOr(value, fallback)
  return Math.min(1, Math.max(0, number))
}

/** A number inside `[0, 1]`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** A moment in milliseconds, when the clock gave one. */
function momentOf(at: string): number {
  const parsed = Date.parse(at)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

/** How alike two vectors are, in `[0, 1]`. */
function cosine(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/**
 * The form a body is compared in.
 *
 * The same form as the fingerprint uses: NFKC, folded blanks and lower case, so that the same words in the same order
 * are the same words however they were spaced or cased.
 */
export function normalizeForSearch(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** A run of Chinese characters. */
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]+/g

/** A run of letters and digits of everything else. */
const LATIN_RUN = /[a-z0-9][a-z0-9_+#.-]*/g

/**
 * The terms of a question, as the search compares them.
 *
 * A run of Latin letters and digits is one term. A run of Chinese characters is cut into the pairs that carry its
 * meaning, because FTS5's tokenizer reads the whole run as one token and would never match it against a body that says
 * the same thing in other words.
 *
 * The same terms are used by the index and by the comparison, so the two paths answer about the same words.
 */
export function queryTerms(query: string): readonly string[] {
  const normalized = normalizeForSearch(query)
  const terms: string[] = []
  const add = (term: string): void => {
    if (term === '' || terms.includes(term)) return
    terms.push(term)
  }
  for (const run of normalized.match(LATIN_RUN) ?? []) add(run.replace(/[._+#-]+$/, ''))
  for (const run of normalized.match(CJK_RUN) ?? []) {
    if (run.length === 1) { add(run); continue }
    for (let index = 0; index + 1 < run.length; index += 1) add(run.slice(index, index + 2))
  }
  return terms
}

/**
 * The question as the index understands it.
 *
 * Every term is a quoted phrase, so a word of the question that holds a character the index treats as an operator is
 * looked for as a word and not as a command. Nothing of the question may change what the index does.
 */
export function ftsQuery(query: string): string {
  const terms = queryTerms(query)
  if (terms.length === 0) return ''
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * The words of a body, as the ranking counts them.
 *
 * The same words the question is cut into, cut the same way: a run of Latin letters and digits is one word, and a run of
 * Chinese characters is cut into the pairs that carry its meaning. A body is counted in these words — how long it is,
 * and how often it carries one of them — so that the numbers behind a score are measured in the same unit everywhere.
 *
 * Unlike the terms of a question, the words of a body are not told apart from one another: a body that says the same
 * word twice carries it twice.
 */
export function documentTokens(text: string): readonly string[] {
  const normalized = normalizeForSearch(text)
  const tokens: string[] = []
  for (const run of normalized.match(LATIN_RUN) ?? []) {
    const word = run.replace(/[._+#-]+$/, '')
    if (word !== '') tokens.push(word)
  }
  for (const run of normalized.match(CJK_RUN) ?? []) {
    if (run.length === 1) { tokens.push(run); continue }
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

/** One digest of a list of rows. */
function digestOf(rows: readonly string[]): string {
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}
