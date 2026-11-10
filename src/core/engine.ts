/** The domain Engine: the single entry point of the core, and the role interfaces its callers receive. */
import { UserError } from './errors.ts'
import { isoTime, liveTicket, pmSessionId, threadKey, WORK_TOOLS } from './model.ts'
import type { ChannelRef, Decision, PolicyEffect, ProjectProfile, ProjectTicketTask, ProjectTicketThread, ThreadRef, Ticket, Trigger } from './model.ts'
import { key } from './ids.ts'
import type { Candidate, Repositories } from './ports.ts'
import type { EngineOptions } from './part.ts'
import { Assignments, type WorkerReport } from './assignments.ts'
import { Evals, type Outcome } from './evals.ts'
import { Intake, type ReceiveResult } from './intake.ts'
import { Replies, type Reply, type ReplyRequest } from './replies.ts'
import { Tickets } from './tickets.ts'

export type { EngineOptions } from './part.ts'
export type { WorkerReport } from './assignments.ts'
export type { Outcome } from './evals.ts'
export type { ReceiveResult } from './intake.ts'
export type { Reply, ReplyRequest } from './replies.ts'

/** The bounds a PM's `orchestrator_project_ticket_create` request must keep; the tool schema states the same limits. */
export const PROJECT_TICKETS = { max: 5, title: 200, goal: 4000, scope: 1500, note: 500, threads: 10, threadKey: 300, tools: 32 } as const
const WORKTREE_NAME = /^[a-z]+(?:-[a-z0-9]+){0,3}$/
/** A short lowercase ASCII worktree name from an English title, or `task-<n>` when the title has none. */
function worktreeName(title: string, index: number): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 4).join('-').slice(0, 32)
    .replace(/-+$/, '')
  return slug && WORKTREE_NAME.test(slug) ? slug : `task-${index + 1}`
}
/** Parse a `source:id` thread key a PM named; `source` is a Source kind and the rest is the Source's own thread id. */
function projectThread(value: string): ThreadRef {
  const colon = value.indexOf(':')
  const source = colon > 0 ? value.slice(0, colon) : ''
  const id = colon > 0 ? value.slice(colon + 1) : ''
  if (!source || !id || value.length > PROJECT_TICKETS.threadKey || !/^[a-z][a-z0-9-]*$/.test(source) || !id.trim()) {
    throw new UserError('invalidThread', { thread: value })
  }
  return { source, id }
}
const invalidTask = (reason: string): never => { throw new UserError('invalidProjectTask', { reason }) }
/**
 * The tools a PM task allows: its explicit list, or the PM Mandate's when it names none; undefined means every work tool.
 * A list may only narrow the PM Mandate's, must name known work tools once each, and holds at most PROJECT_TICKETS.tools.
 */
function prepareAllowTools(value: unknown, inherited: readonly string[] | undefined): string[] | undefined {
  const base = inherited?.length ? [...inherited] : undefined
  if (value === undefined || value === null) return base
  if (!Array.isArray(value)) return invalidTask('allow_tools must be an array of tool names')
  if (value.length > PROJECT_TICKETS.tools) invalidTask(`allow_tools has more than ${PROJECT_TICKETS.tools} tools`)
  const tools: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) invalidTask('each allow_tools entry must be a tool name')
    const name = item.trim()
    if (!WORK_TOOLS.includes(name)) invalidTask(`unknown work tool "${name}"`)
    if (tools.includes(name)) invalidTask(`duplicate work tool "${name}"`)
    tools.push(name)
  }
  // An empty explicit list names no narrower set, so it keeps the PM Mandate's restriction or stays unrestricted.
  if (!tools.length) return base
  if (base) {
    const outside = tools.filter(name => !base.includes(name))
    if (outside.length) invalidTask(`allow_tools cannot widen the PM Mandate: ${outside.join(', ')}`)
  }
  return tools
}
/** One validated task, with its deterministic index, the tools it allows, and the Threads it subscribes to, deduplicated. */
interface PreparedProjectTask {
  index: number
  title: string
  goal: string
  scope: string
  note?: string
  worktree_name: string
  allowTools?: string[]
  threads: (ThreadRef & { contextOnly: boolean })[]
}
/** Validate one task and its Threads before the batch creates anything. */
function prepareProjectTask(task: ProjectTicketTask, index: number, inheritedTools: readonly string[] | undefined): PreparedProjectTask {
  const invalid = invalidTask
  if (!task || typeof task !== 'object') invalid('the task is not an object')
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const title = text(task.title), goal = text(task.goal), scope = text(task.scope), note = text(task.note)
  if (!title) invalid('title is required')
  if (title.length > PROJECT_TICKETS.title) invalid(`title exceeds ${PROJECT_TICKETS.title} characters`)
  if (!goal) invalid('goal is required')
  if (goal.length > PROJECT_TICKETS.goal) invalid(`goal exceeds ${PROJECT_TICKETS.goal} characters`)
  if (scope.length > PROJECT_TICKETS.scope) invalid(`scope exceeds ${PROJECT_TICKETS.scope} characters`)
  if (note.length > PROJECT_TICKETS.note) invalid(`note exceeds ${PROJECT_TICKETS.note} characters`)
  const worktree = text(task.worktree_name)
  if (worktree && (worktree.length > 32 || !WORKTREE_NAME.test(worktree))) {
    invalid(`worktree_name "${worktree}" is not 1-4 lowercase English kebab-case words of at most 32 characters`)
  }
  if (task.threads !== undefined && !Array.isArray(task.threads)) invalid('threads must be an array')
  const threads = new Map<string, ThreadRef & { contextOnly: boolean }>()
  for (const item of task.threads ?? []) {
    if (!item || typeof item !== 'object' || typeof item.key !== 'string') invalid('each thread needs a source:id key')
    const ref = projectThread(item.key.trim())
    const key = threadKey(ref)
    const previous = threads.get(key)
    // An ordinary Subscription outweighs an earlier context-only one for the same Thread.
    threads.set(key, { ...ref, contextOnly: previous ? previous.contextOnly && item.contextOnly === true : item.contextOnly === true })
  }
  if (threads.size > PROJECT_TICKETS.threads) invalid(`more than ${PROJECT_TICKETS.threads} threads`)
  const allowTools = prepareAllowTools((task as { allow_tools?: unknown }).allow_tools, inheritedTools)
  return { index, title, goal, scope: scope || goal, ...(note ? { note } : {}), worktree_name: worktree || worktreeName(title, index),
    ...(allowTools ? { allowTools } : {}), threads: [...threads.values()] }
}

/**
 * Single transactional entry point for mutating Triggers, Threads, Decisions, Tickets, and Assignments.
 * Coordinates Intake, Evals, Tickets, Assignments, and Replies inside synchronous repository transactions while queuing side
 * effects through ports. Callers receive role-scoped `Pick` interfaces rather than the full engine.
 */
export class Engine {
  private readonly repo: Repositories
  private readonly replies: Replies
  private readonly tickets: Tickets
  private readonly assignments: Assignments
  private readonly evals: Evals
  private readonly intake: Intake
  constructor(private readonly options: EngineOptions) {
    this.repo = options.repo
    this.replies = new Replies(options)
    this.tickets = new Tickets(options, this.replies)
    this.assignments = new Assignments(options, this.tickets, this.replies)
    this.evals = new Evals(options, this.tickets)
    this.intake = new Intake(options, this.tickets)
  }

  // Sources

  /**
   * A Source's request to take in a Trigger: store it once, fan it out to the tickets that subscribe to its Threads (to an
   * ended one only a person's message, which resumes it at once unless processing is paused, and to none a person stopped),
   * and queue it for Eval on its primary Thread unless a ticket's worker decides it (see `followupOwners`).
   * Triggers that arrive while an Eval of that Thread runs wait together for the next one.
   */
  receive(trigger: Trigger): ReceiveResult { return this.repo.atomic(() => this.intake.receive(trigger)) }
  /**
   * A Source's request to make an open ticket follow one of its Threads, such as a pull request's, `own` when the ticket
   * opened it: the ticket subscribes to it, and a ready report ends it only once `followsDone` holds (see `Tickets.followsDone`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  bindThread(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    return this.repo.atomic(() => this.tickets.bind(ticketId, thread, own))
  }
  /**
   * A Source's fact that a Thread closed, such as its pull request's merge, at the time it happened. An open ticket that
   * follows it ends once it is done with the Threads it follows, unless work resumed since the close has not finished, or
   * its worker took up a person's message the ticket decides after its latest report.
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    this.repo.atomic(() => { this.tickets.threadClosed(thread, outcome, isoTime(at)) })
  }

  // The clock

  /**
   * Requeues overdue Evals up to `REQUEUES` times before recording `unavailable` (undelivered Evals never expire), starts the
   * Evals of Threads whose queued Triggers wait, and resumes ended tickets a person's message reached while processing was
   * paused. While processing is paused, nothing expires: each Eval in progress notes when the pause began, and its deadline
   * moves forward by the pause's length once processing resumes. Each Eval and each ticket update takes one transaction.
   */
  evaluateDue(): void {
    const policy = this.options.policy()
    for (const thread of this.repo.threads.active()) if (thread.evaluating) this.repo.atomic(() => { this.evals.due(thread, policy) })
    if (policy.paused) return
    for (const ticket of this.repo.tickets.active()) {
      if (!liveTicket(ticket) && ticket.undelivered.length) this.repo.atomic(() => { this.tickets.wake(ticket.id) })
    }
    for (const thread of this.repo.threads.active()) {
      if (thread.pending.length && !thread.evaluating) this.repo.atomic(() => { this.evals.start(thread.key, policy) })
    }
  }

  // The main Session

  /** Register a direct user request for the main Session to route itself, without an assessment delivery. */
  recordTriggerForRouting(trigger: Trigger): ReceiveResult { return this.repo.atomic(() => this.intake.receive(trigger, false)) }

  /**
   * Create a Project from a Trigger, with its Project Profile, PM Mandate and `project` Decision in one transaction.
   * It is idempotent: the Project id derives from the Trigger, so a repeated call returns the Project created first.
   * The Decision comes from a gate-only Eval with a real Eval id, not from an assessor.
   * @throws UserError when the Trigger is unknown or not admissible.
   */
  createProject(triggerId: string, title: string, goal: string): ProjectProfile {
    return this.repo.atomic(() => {
      const projectId = key('project', triggerId)
      const existing = this.repo.projects.get(projectId)
      if (existing) return existing
      if (!this.repo.triggers.get(triggerId)) throw new UserError('unknownTrigger')
      const { decision, mandate } = this.evals.project(triggerId, projectId, goal)
      const project: ProjectProfile = { id: projectId, title, goal, status: 'active', decisionId: decision.id,
        pmSessionId: pmSessionId(projectId), mandate, createdAt: decision.at, updatedAt: decision.at }
      this.repo.projects.save(project)
      this.options.emit?.({ type: 'project.created', at: decision.at, data: { projectId, decisionId: decision.id, pmSessionId: project.pmSessionId } })
      return project
    })
  }
  /**
   * Create the Tickets a Project's PM delegated, one internal Trigger, record-only `delegated` Eval and Decision per task,
   * in one transaction: a task the PM's request cannot create leaves no Trigger, Decision or Ticket behind. Only the Project's
   * own PM Session may call it, and the Project must still be active. A repeated call reuses the Ticket each task index
   * produced before. No Ticket subscribes to the Project's source Thread; only the external Threads a task names.
   * @throws UserError when the Project is unknown or has ended, the caller is not its PM, or a task is invalid.
   */
  createProjectTickets(projectId: string, pmSessionId: string, tasks: readonly ProjectTicketTask[]): Ticket[] {
    return this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.pmSessionId !== pmSessionId) throw new UserError('notProjectPm')
      if (project.status === 'paused') throw new UserError('projectPaused')
      if (project.status !== 'active') throw new UserError('projectEnded')
      if (!tasks || !Array.isArray(tasks) || !tasks.length) throw new UserError('invalidProjectTask', { reason: 'give 1 to 5 tasks' })
      if (tasks.length > PROJECT_TICKETS.max) throw new UserError('invalidProjectTask', { reason: `at most ${PROJECT_TICKETS.max} tasks` })
      const inheritedTools = project.mandate.allowTools?.length ? project.mandate.allowTools : undefined
      const prepared = tasks.map((task, index) => prepareProjectTask(task, index, inheritedTools))
      const at = this.options.now?.() ?? new Date().toISOString()
      const existing = prepared.map(task => this.repo.tickets.get(key('ticket', project.id, 'delegated', String(task.index))))
      const names = new Set(existing.flatMap(ticket => ticket?.execution ? [ticket.execution.name.replace(`-${ticket.id.slice(0, 12)}`, '')] : []))
      for (const task of prepared) {
        if (!existing[task.index] && names.has(task.worktree_name)) throw new UserError('duplicateWorktree', { name: task.worktree_name })
        names.add(task.worktree_name)
      }
      return prepared.map(task => {
        const done = existing[task.index]
        if (done) return done
        const ticketId = key('ticket', project.id, 'delegated', String(task.index))
        const triggerId = key('trigger', project.id, 'delegated', String(task.index))
        const trigger: Trigger = { id: triggerId, source: 'internal', threads: [{ source: 'internal', id: triggerId }],
          actor: { source: 'internal', id: project.pmSessionId }, human: false, at, text: `${task.title}: ${task.goal}`,
          meta: { projectId: project.id, pmSessionId: project.pmSessionId, taskIndex: task.index, title: task.title, goal: task.goal,
            scope: task.scope, ...(task.note ? { note: task.note } : {}) } }
        this.repo.triggers.save(trigger)
        const { decision, mandate } = this.evals.delegated(trigger, project, ticketId, task.scope, task.allowTools)
        this.tickets.createDelegated(ticketId, decision.id, mandate, project.id, trigger, { kind: 'accept', title: task.title,
          scope: task.scope, reason: { code: 'projectTicketCreated', values: { project: project.id } }, name: task.worktree_name,
          ...(task.note ? { note: task.note } : {}) }, decision.at)
        for (const thread of task.threads) this.tickets.subscribeExternal(ticketId, thread, thread.contextOnly)
        return this.repo.tickets.get(ticketId)!
      })
    })
  }
  /**
   * Record a PM's report on its Project: the latest report the read views show.
   * @throws UserError when the Project is unknown.
   */
  projectReport(projectId: string, summary: string): ProjectProfile {
    return this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      const at = this.options.now?.() ?? new Date().toISOString()
      const reported: ProjectProfile = { ...project, latestReport: { summary, at }, updatedAt: at }
      this.repo.projects.save(reported)
      return reported
    })
  }

  /**
   * Pause or resume a Project: active ↔ paused only. An ended Project ignores the change and stays ended.
   * Existing child Tickets continue; only new Tickets are blocked while paused.
   * @throws UserError when the Project is unknown.
   */
  pauseProject(projectId: string, paused: boolean): ProjectProfile {
    return this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.status === 'ended') return project
      const status = paused ? 'paused' as const : 'active' as const
      if (project.status === status) return project
      const updated: ProjectProfile = { ...project, status, updatedAt: this.options.now?.() ?? new Date().toISOString() }
      this.repo.projects.save(updated)
      return updated
    })
  }
  /**
   * End a Project and cascade-stop every still-open Ticket it owns, using the ordinary Ticket stop semantics so history,
   * Sessions and directories stay. It is idempotent: an ended Project returns unchanged.
   * @throws UserError when the Project is unknown.
   */
  stopProject(projectId: string, reason?: string): ProjectProfile {
    return this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.status === 'ended') return project
      const updated: ProjectProfile = { ...project, status: 'ended', updatedAt: this.options.now?.() ?? new Date().toISOString() }
      this.repo.projects.save(updated)
      // The Project is ended first, so child lifecycle notices and relays fall back instead of pretending it is active.
      for (const ticket of this.repo.tickets.open()) if (ticket.projectId === projectId) this.tickets.stop(ticket.id, reason)
      return updated
    })
  }

  /** The candidate of the Eval that holds a Trigger, as its assessor sees it; undefined while no Eval holds it. */
  candidate(triggerId: string): Candidate | undefined { return this.evals.candidate(triggerId) }
  /**
   * Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does, such as a person's explicit
   * request the main Session routes. A proactive candidate is accepted only in `auto` mode with enabled rules its assessment
   * matched, and a Trigger that already started a ticket returns that ticket's Decision. An invalid stop is recorded as
   * `ignore`; one judged under an older Policy as `unavailable`.
   * @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
   * ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
   * mode or without enabled matching rules.
   */
  decide(triggerId: string, outcome: Outcome): Decision { return this.repo.atomic(() => this.evals.decide(triggerId, outcome)) }
  /**
   * Attach a Trigger to a ticket that the message points at: the ticket follows the Trigger's Threads and receives it as an
   * Input with the routing note, and the Eval that holds the Trigger ends, since the ticket has it now; the other Triggers of
   * its batch wait for a fresh Eval. A note for an Input the worker already received goes out as a new Input, and so does a
   * message the ticket let go, read for context only, or had before it ended. An ended ticket resumes under its Mandate, at
   * once unless processing is paused.
   * @throws UserError for a ticket a person stopped, which withdrew its Mandate, or one whose Mandate the Policy no longer holds.
   */
  attach(ticketId: string, triggerId: string, note?: string): Ticket {
    return this.repo.atomic(() => {
      // A message this ticket's worker handed back is not its work: attached here, no worker would decide it, and it could not be handed back again.
      const handedBack = this.repo.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === ticketId)
      if (handedBack) throw new UserError('handedBackHere')
      const trigger = this.tickets.attachable(ticketId, triggerId)
      this.evals.withdraw(trigger)
      this.tickets.attach(ticketId, trigger, note)
      this.evals.routed(triggerId, ticketId)
      this.tickets.wake(ticketId)
      return this.repo.tickets.get(ticketId)!
    })
  }
  /**
   * Ask a running worker that waits in `waiting` state for its status; any other worker is left alone.
   * @returns whether the worker was asked.
   * @throws UserError when the ticket is unknown.
   */
  requestStatus(ticketId: string): boolean { return this.repo.atomic(() => this.tickets.requestStatus(ticketId)) }
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where the person's message was
   * written, attention where the message that raised the question was, else, like a result, to the conversation the ticket
   * started in. A message queued before is not queued again (see `Replies.reply`).
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket that
   * is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply { return this.repo.atomic(() => this.replies.reply(request)) }

  // People, through the panel or the main Session

  /** The assessor delivered an Eval's candidate to its Session: the Eval's deadline counts from now. */
  candidateDelivered(evalId: string): void { this.repo.atomic(() => { this.evals.delivered(evalId, this.options.policy()) }) }
  /**
   * Queue a stored Trigger for a fresh Eval, such as a person's replay; returns false while an Eval holds it.
   * @throws UserError when the trigger is unknown.
   */
  reevaluate(triggerId: string): boolean { return this.repo.atomic(() => this.evals.reevaluate(triggerId)) }
  /**
   * A person dismisses the problem an unavailable Decision shows: the overview lists it no more.
   * @throws UserError for a Decision that is unknown or not unavailable.
   */
  dismiss(decisionId: string): Decision { return this.repo.atomic(() => this.evals.dismiss(decisionId)) }
  /**
   * Drop every ticket's Subscription to a Thread, until a new Decision subscribes one again.
   * @returns whether a Subscription was dropped.
   */
  unsubscribe(thread: string): boolean { return this.repo.atomic(() => this.tickets.dropSubscriptions(thread, 'person')) }
  /**
   * A person stops a ticket, which withdraws its Mandate: it ends and receives nothing more.
   * @throws UserError when the ticket is unknown.
   */
  stopTicket(ticketId: string, reason?: string): Ticket { return this.repo.atomic(() => this.tickets.stop(ticketId, reason)) }

  stopAssignment(ticketId: string, assignmentId: string): Ticket {
    return this.repo.atomic(() => this.tickets.stopAssignment(ticketId, assignmentId))
  }
  /**
   * A person retries a ticket whose worker reported failed or blocked (or whose input delivery failed): the stalled
   * Assignment ends and a new one starts under the same Mandate.
   * @throws UserError when the ticket is unknown, has ended, or is not retryable.
   */
  retryTicket(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.retry(ticketId)) }

  // The Executor

  /**
   * The Executor's fact that an Assignment runs; the Inputs that wait for it go out.
   * @throws UserError when the ticket is unknown.
   */
  assignmentStarted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.started(ticketId, assignmentId) })
  }
  /**
   * The Executor's fact that Inputs reached the Assignment that runs the ticket, which clears a failed delivery. A fact about
   * an Assignment that no longer runs is dropped. Its worker reads each once its Session takes it into a step (`inputsRead`).
   */
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.delivered(ticketId, assignmentId, inputIds) })
  }
  /**
   * The Executor's fact that the worker's Session of an open ticket took the messages that carried Inputs into a step, from
   * which its model reads them: a report or the end of a turn after that counts them as read at the ticket's end.
   * @throws UserError when the ticket is unknown.
   */
  inputsRead(ticketId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.read(ticketId, inputIds) })
  }
  /** The Executor's fact that a turn of the worker of the Assignment that runs the ticket ended, after a report too. */
  turnEnded(ticketId: string, assignmentId: string, interruptedAt?: string): void {
    this.repo.atomic(() => { this.assignments.turnEnded(ticketId, assignmentId, interruptedAt) })
  }
  turnBegan(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.turnBegan(ticketId, assignmentId) })
  }
  /** The Executor's fact that delivering Inputs to the Assignment that runs the ticket failed; the ticket shows it until a delivery succeeds. */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    this.repo.atomic(() => { this.assignments.deliveryFailed(ticketId, assignmentId, error) })
  }
  /**
   * A worker's request, through its Executor, to mark a Thread attached to its ticket unrelated, for `reason`: only that
   * ticket's Subscription drops, until a new Decision subscribes it again.
   * @throws UserError when the ticket is unknown, or for the Thread the ticket started on, one a Source bound it to (such as
   * its pull request's), or one it does not follow.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    this.repo.atomic(() => { this.tickets.markUnrelated(ticketId, thread, reason) })
  }
  /**
   * An Executor's Subscription to a Thread it found related, for context: see `Tickets.followForContext` and `Thread.context`.
   * @returns false when the ticket already follows the Thread.
   * @throws UserError when the ticket is unknown or has ended.
   */
  followForContext(ticketId: string, thread: ThreadRef): boolean {
    return this.repo.atomic(() => this.tickets.followForContext(ticketId, thread))
  }
  /**
   * A fact the main Session gives an open ticket's Executor: see `Tickets.note`.
   * @throws UserError when the ticket is unknown or has ended.
   */
  note(ticketId: string, text: string): Ticket { return this.repo.atomic(() => this.tickets.note(ticketId, text)) }
  /**
   * An Executor's hand-back of a message that reached its ticket but asks for more than it: see `Evals.handback`.
   * @returns whether it was queued for Eval: false while another ticket still decides it, and for one this ticket did not decide (see `Evals.handback`).
   * @throws UserError when the ticket or trigger is unknown, the trigger did not reach the ticket, or the ticket already handed it back.
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.repo.atomic(() => this.evals.handback(ticketId, triggerId, reason))
  }
  /**
   * Record a report on an open ticket's current Assignment. Its question for a person (`attention`) is asked, kept, or
   * cleared (`null` or a `ready` report), and a replaced attention question whose reply has not been sent yet is withdrawn
   * from the outbox. A `blocked` or `failed` report holds back automated inputs until a human message arrives. A `dropped`
   * report ends the ticket, and a `ready` report ends it: `completed` without followed Threads, else with the `followsDone`
   * outcome once `followsDone` holds.
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question that comes with a ready result or an
   * answer, or a question or answer that names a message that is not a person's or did not reach the ticket.
   */
  report(ticketId: string, report: WorkerReport): Ticket { return this.repo.atomic(() => this.assignments.report(ticketId, report)) }
  /**
   * Handles an assignment that was running when the host stopped: restarts it with a recovery note unless its latest report is
   * `waiting`, `ready`, `blocked`, or `failed` and no Input reached its worker after that report, in which case it keeps its
   * Session and state and gets the Inputs that wait for it.
   */
  assignmentInterrupted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.interrupted(ticketId, assignmentId) })
  }

  // Settings

  /**
   * The Policy changed: each open ticket in `effects` is told how the change bears on it, and Evals in progress start again
   * under the new version.
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect> = new Map()): void {
    this.repo.atomic(() => { this.tickets.policyChanged(from, to, effects); this.evals.policyChanged(from, to) })
  }
}

/** What Sources ask and tell the Engine. */
export type EngineForSources = Pick<Engine, 'receive' | 'bindThread' | 'threadClosed'>
/** What the main Session asks of the Engine. */
export type EngineForMainSession = Pick<Engine, 'recordTriggerForRouting' | 'createProject' | 'candidate' | 'candidateDelivered' | 'decide' | 'attach' | 'reply'
  | 'requestStatus' | 'note'>
/** What a Project's PM Session asks of the Engine. */
export type EngineForPM = Pick<Engine, 'projectReport' | 'createProjectTickets'>
/** What people ask of the Engine, through the panel or the main Session. */
export type EngineForPeople = Pick<Engine, 'stopTicket' | 'stopAssignment' | 'retryTicket' | 'reevaluate' | 'unsubscribe' | 'dismiss'
  | 'pauseProject' | 'stopProject'>
/** What Settings tells the Engine. */
export type EngineForSettings = Pick<Engine, 'policyChanged'>
/** What the Executor tells the Engine, and what its workers ask of it. */
export type EngineForExecutor = Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'turnBegan' | 'deliveryFailed'
  | 'assignmentInterrupted' | 'report' | 'markUnrelated' | 'handback' | 'followForContext' | 'reply'>
