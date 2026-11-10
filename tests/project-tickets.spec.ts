/** P2.2a/P2.2b: PM-created Project Tickets, delegated Decisions, external Threads, and their optional worker tool allowlist. */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, waitsForPerson, type Assessor, type Candidate, type DomainEvent, type Executor,
  type Mandate, type Policy, type ProjectProfile, type ProjectTicketTask, type Ticket, type Trigger } from '../src/core/index.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const actor = { source: 'main-session', id: 'dsh-user' }
function trigger(id = 'p1', overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'main-session', threads: [{ source: 'main-session', id }], actor, human: true, addressed: 'direct',
    at: '2026-11-10T00:00:00.000Z', text: `Create a project ${id}`, meta: {}, ...overrides }
}
function harness() {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const events: DomainEvent[] = []
  const launches: [Ticket, string][] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const executor: Executor = { start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment.id]) }), deliver: vi.fn(), stop: vi.fn() }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: (t: Trigger) => t.source === 'main-session' && t.actor.id === actor.id
      ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible: false, reason: 'not_human' },
    revalidate: () => true, admitsInferred: () => false }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor, outbox,
    prepareTicket: (ticket, outcome) => ({ ...ticket, execution: { name: `${outcome.name}-${ticket.id.slice(0, 12)}`,
      directory: `/work/${outcome.name}-${ticket.id.slice(0, 12)}`, assignment: outcome.scope } }),
    emit: event => { events.push(event) }, now: () => '2026-11-10T00:00:00.000Z' })
  engine.recordTriggerForRouting(trigger())
  const project = engine.createProject('p1', 'Website', 'Ship the new site')
  requests.length = 0
  launches.length = 0
  return { repo, engine, requests, events, launches, executor, project }
}
const tasks = [
  { title: 'Header', goal: 'Make the header legible', scope: 'the header', note: 'Keep the logo.',
    threads: [{ key: 'github:1' }, { key: 'github:2', contextOnly: true }] },
  { title: 'Footer links', goal: 'Fix the footer links' },
]
function mandateFor(project: ProjectProfile): Mandate {
  return { strength: project.mandate.strength, policyVersion: project.mandate.policyVersion, basis: { via: 'delegated', projectId: project.id,
    pmSessionId: project.pmSessionId }, actor: { source: 'internal', id: project.pmSessionId }, scope: project.goal }
}

describe('PM-created Project Tickets', () => {
  it('creates two delegated Tickets with real record-only Evals, internal Triggers and no assessor', () => {
    const h = harness()
    const tickets = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)
    expect(tickets).toHaveLength(2)
    expect(h.requests).toEqual([])
    expect(h.repo.tickets.list()).toHaveLength(2)
    for (const [index, ticket] of tickets.entries()) {
      expect(ticket).toMatchObject({ projectId: h.project.id, channels: [], title: tasks[index]!.title,
        origin: { triggerIds: [ticket.origin.triggerId] },
        mandate: { strength: 'explicit', basis: { via: 'delegated', projectId: h.project.id, pmSessionId: h.project.pmSessionId },
          scope: tasks[index]!.scope ?? tasks[index]!.goal } })
      expect(ticket.execution?.directory).toContain(ticket.id.slice(0, 12))
      const decision = h.repo.decisions.get(ticket.decisionId)!
      expect(decision).toMatchObject({ kind: 'delegated', projectId: h.project.id, ticketId: ticket.id, strength: 'explicit',
        triggerIds: [ticket.origin.triggerId], mandate: { basis: { via: 'delegated', projectId: h.project.id } } })
      // A real Eval id from a record-only Eval, distinct from a fabricated or Decision id.
      expect(decision.evalId).toMatch(/^[0-9a-f]{32}$/)
      expect(decision.evalId).not.toBe(decision.id)
      const internal = h.repo.triggers.get(ticket.origin.triggerId)!
      expect(internal).toMatchObject({ source: 'internal', human: false, actor: { source: 'internal', id: h.project.pmSessionId },
        threads: [{ source: 'internal', id: ticket.origin.triggerId }] })
      expect(internal.addressed).toBeUndefined()
      // Each Ticket has one queued Assignment and the Project's own source Thread subscribed none of them.
      expect(ticket.assignments).toHaveLength(1)
      expect(ticket.assignments[0]!.state).toBe('pending')
      expect(h.repo.threads.get('main-session:p1')?.subscriptions ?? []).toEqual([])
    }
    expect(h.launches.map(([ticket]) => ticket.id)).toEqual(tickets.map(ticket => ticket.id))
    expect(h.events.filter(event => event.type === 'ticket.created')).toHaveLength(2)
  })

  it('subscribes only the external Threads a task names, with contextOnly recorded on the Thread', () => {
    const h = harness()
    const [header, footer] = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)
    expect(h.repo.threads.get('github:1')).toMatchObject({ subscriptions: [header!.id] })
    expect(h.repo.threads.get('github:1')?.context).toBeUndefined()
    expect(h.repo.threads.get('github:2')).toMatchObject({ subscriptions: [header!.id], context: [header!.id] })
    expect(h.repo.threads.get('github:2')?.subscriptions).not.toContain(footer!.id)
    expect(h.repo.threads.get('github:3')).toBeUndefined()
    expect(header!.follows).toBeUndefined()
    expect(footer!.follows).toBeUndefined()
  })

  it('is idempotent per batch and records no second Trigger, Eval or Decision', () => {
    const h = harness()
    const first = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)
    const second = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)
    expect(second.map(ticket => ticket.id)).toEqual(first.map(ticket => ticket.id))
    expect(h.repo.tickets.list()).toHaveLength(2)
    expect(h.repo.decisions.byThread(`internal:${first[0]!.origin.triggerId}`)).toHaveLength(1)
    expect(h.repo.triggers.get(first[1]!.origin.triggerId)).toBeDefined()
    expect(h.launches).toHaveLength(2)
  })

  // P2-A02: idempotency follows the whole batch's content, not only the Project and a task's position.
  it('creates a new Ticket batch when the same positions carry different tasks, and replays each batch to its own Tickets', () => {
    const h = harness()
    const alpha = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId,
      [{ title: 'Alpha', goal: 'Do alpha', worktree_name: 'alpha' }])
    const beta = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId,
      [{ title: 'Beta', goal: 'Do beta', worktree_name: 'beta' }])
    expect(beta[0]!.id).not.toBe(alpha[0]!.id)
    expect(beta[0]).toMatchObject({ id: beta[0]!.id, title: 'Beta' })
    expect(h.repo.tickets.list()).toHaveLength(2)
    expect(h.repo.decisions.byThread(`internal:${alpha[0]!.origin.triggerId}`).map(decision => decision.kind))
      .toEqual(['delegated'])
    // Each batch replays to the Ticket it created; a changed goal at the same position is a new batch again.
    expect(h.engine.createProjectTickets(h.project.id, h.project.pmSessionId,
      [{ title: 'Alpha', goal: 'Do alpha', worktree_name: 'alpha' }])[0]!.id).toBe(alpha[0]!.id)
    expect(h.engine.createProjectTickets(h.project.id, h.project.pmSessionId,
      [{ title: 'Beta', goal: 'Do beta', worktree_name: 'beta' }])[0]!.id).toBe(beta[0]!.id)
    expect(h.repo.tickets.list()).toHaveLength(2)
    const changed = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId,
      [{ title: 'Alpha', goal: 'Do alpha differently', worktree_name: 'alpha-2' }])
    expect(changed[0]!.id).not.toBe(alpha[0]!.id)
    expect(h.repo.tickets.list()).toHaveLength(3)
    // A worktree name stays unique across batches within the Project.
    expect(() => h.engine.createProjectTickets(h.project.id, h.project.pmSessionId,
      [{ title: 'Gamma', goal: 'Do gamma', worktree_name: 'alpha' }])).toThrow(new UserError('duplicateWorktree', { name: 'alpha' }))
    expect(h.repo.tickets.list()).toHaveLength(3)
  })

  it('creates nothing when one task is invalid, including an unknown Thread key or a duplicate worktree name', () => {
    const badThread = harness()
    expect(() => badThread.engine.createProjectTickets(badThread.project.id, badThread.project.pmSessionId,
      [tasks[0]!, { title: 'Bad', goal: 'Bad', threads: [{ key: 'not-a-thread-key' }] }]))
      .toThrow(new UserError('invalidThread', { thread: 'not-a-thread-key' }))
    expect(badThread.repo.tickets.list()).toEqual([])
    expect(badThread.repo.threads.list().filter(thread => thread.key.startsWith('internal:'))).toEqual([])
    const badTask = harness()
    expect(() => badTask.engine.createProjectTickets(badTask.project.id, badTask.project.pmSessionId,
      [tasks[0]!, { title: '', goal: 'x' }])).toThrow('title is required')
    expect(badTask.repo.tickets.list()).toEqual([])
    const duplicate = harness()
    expect(() => duplicate.engine.createProjectTickets(duplicate.project.id, duplicate.project.pmSessionId,
      [{ title: 'A', goal: 'A', worktree_name: 'same-name' }, { title: 'B', goal: 'B', worktree_name: 'same-name' }]))
      .toThrow(new UserError('duplicateWorktree', { name: 'same-name' }))
    expect(duplicate.repo.tickets.list()).toEqual([])
  })

  it('refuses a caller that is not the Project PM, an unknown Project and an ended Project, creating nothing', () => {
    const h = harness()
    expect(() => h.engine.createProjectTickets(h.project.id, 'pm-other', tasks)).toThrow(new UserError('notProjectPm'))
    expect(() => h.engine.createProjectTickets('missing', h.project.pmSessionId, tasks)).toThrow(new UserError('unknownProject'))
    h.repo.projects.save({ ...h.project, status: 'ended' as ProjectProfile['status'] })
    expect(() => h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)).toThrow(new UserError('projectEnded'))
    expect(h.repo.tickets.list()).toEqual([])
  })

  it('writes the final worker tool allowlist on the Ticket Mandate, and leaves it absent for the full tool set', () => {
    const h = harness()
    const [narrow, full] = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, [
      { title: 'Header', goal: 'Make the header legible', allow_tools: ['read', 'grep'] },
      { title: 'Footer', goal: 'Fix the footer links' },
    ])
    expect(narrow!.mandate.allowTools).toEqual(['read', 'grep'])
    expect(h.repo.decisions.get(narrow!.decisionId)?.mandate?.allowTools).toEqual(['read', 'grep'])
    expect(full!.mandate).not.toHaveProperty('allowTools')
  })

  it('rejects unknown, duplicate, oversized and widening allowlists, creating nothing', () => {
    const h = harness()
    const call = (allow_tools: unknown) => h.engine.createProjectTickets(h.project.id, h.project.pmSessionId,
      [{ title: 'A', goal: 'A', allow_tools: allow_tools as string[] }])
    expect(() => call(['read', 'nope'])).toThrow(/unknown work tool "nope"/)
    expect(() => call(['read', 'read'])).toThrow(/duplicate work tool "read"/)
    expect(() => call(Array.from({ length: 33 }, () => 'read'))).toThrow(/more than 32 tools/)
    expect(h.repo.tickets.list()).toEqual([])

    const inherited = harness()
    inherited.repo.projects.save({ ...inherited.project, mandate: { ...inherited.project.mandate, allowTools: ['read', 'grep'] } })
    expect(() => inherited.engine.createProjectTickets(inherited.project.id, inherited.project.pmSessionId,
      [{ title: 'A', goal: 'A', allow_tools: ['read', 'bash'] }])).toThrow(/cannot widen the PM Mandate: bash/)
    expect(inherited.repo.tickets.list()).toEqual([])
    const [subset, inheritedList] = inherited.engine.createProjectTickets(inherited.project.id, inherited.project.pmSessionId,
      [{ title: 'A', goal: 'A', allow_tools: ['read'] }, { title: 'B', goal: 'B' }])
    expect(subset!.mandate.allowTools).toEqual(['read'])
    expect(inheritedList!.mandate.allowTools).toEqual(['read', 'grep'])
  })

  it('requires the Project PM Session, so a caller that omits it cannot create Tickets', () => {
    const h = harness()
    const withoutCaller = h.engine.createProjectTickets.bind(h.engine) as unknown as
      (projectId: string, tasks: readonly ProjectTicketTask[]) => Ticket[]
    expect(() => withoutCaller(h.project.id, tasks)).toThrow(new UserError('notProjectPm'))
    expect(h.repo.tickets.list()).toEqual([])
  })

  it('pauses and resumes a Project idempotently, refusing new Tickets only while paused', () => {
    const h = harness()
    const paused = h.engine.pauseProject(h.project.id, true)
    expect(paused).toMatchObject({ status: 'paused', pauseMode: 'soft' })
    expect(h.engine.pauseProject(h.project.id, true)).toEqual(paused)
    expect(() => h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)).toThrow(new UserError('projectPaused'))
    expect(h.repo.tickets.list()).toEqual([])
    const resumed = h.engine.pauseProject(h.project.id, false)
    expect(resumed.status).toBe('active')
    expect(resumed.pauseMode).toBeUndefined()
    expect(h.engine.pauseProject(h.project.id, false)).toEqual(resumed)
    expect(h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)).toHaveLength(2)
    expect(() => h.engine.pauseProject('missing', true)).toThrow(new UserError('unknownProject'))
  })

  it('soft pause lets running work finish; hard pause ends Assignments, and resume adds the hard-resume note', () => {
    const h = harness()
    const [first, second] = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)
    h.engine.assignmentStarted(first!.id, first!.assignments[0]!.id)
    const soft = h.engine.pauseProject(h.project.id, true)
    expect(soft).toMatchObject({ status: 'paused', pauseMode: 'soft' })
    expect(h.executor.stop).not.toHaveBeenCalled()
    expect(h.repo.tickets.get(first!.id)?.assignments[0]?.state).toBe('running')
    expect(() => h.engine.retryTicket(first!.id)).toThrow(new UserError('projectPaused'))
    expect(() => h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, [{ title: 'Blocked', goal: 'Blocked' }]))
      .toThrow(new UserError('projectPaused'))
    // A soft pause can be upgraded to hard, which stops both the running and the pending Assignment now.
    const hard = h.engine.pauseProject(h.project.id, true, 'hard')
    expect(hard).toMatchObject({ status: 'paused', pauseMode: 'hard' })
    for (const ticket of [first!, second!]) {
      const stored = h.repo.tickets.get(ticket.id)!
      expect(stored.archived).toBeUndefined()
      expect(stored.ended).toBeUndefined()
      expect(stored.assignments.every(assignment => assignment.state === 'ended' && assignment.endedReason === 'stoppedByOperator')).toBe(true)
      expect(stored.manualStop).toMatchObject({ scope: 'project' })
    }
    expect(h.executor.stop).toHaveBeenCalledWith(expect.objectContaining({ id: first!.id }),
      expect.objectContaining({ id: first!.assignments[0]!.id }), 'stoppedByOperator')
    expect(() => h.engine.retryTicket(first!.id)).toThrow(new UserError('projectPaused'))
    const resumed = h.engine.pauseProject(h.project.id, false)
    expect(resumed).toMatchObject({ status: 'active' })
    expect(resumed.pauseMode).toBeUndefined()
    expect(resumed.pendingNotes).toEqual([expect.objectContaining({ kind: 'resumedFromHard', sessionId: h.project.pmSessionId })])
    // Resume does not restart the old Assignment, but a person may retry it explicitly.
    expect(h.repo.tickets.get(first!.id)?.assignments).toHaveLength(1)
    expect(h.engine.retryTicket(first!.id).assignments.map(assignment => assignment.state)).toEqual(['ended', 'pending'])
    expect(() => h.engine.pauseProject(h.project.id, true, 'bogus' as 'soft')).toThrow(new UserError('projectPauseMode'))
  })

  it('ends a Project and cascades its stop to open Project Tickets only, idempotently', () => {
    const h = harness()
    const [first, second] = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)
    h.engine.recordTriggerForRouting(trigger('p2'))
    const normal = h.engine.decide('p2', { kind: 'accept', title: 'Normal work', scope: 'normal', reason: 'requested',
      acknowledgement: 'ok', name: 'normal-work' })
    const stopped = h.engine.stopProject(h.project.id, 'projectStoppedByPerson')
    expect(stopped.status).toBe('ended')
    for (const ticket of [first!, second!]) {
      expect(h.repo.tickets.get(ticket.id)).toMatchObject({ ended: { by: 'human', outcome: 'stopped', reason: 'projectStoppedByPerson' } })
    }
    expect(h.repo.tickets.get(normal.ticketId!)).not.toHaveProperty('ended')
    const again = h.engine.stopProject(h.project.id)
    expect(again.status).toBe('ended')
    expect(h.repo.tickets.list().filter(ticket => ticket.projectId === h.project.id)).toHaveLength(2)
    expect(() => h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)).toThrow(new UserError('projectEnded'))
    expect(h.engine.pauseProject(h.project.id, true).status).toBe('ended')
    expect(h.engine.pauseProject(h.project.id, true, 'hard').status).toBe('ended')
  })

  it('stores a PM message as a note Input and delivers it to a running worker without a new Assignment', () => {
    const h = harness()
    const [first] = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, [tasks[0]!])
    h.engine.assignmentStarted(first!.id, first!.assignments[0]!.id)
    const result = h.engine.messageTicket(first!.id, 'Header coordination note')
    expect(result.delivered).toBe('running')
    const stored = h.repo.tickets.get(first!.id)!
    expect(stored.inputs).toContainEqual(expect.objectContaining({ kind: 'note', text: 'Header coordination note' }))
    expect(stored.assignments).toHaveLength(1)
    expect(stored.mandate).toEqual(first!.mandate)
    expect(h.executor.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: first!.id }),
      expect.objectContaining({ id: first!.assignments[0]!.id }))
    const inputs = stored.inputs.length
    h.engine.messageTicket(first!.id, 'Header coordination note')
    expect(h.repo.tickets.get(first!.id)!.inputs).toHaveLength(inputs)
  })

  it('delivers a PM message to a child that is waiting for a person', () => {
    const h = harness()
    const [first] = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, [tasks[0]!])
    h.engine.assignmentStarted(first!.id, first!.assignments[0]!.id)
    h.engine.report(first!.id, { state: 'blocked', summary: 'Need a decision', question: 'Which header?' })
    expect(waitsForPerson(h.repo.tickets.get(first!.id)!)).toBe(true)
    expect(h.engine.messageTicket(first!.id, 'Use the compact header.').delivered).toBe('running')
    const note = h.repo.tickets.get(first!.id)!.inputs.find(input => input.kind === 'note')!
    expect(h.repo.tickets.get(first!.id)!.undelivered).toContain(note.id)
    expect(h.executor.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: first!.id }),
      expect.objectContaining({ id: first!.assignments[0]!.id }))
  })

  it('starts a new Assignment only for wake=true and a retryable Ticket', () => {
    const h = harness()
    const [ticket] = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, [tasks[0]!])
    h.engine.pauseProject(h.project.id, true, 'hard')
    h.engine.pauseProject(h.project.id, false)
    const before = h.repo.tickets.get(ticket!.id)!.assignments.length
    expect(h.engine.messageTicket(ticket!.id, 'Queued note').delivered).toBe('queued')
    expect(h.repo.tickets.get(ticket!.id)!.assignments).toHaveLength(before)
    expect(h.engine.messageTicket(ticket!.id, 'Wake note', true).delivered).toBe('started')
    expect(h.repo.tickets.get(ticket!.id)!.assignments).toHaveLength(before + 1)
    // A note is still stored when no Assignment may start.
    const other = harness()
    const [notRetryable] = other.engine.createProjectTickets(other.project.id, other.project.pmSessionId, [tasks[0]!])
    const stored = other.repo.tickets.get(notRetryable!.id)!
    stored.assignments[0]!.state = 'ended'; stored.assignments[0]!.endedReason = 'failedLaunch'
    other.repo.tickets.save(stored)
    expect(other.engine.messageTicket(notRetryable!.id, 'No start', true).delivered).toBe('not_started')
    expect(other.repo.tickets.get(notRetryable!.id)!.inputs).toEqual([expect.objectContaining({ kind: 'note', text: 'No start' })])
  })

  it('rejects messages to paused, archived, ended, ended-Ticket and Router-owned Tickets', () => {
    const h = harness()
    const [ticket] = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, [tasks[0]!])
    h.engine.pauseProject(h.project.id, true)
    expect(() => h.engine.messageTicket(ticket!.id, 'Paused')).toThrow(new UserError('projectPaused'))
    h.engine.pauseProject(h.project.id, false)
    h.engine.stopTicket(ticket!.id)
    expect(() => h.engine.messageTicket(ticket!.id, 'Ended')).toThrow(new UserError('ticketEnded'))
    const archived = harness()
    const [archivedTicket] = archived.engine.createProjectTickets(archived.project.id, archived.project.pmSessionId, [tasks[0]!])
    archived.engine.archiveProject(archived.project.id)
    expect(() => archived.engine.messageTicket(archivedTicket!.id, 'Archived')).toThrow(new UserError('projectArchived'))
    const stopped = harness()
    const [stoppedTicket] = stopped.engine.createProjectTickets(stopped.project.id, stopped.project.pmSessionId, [tasks[0]!])
    stopped.engine.stopProject(stopped.project.id)
    expect(() => stopped.engine.messageTicket(stoppedTicket!.id, 'Ended project')).toThrow(new UserError('projectEnded'))
    stopped.engine.recordTriggerForRouting(trigger('p9'))
    const normal = stopped.engine.decide('p9', { kind: 'accept', title: 'Router work', scope: 'normal', reason: 'requested',
      acknowledgement: 'ok', name: 'router-work' })
    expect(() => stopped.engine.messageTicket(normal.ticketId!, 'Router ticket')).toThrow(new UserError('notProjectTicket'))
    expect(() => stopped.engine.messageTicket('missing', 'Unknown')).toThrow(new UserError('unknownTicket'))
  })

  it('archives a Project and its child Tickets, ends running Assignments, and leaves Router-owned Tickets alone', () => {
    const h = harness()
    const [first, second] = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)
    h.engine.assignmentStarted(first!.id, first!.assignments[0]!.id)
    h.engine.recordTriggerForRouting(trigger('p3'))
    const normal = h.engine.decide('p3', { kind: 'accept', title: 'Normal work', scope: 'normal', reason: 'requested',
      acknowledgement: 'ok', name: 'normal-work' })
    const archived = h.engine.archiveProject(h.project.id)
    expect(archived).toMatchObject({ status: 'archived', archivedFrom: 'active' })
    expect(h.engine.pauseProject(h.project.id, true, 'hard').status).toBe('archived')
    for (const ticket of [first!, second!]) {
      const stored = h.repo.tickets.get(ticket.id)!
      expect(stored.archived).toMatchObject({ by: 'project', projectId: h.project.id })
      expect(stored.ended).toBeUndefined()
      expect(stored.assignments.every(assignment => assignment.state === 'ended' && assignment.endedReason === 'projectArchived')).toBe(true)
    }
    // Archiving must stop the workers, not only mark their Assignments ended.
    expect(h.executor.stop).toHaveBeenCalledWith(expect.objectContaining({ id: first!.id }),
      expect.objectContaining({ id: first!.assignments[0]!.id }), 'projectArchived')
    expect(h.executor.stop).toHaveBeenCalledWith(expect.objectContaining({ id: second!.id }),
      expect.objectContaining({ id: second!.assignments[0]!.id }), 'projectArchived')
    expect(h.repo.tickets.open().map(ticket => ticket.id)).toEqual([normal.ticketId])
    expect(h.repo.tickets.get(normal.ticketId!)!.archived).toBeUndefined()
    expect(() => h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)).toThrow(new UserError('projectArchived'))
    expect(h.engine.archiveProject(h.project.id)).toEqual(archived)
    const restored = h.engine.unarchiveProject(h.project.id)
    expect(restored.status).toBe('active')
    expect(restored.archivedFrom).toBeUndefined()
    for (const ticket of [first!, second!]) {
      const stored = h.repo.tickets.get(ticket.id)!
      expect(stored.archived).toBeUndefined()
      expect(stored.ended).toBeUndefined()
      expect(stored.assignments).toHaveLength(1)
      expect(stored.assignments[0]!.state).toBe('ended')
    }
    // Unarchive does not start work, but a person may retry the ended Assignment explicitly.
    expect(h.engine.retryTicket(first!.id).assignments.map(assignment => assignment.state)).toEqual(['ended', 'pending'])
    expect(h.engine.unarchiveProject(h.project.id).status).toBe('active')
  })

  it('restores a paused Project after unarchive, and refuses to archive an ended one', () => {
    const h = harness()
    const paused = h.engine.pauseProject(h.project.id, true)
    const archived = h.engine.archiveProject(h.project.id)
    expect(archived).toMatchObject({ status: 'archived', archivedFrom: 'paused' })
    expect(h.engine.unarchiveProject(h.project.id).status).toBe('paused')
    expect(h.engine.pauseProject(h.project.id, false).status).toBe('active')
    h.engine.stopProject(h.project.id)
    expect(() => h.engine.archiveProject(h.project.id)).toThrow(new UserError('projectEnded'))
    expect(paused.status).toBe('paused')
  })

  it('revalidates a delegated Mandate without an external allowed list', () => {
    const h = harness()
    const settings = SettingsSchema.parse({})
    const policy = settingsPolicy(settings, { scope: () => ({ listened: false, reason: 'off' }) })
    expect(policy.revalidate(mandateFor(h.project))).toBe(true)
  })
})

describe('a Project PM Session through the runtime', () => {
  it('uses eval.pmModel for a new PM Session, inherits eval.model when empty, and leaves workers on executor.model', async () => {
    const host = await startRuntime()
    try {
      const llm = (host.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
      const saved = host.runtime.store.settings()
      const evalModel = { provider: 'eval-provider', model: 'eval-model' }
      const pmModel = { provider: 'pm-provider', model: 'pm-model' }
      const workerModel = { provider: 'worker-provider', model: 'worker-model' }
      host.runtime.store.saveSettings({ ...saved, eval: { ...saved.eval, model: evalModel, pmModel }, executor: { ...saved.executor, model: workerModel } })
      const create = async (id: string) => {
        const request = feishu(id, `Start a project for ${id}`)
        host.runtime.receive(request)
        await host.runtime.idle()
        return host.runTool(host.runtime.masterId, 'orchestrator_project_create',
          { trigger_id: request.id, title: `Model project ${id}`, goal: 'Ship a clearer settings site' }) as Promise<{ project: { project_id: string } }>
      }
      const first = await create('27')
      expect(llm.resolveCallConfig).toHaveBeenCalledWith(expect.objectContaining(pmModel))
      const firstProject = host.runtime.store.projects.get(first.project.project_id)!
      expect(host.tools.get(firstProject.pmSessionId)).toBeDefined()
      // Clearing pmModel makes a later PM inherit eval.model, while a worker still uses executor.model.
      host.runtime.store.saveSettings({ ...host.runtime.store.settings(), eval: { ...host.runtime.store.settings().eval, pmModel: null } })
      const second = await create('28')
      const secondProject = host.runtime.store.projects.get(second.project.project_id)!
      expect(llm.resolveCallConfig).toHaveBeenCalledWith(expect.objectContaining(evalModel))
      const result = await host.runTool(secondProject.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Make the header legible', worktree_name: 'fix-header' }] }) as { tickets: { ticket_id: string }[] }
      const ticket = host.runtime.store.tickets.get(result.tickets[0]!.ticket_id)!
      await vi.waitFor(() => expect(host.tools.get(workerSessionId(ticket.id))).toBeDefined())
      expect(llm.resolveCallConfig).toHaveBeenCalledWith(expect.objectContaining(workerModel))
      // The first PM Session keeps the model it was created with.
      expect(firstProject.pmSessionId).not.toBe(secondProject.pmSessionId)
    } finally { await host.stop() }
  })

  it('lets the PM message a child as a note Input without granting authority or duplicating it', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('29', 'Start a project for PM messages')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'PM messages', goal: 'Ship a clearer settings site' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Make the header legible', worktree_name: 'fix-header' }] }) as { tickets: { ticket_id: string }[] }
      const ticket = host.runtime.store.tickets.get(result.tickets[0]!.ticket_id)!
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.state).toBe('running'))
      const sent = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_message',
        { ticket_id: ticket.id, text: 'The footer task found a shared token.' }) as { delivered: string; ticket: { ticket_id: string } }
      expect(sent).toMatchObject({ delivered: 'running', ticket: { ticket_id: ticket.id } })
      const stored = host.runtime.store.tickets.get(ticket.id)!
      const notes = stored.inputs.filter(input => input.kind === 'note' && input.text === 'The footer task found a shared token.')
      expect(notes).toHaveLength(1)
      expect(stored.assignments).toHaveLength(ticket.assignments.length)
      expect(stored.mandate).toEqual(ticket.mandate)
      await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_message',
        { ticket_id: ticket.id, text: 'The footer task found a shared token.' })
      expect(host.runtime.store.tickets.get(ticket.id)!.inputs.filter(input => input.kind === 'note'
        && input.text === 'The footer task found a shared token.')).toHaveLength(1)
      // A known archived worker Session must not be claimed as delivered, even for a running Assignment.
      host.workspace.archived.add(workerSessionId(ticket.id))
      const archived = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_message',
        { ticket_id: ticket.id, text: 'Archived worker note', wake: true }) as { delivered: string }
      expect(archived.delivered).toBe('not_started')
      // A PM cannot message a Ticket outside its Project, including an unknown one.
      await expect(host.runTool(project.pmSessionId, 'orchestrator_project_ticket_message',
        { ticket_id: 'missing', text: 'No' })).rejects.toThrow('does not belong')
    } finally { await host.stop() }
  })

  it('soft-pauses with one PM notice, hard-pauses Sessions, and resumes with a note', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('30', 'Start a project for pause modes')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Pause modes', goal: 'Ship a clearer settings site' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Make the header legible', worktree_name: 'fix-header' }] }) as { tickets: { ticket_id: string }[] }
      const ticket = host.runtime.store.tickets.get(result.tickets[0]!.ticket_id)!
      const worker = workerSessionId(ticket.id)
      await vi.waitFor(() => expect(host.tools.get(worker)).toBeDefined())
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.state).toBe('running'))
      const pmCancel = host.agents.get(project.pmSessionId)!.cancel
      const workerCancel = host.agents.get(worker)!.cancel
      const pmPauses = () => host.deliveries.mock.calls.map(([call]) => call)
        .filter(call => call.sessionId === project.pmSessionId && call.text.includes('"kind":"project_pause"'))
      const soft = (await host.api('POST', `projects/${project.id}/pause`, { paused: true, mode: 'soft' })).body as
        { paused: boolean; mode: string; sessions: { delivered: boolean } }
      expect(soft).toMatchObject({ paused: true, mode: 'soft', sessions: { delivered: true } })
      expect(pmPauses()).toHaveLength(1)
      expect(host.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.state).toBe('running')
      expect(pmCancel).not.toHaveBeenCalled()
      expect(workerCancel).not.toHaveBeenCalled()
      // Repeating the same soft pause sends no second notice.
      await host.api('POST', `projects/${project.id}/pause`, { paused: true, mode: 'soft' })
      expect(pmPauses()).toHaveLength(1)
      // A soft pause can be upgraded to hard, which cancels loaded Sessions and ends the Assignment.
      const hard = (await host.api('POST', `projects/${project.id}/pause`, { paused: true, mode: 'hard' })).body as
        { paused: boolean; mode: string; sessions: { cancelled: string[] } }
      expect(hard).toMatchObject({ paused: true, mode: 'hard' })
      expect(hard.sessions.cancelled).toEqual(expect.arrayContaining([project.pmSessionId, worker]))
      expect(host.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)).toMatchObject({ state: 'ended',
        endedReason: 'stoppedByOperator' })
      expect(host.runtime.store.tickets.get(ticket.id)?.manualStop).toMatchObject({ scope: 'project' })
      expect(host.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
      expect(host.runtime.store.tickets.get(ticket.id)?.archived).toBeUndefined()
      expect(pmCancel).toHaveBeenCalled()
      expect(workerCancel).toHaveBeenCalled()
      const before = host.runtime.store.tickets.get(ticket.id)!.assignments.length
      const resumed = (await host.api('POST', `projects/${project.id}/pause`, { paused: false })).body as
        { paused: boolean; mode: null; sessions: { delivered: boolean } }
      expect(resumed).toMatchObject({ paused: false, mode: null, sessions: { delivered: false } })
      expect(host.runtime.store.projects.get(project.id)).toMatchObject({ status: 'active' })
      expect(host.runtime.store.projects.get(project.id)?.pauseMode).toBeUndefined()
      expect(host.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(before)
      expect(host.runtime.store.projects.get(project.id)?.pendingNotes?.[0]).toMatchObject({ kind: 'resumedFromHard' })
      const prompt = host.sections.get(project.pmSessionId)!({})
      expect(prompt).toContain('resumedFromHard')
      expect(host.runtime.store.projects.get(project.id)?.pendingNotes).toBeUndefined()
      // An archived Project is history: pausing it sends no PM notice and cancels no Session.
      await host.api('POST', `projects/${project.id}/archive`)
      const archivedPauses = pmPauses().length
      const archivedPause = (await host.api('POST', `projects/${project.id}/pause`, { paused: true, mode: 'soft' })).body as
        { sessions: { delivered: boolean } }
      expect(archivedPause.sessions.delivered).toBe(false)
      expect(pmPauses()).toHaveLength(archivedPauses)
    } finally { await host.stop() }
  })

  it('creates its Tickets, starts a worker Assignment for each, and reads only Tickets inside its Project', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('31', 'Start a project for the settings site')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Settings site', goal: 'Ship a clearer settings site' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Make the header legible', worktree_name: 'fix-header', threads: [{ key: 'github:41' }] },
        { title: 'Footer', goal: 'Fix the footer links', worktree_name: 'fix-footer', threads: [{ key: 'github:42', contextOnly: true }] },
      ] }) as { tickets: { ticket_id: string; project_id?: string }[]; project: { ticket_ids?: string[] }; note: string }
      expect(result.tickets).toHaveLength(2)
      expect(result.tickets.map(card => card.project_id)).toEqual([project.id, project.id])
      expect(result.project.ticket_ids).toEqual(result.tickets.map(card => card.ticket_id))
      expect(result.note).toMatch(/no worker has finished/i)
      const [first, second] = result.tickets.map(card => host.runtime.store.tickets.get(card.ticket_id)!)
      expect(first).toMatchObject({ projectId: project.id, channels: [], title: 'Header' })
      expect(first!.mandate.basis).toMatchObject({ via: 'delegated', projectId: project.id, pmSessionId: project.pmSessionId })
      expect(host.runtime.store.triggers.get(first!.origin.triggerId)).toMatchObject({ source: 'internal', human: false,
        actor: { source: 'internal', id: project.pmSessionId } })
      expect(host.runtime.store.threads.get('github:41')?.subscriptions).toEqual([first!.id])
      expect(host.runtime.store.threads.get('github:42')?.context).toEqual([second!.id])
      // Each Ticket's worker Session starts through the normal worker path, not as a PM Session.
      await vi.waitFor(() => expect(host.tools.get(workerSessionId(first!.id))).toBeDefined())
      await vi.waitFor(() => expect(host.tools.get(workerSessionId(second!.id))).toBeDefined())
      // The PM reads its Project's Tickets and one of them; another Ticket is outside its Project.
      expect(await host.runTool(project.pmSessionId, 'orchestrator_read', { resource: `ticket/${first!.id}` }))
        .toMatchObject({ ticket_id: first!.id, project_id: project.id })
      expect(await host.runTool(project.pmSessionId, 'orchestrator_read', { resource: `project/${project.id}/tickets` }))
        .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ ticket_id: first!.id })]) })
      expect(await host.runTool(project.pmSessionId, 'orchestrator_read', { resource: `project/${project.id}` }))
        .toMatchObject({ ticket_ids: expect.arrayContaining([first!.id, second!.id]) })
      // The management API shows the child Tickets and their external Threads too.
      const detail = (await host.api('GET', `projects/${project.id}`)).body as { tickets: { id: string; threads: { thread: string; context?: true }[] }[] }
      expect(detail.tickets.map(ticket => ticket.id)).toEqual(expect.arrayContaining([first!.id, second!.id]))
      expect(detail.tickets.find(ticket => ticket.id === first!.id)?.threads).toEqual([{ thread: 'github:41' }])
      expect(detail.tickets.find(ticket => ticket.id === second!.id)?.threads).toEqual([{ thread: 'github:42', context: true }])
      const outside = await host.acceptedTicket(feishu('32', '@bot fix a normal ticket'))
      await expect(host.runTool(project.pmSessionId, 'orchestrator_read', { resource: `ticket/${outside.ticket.id}` }))
        .rejects.toThrow('outside it')
      // Still only its own Project and the Tickets inside it.
      await expect(host.runTool(project.pmSessionId, 'orchestrator_read', { resource: 'tickets' })).rejects.toThrow('outside it')
    } finally { await host.stop() }
  })

  it('routes child reports and attention to the PM, the PM project report to the main Session, and Router Tickets to the main Session', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('51', 'Start a project for the settings site')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Settings site', goal: 'Ship a clearer settings site' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Make the header legible', worktree_name: 'fix-header' },
        { title: 'Footer', goal: 'Fix the footer links', worktree_name: 'fix-footer' },
      ] }) as { tickets: { ticket_id: string }[] }
      const [header, footer] = result.tickets.map(card => host.runtime.store.tickets.get(card.ticket_id)!)
      const headerSession = workerSessionId(header!.id), footerSession = workerSessionId(footer!.id)
      await vi.waitFor(() => expect(host.tools.get(headerSession)).toBeDefined())
      await vi.waitFor(() => expect(host.tools.get(footerSession)).toBeDefined())
      const delivered = (sessionId: string) => host.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId)
      const texts = (sessionId: string) => delivered(sessionId).map(call => call.text)
      const report = (ticketId: string) => texts(project.pmSessionId).filter(text => text.includes(ticketId))
      // A blocked child report reaches its PM, not the Router.
      await host.runTool(headerSession, 'orchestrator_report', { state: 'blocked', summary: 'The header needs a choice.' })
      await vi.waitFor(() => expect(report(header!.id).some(text => text.includes('"kind":"worker_report"'))).toBe(true))
      expect(texts(host.runtime.masterId).some(text => text.includes(header!.id) && text.includes('worker_report'))).toBe(false)
      // Pausing stops new Tickets only; the existing child's reports still reach the PM.
      expect(host.runtime.engine.pauseProject(project.id, true).status).toBe('paused')
      await host.runTool(headerSession, 'orchestrator_report', { state: 'blocked', summary: 'Still blocked while paused.' })
      await vi.waitFor(() => expect(report(header!.id).some(text => text.includes('Still blocked while paused.'))).toBe(true))
      // A child attention reaches the PM only; the PM can read the Ticket and its Project's Ticket list.
      await host.runTool(footerSession, 'orchestrator_report', { state: 'progress', summary: 'Which footer?', human_action: 'Which footer?' })
      await vi.waitFor(() => expect(report(footer!.id).some(text => text.includes('"kind":"worker_attention"'))).toBe(true))
      expect(texts(host.runtime.masterId).some(text => text.includes(footer!.id) && text.includes('worker_attention'))).toBe(false)
      expect(await host.runTool(project.pmSessionId, 'orchestrator_read', { resource: `ticket/${footer!.id}` }))
        .toMatchObject({ ticket_id: footer!.id, attention: { question: 'Which footer?' } })
      expect(await host.runTool(project.pmSessionId, 'orchestrator_read', { resource: `project/${project.id}/tickets` }))
        .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ ticket_id: footer!.id,
          attention: expect.objectContaining({ question: 'Which footer?' }) })]) })
      // The PM's Project report is relayed to the Router once, and a retry with the same text is idempotent.
      await host.runTool(project.pmSessionId, 'orchestrator_project_report', { summary: 'Blocked on the footer choice.' })
      await vi.waitFor(() => expect(texts(host.runtime.masterId).some(text => text.includes('"kind":"project_report"')
        && text.includes(project.id))).toBe(true))
      const projectReports = () => texts(host.runtime.masterId).filter(text => text.includes('"kind":"project_report"'))
      expect(projectReports()).toHaveLength(1)
      await host.runTool(project.pmSessionId, 'orchestrator_project_report', { summary: 'Blocked on the footer choice.' })
      expect(projectReports()).toHaveLength(1)
      // A Router-owned Ticket's report still goes to the main Session, not to the Project PM.
      const normal = await host.acceptedTicket(feishu('52', '@bot fix a normal ticket'))
      const normalSession = workerSessionId(normal.ticket.id)
      await vi.waitFor(() => expect(host.tools.get(normalSession)).toBeDefined())
      await host.runTool(normalSession, 'orchestrator_report', { state: 'blocked', summary: 'Normal ticket blocked.' })
      await vi.waitFor(() => expect(texts(host.runtime.masterId).some(text => text.includes(normal.ticket.id)
        && text.includes('"kind":"worker_report"'))).toBe(true))
      expect(texts(project.pmSessionId).some(text => text.includes(normal.ticket.id))).toBe(false)
    } finally { await host.stop() }
  })

  it('falls back to the main Session when its Project has ended', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('53', 'Start a project with one Ticket')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Settings site', goal: 'Ship a clearer settings site' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Make the header legible', worktree_name: 'fix-header' }] }) as { tickets: { ticket_id: string }[] }
      const ticket = host.runtime.store.tickets.get(result.tickets[0]!.ticket_id)!
      const sessionId = workerSessionId(ticket.id)
      await vi.waitFor(() => expect(host.tools.get(sessionId)).toBeDefined())
      // End the Project: the Ticket's report must still reach the main Session.
      host.runtime.store.projects.save({ ...project, status: 'ended' as ProjectProfile['status'] })
      await host.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'The Project ended.' })
      await vi.waitFor(() => expect(host.deliveries.mock.calls.some(([call]) => call.sessionId === host.runtime.masterId
        && call.text.includes(ticket.id) && call.text.includes('"kind":"worker_report"'))).toBe(true))
    } finally { await host.stop() }
  })

  it('archives through the API and unarchives through the Router tools, keeping history and stopping Assignments', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('61', 'Start a project to archive')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Settings site', goal: 'Ship a clearer settings site' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Make the header legible', worktree_name: 'fix-header' },
        { title: 'Footer', goal: 'Fix the footer links', worktree_name: 'fix-footer' },
      ] }) as { tickets: { ticket_id: string }[] }
      const children = result.tickets.map(card => host.runtime.store.tickets.get(card.ticket_id)!)
      for (const ticket of children) await vi.waitFor(() => expect(host.tools.get(workerSessionId(ticket.id))).toBeDefined())
      const normal = await host.acceptedTicket(feishu('62', '@bot fix a normal ticket'))
      const archived = (await host.api('POST', `projects/${project.id}/archive`)).body as { archived: boolean;
        sessions: { ids: string[]; failures: unknown[] } }
      expect(archived).toMatchObject({ archived: true, sessions: { failures: [] } })
      expect(host.runtime.store.projects.get(project.id)).toMatchObject({ status: 'archived', archivedFrom: 'active' })
      for (const ticket of children) {
        const stored = host.runtime.store.tickets.get(ticket.id)!
        expect(stored.archived).toMatchObject({ by: 'project', projectId: project.id })
        expect(stored.assignments.every(assignment => assignment.state === 'ended' && assignment.endedReason === 'projectArchived')).toBe(true)
      }
      expect(host.runtime.store.tickets.get(normal.ticket.id)?.archived).toBeUndefined()
      expect(host.workspace.archiveSession.mock.calls.map(([sessionId]) => sessionId)).toEqual(expect.arrayContaining(
        [project.pmSessionId, ...children.map(ticket => workerSessionId(ticket.id))]))
      for (const [sessionId, options] of host.workspace.archiveSession.mock.calls)
        expect({ sessionId, options }).toEqual({ sessionId, options: { stopActivity: true } })
      await expect(host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Later', goal: 'Must not be created', worktree_name: 'later' }] })).rejects.toThrow(/archived/i)
      // The Router unarchives through its own tool: status, Ticket flags and Sessions, with no new Assignment.
      const before = host.runtime.store.tickets.get(children[0]!.id)!.assignments.length
      const restored = await host.runTool(host.runtime.masterId, 'orchestrator_project_unarchive', { project_id: project.id }) as
        { project: { status: string } }
      expect(restored.project.status).toBe('active')
      expect(host.runtime.store.projects.get(project.id)?.status).toBe('active')
      for (const ticket of children) {
        const stored = host.runtime.store.tickets.get(ticket.id)!
        expect(stored.archived).toBeUndefined()
        expect(stored.ended).toBeUndefined()
        expect(stored.assignments).toHaveLength(before)
        expect(stored.assignments.every(assignment => assignment.state === 'ended')).toBe(true)
      }
      expect(host.workspace.unarchiveSession.mock.calls.map(([sessionId]) => sessionId)).toEqual(expect.arrayContaining(
        [project.pmSessionId, ...children.map(ticket => workerSessionId(ticket.id))]))
      const again = await host.runTool(host.runtime.masterId, 'orchestrator_project_archive', { project_id: project.id }) as
        { project: { status: string } }
      expect(again.project.status).toBe('archived')
    } finally { await host.stop() }
  })

  it('reports Session archive failures without rolling back the Project archive', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('63', 'Start a project whose Session archive fails')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Settings site', goal: 'Ship a clearer settings site' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      host.workspace.archiveSession.mockRejectedValueOnce(new Error('archive denied'))
      const result = (await host.api('POST', `projects/${project.id}/archive`)).body as { sessions: { failures: { sessionId: string; error: string }[] } }
      expect(result.sessions.failures).toEqual([{ sessionId: project.pmSessionId, error: 'archive denied' }])
      expect(host.runtime.store.projects.get(project.id)?.status).toBe('archived')
    } finally { await host.stop() }
  })
})
