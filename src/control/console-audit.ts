/**
 * The control plane's audit trail: what really happened, in a vocabulary a console can show.
 *
 * An entry is a fact about the work, not a copy of a request: a Project that was created, an Assignment that started, a
 * Worker that reported, a PM that accepted or rejected, a node that came or went. The line of detail is short and redacted,
 * and it never holds a token, a raw diff or the body of a request.
 */
import { redactCredentials } from '../infra/redact.ts'
import type { ConsoleAuditRow, ConsoleStore } from './console-store.ts'

/** Who acted. */
export type AuditActor = 'operator' | 'pm' | 'worker' | 'router' | 'system'
/** What kind of thing was acted on. */
export type AuditKind = 'project' | 'ticket' | 'assignment' | 'report' | 'review' | 'node' | 'session' | 'schedule'
  | 'denial' | 'memory'
/** How an action ended. */
export type AuditOutcome = 'ok' | 'failed' | 'skipped'

/** One fact to record. */
export interface AuditInput {
  /** Who acted. */
  actor: AuditActor
  /** What kind of thing was acted on. */
  kind: AuditKind
  /** What happened, in the vocabulary of that kind: `created`, `started`, `reported`, `accepted`, `online`, … */
  action: string
  /** The kind of the target, as the kernel names it: `project`, `ticket`, `assignment`, `session`, `node`. */
  targetKind: string
  /** The id of the target. */
  targetId: string
  /** How it ended; `ok` when the caller does not say. */
  outcome?: AuditOutcome
  /** A short line about the fact. It is redacted and shortened, never a request body. */
  detail?: string
}

/** How long a detail line may be. */
const DETAIL_LIMIT = 300

/**
 * Writes the audit trail and reads it back.
 *
 * A write that fails is reported and never thrown: an audit trail that cannot be written must not fail the work it
 * describes. The facts it holds live in the domain's own store, so a missing audit line never costs the control plane a
 * Ticket or a Session.
 */
export class AuditRecorder {
  constructor(private readonly store: ConsoleStore, private readonly now: () => string,
    private readonly report: (error: unknown) => void = () => {}) {}

  /** Record one fact; a failure to write it is reported, not thrown. */
  record(input: AuditInput): void {
    const detail = (input.detail ?? '').trim()
    try {
      this.store.writeAudit({ at: this.now(), actor: input.actor, kind: input.kind, action: input.action,
        targetKind: input.targetKind, targetId: input.targetId, outcome: input.outcome ?? 'ok',
        detail: redactCredentials(detail).slice(0, DETAIL_LIMIT) })
    } catch (error) {
      this.report(error)
    }
  }

  /** The entries of the trail, newest first. */
  entries(options: { limit?: number; kind?: string } = {}): ConsoleAuditRow[] {
    return this.store.auditEntries(options)
  }

  /** How many entries the trail holds. */
  count(): number { return this.store.auditCount() }
}
