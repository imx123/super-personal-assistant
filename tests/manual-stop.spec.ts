/**
 * P3-A: a person's stop of one Worker and a Project hard pause are the same `hardStopWorker` stop; the labels that guard a
 * resume differ, a Project resume clears only its own labels, and a PM revive needs the Project active and a person's
 * approval after a single-Worker stop.
 */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, type Assessor, type Candidate, type DomainEvent, type Executor, type Policy,
  type ProjectProfile, type Ticket, type Trigger } from '../src/core/index.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { projectDetail } from '../src/app/views/projects.ts'
import { ticketDetail } from '../src/app/views/tickets.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import type { Store } from '../src/app/store.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const actor = { source: 'main-session', id: 'dsh-user' }
function trigger(id: string): Trigger {
  return { id, source: 'main-session', threads: [{ source: 'main-session', id }], actor, human: true, addressed: 'direct',
    at: '2026-11-10T00:00:00.000Z', text: `Create a project ${id}`, meta: {} }
}
/** Engine on in-memory repositories; `executor.stop` records calls and can fail for a Ticket the test names. */
function harness() {
  const repo = new MemoryRepositories()
  const events: DomainEvent[] = []
  const stops: { ticketId: string; assignmentId: string; reason: string }[] = []
  const failing = new Set<string>()
  const assessor: Assessor = { request: vi.fn((_candidate: Candidate) => {}), release: vi.fn() }
  const executor: Executor = {
    start: vi.fn(),
    deliver: vi.fn(),
    stop: vi.fn((ticket: Ticket, assignment: { id: string }, reason: string) => {
      if (failing.has(ticket.id)) throw new Error('stop failed')
      stops.push({ ticketId: ticket.id, assignmentId: assignment.id, reason })
    }),
  }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: (t: Trigger) => t.source === 'main-session' && t.actor.id === actor.id
      ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible: false, reason: 'not_human' },
    revalidate: () => true, admitsInferred: () => false }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor, outbox,
    prepareTicket: (ticket, outcome) => ({ ...ticket, execution: { name: `${outcome.name}-${ticket.id.slice(0, 12)}`,
      directory: `/work/${outcome.name}-${ticket.id.slice(0, 12)}`, assignment: outcome.scope } }),
    emit: event => { events.push(event) }, now: () => '2026-11-10T00:00:00.000Z' })
  /** A Project with one delegated Ticket, or the given tasks. */
  const projectWith = (id: string, tasks: { title: string; goal: string }[] = [{ title: `Work ${id}`, goal: `Do ${id}` }]) => {
    engine.recordTriggerForRouting(trigger(id))
    const project = engine.createProject(id, `Project ${id}`, `Goal ${id}`)
    const tickets = engine.createProjectTickets(project.id, project.pmSessionId, tasks)
    stops.length = 0
    events.length = 0
    return { project, tickets }
  }
  return { repo, engine, events, stops, failing, executor, projectWith }
}
const assignmentOf = (repo: MemoryRepositories, ticket: Ticket) => repo.tickets.get(ticket.id)!.assignments.at(-1)!

describe('the one hardStopWorker primitive', () => {
  it('leaves the same Assignment, Ticket and Session stop from a single Worker stop and a Project hard pause', () => {
    const h = harness()
    const single = h.projectWith('p1').tickets[0]!
    const bulk = h.projectWith('p2').tickets[0]!
    h.engine.assignmentStarted(single.id, single.assignments[0]!.id)
    h.engine.assignmentStarted(bulk.id, bulk.assignments[0]!.id)
    // Both Workers had a question for a person when they were stopped.
    h.engine.report(single.id, { state: 'progress', summary: 'Need a choice', question: 'Which?' })
    h.engine.report(bulk.id, { state: 'progress', summary: 'Need a choice', question: 'Which?' })
    h.engine.stopAssignment(single.id, single.assignments[0]!.id)
    h.engine.pauseProject(bulk.projectId!, true, 'hard')

    const one = h.repo.tickets.get(single.id)!, many = h.repo.tickets.get(bulk.id)!
    expect(one.ended).toBeUndefined()
    expect(many.ended).toBeUndefined()
    expect(assignmentOf(h.repo, single)).toMatchObject({ state: 'ended', endedReason: 'stoppedByOperator', report: { state: 'progress' } })
    expect(assignmentOf(h.repo, bulk)).toMatchObject({ state: 'ended', endedReason: 'stoppedByOperator' })
    expect(one.attention).toBeUndefined()
    expect(many.attention).toBeUndefined()
    expect(one.manualStop).toMatchObject({ scope: 'worker', by: 'user' })
    expect(many.manualStop).toMatchObject({ scope: 'project', by: 'user', reason: 'projectPausedByUser' })
    // The Executor is asked to cancel the same Assignment with the same reason on both paths.
    expect(h.stops).toEqual([
      { ticketId: single.id, assignmentId: single.assignments[0]!.id, reason: 'stoppedByOperator' },
      { ticketId: bulk.id, assignmentId: bulk.assignments[0]!.id, reason: 'stoppedByOperator' },
    ])
    // Only the label differs: the Project carries the `project` scope, the single stop the `worker` scope.
    expect(h.events.filter(event => event.type === 'ticket.manualStopSet').map(event => event.data))
      .toEqual([{ ticketId: single.id, scope: 'worker' }, { ticketId: bulk.id, scope: 'project' }])
  })

  it('stops an already ended Worker idempotently and keeps its worker label through a Project hard pause', () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1', [{ title: 'Header', goal: 'Fix the header' }])
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    h.engine.stopAssignment(ticket!.id, ticket!.assignments[0]!.id)
    const stopped = h.repo.tickets.get(ticket!.id)!.manualStop!
    expect(stopped).toMatchObject({ scope: 'worker', by: 'user' })
    // Repeating the single stop neither throws nor re-stops the Worker nor changes the label.
    h.engine.stopAssignment(ticket!.id, ticket!.assignments[0]!.id)
    expect(h.repo.tickets.get(ticket!.id)!.manualStop).toEqual(stopped)
    expect(h.stops).toHaveLength(1)
    // A later Project hard pause must not overwrite it, even though it visits the already stopped Worker.
    const report = h.engine.pauseProjectReport(project.id, true, 'hard')
    expect(report.workers.stopped).toEqual([ticket!.id])
    expect(report.workers.failures).toEqual([])
    expect(h.repo.tickets.get(ticket!.id)!.manualStop).toEqual(stopped)
    expect(h.stops).toHaveLength(1)
    // The Project resume clears only project labels, so this Worker still waits for a person.
    h.engine.pauseProject(project.id, false)
    expect(h.repo.tickets.get(ticket!.id)!.manualStop).toEqual(stopped)
    expect(() => h.engine.retryTicket(ticket!.id)).toThrow(new UserError('manualStopNeedsUserApproval'))
  })

  it('continues with the other Workers when one stop fails and reports the failure', () => {
    const h = harness()
    const { project, tickets } = h.projectWith('p1', [{ title: 'Header', goal: 'Fix the header' }, { title: 'Footer', goal: 'Fix the footer' }])
    for (const ticket of tickets) h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
    h.failing.add(tickets[0]!.id)
    const report = h.engine.pauseProjectReport(project.id, true, 'hard')
    expect(report.project.status).toBe('paused')
    expect(report.workers.stopped).toEqual([tickets[1]!.id])
    expect(report.workers.failures).toEqual([{ ticketId: tickets[0]!.id, error: 'stop failed' }])
    // The failed Worker keeps its running Assignment and no label, so the Project does not look fully stopped.
    expect(h.repo.tickets.get(tickets[0]!.id)).toMatchObject({ assignments: [{ state: 'running' }] })
    expect(h.repo.tickets.get(tickets[0]!.id)!.manualStop).toBeUndefined()
    expect(assignmentOf(h.repo, tickets[1]!)).toMatchObject({ state: 'ended', endedReason: 'stoppedByOperator', })
    // The aggregate event names the failure for the Router.
    expect(h.events.filter(event => event.type === 'project.pausedByUser').map(event => event.data)).toEqual([
      { projectId: project.id, mode: 'hard', stopped: [tickets[1]!.id],
        failures: [{ ticketId: tickets[0]!.id, error: 'stop failed' }] }])
  })

  it('is idempotent: a repeated hard pause and a soft downgrade stop no Worker twice', () => {
    const h = harness()
    const { project, tickets } = h.projectWith('p1')
    h.engine.pauseProject(project.id, true, 'hard')
    expect(h.stops).toHaveLength(1)
    const events = h.events.length
    h.engine.pauseProject(project.id, true, 'hard')
    h.engine.pauseProject(project.id, true, 'soft')
    expect(h.stops).toHaveLength(1)
    expect(h.events).toHaveLength(events)
    expect(h.repo.tickets.get(tickets[0]!.id)!.manualStop).toMatchObject({ scope: 'project' })
  })
})

describe('manual stop labels and resume guards', () => {
  it('clears only project labels on resume, and starts nothing', () => {
    const h = harness()
    const { project, tickets: [single, bulk] } = h.projectWith('p1', [{ title: 'One', goal: 'One' }, { title: 'Two', goal: 'Two' }])
    h.engine.assignmentStarted(single!.id, single!.assignments[0]!.id)
    h.engine.assignmentStarted(bulk!.id, bulk!.assignments[0]!.id)
    h.engine.stopAssignment(single!.id, single!.assignments[0]!.id)
    h.engine.pauseProject(project.id, true, 'hard')
    expect(h.repo.tickets.get(single!.id)!.manualStop).toMatchObject({ scope: 'worker' })
    expect(h.repo.tickets.get(bulk!.id)!.manualStop).toMatchObject({ scope: 'project' })
    const assignments = h.repo.tickets.list().map(ticket => ticket.assignments.length)
    vi.mocked(h.executor.start).mockClear()
    h.engine.pauseProject(project.id, false)
    expect(h.repo.tickets.get(single!.id)!.manualStop).toMatchObject({ scope: 'worker' })
    expect(h.repo.tickets.get(bulk!.id)!.manualStop).toBeUndefined()
    expect(h.repo.tickets.list().map(ticket => ticket.assignments.length)).toEqual(assignments)
    expect(h.executor.start).not.toHaveBeenCalled()
    // A single Worker's stop still refuses a retry; the Project-stopped one is retryable now.
    expect(() => h.engine.retryTicket(single!.id)).toThrow(new UserError('manualStopNeedsUserApproval'))
    expect(h.engine.retryTicket(bulk!.id).assignments.map(assignment => assignment.state)).toEqual(['ended', 'pending'])
  })

  it('refuses to start work for a stopped Worker until its label is cleared', () => {
    const h = harness()
    const { tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    h.engine.stopAssignment(ticket!.id, ticket!.assignments[0]!.id)
    expect(() => h.engine.retryTicket(ticket!.id)).toThrow(new UserError('manualStopNeedsUserApproval'))
    vi.mocked(h.executor.start).mockClear()
    h.engine.allowResume(ticket!.id)
    expect(h.repo.tickets.get(ticket!.id)!.manualStop).toBeUndefined()
    // Clearing the label starts nothing.
    expect(h.repo.tickets.get(ticket!.id)!.assignments).toHaveLength(1)
    expect(h.executor.start).not.toHaveBeenCalled()
    expect(h.engine.retryTicket(ticket!.id).assignments.map(assignment => assignment.state)).toEqual(['ended', 'pending'])
    // Only a worker label can be cleared, and only once.
    expect(() => h.engine.allowResume(ticket!.id)).toThrow(new UserError('notManuallyStopped'))
  })

  it('refuses a PM revive of a person-stopped Worker and revives a Project-stopped one under the same Mandate', () => {
    const h = harness()
    const { project, tickets: [workerStopped, projectStopped] } = h.projectWith('p1', [{ title: 'One', goal: 'One' }, { title: 'Two', goal: 'Two' }])
    h.engine.assignmentStarted(workerStopped!.id, workerStopped!.assignments[0]!.id)
    h.engine.assignmentStarted(projectStopped!.id, projectStopped!.assignments[0]!.id)
    h.engine.stopAssignment(workerStopped!.id, workerStopped!.assignments[0]!.id)
    h.engine.pauseProject(project.id, true, 'hard')
    h.engine.pauseProject(project.id, false)
    expect(() => h.engine.reviveProjectTicket(project.id, project.pmSessionId, workerStopped!.id))
      .toThrow(new UserError('manualStopNeedsUserApproval'))
    const before = h.repo.tickets.get(projectStopped!.id)!
    const revived = h.engine.reviveProjectTicket(project.id, project.pmSessionId, projectStopped!.id)
    expect(revived.manualStop).toBeUndefined()
    expect(revived.mandate).toEqual(before.mandate)
    expect(revived.execution).toEqual(before.execution)
    expect(revived.assignments).toHaveLength(2)
    expect(revived.assignments.at(-1)).toMatchObject({ state: 'pending' })
    expect(h.repo.decisions.byThread(`internal:${revived.origin.triggerId}`)).toHaveLength(1)
    expect(h.events.filter(event => event.type === 'ticket.revived').map(event => event.data))
      .toEqual([{ ticketId: projectStopped!.id, assignmentId: revived.assignments.at(-1)!.id, pmSessionId: project.pmSessionId }])
    // After a person approves the single stop, the PM's revive works in the same way.
    h.engine.allowResume(workerStopped!.id)
    expect(h.engine.reviveProjectTicket(project.id, project.pmSessionId, workerStopped!.id).assignments.at(-1)!.state).toBe('pending')
  })

  it('revives only inside an active Project, from its own PM, and only a stopped open Ticket', () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.pauseProject(project.id, true, 'hard')
    const revive = () => h.engine.reviveProjectTicket(project.id, project.pmSessionId, ticket!.id)
    expect(revive).toThrow(new UserError('projectPaused'))
    h.engine.pauseProject(project.id, false)
    expect(() => h.engine.reviveProjectTicket(project.id, 'pm-other', ticket!.id)).toThrow(new UserError('notProjectPm'))
    expect(() => h.engine.reviveProjectTicket('missing', project.pmSessionId, ticket!.id)).toThrow(new UserError('unknownProject'))
    h.engine.stopTicket(ticket!.id)
    expect(() => h.engine.reviveProjectTicket(project.id, project.pmSessionId, ticket!.id)).toThrow(new UserError('ticketEnded'))
    const other = h.projectWith('p2').tickets[0]!
    expect(() => h.engine.reviveProjectTicket(project.id, project.pmSessionId, other.id)).toThrow(new UserError('notProjectTicket'))
    expect(() => h.engine.reviveProjectTicket(project.id, project.pmSessionId, 'missing')).toThrow(new UserError('unknownTicket'))
    // A ticket whose Assignment ended for another reason, without a stop label, is not revivable.
    const idle = h.projectWith('p4').tickets[0]!
    const storedIdle = h.repo.tickets.get(idle.id)!
    storedIdle.assignments[0]!.state = 'ended'; storedIdle.assignments[0]!.endedReason = 'sessionArchived'
    h.repo.tickets.save(storedIdle)
    expect(() => h.engine.reviveProjectTicket(idle.projectId!, h.repo.projects.get(idle.projectId!)!.pmSessionId, idle.id))
      .toThrow(new UserError('notManuallyStopped'))
    // Archived and ended Projects refuse it before touching the Ticket.
    h.engine.stopProject(other.projectId!)
    expect(() => h.engine.reviveProjectTicket(other.projectId!, h.repo.projects.get(other.projectId!)!.pmSessionId, other.id))
      .toThrow(new UserError('projectEnded'))
    const archived = h.projectWith('p3')
    h.engine.archiveProject(archived.project.id)
    expect(() => h.engine.reviveProjectTicket(archived.project.id, archived.project.pmSessionId, archived.tickets[0]!.id))
      .toThrow(new UserError('projectArchived'))
  })
})

describe('manual stop read views', () => {
  it('shows the stop and the Allow resume action on the Ticket page and its Project page', () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    h.engine.stopAssignment(ticket!.id, ticket!.assignments[0]!.id)
    const store = { settings: () => SettingsSchema.parse({}), read: { subscribedThreads: () => [], firstTrigger: () => undefined },
      tickets: h.repo.tickets, threads: h.repo.threads, projects: h.repo.projects, triggers: h.repo.triggers, decisions: h.repo.decisions } as unknown as Store
    const host = { store, sources: { kind: () => undefined }, links: () => ({ url: '', label: { zh: '', en: '' } }) }
    const ticketView = ticketDetail(host as never, ticket!.id)!
    expect(ticketView.actions.allowResume).toBe(true)
    expect(ticketView.manualStop).toMatchObject({ scope: 'worker' })
    const projectView = projectDetail(store, project.id)!
    expect(projectView.tickets[0]).toMatchObject({ id: ticket!.id, manualStop: { scope: 'worker' }, actions: { allowResume: true } })
  })
})

describe('a Project PM stop and revive through the runtime', () => {
  it('writes labels, relays one aggregate notice, cancels Sessions, and leaves the PM able to revive', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('71', 'Start a project for stops')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Stop project', goal: 'Stop and revive Workers' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' },
        { title: 'Footer', goal: 'Fix the footer', worktree_name: 'fix-footer' }] }) as { tickets: { ticket_id: string }[] }
      const [first, second] = result.tickets.map(card => host.runtime.store.tickets.get(card.ticket_id)!)
      await vi.waitFor(() => expect(host.tools.get(workerSessionId(first!.id))).toBeDefined())
      await vi.waitFor(() => expect(host.tools.get(workerSessionId(second!.id))).toBeDefined())
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(first!.id)?.assignments.at(-1)?.state).toBe('running'))
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(second!.id)?.assignments.at(-1)?.state).toBe('running'))
      const workerCancel = host.agents.get(workerSessionId(first!.id))!.cancel
      const secondCancel = host.agents.get(workerSessionId(second!.id))!.cancel
      // A person stops one Worker on its Ticket page: the label is `worker`, the Session is cancelled, and no project notice goes out.
      const stopped = await host.api('POST', `tickets/${first!.id}/assignment/stop`, { assignmentId: first!.assignments[0]!.id })
      expect(stopped).toEqual({ status: 200, body: { stopped: true } })
      expect(host.runtime.store.tickets.get(first!.id)!.manualStop).toMatchObject({ scope: 'worker' })
      expect(workerCancel).toHaveBeenCalled()
      const execution = () => host.deliveries.mock.calls.map(([call]) => call)
        .filter(call => call.text.includes('"kind":"execution_status"') && call.text.includes(first!.id))
        .map(call => JSON.parse(call.text) as Record<string, unknown>)
      await vi.waitFor(() => expect(execution()).toHaveLength(1))
      expect(execution()[0]).toMatchObject({ manual_stop: { scope: 'worker' }, needs_user_approval: true })
      expect(host.deliveries.mock.calls.some(([call]) => call.text.includes('projectPausedByUser'))).toBe(false)
      // The PM's revive of the person-stopped Worker is refused until a person approves it, and starts nothing.
      await expect(host.runTool(project.pmSessionId, 'orchestrator_project_ticket_revive', { ticket_id: first!.id }))
        .rejects.toThrow(/needs user approval|stopped by a person/i)
      const before = host.runtime.store.tickets.get(first!.id)!.assignments.length
      expect(before).toBe(1)
      // A hard pause visits both Workers; the person-stopped one keeps its worker label, and the Router gets one aggregate notice.
      const hard = (await host.api('POST', `projects/${project.id}/pause`, { paused: true, mode: 'hard' })).body as
        { paused: boolean; mode: string; workers: { stopped: string[]; failures: unknown[] } }
      expect(hard).toMatchObject({ paused: true, mode: 'hard', workers: { failures: [] } })
      expect(hard.workers.stopped).toEqual(expect.arrayContaining([first!.id, second!.id]))
      expect(host.runtime.store.tickets.get(second!.id)!.manualStop).toMatchObject({ scope: 'project' })
      expect(host.runtime.store.tickets.get(first!.id)!.manualStop).toMatchObject({ scope: 'worker' })
      expect(secondCancel).toHaveBeenCalled()
      const aggregate = () => host.deliveries.mock.calls.map(([call]) => call)
        .filter(call => call.text.includes('projectPausedByUser'))
      await vi.waitFor(() => expect(aggregate()).toHaveLength(1))
      expect(aggregate()[0]!.sessionId).toBe(host.runtime.masterId)
      expect(JSON.parse(aggregate()[0]!.text)).toMatchObject({ failures: [] })
      // The hard pause cancelled the PM Session too, so no per-Worker execution relay was delivered for it.
      expect(execution()).toHaveLength(1)
      // Resume clears only the project label; the PM revives the second Worker, keeping its Mandate and worktree.
      await host.api('POST', `projects/${project.id}/pause`, { paused: false })
      expect(host.runtime.store.tickets.get(second!.id)!.manualStop).toBeUndefined()
      const mandate = host.runtime.store.tickets.get(second!.id)!.mandate
      const directory = host.runtime.store.tickets.get(second!.id)!.execution?.directory
      const revived = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_revive', { ticket_id: second!.id })
      expect(revived).toMatchObject({ ticket: { ticket_id: second!.id } })
      const stored = host.runtime.store.tickets.get(second!.id)!
      expect(stored.mandate).toEqual(mandate)
      expect(stored.execution?.directory).toBe(directory)
      expect(stored.assignments.length).toBeGreaterThan(1)
      // Allow resume clears the person's label but starts nothing; the PM's revive then queues the Assignment.
      const approved = await host.api('POST', `tickets/${first!.id}/allow-resume`)
      expect(approved).toEqual({ status: 200, body: { allowed: true } })
      expect(host.runtime.store.tickets.get(first!.id)!.manualStop).toBeUndefined()
      expect(host.runtime.store.tickets.get(first!.id)!.assignments.length).toBe(before)
      expect(await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_revive', { ticket_id: first!.id }))
        .toBeDefined()
      expect(host.runtime.store.tickets.get(first!.id)!.assignments.length).toBe(before + 1)
    } finally { await host.stop() }
  })

  it('reports a Worker it could not stop, keeps it running, and still pauses the Project', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('73', 'Start a project with a failing stop')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Failing stop', goal: 'Check partial failure' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' },
        { title: 'Footer', goal: 'Fix the footer', worktree_name: 'fix-footer' }] }) as { tickets: { ticket_id: string }[] }
      const [first, second] = result.tickets.map(card => host.runtime.store.tickets.get(card.ticket_id)!)
      for (const ticket of [first, second]) {
        await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running'))
      }
      const stop = host.runtime.executor.stop.bind(host.runtime.executor)
      const denied = vi.spyOn(host.runtime.executor, 'stop').mockImplementation((ticket, assignment, reason) => {
        if (ticket.id === first!.id) throw new Error('cancel denied')
        stop(ticket, assignment, reason)
      })
      try {
        const hard = (await host.api('POST', `projects/${project.id}/pause`, { paused: true, mode: 'hard' })).body as
          { paused: boolean; workers: { stopped: string[]; failures: { ticketId: string; error: string }[] } }
        expect(hard).toMatchObject({ paused: true, workers: { failures: [{ ticketId: first!.id, error: 'cancel denied' }] } })
        expect(hard.workers.stopped).toEqual([second!.id])
        // The failing Worker keeps its running Assignment and no label, so the Project is not shown as fully stopped.
        expect(host.runtime.store.tickets.get(first!.id)).toMatchObject({ assignments: [{ state: 'running' }] })
        expect(host.runtime.store.tickets.get(first!.id)!.manualStop).toBeUndefined()
        expect(host.runtime.store.tickets.get(second!.id)!.manualStop).toMatchObject({ scope: 'project' })
        const aggregate = () => host.deliveries.mock.calls.map(([call]) => call)
          .filter(call => call.text.includes('projectPausedByUser'))
        await vi.waitFor(() => expect(aggregate()).toHaveLength(1))
        expect(JSON.parse(aggregate()[0]!.text)).toMatchObject({ failures: [{ ticketId: first!.id, error: 'cancel denied' }] })
      } finally { denied.mockRestore() }
    } finally { await host.stop() }
  })

  it('keeps the revive tool inside the PM boundary and out of the main Session tools', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('72', 'Start a project for the tool boundary')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Boundary', goal: 'Check tools' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      expect([...host.tools.get(project.pmSessionId)!.keys()]).toContain('orchestrator_project_ticket_revive')
      expect([...host.tools.get(host.runtime.masterId)!.keys()]).not.toContain('orchestrator_project_ticket_revive')
      expect([...host.tools.get(host.runtime.masterId)!.keys()]).not.toContain('orchestrator_project_ticket_allow_resume')
      await expect(host.runTool(host.runtime.masterId, 'orchestrator_project_ticket_revive', { ticket_id: 'x' }))
        .rejects.toThrow(/not registered/)
    } finally { await host.stop() }
  })
})

describe('a revoked Project refuses new work after a stop', () => {
  it('does not pause or stop a Worker in an ended or archived Project', () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.stopProject(project.id)
    const stopCalls = h.stops.length
    expect(h.engine.pauseProject(project.id, true, 'hard').status).toBe('ended')
    expect(h.repo.tickets.get(ticket!.id)!.manualStop).toBeUndefined()
    expect(h.stops).toHaveLength(stopCalls)
    const archived = h.projectWith('p2')
    h.engine.archiveProject(archived.project.id)
    expect(h.engine.pauseProject(archived.project.id, true, 'hard').status).toBe('archived')
    expect(h.repo.tickets.get(archived.tickets[0]!.id)!.manualStop).toBeUndefined()
  })

  it('is revalidated by a delegated Mandate without an allowed list', () => {
    const h = harness()
    const { project } = h.projectWith('p1')
    const policy = settingsPolicy(SettingsSchema.parse({}), { scope: () => ({ listened: false, reason: 'off' }) })
    expect(policy.revalidate({ ...project.mandate, basis: { via: 'delegated', projectId: project.id } })).toBe(true)
  })
})
