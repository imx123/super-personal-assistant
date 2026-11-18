/**
 * The memory manager: the queue of reviews, the authority of the system role that runs them, and the daily inspection.
 *
 * **The manager is a system role, not a person.** It runs under the profile `memory_manager.v1`, and that profile is its
 * whole capability set: it may read one candidate, look for the memories that candidate repeats, submit one conclusion
 * and send one candidate back. It has no file, no shell, no network, no dispatch, no control of its own and no way to
 * message anybody. Every conclusion it submits goes into the same `Memory Service` a person at the console uses, so the
 * gates that hold a fact back — the checksum, the scope, the trust, the waiting for a person — hold for it too.
 *
 * **A tool call is bound to one prepared job.** Before the manager is woken, the control plane prepares a job: it names
 * the candidate, the version of that candidate (its checksum), the scope the candidate is about and the sources it
 * carries. The manager's calls must name that job and that version; anything else is refused. A job of an older
 * generation — a node that re-registered, a Session whose credential was rotated, a Session of another machine — is
 * refused as well, and a job that has already finished cannot be finished twice.
 *
 * **One candidate is reviewed by one manager at a time.** Two jobs for the same candidate would be two opinions about
 * one proposal, and the second one would decide about a version the first one had already moved on. The second
 * preparation is refused.
 *
 * **A job has a deadline.** A manager that is woken for a candidate and never calls its decision tool would hold that
 * candidate for ever, because no second job may be prepared for it. The job therefore runs out of time: it is written
 * down as unfinished, with the reason, a late call may not revive it, and an ordinary retry of the same candidate is
 * prepared as usual.
 *
 * **A return is passive and bounded.** When the manager cannot judge a candidate, it may ask the Session that proposed
 * it for more context — but the request is written into that Session's own queue and never delivered: a Session an
 * operator stopped, a paused Project or an ended Session is not woken, and one candidate goes back at most once. A
 * candidate that went round once already waits for a person. The request carries the version of the candidate and the
 * authority of the Session it waits for, so that the proposer may say the candidate once more — once — on exactly that
 * version.
 *
 * **The daily inspection is honest.** It writes down what it did: how many candidates it looked at, how many repeats
 * and conflicts it found, how many cold ones it set aside, and when the next one is due. A run whose node is offline,
 * whose process ended, whose checks failed, or that could only detect and not act is never written down as a success.
 *
 * The module holds no model and reaches no network: it prepares work, keeps the durable record of what was prepared and
 * what came of it, and refuses what it may not do.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { redact } from '../infra/redact.ts'

/** The name of the role profile the manager runs under. */
export const MEMORY_MANAGER_PROFILE_NAME = 'memory_manager.v1'

/**
 * The tools the manager owns, and nothing else.
 *
 * The list is the manager's whole capability set: a role profile that named a tool outside this list would let the
 * manager read a workspace, run a command or reach another role, and the contract forbids all three.
 */
export const MEMORY_MANAGER_TOOLS = [
  'memory_service_review_candidate',
  'memory_service_search_memories',
  'memory_service_decide',
  'memory_service_return_candidate',
] as const

/** The name of one of the manager's tools. */
export type MemoryManagerTool = typeof MEMORY_MANAGER_TOOLS[number]

/** The most reviews one daily inspection may start. */
export const MEMORY_MAINTENANCE_MAX_REVIEWS = 10

/**
 * How long one review job may stay under way, in milliseconds.
 *
 * A manager that is woken for a candidate and never calls its decision tool would otherwise hold that candidate for ever:
 * no second job may be prepared for it, so nothing moves until the control plane is restarted. The job therefore has a
 * deadline, and a job that reaches it is written down as unfinished — with the reason — and may not be revived. A new job
 * for the same candidate is prepared as usual: the retry is an ordinary one, not a way around the bound.
 */
export const MEMORY_REVIEW_JOB_TIMEOUT_MS = 300_000

/** The most rows one list of the manager's records may hold. */
export const MEMORY_MANAGER_LIST_LIMIT = 50

/** The most rows one list holds when the caller names no bound of its own. */
export const MEMORY_MANAGER_LIST_DEFAULT_LIMIT = 20

/** How many days a memory may go unverified before the inspection counts it as stale. */
export const MEMORY_STALE_AFTER_DAYS = 90

/**
 * The tables of the manager.
 *
 * They are created the way every other table of this control plane is created: idempotently, with
 * `CREATE TABLE IF NOT EXISTS`, and without a version of their own. They live in the control plane's own file, next to
 * the candidates and the memories they talk about, so a backup takes one snapshot of all of them.
 *
 * `memory_candidate_returns` is the passive queue: a request that waits for the Session that proposed a candidate to
 * read it in its own time. Nothing here is ever delivered by itself.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_review_runs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  candidate_id TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  scope_type TEXT NOT NULL DEFAULT '',
  scope_id TEXT NOT NULL DEFAULT '',
  source_keys TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL DEFAULT '',
  backend_id TEXT NOT NULL DEFAULT '',
  generation TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  prepared_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS memory_review_runs_candidate ON memory_review_runs(candidate_id, state);
CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  state TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT '',
  backend_id TEXT NOT NULL DEFAULT '',
  checked INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  expired INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  next_at TEXT NOT NULL DEFAULT '',
  prepared_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS memory_maintenance_runs_at ON memory_maintenance_runs(at);
CREATE TABLE IF NOT EXISTS memory_candidate_returns (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL UNIQUE,
  candidate_id TEXT NOT NULL,
  to_session_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  caller_role TEXT NOT NULL DEFAULT '',
  caller_node_id TEXT NOT NULL DEFAULT '',
  caller_project_id TEXT NOT NULL DEFAULT '',
  reevaluated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS memory_candidate_returns_session ON memory_candidate_returns(to_session_id, state);
`

/** The states a review run may be in. */
export type MemoryReviewRunState = 'prepared' | 'dispatched' | 'completed' | 'failed' | 'interrupted'

/** The states a maintenance run may be in. */
export type MemoryMaintenanceRunState =
  | 'attempted'
  | 'succeeded'
  | 'failed'
  | 'skipped_offline'
  | 'skipped_no_node'
  | 'skipped_disabled'
  | 'interrupted'

/** The states a passive return may be in. */
export type MemoryReturnState = 'queued' | 'delivered' | 'reevaluated' | 'expired'

/** One review run, as the operator reads it. */
export interface MemoryReviewRunView {
  readonly runId: string
  readonly jobId: string
  /** What the job is for: a review of one candidate, or a turn of the daily inspection. */
  readonly kind: string
  readonly candidateId: string
  readonly checksum: string
  readonly scopeType: string
  readonly scopeId: string
  /** The sources the candidate carried when the job was prepared. */
  readonly sourceKeys: readonly string[]
  readonly sessionId: string
  readonly nodeId: string
  readonly backendId: string
  /** The generation the job was prepared under; a job of an older one is stale. */
  readonly generation: string
  readonly state: MemoryReviewRunState
  readonly detail: string
  readonly preparedAt: string
  readonly updatedAt: string
  readonly finishedAt: string
  /** When the job runs out of time, when nothing decided about the candidate in the meantime. */
  readonly expiresAt: string
}

/** One maintenance run, as the operator reads it. */
export interface MemoryMaintenanceRunView {
  readonly runId: string
  /** When the run was due. */
  readonly at: string
  readonly state: MemoryMaintenanceRunState
  readonly nodeId: string
  readonly backendId: string
  /** How many candidates and memories the run looked at. */
  readonly checked: number
  /** How many candidates repeat a memory that is already in force. */
  readonly duplicates: number
  /** How many conflicts are open. */
  readonly conflicts: number
  /** How many cold candidates the run set aside. */
  readonly expired: number
  /** How many memories have not been verified for a long time. */
  readonly stale: number
  /** One line about what the run did. */
  readonly summary: string
  /** The rest of the record, redacted and short. */
  readonly detail: string
  /** When the next run is due. */
  readonly nextAt: string
  readonly preparedAt: string
  readonly finishedAt: string
}

/** One passive return, as the Session it waits for reads it. */
export interface MemoryCandidateReturnView {
  readonly returnId: string
  readonly candidateId: string
  readonly toSessionId: string
  readonly reason: string
  readonly state: MemoryReturnState
  readonly createdAt: string
  readonly deliveredAt: string
  /** The version of the candidate the return captured; the proposer says it once more on this one. */
  readonly checksum: string
  /** The caller the return captured: the authority the proposer held when the request was written. */
  readonly callerRole: string
  readonly callerNodeId: string
  readonly callerProjectId: string
  /** When the proposer said the candidate once more, when it did. */
  readonly reevaluatedAt: string
}

/** The Session of a manager, as the control plane holds it. */
export interface MemoryManagerSession {
  readonly sessionId: string
  readonly role: string
  readonly nodeId: string
  readonly toolProfile: string
  readonly tokenVersion: number
  readonly status: string
  readonly revokedAt?: string
  readonly operatorStop?: { readonly at: string }
}

/**
 * The caller, as the control plane authenticated it.
 *
 * Every field is a fact the control plane holds itself: the Session the token proved, the node it runs on, the
 * generation of its credential and the trust generation of the node. Nothing here comes from a request body.
 */
export interface MemoryManagerCaller {
  readonly sessionId: string
  readonly nodeId: string
  readonly tokenVersion: number
  readonly trustEpoch: number
}

/** What the manager's host answers about the world it runs in. */
export interface MemoryManagerHost {
  /** The control plane's own clock. */
  now(): string
  /** The node this control plane manages. */
  nodeId(): string
  /** The backend this control plane talks to. */
  backendId(): string
  /** The trust generation of the node right now; a job of an older one is stale. */
  trustEpoch(): number
  /** Whether the node is reachable right now. */
  nodeOnline(): boolean
  /** The Session record, when this control plane holds one. */
  session(sessionId: string): MemoryManagerSession | undefined
}

/** Why a call of the manager was refused. */
export type MemoryManagerRefusalCode =
  | 'NOT_A_MANAGER'
  | 'SESSION_REVOKED'
  | 'SESSION_STOPPED'
  | 'SESSION_FOREIGN'
  | 'SESSION_STALE'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_BOUND'
  | 'JOB_STALE'
  | 'JOB_EXPIRED'
  | 'JOB_FINISHED'
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'SOURCE_MISMATCH'
  | 'REVIEW_ALREADY_ACTIVE'
  | 'RETURN_LIMIT_REACHED'
  | 'NO_TARGET'

/** The answer of a refusal. */
export interface MemoryManagerRefusal {
  readonly ok: false
  readonly code: MemoryManagerRefusalCode
  readonly reason: string
}

/** The answer of an authorization. */
export type MemoryManagerAuthorization =
  | { readonly ok: true; readonly job: MemoryReviewRunView }
  | MemoryManagerRefusal

/** The answer of a preparation. */
export type MemoryManagerPrepareResult =
  | { readonly ok: true; readonly job: MemoryReviewRunView }
  | MemoryManagerRefusal

/** What one prepared job is about. */
export interface MemoryReviewJobInput {
  readonly candidateId: string
  /** The checksum of the candidate as it was read. */
  readonly checksum: string
  readonly scopeType: string
  readonly scopeId: string
  /** The sources the candidate carried when it was read. */
  readonly sourceKeys: readonly string[]
  /** What the job is for. */
  readonly kind?: 'review' | 'maintenance'
  /** How long the job may stay under way, in milliseconds; the default is the module's own bound. */
  readonly timeoutMs?: number
}

/**
 * The caller a passive return captures.
 *
 * It is the authority the proposer held when the request was written: the role it acted as, the machine it ran on and
 * the Project it was really delegated. A re-evaluation has to come from the very same authority.
 */
export interface MemoryReturnCaller {
  readonly role: string
  readonly nodeId: string
  readonly projectId: string
}

/** One passive return, as it is written into the queue. */
export interface MemoryReturnInput {
  readonly candidateId: string
  readonly toSessionId: string
  readonly reason: string
  /** The version of the candidate the return captured. */
  readonly checksum: string
  /** The authority of the Session the request waits for. */
  readonly caller: MemoryReturnCaller
}

/** The counters one inspection counted. */
export interface MemoryMaintenanceCounters {
  readonly checked: number
  readonly duplicates: number
  readonly conflicts: number
  readonly expired: number
  readonly stale: number
}

/** When the daily inspection runs. */
export interface MemoryMaintenanceSchedule {
  /** Whether the inspection runs on its own at all. */
  readonly enabled: boolean
  /** The minute of the day, in UTC, the inspection is due at. */
  readonly minuteOfDay: number
}

/** The schedule the control plane uses when nothing says otherwise. */
export const DEFAULT_MEMORY_MAINTENANCE_SCHEDULE: MemoryMaintenanceSchedule = { enabled: true, minuteOfDay: 180 }

/**
 * The moment the inspection is due, the last time it was due at or before `at`.
 *
 * A control plane that was down for three days finds the slot of today, not the three it missed: an inspection that
 * replays old windows is an inspection of facts that have changed since.
 */
export function currentMaintenanceSlot(schedule: MemoryMaintenanceSchedule, at: Date): Date {
  const slot = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(),
    Math.floor(schedule.minuteOfDay / 60), schedule.minuteOfDay % 60, 0, 0))
  if (slot.getTime() > at.getTime()) slot.setUTCDate(slot.getUTCDate() - 1)
  return slot
}

/** The moment the inspection is due next, the first one strictly after `at`. */
export function nextMaintenanceSlot(schedule: MemoryMaintenanceSchedule, at: Date): Date {
  const slot = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(),
    Math.floor(schedule.minuteOfDay / 60), schedule.minuteOfDay % 60, 0, 0))
  if (slot.getTime() <= at.getTime()) slot.setUTCDate(slot.getUTCDate() + 1)
  return slot
}

/**
 * The manager of one control plane: the queue of reviews, the authority over them, and the daily inspection.
 *
 * It owns no state of its own beyond the three tables it keeps: every fact about a candidate and a memory comes from the
 * `Memory Service`, which stays the only place a memory is written.
 */
export class MemoryManager {
  constructor(private readonly db: DatabaseSync, private readonly host: MemoryManagerHost,
    private readonly onError: (error: unknown) => void = () => {}) {
    this.migrate()
  }

  /** Make sure the tables are there, the way every other table of this control plane is made. */
  private migrate(): void {
    this.db.exec(SCHEMA)
    this.ensureColumn('memory_review_runs', 'expires_at', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('memory_candidate_returns', 'checksum', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('memory_candidate_returns', 'caller_role', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('memory_candidate_returns', 'caller_node_id', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('memory_candidate_returns', 'caller_project_id', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('memory_candidate_returns', 'reevaluated_at', "TEXT NOT NULL DEFAULT ''")
  }

  /**
   * Give a table a column it did not have, once.
   *
   * The table's own columns are the truth: a database that already has the column keeps it, and a database of the older
   * shape gets it and keeps its rows.
   */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (columns.some(entry => entry.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  // ─── the queue of reviews ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Prepare one review job.
   *
   * The job names the candidate, the version of it that was read, its scope and the sources it carries: those four
   * things are what the manager's calls are checked against afterwards. A candidate that already has a job waiting is
   * refused, so two managers never hold the same proposal at once — unless that job has run out of time, which is
   * written down as unfinished and lets an ordinary retry through.
   */
  prepareReview(input: MemoryReviewJobInput): MemoryManagerPrepareResult {
    if (input.candidateId === '') {
      return { ok: false, code: 'CANDIDATE_NOT_FOUND', reason: 'There is no such candidate.' }
    }
    // A job that ran out of time is not under way any more: it is written down as unfinished before the queue is read,
    // so the retry of the same candidate is an ordinary one.
    this.expireStaleJobs()
    const active = this.db.prepare(
      "SELECT job_id FROM memory_review_runs WHERE candidate_id = ? AND state IN ('prepared', 'dispatched')")
      .get(input.candidateId) as { job_id: string } | undefined
    if (active !== undefined) {
      return { ok: false, code: 'REVIEW_ALREADY_ACTIVE',
        reason: 'This candidate is already being reviewed; one proposal is reviewed by one manager at a time.' }
    }
    const now = this.host.now()
    const jobId = `memjob-${randomUUID()}`
    const runId = `memrun-${randomUUID()}`
    const timeout = input.timeoutMs ?? MEMORY_REVIEW_JOB_TIMEOUT_MS
    try {
      this.db.prepare(`
        INSERT INTO memory_review_runs
          (run_id, job_id, kind, candidate_id, checksum, scope_type, scope_id, source_keys, session_id, node_id,
           backend_id, generation, state, detail, prepared_at, updated_at, finished_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '', 'prepared', '', ?, ?, '', ?)
      `).run(runId, jobId, input.kind ?? 'review', input.candidateId, input.checksum, input.scopeType, input.scopeId,
        JSON.stringify(input.sourceKeys), this.host.nodeId(), this.host.backendId(), now, now, this.deadlineOf(now, timeout))
      const job = this.jobById(jobId)
      return { ok: true, job: job! }
    } catch (error) {
      this.onError(error)
      return { ok: false, code: 'JOB_NOT_FOUND', reason: 'The review job could not be prepared.' }
    }
  }

  /**
   * Write down the jobs that ran out of time without a decision.
   *
   * A job that reached its deadline is finished, and it says so: the state is `failed` and the reason is kept with it.
   * It is not a success and it is not an unknown — nobody decided about the candidate, and the record says exactly that.
   * A job that was decided about, or that is still under way, is left alone.
   */
  expireStaleJobs(): number {
    const now = this.host.now()
    try {
      const result = this.db.prepare(
        "UPDATE memory_review_runs SET state = 'failed', detail = ?, updated_at = ?, finished_at = ? "
        + "WHERE state IN ('prepared', 'dispatched') AND expires_at != '' AND expires_at <= ?")
        .run('The review ran out of time without a decision; it waits for another review.', now, now, now)
      return Number(result.changes)
    } catch (error) {
      this.onError(error)
      return 0
    }
  }

  /** The moment a job that starts now runs out of time. */
  private deadlineOf(now: string, timeoutMs: number): string {
    const at = new Date(now)
    if (Number.isNaN(at.getTime())) return ''
    return new Date(at.getTime() + Math.max(0, timeoutMs)).toISOString()
  }

  /**
   * Bind one prepared job to the Session that will run it.
   *
   * The binding is what makes the job narrow: the Session that was woken is the only one that may work on it, and the
   * generation the node is trusted under is written down with it, so a job of an older node is stale afterwards.
   */
  bindDispatch(jobId: string, sessionId: string): MemoryManagerAuthorization {
    const job = this.jobById(jobId)
    if (job === undefined) return { ok: false, code: 'JOB_NOT_FOUND', reason: 'There is no such review job.' }
    if (job.state !== 'prepared') {
      return { ok: false, code: 'JOB_FINISHED', reason: 'This review job was already dispatched or finished.' }
    }
    const now = this.host.now()
    const generation = String(this.host.trustEpoch())
    this.db.prepare(
      "UPDATE memory_review_runs SET session_id = ?, generation = ?, state = 'dispatched', updated_at = ? WHERE job_id = ?")
      .run(sessionId, generation, now, jobId)
    return { ok: true, job: this.jobById(jobId)! }
  }

  /** Write down how one job ended. */
  finishReview(jobId: string, state: 'completed' | 'failed' | 'interrupted', detail: string): void {
    const now = this.host.now()
    this.db.prepare('UPDATE memory_review_runs SET state = ?, detail = ?, updated_at = ?, finished_at = ? WHERE job_id = ?')
      .run(state, bounded(detail), now, now, jobId)
  }

  /** The review runs, newest first. */
  listReviewRuns(limit?: number): MemoryReviewRunView[] {
    const rows = this.db.prepare('SELECT * FROM memory_review_runs ORDER BY seq DESC LIMIT ?')
      .all(this.limitOf(limit)) as Record<string, SQLInputValue>[]
    return rows.map(row => this.reviewRunView(row))
  }

  /** One review run, by its job id. */
  jobById(jobId: string): MemoryReviewRunView | undefined {
    const row = this.db.prepare('SELECT * FROM memory_review_runs WHERE job_id = ?').get(jobId) as
      Record<string, SQLInputValue> | undefined
    return row === undefined ? undefined : this.reviewRunView(row)
  }

  /** The job that is running for one candidate, when there is one. */
  activeJobOf(candidateId: string): MemoryReviewRunView | undefined {
    const row = this.db.prepare(
      "SELECT * FROM memory_review_runs WHERE candidate_id = ? AND state IN ('prepared', 'dispatched') ORDER BY seq DESC")
      .get(candidateId) as Record<string, SQLInputValue> | undefined
    return row === undefined ? undefined : this.reviewRunView(row)
  }

  // ─── the authority of one call ────────────────────────────────────────────────────────────────────────────────

  /**
   * Decide whether one call of the manager may go on.
   *
   * The Session is checked first: it must be a manager of this control plane, on this node, with a credential of this
   * generation, and it must not be a Session an operator stopped or a Session whose authority was revoked. Then the
   * job is checked: it must exist, it must be the one bound to this Session, it must be under way and not finished, and
   * its generation must still be the node's. Last the arguments are checked against the job: the candidate, the version
   * of it and the sources it carries.
   *
   * Nothing here reads a request body for authority: the caller is the Session the control plane authenticated, and the
   * job is the record the control plane wrote before the Session was woken.
   */
  authorize(caller: MemoryManagerCaller, request: {
    readonly jobId: string
    readonly candidateId: string
    readonly checksum: string
    /** The candidate as it is right now, when the caller read one. */
    readonly live?: { readonly checksum: string; readonly sourceKeys: readonly string[] }
  }): MemoryManagerAuthorization {
    const record = this.host.session(caller.sessionId)
    if (record === undefined) {
      return { ok: false, code: 'NOT_A_MANAGER', reason: 'There is no such Session.' }
    }
    if (record.role !== 'manager' || record.toolProfile !== MEMORY_MANAGER_PROFILE_NAME) {
      return { ok: false, code: 'NOT_A_MANAGER', reason: 'This Session is not the memory manager.' }
    }
    if (record.revokedAt !== undefined) {
      return { ok: false, code: 'SESSION_REVOKED', reason: 'The authority of this Session was revoked.' }
    }
    if (record.operatorStop !== undefined) {
      return { ok: false, code: 'SESSION_STOPPED', reason: 'This Session was stopped by an operator.' }
    }
    if (record.nodeId !== caller.nodeId || record.nodeId !== this.host.nodeId()) {
      return { ok: false, code: 'SESSION_FOREIGN', reason: 'This Session belongs to another node.' }
    }
    if (record.tokenVersion !== caller.tokenVersion) {
      return { ok: false, code: 'SESSION_STALE', reason: 'The credential of this Session was replaced.' }
    }
    const job = this.jobById(request.jobId)
    if (job === undefined) {
      return { ok: false, code: 'JOB_NOT_FOUND', reason: 'There is no such review job.' }
    }
    if (job.sessionId !== caller.sessionId) {
      return { ok: false, code: 'JOB_NOT_BOUND', reason: 'This review job was dispatched to another Session.' }
    }
    if (job.state === 'completed' || job.state === 'failed' || job.state === 'interrupted') {
      return { ok: false, code: 'JOB_FINISHED', reason: 'This review job is already finished.' }
    }
    // A job that ran out of time is finished: it is written down as unfinished, with the reason, and it is not revived by
    // a call that arrives late. A new job for the same candidate is prepared as usual.
    if (reached(job.expiresAt, this.host.now())) {
      this.finishReview(job.jobId, 'failed', 'The review ran out of time without a decision; it waits for another review.')
      return { ok: false, code: 'JOB_EXPIRED', reason: 'This review job ran out of time without a decision.' }
    }
    if (job.generation !== String(caller.trustEpoch)) {
      return { ok: false, code: 'JOB_STALE', reason: 'This review job was prepared for an older generation of the node.' }
    }
    if (job.candidateId !== request.candidateId) {
      return { ok: false, code: 'CANDIDATE_MISMATCH',
        reason: 'This review job is about another candidate.' }
    }
    if (job.checksum !== request.checksum) {
      return { ok: false, code: 'CHECKSUM_MISMATCH',
        reason: 'This review job was prepared for another version of the candidate.' }
    }
    if (request.live !== undefined) {
      if (request.live.checksum !== job.checksum) {
        return { ok: false, code: 'CHECKSUM_MISMATCH',
          reason: 'This candidate changed since the review was prepared; read it again.' }
      }
      if (!sameSources(job.sourceKeys, request.live.sourceKeys)) {
        return { ok: false, code: 'SOURCE_MISMATCH',
          reason: 'The sources of this candidate changed since the review was prepared.' }
      }
    }
    return { ok: true, job }
  }

  // ─── the passive return ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * Write one return into the queue of the Session that proposed the candidate.
   *
   * The queue is passive: nothing is delivered here, and the Session that waits for the request is not started, woken
   * or messaged. A Session an operator stopped, a paused Project or an ended Session keeps the request waiting until a
   * person brings it back.
   *
   * The request carries two facts besides its reason: the version of the candidate it is about, and the authority the
   * proposer held when it was written. They are what a re-evaluation is checked against, so the proposer may say the
   * candidate once more — and only on that version, and only with the authority it had.
   */
  queueReturn(input: MemoryReturnInput): MemoryCandidateReturnView {
    const now = this.host.now()
    const returnId = `memret-${randomUUID()}`
    this.db.prepare(`
      INSERT INTO memory_candidate_returns
        (return_id, candidate_id, to_session_id, reason, state, created_at, delivered_at, checksum,
         caller_role, caller_node_id, caller_project_id, reevaluated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, '', ?, ?, ?, ?, '')
    `).run(returnId, input.candidateId, input.toSessionId, bounded(input.reason), now, input.checksum,
      input.caller.role, input.caller.nodeId, input.caller.projectId)
    return {
      returnId,
      candidateId: input.candidateId,
      toSessionId: input.toSessionId,
      reason: bounded(input.reason),
      state: 'queued',
      createdAt: now,
      deliveredAt: '',
      checksum: input.checksum,
      callerRole: input.caller.role,
      callerNodeId: input.caller.nodeId,
      callerProjectId: input.caller.projectId,
      reevaluatedAt: '',
    }
  }

  /**
   * The request that waits for one Session about one candidate.
   *
   * A request that was already used — the proposer said the candidate once more — is not one of these: the bound of one
   * round is kept by the state of the request, and a spent one is spent for good.
   */
  pendingReturnOf(candidateId: string, sessionId: string): MemoryCandidateReturnView | undefined {
    if (candidateId === '' || sessionId === '') return undefined
    const row = this.db.prepare(
      "SELECT * FROM memory_candidate_returns WHERE candidate_id = ? AND to_session_id = ? "
      + "AND state IN ('queued', 'delivered') ORDER BY seq DESC")
      .get(candidateId, sessionId) as Record<string, SQLInputValue> | undefined
    return row === undefined ? undefined : this.returnView(row)
  }

  /**
   * Write down that the proposer said the candidate once more.
   *
   * The request is spent: the round it stands for is over, and the same request may not carry another one.
   */
  markReturnReevaluated(returnId: string): void {
    const now = this.host.now()
    this.db.prepare("UPDATE memory_candidate_returns SET state = 'reevaluated', reevaluated_at = ? WHERE return_id = ?")
      .run(now, returnId)
  }

  /** The requests that wait for one Session. */
  pendingReturns(sessionId: string): MemoryCandidateReturnView[] {
    if (sessionId === '') return []
    const rows = this.db.prepare(
      "SELECT * FROM memory_candidate_returns WHERE to_session_id = ? AND state = 'queued' ORDER BY seq")
      .all(sessionId) as Record<string, SQLInputValue>[]
    return rows.map(row => this.returnView(row))
  }

  /** Write down that a request was handed to the Session that waited for it. */
  markReturnDelivered(returnId: string): void {
    this.db.prepare("UPDATE memory_candidate_returns SET state = 'delivered', delivered_at = ? WHERE return_id = ?")
      .run(this.host.now(), returnId)
  }

  /**
   * Put a request back into the queue of the Session that waits for it.
   *
   * A delivery that could not be made is not a delivery: the request waits again, and the Session that proposed the
   * candidate may still read it later.
   */
  markReturnQueued(returnId: string): void {
    this.db.prepare("UPDATE memory_candidate_returns SET state = 'queued', delivered_at = '' WHERE return_id = ?")
      .run(returnId)
  }

  /** The requests, whoever they wait for. */
  listReturns(limit?: number): MemoryCandidateReturnView[] {
    const rows = this.db.prepare('SELECT * FROM memory_candidate_returns ORDER BY seq DESC LIMIT ?')
      .all(this.limitOf(limit)) as Record<string, SQLInputValue>[]
    return rows.map(row => this.returnView(row))
  }

  // ─── the daily inspection ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Write down that an inspection was attempted, before anything else happens.
   *
   * The row is written first, so a process that ends in the middle leaves an honest record of what was under way
   * rather than nothing at all.
   */
  startMaintenance(input: { runId: string; at: string; nextAt: string }): MemoryMaintenanceRunView {
    const now = this.host.now()
    this.db.prepare(`
      INSERT INTO memory_maintenance_runs
        (run_id, at, state, node_id, backend_id, checked, duplicates, conflicts, expired, stale, summary, detail,
         next_at, prepared_at, finished_at)
      VALUES (?, ?, 'attempted', ?, ?, 0, 0, 0, 0, 0, '', '', ?, ?, '')
    `).run(input.runId, input.at, this.host.nodeId(), this.host.backendId(), input.nextAt, now)
    return this.maintenanceById(input.runId)!
  }

  /** Write down how an inspection ended, with what it counted. */
  finishMaintenance(runId: string, state: MemoryMaintenanceRunState, counters: MemoryMaintenanceCounters,
    summary: string, detail = ''): MemoryMaintenanceRunView {
    const now = this.host.now()
    this.db.prepare(`
      UPDATE memory_maintenance_runs
        SET state = ?, checked = ?, duplicates = ?, conflicts = ?, expired = ?, stale = ?, summary = ?, detail = ?,
            finished_at = ?
      WHERE run_id = ?
    `).run(state, counters.checked, counters.duplicates, counters.conflicts, counters.expired, counters.stale,
      bounded(summary), bounded(detail), now, runId)
    return this.maintenanceById(runId)!
  }

  /** One inspection, by its own id. */
  maintenanceById(runId: string): MemoryMaintenanceRunView | undefined {
    const row = this.db.prepare('SELECT * FROM memory_maintenance_runs WHERE run_id = ?').get(runId) as
      Record<string, SQLInputValue> | undefined
    return row === undefined ? undefined : this.maintenanceRunView(row)
  }

  /** The inspections, newest first. */
  listMaintenanceRuns(limit?: number): MemoryMaintenanceRunView[] {
    const rows = this.db.prepare('SELECT * FROM memory_maintenance_runs ORDER BY seq DESC LIMIT ?')
      .all(this.limitOf(limit)) as Record<string, SQLInputValue>[]
    return rows.map(row => this.maintenanceRunView(row))
  }

  /** The last inspection, when there was one. */
  lastMaintenanceRun(): MemoryMaintenanceRunView | undefined {
    const rows = this.listMaintenanceRuns(1)
    return rows[0]
  }

  /**
   * Write down the inspections that were under way when the process ended.
   *
   * A run that was attempted and never finished is not a run that succeeded: it is a run whose outcome is unknown, and
   * it says so. The control plane calls this once, when it starts.
   */
  interruptUnfinishedMaintenance(): number {
    const now = this.host.now()
    const result = this.db.prepare(
      "UPDATE memory_maintenance_runs SET state = 'interrupted', summary = ?, detail = ?, finished_at = ? "
      + "WHERE state = 'attempted'")
      .run('巡检在控制面重启时中断，结果未知。', 'The control plane ended while this inspection was under way.', now)
    return Number(result.changes)
  }

  /** The same for the reviews: a job that was under way when the process ended is not a job that finished. */
  interruptUnfinishedReviews(): number {
    const now = this.host.now()
    const result = this.db.prepare(
      "UPDATE memory_review_runs SET state = 'interrupted', detail = ?, updated_at = ?, finished_at = ? "
      + "WHERE state IN ('prepared', 'dispatched')")
      .run('The control plane ended while this review was under way.', now, now)
    return Number(result.changes)
  }

  // ─── what one inspection counts ───────────────────────────────────────────────────────────────────────────────

  /**
   * What the inspection looks at, without changing anything.
   *
   * The counts are read from the tables themselves: the candidates that repeat a memory that is already in force, the
   * conflicts that are still open, the cold candidates, and the memories that have not been verified for a long time.
   */
  countQueue(): MemoryMaintenanceCounters {
    const checked = Number((this.db.prepare('SELECT COUNT(*) AS total FROM memory_candidates').get() as
      { total: number }).total)
    const duplicates = Number((this.db.prepare(`
      SELECT COUNT(*) AS total FROM memory_candidates c
      JOIN long_term_memories m
        ON m.scope_type = c.scope_type AND m.scope_id = c.scope_id
       AND m.content_fingerprint = c.content_fingerprint AND m.status = 'active'
      WHERE c.status IN ('queued', 'reviewing')
    `).get() as { total: number }).total)
    const conflicts = Number((this.db.prepare(
      "SELECT COUNT(*) AS total FROM memory_conflicts WHERE state = 'open'").get() as { total: number }).total)
    const expired = Number((this.db.prepare(
      "SELECT COUNT(*) AS total FROM memory_candidates WHERE status = 'expired_candidate'").get() as
      { total: number }).total)
    const staleBefore = new Date(this.host.now()).getTime() - MEMORY_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000
    const stale = Number((this.db.prepare(
      "SELECT COUNT(*) AS total FROM long_term_memories WHERE status = 'active' AND last_verified_at < ?")
      .get(new Date(staleBefore).toISOString()) as { total: number }).total)
    return { checked, duplicates, conflicts, expired, stale }
  }

  // ─── the shape of a row ──────────────────────────────────────────────────────────────────────────────────────────

  private reviewRunView(row: Record<string, SQLInputValue>): MemoryReviewRunView {
    return {
      runId: String(row.run_id),
      jobId: String(row.job_id),
      kind: String(row.kind),
      candidateId: String(row.candidate_id),
      checksum: String(row.checksum),
      scopeType: String(row.scope_type),
      scopeId: String(row.scope_id),
      sourceKeys: parseKeys(row.source_keys),
      sessionId: String(row.session_id),
      nodeId: String(row.node_id),
      backendId: String(row.backend_id),
      generation: String(row.generation),
      state: String(row.state) as MemoryReviewRunState,
      detail: redact(String(row.detail ?? '')),
      preparedAt: String(row.prepared_at),
      updatedAt: String(row.updated_at),
      finishedAt: String(row.finished_at ?? ''),
      expiresAt: String(row.expires_at ?? ''),
    }
  }

  private maintenanceRunView(row: Record<string, SQLInputValue>): MemoryMaintenanceRunView {
    return {
      runId: String(row.run_id),
      at: String(row.at),
      state: String(row.state) as MemoryMaintenanceRunState,
      nodeId: String(row.node_id),
      backendId: String(row.backend_id),
      checked: Number(row.checked ?? 0),
      duplicates: Number(row.duplicates ?? 0),
      conflicts: Number(row.conflicts ?? 0),
      expired: Number(row.expired ?? 0),
      stale: Number(row.stale ?? 0),
      summary: redact(String(row.summary ?? '')),
      detail: redact(String(row.detail ?? '')),
      nextAt: String(row.next_at ?? ''),
      preparedAt: String(row.prepared_at),
      finishedAt: String(row.finished_at ?? ''),
    }
  }

  private returnView(row: Record<string, SQLInputValue>): MemoryCandidateReturnView {
    return {
      returnId: String(row.return_id),
      candidateId: String(row.candidate_id),
      toSessionId: String(row.to_session_id),
      reason: redact(String(row.reason ?? '')),
      state: String(row.state) as MemoryReturnState,
      createdAt: String(row.created_at),
      deliveredAt: String(row.delivered_at ?? ''),
      checksum: String(row.checksum ?? ''),
      callerRole: String(row.caller_role ?? ''),
      callerNodeId: String(row.caller_node_id ?? ''),
      callerProjectId: String(row.caller_project_id ?? ''),
      reevaluatedAt: String(row.reevaluated_at ?? ''),
    }
  }

  /** The most rows a list may hold. */
  private limitOf(limit: number | undefined): number {
    if (limit === undefined) return MEMORY_MANAGER_LIST_DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_MANAGER_LIST_LIMIT) return MEMORY_MANAGER_LIST_DEFAULT_LIMIT
    return limit
  }
}

/**
 * The keys of the sources a candidate carries.
 *
 * Two candidates carry the same sources when they name the same records: the kind and the id of each, sorted, so the
 * order the records were read in does not matter.
 */
export function sourceKeysOf(refs: readonly { readonly kind: string; readonly id: string }[]): string[] {
  return refs.map(ref => `${ref.kind}:${ref.id}`).sort()
}

/** Whether two sets of source keys are the same set. */
export function sameSources(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((key, index) => key === b[index])
}

/** The source keys of one row, read back from its own column. */
function parseKeys(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((key): key is string => typeof key === 'string')
  } catch {
    return []
  }
}

/** A note, redacted and bounded. */
function bounded(text: string): string {
  return redact(text).slice(0, 500)
}

/**
 * Whether a deadline has been reached.
 *
 * A deadline that is not there is no deadline: a job of an older shape, or one that was prepared without a bound, is not
 * expired by this rule.
 */
function reached(deadline: string, now: string): boolean {
  if (deadline === '') return false
  const at = new Date(deadline).getTime()
  const moment = new Date(now).getTime()
  if (Number.isNaN(at) || Number.isNaN(moment)) return deadline <= now
  return at <= moment
}
