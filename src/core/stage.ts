/** Ticket stage classification and retry eligibility (docs/003). */
import { assignmentStopped, currentReview, latestAssignment, runningAssignment, waitsForPerson, type Ticket } from './model.ts'

/** High-level execution stage of a ticket: waiting on a person, actively working or queued, idle between turns, ended, or archived with its Project. */
export type TicketStage = { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' } | { stage: 'idle' } | { stage: 'ended' } | { stage: 'archived' }

/** Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins. */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.archived) return { stage: 'archived' }
  if (ticket.ended) return { stage: 'ended' }
  const assignment = latestAssignment(ticket)
  if (assignmentStopped(assignment) || assignment?.interruptedAt) return { stage: 'idle' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  const report = assignment?.report?.state
  if (report === 'ready') return { stage: 'person', action: 'review' }
  // A human follow-up after a blocked or failed report returns the ticket to the executor.
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) return { stage: 'person', action: report }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' }
  return { stage: 'working' }
}

/** True when an open ticket was stopped by an operator, archived or hard-paused and restored, stalled on a report, or has a failed input delivery. */
export function canRetry(ticket: Ticket): boolean {
  const assignment = latestAssignment(ticket)
  return !ticket.ended && !ticket.archived && (assignmentStopped(assignment)
    || assignment?.endedReason === 'projectArchived' || assignment?.endedReason === 'projectPaused'
    || waitsForPerson(ticket) || !!ticket.delivery)
}

/**
 * What a PM sees of one of its Tickets' states, derived from the Ticket, its Project archive and its latest Assignment.
 *
 * `waiting` is the state of a Ticket whose Worker reported its result and whose PM has not decided about it yet: the
 * work is done, the Ticket stays open until the PM accepts or rejects it.
 *
 * The rule lives here, in the domain, because the console, the Router's summary and the live state must all answer with
 * the same word for the same Ticket: a second opinion computed anywhere else would drift from the one the PM acts on.
 */
export type PmTicketStatus = 'open' | 'running' | 'waiting' | 'blocked' | 'failed' | 'completed' | 'stopped' | 'archived'

/** The status a PM reads for a Ticket; the first matching rule wins, mirroring `ticketStage` where it applies. */
export function pmTicketStatus(ticket: Ticket): PmTicketStatus {
  if (ticket.archived) return 'archived'
  // A `merged` Ticket completed its work just as a `completed` one did; every other outcome ended it without that.
  if (ticket.ended) return ticket.ended.outcome === 'completed' || ticket.ended.outcome === 'merged'
    ? 'completed' : 'stopped'
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  // A person's later message lifts a blocked or failed report, so only an unanswered one still blocks the Ticket.
  if (report === 'blocked' && waitsForPerson(ticket)) return 'blocked'
  if (report === 'failed' && waitsForPerson(ticket)) return 'failed'
  if (assignmentStopped(assignment) || ticket.manualStop) return 'stopped'
  // A result that waits for the PM's decision is neither running nor open: the work is done, the Ticket is not.
  if (currentReview(ticket)?.state === 'pending') return 'waiting'
  if (runningAssignment(ticket)) return 'running'
  return 'open'
}
