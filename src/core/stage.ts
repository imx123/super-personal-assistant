/** Ticket stage classification and retry eligibility (docs/003). */
import { assignmentStopped, latestAssignment, waitsForPerson, type Ticket } from './model.ts'

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
