/**
 * P3-B: same-Project Worker handoffs (a new Session on the same Ticket under one PM) and cross-Project splits (a new,
 * independent Ticket that the target Project's PM accepts or rejects), plus their permission boundaries.
 */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, assignmentSessionId, latestAssignment, ticketOfSession, workerSessionId,
  workerSessionsOf, type Assessor, type Candidate, type DomainEvent, type Executor, type Policy, type ProjectProfile, type Ticket,
  type Trigger } from '../src/core/index.ts'
import { PM_TOOLS } from '../src/app/sessions.ts'
import { ticketDetail } from '../src/app/views/tickets.ts'
import { projectDetail } from '../src/app/views/projects.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Store } from '../src/app/store.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const actor = { source: 'main-session', id: 'dsh-user' }
function trigger(id: string): Trigger {
  return { id, source: 'main-session', threads: [{ source: 'main-session', id }], actor, human: true, addressed: 'direct',
    at: '2026-11-10T00:00:00.000Z', text: `Create a project ${id}`, meta: {} }
}
function harness() {
  const repo = new MemoryRepositories()
  const events: DomainEvent[] = []
  const stops: { ticketId: string; assignmentId: string; reason: string }[] = []
  const starts: string[] = []
  const assessor: Assessor = { request: vi.fn((_candidate: Candidate) => {}), release: vi.fn() }
  const executor: Executor = {
    start: vi.fn((ticket: Ticket, assignment: { id: string }) => { starts.push(`${ticket.id}:${assignment.id}`) }),
    deliver: vi.fn(),
    stop: vi.fn((ticket: Ticket, assignment: { id: string }, reason: string) => { stops.push({ ticketId: ticket.id,
      assignmentId: assignment.id, reason }) }),
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
  const projectWith = (id: string, tasks: { title: string; goal: string }[] = [{ title: `Work ${id}`, goal: `Do ${id}` }]) => {
    engine.recordTriggerForRouting(trigger(id))
    const project = engine.createProject(id, `Project ${id}`, `Goal ${id}`)
    const tickets = engine.createProjectTickets(project.id, project.pmSessionId, tasks)
    stops.length = 0; starts.length = 0; events.length = 0
    return { project, tickets }
  }
  return { repo, engine, events, stops, starts, executor, projectWith }
}
const assignmentOf = (repo: MemoryRepositories, ticket: Ticket) => repo.tickets.get(ticket.id)!.assignments.at(-1)!

describe('Worker Session ids after a handoff', () => {
  it('names the base Session and each handoff, and resolves all of them to the same Ticket', () => {
    expect(workerSessionId('t1')).toBe('worker-t1')
    expect(workerSessionId('t1', 2)).toBe('worker-t1-h2')
    expect(ticketOfSession('worker-t1')).toBe('t1')
    expect(ticketOfSession('worker-t1-h2')).toBe('t1')
    expect(ticketOfSession('worker-t1-h12')).toBe('t1')
    expect(ticketOfSession('pm-p1')).toBeUndefined()
    expect(ticketOfSession('child-1')).toBeUndefined()
    const ticket = { id: 't1', assignments: [{ id: 'a1', state: 'ended' as const, createdAt: '', endedReason: 'handedOff',
      sessionId: 'worker-t1' }, { id: 'a2', state: 'pending' as const, createdAt: '', sessionId: 'worker-t1-h1' }],
    handoffs: [{ id: 'h', at: '', kind: 'transfer' as const, status: 'accepted' as const, from: { ticketId: 't1', projectId: 'p1',
      sessionId: 'worker-t1' }, to: { ticketId: 't1', projectId: 'p1', sessionId: 'worker-t1-h1' }, summary: 's' }] } as unknown as Ticket
    expect(workerSessionsOf(ticket)).toEqual(['worker-t1', 'worker-t1-h1'])
    expect(assignmentSessionId('t1', ticket.assignments[0]!)).toBe('worker-t1')
    expect(assignmentSessionId('t1', ticket.assignments[1]!)).toBe('worker-t1-h1')
  })
})

describe('same-Project Ticket handoff', () => {
  it('keeps the Ticket, Mandate and worktree, ends the old Assignment handedOff and starts worker-h1', async () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    const before = h.repo.tickets.get(ticket!.id)!
    const handed = await h.engine.transferTicket(project.id, project.pmSessionId, ticket!.id, { reason: 'The Worker is stuck',
      summary: 'Header done; footer still needs a link check.', unfinished: ['Check the footer links'] })
    expect(handed.ended).toBeUndefined()
    expect(handed.mandate).toEqual(before.mandate)
    expect(handed.execution).toEqual(before.execution)
    expect(handed.origin).toEqual(before.origin)
    expect(handed.assignments).toHaveLength(2)
    expect(handed.assignments[0]).toMatchObject({ state: 'ended', endedReason: 'handedOff', sessionId: workerSessionId(ticket!.id) })
    expect(assignmentOf(h.repo, ticket!)).toMatchObject({ state: 'pending', sessionId: `${workerSessionId(ticket!.id)}-h1` })
    expect(handed.handoffs).toHaveLength(1)
    expect(handed.handoffs![0]).toMatchObject({ kind: 'transfer', status: 'accepted',
      from: { ticketId: ticket!.id, projectId: project.id, assignmentId: ticket!.assignments[0]!.id,
        sessionId: workerSessionId(ticket!.id) },
      to: { ticketId: ticket!.id, projectId: project.id, assignmentId: handed.assignments[1]!.id,
        sessionId: `${workerSessionId(ticket!.id)}-h1` },
      reason: 'The Worker is stuck', summary: 'Header done; footer still needs a link check.', unfinished: ['Check the footer links'],
      approvedBy: { kind: 'pm', sessionId: project.pmSessionId } })
    // The new Worker gets the handoff briefing, and the old one is stopped with the handedOff reason.
    expect(handed.inputs.at(-1)).toMatchObject({ kind: 'text' })
    expect((handed.inputs.at(-1) as { text: string }).text).toContain('Check the footer links')
    expect(h.stops).toEqual([{ ticketId: ticket!.id, assignmentId: ticket!.assignments[0]!.id, reason: 'handedOff' }])
    expect(h.starts).toEqual([`${ticket!.id}:${handed.assignments[1]!.id}`])
    expect(h.events.filter(event => event.type === 'ticket.handedOff').map(event => event.data))
      .toEqual([{ ticketId: ticket!.id, handoffId: handed.handoffs![0]!.id, kind: 'transfer', toTicketId: ticket!.id,
        toSessionId: `${workerSessionId(ticket!.id)}-h1` }])
  })

  it('numbers further handoffs h2, h3 and keeps every earlier Assignment and Session', async () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    await h.engine.transferTicket(project.id, project.pmSessionId, ticket!.id, { reason: 'One', summary: 'First' })
    await h.engine.transferTicket(project.id, project.pmSessionId, ticket!.id, { reason: 'Two', summary: 'Second' })
    const stored = h.repo.tickets.get(ticket!.id)!
    expect(stored.assignments.map(assignment => assignment.sessionId)).toEqual([workerSessionId(ticket!.id),
      `${workerSessionId(ticket!.id)}-h1`, `${workerSessionId(ticket!.id)}-h2`])
    expect(stored.handoffs!.map(handoff => handoff.to.sessionId)).toEqual([`${workerSessionId(ticket!.id)}-h1`,
      `${workerSessionId(ticket!.id)}-h2`])
    expect(workerSessionsOf(stored)).toEqual([workerSessionId(ticket!.id), `${workerSessionId(ticket!.id)}-h1`,
      `${workerSessionId(ticket!.id)}-h2`])
    expect(stored.assignments.map(assignment => assignment.endedReason)).toEqual(['handedOff', 'handedOff', undefined])
  })

  it('refuses a handoff outside an active Project, from another PM or Worker, and with nothing to hand over', async () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    const transfer = (projectId = project.id, pm = project.pmSessionId, ticketId = ticket!.id) =>
      h.engine.transferTicket(projectId, pm, ticketId, { reason: 'Stuck', summary: 'Summary' })
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    await expect(transfer(project.id, 'pm-other')).rejects.toThrow(new UserError('notProjectPm'))
    await expect(transfer('missing')).rejects.toThrow(new UserError('unknownProject'))
    h.engine.pauseProject(project.id, true)
    await expect(transfer()).rejects.toThrow(new UserError('projectPaused'))
    h.engine.pauseProject(project.id, false)
    // A Ticket whose Assignment already ended has nothing to hand over; an ended Ticket neither.
    const ended = h.projectWith('p2').tickets[0]!
    const stored = h.repo.tickets.get(ended.id)!
    stored.assignments[0]!.state = 'ended'; stored.assignments[0]!.endedReason = 'sessionArchived'
    h.repo.tickets.save(stored)
    await expect(h.engine.transferTicket(ended.projectId!, h.repo.projects.get(ended.projectId!)!.pmSessionId, ended.id,
      { reason: 'Stuck', summary: 'Summary' })).rejects.toThrow(new UserError('notHandoffable'))
    h.engine.stopTicket(ended.id)
    await expect(h.engine.transferTicket(ended.projectId!, h.repo.projects.get(ended.projectId!)!.pmSessionId, ended.id,
      { reason: 'Stuck', summary: 'Summary' })).rejects.toThrow(new UserError('ticketEnded'))
    const router = (() => {
      h.engine.recordTriggerForRouting(trigger('p9'))
      return h.engine.decide('p9', { kind: 'accept', title: 'Normal', scope: 'normal', reason: 'requested', acknowledgement: 'ok',
        name: 'normal-work' })
    })()
    await expect(h.engine.transferTicket(project.id, project.pmSessionId, router.ticketId!,
      { reason: 'Stuck', summary: 'Summary' })).rejects.toThrow(new UserError('notProjectTicket'))
    await expect(h.engine.transferTicket(project.id, project.pmSessionId, ticket!.id, { reason: '', summary: '' }))
      .rejects.toThrow(new UserError('invalidHandoff', { reason: 'summary is required' }))
    // A person's stop is not silently handed over.
    h.engine.stopAssignment(ticket!.id, ticket!.assignments[0]!.id)
    await expect(transfer()).rejects.toThrow(new UserError('manualStopNeedsUserApproval'))
  })
})

describe('cross-Project handoff', () => {
  function twoProjects() {
    const h = harness()
    const source = h.projectWith('p1')
    const target = h.projectWith('p2')
    h.engine.assignmentStarted(source.tickets[0]!.id, source.tickets[0]!.assignments[0]!.id)
    return { ...h, source, target }
  }
  const request = { targetProjectId: '', title: 'Footer', goal: 'Fix the footer on the settings site', reason: 'The footer belongs to the settings Project',
    summary: 'Header done; footer link check remains.', unfinished: ['Check the footer links'] }

  it('records a pending request without stopping the source, and is idempotent', () => {
    const h = twoProjects()
    const input = { ...request, targetProjectId: h.target.project.id }
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, h.source.tickets[0]!.id, input)
    expect(handoff).toMatchObject({ kind: 'split', status: 'pending', to: { projectId: h.target.project.id },
      from: { ticketId: h.source.tickets[0]!.id, projectId: h.source.project.id },
      request: { title: 'Footer', goal: 'Fix the footer on the settings site' }, summary: request.summary,
      unfinished: ['Check the footer links'] })
    const source = h.repo.tickets.get(h.source.tickets[0]!.id)!
    expect(source.ended).toBeUndefined()
    expect(assignmentOf(h.repo, h.source.tickets[0]!)).toMatchObject({ state: 'running' })
    expect(h.repo.tickets.list().filter(ticket => ticket.projectId === h.target.project.id)).toHaveLength(1)
    expect(h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, h.source.tickets[0]!.id, input)).toEqual(handoff)
    expect(h.repo.tickets.get(h.source.tickets[0]!.id)!.handoffs).toHaveLength(1)
  })

  it('refuses a non-active or own target and a caller that is not the source PM', () => {
    const h = twoProjects()
    const source = h.source.project, ticketId = h.source.tickets[0]!.id
    const call = (targetProjectId: string, pm = source.pmSessionId) =>
      h.engine.requestProjectHandoff(source.id, pm, ticketId, { ...request, targetProjectId })
    expect(() => call(h.target.project.id, 'pm-other')).toThrow(new UserError('notProjectPm'))
    expect(() => call(source.id)).toThrow(new UserError('handoffTarget'))
    expect(() => call('missing')).toThrow(new UserError('unknownProject'))
    h.engine.pauseProject(h.target.project.id, true)
    expect(() => call(h.target.project.id)).toThrow(new UserError('projectPaused'))
    h.engine.pauseProject(h.target.project.id, false)
    h.engine.stopProject(h.target.project.id)
    expect(() => call(h.target.project.id)).toThrow(new UserError('projectEnded'))
    const archived = h.projectWith('p3')
    h.engine.pauseProject(source.id, true)
    expect(() => call(archived.project.id)).toThrow(new UserError('projectPaused'))
    h.engine.pauseProject(source.id, false)
    h.engine.archiveProject(archived.project.id)
    expect(() => call(archived.project.id)).toThrow(new UserError('projectArchived'))
    // A source Ticket that ended, or a Router-owned one, cannot request.
    const liveTarget = h.projectWith('p4').project
    h.engine.stopTicket(ticketId)
    expect(() => call(liveTarget.id)).toThrow(new UserError('ticketEnded'))
    h.engine.recordTriggerForRouting(trigger('p9'))
    const normal = h.engine.decide('p9', { kind: 'accept', title: 'Normal', scope: 'normal', reason: 'requested', acknowledgement: 'ok',
      name: 'normal-work' })
    expect(() => h.engine.requestProjectHandoff(source.id, source.pmSessionId, normal.ticketId!, { ...request,
      targetProjectId: liveTarget.id })).toThrow(new UserError('notProjectTicket'))
  })

  it('lets the target PM reject without changing the source Ticket', async () => {
    const h = twoProjects()
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, h.source.tickets[0]!.id,
      { ...request, targetProjectId: h.target.project.id })
    const result = await h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'reject', reason: 'Not our Project' })
    expect(result.handoff).toMatchObject({ status: 'rejected', decisionReason: 'Not our Project' })
    expect(result.ticket).toBeUndefined()
    const source = h.repo.tickets.get(h.source.tickets[0]!.id)!
    expect(source.ended).toBeUndefined()
    expect(source.handoffs![0]).toMatchObject({ status: 'rejected', decisionReason: 'Not our Project' })
    expect(assignmentOf(h.repo, h.source.tickets[0]!)).toMatchObject({ state: 'running' })
    expect(h.stops).toEqual([])
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).rejects.toThrow(new UserError('handoffHandled'))
  })

  it('refuses a target accept after the source Project pauses or its Worker gets a manual stop', async () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    h.engine.pauseProject(h.source.project.id, true)
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).rejects.toThrow(new UserError('projectPaused'))
    h.engine.pauseProject(h.source.project.id, false)
    h.engine.stopAssignment(sourceTicket.id, sourceTicket.assignments[0]!.id)
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).rejects.toThrow(new UserError('manualStopNeedsUserApproval'))
  })

  it('accepts into a new independent Ticket, links both records, and ends the source as handedOff', async () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const sourceBefore = h.repo.tickets.get(sourceTicket.id)!
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    const result = await h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id, { action: 'accept' })
    expect(result.ticket).toBeDefined()
    const target = h.repo.tickets.get(result.ticket!.id)!
    expect(target.id).not.toBe(sourceTicket.id)
    expect(target.projectId).toBe(h.target.project.id)
    expect(target.mandate.basis).toMatchObject({ via: 'delegated', projectId: h.target.project.id })
    expect(target.title).toBe('Footer')
    expect(target.ended).toBeUndefined()
    expect(target.assignments).toHaveLength(1)
    expect(assignmentOf(h.repo, target)).toMatchObject({ state: 'pending', sessionId: workerSessionId(target.id) })
    expect(target.execution?.directory).not.toBe(sourceBefore.execution?.directory)
    expect(target).not.toHaveProperty('parentId')
    expect(target.handoffs).toHaveLength(1)
    expect(target.handoffs![0]).toMatchObject({ id: handoff.id, status: 'accepted', kind: 'split',
      from: { ticketId: sourceTicket.id, projectId: h.source.project.id }, to: { ticketId: target.id, projectId: h.target.project.id,
        sessionId: workerSessionId(target.id) }, approvedBy: { kind: 'pm', sessionId: h.target.project.pmSessionId } })
    // The briefing on the new Ticket carries the summary and unfinished items, not the worktree.
    expect((target.inputs.at(-1) as { text: string }).text).toContain('footer link check')
    expect((target.inputs.at(-1) as { text: string }).text).toContain('own Mandate and worktree')
    // The source Ticket ended handedOff, its Assignment stopped, and the record is on both sides.
    const sourceAfter = h.repo.tickets.get(sourceTicket.id)!
    expect(sourceAfter).toMatchObject({ ended: { by: 'executor', outcome: 'handedOff' } })
    expect(sourceAfter.assignments.at(-1)).toMatchObject({ state: 'ended', endedReason: 'handedOff' })
    expect(sourceAfter.handoffs![0]).toMatchObject({ id: handoff.id, status: 'accepted', to: { ticketId: target.id } })
    expect(h.stops).toEqual([{ ticketId: sourceTicket.id, assignmentId: sourceTicket.assignments[0]!.id, reason: 'handedOff' }])
    expect(sourceAfter.execution).toEqual(sourceBefore.execution)
    expect(h.events.filter(event => event.type === 'ticket.handedOff').map(event => event.data))
      .toEqual([{ ticketId: sourceTicket.id, handoffId: handoff.id, kind: 'split', toTicketId: target.id,
        toSessionId: workerSessionId(target.id) }])
    // Accepting again returns the same target Ticket and creates no second one.
    const again = await h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id, { action: 'accept' })
    expect(again.ticket?.id).toBe(target.id)
    expect(h.repo.tickets.list().filter(ticket => ticket.projectId === h.target.project.id)).toHaveLength(2)
  })

  it('refuses a decision from another PM, for a request addressed elsewhere, or after the source ended', async () => {
    const h = twoProjects()
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, h.source.tickets[0]!.id,
      { ...request, targetProjectId: h.target.project.id })
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.source.project.pmSessionId, handoff.id,
      { action: 'accept' })).rejects.toThrow(new UserError('notProjectPm'))
    const third = h.projectWith('p3')
    await expect(h.engine.decideProjectHandoff(third.project.id, third.project.pmSessionId, handoff.id,
      { action: 'accept' })).rejects.toThrow(new UserError('notProjectTicket'))
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, 'missing',
      { action: 'accept' })).rejects.toThrow(new UserError('unknownHandoff'))
    h.engine.pauseProject(h.target.project.id, true)
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).rejects.toThrow(new UserError('projectPaused'))
    h.engine.pauseProject(h.target.project.id, false)
    h.engine.stopTicket(h.source.tickets[0]!.id)
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).rejects.toThrow(new UserError('ticketEnded'))
  })
})

describe('handoff read views through the Store views', () => {
  it('shows handoffs on the source Ticket and the pending request on the target Project', () => {
    const h = harness()
    const source = h.projectWith('p1'), target = h.projectWith('p2')
    h.engine.assignmentStarted(source.tickets[0]!.id, source.tickets[0]!.assignments[0]!.id)
    const handoff = h.engine.requestProjectHandoff(source.project.id, source.project.pmSessionId, source.tickets[0]!.id,
      { targetProjectId: target.project.id, title: 'Footer', goal: 'Fix the footer', reason: 'Belongs to p2', summary: 'Summary text' })
    const store = { settings: () => SettingsSchema.parse({}), read: { subscribedThreads: () => [], firstTrigger: () => undefined },
      tickets: h.repo.tickets, threads: h.repo.threads, projects: h.repo.projects, triggers: h.repo.triggers, decisions: h.repo.decisions } as unknown as Store
    const host = { store, sources: { kind: () => undefined }, links: () => ({ url: '', label: { zh: '', en: '' } }) }
    expect(ticketDetail(host as never, source.tickets[0]!.id)!.handoffs).toEqual([handoff])
    const targetView = projectDetail(store, target.project.id)!
    expect(targetView.handoffRequests).toEqual([expect.objectContaining({ handoff_id: handoff.id, ticket_id: source.tickets[0]!.id,
      title: source.tickets[0]!.title, summary: 'Summary text' })])
    // A same-Project split is pending only while its source cleanup runs; it is not a request the Project's PM decides.
    const stored = h.repo.tickets.get(source.tickets[0]!.id)!
    stored.handoffs = [...stored.handoffs ?? [], { ...handoff, id: 'same-project-pending', status: 'pending' as const,
      to: { projectId: source.project.id } }]
    h.repo.tickets.save(stored)
    expect(projectDetail(store, source.project.id)!.handoffRequests ?? []).toEqual([])
  })
})

describe('handoff through the runtime', () => {
  it('moves a child Ticket to worker-h1, routes its reports, and stops the old Session', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('81', 'Start a project for handoff')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Handoff project', goal: 'Hand work to a new Worker' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }] }) as { tickets: { ticket_id: string }[] }
      const ticket = host.runtime.store.tickets.get(result.tickets[0]!.ticket_id)!
      const base = workerSessionId(ticket.id)
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.state).toBe('running'))
      const oldCancel = host.agents.get(base)!.cancel
      const handoff = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_handoff', { ticket_id: ticket.id,
        reason: 'The Worker is stuck', summary: 'Header is done; the footer remains.', unfinished: ['Fix the footer'] }) as
        { handoff_id: string; session_id: string; ticket: { ticket_id: string; state: string } }
      expect(handoff).toMatchObject({ session_id: `${base}-h1`, ticket: { ticket_id: ticket.id } })
      expect(host.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)?.sessionId).toBe(`${base}-h1`)
      await vi.waitFor(() => expect(host.tools.get(`${base}-h1`)).toBeDefined())
      await vi.waitFor(() => expect(oldCancel).toHaveBeenCalled())
      // The new Session can report and the report reaches the PM, as any child report does.
      await host.runTool(`${base}-h1`, 'orchestrator_report', { state: 'blocked', summary: 'The footer needs a decision.' })
      await vi.waitFor(() => expect(host.deliveries.mock.calls.some(([call]) => call.sessionId === project.pmSessionId
        && call.text.includes(ticket.id) && call.text.includes('The footer needs a decision.'))).toBe(true))
      // The Ticket page links both Assignments to their own Sessions and lists the handoff.
      const page = (await host.api('GET', `tickets/${ticket.id}`)).body as { sessionId: string;
        assignments: { state: string; ref?: string; endedReason?: string }[]; handoffs: { handoff_id?: string; id: string; kind: string }[] }
      expect(page.sessionId).toBe(`${base}-h1`)
      expect(page.assignments.map(assignment => assignment.ref)).toEqual([base, `${base}-h1`])
      expect(page.assignments[0]).toMatchObject({ endedReason: 'handedOff' })
      expect(page.handoffs).toEqual([expect.objectContaining({ id: handoff.handoff_id, kind: 'transfer' })])
      // Only the PM has the handoff tools; the Worker and the Router do not.
      expect([...host.tools.get(`${base}-h1`)!.keys()].some(name => name.startsWith('orchestrator_project_ticket_handoff'))).toBe(false)
      expect([...host.tools.get(host.runtime.masterId)!.keys()].some(name => name.startsWith('orchestrator_project_ticket_handoff'))).toBe(false)
      expect([...host.tools.get(project.pmSessionId)!.keys()].sort()).toEqual([...PM_TOOLS].sort())
      // Archiving the Project reaches the old and the new Worker Session.
      await host.api('POST', `projects/${project.id}/archive`)
      const archived = host.workspace.archiveSession.mock.calls.map(([sessionId]) => sessionId)
      expect(archived).toEqual(expect.arrayContaining([project.pmSessionId, base, `${base}-h1`]))
    } finally { await host.stop() }
  })

  it('accepts a cross-Project request through the two PMs and keeps the target Ticket independent', async () => {
    const host = await startRuntime()
    try {
      const createProject = async (id: string, title: string) => {
        const request = feishu(id, `Start ${title}`)
        host.runtime.receive(request)
        await host.runtime.idle()
        const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
          { trigger_id: request.id, title, goal: `Goal of ${title}` }) as { project: { project_id: string } }
        return host.runtime.store.projects.get(created.project.project_id)!
      }
      const source = await createProject('82', 'Source project')
      const target = await createProject('83', 'Target project')
      const sourceTicket = (await host.runTool(source.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Footer', goal: 'Fix the footer', worktree_name: 'fix-footer' }] }) as { tickets: { ticket_id: string }[] }).tickets[0]!
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(sourceTicket.ticket_id)?.assignments.at(-1)?.state).toBe('running'))
      const request = await host.runTool(source.pmSessionId, 'orchestrator_project_ticket_handoff_to_project', {
        ticket_id: sourceTicket.ticket_id, target_project_id: target.id, title: 'Footer follow-up', goal: 'Finish the footer',
        reason: 'It belongs to the target project', summary: 'The footer links need checking.', unfinished: ['Check the links'] }) as
        { handoff_id: string; status: string; target_project: string }
      expect(request).toMatchObject({ status: 'pending', target_project: target.id })
      const targetPage = (await host.api('GET', `projects/${target.id}`)).body as { handoffRequests?: { handoff_id: string }[] }
      expect(targetPage.handoffRequests).toEqual([expect.objectContaining({ handoff_id: request.handoff_id })])
      const decided = await host.runTool(target.pmSessionId, 'orchestrator_project_ticket_handoff_decide',
        { handoff_id: request.handoff_id, action: 'accept' }) as { ticket: { ticket_id: string; project_id: string } }
      expect(decided.ticket.project_id).toBe(target.id)
      expect(decided.ticket.ticket_id).not.toBe(sourceTicket.ticket_id)
      expect(host.runtime.store.tickets.get(sourceTicket.ticket_id)).toMatchObject({ ended: { outcome: 'handedOff' } })
      const targetTicket = host.runtime.store.tickets.get(decided.ticket.ticket_id)!
      expect(targetTicket).toMatchObject({ projectId: target.id })
      expect(targetTicket.mandate.basis).toMatchObject({ via: 'delegated', projectId: target.id })
      expect(targetTicket).not.toHaveProperty('parentId')
      await vi.waitFor(() => expect(host.tools.get(workerSessionId(targetTicket.id))).toBeDefined())
    } finally { await host.stop() }
  })
})
