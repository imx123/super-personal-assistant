/** Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { assignmentSessionId, assignmentStopped, latestAssignment, latestReport, liveTicket, OPERATOR_STOP, readUntil, runningAssignment,
  settled, threadKey, waitsForPerson, workerSessionId } from './model.ts'
import type { Assignment, ChannelRef, Evaluation, Follow, Handoff, Mandate, ManualStop, PolicyEffect, ThreadRef, Ticket, TicketEndBy,
  TicketInput, TicketOutcome, Trigger, TriggerDisposition } from './model.ts'
import type { AssessmentOutcome } from './ports.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { canRetry } from './stage.ts'
import { redact } from '../infra/redact.ts'

const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Whether an Input is a message no person wrote, such as CI's, a bot's, or the main Session's note. */
export const automatic = (input: TicketInput | undefined): boolean => input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)
/**
 * Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the message
 * into a step before then. One delivered before reads were recorded counts as read once it reached the worker by then.
 */
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean => input.readAt === undefined
  ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until
const STATUS_REQUEST = 'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.'
/** What a stop of one Worker names: who stopped it, whether for that Worker alone or for its Project, and the Assignment a
 * person selected. A Project stop names its Project and leaves the Assignment to the latest one. */
export interface HardStopWorkerOptions {
  scope: 'worker' | 'project'
  by: string
  sessionId?: string
  reason?: string
  /** The Assignment a person's single-Worker stop names. */
  assignmentId?: string
  /** The Project whose hard pause stops the Worker. */
  projectId?: string
  /** Receives the Executor's background cleanup, which a Project hard pause waits for before reporting the Worker stopped. */
  cleanups?: { ticketId: string; work: Promise<void> }[]
}
/** A transfer that has recorded its Handoff and ended the old Worker, but has not started the new Assignment yet. */
export interface TransferStart {
  ticket: Ticket
  assignmentId: string
  handoffId: string
  /** The Executor's cleanup of the old Worker's background work, which the next Worker must wait for. */
  work?: Promise<void>
}

/**
 * Manages each ticket's lifecycle: creates the ticket for an accept decision with its Mandate, Subscriptions, and first
 * Assignment, binds and attaches Threads, adds Inputs, resumes, retries, restarts, and ends tickets, and drops Subscriptions.
 * Coordinates with Replies for the acknowledgement an accept carries and with Executor to start, deliver to, and stop assignments.
 * Intake, Evals, Assignments, and Engine delegate ticket and subscription mutations here.
 */
export class Tickets extends EnginePart {
  constructor(options: EngineOptions, private readonly replies: Replies) { super(options) }

  /**
   * Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
   * Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
   * gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed.
   */
  create(id: string, decisionId: string, mandate: Mandate, evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, at: string): void {
    const { triggerIds } = evaluation
    // Fall back to the last trigger for Evals recorded before `primary` existed.
    const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!)
    const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds }
    let ticket: Ticket = { id, title: outcome.title, decisionId, mandate, channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: at, updatedAt: at, origin }
    for (const triggerId of triggerIds) {
      const channel = this.repo.triggers.get(triggerId)?.channel
      if (channel && !ticket.channels.some(item => sameChannel(item, channel))) ticket.channels.push(channel)
    }
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    const assignment = this.newAssignment(ticket)
    this.repo.tickets.save(ticket)
    for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref)
    if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement)
    this.options.executor.start(this.require(id), assignment)
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
  }
  /**
   * Create a Ticket its Project's PM delegated: no acknowledgement, no Channel, and no Subscription to the internal
   * Trigger's own Thread, since the PM remains the Project's only outward voice. Explicit external Threads are subscribed
   * separately through `subscribeExternal`. Its first Assignment is queued like any other.
   */
  createDelegated(id: string, decisionId: string, mandate: Mandate, projectId: string, trigger: Trigger,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, at: string): Ticket {
    let ticket: Ticket = { id, title: outcome.title, decisionId, projectId, mandate, channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: at, updatedAt: at, origin: { triggerId: trigger.id, triggerIds: [trigger.id] } }
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    const assignment = this.newAssignment(ticket)
    this.repo.tickets.save(ticket)
    this.options.executor.start(this.require(id), assignment)
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
    return this.require(id)
  }
  /**
   * Subscribe an open ticket to an external Thread its PM named when creating it, or upgrade a context-only Subscription
   * to an ordinary one. It changes only Thread.subscriptions (and Thread.context for context-only), never `Ticket.follows`.
   * @returns false when the ticket already subscribes to the Thread.
   * @throws UserError when the reference is invalid or the ticket is unknown or has ended.
   */
  subscribeExternal(ticketId: string, ref: ThreadRef, contextOnly = false): boolean {
    if (typeof ref?.source !== 'string' || typeof ref?.id !== 'string' || !ref.source.trim() || !ref.id.trim()) {
      throw new UserError('invalidThread', { thread: JSON.stringify(ref) })
    }
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const current = this.thread(ref)
    if (current.subscriptions.includes(ticketId)) {
      // A later ordinary Subscription makes an earlier context-only one ordinary; otherwise it is already covered.
      if (!contextOnly && current.context?.includes(ticketId)) { this.subscribe(ticketId, ref); return true }
      return false
    }
    this.subscribe(ticketId, ref)
    if (!contextOnly) return true
    const thread = this.thread(ref)
    thread.context = [...new Set([...thread.context ?? [], ticketId])]
    this.repo.threads.save(thread)
    return true
  }
  /**
   * Subscribes an open ticket to `thread` and records it in `ticket.follows` (`own` when opened by the ticket).
   * @throws UserError when the ticket is unknown or has ended.
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.subscribe(ticketId, thread)
    const ticket = this.require(ticketId)
    const followed = threadKey(thread)
    const follow = ticket.follows?.find(item => item.thread === followed)
    // Re-binding a thread reopens it if previously closed; `own` remains true once set.
    if (follow) { follow.own ||= own; delete follow.closed } else ticket.follows = [...ticket.follows ?? [], { thread: followed, own }]
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * Record that a Thread open tickets follow closed, and end each one done with its Threads (see `followsDone`), unless its
   * work has not finished (see `unfinished`); such work ends the ticket once it reports ready.
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    const closed = threadKey(thread)
    for (const ticket of this.repo.tickets.open()) {
      const follow = ticket.follows?.find(item => item.thread === closed && !item.closed)
      if (!follow) continue
      follow.closed = { at, outcome }
      this.repo.tickets.save(ticket)
      const done = this.followsDone(ticket)
      if (!done || this.unfinished(ticket, at)) continue
      // Work resumed after the close and finished ends now.
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at)
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at)
    }
  }
  /**
   * How a ticket that follows Threads is done with them: once no Thread it opened (`own`) is still open, or, when it opened none,
   * once every one it follows closed. It ends as the latest close among those Threads did; undefined while it is not done.
   */
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? []
    const own = follows.filter(item => item.own)
    const counted = own.length ? own : follows
    if (!counted.length || counted.some(item => !item.closed)) return undefined
    return counted.map(item => item.closed!).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  }
  /**
   * The Trigger to attach to a ticket, once the ticket may take it.
   * @throws UserError when the trigger or ticket is unknown, a ticket's worker still decides the trigger, a person stopped the ticket, or an ended ticket's Mandate no longer revalidates.
   */
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // A follow-up that reached a ticket goes elsewhere only once the workers that decide it hand it back.
    this.leftToWorkers(trigger)
    const current = this.require(ticketId)
    if (current.archived) throw new UserError('ticketArchived')
    if (current.ended?.outcome === 'handedOff') throw new UserError('ticketEnded')
    if (this.projectPaused(current)) throw new UserError('projectPaused')
    if (current.ended?.by === 'human') throw new UserError('ticketStopped')
    if (!liveTicket(current) && !this.policy().revalidate(current.mandate)) throw new UserError('mandateRevoked')
    return trigger
  }
  /**
   * Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's worker
   * then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold the
   * message as its ticket's takes it as a new Input, which wakes an ended ticket as any attached message does.
   */
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    for (const ref of trigger.threads) this.subscribe(ticketId, ref)
    // A person's sending it to Eval, which routed it here, is over, and so is the ticket's reading it for context only.
    const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const { context, requeued, ...disposition } = current
    const followed = context?.filter(id => id !== ticketId)
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: [...new Set([...disposition.fanout, ticketId])],
      ...followed?.length ? { context: followed } : {} })
    const ticket = this.require(ticketId)
    const id = key('input', ticketId, 'trigger', trigger.id)
    const existing = ticket.inputs.find(input => input.id === id)
    const at = this.now()
    const input = (inputId: string): TicketInput => ({ id: inputId, kind: 'trigger', triggerId: trigger.id, at, ...(note ? { note } : {}),
      ...trigger.human ? { human: true } : {} })
    if (existing?.kind !== 'trigger') this.addInput(ticket, input(id))
    else if (note && ticket.undelivered.includes(id)) { existing.note = note; ticket.updatedAt = at; this.repo.tickets.save(ticket) }
    // A person sent it to Eval, or the ticket let it go before its worker took it up, read it for context only, or ended after
    // its worker had it, so the worker gets it again.
    else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) {
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)))
    }
    // The worker has the message already, so the note comes with it again.
    else if (note) this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)))
  }
  /**
   * Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
   * @returns whether the status request input was queued.
   * @throws UserError when the ticket is unknown.
   */
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false
    this.addInput(ticket, { id: `status:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: STATUS_REQUEST, at: this.now() })
    return true
  }
  /**
   * Stops a ticket on behalf of a human, ending any active assignments.
   * @throws UserError when the ticket is unknown.
   */
  stop(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'human', 'stopped', this.now(), reason)
    return this.require(ticketId)
  }
  /**
   * The single primitive that stops one Worker: end its active Assignment (unless it already ended) with the operator's
   * reason, put back the messages no step took, clear its question and delivery error, record `ManualStop` on the Ticket, and
   * ask the Executor to cancel the turn and stop its background work. A person's stop of one Worker and a Project hard
   * pause's loop over its Workers both call it, so both leave the same state; only `manualStop.scope` differs, and a
   * `project` stop never overwrites an earlier `worker` stop.
   * @throws UserError when the ticket is unknown or ended, the assignment is not the Ticket's latest, or it already ended.
   */
  hardStopWorker(ticketId: string, options: HardStopWorkerOptions): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const latest = latestAssignment(ticket)
    let assignment: Assignment | undefined
    let labelled = false
    if (options.scope === 'worker') {
      if (!latest || latest.id !== options.assignmentId) throw new UserError('assignmentEnded')
      if (assignmentStopped(latest)) {
        // A stop recorded before ManualStop existed gains its label without touching the ended Assignment.
        if (!ticket.manualStop) { this.writeManualStop(ticket, options); labelled = true }
      } else {
        if (latest.state === 'ended') throw new UserError('assignmentEnded')
        assignment = latest
        this.writeManualStop(ticket, options)
        labelled = true
      }
    } else {
      if (options.projectId && ticket.projectId !== options.projectId) throw new UserError('notProjectTicket')
      if (latest && latest.state !== 'ended') assignment = latest
      if (!ticket.manualStop || ticket.manualStop.scope !== 'worker') { this.writeManualStop(ticket, options); labelled = true }
    }
    if (assignment) {
      this.endAssignment(ticket, assignment, OPERATOR_STOP)
      this.requeueUntaken(ticket, assignment)
      if (ticket.attention) this.replies.withdrawAttention(ticket.attention.id)
      delete ticket.attention
      delete ticket.delivery
    }
    if (!labelled && options.scope === 'worker') return this.require(ticketId)
    ticket.updatedAt = this.now()
    if (assignment) {
      const cleanup = this.options.executor.stop(ticket, assignment, OPERATOR_STOP)
      if (cleanup && options.cleanups) {
        const work: Promise<void> = Promise.resolve(cleanup)
        work.catch(() => {})
        options.cleanups.push({ ticketId, work })
      }
    }
    this.repo.tickets.save(ticket)
    if (labelled) this.emit('ticket.manualStopSet', { ticketId, scope: options.scope })
    return this.require(ticketId)
  }
  /**
   * Clear a `worker` stop on a person's explicit approval, or a `project` stop when its Project resumes. It starts or
   * resumes nothing: the PM's next `revive` starts the new Assignment.
   * @throws UserError when the ticket is unknown or carries no stop of that scope.
   */
  clearManualStop(ticketId: string, scope: ManualStop['scope'], by: 'user' | 'pm'): Ticket {
    const ticket = this.require(ticketId)
    if (ticket.manualStop?.scope !== scope) throw new UserError('notManuallyStopped')
    delete ticket.manualStop
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.emit('ticket.manualStopCleared', { ticketId, scope, by })
    return this.require(ticketId)
  }
  /**
   * Clear every `project` stop a Project's hard pause left on its Tickets, keeping each `worker` stop. It starts nothing.
   * @returns how many Tickets were cleared.
   */
  clearProjectManualStops(projectId: string, by: 'user' | 'pm' = 'pm'): number {
    let cleared = 0
    for (const ticket of this.repo.tickets.list()) {
      if (ticket.projectId !== projectId || ticket.manualStop?.scope !== 'project') continue
      delete ticket.manualStop
      ticket.updatedAt = this.now()
      this.repo.tickets.save(ticket)
      this.emit('ticket.manualStopCleared', { ticketId: ticket.id, scope: 'project', by })
      cleared++
    }
    return cleared
  }
  /**
   * Revive a Worker that a Project hard pause stopped, or one a person already allowed to resume, under the Ticket's
   * unchanged Mandate and worktree: it clears any `project` stop and starts one new Assignment, creating no Decision. A
   * `worker` stop still in place is refused until a person clears it. With no stop left, only a Ticket whose latest
   * Assignment an operator stopped is revivable, so a Ticket that consumed its only stop is not started twice.
   * @throws UserError when the ticket is unknown or ended, is not the Project's, has no stop or operator stop, still has an
   * active Assignment, or carries a `worker` stop.
   */
  revive(ticketId: string, projectId: string, pmSessionId: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (ticket.projectId !== projectId) throw new UserError('notProjectTicket')
    // A revoked PM Mandate cannot revive its Project's Tickets, whatever stop the Worker carries.
    if (!this.policy().revalidate(ticket.mandate)) throw new UserError('mandateRevoked')
    const stop = ticket.manualStop
    if (stop?.scope === 'worker') throw new UserError('manualStopNeedsUserApproval')
    const latest = latestAssignment(ticket)
    if (latest && latest.state !== 'ended') throw new UserError('workerRunning')
    if (!stop && !assignmentStopped(latest)) throw new UserError('notManuallyStopped')
    delete ticket.manualStop
    const assignment = this.newAssignment(ticket)
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
    this.emit('ticket.revived', { ticketId, assignmentId: assignment.id, pmSessionId })
    return this.require(ticketId)
  }
  /**
   * Move a Ticket to a new Worker inside its Project: end the current Assignment with `handedOff` and ask the Executor to
   * stop its Session, record the transfer on both sides of the same Ticket, brief the new Worker, and create (but do not yet
   * start) one new Assignment under the unchanged Mandate and worktree in Session `worker-<ticketId>-h<seq>`. The Handoff
   * stays `starting` until `completeTransfer` decides it with the launch, so a restart can fail it instead of leaving an
   * accepted record with no Worker. The caller waits for `work` before `completeTransfer`, so a failed cleanup cannot
   * start a replacement Worker over the old one's work.
   * @throws UserError when the ticket is unknown or ended, is not the Project's, carries a manual stop, or has no running or
   * pending Assignment to hand over.
   */
  beginTransfer(ticketId: string, projectId: string, pmSessionId: string,
    request: { reason: string; summary: string; unfinished?: string[] }): TransferStart {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (ticket.projectId !== projectId) throw new UserError('notProjectTicket')
    this.refuseManualStop(ticket)
    const latest = latestAssignment(ticket)
    if (!latest || latest.state === 'ended') throw new UserError('notHandoffable')
    const at = this.now()
    const seq = this.transferCount(ticket) + 1
    const record: Handoff = { id: key('handoff', ticketId, 'transfer', String(seq), request.summary),
      at, kind: 'transfer', status: 'starting',
      from: { ticketId, projectId, assignmentId: latest.id, sessionId: assignmentSessionId(ticketId, latest) },
      to: { ticketId, projectId, sessionId: workerSessionId(ticketId, seq) },
      reason: request.reason, summary: request.summary, ...request.unfinished?.length ? { unfinished: request.unfinished } : {},
      approvedBy: { kind: 'pm', sessionId: pmSessionId }, decidedAt: at }
    this.endAssignment(ticket, latest, 'handedOff')
    this.requeueUntaken(ticket, latest)
    if (ticket.attention) this.replies.withdrawAttention(ticket.attention.id)
    delete ticket.attention
    delete ticket.delivery
    ticket.handoffs = [...ticket.handoffs ?? [], record]
    this.briefHandoff(ticket, record)
    const assignment = this.newAssignment(ticket)
    record.to.assignmentId = assignment.id
    ticket.updatedAt = at
    const cleanup = this.options.executor.stop(ticket, latest, 'handedOff')
    this.repo.tickets.save(ticket)
    return { ticket: this.require(ticketId), assignmentId: assignment.id, handoffId: record.id, ...cleanup ? { work: cleanup } : {} }
  }
  /**
   * Start the Assignment `beginTransfer` created, once the old Worker's background cleanup succeeded, and report the handoff.
   * It rechecks the whole record, not just the Assignment: the Handoff must still be the `starting` transfer that created
   * this Assignment and the Assignment must still be the Ticket's pending latest one, so a stop, a retry or a second
   * transfer during the cleanup can never start a Worker over the newer state.
   * @throws UserError when the ticket ended meanwhile, the Handoff is no longer starting or is not this transfer, or the
   * Assignment is no longer the Ticket's pending latest one.
   */
  completeTransfer(ticketId: string, assignmentId: string, handoffId: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const handoff = ticket.handoffs?.find(item => item.id === handoffId)
    if (!handoff || handoff.kind !== 'transfer' || handoff.status !== 'starting' || handoff.to.assignmentId !== assignmentId) {
      throw new UserError('handoffHandled')
    }
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment) throw new UserError('assignmentEnded')
    if (latestAssignment(ticket)?.id !== assignmentId) throw new UserError('assignmentEnded')
    if (assignment.state === 'running') return ticket
    if (assignment.state !== 'pending') throw new UserError('assignmentEnded')
    // The transfer is decided only here, together with the launch it starts; a crash before this leaves it `starting` for
    // startup recovery to fail, never an accepted record with no Worker.
    handoff.status = 'accepted'
    handoff.decidedAt = this.now()
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
    this.emit('ticket.handedOff', { ticketId, handoffId, kind: 'transfer', toTicketId: ticketId,
      toSessionId: handoff.to.sessionId ?? assignmentSessionId(ticketId, assignment) })
    return this.require(ticketId)
  }
  /**
   * A transfer that did not start its replacement Worker: the Handoff becomes `failed` so no accepted record claims
   * success, the new Assignment ends as `handoffCleanupFailed` while it is still pending, and the failure stays on the
   * Ticket as `delivery.error` for a person to retry. The failure is recorded even when a concurrent stop or a newer
   * transfer already changed the Assignment; only a newer, still-active Assignment keeps its own delivery state, since
   * the failed Handoff already carries the error. It starts nothing.
   */
  failTransfer(ticketId: string, assignmentId: string, handoffId: string, error: string): Ticket {
    const ticket = this.require(ticketId)
    const at = this.now()
    // Handoff failures are durable and shown in the panel; keep only the redacted diagnostic.
    const diagnostic = redact(error)
    const handoff = ticket.handoffs?.find(item => item.id === handoffId)
    if (handoff && (handoff.status === 'starting' || handoff.status === 'accepted' || handoff.status === 'pending')) {
      handoff.status = 'failed'
      handoff.decidedAt = at
      handoff.failure = diagnostic.slice(0, 1000)
    }
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (assignment?.state === 'pending') this.endAssignment(ticket, assignment, 'handoffCleanupFailed')
    const latest = latestAssignment(ticket)
    const superseded = !!latest && latest.id !== assignmentId && latest.state !== 'ended'
    // An archived Ticket also keeps the error so a later unarchive leaves it retryable; only an ended one drops it.
    if (!ticket.ended && !superseded) ticket.delivery = { error: diagnostic.slice(0, 300), at }
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return this.require(ticketId)
  }
  /**
   * Stop the source Worker of a Ticket being handed away, before its target exists: end its latest Assignment with
   * `handedOff`, put back the messages no step took, clear its question and delivery error, and ask the Executor to cancel
   * the turn and stop its background work. The Ticket stays open; the caller waits for `work` and then either
   * `completeHandoffAway` or `failHandoffAway`, so no target Worker starts over work that still runs.
   */
  beginHandoffAway(ticketId: string, reason?: string): { ticket: Ticket; work?: Promise<void> } {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const latest = latestAssignment(ticket)
    let work: Promise<void> | undefined
    if (latest && latest.state !== 'ended') {
      this.endAssignment(ticket, latest, 'handedOff')
      this.requeueUntaken(ticket, latest)
      if (ticket.attention) this.replies.withdrawAttention(ticket.attention.id)
      delete ticket.attention
      delete ticket.delivery
      ticket.updatedAt = this.now()
      this.repo.tickets.save(ticket)
      let cleanup: void | Promise<void>
      try { cleanup = this.options.executor.stop(ticket, latest, 'handedOff') } catch (error) { cleanup = Promise.reject(error) }
      if (cleanup) {
        work = Promise.resolve(cleanup)
        // The caller awaits it; an ignored failure must not become an unhandled rejection.
        work.catch(() => {})
      }
    }
    return { ticket: this.require(ticketId), ...work ? { work } : {} }
  }
  /**
   * End a source Ticket whose Worker stopped cleanly for a split or a cross-Project handoff. The caller runs it in the
   * transaction that records the accepted Handoff, so the Ticket ends only after the target Ticket existed.
   * @throws UserError when the ticket is unknown or ended.
   */
  completeHandoffAway(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'executor', 'handedOff', this.now(), reason)
    return this.require(ticketId)
  }
  /**
   * Record that a split or cross-Project handoff could not finish: its Handoff becomes `failed` and, unless a newer
   * still-active Assignment now owns the Ticket, the Ticket keeps `delivery.error` for a person to retry, so it never
   * looks handed off. A concurrent retry that already owns the Ticket keeps its own delivery state; the failed Handoff
   * records the error for its history. Nothing starts, and a concurrent stop may already have ended the Ticket.
   */
  failHandoffAway(ticketId: string, handoffId: string, error: string): Ticket | undefined {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket) return undefined
    const at = this.now()
    const diagnostic = redact(error)
    const handoff = ticket.handoffs?.find(item => item.id === handoffId)
    if (handoff && (handoff.status === 'starting' || handoff.status === 'pending' || handoff.status === 'accepted')) {
      handoff.status = 'failed'
      handoff.decidedAt = at
      handoff.failure = diagnostic.slice(0, 1000)
    }
    const latest = latestAssignment(ticket)
    const from = handoff?.from.assignmentId
    const superseded = !!latest && !!from && latest.id !== from && latest.state !== 'ended'
    // An archived Ticket also keeps the error so a later unarchive leaves it retryable; only an ended one drops it.
    if (!ticket.ended && !superseded) ticket.delivery = { error: diagnostic.slice(0, 300), at }
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return this.require(ticketId)
  }
  /**
   * Recover Handoffs a host restart interrupted between their first transaction and their completion (see
   * `recoverTicketHandoffs`). Idempotent and safe to call at startup: it starts no Worker and creates no Ticket.
   * @returns how many in-flight Handoffs it recovered.
   */
  recoverStartingHandoffs(at = this.now()): number {
    let recovered = 0
    for (const ticket of this.repo.tickets.list()) {
      if (!ticket.handoffs?.some(handoff => handoff.status === 'starting')) continue
      recovered += this.repo.atomic(() => this.recoverTicketHandoffs(ticket.id, at))
    }
    return recovered
  }
  /**
   * Fail the `starting` Handoffs of one Ticket: the source Worker stopped and its cleanup was awaited, but the process
   * ended before the replacement Worker or target Ticket was committed. A transfer's pending replacement Assignment ends
   * `handoffCleanupFailed`; an open Ticket keeps a delivery error so a person can retry, unless a newer active Assignment
   * already owns it. It never starts the target or replacement.
   */
  private recoverTicketHandoffs(ticketId: string, at: string): number {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket) return 0
    const starting = (ticket.handoffs ?? []).filter(handoff => handoff.status === 'starting')
    if (!starting.length) return 0
    const message = 'The host restarted while this handoff was starting, so it did not complete and no Worker was started over it.'
    for (const handoff of starting) {
      handoff.status = 'failed'
      handoff.decidedAt = at
      handoff.failure = message
      if (handoff.kind !== 'transfer' || !handoff.to.assignmentId) continue
      // The replacement was reserved by the first transaction but never launched; a retry reuses its `-h<seq>` slot.
      const assignment = ticket.assignments.find(item => item.id === handoff.to.assignmentId)
      if (assignment?.state === 'pending') this.endAssignment(ticket, assignment, 'handoffCleanupFailed')
    }
    const latest = latestAssignment(ticket)
    const sources = new Set(starting.flatMap(handoff => handoff.from.assignmentId ? [handoff.from.assignmentId] : []))
    const superseded = !!latest && latest.state !== 'ended' && !sources.has(latest.id)
    // An archived Ticket also keeps the error so a later unarchive leaves it retryable; only an ended one drops it.
    if (!ticket.ended && !superseded) ticket.delivery = { error: message, at }
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return starting.length
  }
  /**
   * Add the new Worker's briefing as a text Input, under the Handoff's id, so the receiving Session reads why it has the work
   * and what is unfinished without the source Ticket's history, worktree or uncommitted changes being transferred.
   */
  briefHandoff(ticket: Ticket, handoff: Handoff, moved = handoff.kind === 'transfer'): void {
    const id = key('input', ticket.id, 'handoff', handoff.id)
    if (ticket.inputs.some(input => input.id === id)) return
    const unfinished = handoff.unfinished?.length ? `\nUnfinished:\n${handoff.unfinished.map(item => `- ${item}`).join('\n')}` : ''
    const where = moved
      ? 'The Ticket, its Mandate and its worktree are unchanged; inspect the worktree, git history and PR state and continue.'
      : `This is a new Ticket in Project ${ticket.projectId}, with its own Mandate and worktree. The source Ticket ${handoff.from.ticketId} in Project ${handoff.from.projectId} ended as handed off; its worktree and uncommitted changes were not transferred. Inspect this Ticket's own workspace and continue.`
    const text = `A Project PM handed this work to a new Worker. Reason: ${handoff.reason ?? 'not stated'}.\n`
      + `Summary: ${handoff.summary}${unfinished}\n${where}`
    ticket.inputs.push({ id, kind: 'text', text, at: this.now() })
    ticket.undelivered.push(id)
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
  }
  /**
   * The number of transfer Handoffs a Ticket recorded, which numbers its next Worker Session. A failed transfer still used
   * its slot, so a retry after it starts the same `-h<seq>` Session the replacement would have had, not the old Worker's.
   */
  private transferCount(ticket: Pick<Ticket, 'id' | 'handoffs'>): number {
    return ticket.handoffs?.filter(handoff => handoff.kind === 'transfer' && !!handoff.to.sessionId).length ?? 0
  }
  /** Record the stop that guards the Worker's automatic resume; a Project stop leaves an earlier `worker` stop in place. */
  private writeManualStop(ticket: Ticket, options: HardStopWorkerOptions): void {
    if (options.scope === 'project' && ticket.manualStop?.scope === 'worker') return
    ticket.manualStop = { at: this.now(), scope: options.scope, by: options.by,
      ...options.sessionId ? { sessionId: options.sessionId } : {}, ...options.reason ? { reason: options.reason } : {} }
  }
  /**
   * A person's stop of the selected Worker alone: see `hardStopWorker`.
   * @throws UserError when the ticket is unknown or ended, or the assignment is not its latest or already ended.
   */
  stopAssignment(ticketId: string, assignmentId: string): Ticket {
    return this.hardStopWorker(ticketId, { scope: 'worker', by: 'user', assignmentId })
  }
  /**
   * Replaces the stalled or explicitly stopped assignment of a retryable open ticket.
   * @throws UserError when the ticket is unknown, its Project is paused, it carries a manual stop, or it is not retryable.
   */
  retry(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    if (this.projectPaused(ticket)) throw new UserError('projectPaused')
    this.refuseManualStop(ticket)
    const latest = latestAssignment(ticket)
    if (!canRetry(ticket) || !latest) throw new UserError('notRetryable')
    const stopped = assignmentStopped(latest)
    if (!stopped) {
      this.endAssignment(ticket, latest, 'retried')
      this.requeueUntaken(ticket, latest)
    }
    const assignment = this.newAssignment(ticket)
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    if (!stopped) this.options.executor.stop(ticket, latest, 'retried')
    this.options.executor.start(ticket, assignment)
    return ticket
  }
  /**
   * Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the person's messages there that the ticket decides.
   * @throws UserError when the ticket is unknown, or `thread` is an origin thread, a bound `follows` thread, or not subscribed.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId)
    if (this.source(ticket)?.threads.some(ref => threadKey(ref) === thread)) throw new UserError('sourceThread')
    if (ticket.follows?.some(item => item.thread === thread)) throw new UserError('followedThread')
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError('notFollowing')
    this.dropSubscriptions(thread, 'executor', ticketId, reason)
    // Its worker found the Thread is not its ticket's: it hands back, with its reason, the person's messages there it decides.
    for (const trigger of this.triggersOf(ticket)) {
      if (trigger.threads.some(ref => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason)
    }
  }
  /**
   * Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order they
   * were accepted; the others are left alone.
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now()
    // Iterate tickets oldest first so deliveries queue in acceptance order.
    for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id)
      // Include `at` in the input key so repeated transitions between the same policy versions still record a new input.
      if (effect) this.addInput(ticket, { id: key('input', ticket.id, 'policy', from, to, at), kind: 'policy-changed', from, to, at, effect })
    }
  }
  /**
   * Stop each open delegated Ticket whose Project PM authority a Policy change removed, through the same single-Worker
   * stop a Project hard pause uses. Its Mandate stays revoked: retry, wake and revive refuse it until the PM Mandate holds
   * again, and a `project` stop marks the Worker stopped without making it a person's stop.
   * @returns the IDs of the Tickets stopped.
   */
  revokeDelegated(effects: ReadonlyMap<string, PolicyEffect>): string[] {
    const revoked: string[] = []
    for (const ticket of this.repo.tickets.open()) {
      if (ticket.mandate.basis.via !== 'delegated' || !effects.has(ticket.id)) continue
      if (this.policy().revalidate(ticket.mandate)) continue
      try {
        this.hardStopWorker(ticket.id, { scope: 'project', by: 'policy', ...(ticket.projectId ? { projectId: ticket.projectId } : {}),
          reason: 'policyRevoked' })
        revoked.push(ticket.id)
      } catch {
        // Its revoked Mandate still keeps it from starting again, also when an already ended Worker leaves nothing to stop.
      }
    }
    return revoked
  }
  /**
   * Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. A ticket that
   * followed the Thread follows it no more, so its close no longer ends the ticket. Each ticket keeps deciding the messages
   * it received from the Thread.
   */
  dropSubscriptions(thread: string, by: 'person' | 'executor', ticketId?: string, reason?: string): boolean {
    const current = this.repo.threads.get(thread)
    const tickets = current?.subscriptions.filter(id => ticketId === undefined || id === ticketId) ?? []
    if (!current || !tickets.length) return false
    current.subscriptions = current.subscriptions.filter(id => !tickets.includes(id))
    this.repo.threads.save(current)
    for (const id of tickets) {
      const ticket = this.repo.tickets.get(id)
      if (!ticket?.follows?.some(item => item.thread === thread)) continue
      const { follows: before, ...rest } = ticket
      const follows = before.filter(item => item.thread !== thread)
      this.repo.tickets.save(follows.length ? { ...rest, follows } : rest)
    }
    for (const id of tickets) this.emit('thread.unsubscribed', { threadKey: current.key, ticketId: id, by, ...(reason ? { reason } : {}) })
    return true
  }
  /**
   * Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment whose launch
   * failed once no person is waited for: a Policy change alone does not launch it again.
   */
  addInput(ticket: Ticket, input: TicketInput, deliverWhileWaiting = false): void {
    if (ticket.inputs.some(existing => existing.id === input.id)) return
    ticket.inputs.push(input); ticket.updatedAt = this.now()
    // Hold back automated inputs while the worker is waiting on a person, unless a Project PM is answering that question.
    const held = !deliverWhileWaiting && liveTicket(ticket) && automatic(input) && waitsForPerson(ticket)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) this.options.executor.deliver(ticket, running)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.options.executor.start(ticket, latest)
  }
  /**
   * Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it: no Eval
   * and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds stays ended and
   * takes nothing (see `refuse`). While processing is paused the message waits, and the first pass after the pause resumes
   * the ticket under the Policy then. Reads the ticket afresh, so it is idempotent and leaves an already-resumed ticket alone.
   */
  wake(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || liveTicket(ticket) || ticket.archived || ticket.ended?.by === 'human' || ticket.ended?.outcome === 'handedOff'
      || ticket.manualStop || !ticket.undelivered.length) return
    // A paused Project accepts no new Assignment; the message waits for a person to resume it and retry explicitly.
    if (this.projectPaused(ticket)) return
    const policy = this.policy()
    if (policy.paused) return
    if (!policy.revalidate(ticket.mandate)) { this.refuse(ticket); return }
    // Only a human's message resumes an ended ticket; bot/CI triggers wait alongside inputs from before the ticket ended.
    const first = ticket.undelivered.map(id => ticket.inputs.find(input => input.id === id)).find(input => input?.kind === 'trigger' && input.human)
    if (first?.kind !== 'trigger') return
    const at = this.now()
    delete ticket.ended; ticket.updatedAt = at
    const assignment = this.newAssignment(ticket)
    // Prepend the resumed marker so it is delivered ahead of the waiting messages.
    const resumed: TicketInput = { id: key('input', ticket.id, 'resumed', first.triggerId), kind: 'resumed', triggerId: first.triggerId, at }
    ticket.inputs.push(resumed); ticket.undelivered.unshift(resumed.id)
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
    this.emit('ticket.resumed', { ticketId, triggerId: first.triggerId })
  }
  /** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap(input => input.kind === 'trigger' && (!ids || ids.includes(input.id))
      ? this.repo.triggers.get(input.triggerId) ?? [] : [])
  }
  /**
   * Whether a ticket's worker took a person's message up, by acknowledging or answering it. A message acknowledged before
   * acknowledgements were recorded on it has only the acknowledgement's message in the outbox.
   */
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    return acked ? acked.includes(ticket.id) : this.options.outbox.status(key('ack', trigger.id)) !== undefined
  }
  /** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(trigger => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger))
  }
  /**
   * A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the person's
   * messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and each of `left`
   * that no other ticket decides goes to Eval, as a person's message that reached no ticket does, unless a ticket took it
   * up, a Decision settled it, or it is the message a stop ended this ticket on.
   */
  private letGo(ticketId: string, waiting: readonly Trigger[], left: readonly Trigger[]): void {
    for (const trigger of [...waiting, ...left]) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      if (disposition?.fanout.includes(ticketId)) {
        this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: disposition.fanout.filter(id => id !== ticketId) })
      }
    }
    for (const trigger of left) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      const decision = disposition?.decisionId ? this.repo.decisions.get(disposition.decisionId) : undefined
      // The main Session that stopped this ticket on the message decides the rest of it itself, unless a ticket handed it back.
      const stopped = decision?.kind === 'stop' && decision.ticketId === ticketId && !disposition?.handbacks?.length
      const decided = !!decision && (settled(decision) || stopped)
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger)
    }
  }
  /** An ended ticket that cannot resume takes none of the messages that waited for it (see `letGo`). */
  private refuse(ticket: Ticket): void {
    const waiting = this.triggersOf(ticket, ticket.undelivered), left = this.untaken(ticket, ticket.undelivered)
    ticket.undelivered = []
    this.repo.tickets.save(ticket)
    this.letGo(ticket.id, waiting, left)
  }
  /** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason)
    this.requeueUntaken(ticket, running)
    const assignment = this.newAssignment(ticket)
    const at = this.now()
    const input: TicketInput = { id: key('input', ticket.id, 'restart', assignment.id), kind: 'text', text: note, at }
    ticket.inputs.push(input); ticket.undelivered.push(input.id); ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
  }
  /**
   * Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a cancel may
   * have dropped them, or a step that claimed them was cut off, and the new Assignment's launch takes a copy still waiting
   * in the Session out, so its delivery is the only one. An earlier end let go of what earlier Assignments left.
   */
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(input => input.kind === 'trigger' && input.readAt === null && input.deliveredTo === replaced.id
      && !ticket.undelivered.includes(input.id))
    ticket.undelivered.unshift(...untaken.map(input => input.id))
  }
  /**
   * End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
   * why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
   * the person's messages it decides that its worker did not read before its latest report or turn end, the report that
   * ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
   * the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
   */
  end(ticketId: string, by: TicketEndBy, outcome: TicketOutcome, at = this.now(), reason?: string): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    const stopping = ticket.assignments.filter(assignment => assignment.state !== 'ended')
    const why = reason && reason !== outcome ? { reason } : {}
    const until = readUntil(ticket)
    const waiting = this.triggersOf(ticket, ticket.undelivered)
    const left = this.untaken(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger'
      && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []))
    // An end dated earlier, such as a PR's merge, does not move the ticket's last change back.
    ticket.ended = { at, by, outcome, ...why }; ticket.undelivered = []; ticket.updatedAt = this.now()
    delete ticket.attention; delete ticket.delivery
    // The Assignments the end stops end with it; the ticket's end says why.
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at }
    this.repo.tickets.save(ticket)
    this.letGo(ticketId, waiting, left)
    this.emit('ticket.ended', { ticketId, by, outcome, ...why })
    for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome)
  }
  /**
   * Whether a ticket's work has not finished at a close at `at`: its worker took up a person's message the ticket decides and
   * has not reported other than progress, or ended a turn, since its Session took that message into a step, or work resumed
   * after the close, whose Assignment started after it, has no ready report or Input arrived after that report; a Policy
   * change asks for no work.
   */
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false)
    const taken = this.triggersOf(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []))
      .some(trigger => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger))
    const latest = latestAssignment(ticket)
    if (taken || !(Date.parse(latest?.createdAt ?? '') > Date.parse(at))) return taken
    const report = latest?.report
    const later = ticket.inputs.some(input => input.kind !== 'policy-changed' && Date.parse(input.at) > Date.parse(report?.at ?? ''))
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later
  }
  /** Whether the Ticket's Project is paused, which blocks every new Assignment, explicit or automatic. */
  private projectPaused(ticket: Pick<Ticket, 'projectId'>): boolean {
    return !!ticket.projectId && this.repo.projects.get(ticket.projectId)?.status === 'paused'
  }
  /**
   * Refuse to start work for a manually stopped Worker, or for a delegated Ticket whose Project PM Mandate no longer holds:
   * a `worker` stop needs a person's approval, and a `project` stop its PM's revive once the Project is active.
   */
  private refuseManualStop(ticket: Ticket): void {
    // A delegated Ticket whose Project PM Mandate no longer holds starts no new Assignment, whatever its stop label says.
    if (ticket.mandate.basis.via === 'delegated' && !this.policy().revalidate(ticket.mandate)) throw new UserError('mandateRevoked')
    const stop = ticket.manualStop
    if (!stop) return
    throw new UserError(stop.scope === 'worker' ? 'manualStopNeedsUserApproval' : 'manualStopProjectPaused')
  }
  /**
   * Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket.
   * @throws UserError when the Ticket carries a manual stop or belongs to a paused Project.
   */
  private newAssignment(ticket: Ticket): Assignment {
    this.refuseManualStop(ticket)
    if (this.projectPaused(ticket)) throw new UserError('projectPaused')
    const assignment: Assignment = { id: key('assignment', ticket.id, String(ticket.assignments.length)), state: 'pending',
      createdAt: this.now(), sessionId: workerSessionId(ticket.id, this.transferCount(ticket)) }
    ticket.assignments.push(assignment)
    delete ticket.delivery
    return assignment
  }
  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
    assignment.state = 'ended'; assignment.endedAt = this.now(); assignment.endedReason = reason
    this.emit('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
  /**
   * Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing (see `TicketInput`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at })
    return this.require(ticketId)
  }
  /**
   * Add a note Input under a caller-chosen deterministic id, so a repeated request with the same text adds it once.
   * @throws UserError when the ticket is unknown or has ended.
   */
  noteWithId(ticketId: string, text: string, id: string, deliverWhileWaiting = false): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    this.addInput(ticket, { id, kind: 'note', text, at: this.now() }, deliverWhileWaiting)
    return this.require(ticketId)
  }
  /**
   * Add a note Input under a deterministic id without delivering it or starting an Assignment, such as when its worker
   * Session is known to be archived.
   * @throws UserError when the ticket is unknown or has ended.
   */
  queueNoteWithId(ticketId: string, text: string, id: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (ticket.inputs.some(input => input.id === id)) return ticket
    const at = this.now()
    ticket.inputs.push({ id, kind: 'note', text, at })
    ticket.undelivered.push(id)
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return this.require(ticketId)
  }
  /**
   * Subscribe an open ticket to a Thread its Executor found related, for context: see `Thread.context`.
   * @returns false when the ticket follows the Thread already.
   * @throws UserError when the ticket is unknown or has ended.
   */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    if (this.thread(ref).subscriptions.includes(ticketId)) return false
    this.subscribe(ticketId, ref)
    const thread = this.thread(ref)
    thread.context = [...thread.context ?? [], ticketId]
    this.repo.threads.save(thread)
    return true
  }
  /** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) { thread.subscriptions.push(ticketId); this.emit('thread.subscribed', { threadKey: thread.key, ticketId }) }
    if (thread.context?.includes(ticketId)) thread.context = thread.context.filter(id => id !== ticketId)
    this.repo.threads.save(thread)
  }
}
