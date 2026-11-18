/**
 * The durable event history: the key facts of what this control plane did, kept beside the domain that did it.
 *
 * The index lives in the control plane's own file, next to the Tickets, the Projects and the coordination rows it points
 * at. That is what ADR-4 chose for the first version: the sources are all in that file, so the backup and the rollback
 * take one snapshot and the references cannot dangle because two files were restored in the wrong order. It is *not* the
 * console's `event_log`: that log is pruned after 20 000 rows or seven days, and a fact that is pruned away is gone. The
 * rows here are never pruned by age or by count, and nothing deletes them without a person's decision.
 *
 * What a row is: **one fact**. A Trigger arrived, an Assignment started, a result was reviewed, a person stopped a
 * Worker, a call was refused, a scheduled run finished. What a row is not: a transcript. The text of a report, the
 * arguments of a call, the body of a conversation and the path of a file never come here — the row names the record they
 * live in, so a reader can go to the source, and the summary says what happened in a sentence that is already redacted.
 * The redaction happens twice: when the row is written and when it is read, so a row that was written by an older version
 * of this module is still redacted on the way out.
 *
 * The scope is exact. A row belongs to a Ticket, a Project, a Session or an Assignment, and the five keys are kept
 * independently, so a reader may ask for a Ticket, for a Project or for the Session that made the call and get exactly
 * that. The scope of a *reader* is a different thing and never comes from the request: it is derived from the Session the
 * caller proved, the same way the live state derives it — a Worker reads its own current Ticket, a PM its own Project, the
 * Router the pool it manages. The reader's scope is applied in the SQL, before the page is cut, so a fact that is out of
 * scope is not counted, not paged past and not hinted at: the kinds the index holds and the moment it starts are told
 * from the same scope, so a reader of one Project never learns that another Project holds a kind it does not hold or
 * began earlier.
 *
 * Writing twice is writing once. Every row carries an idempotency key built from the kind, the scope, the stable id of
 * the source record and its ordinal, so a retried request, a replayed delivery and a restarted control plane write the
 * same row instead of a second one.
 *
 * The index starts where this module starts. Nothing before it is reconstructed and nothing is guessed: a reader is told
 * the oldest row the index holds, because the facts before that are not in here and never will be.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { latestAssignment, type DomainEvent, type ProjectProfile, type Ticket } from '../core/index.ts'
import { redact } from '../infra/redact.ts'
import type { SessionRecord } from '../shared/protocol.ts'

/** The kinds of fact the index holds. */
export type EventHistoryKind =
  | 'trigger'
  | 'dispatch'
  | 'handoff'
  | 'report'
  | 'review'
  | 'manual_stop'
  | 'denial'
  | 'schedule'
  | 'error'

/** The kinds of fact the index holds, in the order the contract names them. */
export const EVENT_HISTORY_KINDS: readonly EventHistoryKind[] = [
  'trigger', 'dispatch', 'handoff', 'report', 'review', 'manual_stop', 'denial', 'schedule', 'error',
]

/** The most rows one page may hold. */
export const EVENT_HISTORY_LIMIT = 100

/** The rows a page holds when the caller names no bound of its own. */
export const EVENT_HISTORY_DEFAULT_LIMIT = 50

/** The most characters a summary may hold. */
export const EVENT_HISTORY_SUMMARY_LIMIT = 500

/** The most characters the whole detail may hold. */
export const EVENT_HISTORY_DETAIL_LIMIT = 4000

/**
 * The table of the index.
 *
 * The shape is the contract's, column for column, and it is created the way every other table of this control plane is
 * created: idempotently, with `CREATE TABLE IF NOT EXISTS`, and without a version of its own. A database that was opened
 * before this module existed gets the table the first time it is opened after; a database that already has it keeps it.
 *
 * There is no second shape to move away from: this table arrived with this module, so a database that holds it holds
 * the whole of it. The table and its indexes are therefore one statement, and no column is added afterwards.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_history_index (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL,
  at TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  ticket_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  control_session_id TEXT NOT NULL DEFAULT '',
  assignment_id TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL DEFAULT '',
  backend_id TEXT NOT NULL DEFAULT '',
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_history_index_scope ON event_history_index(scope_key, at);
CREATE INDEX IF NOT EXISTS event_history_index_ticket ON event_history_index(ticket_id, at);
CREATE INDEX IF NOT EXISTS event_history_index_project ON event_history_index(project_id, at);
CREATE INDEX IF NOT EXISTS event_history_index_session ON event_history_index(control_session_id, at);
CREATE INDEX IF NOT EXISTS event_history_index_assignment ON event_history_index(assignment_id, at);
CREATE INDEX IF NOT EXISTS event_history_index_node ON event_history_index(node_id, at);
`

/**
 * The records the index is written from and read against.
 *
 * The service owns no state of its own: every fact comes from here, so a row can never be about a world that this control
 * plane does not hold.
 */
export interface EventHistoryHost {
  /** The control plane's own clock: the moment a fact happened and the moment it was written. */
  now(): string
  /** The node this control plane manages. */
  nodeId(): string
  /** The backend this control plane talks to. */
  backendId(): string
  /** The control-plane Session records. */
  sessions(): readonly SessionRecord[]
  /** The Tickets of the business store. */
  tickets(): readonly Ticket[]
  /** The Projects of the business store. */
  projects(): readonly ProjectProfile[]
  /** The id of the Session that is the Router of this control plane. */
  routerSessionId(): string
}

/** The scope of one fact: which keys it belongs to. Every key is independent of the others. */
export interface EventHistoryScope {
  readonly ticketId?: string
  readonly projectId?: string
  readonly controlSessionId?: string
  readonly assignmentId?: string
}

/** One fact, as the control plane hands it over. */
export interface EventHistoryFact {
  readonly kind: EventHistoryKind
  readonly scope: EventHistoryScope
  /** The record the fact comes from: `ticket`, `project`, `assignment`, `coordination_deliveries`, … */
  readonly sourceTable: string
  /** The stable id of that record. */
  readonly sourceId: string
  /** The ordinal of the fact within that record; the same fact twice carries the same ordinal. */
  readonly sourceSeq?: number
  /** One sentence about what happened. It is redacted before it is stored. */
  readonly summary: string
  /** The structured supplement. It is redacted before it is stored. */
  readonly detail?: Readonly<Record<string, unknown>>
}

/** One row of the index, as a reader sees it. */
export interface EventHistoryEntry {
  readonly seq: number
  readonly eventId: string
  readonly kind: EventHistoryKind
  /** When the fact happened: the control plane's own clock. */
  readonly at: string
  /** The scope the row belongs to. */
  readonly scopeKey: string
  readonly ticketId: string
  readonly projectId: string
  readonly controlSessionId: string
  readonly assignmentId: string
  readonly nodeId: string
  readonly backendId: string
  readonly sourceTable: string
  readonly sourceId: string
  readonly sourceSeq: number
  readonly summary: string
  readonly detail: Readonly<Record<string, unknown>>
}

/**
 * What one reader may read: the scopes it owns.
 *
 * A row is filed under one scope key — `ticket:<id>`, `project:<id>`, `assignment:<id>`, `control_session:<id>` or
 * `node:<id>` — and a reader owns a row when it owns that scope. The Tickets it owns are named as well, so a row that was
 * written before the Project was known is still its own: an older row names the Ticket and nothing else.
 */
export interface EventHistoryAuthority {
  /** Whether the reader may read every row of this control plane. */
  readonly all: boolean
  /** The scope keys the reader owns outright: `ticket:t1`, `project:p1`, `control_session:pm-1`. */
  readonly scopeKeys: readonly string[]
  /** The Tickets the reader owns: an older row that names only that Ticket is still its own. */
  readonly ticketIds: readonly string[]
}

/** One query: the exact keys to read, and how much of them. */
export interface EventHistoryQuery {
  readonly ticketId?: string
  readonly projectId?: string
  readonly controlSessionId?: string
  readonly assignmentId?: string
  readonly nodeId?: string
  readonly kind?: EventHistoryKind
  readonly limit?: number
  /** The page before this one: the keyset position of the last row of it. */
  readonly cursor?: string
  /** The order of the rows: newest first by default. */
  readonly order?: 'asc' | 'desc'
}

/** How much of the history one reader may really see. */
export interface EventHistoryCoverage {
  /** The oldest row the reader may see: its history starts here and nowhere earlier. */
  readonly since?: string
  /** The kinds the reader may see rows of. */
  readonly kinds: readonly EventHistoryKind[]
  /** The index is never cut by age or by count. */
  readonly trimmed: false
  /** The retention rule, in words a console may show. */
  readonly retention: string
}

/** One page of the index. */
export interface EventHistoryPage {
  readonly rows: readonly EventHistoryEntry[]
  /** The keyset position of the next page, when there is one. */
  readonly nextCursor?: string
  /** Whether more rows are in scope than this page holds. */
  readonly hasMore: boolean
  /** How many rows are in scope, in all. */
  readonly total: number
  readonly coverage: EventHistoryCoverage
}

/** Why a reader may not read the history at all. */
export type EventHistoryRefusalCode =
  | 'UNKNOWN_SESSION'
  | 'ROLE_MISMATCH'
  | 'NO_SCOPE'
  | 'ASSIGNMENT_UNAVAILABLE'
  | 'STALE_ASSIGNMENT'

/** The answer of a scoped read: the page, or the reason there is none. */
export type EventHistoryResult =
  | { readonly ok: true; readonly page: EventHistoryPage }
  | { readonly ok: false; readonly code: EventHistoryRefusalCode; readonly reason: string }

/** The scope one Session may read, or the reason it may read none. */
type EventHistoryScopeResult =
  | { readonly ok: true; readonly authority: EventHistoryAuthority }
  | { readonly ok: false; readonly code: EventHistoryRefusalCode; readonly reason: string }

/** A query the service will not answer as it was written. */
export class EventHistoryQueryError extends Error {
  constructor(readonly code: 'INVALID_CURSOR' | 'INVALID_LIMIT', message: string) {
    super(message)
    this.name = 'EventHistoryQueryError'
  }
}

/** The retention rule of the index, in words a console may show. */
const RETENTION_TEXT = '持久事件历史不按天数或行数裁剪，也不会自动删除；它随控制面的业务库一起备份与回滚。'

/**
 * The durable event history of one control plane.
 *
 * The service writes the facts the control plane's own paths produce and reads them back for one reader at a time. It
 * never starts a Session, never asks the node anything and never calls a model.
 */
export class EventHistoryService {
  constructor(private readonly db: DatabaseSync, private readonly host: EventHistoryHost,
    private readonly onError: (error: unknown) => void = () => {}) {
    this.migrate()
  }

  /**
   * Make sure the table is there, in the way every other table of this control plane is made.
   *
   * The migration is idempotent and owns no version: a database that already has the table keeps it, and a database that
   * was opened before this module existed gets it. There is no older shape of the table to move away from — it arrived
   * with this module — so nothing is rewritten and no column is added afterwards.
   */
  private migrate(): void {
    this.db.exec(SCHEMA)
  }

  // ─── writing ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Write one fact.
   *
   * The write never throws into the caller's path: an index that cannot be written must not undo the work that produced
   * the fact. The failure is reported instead, and the fact is lost — a gap that is real, not a silent one.
   */
  record(fact: EventHistoryFact): void {
    try {
      const scope = this.scopeOf(fact.scope)
      const sourceSeq = fact.sourceSeq ?? this.nextSeq(fact.kind, fact.sourceTable, fact.sourceId)
      const eventId = eventIdOf(fact.kind, scope.key, fact.sourceTable, fact.sourceId, sourceSeq)
      const at = this.host.now()
      const summary = redact(fact.summary).slice(0, EVENT_HISTORY_SUMMARY_LIMIT)
      const detail = JSON.stringify(redactDetail(fact.detail))
      this.db.prepare(`
        INSERT INTO event_history_index
          (event_id, event_kind, at, scope_key, ticket_id, project_id, control_session_id, assignment_id,
           node_id, backend_id, source_table, source_id, source_seq, summary, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `).run(
        eventId, fact.kind, at, scope.key, scope.ticketId, scope.projectId, scope.controlSessionId, scope.assignmentId,
        this.host.nodeId(), this.host.backendId(), fact.sourceTable, fact.sourceId, sourceSeq, summary, detail, at,
      )
    } catch (error) {
      this.onError(error)
    }
  }

  /**
   * The fact the domain itself committed.
   *
   * The domain says what happened inside the transaction that wrote it, so the row is written in the same transaction as
   * the work it describes: an Assignment that started, a review that was decided, a person who stopped a Worker, a stop
   * the Executor could not confirm, a handover of a Ticket. The rows carry the ids of the records they come from and
   * never their text.
   *
   * The same transaction is where the row is written, not a promise that the row is there: a write that fails is
   * reported, the fact is lost, and the work it describes stays committed. That gap is a real one and it is said out
   * loud instead of being hidden.
   */
  recordDomainEvent(event: DomainEvent): void {
    switch (event.type) {
      case 'assignment.started': {
        const { ticketId, assignmentId } = event.data
        this.record({
          kind: 'dispatch', scope: { ticketId, assignmentId, ...this.scopeOfTicket(ticketId) },
          sourceTable: 'assignment', sourceId: assignmentId, sourceSeq: 0,
          summary: '派工：Worker 开始执行这次尝试。',
          detail: { assignmentId },
        })
        return
      }
      case 'ticket.reviewDecided': {
        const { ticketId, assignmentId, reviewId, decision } = event.data
        this.record({
          kind: 'review', scope: { ticketId, assignmentId, ...this.scopeOfTicket(ticketId) },
          sourceTable: 'ticket', sourceId: reviewId, sourceSeq: 0,
          summary: decision === 'accepted' ? '评审：PM 验收通过。' : '评审：PM 打回返工。',
          detail: { reviewId, assignmentId, decision },
        })
        return
      }
      case 'ticket.manualStopSet': {
        const { ticketId, scope } = event.data
        this.record({
          kind: 'manual_stop', scope: { ticketId, ...this.scopeOfTicket(ticketId) },
          sourceTable: 'ticket', sourceId: ticketId,
          summary: scope === 'project' ? '人工停止：项目范围，Worker 已被叫停。' : '人工停止：Worker 已被叫停。',
          detail: { scope },
        })
        return
      }
      case 'ticket.stopFailed': {
        const { ticketId, assignmentId, error } = event.data
        this.record({
          kind: 'error', scope: { ticketId, assignmentId, ...this.scopeOfTicket(ticketId) },
          sourceTable: 'ticket', sourceId: assignmentId,
          summary: '失败：这次停止没有确认成功。',
          detail: { code: 'stop_failed', assignmentId, diagnostic: error },
        })
        return
      }
      case 'ticket.handedOff': {
        const { ticketId, handoffId, kind, toTicketId, toSessionId } = event.data
        this.record({
          kind: 'handoff', scope: { ticketId, controlSessionId: toSessionId, ...this.scopeOfTicket(ticketId) },
          sourceTable: 'ticket', sourceId: handoffId, sourceSeq: 0,
          summary: kind === 'transfer' ? '交接：这张工单交给了另一个 Worker。' : '交接：这张工单被拆成了另一张。',
          detail: { handoffId, toTicketId, toSessionId, kind },
        })
        return
      }
      default:
        return
    }
  }

  /** A Trigger arrived and became work: a Project or a Ticket. */
  recordTrigger(input: { triggerId: string; projectId?: string; ticketId?: string }): void {
    const projectId = input.projectId ?? ''
    const ticketId = input.ticketId ?? ''
    this.record({
      kind: 'trigger',
      scope: { ...(ticketId === '' ? {} : { ticketId }), ...(projectId === '' ? {} : { projectId }) },
      sourceTable: 'trigger', sourceId: input.triggerId, sourceSeq: 0,
      summary: ticketId === '' ? '触发：一次请求建成了项目。' : '触发：一次请求派出了独立工单。',
      detail: { triggerId: input.triggerId },
    })
  }

  /** The Router handed work to a Project's PM. The delivery row is the source; its payload never comes here. */
  recordHandoff(input: { deliveryId: string; projectId?: string; controlSessionId?: string; summary: string }): void {
    this.record({
      kind: 'handoff',
      scope: { ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.controlSessionId === undefined ? {} : { controlSessionId: input.controlSessionId }) },
      sourceTable: 'coordination_deliveries', sourceId: input.deliveryId, sourceSeq: 0,
      summary: input.summary,
      detail: { deliveryId: input.deliveryId },
    })
  }

  /**
   * A report was written.
   *
   * Only the state is kept: a report's text is the Worker's own words, and it stays in the Ticket where it was written.
   */
  recordReport(input: { state: string; sourceTable: string; sourceId: string; ticketId?: string; projectId?: string;
    assignmentId?: string; controlSessionId?: string }): void {
    this.record({
      kind: 'report',
      scope: { ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.assignmentId === undefined ? {} : { assignmentId: input.assignmentId }),
        ...(input.controlSessionId === undefined ? {} : { controlSessionId: input.controlSessionId }) },
      sourceTable: input.sourceTable, sourceId: input.sourceId,
      summary: `报告：${input.state}。`,
      detail: { state: input.state },
    })
  }

  /** A call was refused by the permission guard. The call's own id is the source; its arguments never come here. */
  recordDenial(input: { callId: string; controlSessionId: string; toolName: string; reasonCode: string;
    ticketId?: string; projectId?: string; assignmentId?: string }): void {
    this.record({
      kind: 'denial', scope: { controlSessionId: input.controlSessionId,
        ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.assignmentId === undefined ? {} : { assignmentId: input.assignmentId }) },
      sourceTable: 'permission_denial_calls', sourceId: input.callId, sourceSeq: 0,
      summary: `权限拒绝：${input.toolName}（${input.reasonCode}）。`,
      detail: { toolName: input.toolName, reasonCode: input.reasonCode },
    })
  }

  /** A scheduled run finished. The run's own id is the source; the note of the plan never comes here. */
  recordSchedule(input: { runId: string; planId: string; projectId: string; state: string }): void {
    this.record({
      kind: 'schedule', scope: { projectId: input.projectId },
      sourceTable: 'sched_run', sourceId: input.runId, sourceSeq: 0,
      summary: `定时计划：这一次运行是 ${input.state}。`,
      detail: { runId: input.runId, planId: input.planId, state: input.state },
    })
  }

  /** Something went wrong that a person has to know about. */
  recordFailure(input: { sourceTable: string; sourceId: string; code: string; diagnostic?: string;
    ticketId?: string; projectId?: string; assignmentId?: string }): void {
    this.record({
      kind: 'error',
      scope: { ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.assignmentId === undefined ? {} : { assignmentId: input.assignmentId }) },
      sourceTable: input.sourceTable, sourceId: input.sourceId,
      summary: `失败：${input.code}。`,
      detail: { code: input.code, ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }) },
    })
  }

  // ─── reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The history as the operator reads it: everything this control plane holds. */
  forOperator(query: EventHistoryQuery): EventHistoryPage {
    return this.page(query, { all: true, scopeKeys: [], ticketIds: [] })
  }

  /**
   * The history one Session may read.
   *
   * The Session names its own scope: the role comes from its record and the work from what it owns. A caller that names
   * another Ticket, another Project or another Session is not answered at all — the request carries no authority here, so
   * there is nothing in it to trust.
   */
  forSession(request: { audience: 'router' | 'pm' | 'worker'; sessionId: string },
    query: EventHistoryQuery): EventHistoryResult {
    const sessions = this.host.sessions()
    const record = sessions.find(session => session.sessionId === request.sessionId)
    if (record === undefined) {
      return { ok: false, code: 'UNKNOWN_SESSION', reason: `There is no Session ${request.sessionId}` }
    }
    if (record.role !== request.audience) {
      return { ok: false, code: 'ROLE_MISMATCH',
        reason: `This Session is a ${record.role} Session and may not read the ${request.audience} view` }
    }
    if (record.revokedAt !== undefined) {
      return { ok: false, code: 'NO_SCOPE', reason: 'This Session was revoked; it opens nothing' }
    }
    if (record.operatorStop !== undefined) {
      return { ok: false, code: 'NO_SCOPE', reason: 'This Session was stopped by an operator; it opens nothing' }
    }
    // A Session belongs to one node: a record of another machine is not this control plane's Session, and the work it
    // would read is that machine's.
    if (record.nodeId !== '' && record.nodeId !== this.host.nodeId()) {
      return { ok: false, code: 'NO_SCOPE',
        reason: `This Session belongs to the node ${record.nodeId}, not to ${this.host.nodeId()}` }
    }
    const scope = request.audience === 'router' ? this.routerScope(record)
      : request.audience === 'pm' ? this.pmScope(record) : this.workerScope(record)
    if (!scope.ok) return { ok: false, code: scope.code, reason: scope.reason }
    return { ok: true, page: this.page(query, scope.authority) }
  }

  /**
   * The Router's scope: the pool it manages.
   *
   * The Router is the one Session that belongs to no Project, so it reads every row of this control plane. It is still
   * the Router of *this* control plane: a Session record of another machine may not borrow its view.
   */
  private routerScope(record: SessionRecord): EventHistoryScopeResult {
    if (record.sessionId !== this.host.routerSessionId()) {
      return { ok: false, code: 'NO_SCOPE', reason: 'This Session is not the Router of this control plane' }
    }
    return { ok: true, authority: { all: true, scopeKeys: [], ticketIds: [] } }
  }

  /**
   * A PM's scope: the Project it was really delegated, the Tickets under it and its own Session.
   *
   * The Project is the one whose PM this Session is — the delegation itself, not the id the record carries. The Tickets
   * are the ones that verifiably belong to it, so a row that was written before the Project was known (a row that names
   * the Ticket and nothing else) is still its own. Its own Session is in the scope because the facts it caused under
   * that Session are its own; the Session belongs to this one Project, so it never reaches another one.
   */
  private pmScope(record: SessionRecord): EventHistoryScopeResult {
    const project = this.host.projects().find(entry => entry.pmSessionId === record.sessionId)
    if (project === undefined) {
      return { ok: false, code: 'NO_SCOPE', reason: 'This Session is not the PM of a Project of this control plane' }
    }
    const tickets = this.host.tickets().filter(ticket => ticket.projectId === project.id).map(ticket => ticket.id)
    return { ok: true, authority: { all: false,
      scopeKeys: [scopeKeyOf('project', project.id), scopeKeyOf('control_session', record.sessionId)],
      ticketIds: tickets } }
  }

  /**
   * A Worker's scope: the Ticket it is working on, and nothing else.
   *
   * The Assignment must still be the Ticket's current one: what a replaced Worker would read is no longer its work. The
   * scope is that Ticket alone — not the Project of that Ticket, not the Assignment and not the Session it runs in as a
   * loose alternative: a row that names one of those without naming the Ticket is a row of work this Worker does not
   * hold, and it may not read it.
   */
  private workerScope(record: SessionRecord): EventHistoryScopeResult {
    const assignmentId = record.assignmentId
    if (assignmentId === undefined || assignmentId === '') {
      return { ok: false, code: 'NO_SCOPE', reason: 'This Worker Session has no Assignment' }
    }
    const ticket = this.host.tickets().find(entry => entry.assignments.some(item => item.id === assignmentId))
    if (ticket === undefined) {
      return { ok: false, code: 'ASSIGNMENT_UNAVAILABLE',
        reason: `The Assignment ${assignmentId} belongs to no Ticket of this control plane` }
    }
    if (latestAssignment(ticket)?.id !== assignmentId) {
      return { ok: false, code: 'STALE_ASSIGNMENT',
        reason: `The Assignment ${assignmentId} was replaced and is no longer the work that runs` }
    }
    return { ok: true, authority: { all: false, scopeKeys: [scopeKeyOf('ticket', ticket.id)], ticketIds: [ticket.id] } }
  }

  /**
   * One page of the index.
   *
   * The reader's scope and the caller's exact keys are one WHERE clause, and the page is cut after it: a fact that is
   * out of scope is neither counted nor paged past. The coverage that comes with the page is told from the reader's own
   * scope as well, so the kinds the index holds and the moment it starts never say more than the rows already do.
   */
  private page(query: EventHistoryQuery, authority: EventHistoryAuthority): EventHistoryPage {
    const limit = this.limitOf(query.limit)
    const order = query.order === 'asc' ? 'asc' : 'desc'
    const scope = this.scopeClause(authority)
    const where = this.whereOf(query, scope)
    const total = this.countOf(where)
    const cursor = query.cursor === undefined || query.cursor === '' ? undefined : decodeCursor(query.cursor)
    const params = [...where.params]
    let sql = `SELECT seq, event_id, event_kind, at, scope_key, ticket_id, project_id, control_session_id, assignment_id,
      node_id, backend_id, source_table, source_id, source_seq, summary, detail
      FROM event_history_index WHERE ${where.sql}`
    if (cursor !== undefined) {
      // The keyset position: the row after the last one of the page before, and never before it again.
      sql += order === 'desc'
        ? ' AND (at < ? OR (at = ? AND seq < ?))'
        : ' AND (at > ? OR (at = ? AND seq > ?))'
      params.push(cursor.at, cursor.at, cursor.seq)
    }
    sql += order === 'desc' ? ' ORDER BY at DESC, seq DESC' : ' ORDER BY at ASC, seq ASC'
    sql += ' LIMIT ?'
    params.push(limit + 1)
    const rows = this.db.prepare(sql).all(...params) as Record<string, SQLInputValue>[]
    const page = rows.slice(0, limit).map(row => entryOf(row))
    const last = page.at(-1)
    const hasMore = rows.length > limit
    return {
      rows: page,
      ...(hasMore && last !== undefined ? { nextCursor: encodeCursor({ at: last.at, seq: last.seq }) } : {}),
      hasMore,
      total,
      coverage: this.coverageOf(scope),
    }
  }

  /** How many rows are in scope, with the same WHERE the page is cut with. */
  private countOf(where: { sql: string; params: SQLInputValue[] }): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM event_history_index WHERE ${where.sql}`)
      .get(...where.params) as { total: number } | undefined
    return row?.total ?? 0
  }

  /**
   * The WHERE clause of one read: the reader's scope first, the caller's exact keys second.
   *
   * Both are in the SQL, so the count and the page agree and a fact of another Project is not even counted. A key of
   * another Project matches nothing, exactly as a key that never existed matches nothing: the answer does not say which
   * of the two it was.
   */
  private whereOf(query: EventHistoryQuery,
    scope: { sql: string; params: SQLInputValue[] } | undefined): { sql: string; params: SQLInputValue[] } {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (scope !== undefined) {
      clauses.push(scope.sql)
      params.push(...scope.params)
    }
    const exact: readonly (readonly [string, string | undefined])[] = [
      ['ticket_id', query.ticketId],
      ['project_id', query.projectId],
      ['control_session_id', query.controlSessionId],
      ['assignment_id', query.assignmentId],
      ['node_id', query.nodeId],
      ['event_kind', query.kind],
    ]
    for (const [column, value] of exact) {
      if (value === undefined || value === '') continue
      clauses.push(`${column} = ?`)
      params.push(value)
    }
    return { sql: clauses.length === 0 ? '1 = 1' : clauses.join(' AND '), params }
  }

  /**
   * The clause that holds the reader's scope: the rows it may read, and no other.
   *
   * A row is read when it is filed under a scope the reader owns, or when it names a Ticket the reader owns. A reader
   * that owns nothing reads nothing at all.
   */
  private scopeClause(authority: EventHistoryAuthority): { sql: string; params: SQLInputValue[] } | undefined {
    if (authority.all) return undefined
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (authority.scopeKeys.length > 0) {
      clauses.push(`scope_key IN (${authority.scopeKeys.map(() => '?').join(', ')})`)
      params.push(...authority.scopeKeys)
    }
    if (authority.ticketIds.length > 0) {
      clauses.push(`ticket_id IN (${authority.ticketIds.map(() => '?').join(', ')})`)
      params.push(...authority.ticketIds)
    }
    if (clauses.length === 0) return { sql: '1 = 0', params: [] }
    return { sql: `(${clauses.join(' OR ')})`, params }
  }

  /** The most rows a page may hold. */
  private limitOf(limit: number | undefined): number {
    if (limit === undefined) return EVENT_HISTORY_DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > EVENT_HISTORY_LIMIT) {
      throw new EventHistoryQueryError('INVALID_LIMIT',
        `The limit must be a whole number between 1 and ${EVENT_HISTORY_LIMIT}`)
    }
    return limit
  }

  /**
   * How much of the history the index really holds — the whole of it.
   *
   * This is the operator's own view of the index. A reader with a scope is told its own coverage by `coverageOf`.
   */
  coverage(): EventHistoryCoverage {
    return this.coverageOf(undefined)
  }

  /**
   * How much of the history one reader may really see.
   *
   * The scope is applied in the SQL, so a reader of one Project never learns that another Project holds a kind it does
   * not hold, nor that the index began earlier than its own oldest fact. The operator and the Router have no scope, so
   * they are told about the whole index.
   */
  private coverageOf(scope: { sql: string; params: SQLInputValue[] } | undefined): EventHistoryCoverage {
    const where = scope === undefined ? '' : ` WHERE ${scope.sql}`
    const params: SQLInputValue[] = scope === undefined ? [] : scope.params
    const oldest = this.db.prepare(`SELECT MIN(at) AS since FROM event_history_index${where}`).get(...params) as
      { since: string | null } | undefined
    const kinds = this.db.prepare(
      `SELECT DISTINCT event_kind FROM event_history_index${where} ORDER BY event_kind`).all(...params) as
      { event_kind: string }[]
    return {
      ...(oldest?.since === undefined || oldest.since === null ? {} : { since: oldest.since }),
      kinds: kinds.map(row => row.event_kind).filter((kind): kind is EventHistoryKind =>
        (EVENT_HISTORY_KINDS as readonly string[]).includes(kind)),
      trimmed: false,
      retention: RETENTION_TEXT,
    }
  }

  // ─── the shape of a row ────────────────────────────────────────────────────────────────────────────────────────────

  /** The scope of one fact: the key it is filed under and the ids it keeps. */
  private scopeOf(scope: EventHistoryScope): { key: string; ticketId: string; projectId: string;
    controlSessionId: string; assignmentId: string } {
    const ticketId = scope.ticketId ?? ''
    const projectId = scope.projectId ?? ''
    const controlSessionId = scope.controlSessionId ?? ''
    const assignmentId = scope.assignmentId ?? ''
    const key = ticketId !== '' ? scopeKeyOf('ticket', ticketId)
      : assignmentId !== '' ? scopeKeyOf('assignment', assignmentId)
        : projectId !== '' ? scopeKeyOf('project', projectId)
          : controlSessionId !== '' ? scopeKeyOf('control_session', controlSessionId)
            : `node:${this.host.nodeId()}`
    return { key, ticketId, projectId, controlSessionId, assignmentId }
  }

  /** The Project a Ticket belongs to, and the PM that manages it. */
  private scopeOfTicket(ticketId: string): { projectId?: string; controlSessionId?: string } {
    const ticket = this.host.tickets().find(entry => entry.id === ticketId)
    if (ticket === undefined || ticket.projectId === undefined) return {}
    const project = this.host.projects().find(entry => entry.id === ticket.projectId)
    if (project === undefined) return { projectId: ticket.projectId }
    return { projectId: ticket.projectId, controlSessionId: project.pmSessionId }
  }

  /** The ordinal of the next fact of one source: the facts of a record that may happen again are told apart by it. */
  private nextSeq(kind: EventHistoryKind, sourceTable: string, sourceId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS total FROM event_history_index WHERE event_kind = ? AND source_table = ? AND source_id = ?')
      .get(kind, sourceTable, sourceId) as { total: number } | undefined
    return row?.total ?? 0
  }
}

/**
 * The scope key of one id: the key a row is filed under when it names that id.
 *
 * The same string is written into the row and read back by the readers, so a reader's scope and a row's scope are the
 * same vocabulary.
 */
function scopeKeyOf(kind: 'ticket' | 'project' | 'assignment' | 'control_session', id: string): string {
  return `${kind}:${id}`
}

/**
 * The idempotency key of one fact.
 *
 * It is built from the kind, the scope, the stable id of the source record and the ordinal of the fact within it: the
 * same fact, written again by a retry or after a restart, has the same key and is written once.
 */
function eventIdOf(kind: string, scopeKey: string, sourceTable: string, sourceId: string, sourceSeq: number): string {
  return createHash('sha256').update(`${kind} ${scopeKey} ${sourceTable} ${sourceId} ${sourceSeq}`).digest('hex').slice(0, 32)
}

/** The keyset position of one page: where it ends. */
function encodeCursor(cursor: { at: string; seq: number }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** The keyset position a cursor names, or the refusal that it is not one. */
function decodeCursor(cursor: string): { at: string; seq: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new EventHistoryQueryError('INVALID_CURSOR', 'The cursor is not one this service wrote')
  }
  const value = parsed as { at?: unknown; seq?: unknown }
  if (typeof value.at !== 'string' || typeof value.seq !== 'number' || !Number.isInteger(value.seq)) {
    throw new EventHistoryQueryError('INVALID_CURSOR', 'The cursor is not one this service wrote')
  }
  return { at: value.at, seq: value.seq }
}

/** One row of the index, as a reader sees it. The text is redacted again on the way out. */
function entryOf(row: Record<string, SQLInputValue>): EventHistoryEntry {
  return {
    seq: Number(row.seq),
    eventId: String(row.event_id),
    kind: String(row.event_kind) as EventHistoryKind,
    at: String(row.at),
    scopeKey: String(row.scope_key),
    ticketId: String(row.ticket_id),
    projectId: String(row.project_id),
    controlSessionId: String(row.control_session_id),
    assignmentId: String(row.assignment_id),
    nodeId: String(row.node_id),
    backendId: String(row.backend_id),
    sourceTable: String(row.source_table),
    sourceId: String(row.source_id),
    sourceSeq: Number(row.source_seq),
    summary: redact(String(row.summary)),
    detail: redactDetail(parseDetail(String(row.detail))),
  }
}

/** The detail of one row, read back as the object it was written as. */
function parseDetail(value: string): Record<string, unknown> {
  if (value === '') return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * The detail of one fact, redacted.
 *
 * Every string in it goes through the same redaction the summary goes through, so a value that slipped into a detail
 * cannot leave the control plane by that way. The whole detail is bounded, so one fact cannot fill the row.
 */
function redactDetail(detail: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  if (detail === undefined) return {}
  const out: Record<string, unknown> = {}
  let size = 0
  for (const [name, value] of Object.entries(detail)) {
    const text = typeof value === 'string' ? redact(value)
      : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value) ?? ''
    if (size + text.length > EVENT_HISTORY_DETAIL_LIMIT) break
    size += text.length
    out[name] = text
  }
  return out
}
