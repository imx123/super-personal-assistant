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

/**
 * One notice about a stop, written for the logical superior of the stopped work.
 *
 * The notice is the control plane's own durable fact: a PM that was stopped, a Worker that was stopped and a Ticket
 * that was cancelled each leave one behind, so the superior — the Router, the PM, or the operator — can read what
 * happened without the work itself having to carry it.
 *
 * The notice names the target, the scope, what the stop affected, what it left running, who acted and when. It names
 * nothing else: the ids it carries belong to the one Project the stopped work was part of, so a notice never carries
 * another Project's data.
 */
export interface StopNoticeRow {
  /** The notice's own id, newest last. */
  id: number
  /** When the stop was recorded. */
  at: string
  /** What was stopped: `session`, `assignment` or `ticket`. */
  targetKind: string
  /** The id of the stopped thing. */
  targetId: string
  /** The Session the stop was about, when there is one. */
  sessionId: string
  /** The scope of the stop: `session`, `assignment` or `ticket`. */
  scope: string
  /** `requested` until the node confirmed the stop; `confirmed` afterwards. */
  state: string
  /** Who stopped it. */
  actor: string
  /** The Project the stopped work belonged to, when it had one. */
  projectId: string
  /** What the stop affected, as JSON. */
  affected: string
  /** What the stop left running, as JSON. */
  unaffected: string
  /** Who may read the notice: `pm`, `router` or `operator`. */
  superiorKind: string
  /** The Session of the superior, when the superior is one. */
  superiorId: string
  /** The redacted diagnostic of a stop the node did not confirm. */
  error: string
}

/**
 * One message the Fast Router claimed, and what became of it.
 *
 * The row is the durable half of the fast route: it names the request the message was, the rule that read it, the target
 * the rule found and how far the message actually got. It is written before the action begins, so a control plane that
 * died in the middle leaves the fact behind instead of repeating the action, and it is keyed by the request id, so the
 * same message never becomes two.
 */
export interface FastRouteRow {
  /** The row's own order; the oldest row was routed first. */
  seq: number
  /** The Router request this routing is; the message's own id, so the same message is routed once. */
  requestId: string
  /** When the message was accepted. */
  at: string
  /** The person's own words. */
  text: string
  /** What the rule decided: `existing_ticket`, `existing_project_pm`, `standalone_ticket`, `read_only`, `escalate` or `ordinary_reply`. */
  outcome: string
  /** How far the message got: `accepted`, `routing`, `queued`, `assigned`, `escalated`, `failed` or `unconfirmed`. */
  stage: string
  /** How sure the rule was, in hundredths. */
  confidence: number
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** Whether the target was a `ticket` or a `project`; empty when there was none. */
  targetKind: string
  /** The id of the target. */
  targetId: string
  /** The title of the target. */
  targetTitle: string
  /** The Ticket the work landed in, when one was created or addressed. */
  ticketId: string
  /** The Worker Session of that Ticket, when it is known. */
  sessionId: string
  /** The title of the Ticket a standalone task was to become. */
  ticketTitle: string
  /** The goal of the Ticket a standalone task was to become. */
  ticketGoal: string
  /** Why it failed, when it failed. */
  error: string
}

/**
 * One decision of the Project Gate, and what became of it.
 *
 * The row is the durable half of the gate: it names the human request the decision was made for, the four findings and the
 * modules they were made of, the reason the gate gave, and — when a Project really was created — the Project and the PM
 * that belong to it. A refusal is a row as well: it says that nothing was created and why, so a person may ask later why
 * their request did not become a Project.
 *
 * The attempt number keeps every try of one request: a decision that was refused may be tried again with a better one, and
 * both tries are facts. The request id and the attempt together are unique, so one try is recorded once.
 */
export interface ProjectGateRow {
  /** The row's own order; the oldest row was decided first. */
  seq: number
  /** The Router request this decision was made for; the message's own id. */
  requestId: string
  /** Which try of that request this is, counting from one. */
  attempt: number
  /** When the decision was made. */
  at: string
  /** The person's own words. */
  text: string
  /** The title the decision would have given the Project. */
  title: string
  /** The goal the decision would have given the Project. */
  goal: string
  /** What became of it: `created`, `refused` or `failed`. */
  outcome: string
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** The four findings, as JSON. */
  conditions: string
  /** The modules, as JSON. */
  modules: string
  /** The condition that failed, when one did. */
  failedCondition: string
  /** The Project the request named outright, as JSON, when it named one. */
  existingProject: string
  /** The Project that was created, when one was. */
  projectId: string
  /** The PM Session of that Project, when there is one. */
  pmSessionId: string
  /** The state of that PM Session, as the control plane knows it. */
  pmStatus: string
  /** Why it failed, when it failed. */
  error: string
}

/**
 * One handoff of a request to a Project's PM, and what became of it.
 *
 * The row is the durable half of the high-level handoff: it names the request the work came from, the Project it goes
 * to, the PM Session that received it, the words that really travelled and how far the delivery got. It is written
 * before anything is sent, so a control plane that died in the middle leaves the fact behind instead of sending the
 * same work twice, and the request id is unique, so one request may only ever reach one PM.
 *
 * The `kind` tells the two handoffs apart: a `handoff` is the high-level Router's own decision to give a request to the
 * PM of a Project that already existed, and a `brief` is the work brief the Project Gate publishes to the PM of the
 * Project it just created.
 */
export interface RouterHandoffRow {
  /** The row's own order; the oldest row was handed over first. */
  seq: number
  /** The Router request this handoff is; the message's own id, so the same message is handed over once. */
  requestId: string
  /** Which kind of handoff this is: `handoff` or `brief`. */
  kind: string
  /** When the decision was made. */
  at: string
  /** The person's own words. */
  text: string
  /** The Project the work goes to. */
  projectId: string
  /** The title of that Project, as the console shows it. */
  projectTitle: string
  /** The PM Session that received the work. */
  pmSessionId: string
  /** The words that really travelled to that PM. */
  instruction: string
  /** The short, checkable reason the Router gave. */
  rationale: string
  /** How far the handoff got: `accepted`, `routing`, `queued`, `assigned`, `refused`, `failed` or `unconfirmed`. */
  stage: string
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** Why it failed, when it failed. */
  error: string
}

/**
 * One message a person sent to the Router, and what became of it.
 *
 * The row is the control plane's own durable fact about a message that is on its way to the Router. It exists because
 * the Router's inbox is the node's, not the control plane's: without a row of its own, a message that waited, failed or
 * was read would be visible only while the process lived, and a console that reloaded would show a queue it cannot
 * explain.
 *
 * `state` says what really happened: `queued` while the message waits for its turn, `sent` once the node took it into
 * the Session's inbox, `read` once a turn of that Session took it, and `failed` when the node refused it. The inbox and
 * the turn are two different facts, and the row keeps them apart.
 */
export interface RouterQueueRow {
  /** The message's own id: the stable Input id the node reports it under. */
  id: string
  /** The queue's own order; the oldest row is delivered first. */
  seq: number
  /** When the person sent it. */
  at: string
  /** The person's own words. */
  text: string
  /** The files the message carried, as JSON. */
  attachments: string
  /** The model the message asked for, as JSON; empty when it asked for none. */
  model: string
  /** The Router request the message is; the Router names this id when it proposes something for it. */
  requestId: string
  /**
   * What became of the message.
   *
   * The states are facts about different moments, and the queue keeps them apart: `queued` while the message waits for
   * its turn, `sending` while it is on its way to the node, `sent` once the node took it into the Session's inbox,
   * `read` once a turn of that Session took it, `failed` when the node refused it, `unconfirmed` when the control
   * plane cannot say whether it arrived — a restart in the middle of a delivery leaves exactly that fact behind — and
   * `routed` when the Fast Router carried the message out itself, so it never goes to the Router at all.
   */
  state: string
  /** Why the delivery failed, or why it still waits; empty when there is nothing to say. */
  error: string
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

/**
 * How many stop notices the file keeps.
 *
 * A notice is a fact about a stop that a superior has to be able to read; it is not a log of every action the control
 * plane ever took. The newest ones are the ones that matter, and the bound keeps the file from growing without limit.
 */
export const DEFAULT_STOP_NOTICES = 1000

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
CREATE TABLE IF NOT EXISTS stop_notice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, session_id TEXT NOT NULL,
  scope TEXT NOT NULL, state TEXT NOT NULL, actor TEXT NOT NULL, project_id TEXT NOT NULL,
  affected TEXT NOT NULL, unaffected TEXT NOT NULL, superior_kind TEXT NOT NULL, superior_id TEXT NOT NULL,
  error TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS stop_notice_at ON stop_notice(at);
CREATE INDEX IF NOT EXISTS stop_notice_superior ON stop_notice(superior_kind, superior_id, id);
CREATE TABLE IF NOT EXISTS router_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, text TEXT NOT NULL, attachments TEXT NOT NULL,
  model TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS router_queue_state ON router_queue(state, seq);
CREATE TABLE IF NOT EXISTS fast_route (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, text TEXT NOT NULL,
  outcome TEXT NOT NULL, stage TEXT NOT NULL, confidence INTEGER NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL,
  target_kind TEXT NOT NULL, target_id TEXT NOT NULL, target_title TEXT NOT NULL,
  ticket_id TEXT NOT NULL, session_id TEXT NOT NULL, ticket_title TEXT NOT NULL, ticket_goal TEXT NOT NULL,
  error TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS fast_route_stage ON fast_route(stage, seq);
CREATE TABLE IF NOT EXISTS project_gate (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL, attempt INTEGER NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL,
  title TEXT NOT NULL, goal TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL,
  conditions TEXT NOT NULL, modules TEXT NOT NULL, failed_condition TEXT NOT NULL, existing_project TEXT NOT NULL,
  project_id TEXT NOT NULL, pm_session_id TEXT NOT NULL, pm_status TEXT NOT NULL, error TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS project_gate_attempt ON project_gate(request_id, attempt);
CREATE INDEX IF NOT EXISTS project_gate_request ON project_gate(request_id, seq);
CREATE TABLE IF NOT EXISTS router_handoff (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL,
  project_id TEXT NOT NULL, project_title TEXT NOT NULL, pm_session_id TEXT NOT NULL,
  instruction TEXT NOT NULL, rationale TEXT NOT NULL,
  stage TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL, error TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS router_handoff_stage ON router_handoff(stage, seq);
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

  writeTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

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

  /**
   * The events of one Session between two sequences, newest first.
   *
   * The range is read newest first on purpose: a digest is the *latest* increment of a Session's activity, so a long
   * silence produces the newest facts rather than the oldest ones, and the caller may still move its watermark past the
   * whole range. The rows are capped by the caller, and a payload that cannot be parsed is the caller's to skip.
   */
  sessionEventsBetween(sessionId: string, after: number, upTo: number, limit: number): ConsoleEventRow[] {
    const rows = this.db.prepare(
      'SELECT seq, at, node_id, node_seq, session_id, type, kind, payload FROM event_log '
      + 'WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq DESC LIMIT ?')
      .all(sessionId, after, upTo, Math.max(1, Math.min(limit, 5000)))
    return rows.map(row => this.eventRow(row))
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
   * Record one notice about a stop, for the logical superior of the stopped work.
   *
   * The notice is written in the console's own file, so it survives a restart of the control plane and outlives the
   * Session it is about. Nothing else is written with it: no Project, no Ticket and no Assignment changes because a
   * notice was recorded.
   */
  addStopNotice(row: Omit<StopNoticeRow, 'id'>): number {
    const result = this.db.prepare(
      'INSERT INTO stop_notice (at, target_kind, target_id, session_id, scope, state, actor, project_id,'
      + ' affected, unaffected, superior_kind, superior_id, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.at, row.targetKind, row.targetId, row.sessionId, row.scope, row.state, row.actor, row.projectId,
        row.affected, row.unaffected, row.superiorKind, row.superiorId, row.error)
    return numberOf(result.lastInsertRowid)
  }

  /**
   * The notices about stops, newest first.
   *
   * A superior reads the notices meant for it: the PM of a Project reads the ones about that Project's own work, the
   * Router reads the ones about the Sessions it is the superior of, and the operator reads them all. The filter is
   * what keeps one Project's notice out of another Project's PM.
   */
  stopNotices(filter: { limit?: number; superiorKind?: string; superiorId?: string; projectId?: string } = {}): StopNoticeRow[] {
    const limit = Math.max(1, Math.min(Math.trunc(filter.limit ?? 50), 500))
    const clauses: string[] = []
    const values: (string | number)[] = []
    if (filter.superiorKind !== undefined) {
      clauses.push('superior_kind = ?')
      values.push(filter.superiorKind)
    }
    if (filter.superiorId !== undefined) {
      clauses.push('superior_id = ?')
      values.push(filter.superiorId)
    }
    if (filter.projectId !== undefined) {
      clauses.push('project_id = ?')
      values.push(filter.projectId)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const rows = this.db.prepare(
      'SELECT id, at, target_kind, target_id, session_id, scope, state, actor, project_id, affected, unaffected,'
      + ` superior_kind, superior_id, error FROM stop_notice${where} ORDER BY id DESC LIMIT ?`)
      .all(...values, limit)
    return rows.map(row => ({ id: numberOf(row.id), at: stringOf(row.at), targetKind: stringOf(row.target_kind),
      targetId: stringOf(row.target_id), sessionId: stringOf(row.session_id), scope: stringOf(row.scope),
      state: stringOf(row.state), actor: stringOf(row.actor), projectId: stringOf(row.project_id),
      affected: stringOf(row.affected), unaffected: stringOf(row.unaffected), superiorKind: stringOf(row.superior_kind),
      superiorId: stringOf(row.superior_id), error: stringOf(row.error) }))
  }

  /**
   * Record one message a person sent to the Router, and return its place in the queue.
   *
   * The row is written before the message reaches the node, so a message that never left is still a fact the console can
   * show: an interjection is never lost because the node was busy, offline or slow. The id is unique, and a message that
   * is already in the queue keeps its row: the same id is the same message, however many times it is sent.
   */
  addRouterMessage(row: Omit<RouterQueueRow, 'seq'>): number {
    const result = this.db.prepare(
      'INSERT INTO router_queue (id, at, text, attachments, model, request_id, state, error)'
      + ' VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(row.id, row.at, row.text, row.attachments, row.model, row.requestId, row.state, row.error)
    return numberOf(result.lastInsertRowid)
  }

  /**
   * The messages the Router's queue holds.
   *
   * `states` narrows the answer to the ones in the given state; the queue itself is read without it. The rows are
   * ordered oldest first, which is the order they are delivered in; `newest` asks for the other order, which is what a
   * console shows. The rows are bounded by the caller, and the oldest are dropped first: a message that was read long
   * ago is history, not a task.
   */
  routerMessages(options: { limit?: number; states?: readonly string[]; newest?: boolean } = {}): RouterQueueRow[] {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 200))
    const order = options.newest === true ? 'DESC' : 'ASC'
    const rows = options.states === undefined || options.states.length === 0
      ? this.db.prepare(
        `SELECT seq, id, at, text, attachments, model, request_id, state, error FROM router_queue ORDER BY seq ${order} LIMIT ?`)
        .all(limit)
      : this.db.prepare(
        'SELECT seq, id, at, text, attachments, model, request_id, state, error FROM router_queue'
        + ` WHERE state IN (${options.states.map(() => '?').join(',')}) ORDER BY seq ${order} LIMIT ?`)
        .all(...options.states, limit)
    return rows.map(row => this.routerQueueRow(row))
  }

  /** The row of one message, when the queue still holds it. */
  routerMessage(id: string): RouterQueueRow | undefined {
    const row = this.db.prepare(
      'SELECT seq, id, at, text, attachments, model, request_id, state, error FROM router_queue WHERE id = ?').get(id)
    return row === undefined ? undefined : this.routerQueueRow(row)
  }

  /**
   * Write what became of one message.
   *
   * The state and the diagnostic are the only things that change: the text the person wrote and the id the node knows it
   * by never do, so a row that is read again still says the same thing.
   */
  updateRouterMessage(id: string, patch: { state?: string; error?: string }): void {
    const current = this.routerMessage(id)
    if (!current) return
    this.db.prepare('UPDATE router_queue SET state = ?, error = ? WHERE id = ?')
      .run(patch.state ?? current.state, patch.error ?? current.error, id)
  }

  /**
   * Drop what the queue may no longer keep: the rows that really ended long ago.
   *
   * Only a row with a final state may go: a message that still waits, that is on its way, or whose outcome the control
   * plane does not know, is a task and not history. The oldest final rows go first, and a message that has not been
   * delivered yet is never dropped — a queue that silently forgot a person's words would deliver them never.
   */
  pruneRouterMessages(keep = 200): void {
    const rows = this.db.prepare(
      "SELECT seq FROM router_queue WHERE state IN ('read','failed','routed') ORDER BY seq DESC").all()
    const doomed = rows.slice(keep).map(row => numberOf(row.seq))
    if (doomed.length === 0) return
    const remove = this.db.prepare('DELETE FROM router_queue WHERE seq = ?')
    for (const seq of doomed) remove.run(seq)
  }

  /**
   * How many messages the queue holds in the given states.
   *
   * The count is what keeps the queue bounded: a person who sends more than the queue may hold is told so before the
   * message is accepted, and the messages that are already there are never pushed out to make room.
   */
  routerMessageCount(states: readonly string[]): number {
    if (states.length === 0) return 0
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM router_queue WHERE state IN (${states.map(() => '?').join(',')})`).get(...states)
    return row === undefined ? 0 : numberOf(row.count)
  }

  /**
   * Write one routing the Fast Router claimed.
   *
   * The request id is the message's own id, and it is unique: a message that arrives twice writes one row, and the second
   * write leaves the first one alone. The row is written before the action begins, so a control plane that died in the
   * middle of the action finds the fact when it comes back.
   */
  addFastRoute(row: Omit<FastRouteRow, 'seq'>): FastRouteRow {
    this.db.prepare('INSERT OR IGNORE INTO fast_route'
      + ' (request_id, at, text, outcome, stage, confidence, reason, detail,'
      + ' target_kind, target_id, target_title, ticket_id, session_id, ticket_title, ticket_goal, error)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.requestId, row.at, row.text, row.outcome, row.stage, row.confidence, row.reason, row.detail,
        row.targetKind, row.targetId, row.targetTitle, row.ticketId, row.sessionId, row.ticketTitle, row.ticketGoal,
        row.error)
    return this.fastRoute(row.requestId)!
  }

  /** The row of one routing, when the file still holds it. */
  fastRoute(requestId: string): FastRouteRow | undefined {
    const row = this.db.prepare('SELECT seq, request_id, at, text, outcome, stage, confidence, reason, detail,'
      + ' target_kind, target_id, target_title, ticket_id, session_id, ticket_title, ticket_goal, error'
      + ' FROM fast_route WHERE request_id = ?')
      .get(requestId)
    return row === undefined ? undefined : this.fastRouteRow(row)
  }

  /**
   * The routings the file holds, newest first.
   *
   * The console shows them in the order they were made, so a person reads what happened to their messages in the order
   * they wrote them.
   */
  fastRoutes(options: { limit?: number; newest?: boolean } = {}): FastRouteRow[] {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 200))
    const order = options.newest === true ? 'DESC' : 'ASC'
    const rows = this.db.prepare('SELECT seq, request_id, at, text, outcome, stage, confidence, reason, detail,'
      + ' target_kind, target_id, target_title, ticket_id, session_id, ticket_title, ticket_goal, error FROM fast_route'
      + ` ORDER BY seq ${order} LIMIT ?`).all(limit)
    return rows.map(row => this.fastRouteRow(row))
  }

  /**
   * Write what became of one routing.
   *
   * Only the facts that move change: the words the person wrote and the id of the request stay, so a row that is read
   * again still says the same thing. The `detail` is the wording of the rule, and it becomes the answer itself when the
   * rule answered a question from the record.
   */
  updateFastRoute(requestId: string, patch: { stage?: string; error?: string; ticketId?: string; sessionId?: string;
    detail?: string }): void {
    const current = this.fastRoute(requestId)
    if (!current) return
    this.db.prepare('UPDATE fast_route SET stage = ?, error = ?, ticket_id = ?, session_id = ?, detail = ?'
      + ' WHERE request_id = ?')
      .run(patch.stage ?? current.stage, patch.error ?? current.error, patch.ticketId ?? current.ticketId,
        patch.sessionId ?? current.sessionId, patch.detail ?? current.detail, requestId)
  }

  /**
   * The routings that named one Ticket.
   *
   * They are the ones that wait for that Ticket's Worker: the routing that started it and the routing that continues it.
   */
  fastRoutesOfTicket(ticketId: string): FastRouteRow[] {
    const rows = this.db.prepare('SELECT seq, request_id, at, text, outcome, stage, confidence, reason, detail,'
      + ' target_kind, target_id, target_title, ticket_id, session_id, ticket_title, ticket_goal, error'
      + ' FROM fast_route WHERE ticket_id = ? ORDER BY seq ASC').all(ticketId)
    return rows.map(row => this.fastRouteRow(row))
  }

  /**
   * Drop the routings the file may no longer keep.
   *
   * Only a routing that came to rest may go: one that is still on its way, or whose outcome the control plane does not
   * know, is a task and not history.
   */
  pruneFastRoutes(keep = 200): void {
    const rows = this.db.prepare(
      "SELECT seq FROM fast_route WHERE stage IN ('queued','assigned','escalated','model','failed','unconfirmed')"
      + ' ORDER BY seq DESC').all()
    const doomed = rows.slice(keep).map(row => numberOf(row.seq))
    if (doomed.length === 0) return
    const remove = this.db.prepare('DELETE FROM fast_route WHERE seq = ?')
    for (const seq of doomed) remove.run(seq)
  }

  /**
   * Record one decision of the Project Gate.
   *
   * The row is written before anything is created, so a control plane that died in the middle leaves the fact behind
   * instead of creating a second Project when it comes back. The request id and the attempt are unique together: one try
   * of one request is recorded once.
   */
  addProjectGate(row: Omit<ProjectGateRow, 'seq'>): ProjectGateRow {
    this.db.prepare('INSERT OR IGNORE INTO project_gate'
      + ' (request_id, attempt, at, text, title, goal, outcome, reason, detail,'
      + ' conditions, modules, failed_condition, existing_project, project_id, pm_session_id, pm_status, error)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.requestId, row.attempt, row.at, row.text, row.title, row.goal, row.outcome, row.reason, row.detail,
        row.conditions, row.modules, row.failedCondition, row.existingProject, row.projectId, row.pmSessionId,
        row.pmStatus, row.error)
    return this.projectGateRow(row.requestId, row.attempt)!
  }

  /**
   * Write what became of one decision.
   *
   * The Project and the PM it names are facts the control plane learned after the row was written; the reason and the
   * words stay as they were read.
   */
  updateProjectGate(requestId: string, attempt: number, patch: { outcome?: string; reason?: string; detail?: string
    projectId?: string; pmSessionId?: string; pmStatus?: string; error?: string }): void {
    const current = this.projectGateRow(requestId, attempt)
    if (!current) return
    this.db.prepare('UPDATE project_gate SET outcome = ?, reason = ?, detail = ?, project_id = ?,'
      + ' pm_session_id = ?, pm_status = ?, error = ? WHERE request_id = ? AND attempt = ?')
      .run(patch.outcome ?? current.outcome, patch.reason ?? current.reason, patch.detail ?? current.detail,
        patch.projectId ?? current.projectId, patch.pmSessionId ?? current.pmSessionId, patch.pmStatus ?? current.pmStatus,
        patch.error ?? current.error, requestId, attempt)
  }

  /** The decisions the file holds, newest first. */
  projectGates(options: { limit?: number; newest?: boolean } = {}): ProjectGateRow[] {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 200))
    const order = options.newest === true ? 'DESC' : 'ASC'
    const rows = this.db.prepare('SELECT seq, request_id, attempt, at, text, title, goal, outcome, reason, detail,'
      + ' conditions, modules, failed_condition, existing_project, project_id, pm_session_id, pm_status, error FROM project_gate'
      + ` ORDER BY seq ${order} LIMIT ?`).all(limit)
    return rows.map(row => this.projectGateRowOf(row))
  }

  /** Every try of one request, oldest first. */
  projectGatesOfRequest(requestId: string): ProjectGateRow[] {
    const rows = this.db.prepare('SELECT seq, request_id, attempt, at, text, title, goal, outcome, reason, detail,'
      + ' conditions, modules, failed_condition, existing_project, project_id, pm_session_id, pm_status, error FROM project_gate'
      + ' WHERE request_id = ? ORDER BY attempt ASC').all(requestId)
    return rows.map(row => this.projectGateRowOf(row))
  }

  /**
   * The try that really created a Project, when one did.
   *
   * It is what makes a repeated call idempotent: a second call for the same request finds the Project the first one made
   * instead of making another.
   */
  createdProjectGate(requestId: string): ProjectGateRow | undefined {
    const rows = this.projectGatesOfRequest(requestId)
    return rows.find(row => row.outcome === 'created')
  }

  /** One decision, by the request it was made for and the try it was. */
  private projectGateRow(requestId: string, attempt: number): ProjectGateRow | undefined {
    const row = this.db.prepare('SELECT seq, request_id, attempt, at, text, title, goal, outcome, reason, detail,'
      + ' conditions, modules, failed_condition, existing_project, project_id, pm_session_id, pm_status, error FROM project_gate'
      + ' WHERE request_id = ? AND attempt = ?').get(requestId, attempt)
    return row === undefined ? undefined : this.projectGateRowOf(row)
  }

  /**
   * Drop what the file may no longer keep.
   *
   * The decisions are bounded the same way the routings are: a decision that came to rest long ago is history, not a task.
   */
  pruneProjectGates(keep = 200): void {
    const rows = this.db.prepare("SELECT seq FROM project_gate ORDER BY seq DESC").all()
    const doomed = rows.slice(keep).map(row => numberOf(row.seq))
    if (doomed.length === 0) return
    const remove = this.db.prepare('DELETE FROM project_gate WHERE seq = ?')
    for (const seq of doomed) remove.run(seq)
  }

  /**
   * Write one handoff of a request to a Project's PM.
   *
   * The request id is unique: a request reaches one PM only. The row is written before the work is sent, so a control
   * plane that died in the middle leaves the fact behind instead of sending the same work to a PM a second time.
   *
   * A row that is already there is replaced when it is a refusal — a refusal sent nothing, so a decision that holds may
   * follow it — and left alone otherwise, so a delivery is never rewritten.
   */
  addRouterHandoff(row: Omit<RouterHandoffRow, 'seq'>): RouterHandoffRow {
    this.db.prepare('INSERT INTO router_handoff'
      + ' (request_id, kind, at, text, project_id, project_title, pm_session_id, instruction, rationale,'
      + ' stage, reason, detail, error)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      + ' ON CONFLICT(request_id) DO UPDATE SET kind = excluded.kind, at = excluded.at, text = excluded.text,'
      + ' project_id = excluded.project_id, project_title = excluded.project_title,'
      + ' pm_session_id = excluded.pm_session_id, instruction = excluded.instruction,'
      + ' rationale = excluded.rationale, stage = excluded.stage, reason = excluded.reason,'
      + ' detail = excluded.detail, error = excluded.error'
      + ' WHERE router_handoff.stage = \'refused\'')
      .run(row.requestId, row.kind, row.at, row.text, row.projectId, row.projectTitle, row.pmSessionId,
        row.instruction, row.rationale, row.stage, row.reason, row.detail, row.error)
    return this.routerHandoff(row.requestId)!
  }

  /** The row of one handoff, when the file still holds it. */
  routerHandoff(requestId: string): RouterHandoffRow | undefined {
    const row = this.db.prepare('SELECT seq, request_id, kind, at, text, project_id, project_title, pm_session_id,'
      + ' instruction, rationale, stage, reason, detail, error FROM router_handoff WHERE request_id = ?')
      .get(requestId)
    return row === undefined ? undefined : this.routerHandoffRow(row)
  }

  /** The handoffs the file holds, newest first. */
  routerHandoffs(options: { limit?: number; newest?: boolean } = {}): RouterHandoffRow[] {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 200))
    const order = options.newest === true ? 'DESC' : 'ASC'
    const rows = this.db.prepare('SELECT seq, request_id, kind, at, text, project_id, project_title, pm_session_id,'
      + ' instruction, rationale, stage, reason, detail, error FROM router_handoff'
      + ` ORDER BY seq ${order} LIMIT ?`).all(limit)
    return rows.map(row => this.routerHandoffRow(row))
  }

  /**
   * Write what became of one handoff.
   *
   * The words the person wrote and the target of the work stay as they were read; only the facts that move change, so a
   * row that is read again still says the same thing.
   */
  updateRouterHandoff(requestId: string, patch: { stage?: string; reason?: string; detail?: string
    pmSessionId?: string; error?: string }): void {
    const current = this.routerHandoff(requestId)
    if (!current) return
    this.db.prepare('UPDATE router_handoff SET stage = ?, reason = ?, detail = ?, pm_session_id = ?, error = ?'
      + ' WHERE request_id = ?')
      .run(patch.stage ?? current.stage, patch.reason ?? current.reason, patch.detail ?? current.detail,
        patch.pmSessionId ?? current.pmSessionId, patch.error ?? current.error, requestId)
  }

  /** One handoff, read back from its row. */
  private routerHandoffRow(row: Record<string, unknown>): RouterHandoffRow {
    return {
      seq: numberOf(row.seq),
      requestId: stringOf(row.request_id),
      kind: stringOf(row.kind),
      at: stringOf(row.at),
      text: stringOf(row.text),
      projectId: stringOf(row.project_id),
      projectTitle: stringOf(row.project_title),
      pmSessionId: stringOf(row.pm_session_id),
      instruction: stringOf(row.instruction),
      rationale: stringOf(row.rationale),
      stage: stringOf(row.stage),
      reason: stringOf(row.reason),
      detail: stringOf(row.detail),
      error: stringOf(row.error),
    }
  }

  /**
   * Drop the handoffs the file may no longer keep.
   *
   * A handoff that came to rest may go; one that is still on its way is a task and not history.
   */
  pruneRouterHandoffs(keep = 200): void {
    const rows = this.db.prepare(
      "SELECT seq FROM router_handoff WHERE stage IN ('queued','assigned','refused','failed','unconfirmed')"
      + ' ORDER BY seq DESC').all()
    const doomed = rows.slice(keep).map(row => numberOf(row.seq))
    if (doomed.length === 0) return
    const remove = this.db.prepare('DELETE FROM router_handoff WHERE seq = ?')
    for (const seq of doomed) remove.run(seq)
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
    // The notices are bounded by their number alone: a stop that a superior still has to read stays, an old one goes.
    this.db.prepare('DELETE FROM stop_notice WHERE id <= (SELECT MAX(id) FROM stop_notice) - ?').run(DEFAULT_STOP_NOTICES)
    // The Router's queue is bounded the same way: a message that was read or failed long ago is history, not a task.
    this.pruneRouterMessages()
    // The routings the Fast Router made are bounded the same way: one that came to rest long ago is history, not a task.
    this.pruneFastRoutes()
    // The decisions of the Project Gate are bounded the same way: one that came to rest long ago is history, not a task.
    this.pruneProjectGates()
    // The handoffs to a Project's PM are bounded the same way: one that came to rest long ago is history, not a task.
    this.pruneRouterHandoffs()
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

  /** One row of the Router's queue, as this store hands it out. */
  private routerQueueRow(row: Record<string, unknown>): RouterQueueRow {
    return { seq: numberOf(row.seq), id: stringOf(row.id), at: stringOf(row.at), text: stringOf(row.text),
      attachments: stringOf(row.attachments), model: stringOf(row.model), requestId: stringOf(row.request_id),
      state: stringOf(row.state), error: stringOf(row.error) }
  }

  /** One routing row, as this store hands it out. */
  private fastRouteRow(row: Record<string, unknown>): FastRouteRow {
    return { seq: numberOf(row.seq), requestId: stringOf(row.request_id), at: stringOf(row.at), text: stringOf(row.text),
      outcome: stringOf(row.outcome), stage: stringOf(row.stage), confidence: numberOf(row.confidence),
      reason: stringOf(row.reason), detail: stringOf(row.detail), targetKind: stringOf(row.target_kind),
      targetId: stringOf(row.target_id), targetTitle: stringOf(row.target_title), ticketId: stringOf(row.ticket_id),
      sessionId: stringOf(row.session_id), ticketTitle: stringOf(row.ticket_title), ticketGoal: stringOf(row.ticket_goal),
      error: stringOf(row.error) }
  }

  /** One decision of the Project Gate, as this store hands it out. */
  private projectGateRowOf(row: Record<string, unknown>): ProjectGateRow {
    return { seq: numberOf(row.seq), requestId: stringOf(row.request_id), attempt: numberOf(row.attempt),
      at: stringOf(row.at), text: stringOf(row.text), title: stringOf(row.title), goal: stringOf(row.goal),
      outcome: stringOf(row.outcome), reason: stringOf(row.reason), detail: stringOf(row.detail),
      conditions: stringOf(row.conditions), modules: stringOf(row.modules),
      failedCondition: stringOf(row.failed_condition), existingProject: stringOf(row.existing_project),
      projectId: stringOf(row.project_id),
      pmSessionId: stringOf(row.pm_session_id), pmStatus: stringOf(row.pm_status), error: stringOf(row.error) }
  }
}
