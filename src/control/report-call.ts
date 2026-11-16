/**
 * The call-level ledger of Worker reports: one entry per tool invocation that carried a report.
 *
 * A Worker report used to be deduplicated by its content, which cannot tell a replayed call from a new fact that happens
 * to read the same: the second `ready` of one Assignment after a rejection is a new review round, and swallowing it would
 * leave that round without a decision. This ledger is keyed by the call instead — the DSH tool invocation id the node
 * sends — so a replayed call is recognised as the same call and a new call is always a new fact, whatever it says.
 *
 * The entry lives in the domain's own KV area, so the report and its entry are written in one transaction: a report that was
 * written is always recorded, and a recorded call survives a restart of the control plane.
 */
import { createHash } from 'node:crypto'
import { KV, type Key } from '../kv.ts'
import type { WorkerReport } from '../core/index.ts'

/** One recorded report call. */
export interface ReportCallRecord {
  /** The Session the call came from. */
  sessionId: string
  /** The Assignment the call was about. */
  assignmentId: string
  /** The Ticket the call was about. */
  ticketId: string
  /** The hash of the payload the call carried. A different payload under the same key is a conflict, not a replay. */
  payloadHash: string
  /** The report state that was written. */
  state: string
  /** Whether the PM was already woken for this call. */
  notified: boolean
  /** When the call was recorded. */
  at: string
}

/**
 * The hash of one report's payload.
 *
 * It covers everything the call said about the work — the Ticket, the Assignment, the state, the summary and the question —
 * so two calls with the same key but a different payload are told apart from a replay of the same call.
 */
export function reportPayloadHash(ticketId: string, assignmentId: string, report: WorkerReport): string {
  return createHash('sha256').update(JSON.stringify([
    ticketId, assignmentId, report.state, report.summary.trim(), report.question ?? null,
  ])).digest('hex')
}

/**
 * The hash of a Session id, so a ledger key never has to spell the id out.
 *
 * A Session id may hold a `:` (an Assignment id does), and a key that spells it out would let one Session's key be the
 * prefix of another's.
 */
function sessionScope(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
}

/**
 * The prefix every ledger entry of one Session shares.
 *
 * The Session id is hashed rather than spelled out: a prefix that one Session id is a prefix of another would let one
 * Session's pruning reach into another's entries.
 */
export function reportCallPrefix(sessionId: string): string {
  return `${KV.control.reportCall.prefix}${sessionScope(sessionId)}:`
}

/**
 * The key of one call's ledger entry.
 *
 * The call key is bound to the Session and the Assignment that made it: the same key under another Session or another
 * Assignment is another call, never a replay of this one.
 */
export function reportCallKey(sessionId: string, assignmentId: string, callKey: string): Key<ReportCallRecord> {
  const id = createHash('sha256').update(`${sessionId}|${assignmentId}|${callKey}`).digest('hex')
  return KV.control.reportCall(sessionScope(sessionId), id)
}
