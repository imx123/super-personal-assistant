/** The domain Engine: the single entry point of the core, and the role interfaces its callers receive. */
import { UserError } from './errors.ts'
import { assignmentSessionId, isoTime, latestAssignment, liveTicket, pmSessionId, runningAssignment, threadKey, waitsForPerson,
  workerSessionId, WORK_TOOLS } from './model.ts'
import type { ChannelRef, Decision, Handoff, PolicyEffect, ProjectNote, ProjectProfile, ProjectTicketTask, ProjectTicketThread, ThreadRef,
  Ticket, Trigger } from './model.ts'
import { key } from './ids.ts'
import type { Candidate, Repositories } from './ports.ts'
import type { EngineOptions } from './part.ts'
import { Assignments, type WorkerReport } from './assignments.ts'
import { Evals, type Outcome } from './evals.ts'
import { Intake, type ReceiveResult } from './intake.ts'
import { Replies, type Reply, type ReplyRequest } from './replies.ts'
import { canRetry } from './stage.ts'
import { Tickets } from './tickets.ts'

export type { EngineOptions } from './part.ts'
export type { WorkerReport } from './assignments.ts'
export type { Outcome } from './evals.ts'
export type { ReceiveResult } from './intake.ts'
export type { Reply, ReplyRequest } from './replies.ts'

/** How a PM's message to a child Ticket reached its worker: routed to a running one, started an Assignment, queued only, or not started. */
export type TicketMessageDelivery = 'running' | 'started' | 'queued' | 'not_started'

/** What a Project pause did to its Workers: those stopped, and those a failure left running for a person to retry. */
export interface ProjectPauseWorkers {
  stopped: string[]
  failures: { ticketId: string; error: string }[]
}
/** A Project pause or resume with the report of the Workers it stopped, which the panel shows beside the Project state. */
export interface ProjectPauseReport {
  project: ProjectProfile
  workers: ProjectPauseWorkers
}
/** A same-Project handoff: why the Worker changes and what its successor needs to continue. */
export interface TicketHandoffRequest { reason: string; summary: string; unfinished?: string[] }
/** A cross-Project handoff request: the Ticket its target Project's PM should create, plus what to carry over. */
export interface ProjectHandoffRequest extends TicketHandoffRequest {
  targetProjectId: string
  title: string
  goal: string
  scope?: string
  worktree_name?: string
}
/** What a target PM decided about a cross-Project handoff, and the Ticket it created when accepted. */
export interface ProjectHandoffResult { handoff: Handoff; ticket?: Ticket }
/** A same-Project split: the new Ticket the PM creates when a Worker reports work beyond its own Ticket. */
export interface TicketSplitRequest extends TicketHandoffRequest { title: string; goal: string; scope?: string; worktree_name?: string }
/** The bounds a cross-Project handoff's summary and unfinished items keep. */
export const HANDOFF = { summary: 4000, unfinished: 20, item: 500 } as const

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
/** Validate the task and carry-over fields of a cross-Project handoff before any state changes. */
function prepareHandoff(input: ProjectHandoffRequest): { request: NonNullable<Handoff['request']>; reason: string; summary: string;
  unfinished?: string[] } {
  const invalid = (reason: string): never => { throw new UserError('invalidHandoff', { reason }) }
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const title = text(input.title), goal = text(input.goal), scope = text(input.scope), reason = text(input.reason)
  const summary = text(input.summary), worktree = text(input.worktree_name)
  if (!title) invalid('title is required')
  if (title.length > PROJECT_TICKETS.title) invalid(`title exceeds ${PROJECT_TICKETS.title} characters`)
  if (!goal) invalid('goal is required')
  if (goal.length > PROJECT_TICKETS.goal) invalid(`goal exceeds ${PROJECT_TICKETS.goal} characters`)
  if (scope.length > PROJECT_TICKETS.scope) invalid(`scope exceeds ${PROJECT_TICKETS.scope} characters`)
  if (!reason) invalid('reason is required')
  if (reason.length > 500) invalid('reason exceeds 500 characters')
  if (!summary) invalid('summary is required')
  if (summary.length > HANDOFF.summary) invalid(`summary exceeds ${HANDOFF.summary} characters`)
  if (worktree && (worktree.length > 32 || !WORKTREE_NAME.test(worktree))) {
    invalid(`worktree_name "${worktree}" is not 1-4 lowercase English kebab-case words of at most 32 characters`)
  }
  const unfinished = input.unfinished
  if (unfinished !== undefined && !Array.isArray(unfinished)) invalid('unfinished must be an array of work items')
  const items = (unfinished ?? []).map(text)
  if (items.length > HANDOFF.unfinished) invalid(`more than ${HANDOFF.unfinished} unfinished items`)
  if (items.some(item => !item || item.length > HANDOFF.item)) invalid(`each unfinished item needs 1-${HANDOFF.item} characters`)
  return { request: { title, goal, scope: scope || goal, ...(worktree ? { worktree_name: worktree } : {}) }, reason, summary,
    ...items.length ? { unfinished: items } : {} }
}
/** The useful text of a failure, including the causes of an Executor's AggregateError. */
function errorText(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(item => item instanceof Error ? item.message : String(item)).filter(Boolean)
    return causes.length ? causes.join('; ') : error.message
  }
  return error instanceof Error ? error.message : String(error)
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
 * The content-derived key of one PM Ticket batch: replaying the same tasks reaches the same Tickets, while a new batch gets
 * new ones even at the same task positions (P2-A02). Every field that shapes the Ticket is part of the key, so a changed
 * goal, scope, note, worktree name, tool allowlist or Thread set is a different batch.
 */
function batchKey(projectId: string, tasks: readonly PreparedProjectTask[]): string {
  const canonical = tasks.map(task => ({ index: task.index, title: task.title, goal: task.goal, scope: task.scope,
    note: task.note ?? null, worktree_name: task.worktree_name, allowTools: task.allowTools ?? null,
    threads: task.threads.map(thread => ({ source: thread.source, id: thread.id, contextOnly: thread.contextOnly })) }))
  return key('project-tickets', projectId, JSON.stringify(canonical))
}
/** The Ticket a batch's task position created; a new batch has its own ids. */
const ticketIdFor = (projectId: string, batch: string, index: number): string =>
  key('ticket', projectId, 'delegated', batch, String(index))
/** The worktree name a Ticket's execution directory carries, without the Ticket id suffix. */
const worktreeOf = (ticket: Ticket): string => ticket.execution!.name.replace(`-${ticket.id.slice(0, 12)}`, '')

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
   * own PM Session may call it, and the Project must still be active. A repeated call with the same tasks reuses the Tickets
   * that batch produced; a new batch gets new Tickets even at the same positions. No Ticket subscribes to the Project's source
   * Thread; only the external Threads a task names.
   * @throws UserError when the Project is unknown or has ended, the caller is not its PM, a task is invalid, or a worktree
   * name is already used in the Project.
   */
  createProjectTickets(projectId: string, pmSessionId: string, tasks: readonly ProjectTicketTask[]): Ticket[] {
    return this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.pmSessionId !== pmSessionId) throw new UserError('notProjectPm')
      if (project.status === 'archived') throw new UserError('projectArchived')
      if (project.status === 'paused') throw new UserError('projectPaused')
      if (project.status !== 'active') throw new UserError('projectEnded')
      if (!tasks || !Array.isArray(tasks) || !tasks.length) throw new UserError('invalidProjectTask', { reason: 'give 1 to 5 tasks' })
      if (tasks.length > PROJECT_TICKETS.max) throw new UserError('invalidProjectTask', { reason: `at most ${PROJECT_TICKETS.max} tasks` })
      const inheritedTools = project.mandate.allowTools?.length ? project.mandate.allowTools : undefined
      const prepared = tasks.map((task, index) => prepareProjectTask(task, index, inheritedTools))
      const at = this.options.now?.() ?? new Date().toISOString()
      const batch = batchKey(project.id, prepared)
      const existing = prepared.map(task => this.repo.tickets.get(ticketIdFor(project.id, batch, task.index)))
      // Worktree names stay unique within the Project, across batches: an earlier Ticket keeps its directory.
      const names = new Set(this.repo.tickets.list().filter(ticket => ticket.projectId === project.id)
        .flatMap(ticket => ticket.execution ? [worktreeOf(ticket)] : []))
      for (const task of prepared) {
        if (!existing[task.index] && names.has(task.worktree_name)) throw new UserError('duplicateWorktree', { name: task.worktree_name })
        names.add(task.worktree_name)
      }
      return prepared.map(task => {
        const done = existing[task.index]
        if (done) return done
        const ticketId = ticketIdFor(project.id, batch, task.index)
        const triggerId = key('trigger', project.id, 'delegated', batch, String(task.index))
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
   * Pause or resume a Project: active ↔ paused only. An ended or archived Project ignores the change.
   * A soft pause blocks new Tickets and Assignments while running Assignments finish; a hard pause stops the Project's
   * Workers one by one through `Tickets.hardStopWorker`, so each ends exactly as a person's single stop would, records a
   * `project` manual stop unless it already carries a `worker` one, and asks the Executor to stop it. A Worker that fails
   * to stop, or whose background cleanup cannot finish, is reported and the rest still stop; the Project is paused either way.
   * Resuming clears only its Workers' `project` stops, never their `worker` stops, and adds one `resumedFromHard` note for
   * the PM; it restarts nothing.
   *
   * This synchronous state-only form does not wait for the started background cleanups and emits no
   * `project.pausedByUser`: that aggregate notice claims `stopped`, which is only true after the cleanups. Use
   * `pauseProjectReport` for the report and the Router notice.
   * @throws UserError when the Project is unknown or the mode is not `soft`/`hard`.
   */
  pauseProject(projectId: string, paused: boolean, mode: 'soft' | 'hard' = 'soft'): ProjectProfile {
    const begun = this.repo.atomic(() => this.pauseProjectNow(projectId, paused, mode))
    return begun.report.project
  }
  /**
   * `pauseProject`, with the Workers a hard pause stopped and the ones it failed to stop, after waiting for every started
   * background cleanup. A cleanup that rejects moves its Ticket from `stopped` to `failures`, so neither the API result nor
   * the Router notice claims a Worker was stopped while its jobs may still run.
   */
  async pauseProjectReport(projectId: string, paused: boolean, mode: 'soft' | 'hard' = 'soft'): Promise<ProjectPauseReport> {
    const begun = this.repo.atomic(() => this.pauseProjectNow(projectId, paused, mode))
    for (const { ticketId, work } of begun.cleanups) {
      try {
        await work
      } catch (error) {
        begun.report.workers.stopped = begun.report.workers.stopped.filter(id => id !== ticketId)
        begun.report.workers.failures.push({ ticketId, error: errorText(error) })
      }
    }
    if (begun.hardChanged) this.emitPausedByUser(begun)
    return begun.report
  }
  /** Apply the pause/resume transaction and collect the Worker cleanups a hard pause started; the caller reports them. */
  private pauseProjectNow(projectId: string, paused: boolean, mode: 'soft' | 'hard'):
    { report: ProjectPauseReport; cleanups: { ticketId: string; work: Promise<void> }[]; hardChanged: boolean; at: string } {
    if (mode !== 'soft' && mode !== 'hard') throw new UserError('projectPauseMode')
    return this.repo.atomic(() => {
      const workers: ProjectPauseWorkers = { stopped: [], failures: [] }
      const cleanups: { ticketId: string; work: Promise<void> }[] = []
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      const at = this.options.now?.() ?? new Date().toISOString()
      if (project.status === 'ended' || project.status === 'archived') {
        return { report: { project, workers }, cleanups, hardChanged: false, at }
      }
      if (!paused) {
        if (project.status !== 'paused') return { report: { project, workers }, cleanups, hardChanged: false, at }
        const active: ProjectProfile = { ...project, status: 'active', updatedAt: at }
        delete active.pauseMode
        if (project.pauseMode === 'hard') {
          const note: ProjectNote = { id: key('project-note', project.id, 'resumedFromHard', at), at, kind: 'resumedFromHard',
            sessionId: project.pmSessionId,
            text: 'The Project resumed from a hard pause. Read the Project and its Tickets and synchronize their state before '
              + 'continuing; interrupted Assignments were not retried.' }
          active.pendingNotes = [...project.pendingNotes ?? [], note]
        }
        this.repo.projects.save(active)
        // Only the stops the hard pause wrote go: a person's stop of one Worker stays until a person approves its resume.
        this.tickets.clearProjectManualStops(projectId, 'user')
        this.options.emit?.({ type: 'project.resumed', at, data: { projectId, ...(project.pauseMode ? { mode: project.pauseMode } : {}) } })
        return { report: { project: this.repo.projects.get(projectId)!, workers }, cleanups, hardChanged: false, at }
      }
      // A hard pause is not downgraded by a later soft request; it ends only on resume.
      if (project.status === 'paused' && project.pauseMode === 'hard' && mode === 'soft') {
        return { report: { project, workers }, cleanups, hardChanged: false, at }
      }
      if (project.status === 'paused' && project.pauseMode === mode) return { report: { project, workers }, cleanups, hardChanged: false, at }
      const pausedProject: ProjectProfile = { ...project, status: 'paused', pauseMode: mode, updatedAt: at }
      this.repo.projects.save(pausedProject)
      this.options.emit?.({ type: 'project.paused', at, data: { projectId, mode,
        ...(project.status === 'paused' && project.pauseMode ? { from: project.pauseMode } : {}) } })
      const hardChanged = mode === 'hard'
      if (hardChanged) {
        // Each Worker stops in its own transaction through the one primitive a person's stop uses, so its failure leaves the
        // others stopping and the Project still pauses; the aggregate event tells the Router which ones failed.
        for (const ticket of this.repo.tickets.open()) {
          if (ticket.projectId !== projectId) continue
          const local: { ticketId: string; work: Promise<void> }[] = []
          try {
            this.repo.atomic(() => this.tickets.hardStopWorker(ticket.id, { scope: 'project', by: 'user', projectId,
              reason: 'projectPausedByUser', cleanups: local }))
            workers.stopped.push(ticket.id)
            cleanups.push(...local)
          } catch (error) {
            workers.failures.push({ ticketId: ticket.id, error: errorText(error) })
          }
        }
      }
      return { report: { project: this.repo.projects.get(projectId)!, workers }, cleanups, hardChanged, at }
    })
  }
  /** Emit the aggregate hard-pause event the Runtime relays to the Router, with the failures known when it is emitted. */
  private emitPausedByUser(begun: { report: ProjectPauseReport; at: string }): void {
    this.options.emit?.({ type: 'project.pausedByUser', at: begun.at, data: { projectId: begun.report.project.id, mode: 'hard',
      stopped: [...begun.report.workers.stopped], failures: [...begun.report.workers.failures] } })
  }
  /**
   * A person's explicit approval to make a Worker that a single stop ended resumable: clear its `worker` stop. It restarts
   * nothing; the Project's PM revives the Worker on its next revive. A Project stop is not cleared here.
   * @throws UserError when the Ticket is unknown or carries no `worker` stop.
   */
  allowResume(ticketId: string): Ticket {
    return this.repo.atomic(() => this.tickets.clearManualStop(ticketId, 'worker', 'user'))
  }
  /**
   * A Project PM revives one of its Workers that a hard pause stopped: the Project must be active, the Ticket must be its
   * own and open, and the stop must be the Project's rather than a person's. The Ticket keeps its Mandate and worktree; one
   * new Assignment starts and no Decision is created.
   * @throws UserError when the Project is unknown, paused, archived or ended, the caller is not its PM, the Ticket is not
   * its own or is ended, it has no Project stop, still has an active Assignment, or carries a person's stop.
   */
  reviveProjectTicket(projectId: string, pmSessionId: string, ticketId: string): Ticket {
    return this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.pmSessionId !== pmSessionId) throw new UserError('notProjectPm')
      if (project.status === 'archived') throw new UserError('projectArchived')
      if (project.status === 'paused') throw new UserError('projectPaused')
      if (project.status !== 'active') throw new UserError('projectEnded')
      return this.tickets.revive(ticketId, projectId, pmSessionId)
    })
  }
  /**
   * A Project PM moves one of its Tickets to a new Worker: the same Ticket, Mandate and worktree, a new Session named
   * `worker-<ticketId>-h<seq>`, and the old Assignment and Session stopped. The new Assignment starts only after the old
   * Worker's background cleanup succeeds; a cleanup failure, or a stop, retry or second transfer during the cleanup,
   * ends it as `handoffCleanupFailed` or fails its Handoff instead of starting a replacement Session over work that may
   * still run. Only the PM may call it; a Worker can only report that it needs another Worker.
   * @throws UserError when the Project is unknown, paused, archived or ended, the caller is not its PM, or the Ticket is not
   * its own, is ended, carries a manual stop, or has no running or pending Assignment; or when the cleanup fails.
   */
  async transferTicket(projectId: string, pmSessionId: string, ticketId: string, request: TicketHandoffRequest): Promise<Ticket> {
    const summary = typeof request?.summary === 'string' ? request.summary.trim() : ''
    if (!summary) throw new UserError('invalidHandoff', { reason: 'summary is required' })
    if (summary.length > HANDOFF.summary) throw new UserError('invalidHandoff', { reason: `summary exceeds ${HANDOFF.summary} characters` })
    const begun = this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.pmSessionId !== pmSessionId) throw new UserError('notProjectPm')
      if (project.status === 'archived') throw new UserError('projectArchived')
      if (project.status === 'paused') throw new UserError('projectPaused')
      if (project.status !== 'active') throw new UserError('projectEnded')
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || ticket.projectId !== projectId) throw new UserError('notProjectTicket')
      return this.tickets.beginTransfer(ticketId, projectId, pmSessionId, { reason: request.reason?.trim() || 'Handed to a new Worker',
        summary, ...request.unfinished?.length ? { unfinished: request.unfinished } : {} })
    })
    if (begun.work) {
      try {
        await begun.work
      } catch (error) {
        const message = errorText(error)
        this.repo.atomic(() => this.tickets.failTransfer(ticketId, begun.assignmentId, begun.handoffId, message))
        throw new UserError('handoffCleanupFailed', { error: message.slice(0, 300) })
      }
    }
    try {
      return this.repo.atomic(() => {
        const project = this.repo.projects.get(projectId)
        if (!project) throw new UserError('unknownProject')
        if (project.status === 'paused') throw new UserError('projectPaused')
        if (project.status === 'archived') throw new UserError('projectArchived')
        if (project.status !== 'active') throw new UserError('projectEnded')
        return this.tickets.completeTransfer(ticketId, begun.assignmentId, begun.handoffId)
      })
    } catch (error) {
      this.repo.atomic(() => this.tickets.failTransfer(ticketId, begun.assignmentId, begun.handoffId,
        `The handoff could not start its replacement Worker: ${errorText(error)}`))
      throw error
    }
  }
  /**
   * A Project PM answers a Worker's "this is beyond my Ticket" report by creating an independent Ticket in the same Project
   * and ending the source Ticket as `handedOff`: a `split` Handoff binds the exact source Assignment/Session to the new
   * Ticket's first Assignment, the new Ticket gets its own Delegated Decision, Mandate, worktree and briefing, and the two
   * Tickets are peers (no parent). The PM chooses the new task; a Worker can only report the need.
   *
   * It stops the source Worker first and waits for its background cleanup: the new Ticket, its Handoff and the source
   * Ticket's `handedOff` end commit only after that cleanup succeeded, so no Worker starts over work that still runs. A
   * failed cleanup, or a stop or Project change during it, leaves the source Ticket open with a `failed` Handoff and a
   * `delivery.error` and starts nothing.
   * @throws UserError when the Project is unknown or not active, the caller is not its PM, the source Ticket is not its own,
   * ended or manually stopped, its latest Assignment ended, or the new task is invalid or reuses the Project's worktree
   * name; or when the source Worker's background cleanup fails.
   */
  async splitTicket(projectId: string, pmSessionId: string, ticketId: string, input: TicketSplitRequest): Promise<ProjectHandoffResult> {
    const prepared = prepareHandoff({ ...input, targetProjectId: projectId })
    const begun = this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.pmSessionId !== pmSessionId) throw new UserError('notProjectPm')
      if (project.status === 'archived') throw new UserError('projectArchived')
      if (project.status === 'paused') throw new UserError('projectPaused')
      if (project.status !== 'active') throw new UserError('projectEnded')
      const source = this.repo.tickets.get(ticketId)
      if (!source || source.projectId !== projectId) throw new UserError('notProjectTicket')
      if (!liveTicket(source)) throw new UserError('ticketEnded')
      if (source.manualStop) throw new UserError(source.manualStop.scope === 'worker'
        ? 'manualStopNeedsUserApproval' : 'manualStopProjectPaused')
      const latest = latestAssignment(source)
      if (!latest || latest.state === 'ended') throw new UserError('notHandoffable')
      // The new Ticket's worktree must be free before the source Worker stops, so a refused task cannot also stop it.
      this.assertWorktreeFree(projectId, prepared.request.title, prepared.request.worktree_name)
      const at = this.options.now?.() ?? new Date().toISOString()
      // The Handoff is `starting` while the source Worker stops; a host restart leaves it for startup recovery to fail,
      // never a pending record whose Assignment already ended.
      const starting: Handoff = { id: key('handoff', ticketId, 'split', latest.id, at), at, kind: 'split', status: 'starting',
        from: { ticketId, projectId, assignmentId: latest.id, sessionId: assignmentSessionId(ticketId, latest) },
        to: { projectId }, reason: prepared.reason, summary: prepared.summary,
        ...prepared.unfinished ? { unfinished: prepared.unfinished } : {}, request: prepared.request,
        approvedBy: { kind: 'pm', sessionId: pmSessionId } }
      source.handoffs = [...source.handoffs ?? [], starting]
      source.updatedAt = at
      this.repo.tickets.save(source)
      const { work } = this.tickets.beginHandoffAway(ticketId, 'Split into a new Ticket in this Project')
      return { handoff: starting, work }
    })
    if (begun.work) {
      try {
        await begun.work
      } catch (error) {
        const message = errorText(error)
        this.repo.atomic(() => this.tickets.failHandoffAway(ticketId, begun.handoff.id, message))
        throw new UserError('handoffCleanupFailed', { error: message.slice(0, 300) })
      }
    }
    try {
      return this.repo.atomic(() => this.completeSplit(projectId, pmSessionId, ticketId, begun.handoff.id))
    } catch (error) {
      this.repo.atomic(() => this.tickets.failHandoffAway(ticketId, begun.handoff.id, errorText(error)))
      throw error
    }
  }
  /**
   * Finish a split after its source Worker's cleanup: recheck the source Ticket and its pending Handoff, create the
   * independent Ticket and only then end the source Ticket `handedOff`. It runs in the same transaction as the accepted
   * Handoff on both sides, so an interrupted attempt leaves neither a target Ticket nor an accepted record.
   */
  private completeSplit(projectId: string, pmSessionId: string, ticketId: string, handoffId: string): ProjectHandoffResult {
    const project = this.repo.projects.get(projectId)
    if (!project) throw new UserError('unknownProject')
    if (project.pmSessionId !== pmSessionId) throw new UserError('notProjectPm')
    if (project.status === 'archived') throw new UserError('projectArchived')
    if (project.status === 'paused') throw new UserError('projectPaused')
    if (project.status !== 'active') throw new UserError('projectEnded')
    const source = this.repo.tickets.get(ticketId)
    if (!source || source.projectId !== projectId) throw new UserError('notProjectTicket')
    if (!liveTicket(source)) throw new UserError('ticketEnded')
    if (source.manualStop) throw new UserError(source.manualStop.scope === 'worker'
      ? 'manualStopNeedsUserApproval' : 'manualStopProjectPaused')
    const pending = source.handoffs?.find(item => item.id === handoffId)
    if (!pending || pending.kind !== 'split' || pending.status !== 'starting') throw new UserError('handoffHandled')
    const latest = latestAssignment(source)
    if (!latest || latest.id !== pending.from.assignmentId || latest.state !== 'ended' || latest.endedReason !== 'handedOff') {
      throw new UserError('notHandoffable')
    }
    const request = pending.request
    if (!request) throw new UserError('invalidHandoff', { reason: 'the handoff names no Ticket task' })
    const at = this.options.now?.() ?? new Date().toISOString()
    const [created] = this.createProjectTickets(projectId, pmSessionId, [{ title: request.title,
      goal: request.goal, scope: request.scope, worktree_name: request.worktree_name,
      note: `Split from Ticket ${ticketId} after its Worker reported work beyond it. Read the handoff summary and unfinished `
        + "work in this Ticket's handoff briefing." }])
    const target = this.repo.tickets.get(created!.id)!
    const targetAssignment = target.assignments.at(-1)
    const accepted: Handoff = { ...pending, status: 'accepted', decidedAt: at,
      to: { ticketId: target.id, projectId, ...targetAssignment ? { assignmentId: targetAssignment.id } : {},
        sessionId: targetAssignment ? assignmentSessionId(target.id, targetAssignment) : workerSessionId(target.id) } }
    const siblings = this.repo.tickets.get(ticketId)!
    siblings.handoffs = (siblings.handoffs ?? []).map(item => item.id === accepted.id ? accepted
      : item.status === 'pending' && item.kind === 'split'
        ? { ...item, status: 'rejected' as const, decidedAt: at, decisionReason: `Split into Ticket ${target.id}` } : item)
    siblings.updatedAt = at
    this.repo.tickets.save(siblings)
    target.handoffs = [...target.handoffs ?? [], accepted]
    target.updatedAt = at
    this.repo.tickets.save(target)
    this.tickets.briefHandoff(target, accepted, false)
    this.tickets.completeHandoffAway(ticketId, `Split into Ticket ${target.id}`)
    this.options.emit?.({ type: 'ticket.handedOff', at, data: { ticketId, handoffId: accepted.id, kind: 'split',
      toTicketId: target.id, toSessionId: accepted.to.sessionId! } })
    return { handoff: accepted, ticket: this.repo.tickets.get(target.id)! }
  }
  /** Refuse a split or accepted handoff whose target Ticket would reuse a worktree name of the target Project. */
  private assertWorktreeFree(projectId: string, title: string, requested?: string): void {
    const name = requested || worktreeName(title, 0)
    const taken = this.repo.tickets.list().some(ticket => ticket.projectId === projectId && !!ticket.execution
      && worktreeOf(ticket) === name)
    if (taken) throw new UserError('duplicateWorktree', { name })
  }
  /**
   * A source Project's PM asks another Project's PM to take over work beyond its Project: the request names the new Ticket
   * the target would create, and carries only a summary, the unfinished items and links, never the worktree or uncommitted
   * changes. It is pending until the target PM decides; the source Ticket keeps running meanwhile. Repeated identical
   * requests return the same record.
   * @throws UserError when either Project is unknown or not active, the caller is not the source PM, the target is the
   * source, or the Ticket is not the source's, is ended, or has no running or pending Assignment.
   */
  requestProjectHandoff(projectId: string, pmSessionId: string, ticketId: string, input: ProjectHandoffRequest): Handoff {
    return this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.pmSessionId !== pmSessionId) throw new UserError('notProjectPm')
      if (project.status === 'archived') throw new UserError('projectArchived')
      if (project.status === 'paused') throw new UserError('projectPaused')
      if (project.status !== 'active') throw new UserError('projectEnded')
      const targetId = typeof input?.targetProjectId === 'string' ? input.targetProjectId.trim() : ''
      const target = targetId ? this.repo.projects.get(targetId) : undefined
      if (!target) throw new UserError('unknownProject')
      if (target.id === project.id) throw new UserError('handoffTarget')
      if (target.status === 'archived') throw new UserError('projectArchived')
      if (target.status === 'paused') throw new UserError('projectPaused')
      if (target.status !== 'active') throw new UserError('projectEnded')
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || ticket.projectId !== projectId) throw new UserError('notProjectTicket')
      if (!liveTicket(ticket)) throw new UserError('ticketEnded')
      if (ticket.manualStop) throw new UserError(ticket.manualStop.scope === 'worker' ? 'manualStopNeedsUserApproval' : 'manualStopProjectPaused')
      const latest = latestAssignment(ticket)
      if (!latest || latest.state === 'ended') throw new UserError('notHandoffable')
      const prepared = prepareHandoff(input)
      const assignmentId = latest.id
      const sessionId = assignmentSessionId(ticket.id, latest)
      // Bind the request to the Assignment and Session that made it: after a transfer or a revive, the same content is a new
      // request, and the old one can no longer finalize the Ticket.
      const id = key('handoff', ticketId, target.id, assignmentId, sessionId, JSON.stringify({ ...prepared, reason: prepared.reason }))
      const existing = ticket.handoffs?.find(handoff => handoff.id === id)
      if (existing) {
        // A request recorded before assignment binding is upgraded in place on a fresh request with the same content.
        if (existing.from.assignmentId) return existing
        const upgraded: Handoff = { ...existing, from: { ...existing.from, assignmentId, sessionId } }
        ticket.handoffs = (ticket.handoffs ?? []).map(item => item.id === existing.id ? upgraded : item)
        ticket.updatedAt = this.options.now?.() ?? new Date().toISOString()
        this.repo.tickets.save(ticket)
        return upgraded
      }
      const at = this.options.now?.() ?? new Date().toISOString()
      const handoff: Handoff = { id, at, kind: 'split', status: 'pending',
        from: { ticketId, projectId, assignmentId, sessionId }, to: { projectId: target.id },
        reason: prepared.reason, summary: prepared.summary, ...prepared.unfinished ? { unfinished: prepared.unfinished } : {},
        request: prepared.request }
      ticket.handoffs = [...ticket.handoffs ?? [], handoff]
      ticket.updatedAt = at
      this.repo.tickets.save(ticket)
      return handoff
    })
  }
  /**
   * The target Project's PM decides a pending cross-Project handoff. Rejecting marks it rejected and leaves the source
   * Ticket running. Accepting claims the request as `starting` (a concurrent decision refuses), stops the source Worker
   * and waits for its background cleanup; only then does it create
   * a new, independent Ticket in the target Project under its own Mandate and worktree (new Decision, no parent), record
   * the accepted Handoff on both Tickets, and end the source Ticket with outcome `handedOff` after its Assignment and
   * Session stopped. A failed cleanup, or a change to either Ticket during it, leaves a `failed` Handoff and a
   * `delivery.error` on the source Ticket and starts nothing. Links carry over; worktrees and uncommitted changes do not.
   * @throws UserError when either Project is unknown, paused, archived or ended, the caller is not the target PM, the
   * Handoff is unknown, already decided or not addressed to this Project, the source Ticket or its Assignment is no longer
   * current, or the source Worker's background cleanup fails.
   */
  async decideProjectHandoff(projectId: string, pmSessionId: string, handoffId: string,
    decision: { action: 'accept' | 'reject'; reason?: string }): Promise<ProjectHandoffResult> {
    const begun = this.repo.atomic((): { decided?: ProjectHandoffResult; accept?: { handoffId: string; originId: string };
      work?: Promise<void> } => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.pmSessionId !== pmSessionId) throw new UserError('notProjectPm')
      if (project.status === 'archived') throw new UserError('projectArchived')
      if (project.status === 'paused') throw new UserError('projectPaused')
      if (project.status !== 'active') throw new UserError('projectEnded')
      let source: Ticket | undefined, handoff: Handoff | undefined
      for (const ticket of this.repo.tickets.list()) {
        const found = ticket.handoffs?.find(item => item.id === handoffId)
        if (found) { source = ticket; handoff = found; break }
      }
      if (!source || !handoff) throw new UserError('unknownHandoff')
      if (handoff.kind !== 'split' || handoff.to.projectId !== projectId) throw new UserError('notProjectTicket')
      // A decided request answers only its own action: accepting an accepted request is idempotent, rejecting it is a
      // contradiction, and so is accepting a rejected or failed one.
      if (handoff.status === 'accepted') {
        if (decision.action !== 'accept') throw new UserError('handoffHandled')
        const ticket = handoff.to.ticketId ? this.repo.tickets.get(handoff.to.ticketId) : undefined
        return { decided: { handoff, ...ticket ? { ticket } : {} } }
      }
      if (handoff.status === 'rejected') {
        if (decision.action !== 'reject') throw new UserError('handoffHandled')
        return { decided: { handoff } }
      }
      if (handoff.status !== 'pending') throw new UserError('handoffHandled')
      const at = this.options.now?.() ?? new Date().toISOString()
      if (decision.action === 'reject') {
        const rejected: Handoff = { ...handoff, status: 'rejected', decidedAt: at,
          ...(decision.reason?.trim() ? { decisionReason: decision.reason.trim().slice(0, 1000) } : {}) }
        this.replaceHandoff(source, rejected)
        return { decided: { handoff: rejected } }
      }
      const origin = this.repo.tickets.get(handoff.from.ticketId!)
      if (!origin || !liveTicket(origin)) throw new UserError('ticketEnded')
      // The target PM may end the source Ticket, so the source must still be active and the requested Assignment current.
      // This prevents a target from finalizing a handoff after the source Project was paused/archived, its Worker was
      // manually stopped, or the source Ticket moved on to another Assignment/Session.
      const sourceProject = this.repo.projects.get(handoff.from.projectId)
      if (!sourceProject) throw new UserError('unknownProject')
      if (sourceProject.status === 'archived') throw new UserError('projectArchived')
      if (sourceProject.status === 'paused') throw new UserError('projectPaused')
      if (sourceProject.status !== 'active') throw new UserError('projectEnded')
      if (origin.projectId !== handoff.from.projectId) throw new UserError('notProjectTicket')
      if (origin.manualStop) throw new UserError(origin.manualStop.scope === 'worker'
        ? 'manualStopNeedsUserApproval' : 'manualStopProjectPaused')
      const current = latestAssignment(origin)
      const currentSession = current ? assignmentSessionId(origin.id, current) : undefined
      // A record made before P3-B has no assignmentId: there is no safe way to prove it still names the Assignment that
      // requested it, so it is refused explicitly and the source PM must request again.
      if (!handoff.from.assignmentId) throw new UserError('notHandoffable')
      const expectedSession = handoff.from.sessionId ?? currentSession
      if (!current || current.state === 'ended' || current.id !== handoff.from.assignmentId
        || currentSession !== expectedSession) {
        throw new UserError('notHandoffable')
      }
      const request = handoff.request
      if (!request) throw new UserError('invalidHandoff', { reason: 'the request names no Ticket task' })
      // Refuse a taken worktree before stopping the source Worker; the target Ticket is created only after the cleanup.
      this.assertWorktreeFree(projectId, request.title, request.worktree_name)
      // Claim the request for this accept while the source Worker stops: a concurrent decision must be refused, and a host
      // restart leaves a `starting` record for startup recovery rather than a `pending` request nobody can decide safely.
      this.replaceHandoff(origin, { ...handoff, status: 'starting' })
      const { work } = this.tickets.beginHandoffAway(origin.id, `Handed off to Project ${projectId}`)
      return { accept: { handoffId: handoff.id, originId: origin.id }, ...work ? { work } : {} }
    })
    if (begun.decided) return begun.decided
    const accept = begun.accept!
    if (begun.work) {
      try {
        await begun.work
      } catch (error) {
        const message = errorText(error)
        this.repo.atomic(() => this.tickets.failHandoffAway(accept.originId, accept.handoffId, message))
        throw new UserError('handoffCleanupFailed', { error: message.slice(0, 300) })
      }
    }
    try {
      return this.repo.atomic(() => this.acceptProjectHandoff(projectId, pmSessionId, accept.handoffId, accept.originId))
    } catch (error) {
      this.repo.atomic(() => this.tickets.failHandoffAway(accept.originId, accept.handoffId, errorText(error)))
      throw error
    }
  }
  /**
   * Finish a cross-Project accept after its source Worker's cleanup: recheck both Projects, the source Ticket, its now
   * stopped Assignment and the still-pending Handoff, create the target Ticket, and only then end the source Ticket
   * `handedOff`. It runs in one transaction with the accepted Handoff on both Tickets.
   */
  private acceptProjectHandoff(projectId: string, pmSessionId: string, handoffId: string, originId: string): ProjectHandoffResult {
    const project = this.repo.projects.get(projectId)
    if (!project) throw new UserError('unknownProject')
    if (project.pmSessionId !== pmSessionId) throw new UserError('notProjectPm')
    if (project.status === 'archived') throw new UserError('projectArchived')
    if (project.status === 'paused') throw new UserError('projectPaused')
    if (project.status !== 'active') throw new UserError('projectEnded')
    const origin = this.repo.tickets.get(originId)
    if (!origin || !liveTicket(origin)) throw new UserError('ticketEnded')
    const sourceProject = this.repo.projects.get(origin.projectId ?? '')
    if (!sourceProject) throw new UserError('unknownProject')
    if (sourceProject.status === 'archived') throw new UserError('projectArchived')
    if (sourceProject.status === 'paused') throw new UserError('projectPaused')
    if (sourceProject.status !== 'active') throw new UserError('projectEnded')
    if (origin.manualStop) throw new UserError(origin.manualStop.scope === 'worker'
      ? 'manualStopNeedsUserApproval' : 'manualStopProjectPaused')
    const handoff = origin.handoffs?.find(item => item.id === handoffId)
    if (!handoff || handoff.to.projectId !== projectId) throw new UserError('notProjectTicket')
    if (handoff.status !== 'starting') throw new UserError('handoffHandled')
    if (!handoff.from.assignmentId) throw new UserError('notHandoffable')
    const current = latestAssignment(origin)
    const currentSession = current ? assignmentSessionId(origin.id, current) : undefined
    const expectedSession = handoff.from.sessionId ?? currentSession
    // The source Assignment was stopped before this transaction; a different state or id means a stop, retry or another
    // handoff changed the Ticket during the cleanup, and this accept must not start target work over that change.
    if (!current || current.id !== handoff.from.assignmentId || current.state !== 'ended'
      || current.endedReason !== 'handedOff' || currentSession !== expectedSession) {
      throw new UserError('notHandoffable')
    }
    const request = handoff.request
    if (!request) throw new UserError('invalidHandoff', { reason: 'the request names no Ticket task' })
    const at = this.options.now?.() ?? new Date().toISOString()
    const [created] = this.createProjectTickets(projectId, pmSessionId, [{ title: request.title, goal: request.goal,
      scope: request.scope, worktree_name: request.worktree_name,
      note: `Handoff from Project ${handoff.from.projectId}, Ticket ${handoff.from.ticketId}. Read the handoff summary and `
        + "unfinished work in this Ticket's handoff briefing." }])
    const target = this.repo.tickets.get(created!.id)!
    const targetAssignment = target.assignments.at(-1)
    const sessionId = targetAssignment ? assignmentSessionId(target.id, targetAssignment) : workerSessionId(target.id)
    const accepted: Handoff = { ...handoff, status: 'accepted', decidedAt: at,
      to: { ticketId: target.id, projectId, ...targetAssignment ? { assignmentId: targetAssignment.id } : {}, sessionId },
      approvedBy: { kind: 'pm', sessionId: pmSessionId } }
    this.replaceHandoff(origin, accepted)
    target.handoffs = [...target.handoffs ?? [], accepted]
    target.updatedAt = at
    this.repo.tickets.save(target)
    this.tickets.briefHandoff(target, accepted, false)
    // A source Ticket hands its work to one place only: its other pending requests are no longer actionable.
    const siblings = this.repo.tickets.get(origin.id)!
    siblings.handoffs = (siblings.handoffs ?? []).map(item => item.id !== accepted.id && item.status === 'pending' && item.kind === 'split'
      ? { ...item, status: 'rejected' as const, decidedAt: at, decisionReason: `Handed off to Project ${projectId}` }
      : item)
    siblings.updatedAt = at
    this.repo.tickets.save(siblings)
    this.tickets.completeHandoffAway(origin.id, `Handed off to Project ${projectId}`)
    this.options.emit?.({ type: 'ticket.handedOff', at, data: { ticketId: origin.id, handoffId: accepted.id, kind: 'split',
      toTicketId: target.id, toSessionId: sessionId } })
    return { handoff: accepted, ticket: this.repo.tickets.get(target.id)! }
  }
  /** Save a decided Handoff on its source Ticket, replacing the pending record in place. */
  private replaceHandoff(source: Ticket, handoff: Handoff): void {
    source.handoffs = (source.handoffs ?? []).map(item => item.id === handoff.id ? handoff : item)
    source.updatedAt = this.options.now?.() ?? new Date().toISOString()
    this.repo.tickets.save(source)
  }
  /**
   * End a Project and cascade-stop every still-open Ticket it owns, using the ordinary Ticket stop semantics so history,
   * Sessions and directories stay. It is idempotent: an ended or archived Project returns unchanged.
   * @throws UserError when the Project is unknown.
   */
  stopProject(projectId: string, reason?: string): ProjectProfile {
    return this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.status === 'ended' || project.status === 'archived') return project
      const updated: ProjectProfile = { ...project, status: 'ended', updatedAt: this.options.now?.() ?? new Date().toISOString() }
      this.repo.projects.save(updated)
      this.options.emit?.({ type: 'project.ended', at: updated.updatedAt, data: { projectId, ...(reason !== undefined ? { reason } : {}) } })
      // The Project is ended first, so child lifecycle notices and relays fall back instead of pretending it is active.
      for (const ticket of this.repo.tickets.open()) if (ticket.projectId === projectId) this.tickets.stop(ticket.id, reason)
      return updated
    })
  }
  /**
   * Archive a Project: save its active/paused status in `archivedFrom`, mark every child Ticket archived, and end any
   * Assignment that still ran with `projectArchived`. Session archiving happens after this transaction, in the application
   * service. Idempotent; an ended Project cannot be archived.
   * @throws UserError when the Project is unknown or ended.
   */
  archiveProject(projectId: string): ProjectProfile {
    return this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.status === 'archived') return project
      if (project.status === 'ended') throw new UserError('projectEnded')
      const at = this.options.now?.() ?? new Date().toISOString()
      const archived: ProjectProfile = { ...project, status: 'archived', archivedFrom: project.status, updatedAt: at }
      this.repo.projects.save(archived)
      this.options.emit?.({ type: 'project.archived', at, data: { projectId, from: project.status as 'active' | 'paused' } })
      for (const ticket of this.repo.tickets.list()) {
        if (ticket.projectId !== projectId) continue
        for (const assignment of ticket.assignments) {
          if (assignment.state === 'ended') continue
          assignment.state = 'ended'; assignment.endedAt = at; assignment.endedReason = 'projectArchived'
          this.options.executor.stop(ticket, assignment, 'projectArchived')
        }
        ticket.archived = { at, by: 'project', projectId }
        ticket.updatedAt = at
        this.repo.tickets.save(ticket)
      }
      return archived
    })
  }
  /**
   * Unarchive a Project: restore its `archivedFrom` status and clear the project's archive marker from its child Tickets.
   * No Assignment is restarted; a still-open Ticket waits for a person or the PM to retry. Idempotent.
   * @throws UserError when the Project is unknown.
   */
  unarchiveProject(projectId: string): ProjectProfile {
    return this.repo.atomic(() => {
      const project = this.repo.projects.get(projectId)
      if (!project) throw new UserError('unknownProject')
      if (project.status !== 'archived') return project
      const at = this.options.now?.() ?? new Date().toISOString()
      const restored: ProjectProfile = { ...project, status: project.archivedFrom ?? 'active', updatedAt: at }
      delete restored.archivedFrom
      this.repo.projects.save(restored)
      this.options.emit?.({ type: 'project.unarchived', at, data: { projectId, status: restored.status as 'active' | 'paused' } })
      for (const ticket of this.repo.tickets.list()) {
        if (ticket.projectId !== projectId || ticket.archived?.projectId !== projectId) continue
        delete ticket.archived
        ticket.updatedAt = at
        this.repo.tickets.save(ticket)
      }
      return restored
    })
  }

  /**
   * Recover Handoffs a host restart interrupted after their first transaction: their source Worker was already stopped, but
   * the replacement Worker or target Ticket was never committed. Each `starting` Handoff becomes `failed` and its still
   * open Ticket keeps a delivery error for a person to retry; a transfer's reserved but never launched Assignment ends
   * `handoffCleanupFailed`. It starts nothing and is idempotent, so Runtime calls it once before resuming work.
   * @returns how many in-flight Handoffs it recovered.
   */
  recoverInterruptedHandoffs(): number { return this.tickets.recoverStartingHandoffs() }
  /**
   * A child Worker Session was archived outside the Project's own commands: end its current Assignment with
   * `sessionArchived`, leave the Ticket open, and add one pending note for the PM's next prompt. It does not start or wake
   * anything. A Ticket already archived with its Project is left alone, so a Project archive produces no duplicate note.
   */
  workerSessionArchived(ticketId: string, sessionId: string, at = new Date().toISOString()): void {
    this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || ticket.archived) return
      const assignment = latestAssignment(ticket)
      // An older Worker Session a handoff left keeps only history: archiving it must not end the current Assignment.
      if (!assignment || assignmentSessionId(ticket.id, assignment) !== sessionId) return
      if (assignment.state !== 'ended') {
        assignment.state = 'ended'; assignment.endedAt = at; assignment.endedReason = 'sessionArchived'
        ticket.updatedAt = at
        this.repo.tickets.save(ticket)
        this.options.executor.stop(ticket, assignment, 'sessionArchived')
      }
      if (!liveTicket(ticket)) return
      const project = ticket.projectId ? this.repo.projects.get(ticket.projectId) : undefined
      if (!project || project.status === 'archived') return
      const id = key('project-note', project.id, 'workerArchived', ticket.id, sessionId)
      if (project.pendingNotes?.some(note => note.id === id)) return
      const note: ProjectNote = { id, at, kind: 'workerArchived', ticketId: ticket.id, sessionId,
        text: `Worker Session archived; "${ticket.title}" stays open with no automatic retry.` }
      this.repo.projects.save({ ...project, pendingNotes: [...project.pendingNotes ?? [], note], updatedAt: at })
    })
  }
  /**
   * A child Worker Session was unarchived outside the Project's own commands: leave the Ticket and Assignment as they are
   * and add an optional pending note for the PM. It never restarts the Assignment, and an older Session a handoff left adds
   * no note.
   */
  workerSessionUnarchived(ticketId: string, sessionId: string, at = new Date().toISOString()): void {
    this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || ticket.archived || !liveTicket(ticket)) return
      const assignment = latestAssignment(ticket)
      if (!assignment || assignmentSessionId(ticket.id, assignment) !== sessionId) return
      const project = ticket.projectId ? this.repo.projects.get(ticket.projectId) : undefined
      if (!project || project.status === 'archived') return
      const id = key('project-note', project.id, 'workerRestored', ticket.id, sessionId)
      if (project.pendingNotes?.some(note => note.id === id)) return
      const note: ProjectNote = { id, at, kind: 'workerRestored', ticketId: ticket.id, sessionId,
        text: `Worker Session restored; "${ticket.title}" was not retried automatically.` }
      this.repo.projects.save({ ...project, pendingNotes: [...project.pendingNotes ?? [], note], updatedAt: at })
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
   * A Project PM's coordination message to one of its child Tickets. It is stored as a note Input first, so it stays in the
   * Ticket's history and grants nothing. A running Assignment gets it delivered, a pending one is started, and with
   * `wake` a retryable Ticket gets a new Assignment; otherwise the note waits. The note id is derived from the Ticket and
   * text, so the same request adds it once. `queueOnly` stores the note without delivering or starting, for a known archived
   * worker Session.
   * @throws UserError when the Ticket is unknown, ended, archived or outside a Project, or when its Project is paused,
   * archived or ended.
   */
  messageTicket(ticketId: string, text: string, wake = false, queueOnly = false): { delivered: TicketMessageDelivery; ticket: Ticket } {
    return this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket) throw new UserError('unknownTicket')
      const project = ticket.projectId ? this.repo.projects.get(ticket.projectId) : undefined
      if (!ticket.projectId || !project) throw new UserError('notProjectTicket')
      if (project.status === 'paused') throw new UserError('projectPaused')
      if (project.status === 'archived') throw new UserError('projectArchived')
      if (project.status !== 'active') throw new UserError('projectEnded')
      if (ticket.archived) throw new UserError('ticketArchived')
      if (!liveTicket(ticket)) throw new UserError('ticketEnded')
      const running = !!runningAssignment(ticket)
      const pending = latestAssignment(ticket)?.state === 'pending' && !waitsForPerson(ticket)
      const canStart = canRetry(ticket)
      const id = key('input', ticketId, 'note', 'pm', text)
      if (queueOnly) {
        this.tickets.queueNoteWithId(ticketId, text, id)
        return { delivered: 'not_started', ticket: this.repo.tickets.get(ticketId)! }
      }
      this.tickets.noteWithId(ticketId, text, id, true)
      let delivered: TicketMessageDelivery
      if (running) delivered = 'running'
      else if (pending) delivered = 'started'
      else if (wake && canStart) { this.tickets.retry(ticketId); delivered = 'started' }
      else delivered = wake ? 'not_started' : 'queued'
      return { delivered, ticket: this.repo.tickets.get(ticketId)! }
    })
  }
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
export type EngineForPM = Pick<Engine, 'projectReport' | 'createProjectTickets' | 'messageTicket' | 'reviveProjectTicket'
  | 'transferTicket' | 'splitTicket' | 'requestProjectHandoff' | 'decideProjectHandoff'>
/** What people ask of the Engine, through the panel or the main Session. */
export type EngineForPeople = Pick<Engine, 'stopTicket' | 'stopAssignment' | 'retryTicket' | 'reevaluate' | 'unsubscribe' | 'dismiss'
  | 'pauseProject' | 'pauseProjectReport' | 'allowResume' | 'stopProject' | 'archiveProject' | 'unarchiveProject'>
/** What Settings tells the Engine. */
export type EngineForSettings = Pick<Engine, 'policyChanged'>
/** What the Executor tells the Engine, and what its workers ask of it. */
export type EngineForExecutor = Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'turnBegan' | 'deliveryFailed'
  | 'assignmentInterrupted' | 'report' | 'markUnrelated' | 'handback' | 'followForContext' | 'reply' | 'stopAssignment'>
