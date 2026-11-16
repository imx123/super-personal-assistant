/**
 * The control plane's own durable record: the event log with a sequence of its own, and the audit trail.
 *
 * It is a separate SQLite file from the domain's `control.sqlite`, because the domain's schema belongs to the plugin and
 * to the kernel alike, while this file belongs to the control plane's console alone. Nothing here rolls the domain's
 * schema back, and an old plugin binary never opens this file.
 *
 * The event log gives every recorded event a sequence that is monotonic across control-plane restarts, which a node's own
 * counter cannot be: a node restarts and counts from 1 again. The node's counter is kept beside it, so a restart stays
 * visible. The log is bounded — a fixed number of rows and a fixed age — and a client that asks for an event the log no
 * longer holds is told that the log has a gap instead of being given a history that silently starts later.
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** One recorded event, as the log holds it. */
export interface ConsoleEventRow {
  /** The control plane's own sequence: monotonic across restarts. */
  seq: number
  /** When the event happened, as the node reported it. */
  at: string
  /** The node the event came from. */
  nodeId: string
  /** The node's own counter, when the event came from a node. */
  nodeSeq?: number
  /** The Session the event is about; empty for a node-scoped event. */
  sessionId: string
  /** The event type, as the protocol names it. */
  type: string
  /** The event's own kind, for a `session.event`; empty otherwise. */
  kind: string
  /** The whole event as JSON, exactly as a subscriber receives it. */
  payload: string
}

/** One audit entry: who did what to which target, and how it ended. */
export interface ConsoleAuditRow {
  /** The audit's own sequence, monotonic and never reused. */
  seq: number
  /** When the fact was recorded. */
  at: string
  /** Who acted: an operator, a PM, a Worker or the system itself. */
  actor: string
  /** What kind of thing was acted on: a project, a ticket, an assignment, a report, a review, a node or a session. */
  kind: string
  /** What happened, in the vocabulary of that kind. */
  action: string
  /** The kind of the target, as the kernel names it. */
  targetKind: string
  /** The id of the target. */
  targetId: string
  /** How it ended: `ok`, `failed` or `skipped`. */
  outcome: string
  /** A short, redacted line about the fact; never a request body and never a credential. */
  detail: string
}

/** One entry of a Project's own memory: a fact an operator wrote down for that Project. */
export interface ProjectMemoryRow {
  /** The entry's own id, newest last. */
  id: number
  /** The Project the entry belongs to. */
  projectId: string
  /** When it was written. */
  at: string
  /** Who wrote it. */
  actor: string
  /** The text of the entry. */
  text: string
}

/** One run of the orphan reconciliation, as it was recorded. */
export interface ReconcileRunRow {
  /** The run's own id. */
  id: number
  /** When the run happened. */
  at: string
  /** Whether the node answered during the run. */
  nodeOnline: boolean
  /** How many Sessions the run looked at. */
  checked: number
  /** The findings of the run, as JSON. */
  findings: string
  /** The counts of the run, as JSON. */
  counts: string
  /** What the run could not see. */
  boundary: string
}

/** What the log keeps and for how long. */
export interface ConsoleStoreOptions {
  /** How many events the log keeps; the oldest are dropped first. */
  eventRows?: number
  /** How many days the log keeps; `0` keeps the events forever. */
  eventDays?: number
  /** How many days the audit keeps; `0` keeps the audit forever. */
  auditDays?: number
}

/** How many events the log keeps by default. */
export const DEFAULT_EVENT_ROWS = 20_000
/** How many days the log keeps by default. */
export const DEFAULT_EVENT_DAYS = 7
/** How many days the audit keeps by default; `0` means the audit is permanent. */
export const DEFAULT_AUDIT_DAYS = 0

/** The tables of the console's own file. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS console_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
  target_kind TEXT NOT NULL, target_id TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE INDEX IF NOT EXISTS audit_kind ON audit(kind, seq);
CREATE TABLE IF NOT EXISTS event_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, node_id TEXT NOT NULL, node_seq INTEGER, session_id TEXT NOT NULL,
  type TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS event_log_session ON event_log(session_id, seq);
CREATE INDEX IF NOT EXISTS event_log_at ON event_log(at);
CREATE TABLE IF NOT EXISTS project_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_memory_project ON project_memory(project_id, id);
CREATE TABLE IF NOT EXISTS reconcile_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, node_online INTEGER NOT NULL, checked INTEGER NOT NULL,
  findings TEXT NOT NULL, counts TEXT NOT NULL, boundary TEXT NOT NULL);
`

/** The value of one column of a row, as a number. */
function numberOf(value: unknown): number { return typeof value === 'number' ? value : Number(value) }

/** The value of one column of a row, as a string. */
function stringOf(value: unknown): string { return typeof value === 'string' ? value : String(value) }

/**
 * The control plane's own file: the event log and the audit trail.
 *
 * Every write is synchronous and small, so a recorded event is durable before the subscribers are told about it. A write
 * that fails throws to the caller, which reports it and keeps the work going: a log that cannot be written must never
 * stop a Worker from reporting.
 */
export class ConsoleStore {
  readonly db: DatabaseSync
  /** How many events the log keeps. */
  readonly eventRows: number
  /** How many days the log keeps; `0` keeps the events forever. */
  readonly eventDays: number
  /** How many days the audit keeps; `0` keeps the audit forever. */
  readonly auditDays: number
  /** The sequence the log gave its last event; the next one is the one after it. */
  private sequence: number

  constructor(path: string, options: ConsoleStoreOptions = {}) {
    this.eventRows = options.eventRows ?? DEFAULT_EVENT_ROWS
    this.eventDays = options.eventDays ?? DEFAULT_EVENT_DAYS
    this.auditDays = options.auditDays ?? DEFAULT_AUDIT_DAYS
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      this.db.exec(SCHEMA)
      this.sequence = this.readSequence()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /** Close the file; a closed store throws on every later call, which is how a closed control plane behaves. */
  close(): void { this.db.close() }

  /**
   * Take the sequence the next event gets.
   *
   * The counter comes from the file, so it keeps counting across control-plane restarts, and it never repeats: the
   * oldest rows may be dropped, but the counter outlives them.
   */
  nextEventSeq(): number {
    this.sequence += 1
    return this.sequence
  }

  /** The sequence the log gave its last event. */
  lastEventSeq(): number { return this.sequence }

  /**
   * Record one event under the sequence it was given.
   *
   * The sequence is written by the caller, so the whole event — the sequence included — can be stored as one payload and
   * read back exactly as a subscriber saw it.
   */
  appendEvent(row: Omit<ConsoleEventRow, 'seq'> & { seq: number }): number {
    this.db.prepare(
      'INSERT INTO event_log (seq, at, node_id, node_seq, session_id, type, kind, payload) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.seq, row.at, row.nodeId, row.nodeSeq ?? null, row.sessionId, row.type, row.kind, row.payload)
    if (row.seq > this.sequence) this.sequence = row.seq
    return row.seq
  }

  /**
   * The events after a sequence, and the gap a client has to know about.
   *
   * `gapFrom` is the first sequence the log no longer holds: the events between the client's own sequence and it were
   * dropped, and a client that needs them has to be told rather than left with a history that starts later.
   */
  eventsAfter(after: number, limit = 1000): { rows: ConsoleEventRow[]; gapFrom?: number } {
    const earliest = this.db.prepare('SELECT MIN(seq) AS seq FROM event_log').get()
    const first = earliest === undefined || earliest.seq === null || earliest.seq === undefined
      ? undefined : numberOf(earliest.seq)
    const rows = this.db.prepare(
      'SELECT seq, at, node_id, node_seq, session_id, type, kind, payload FROM event_log WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(after, limit)
    const gapFrom = first !== undefined && first > after + 1 ? after + 1 : undefined
    return { rows: rows.map(row => this.eventRow(row)), ...(gapFrom === undefined ? {} : { gapFrom }) }
  }

  /** The message events of one Session, oldest first: the conversation the console shows. */
  messagesFor(sessionId: string, limit = 200): ConsoleEventRow[] {
    return this.db.prepare(
      'SELECT seq, at, node_id, node_seq, session_id, type, kind, payload FROM event_log WHERE session_id = ? AND kind = ? ORDER BY seq LIMIT ?')
      .all(sessionId, 'message', limit).map(row => this.eventRow(row))
  }

  /** The sequence the log will give its next event: the counter of the file, which never goes back. */
  private readSequence(): number {
    try {
      const counter = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'event_log'").get()
      if (counter !== undefined && counter.seq !== null && counter.seq !== undefined) return numberOf(counter.seq)
    } catch {
      // A file without an autoincrement counter yet has no row in `sqlite_sequence`; the newest event is the same answer.
    }
    const newest = this.db.prepare('SELECT MAX(seq) AS seq FROM event_log').get()
    return newest === undefined || newest.seq === null || newest.seq === undefined ? 0 : numberOf(newest.seq)
  }

  /** How many events the log holds right now. */
  eventCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM event_log').get()
    return row === undefined || row.count === null || row.count === undefined ? 0 : numberOf(row.count)
  }

  /** Record one audit entry and return its sequence. */
  writeAudit(row: Omit<ConsoleAuditRow, 'seq'>): number {
    const result = this.db.prepare(
      'INSERT INTO audit (at, actor, kind, action, target_kind, target_id, outcome, detail) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.at, row.actor, row.kind, row.action, row.targetKind, row.targetId, row.outcome, row.detail)
    return numberOf(result.lastInsertRowid)
  }

  /** The audit entries, newest first; a kind narrows them to one vocabulary. */
  auditEntries(options: { limit?: number; kind?: string } = {}): ConsoleAuditRow[] {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 500))
    const rows = options.kind === undefined
      ? this.db.prepare('SELECT seq, at, actor, kind, action, target_kind, target_id, outcome, detail FROM audit ORDER BY seq DESC LIMIT ?')
        .all(limit)
      : this.db.prepare('SELECT seq, at, actor, kind, action, target_kind, target_id, outcome, detail FROM audit WHERE kind = ? ORDER BY seq DESC LIMIT ?')
        .all(options.kind, limit)
    return rows.map(row => this.auditRow(row))
  }

  /** How many audit entries the trail holds. */
  auditCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM audit').get()
    return row === undefined || row.count === null || row.count === undefined ? 0 : numberOf(row.count)
  }

  /**
   * Record one entry of a Project's own memory.
   *
   * The entries are facts of that Project alone: they are read by the Project's PM and by nobody else. The table keeps
   * them apart from the domain's own state, so writing one never touches a Ticket, an Assignment or a Project.
   */
  addMemory(row: { projectId: string; at: string; actor: string; text: string }): number {
    const result = this.db.prepare(
      'INSERT INTO project_memory (project_id, at, actor, text) VALUES (?,?,?,?)')
      .run(row.projectId, row.at, row.actor, row.text)
    return numberOf(result.lastInsertRowid)
  }

  /**
   * The entries of one Project's memory, newest first.
   *
   * The bound is the caller's: the PM reads a bounded slice, and the console shows the same slice, so a Project with a
   * long history never turns into an unbounded answer.
   */
  memories(projectId: string, limit = 20): ProjectMemoryRow[] {
    const rows = this.db.prepare(
      'SELECT id, project_id, at, actor, text FROM project_memory WHERE project_id = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, limit)
    return rows.map(row => ({ id: numberOf(row.id), projectId: stringOf(row.project_id), at: stringOf(row.at),
      actor: stringOf(row.actor), text: stringOf(row.text) }))
  }

  /** How many entries one Project's memory holds. */
  memoryCount(projectId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM project_memory WHERE project_id = ?').get(projectId)
    return row === undefined || row.count === null || row.count === undefined ? 0 : numberOf(row.count)
  }

  /**
   * Drop the entries a Project's memory may no longer keep.
   *
   * Only the newest ones stay: a memory is a note for the PM, not a log, and an unbounded one would grow the file
   * without telling anybody anything.
   */
  pruneMemories(projectId: string, keep = 200): void {
    this.db.prepare(
      'DELETE FROM project_memory WHERE project_id = ? AND id <= (SELECT MAX(id) FROM project_memory WHERE project_id = ?) - ?')
      .run(projectId, projectId, keep)
  }

  /** Record one run of the reconciliation and return its id. */
  writeReconcileRun(row: Omit<ReconcileRunRow, 'id'>): number {
    const result = this.db.prepare(
      'INSERT INTO reconcile_run (at, node_online, checked, findings, counts, boundary) VALUES (?,?,?,?,?,?)')
      .run(row.at, row.nodeOnline ? 1 : 0, row.checked, row.findings, row.counts, row.boundary)
    return numberOf(result.lastInsertRowid)
  }

  /** The runs of the reconciliation, newest first. */
  reconcileRuns(limit = 10): ReconcileRunRow[] {
    const rows = this.db.prepare(
      'SELECT id, at, node_online, checked, findings, counts, boundary FROM reconcile_run ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(Math.trunc(limit), 100)))
    return rows.map(row => ({ id: numberOf(row.id), at: stringOf(row.at), nodeOnline: numberOf(row.node_online) !== 0,
      checked: numberOf(row.checked), findings: stringOf(row.findings), counts: stringOf(row.counts),
      boundary: stringOf(row.boundary) }))
  }

  /**
   * Drop what the log may no longer keep.
   *
   * The events are bounded twice: by their number and by their age. The audit is bounded by its age alone, and an age of
   * `0` keeps it forever. The sequence of the log is never reused: the file's own counter outlives every dropped row.
   */
  prune(now: string): void {
    this.db.prepare('DELETE FROM event_log WHERE seq <= (SELECT MAX(seq) FROM event_log) - ?').run(this.eventRows)
    if (this.eventDays > 0) {
      this.db.prepare('DELETE FROM event_log WHERE at < ?').run(this.olderThan(now, this.eventDays))
    }
    if (this.auditDays > 0) {
      this.db.prepare('DELETE FROM audit WHERE at < ?').run(this.olderThan(now, this.auditDays))
    }
  }

  /** One value of the console's own settings. */
  meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM console_meta WHERE key = ?').get(key)
    return row === undefined || row.value === null || row.value === undefined ? undefined : stringOf(row.value)
  }

  /** Write one value of the console's own settings. */
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO console_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  /** The moment `days` days before `now`, in the same ISO form the rows carry. */
  private olderThan(now: string, days: number): string {
    const moment = new Date(now).getTime()
    if (!Number.isFinite(moment)) return now
    return new Date(moment - days * 86_400_000).toISOString()
  }

  /** One event row, as this store hands it out. */
  private eventRow(row: Record<string, unknown>): ConsoleEventRow {
    const nodeSeq = row.node_seq === null || row.node_seq === undefined ? undefined : numberOf(row.node_seq)
    return { seq: numberOf(row.seq), at: stringOf(row.at), nodeId: stringOf(row.node_id), sessionId: stringOf(row.session_id),
      type: stringOf(row.type), kind: stringOf(row.kind), payload: stringOf(row.payload),
      ...(nodeSeq === undefined ? {} : { nodeSeq }) }
  }

  /** One audit row, as this store hands it out. */
  private auditRow(row: Record<string, unknown>): ConsoleAuditRow {
    return { seq: numberOf(row.seq), at: stringOf(row.at), actor: stringOf(row.actor), kind: stringOf(row.kind),
      action: stringOf(row.action), targetKind: stringOf(row.target_kind), targetId: stringOf(row.target_id),
      outcome: stringOf(row.outcome), detail: stringOf(row.detail) }
  }
}
