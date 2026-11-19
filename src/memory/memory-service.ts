/**
 * The memory service: the one place a long-term memory is written.
 *
 * A memory is a fact that may be reused across tasks: a preference the person stated, a fact about one machine, an
 * arrangement of one project. It is not a record of what happened — that is the event history — and it is not the
 * console's short-lived log. It lives in the control plane's own file, next to the records it points at, so the backup
 * and the rollback take one snapshot and a memory never refers to a Ticket that is no longer there.
 *
 * **Nothing here calls a model, reaches the network, starts a Session or runs a command.** The service is a pure
 * function over the records the control plane already holds: it decides what may be written, writes it in one
 * transaction, and hands the answers back. Who reviews a candidate — a person at the console today, the memory manager
 * of `P5-4` tomorrow — is the caller's business; the transitions are the same either way.
 *
 * **A candidate is a proposal and a memory is a decision.** A candidate enters the queue and waits. It becomes a
 * memory only when a decision says so, and no path exists that writes one directly: the operator's own words wait for
 * a decision like everybody else's. The queue is the place where the tainted, the unverifiable and the merely repeated
 * are held apart from what the control plane really knows.
 *
 * **The authority is the Session, never the request.** A caller is the Session it proved: the role its record carries,
 * the node it runs on, the Project it was really delegated. A body that names a role, a node, a Project or a trust tag
 * changes nothing. The trust of a fact is derived from the records its sources name, so a caller cannot promote its
 * own proposal by calling it verified.
 *
 * **A fact that came from outside stays outside.** A source the control plane cannot check, or one that is an
 * observation rather than a conclusion, taints the fact that carries it — and a tainted fact may never become a global
 * one, however it is worded. A conclusion is bound to the accepted review or the finished Assignment it came from,
 * never to a report's own text.
 *
 * **The body is written redacted, and it is short.** No prompt, no path, no secret and no raw tool argument reaches the
 * table; a body that carries one is refused rather than masked, because a masked secret is still a secret in a file
 * somebody may read.
 *
 * **The forgetting of a memory is not decided yet.** The contract leaves two ways open — a fingerprint that keeps
 * suppressing the fact, or a deletion that takes the text with it — and the user has not chosen. So no tombstone table
 * is created, no memory is deleted, and there is no action here that would forget anything.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { redact } from '../infra/redact.ts'
import {
  allowedScopes, candidateIdempotencyKey, contentFingerprint, containsAbsolutePath, containsSecret, mayPropose,
  maySeeCandidate, nodeIdOf, parseSourceRefs, proposalAuthority, projectIdOf, projectScope, recordWithinCaller, scopeOf,
  validateSourceRefs,
  type MemoryCaller, type MemoryScope, type MemoryScopeSet, type MemorySourceRecord, type MemorySourceRef,
  type SourceRefInput, type SourceRefKind, type SourceTrust,
} from './memory-scope.ts'

/** The states a candidate may be in. */
export type MemoryCandidateStatus =
  | 'queued'
  | 'reviewing'
  | 'active'
  | 'duplicate'
  | 'superseded'
  | 'conflict_pending'
  | 'pending_human_confirm'
  | 'expired_candidate'
  | 'needs_reverify'
  | 'rejected'

/** The most times one candidate may be sent back to the Session that proposed it. */
export const MEMORY_RETURN_LIMIT = 1

/**
 * The most times one candidate may be said once more by the Session that proposed it.
 *
 * A candidate goes round once: the manager sends it back, the proposer says it once more, and the manager reviews that
 * version. A second round waits for a person.
 */
export const MEMORY_REEVALUATION_LIMIT = 1

/** The states a memory may be in. */
export type MemoryStatus = 'active' | 'superseded' | 'forgotten' | 'needs_reverify' | 'conflict_pending'

/** The states a conflict may be in. */
export type MemoryConflictState = 'open' | 'resolved_merge' | 'resolved_supersede' | 'resolved_human' | 'expired'

/** The decisions one may take about a candidate. */
export type MemoryDecisionKind = 'approve' | 'reject' | 'merge' | 'conflict' | 'supersede'

/** The most characters one memory body may hold. */
export const MEMORY_CONTENT_LIMIT = 1000

/** The most rows one list may hold. */
export const MEMORY_LIST_LIMIT = 200

/** The most rows one list holds when the caller names no bound of its own. */
export const MEMORY_LIST_DEFAULT_LIMIT = 50

/** How long a candidate waits for a decision before it is cold, in days. */
export const MEMORY_CANDIDATE_RETENTION_DAYS = 30

/** How much a merge may raise the confidence of a memory. */
const CONFIDENCE_STEP = 0.02

/**
 * The most the usefulness of a memory may ever be.
 *
 * A fact may be worth a lot, but the number that counts how useful it was is a number inside `[0, 1]`: it says how
 * often the fact was really used, and a fact that was used a hundred times is not worth a hundred times as much.
 */
export const MEMORY_UTILITY_MAX = 1

/** How fast the usefulness of a memory grows with every real use of it. */
export const MEMORY_UTILITY_RATE = 0.5

/** How much one dispute takes from the confidence of a memory. */
export const MEMORY_DISPUTE_STEP = 0.1

/**
 * The confidence under which a memory waits for somebody to look at it again.
 *
 * A memory that was called misleading often enough stops being injected on its own: it waits for the next inspection,
 * which is where a person decides whether it is still true.
 */
export const MEMORY_CONFIDENCE_FLOOR = 0.3

/**
 * The tables of the memory service.
 *
 * They are created the way every other table of this control plane is created: idempotently, with
 * `CREATE TABLE IF NOT EXISTS`, and without a version of their own. A database opened before this module existed gets
 * them the first time it is opened after; a database that already has them keeps them.
 *
 * The `ticket` scope is absent by design: a Ticket's own detail is not a memory, and the write path refuses it before
 * it reaches a row. The `memory_tombstones` table is absent by decision: the contract leaves the forgetting of a memory
 * open, and a table that exists before the question is answered would be a table built on a guess.
 *
 * The live fingerprint index is partial: it covers the states in which a memory may still be recalled, so a superseded
 * or a rejected row may not stand in the way of a new fact with the same words.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_candidates (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  proposed_scope_type TEXT NOT NULL,
  proposed_scope_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  source_trust TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  proposed_by_session_id TEXT NOT NULL DEFAULT '',
  proposed_by_role TEXT NOT NULL DEFAULT '',
  provisional_same_session INTEGER NOT NULL DEFAULT 0,
  revision_count INTEGER NOT NULL DEFAULT 0,
  reevaluations INTEGER NOT NULL DEFAULT 0,
  returned_to_session_id TEXT NOT NULL DEFAULT '',
  conflict_with_id TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0,
  review_note TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL DEFAULT '',
  backend_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_candidates_idempotency ON memory_candidates(idempotency_key);
CREATE INDEX IF NOT EXISTS memory_candidates_status ON memory_candidates(status, created_at);
CREATE INDEX IF NOT EXISTS memory_candidates_scope ON memory_candidates(scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS memory_candidates_session ON memory_candidates(proposed_by_session_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS memory_candidates_live_fingerprint
  ON memory_candidates(scope_type, scope_id, content_fingerprint)
  WHERE status IN ('queued', 'reviewing', 'pending_human_confirm', 'conflict_pending');
CREATE TABLE IF NOT EXISTS long_term_memories (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  source_trust TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  supersedes_id TEXT NOT NULL DEFAULT '',
  superseded_by_id TEXT NOT NULL DEFAULT '',
  conflict_with_id TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  utility REAL NOT NULL DEFAULT 0,
  exposure_count INTEGER NOT NULL DEFAULT 0,
  effective_use_count INTEGER NOT NULL DEFAULT 0,
  disputed_count INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  deprecated_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT '',
  backend_id TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS long_term_memories_live_fingerprint
  ON long_term_memories(scope_type, scope_id, content_fingerprint)
  WHERE status IN ('active', 'conflict_pending');
CREATE INDEX IF NOT EXISTS long_term_memories_scope_active ON long_term_memories(scope_type, scope_id, status);
CREATE TABLE IF NOT EXISTS memory_conflicts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  conflict_id TEXT NOT NULL UNIQUE,
  memory_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL DEFAULT '',
  other_memory_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_conflicts_open
  ON memory_conflicts(memory_id, candidate_id) WHERE state = 'open';
CREATE TABLE IF NOT EXISTS memory_id_sequence (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO memory_id_sequence (name, value) VALUES ('memory', 0), ('candidate', 0), ('conflict', 0);
CREATE TABLE IF NOT EXISTS memory_use_credits (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_id TEXT NOT NULL UNIQUE,
  memory_id TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  utility REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_use_credits_pair ON memory_use_credits(memory_id, evidence_key);
CREATE TABLE IF NOT EXISTS memory_disputes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id TEXT NOT NULL UNIQUE,
  memory_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_disputes_memory ON memory_disputes(memory_id, at);
`

/**
 * The records the memory service reads and writes beside.
 *
 * The service owns no state of its own: every fact comes from here, so a memory can never be about a world this
 * control plane does not hold.
 */
export interface MemoryHost {
  /** The control plane's own clock: the moment a fact was written. */
  now(): string
  /** The node this control plane manages. */
  nodeId(): string
  /** The backend this control plane talks to. */
  backendId(): string
  /** The nodes this control plane knows. */
  nodeIds(): readonly string[]
  /** The Projects this control plane knows. */
  projectIds(): readonly string[]
  /**
   * The record a source reference names, when the control plane really holds it.
   *
   * The answer decides two things: whether the reference may be believed at all, and whether the fact it carries is a
   * conclusion the control plane confirmed.
   */
  source(kind: SourceRefKind, id: string): MemorySourceRecord | undefined
}

/** One candidate, as a reader sees it. */
export interface MemoryCandidateView {
  readonly candidateId: string
  readonly scopeType: string
  readonly scopeId: string
  readonly proposedScopeType: string
  readonly proposedScopeId: string
  /** The body of the proposal, already redacted. */
  readonly content: string
  readonly status: string
  readonly sourceTrust: string
  readonly sourceRefs: readonly MemorySourceRef[]
  readonly proposedByRole: string
  readonly proposedBySessionId: string
  /** Whether the proposal may be read inside the Session that made it while it waits. */
  readonly provisionalSameSession: boolean
  readonly revisionCount: number
  /** How many times the proposer has said this candidate once more after it was sent back. */
  readonly reevaluations: number
  /** The Session the candidate was sent back to, when it was. */
  readonly returnedToSessionId: string
  readonly conflictWithId: string
  readonly confidence: number
  readonly importance: number
  readonly reviewNote: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly reviewedAt: string
  readonly expiresAt: string
  /** The checksum of this version of the candidate; a decision made on an older one is refused. */
  readonly checksum: string
}

/** One memory, as a reader sees it. */
export interface MemoryRecordView {
  readonly memoryId: string
  readonly scopeType: string
  readonly scopeId: string
  /** The body of the memory, already redacted. */
  readonly content: string
  readonly status: string
  readonly sourceTrust: string
  readonly sourceRefs: readonly MemorySourceRef[]
  readonly supersedesId: string
  readonly supersededById: string
  readonly conflictWithId: string
  readonly pinned: boolean
  readonly importance: number
  readonly confidence: number
  readonly utility: number
  readonly validFrom: string
  readonly lastVerifiedAt: string
  readonly deprecatedAt: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly nodeId: string
  readonly backendId: string
  /** The checksum of this version of the memory. */
  readonly checksum: string
}

/** One page of candidates. */
export interface MemoryCandidatePage {
  readonly rows: readonly MemoryCandidateView[]
  readonly total: number
}

/** One page of memories. */
export interface MemoryRecordPage {
  readonly rows: readonly MemoryRecordView[]
  readonly total: number
}

/** The answer of an exact read of one memory. */
export type MemoryReadResult =
  | { readonly found: true; readonly memory: MemoryRecordView }
  | { readonly found: false }

/** Why a write or a decision was refused. */
export type MemoryRefusalCode =
  | 'INVALID_SCOPE'
  | 'SCOPE_NOT_PERMITTED'
  | 'UNKNOWN_SCOPE'
  | 'EMPTY_CONTENT'
  | 'CONTENT_TOO_LONG'
  | 'REDACTION_REJECTED'
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_NOT_REVIEWABLE'
  | 'STALE_CANDIDATE'
  | 'GLOBAL_PROMOTION_REFUSED'
  | 'MEMORY_NOT_FOUND'
  | 'MEMORY_NOT_ACTIVE'
  | 'NOT_A_DUPLICATE'
  | 'SCOPE_MISMATCH'
  | 'CONFLICT_ALREADY_OPEN'
  | 'RETURN_LIMIT_REACHED'
  | 'RETURN_NOT_PERMITTED'
  | 'REEVALUATION_NOT_PERMITTED'
  | 'REEVALUATION_LIMIT_REACHED'
  | 'DUPLICATE_CONTENT'
  | 'EVIDENCE_NOT_VERIFIED'
  | 'NOT_PERMITTED'

/**
 * One piece of evidence that a memory was really used.
 *
 * The evidence is a record the control plane holds: a review that was accepted or an Assignment that ended. It is never
 * a sentence an Agent wrote about itself — a claim of use is not a use.
 */
export interface MemoryUseEvidence {
  /** The review the PM accepted. */
  readonly reviewId?: string
  /** The Assignment that ended. */
  readonly assignmentId?: string
}

/** What one credit did to one memory. */
export interface MemoryUseCredit {
  readonly memoryId: string
  /** The usefulness of the memory after the credit. */
  readonly utility: number
  /** How many real uses the memory has had. */
  readonly effectiveUseCount: number
  /** Whether this piece of evidence had already been counted for this memory. */
  readonly alreadyCredited: boolean
}

/** The answer of a credit. */
export type MemoryUseResult =
  | { readonly ok: true; readonly credited: readonly MemoryUseCredit[] }
  | { readonly ok: false; readonly code: MemoryRefusalCode; readonly reason: string }

/** The answer of a dispute. */
export type MemoryDisputeResult =
  | { readonly ok: true; readonly memory: MemoryRecordView }
  | { readonly ok: false; readonly code: MemoryRefusalCode; readonly reason: string }

/**
 * The answer of a proposal.
 *
 * A proposal that is already in the queue is answered with the row only to the caller that may see it: the operator,
 * the memory manager and the Session that proposed it. Another Session is told that the proposal is already there and
 * nothing else — no row, no checksum, no sources and no name of the proposer.
 */
export type MemorySubmitResult =
  | { readonly ok: true; readonly duplicate: false; readonly candidate: MemoryCandidateView }
  | { readonly ok: true; readonly duplicate: true; readonly candidate?: MemoryCandidateView }
  | { readonly ok: false; readonly code: MemoryRefusalCode; readonly reason: string }

/** What a decision did. */
export type MemoryDecisionCode = 'APPROVED' | 'REJECTED' | 'MERGED' | 'CONFLICT_HELD' | 'SUPERSEDED' | 'RETURNED'
  | 'HELD_FOR_HUMAN'

/** The answer of a decision. */
export type MemoryDecisionResult =
  | { readonly ok: true; readonly code: MemoryDecisionCode; readonly candidate: MemoryCandidateView;
      readonly memory?: MemoryRecordView }
  | { readonly ok: false; readonly code: MemoryRefusalCode; readonly reason: string }

/** One request to send a candidate back to the Session that proposed it. */
export interface MemoryReturnRequest {
  /** The caller, as the control plane authenticated it. */
  readonly caller: MemoryCaller
  readonly candidateId: string
  /** The checksum of the candidate as the caller read it. */
  readonly expectedChecksum: string
  /** The Session the candidate goes back to. */
  readonly toSessionId: string
  /** Why the candidate goes back, in words the person may read. */
  readonly reason?: string
}

/** One request to put a candidate into the queue that waits for a person. */
export interface MemoryHoldRequest {
  /** The caller, as the control plane authenticated it. */
  readonly caller: MemoryCaller
  readonly candidateId: string
  /** The checksum of the candidate as the caller read it. */
  readonly expectedChecksum: string
  /** Why a person has to look at it. */
  readonly note?: string
}

/**
 * One request to say a candidate once more.
 *
 * It is the second half of the bounded return: the candidate went back to the Session that proposed it, and that Session
 * says the fact again — with more context, or as it was. The caller is the Session the candidate was sent back to, and
 * the checksum is the version the return captured.
 */
export interface MemoryReevaluationRequest {
  /** The caller, as the control plane authenticated it. */
  readonly caller: MemoryCaller
  readonly candidateId: string
  /** The checksum of the candidate as the passive return captured it. */
  readonly expectedChecksum: string
  /** The body the proposer says now; the old one stays when it says nothing. */
  readonly content?: string
}

/** One proposal: what somebody offered to be remembered. */
export interface MemorySubmitRequest {
  /** The caller, as the control plane authenticated it. */
  readonly caller: MemoryCaller
  /** The body of the proposal. */
  readonly content: string
  /** The scope it is proposed for; it is checked against the caller's authority. */
  readonly scope: { readonly scopeType: string; readonly scopeId: string }
  /** The records it came from. */
  readonly sourceRefs?: readonly SourceRefInput[]
  /** How important the fact is, in `[0, 1]`. */
  readonly importance?: number
}

/** One decision about one candidate. */
export interface MemoryDecisionRequest {
  /** The caller, as the control plane authenticated it. */
  readonly caller: MemoryCaller
  readonly candidateId: string
  readonly decision: MemoryDecisionKind
  /** The checksum of the candidate as the caller read it; a decision on an older version is refused. */
  readonly expectedChecksum: string
  /** The memory the decision is about, for a merge, a conflict or a supersession. */
  readonly memoryId?: string
  /** Why a person decided; it is redacted and kept with the candidate. */
  readonly note?: string
}

/** The statuses a candidate may be decided from. */
const REVIEWABLE: readonly MemoryCandidateStatus[] = ['queued', 'reviewing', 'pending_human_confirm']

/**
 * The memory service of one control plane.
 *
 * It writes candidates and memories, and it reads them back for one caller at a time. It never starts a Session, never
 * asks the node anything and never calls a model.
 */
export class MemoryService {
  private depth = 0

  constructor(private readonly db: DatabaseSync, private readonly host: MemoryHost,
    private readonly onError: (error: unknown) => void = () => {}) {
    this.migrate()
  }

  /**
   * Make sure the tables are there, in the way every other table of this control plane is made.
   *
   * The migration is idempotent and owns no version: a database that already has the tables keeps them, and a database
   * that was opened before this module existed gets them. The tables arrived with this module, so there is no older shape
   * of them to move away from; the only column that was added afterwards is the counter of the re-evaluations, and a
   * database of the earlier shape gets it here.
   */
  private migrate(): void {
    this.db.exec(SCHEMA)
    this.ensureColumn('memory_candidates', 'reevaluations', 'INTEGER NOT NULL DEFAULT 0')
  }

  /**
   * Give a table a column it did not have, once.
   *
   * The table's own columns are the truth: a database that already has the column keeps it, and a database of the older
   * shape gets it and keeps its rows. Nothing else about the table is rewritten.
   */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (columns.some(entry => entry.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  // ─── proposing ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Offer one fact to be remembered.
   *
   * The body is checked before anything is written: it must say something, it must be short enough, and it must carry
   * neither a path nor a secret. The scope is checked against the caller's authority, and the sources are checked
   * against the records the control plane really holds — a source it cannot find taints the fact instead of being
   * quietly dropped.
   *
   * Writing the same proposal twice writes one row: the idempotency key is built from the sources, the body and the
   * scope, and the same body in the same scope is one candidate however many times it is offered.
   */
  submit(request: MemorySubmitRequest): MemorySubmitResult {
    const scope = scopeOf(request.scope.scopeType, request.scope.scopeId)
    if (scope === undefined) {
      return { ok: false, code: 'INVALID_SCOPE',
        reason: 'A memory belongs to the global scope, to one machine or to one project; nothing else is a scope.' }
    }
    const authority = proposalAuthority(request.caller)
    if (!mayPropose(authority, scope)) {
      return { ok: false, code: 'SCOPE_NOT_PERMITTED',
        reason: scope.scopeType === 'user_global'
          ? 'This caller may not state a preference of the person.'
          : `This caller may not state a fact about ${scope.scopeId}.` }
    }
    const known = this.scopeIsKnown(scope)
    if (!known.ok) return { ok: false, code: known.code, reason: known.reason }

    const content = request.content.trim()
    if (content === '') return { ok: false, code: 'EMPTY_CONTENT', reason: 'A memory says something.' }
    if (content.length > MEMORY_CONTENT_LIMIT) {
      return { ok: false, code: 'CONTENT_TOO_LONG',
        reason: `A memory holds at most ${MEMORY_CONTENT_LIMIT} characters.` }
    }
    const leak = leakOf(content)
    if (leak !== undefined) {
      return { ok: false, code: 'REDACTION_REJECTED',
        reason: `The body carries ${leak === 'path' ? 'a path on a machine' : 'a secret'}; a memory may not keep it.` }
    }

    const validated = validateSourceRefs(request.sourceRefs ?? [], (kind, id) => this.host.source(kind, id),
      { operator: request.caller.role === 'operator', scope })
    const foreign = this.foreignSource(validated.refs, request.caller)
    if (foreign !== undefined) {
      return { ok: false, code: 'SCOPE_NOT_PERMITTED', reason: foreign }
    }
    const body = redact(content)
    const fingerprint = contentFingerprint(body, scope)
    const idempotencyKey = candidateIdempotencyKey(validated.refs, fingerprint, scope)
    const now = this.host.now()
    const status = this.statusOfSubmission(scope, validated.trust)
    const provisional = this.isProvisional(request.caller, scope, validated.trust)
    const importance = clamp01(request.importance ?? 0)

    try {
      return this.transaction((): MemorySubmitResult => {
        const written = this.candidateOfIdempotency(idempotencyKey)
        if (written !== undefined) return this.duplicateOf(written, request.caller)
        const same = this.liveCandidateOfFingerprint(scope, fingerprint)
        if (same !== undefined) return this.duplicateOf(same, request.caller)
        const candidateId = this.nextId('candidate', 'cand')
        this.db.prepare(`
          INSERT INTO memory_candidates
            (candidate_id, idempotency_key, scope_type, scope_id, proposed_scope_type, proposed_scope_id,
             content, content_fingerprint, status, source_trust, source_refs, proposed_by_session_id,
             proposed_by_role, provisional_same_session, revision_count, returned_to_session_id, conflict_with_id,
             confidence, importance, review_note, node_id, backend_id, created_at, updated_at, reviewed_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?, '', ?, ?, ?, ?, '', ?)
        `).run(
          candidateId, idempotencyKey, scope.scopeType, scope.scopeId, scope.scopeType, scope.scopeId,
          body, fingerprint, status, validated.trust, JSON.stringify(validated.refs),
          request.caller.sessionId, request.caller.role, provisional ? 1 : 0,
          confidenceOf(validated.trust), importance,
          this.nodeOf(scope), this.host.backendId(), now, now, this.expiryOf(now),
        )
        const stored = this.candidateById(candidateId)
        return { ok: true, candidate: this.candidateView(stored!), duplicate: false }
      })
    } catch (error) {
      this.onError(error)
      return { ok: false, code: 'NOT_PERMITTED', reason: 'The candidate could not be written.' }
    }
  }

  /**
   * The answer to a proposal that is already in the queue.
   *
   * The row is shown to the caller that may see it: the operator, the memory manager and the Session that proposed it.
   * Another Session is told that the proposal is already there and nothing else — not the row, not its checksum, not its
   * sources, and not who proposed it. The rule is the one the scope module holds, so the manager of `P5-4` reads it
   * from the same place.
   */
  private duplicateOf(row: CandidateRow, caller: MemoryCaller): MemorySubmitResult {
    if (!maySeeCandidate(caller, row.row.proposed_by_session_id)) return { ok: true, duplicate: true }
    return { ok: true, duplicate: true, candidate: this.candidateView(row) }
  }

  /**
   * The reason a proposal may not lean on the records it names, when it may not.
   *
   * A reference that names a record of another Project — or of another machine — is refused outright: a PM may not carry
   * a conclusion out of the work it came from, and a Worker may not do it either. The rule is about the records the
   * control plane really holds, not about the words around them: a reference that names no record at all is left to the
   * trust that already follows it, and a reference of the caller's own work is fine.
   */
  private foreignSource(refs: readonly MemorySourceRef[], caller: MemoryCaller): string | undefined {
    for (const ref of refs) {
      if (!ref.verified) continue
      const record = this.host.source(ref.kind, ref.id)
      if (record === undefined) continue
      if (recordWithinCaller(record, caller)) continue
      return 'This proposal leans on a record of another Project or another machine; a fact may not be carried out of '
        + 'the work it came from.'
    }
    return undefined
  }

  /**
   * The state a proposal enters the queue in.
   *
   * The global scope always waits for a person: no path makes a global fact effective without a decision about it. A
   * fact whose sources could not be checked waits too — it is held where a person may look at it, and it may never
   * become a global one.
   */
  private statusOfSubmission(scope: MemoryScope, trust: SourceTrust): MemoryCandidateStatus {
    if (scope.scopeType === 'user_global') return 'pending_human_confirm'
    if (trust === 'external_tainted') return 'pending_human_confirm'
    return 'queued'
  }

  /**
   * Whether a proposal may be read inside the Session that made it while it waits.
   *
   * The mark is open to one case only: a preference the person stated, carried by the Router's own session. It is not a
   * way into the memory table — the proposal is not a memory and has no id there — it is a way for the session that
   * heard the person to use the preference while the decision is still being made. No other session sees it.
   */
  private isProvisional(caller: MemoryCaller, scope: MemoryScope, trust: SourceTrust): boolean {
    return caller.role === 'router' && caller.sessionId !== '' && scope.scopeType === 'user_global'
      && trust === 'operator_explicit'
  }

  // ─── deciding ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Take one decision about one candidate.
   *
   * The decision names the version of the candidate it was made on: a candidate that changed since it was read is
   * refused, so two people cannot decide the same proposal twice out of sight of each other. Every decision and every
   * row it touches happen in one transaction: a candidate that becomes a memory and the memory itself are one fact,
   * not two.
   *
   * The candidate is read inside that same transaction, and so are the checks that decide whether it may be decided
   * about at all: a candidate that another decision moved on while this one was on its way is refused here, and the
   * refusal leaves nothing behind.
   */
  decide(request: MemoryDecisionRequest): MemoryDecisionResult {
    if (request.caller.role !== 'operator' && request.caller.role !== 'manager') {
      return { ok: false, code: 'NOT_PERMITTED',
        reason: 'Only a person at the console, or the memory manager, may decide about a candidate.' }
    }
    try {
      return this.transaction((): MemoryDecisionResult => {
        const candidate = this.candidateById(request.candidateId)
        if (candidate === undefined) {
          return { ok: false, code: 'CANDIDATE_NOT_FOUND', reason: 'There is no such candidate.' }
        }
        if (candidate.checksum !== request.expectedChecksum) {
          return { ok: false, code: 'STALE_CANDIDATE',
            reason: 'This candidate changed since it was read; read it again before deciding about it.' }
        }
        if (!REVIEWABLE.includes(candidate.row.status as MemoryCandidateStatus)) {
          return { ok: false, code: 'CANDIDATE_NOT_REVIEWABLE',
            reason: `This candidate is ${candidate.row.status} and waits for no decision.` }
        }
        const refused = this.refusalOf(candidate, request)
        if (refused !== undefined) return refused
        if (request.decision === 'approve') return this.approve(candidate, request)
        if (request.decision === 'reject') return this.reject(candidate, request)
        if (request.decision === 'merge') return this.merge(candidate, request)
        if (request.decision === 'conflict') return this.holdConflict(candidate, request)
        return this.supersede(candidate, request)
      })
    } catch (error) {
      this.onError(error)
      return { ok: false, code: 'NOT_PERMITTED', reason: 'The decision could not be written.' }
    }
  }

  /**
   * The rules a decision has to pass before it touches anything.
   *
   * **A candidate that waits for a person is decided by a person.** The memory manager reviews, but a fact that waits
   * for a human confirmation becomes effective only when a human says so: it may not be approved, merged, superseded
   * or held against another memory by anybody else. Sending it back is not an activation, and it stays open to the
   * manager.
   *
   * **A fact that came from outside never touches the global scope.** It may not create a global memory, merge into
   * one, replace one or hold a conflict against one: a fact nobody could verify does not get to change what the person
   * believes everywhere, and it does not get to push an existing global memory down either. The global scope stays as
   * it was.
   */
  private refusalOf(candidate: CandidateRow, request: MemoryDecisionRequest): MemoryDecisionResult | undefined {
    if (candidate.row.status === 'pending_human_confirm' && request.caller.role !== 'operator'
      && request.decision !== 'reject') {
      return { ok: false, code: 'NOT_PERMITTED',
        reason: 'This candidate waits for a person; only the operator may decide about it.' }
    }
    const scope = this.scopeOfRow(candidate.row.scope_type, candidate.row.scope_id)
    if (scope.scopeType === 'user_global' && candidate.row.source_trust === 'external_tainted'
      && request.decision !== 'reject') {
      return { ok: false, code: 'GLOBAL_PROMOTION_REFUSED',
        reason: 'A fact that came from outside may not become a global one; it may be held or kept inside its own scope.' }
    }
    return undefined
  }

  /**
   * The decision that makes a candidate a memory.
   *
   * A global fact may only be written from the person's own words or from a conclusion the control plane confirmed; a
   * fact that came from outside is refused here and stays where it is. A candidate whose body is already a memory of the
   * same scope is not written twice: the existing memory takes the new source and the candidate is a duplicate.
   */
  private approve(candidate: CandidateRow, request: MemoryDecisionRequest): MemoryDecisionResult {
    const scope = this.scopeOfRow(candidate.row.scope_type, candidate.row.scope_id)
    if (scope.scopeType === 'user_global' && candidate.row.source_trust === 'external_tainted') {
      return { ok: false, code: 'GLOBAL_PROMOTION_REFUSED',
        reason: 'A fact that came from outside may not become a global one; it may be held or kept inside its own scope.' }
    }
    const existing = this.liveMemoryOfFingerprint(scope, candidate.row.content_fingerprint)
    if (existing !== undefined) {
      if (existing.row.status === 'conflict_pending') {
        return { ok: false, code: 'CONFLICT_ALREADY_OPEN',
          reason: 'That memory is held by a conflict; settle the conflict before deciding about this candidate.' }
      }
      this.mergeInto(existing, candidate.row)
      const merged = this.memoryById(existing.row.memory_id)
      const updated = this.markCandidate(candidate.row, 'duplicate', request.note)
      return { ok: true, code: 'MERGED', candidate: this.candidateView(updated), memory: this.memoryView(merged!) }
    }
    const now = this.host.now()
    const memoryId = this.nextId('memory', 'mem')
    this.db.prepare(`
      INSERT INTO long_term_memories
        (memory_id, scope_type, scope_id, content, content_fingerprint, status, source_trust, source_refs,
         supersedes_id, superseded_by_id, conflict_with_id, pinned, importance, confidence, utility,
         exposure_count, effective_use_count, disputed_count, valid_from, last_verified_at, deprecated_at,
         created_at, updated_at, node_id, backend_id)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '', '', '', 0, ?, ?, 0, 0, 0, 0, ?, ?, '', ?, ?, ?, ?)
    `).run(
      memoryId, candidate.row.scope_type, candidate.row.scope_id, candidate.row.content,
      candidate.row.content_fingerprint, candidate.row.source_trust, candidate.row.source_refs,
      candidate.row.importance, confidenceOf(candidate.row.source_trust as SourceTrust),
      now, now, now, now, this.nodeOf(scope), this.host.backendId(),
    )
    const updated = this.markCandidate(candidate.row, 'active', request.note)
    const memory = this.memoryById(memoryId)
    return { ok: true, code: 'APPROVED', candidate: this.candidateView(updated), memory: this.memoryView(memory!) }
  }

  /** The decision that ends a candidate without a memory. */
  private reject(candidate: CandidateRow, request: MemoryDecisionRequest): MemoryDecisionResult {
    const updated = this.markCandidate(candidate.row, 'rejected', request.note)
    return { ok: true, code: 'REJECTED', candidate: this.candidateView(updated) }
  }

  /**
   * The decision that says a candidate repeats a memory that is already there.
   *
   * The memory is not written again: it takes the new source, its last verification is refreshed and its confidence
   * rises a little. The candidate is a duplicate, and no memory row is created for it.
   */
  private merge(candidate: CandidateRow, request: MemoryDecisionRequest): MemoryDecisionResult {
    const target = this.memoryNamedBy(request)
    if (target === undefined) return { ok: false, code: 'MEMORY_NOT_FOUND', reason: 'There is no such memory.' }
    if (target.row.status !== 'active' && target.row.status !== 'conflict_pending') {
      return { ok: false, code: 'MEMORY_NOT_ACTIVE',
        reason: `This memory is ${target.row.status} and takes no new source.` }
    }
    if (target.row.scope_type !== candidate.row.scope_type || target.row.scope_id !== candidate.row.scope_id) {
      return { ok: false, code: 'SCOPE_MISMATCH',
        reason: 'That memory belongs to another scope, so this candidate does not repeat it.' }
    }
    if (target.row.content_fingerprint !== candidate.row.content_fingerprint) {
      return { ok: false, code: 'NOT_A_DUPLICATE',
        reason: 'That memory says something else, so this candidate does not repeat it.' }
    }
    this.mergeInto(target, candidate.row)
    const merged = this.memoryById(target.row.memory_id)!
    const updated = this.markCandidate(candidate.row, 'duplicate', request.note)
    return { ok: true, code: 'MERGED', candidate: this.candidateView(updated), memory: this.memoryView(merged) }
  }

  /**
   * The decision that holds a candidate and a memory apart because they contradict each other.
   *
   * Both ends leave the trusted view while the conflict is open, and the conflict itself is recorded: it may be raised
   * once. Raising it again for the same pair is refused rather than answered twice.
   *
   * The two ends have to be of the same scope before anything is touched: a conflict is between two sayings about the
   * same thing, and a candidate of one scope may not pull a memory of another scope out of the trusted view.
   */
  private holdConflict(candidate: CandidateRow, request: MemoryDecisionRequest): MemoryDecisionResult {
    const target = this.memoryNamedBy(request)
    if (target === undefined) return { ok: false, code: 'MEMORY_NOT_FOUND', reason: 'There is no such memory.' }
    if (target.row.scope_type !== candidate.row.scope_type || target.row.scope_id !== candidate.row.scope_id) {
      return { ok: false, code: 'SCOPE_MISMATCH',
        reason: 'That memory belongs to another scope, so this candidate does not contradict it.' }
    }
    if (target.row.status === 'conflict_pending') {
      return { ok: false, code: 'CONFLICT_ALREADY_OPEN',
        reason: 'That memory is already held by a conflict.' }
    }
    if (target.row.status !== 'active') {
      return { ok: false, code: 'MEMORY_NOT_ACTIVE',
        reason: `This memory is ${target.row.status} and takes no conflict.` }
    }
    const open = this.db.prepare(
      "SELECT conflict_id FROM memory_conflicts WHERE memory_id = ? AND candidate_id = ? AND state = 'open'")
      .get(target.row.memory_id, candidate.row.candidate_id) as { conflict_id: string } | undefined
    if (open !== undefined) {
      return { ok: false, code: 'CONFLICT_ALREADY_OPEN',
        reason: 'This candidate and that memory are already held by a conflict.' }
    }
    const now = this.host.now()
    this.db.prepare(`
      INSERT INTO memory_conflicts (conflict_id, memory_id, candidate_id, other_memory_id, reason, state, created_at, resolved_at)
      VALUES (?, ?, ?, '', ?, 'open', ?, '')
    `).run(this.nextId('conflict', 'conf'), target.row.memory_id, candidate.row.candidate_id,
      bounded(request.note ?? ''), now)
    this.db.prepare('UPDATE long_term_memories SET status = ?, conflict_with_id = ?, updated_at = ? WHERE memory_id = ?')
      .run('conflict_pending', candidate.row.candidate_id, now, target.row.memory_id)
    const updated = this.markCandidate(candidate.row, 'conflict_pending', request.note)
    const memory = this.memoryById(target.row.memory_id)!
    return { ok: true, code: 'CONFLICT_HELD', candidate: this.candidateView(updated), memory: this.memoryView(memory) }
  }

  /**
   * The decision that says a fact changed and the newer one takes its place.
   *
   * The new memory names the one it replaces, and the one it replaces is marked as superseded with the moment it was
   * deprecated. Both rows change in one transaction: there is no moment in which two memories of the same scope say
   * the same thing, and the old one keeps its own history.
   */
  private supersede(candidate: CandidateRow, request: MemoryDecisionRequest): MemoryDecisionResult {
    const target = this.memoryNamedBy(request)
    if (target === undefined) return { ok: false, code: 'MEMORY_NOT_FOUND', reason: 'There is no such memory.' }
    if (target.row.status !== 'active' && target.row.status !== 'conflict_pending') {
      return { ok: false, code: 'MEMORY_NOT_ACTIVE',
        reason: `This memory is ${target.row.status} and may not be replaced.` }
    }
    if (target.row.scope_type !== candidate.row.scope_type || target.row.scope_id !== candidate.row.scope_id) {
      return { ok: false, code: 'SCOPE_MISMATCH',
        reason: 'That memory belongs to another scope, so it may not be replaced by this candidate.' }
    }
    const now = this.host.now()
    const memoryId = this.nextId('memory', 'mem')
    this.db.prepare(`
      INSERT INTO long_term_memories
        (memory_id, scope_type, scope_id, content, content_fingerprint, status, source_trust, source_refs,
         supersedes_id, superseded_by_id, conflict_with_id, pinned, importance, confidence, utility,
         exposure_count, effective_use_count, disputed_count, valid_from, last_verified_at, deprecated_at,
         created_at, updated_at, node_id, backend_id)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, '', '', 0, ?, ?, 0, 0, 0, 0, ?, ?, '', ?, ?, ?, ?)
    `).run(
      memoryId, candidate.row.scope_type, candidate.row.scope_id, candidate.row.content,
      candidate.row.content_fingerprint, candidate.row.source_trust, candidate.row.source_refs, target.row.memory_id,
      candidate.row.importance, confidenceOf(candidate.row.source_trust as SourceTrust),
      now, now, now, now, this.nodeOf(this.scopeOfRow(candidate.row.scope_type, candidate.row.scope_id)),
      this.host.backendId(),
    )
    this.db.prepare(
      "UPDATE long_term_memories SET status = 'superseded', deprecated_at = ?, superseded_by_id = ?, updated_at = ? WHERE memory_id = ?")
      .run(now, memoryId, now, target.row.memory_id)
    this.db.prepare("UPDATE memory_conflicts SET state = 'resolved_supersede', resolved_at = ? WHERE memory_id = ? AND state = 'open'")
      .run(now, target.row.memory_id)
    const updated = this.markCandidate(candidate.row, 'superseded', request.note)
    const memory = this.memoryById(memoryId)!
    return { ok: true, code: 'SUPERSEDED', candidate: this.candidateView(updated), memory: this.memoryView(memory) }
  }

  /** The memory a decision names, when it names one that exists. */
  private memoryNamedBy(request: MemoryDecisionRequest): MemoryRow | undefined {
    const memoryId = request.memoryId ?? ''
    if (memoryId === '') return undefined
    return this.memoryById(memoryId)
  }

  /** The scope a row names, as the scope the service works with. */
  private scopeOfRow(scopeType: string, scopeId: string): MemoryScope {
    return scopeOf(scopeType, scopeId) ?? { scopeType: scopeType as MemoryScope['scopeType'], scopeId }
  }

  /**
   * One memory takes the source of a candidate that repeats it.
   *
   * The body is not written again, the last verification is refreshed and the confidence rises a little — never by more
   * than a step, and never above one.
   */
  private mergeInto(target: MemoryRow, candidate: CandidateFields): void {
    const now = this.host.now()
    const refs = mergeRefs(parseSourceRefs(target.row.source_refs), parseSourceRefs(candidate.source_refs))
    this.db.prepare(
      'UPDATE long_term_memories SET source_refs = ?, last_verified_at = ?, confidence = ?, updated_at = ? WHERE memory_id = ?')
      .run(JSON.stringify(refs), now, Math.min(1, target.row.confidence + CONFIDENCE_STEP), now, target.row.memory_id)
  }

  /** One candidate's new state, with the moment it was decided and the reason a person gave. */
  private markCandidate(candidate: CandidateFields, status: MemoryCandidateStatus, note: string | undefined): CandidateRow {
    const now = this.host.now()
    this.db.prepare(
      "UPDATE memory_candidates SET status = ?, reviewed_at = ?, updated_at = ?, review_note = ? WHERE candidate_id = ?")
      .run(status, now, now, bounded(note ?? ''), candidate.candidate_id)
    return this.candidateById(candidate.candidate_id)!
  }

  // ─── the queue's own clock ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The candidates that waited too long.
   *
   * A candidate nobody decided about keeps its row and its history; it only changes its state, so that the queue shows
   * that it is cold rather than dropping it silently.
   */
  expireStaleCandidates(): number {
    const now = this.host.now()
    try {
      return this.transaction(() => {
        const result = this.db.prepare(
          "UPDATE memory_candidates SET status = 'expired_candidate', updated_at = ? WHERE status IN ('queued', 'pending_human_confirm') AND expires_at != '' AND expires_at < ?")
          .run(now, now)
        return Number(result.changes)
      })
    } catch (error) {
      this.onError(error)
      return 0
    }
  }

  // ─── reading ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The queue of candidates, as one caller reads it.
   *
   * The operator reads the whole queue. A Session reads only the candidates it proposed itself: another Session's
   * pending work is not shown to it, and neither is the queue of the memory manager.
   */
  listCandidates(caller: MemoryCaller, options: { status?: string; limit?: number } = {}): MemoryCandidatePage {
    const limit = this.limitOf(options.limit)
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (caller.role !== 'operator' && caller.role !== 'manager') {
      clauses.push('proposed_by_session_id = ?')
      params.push(caller.sessionId)
    }
    if (options.status !== undefined && options.status !== '') {
      clauses.push('status = ?')
      params.push(options.status)
    }
    const where = clauses.length === 0 ? '1 = 1' : clauses.join(' AND ')
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS total FROM memory_candidates WHERE ${where}`)
      .get(...params) as { total: number }).total)
    const rows = this.db.prepare(
      `SELECT * FROM memory_candidates WHERE ${where} ORDER BY created_at DESC, seq DESC LIMIT ?`)
      .all(...params, limit) as Record<string, SQLInputValue>[]
    return { rows: rows.map(row => this.candidateView(candidateOf(row))), total }
  }

  /**
   * The memories, as one caller reads them.
   *
   * The list a caller sees by default holds the memories that are in force: the ones that may still be recalled. The
   * scope is applied in the SQL, so a memory of another project is neither counted nor shown.
   */
  listMemories(caller: MemoryCaller, options: { status?: string; limit?: number; includeInactive?: boolean } = {}):
    MemoryRecordPage {
    const limit = this.limitOf(options.limit)
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    const scope = this.scopeClause(allowedScopes(caller))
    if (scope !== undefined) {
      clauses.push(scope.sql)
      params.push(...scope.params)
    }
    if (options.status !== undefined && options.status !== '') {
      clauses.push('status = ?')
      params.push(options.status)
    } else if (options.includeInactive !== true) {
      clauses.push("status = 'active'")
    }
    const where = clauses.length === 0 ? '1 = 1' : clauses.join(' AND ')
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS total FROM long_term_memories WHERE ${where}`)
      .get(...params) as { total: number }).total)
    const rows = this.db.prepare(
      `SELECT * FROM long_term_memories WHERE ${where} ORDER BY pinned DESC, updated_at DESC, seq DESC LIMIT ?`)
      .all(...params, limit) as Record<string, SQLInputValue>[]
    return { rows: rows.map(row => this.memoryView(memoryOf(row))), total }
  }

  /**
   * One memory, read by its id.
   *
   * A memory that is not in force is not there as far as this read is concerned, and an id that was never given is
   * answered in exactly the same way: the answer does not say whether the id ever existed.
   */
  readMemory(caller: MemoryCaller, memoryId: string, options: { includeInactive?: boolean } = {}): MemoryReadResult {
    const row = this.memoryById(memoryId)
    if (row === undefined) return { found: false }
    if (row.row.status !== 'active' && options.includeInactive !== true) return { found: false }
    const scope = this.scopeClause(allowedScopes(caller))
    if (scope !== undefined) {
      const outOfScope = this.db.prepare(`SELECT 1 FROM long_term_memories WHERE memory_id = ? AND ${scope.sql}`)
        .get(memoryId, ...scope.params) === undefined
      if (outOfScope) return { found: false }
    }
    return { found: true, memory: this.memoryView(row) }
  }

  /**
   * One candidate, read by its id.
   *
   * The queue of the operator and of the memory manager is the whole queue; a Session reads only the candidate it
   * proposed itself. An id that names no candidate is answered in exactly the same way as one that does: the answer does
   * not say whether the id ever existed.
   */
  readCandidate(caller: MemoryCaller, candidateId: string): { found: true; candidate: MemoryCandidateView } | { found: false } {
    const row = this.candidateById(candidateId)
    if (row === undefined) return { found: false }
    if (!maySeeCandidate(caller, row.row.proposed_by_session_id)) return { found: false }
    return { found: true, candidate: this.candidateView(row) }
  }

  /**
   * The memories of one scope, and of no other.
   *
   * The memory manager reviews one candidate at a time, and what it may compare that candidate against is the scope the
   * candidate is about: a project fact is compared with the project's own memories, never with another project's. The
   * scope is named by the caller of the review, which is the control plane itself and not the request.
   */
  listMemoriesInScope(scope: MemoryScope, options: { status?: string; limit?: number } = {}): MemoryRecordPage {
    const limit = this.limitOf(options.limit)
    const clauses = ['scope_type = ?', 'scope_id = ?']
    const params: SQLInputValue[] = [scope.scopeType, scope.scopeId]
    if (options.status !== undefined && options.status !== '') {
      clauses.push('status = ?')
      params.push(options.status)
    } else {
      clauses.push("status IN ('active', 'conflict_pending')")
    }
    const where = clauses.join(' AND ')
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS total FROM long_term_memories WHERE ${where}`)
      .get(...params) as { total: number }).total)
    const rows = this.db.prepare(
      `SELECT * FROM long_term_memories WHERE ${where} ORDER BY pinned DESC, updated_at DESC, seq DESC LIMIT ?`)
      .all(...params, limit) as Record<string, SQLInputValue>[]
    return { rows: rows.map(row => this.memoryView(memoryOf(row))), total }
  }

  /**
   * Send one candidate back to the Session that proposed it.
   *
   * The request is passive: the candidate remembers that it was sent back and to whom, and nobody is woken. The Session
   * that proposed it may read the request when it is running on its own business, and a Session an operator stopped, a
   * paused Project or an ended Session keeps the request waiting until a person brings it back.
   *
   * One candidate is sent back at most once: a second request about the same proposal is refused, and the candidate then
   * waits for a person instead of going round again.
   */
  returnCandidate(request: MemoryReturnRequest): MemoryDecisionResult {
    if (request.caller.role !== 'operator' && request.caller.role !== 'manager') {
      return { ok: false, code: 'NOT_PERMITTED',
        reason: 'Only a person at the console, or the memory manager, may send a candidate back.' }
    }
    try {
      return this.transaction((): MemoryDecisionResult => {
        const candidate = this.candidateById(request.candidateId)
        if (candidate === undefined) {
          return { ok: false, code: 'CANDIDATE_NOT_FOUND', reason: 'There is no such candidate.' }
        }
        if (candidate.checksum !== request.expectedChecksum) {
          return { ok: false, code: 'STALE_CANDIDATE',
            reason: 'This candidate changed since it was read; read it again before deciding about it.' }
        }
        if (!REVIEWABLE.includes(candidate.row.status as MemoryCandidateStatus)) {
          return { ok: false, code: 'CANDIDATE_NOT_REVIEWABLE',
            reason: `This candidate is ${candidate.row.status} and waits for no decision.` }
        }
        if (candidate.row.revision_count >= MEMORY_RETURN_LIMIT) {
          return { ok: false, code: 'RETURN_LIMIT_REACHED',
            reason: 'This candidate was already sent back once; it waits for a person now.' }
        }
        const now = this.host.now()
        this.db.prepare(
          "UPDATE memory_candidates SET status = 'reviewing', revision_count = revision_count + 1, "
          + 'returned_to_session_id = ?, review_note = ?, updated_at = ? WHERE candidate_id = ?')
          .run(bounded(request.toSessionId), bounded(request.reason ?? ''), now, candidate.row.candidate_id)
        const updated = this.candidateById(candidate.row.candidate_id)!
        return { ok: true, code: 'RETURNED', candidate: this.candidateView(updated) }
      })
    } catch (error) {
      this.onError(error)
      return { ok: false, code: 'NOT_PERMITTED', reason: 'The candidate could not be sent back.' }
    }
  }

  /**
   * Say one candidate once more.
   *
   * This is the second half of the bounded return: a candidate the manager could not judge went back to the Session that
   * proposed it, and that Session may say the fact again — with more context, or as it was — and the same candidate goes
   * back into the queue for a review. It is the same candidate and never a new one: the id, the scope, the sources, the
   * trust and the proposer stay what they were, and only the body may change.
   *
   * The bound is one. A candidate goes round once: the proposer says it once more and the manager reviews that version; a
   * second round waits for a person. The caller must be the Session the candidate was sent back to, the version it acts on
   * must be the one the return captured, and the caller must still hold the authority over the scope it speaks about.
   */
  reevaluate(request: MemoryReevaluationRequest): MemorySubmitResult {
    try {
      return this.transaction((): MemorySubmitResult => {
        const candidate = this.candidateById(request.candidateId)
        if (candidate === undefined) {
          return { ok: false, code: 'CANDIDATE_NOT_FOUND', reason: 'There is no such candidate.' }
        }
        if (candidate.row.status !== 'reviewing') {
          return { ok: false, code: 'CANDIDATE_NOT_REVIEWABLE',
            reason: `This candidate is ${candidate.row.status} and waits for no re-evaluation.` }
        }
        if (candidate.row.returned_to_session_id !== request.caller.sessionId
          || candidate.row.proposed_by_session_id !== request.caller.sessionId) {
          return { ok: false, code: 'REEVALUATION_NOT_PERMITTED',
            reason: 'Only the Session that proposed this candidate may say it once more.' }
        }
        if (candidate.checksum !== request.expectedChecksum) {
          return { ok: false, code: 'STALE_CANDIDATE',
            reason: 'This candidate changed since it was sent back; read it again before saying it once more.' }
        }
        if (candidate.row.reevaluations >= MEMORY_REEVALUATION_LIMIT) {
          return { ok: false, code: 'REEVALUATION_LIMIT_REACHED',
            reason: 'This candidate was already said once more; it waits for a person now.' }
        }
        const scope = this.scopeOfRow(candidate.row.scope_type, candidate.row.scope_id)
        if (!mayPropose(proposalAuthority(request.caller), scope)) {
          return { ok: false, code: 'SCOPE_NOT_PERMITTED',
            reason: `This caller may not state a fact about ${scope.scopeId}.` }
        }
        let body = candidate.row.content
        let fingerprint = candidate.row.content_fingerprint
        let idempotencyKey = candidate.row.idempotency_key
        if (request.content !== undefined) {
          const text = request.content.trim()
          if (text === '') return { ok: false, code: 'EMPTY_CONTENT', reason: 'A memory says something.' }
          if (text.length > MEMORY_CONTENT_LIMIT) {
            return { ok: false, code: 'CONTENT_TOO_LONG',
              reason: `A memory holds at most ${MEMORY_CONTENT_LIMIT} characters.` }
          }
          const leak = leakOf(text)
          if (leak !== undefined) {
            return { ok: false, code: 'REDACTION_REJECTED',
              reason: `The body carries ${leak === 'path' ? 'a path on a machine' : 'a secret'}; a memory may not keep it.` }
          }
          const redacted = redact(text)
          if (redacted !== candidate.row.content) {
            body = redacted
            fingerprint = contentFingerprint(body, scope)
            idempotencyKey = candidateIdempotencyKey(parseSourceRefs(candidate.row.source_refs), fingerprint, scope)
            // The same words are one row: another candidate of this scope that already says them, and another row that
            // already answers to them, both refuse the second writing.
            const same = this.liveCandidateOfFingerprint(scope, fingerprint)
            if (same !== undefined && same.row.candidate_id !== candidate.row.candidate_id) {
              return { ok: false, code: 'DUPLICATE_CONTENT',
                reason: 'Another candidate of this scope already says that; it is not written twice.' }
            }
            const written = this.candidateOfIdempotency(idempotencyKey)
            if (written !== undefined && written.row.candidate_id !== candidate.row.candidate_id) {
              return { ok: false, code: 'DUPLICATE_CONTENT',
                reason: 'This proposal is already in the queue; it is not written twice.' }
            }
          }
        }
        const now = this.host.now()
        // The candidate goes back into the queue it came from: a fact about the person, or one nobody could check, waits
        // for a person again — saying it once more does not make it a fact the manager may judge.
        const status = this.statusOfSubmission(scope, candidate.row.source_trust as SourceTrust)
        this.db.prepare(`
          UPDATE memory_candidates
            SET content = ?, content_fingerprint = ?, idempotency_key = ?, status = ?,
                reevaluations = reevaluations + 1, updated_at = ?
            WHERE candidate_id = ?
        `).run(body, fingerprint, idempotencyKey, status, now, candidate.row.candidate_id)
        const updated = this.candidateById(candidate.row.candidate_id)!
        return { ok: true, duplicate: false, candidate: this.candidateView(updated) }
      })
    } catch (error) {
      this.onError(error)
      return { ok: false, code: 'NOT_PERMITTED', reason: 'The candidate could not be said once more.' }
    }
  }

  /**
   * Put one candidate into the queue that waits for a person.
   *
   * This is where a case the manager cannot judge ends up: a fact that only a person may confirm, a candidate that went
   * round once already, or one whose sources cannot be checked. It is not a decision and it does not make a fact
   * effective — it only says that a person has to look at it.
   */
  holdForHuman(request: MemoryHoldRequest): MemoryDecisionResult {
    if (request.caller.role !== 'operator' && request.caller.role !== 'manager') {
      return { ok: false, code: 'NOT_PERMITTED',
        reason: 'Only a person at the console, or the memory manager, may hold a candidate for a person.' }
    }
    try {
      return this.transaction((): MemoryDecisionResult => {
        const candidate = this.candidateById(request.candidateId)
        if (candidate === undefined) {
          return { ok: false, code: 'CANDIDATE_NOT_FOUND', reason: 'There is no such candidate.' }
        }
        if (candidate.checksum !== request.expectedChecksum) {
          return { ok: false, code: 'STALE_CANDIDATE',
            reason: 'This candidate changed since it was read; read it again before deciding about it.' }
        }
        if (!REVIEWABLE.includes(candidate.row.status as MemoryCandidateStatus)) {
          return { ok: false, code: 'CANDIDATE_NOT_REVIEWABLE',
            reason: `This candidate is ${candidate.row.status} and waits for no decision.` }
        }
        const updated = this.markCandidate(candidate.row, 'pending_human_confirm', request.note)
        return { ok: true, code: 'HELD_FOR_HUMAN', candidate: this.candidateView(updated) }
      })
    } catch (error) {
      this.onError(error)
      return { ok: false, code: 'NOT_PERMITTED', reason: 'The candidate could not be held.' }
    }
  }

  /**
   * The proposals one Session may read while they wait.
   *
   * These are the proposals the person made in that Session and that Session alone may use until a decision is made.
   * Another Session's waiting proposals are not here, and none of these is a memory: they have no id in the memory
   * table and take no part in any recall.
   */
  provisionalFor(sessionId: string): readonly MemoryCandidateView[] {
    if (sessionId === '') return []
    const rows = this.db.prepare(
      "SELECT * FROM memory_candidates WHERE provisional_same_session = 1 AND proposed_by_session_id = ? AND status IN ('queued', 'reviewing', 'pending_human_confirm') ORDER BY created_at DESC")
      .all(sessionId) as Record<string, SQLInputValue>[]
    return rows.map(row => this.candidateView(candidateOf(row)))
  }

  // ─── what a memory was worth ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Write down that a memory was shown to somebody.
   *
   * An exposure is a count and nothing else. It says how often a memory was in front of somebody, and it may not make
   * the memory more useful than it was: a memory that was read often would otherwise keep itself alive by being read,
   * and a fact nobody ever used would look as good as a fact that carried a whole Project.
   */
  recordExposure(caller: MemoryCaller, memoryIds: readonly string[]): number {
    const scopes = allowedScopes(caller)
    let written = 0
    for (const memoryId of memoryIds) {
      if (memoryId === '') continue
      const row = this.memoryById(memoryId)
      if (row === undefined || row.row.status !== 'active') continue
      if (!this.withinScopes(row.row, scopes)) continue
      this.db.prepare('UPDATE long_term_memories SET exposure_count = exposure_count + 1 WHERE memory_id = ?')
        .run(memoryId)
      written += 1
    }
    return written
  }

  /**
   * Write down that a memory was really used.
   *
   * A memory becomes more useful only when the control plane can show that it was used: an Assignment that ended or a
   * review that was accepted. The evidence is looked up in the records the control plane itself holds — a sentence an
   * Agent wrote about itself is not evidence, and a memory that was never injected is not used either.
   *
   * The credit is written once per piece of evidence: the same accepted review does not count twice, not after a
   * restart and not after a retry. The usefulness grows towards its bound and never past it, so a fact that was used
   * many times is worth more than one that was used once and no more than one that was used a thousand times.
   */
  creditEffectiveUse(request: { readonly memoryIds: readonly string[];
    readonly evidence: MemoryUseEvidence }): MemoryUseResult {
    const evidence = this.evidenceOf(request.evidence)
    if (evidence === undefined) {
      return { ok: false, code: 'EVIDENCE_NOT_VERIFIED',
        reason: 'A memory becomes more useful only when the control plane can show that it was used: name a review that '
          + 'was accepted or an Assignment that ended.' }
    }
    const credited: MemoryUseCredit[] = []
    try {
      this.transaction((): void => {
        for (const memoryId of request.memoryIds) {
          const row = this.memoryById(memoryId)
          if (row === undefined || row.row.status !== 'active') continue
          if (!this.withinEvidence(row.row, evidence)) continue
          const counted = row.row.effective_use_count
          const already = this.db.prepare(
            'SELECT credit_id FROM memory_use_credits WHERE memory_id = ? AND evidence_key = ?')
            .get(memoryId, evidence.key) as { credit_id: string } | undefined
          if (already !== undefined) {
            credited.push({ memoryId, utility: row.row.utility, effectiveUseCount: counted, alreadyCredited: true })
            continue
          }
          const count = counted + 1
          const utility = Math.min(MEMORY_UTILITY_MAX,
            MEMORY_UTILITY_MAX * (1 - Math.exp(-MEMORY_UTILITY_RATE * count)))
          const now = this.host.now()
          this.db.prepare(
            'UPDATE long_term_memories SET effective_use_count = ?, utility = ?, last_verified_at = ?, updated_at = ? '
            + 'WHERE memory_id = ?').run(count, utility, now, now, memoryId)
          this.db.prepare(
            'INSERT INTO memory_use_credits (credit_id, memory_id, evidence_key, evidence_kind, evidence_id, utility, at) '
            + 'VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(`credit-${randomUUID()}`, memoryId, evidence.key, evidence.kind, evidence.id, utility, now)
          credited.push({ memoryId, utility, effectiveUseCount: count, alreadyCredited: false })
        }
      })
    } catch (error) {
      this.onError(error)
      return { ok: false, code: 'NOT_PERMITTED', reason: 'The credit could not be written.' }
    }
    return { ok: true, credited }
  }

  /**
   * Write down that a memory misled somebody.
   *
   * A person at the console says so, and the memory answers for it: its confidence falls by a step, the number of
   * disputes grows, and a memory whose confidence falls under the floor waits for somebody to look at it again instead
   * of being injected on its own.
   */
  disputeMemory(request: { readonly caller: MemoryCaller; readonly memoryId: string; readonly reason?: string }):
    MemoryDisputeResult {
    if (request.caller.role !== 'operator') {
      return { ok: false, code: 'NOT_PERMITTED',
        reason: 'Only a person at the console may mark a memory as misleading.' }
    }
    const row = this.memoryById(request.memoryId)
    if (row === undefined) return { ok: false, code: 'MEMORY_NOT_FOUND', reason: 'There is no such memory.' }
    if (row.row.status !== 'active') {
      return { ok: false, code: 'MEMORY_NOT_ACTIVE',
        reason: `This memory is ${row.row.status} and takes no dispute.` }
    }
    try {
      this.transaction(() => {
        const confidence = Math.max(0, row.row.confidence - MEMORY_DISPUTE_STEP)
        const status = confidence < MEMORY_CONFIDENCE_FLOOR ? 'needs_reverify' : row.row.status
        const now = this.host.now()
        this.db.prepare(
          'UPDATE long_term_memories SET disputed_count = disputed_count + 1, confidence = ?, status = ?, updated_at = ? '
          + 'WHERE memory_id = ?').run(confidence, status, now, request.memoryId)
        this.db.prepare(
          'INSERT INTO memory_disputes (dispute_id, memory_id, reason, confidence, at) VALUES (?, ?, ?, ?, ?)')
          .run(`dispute-${randomUUID()}`, request.memoryId, bounded(request.reason ?? ''), confidence, now)
      })
    } catch (error) {
      this.onError(error)
      return { ok: false, code: 'NOT_PERMITTED', reason: 'The dispute could not be written.' }
    }
    return { ok: true, memory: this.memoryView(this.memoryById(request.memoryId)!) }
  }

  /**
   * The evidence a credit leans on, when the control plane really holds it.
   *
   * A review that was accepted and an Assignment that ended are conclusions; a review that is still waiting and an
   * Assignment that is still running are not. The record itself is the authority — never a sentence anybody wrote
   * about the work.
   */
  private evidenceOf(evidence: MemoryUseEvidence):
    { readonly key: string; readonly kind: string; readonly id: string; readonly projectId: string } | undefined {
    if (evidence.reviewId !== undefined && evidence.reviewId !== '') {
      const record = this.host.source('review', evidence.reviewId)
      if (record === undefined || !record.authoritative) return undefined
      return { key: `review:${evidence.reviewId}`, kind: 'review', id: evidence.reviewId,
        projectId: record.projectId ?? '' }
    }
    if (evidence.assignmentId !== undefined && evidence.assignmentId !== '') {
      const record = this.host.source('assignment', evidence.assignmentId)
      if (record === undefined || !record.authoritative) return undefined
      return { key: `assignment:${evidence.assignmentId}`, kind: 'assignment', id: evidence.assignmentId,
        projectId: record.projectId ?? '' }
    }
    return undefined
  }

  /**
   * Whether a memory may be credited by a piece of evidence.
   *
   * A fact about the person may be credited by any work; a fact about a Project only by the work of that Project.
   */
  private withinEvidence(row: MemoryFields, evidence: { readonly projectId: string }): boolean {
    if (row.scope_type === 'user_global') return true
    if (evidence.projectId === '') return false
    if (row.scope_type !== 'project') return false
    return row.scope_id === projectScope(evidence.projectId).scopeId
  }

  /** Whether a row belongs to one of the scopes a reader may read. */
  private withinScopes(row: MemoryFields, scopes: MemoryScopeSet): boolean {
    if (scopes.all) return true
    return scopes.scopes.some(scope => scope.scopeType === row.scope_type && scope.scopeId === row.scope_id)
  }

  // ─── the shape of a row ──────────────────────────────────────────────────────────────────────────────────────────

  /** One candidate, read back for a reader. */
  private candidateView(row: CandidateRow): MemoryCandidateView {
    return {
      candidateId: row.row.candidate_id,
      scopeType: row.row.scope_type,
      scopeId: row.row.scope_id,
      proposedScopeType: row.row.proposed_scope_type,
      proposedScopeId: row.row.proposed_scope_id,
      content: redact(row.row.content),
      status: row.row.status,
      sourceTrust: row.row.source_trust,
      sourceRefs: parseSourceRefs(row.row.source_refs),
      proposedByRole: row.row.proposed_by_role,
      proposedBySessionId: row.row.proposed_by_session_id,
      provisionalSameSession: row.row.provisional_same_session === 1,
      revisionCount: row.row.revision_count,
      reevaluations: row.row.reevaluations,
      returnedToSessionId: row.row.returned_to_session_id,
      conflictWithId: row.row.conflict_with_id,
      confidence: row.row.confidence,
      importance: row.row.importance,
      reviewNote: redact(row.row.review_note),
      createdAt: row.row.created_at,
      updatedAt: row.row.updated_at,
      reviewedAt: row.row.reviewed_at,
      expiresAt: row.row.expires_at,
      checksum: row.checksum,
    }
  }

  /** One memory, read back for a reader. */
  private memoryView(row: MemoryRow): MemoryRecordView {
    return {
      memoryId: row.row.memory_id,
      scopeType: row.row.scope_type,
      scopeId: row.row.scope_id,
      content: redact(row.row.content),
      status: row.row.status,
      sourceTrust: row.row.source_trust,
      sourceRefs: parseSourceRefs(row.row.source_refs),
      supersedesId: row.row.supersedes_id,
      supersededById: row.row.superseded_by_id,
      conflictWithId: row.row.conflict_with_id,
      pinned: row.row.pinned === 1,
      importance: row.row.importance,
      confidence: row.row.confidence,
      utility: row.row.utility,
      validFrom: row.row.valid_from,
      lastVerifiedAt: row.row.last_verified_at,
      deprecatedAt: row.row.deprecated_at,
      createdAt: row.row.created_at,
      updatedAt: row.row.updated_at,
      nodeId: row.row.node_id,
      backendId: row.row.backend_id,
      checksum: row.checksum,
    }
  }

  /** One candidate, read from its own row. */
  private candidateById(candidateId: string): CandidateRow | undefined {
    const row = this.db.prepare('SELECT * FROM memory_candidates WHERE candidate_id = ?').get(candidateId) as
      Record<string, SQLInputValue> | undefined
    return row === undefined ? undefined : candidateOf(row)
  }

  /** The candidate a proposal was already written as. */
  private candidateOfIdempotency(key: string): CandidateRow | undefined {
    const row = this.db.prepare('SELECT * FROM memory_candidates WHERE idempotency_key = ?').get(key) as
      Record<string, SQLInputValue> | undefined
    return row === undefined ? undefined : candidateOf(row)
  }

  /** The live candidate that already carries the same words in the same scope. */
  private liveCandidateOfFingerprint(scope: MemoryScope, fingerprint: string): CandidateRow | undefined {
    const row = this.db.prepare(
      "SELECT * FROM memory_candidates WHERE scope_type = ? AND scope_id = ? AND content_fingerprint = ? AND status IN ('queued', 'reviewing', 'pending_human_confirm', 'conflict_pending')")
      .get(scope.scopeType, scope.scopeId, fingerprint) as Record<string, SQLInputValue> | undefined
    return row === undefined ? undefined : candidateOf(row)
  }

  /** One memory, read from its own row. */
  private memoryById(memoryId: string): MemoryRow | undefined {
    const row = this.db.prepare('SELECT * FROM long_term_memories WHERE memory_id = ?').get(memoryId) as
      Record<string, SQLInputValue> | undefined
    return row === undefined ? undefined : memoryOf(row)
  }

  /** The memory that already carries the same words in the same scope. */
  private liveMemoryOfFingerprint(scope: MemoryScope, fingerprint: string): MemoryRow | undefined {
    const row = this.db.prepare(
      "SELECT * FROM long_term_memories WHERE scope_type = ? AND scope_id = ? AND content_fingerprint = ? AND status IN ('active', 'conflict_pending')")
      .get(scope.scopeType, scope.scopeId, fingerprint) as Record<string, SQLInputValue> | undefined
    return row === undefined ? undefined : memoryOf(row)
  }

  /** The clause that holds the scope of a reader: the rows it may read, and no other. */
  private scopeClause(scopes: MemoryScopeSet): { sql: string; params: SQLInputValue[] } | undefined {
    if (scopes.all) return undefined
    if (scopes.scopes.length === 0) return { sql: '1 = 0', params: [] }
    const parts = scopes.scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ')
    const params: SQLInputValue[] = []
    for (const scope of scopes.scopes) params.push(scope.scopeType, scope.scopeId)
    return { sql: `(${parts})`, params }
  }

  /** Whether a scope names something this control plane really holds. */
  private scopeIsKnown(scope: MemoryScope): { ok: true } | { ok: false; code: MemoryRefusalCode; reason: string } {
    if (scope.scopeType === 'user_global') return { ok: true }
    if (scope.scopeType === 'node_env') {
      const nodeId = scope.scopeId.replace(/^node:/, '')
      if (nodeId === '' || !this.host.nodeIds().includes(nodeId)) {
        return { ok: false, code: 'UNKNOWN_SCOPE', reason: `This control plane knows no machine named ${nodeId}.` }
      }
      return { ok: true }
    }
    const projectId = projectIdOf(scope)
    if (projectId === '' || !this.host.projectIds().includes(projectId)) {
      return { ok: false, code: 'UNKNOWN_SCOPE', reason: `This control plane knows no project named ${projectId}.` }
    }
    return { ok: true }
  }

  /**
   * The node a row is bound to.
   *
   * A global fact carries no machine at all: it would otherwise travel with one machine and pollute another. A fact
   * about a machine is bound to that machine, not to the one that happens to write it down.
   */
  private nodeOf(scope: MemoryScope): string {
    if (scope.scopeType === 'user_global') return ''
    if (scope.scopeType === 'node_env') return nodeIdOf(scope)
    return this.host.nodeId()
  }

  /** The most rows a list may hold. */
  private limitOf(limit: number | undefined): number {
    if (limit === undefined) return MEMORY_LIST_DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_LIST_LIMIT) return MEMORY_LIST_DEFAULT_LIMIT
    return limit
  }

  /** The moment a candidate stops waiting. */
  private expiryOf(now: string): string {
    const at = new Date(now)
    if (Number.isNaN(at.getTime())) return ''
    at.setUTCDate(at.getUTCDate() + MEMORY_CANDIDATE_RETENTION_DAYS)
    return at.toISOString()
  }

  /**
   * The next id of one kind.
   *
   * The ids come from a counter that only grows, so an id is never handed out twice — not after a restart, and not
   * after a row is deleted. That is what lets an id be read as a stable name of a memory for as long as the memory
   * lives.
   */
  private nextId(name: 'memory' | 'candidate' | 'conflict', prefix: string): string {
    this.db.prepare('UPDATE memory_id_sequence SET value = value + 1 WHERE name = ?').run(name)
    const row = this.db.prepare('SELECT value FROM memory_id_sequence WHERE name = ?').get(name) as
      { value: number } | undefined
    return `${prefix}_${String(row?.value ?? 0).padStart(12, '0')}`
  }

  /**
   * One transaction, or none.
   *
   * The work is one fact: a candidate that becomes a memory and the memory itself are written together, or neither is.
   * A savepoint is used rather than a bare transaction, so the service may be called from inside a transaction of the
   * domain and still leave it to that transaction to decide what is kept.
   *
   * The caller may run its own writes inside it: the records of the control plane that speak of a candidate and the
   * candidate itself are then written together, or neither is.
   */
  transaction<T>(work: () => T): T {
    const name = `memory_atomic_${this.depth++}`
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

/** The fields of one row of the candidate table. */
interface CandidateFields {
  readonly candidate_id: string
  readonly idempotency_key: string
  readonly scope_type: string
  readonly scope_id: string
  readonly proposed_scope_type: string
  readonly proposed_scope_id: string
  readonly content: string
  readonly content_fingerprint: string
  readonly status: string
  readonly source_trust: string
  readonly source_refs: string
  readonly proposed_by_session_id: string
  readonly proposed_by_role: string
  readonly provisional_same_session: number
  readonly revision_count: number
  readonly reevaluations: number
  readonly returned_to_session_id: string
  readonly conflict_with_id: string
  readonly confidence: number
  readonly importance: number
  readonly review_note: string
  readonly created_at: string
  readonly updated_at: string
  readonly reviewed_at: string
  readonly expires_at: string
}

/** The fields of one row of the memory table. */
interface MemoryFields {
  readonly memory_id: string
  readonly scope_type: string
  readonly scope_id: string
  readonly content: string
  readonly content_fingerprint: string
  readonly status: string
  readonly source_trust: string
  readonly source_refs: string
  readonly supersedes_id: string
  readonly superseded_by_id: string
  readonly conflict_with_id: string
  readonly pinned: number
  readonly importance: number
  readonly confidence: number
  readonly utility: number
  readonly exposure_count: number
  readonly effective_use_count: number
  readonly disputed_count: number
  readonly valid_from: string
  readonly last_verified_at: string
  readonly deprecated_at: string
  readonly created_at: string
  readonly updated_at: string
  readonly node_id: string
  readonly backend_id: string
}

/** One row of the candidate table, with the checksum that names its version. */
interface CandidateRow {
  readonly row: CandidateFields
  readonly checksum: string
}

/** One row of the memory table, with the checksum that names its version. */
interface MemoryRow {
  readonly row: MemoryFields
  readonly checksum: string
}

/** One row of the candidate table, read from the table. */
function candidateOf(row: Record<string, SQLInputValue>): CandidateRow {
  const read: CandidateFields = {
    candidate_id: String(row.candidate_id),
    idempotency_key: String(row.idempotency_key),
    scope_type: String(row.scope_type),
    scope_id: String(row.scope_id),
    proposed_scope_type: String(row.proposed_scope_type),
    proposed_scope_id: String(row.proposed_scope_id),
    content: String(row.content),
    content_fingerprint: String(row.content_fingerprint),
    status: String(row.status),
    source_trust: String(row.source_trust),
    source_refs: String(row.source_refs),
    proposed_by_session_id: String(row.proposed_by_session_id),
    proposed_by_role: String(row.proposed_by_role),
    provisional_same_session: Number(row.provisional_same_session),
    revision_count: Number(row.revision_count),
    reevaluations: Number(row.reevaluations ?? 0),
    returned_to_session_id: String(row.returned_to_session_id ?? ''),
    conflict_with_id: String(row.conflict_with_id),
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    review_note: String(row.review_note),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    reviewed_at: String(row.reviewed_at),
    expires_at: String(row.expires_at),
  }
  return { row: read, checksum: checksumOf(read.candidate_id, read.status, read.updated_at, read.content_fingerprint) }
}

/** One row of the memory table, read from the table. */
function memoryOf(row: Record<string, SQLInputValue>): MemoryRow {
  const read: MemoryFields = {
    memory_id: String(row.memory_id),
    scope_type: String(row.scope_type),
    scope_id: String(row.scope_id),
    content: String(row.content),
    content_fingerprint: String(row.content_fingerprint),
    status: String(row.status),
    source_trust: String(row.source_trust),
    source_refs: String(row.source_refs),
    supersedes_id: String(row.supersedes_id),
    superseded_by_id: String(row.superseded_by_id),
    conflict_with_id: String(row.conflict_with_id),
    pinned: Number(row.pinned),
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    utility: Number(row.utility),
    exposure_count: Number(row.exposure_count ?? 0),
    effective_use_count: Number(row.effective_use_count ?? 0),
    disputed_count: Number(row.disputed_count ?? 0),
    valid_from: String(row.valid_from),
    last_verified_at: String(row.last_verified_at),
    deprecated_at: String(row.deprecated_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    node_id: String(row.node_id),
    backend_id: String(row.backend_id),
  }
  return { row: read, checksum: checksumOf(read.memory_id, read.status, read.updated_at, read.content_fingerprint) }
}

/** The checksum of one row: it names the version a decision was made on. */
function checksumOf(id: string, status: string, updatedAt: string, fingerprint: string): string {
  return createHash('sha256').update(`${id} ${status} ${updatedAt} ${fingerprint}`).digest('hex').slice(0, 32)
}

/** The source references of two rows, kept apart by what they name. */
function mergeRefs(left: readonly MemorySourceRef[], right: readonly MemorySourceRef[]): readonly MemorySourceRef[] {
  const merged: MemorySourceRef[] = [...left]
  for (const ref of right) {
    if (merged.some(entry => entry.kind === ref.kind && entry.id === ref.id)) continue
    merged.push(ref)
  }
  return merged
}

/** The confidence a memory starts with, by the trust of its source. */
function confidenceOf(trust: SourceTrust): number {
  if (trust === 'operator_explicit') return 0.9
  if (trust === 'verified_execution') return 0.8
  return 0.4
}

/** A number inside `[0, 1]`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** A note, redacted and bounded. */
function bounded(text: string): string {
  return redact(text).slice(0, 500)
}

/**
 * What a body carries that it may not keep.
 *
 * A path and a secret are refused rather than masked: a masked secret is still a secret in a file somebody may read,
 * and a path names a place on a machine that a memory may not name.
 */
function leakOf(content: string): 'path' | 'secret' | undefined {
  if (containsSecret(content)) return 'secret'
  if (containsAbsolutePath(content)) return 'path'
  return undefined
}
