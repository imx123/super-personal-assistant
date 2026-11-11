/**
 * P3 audit reproductions: a native DSH Stop is a hard stop, a plugin cancel is not; a failed background cleanup is not
 * reported as a stopped Worker and never starts a replacement; a Handoff is bound to its source Assignment; a decided
 * Handoff answers only its own action.
 */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, assignmentSessionId, latestAssignment, workerSessionId, type Assessor,
  type Candidate, type DomainEvent, type Executor, type Policy, type ProjectProfile, type Ticket, type Trigger } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const cleanup = vi.hoisted(() => ({ fail: false, error: 'cleanup denied' }))
vi.mock('../src/executor/background.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/executor/background.ts')>()
  return { ...actual, stopBackground: (ctx: Parameters<typeof actual.stopBackground>[0], sessionId: string, reason: string,
    keepInbox = false) => cleanup.fail ? Promise.reject(new Error(cleanup.error))
    : actual.stopBackground(ctx, sessionId, reason, keepInbox) }
})

const actor = { source: 'main-session', id: 'dsh-user' }
function trigger(id: string): Trigger {
  return { id, source: 'main-session', threads: [{ source: 'main-session', id }], actor, human: true, addressed: 'direct',
    at: '2026-11-10T00:00:00.000Z', text: `Create a project ${id}`, meta: {} }
}
function harness() {
  const repo = new MemoryRepositories()
  const events: DomainEvent[] = []
  const assessor: Assessor = { request: vi.fn((_candidate: Candidate) => {}), release: vi.fn() }
  const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
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
    return { project, tickets }
  }
  return { repo, engine, events, executor, projectWith }
}
/** Two Projects with one running source Ticket each, for cross-Project handoff tests. */
function twoProjects() {
  const h = harness()
  const source = h.projectWith('p1')
  const target = h.projectWith('p2')
  h.engine.assignmentStarted(source.tickets[0]!.id, source.tickets[0]!.assignments[0]!.id)
  return { ...h, source, target }
}
const request = { targetProjectId: '', title: 'Footer', goal: 'Fix the footer', reason: 'Belongs to the target',
  summary: 'Header done; footer remains.', unfinished: ['Check the footer'] }

async function createProject(host: Host, id: string, title: string, tasks: { title: string; goal: string; worktree_name: string }[]) {
  const incoming = feishu(id, `Start ${title}`)
  host.runtime.receive(incoming)
  await host.runtime.idle()
  const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
    { trigger_id: incoming.id, title, goal: `Goal of ${title}` }) as { project: { project_id: string } }
  const project = host.runtime.store.projects.get(created.project.project_id)!
  const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks }) as
    { tickets: { ticket_id: string }[] }
  return { project, tickets: result.tickets.map(card => host.runtime.store.tickets.get(card.ticket_id)!) }
}
/** Report the fake Session's latest turn as a person's native DSH Stop, then make it idle. */
function nativeStop(host: Host, sessionId: string): void {
  const agent = host.agents.get(sessionId)!
  ;(agent as unknown as { session: { snapshotEvents: () => unknown[] } }).session.snapshotEvents = () => [{
    type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }]
  agent.status = 'idle'
  host.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}
const execution = (host: Host, sessionId: string, ticketId: string) => host.deliveries.mock.calls.map(([call]) => call)
  .filter(call => call.sessionId === sessionId && call.text.includes('"kind":"execution_status"') && call.text.includes(ticketId))
  .map(call => JSON.parse(call.text) as Record<string, unknown>)

describe('a native DSH Stop is a hard stop', () => {
  it('ends the Assignment, writes the worker label and sends the PM execution receipt', async () => {
    const host = await startRuntime()
    try {
      const { project, tickets: [ticket] } = await createProject(host, '91', 'Native stop', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running'))
      const base = workerSessionId(ticket!.id)
      const stop = vi.spyOn(host.runtime.engine, 'stopAssignment')
      nativeStop(host, base)
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)!.manualStop).toMatchObject({ scope: 'worker' }))
      expect(host.runtime.store.tickets.get(ticket!.id)!.assignments.at(-1)).toMatchObject({ state: 'ended',
        endedReason: 'stoppedByOperator' })
      expect(stop).toHaveBeenCalledWith(ticket!.id, ticket!.assignments[0]!.id)
      await vi.waitFor(() => expect(execution(host, project.pmSessionId, ticket!.id)).toHaveLength(1))
      expect(execution(host, project.pmSessionId, ticket!.id)[0]).toMatchObject({ action: 'stop_assignment',
        manual_stop: { scope: 'worker' }, needs_user_approval: true, assignment_state: 'ended' })
      expect(host.deliveries.mock.calls.some(([call]) => call.text.includes('projectPausedByUser'))).toBe(false)
    } finally { await host.stop() }
  })

  it('does not mistake a cancel this plugin issued for a native Stop', async () => {
    const host = await startRuntime()
    try {
      const { tickets: [ticket] } = await createProject(host, '92', 'Plugin cancel', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running'))
      const base = workerSessionId(ticket!.id)
      const stopAssignment = vi.spyOn(host.runtime.engine, 'stopAssignment')
      const stored = host.runtime.store.tickets.get(ticket!.id)!
      const stopping = host.runtime.executor.stop(stored, stored.assignments.at(-1)!, 'handedOff')
      nativeStop(host, base)
      await stopping
      await vi.waitFor(() => expect(stopAssignment).not.toHaveBeenCalled())
      // No second stop, no worker label, no receipt: the domain still owns this artificial Assignment.
      expect(host.runtime.store.tickets.get(ticket!.id)!.manualStop).toBeUndefined()
      expect(host.runtime.store.tickets.get(ticket!.id)!.assignments.at(-1)!.state).toBe('running')
      expect(host.deliveries.mock.calls.some(([call]) => call.text.includes('"kind":"execution_status"'))).toBe(false)
    } finally { await host.stop() }
  })

  it('leaves an old handoff Session turn end alone', async () => {
    const host = await startRuntime()
    try {
      const { project, tickets: [ticket] } = await createProject(host, '93', 'Handoff old turn', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running'))
      await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_handoff', { ticket_id: ticket!.id,
        reason: 'Stuck', summary: 'Continue', unfinished: [] })
      const base = workerSessionId(ticket!.id)
      const stopAssignment = vi.spyOn(host.runtime.engine, 'stopAssignment')
      nativeStop(host, base)
      await vi.waitFor(() => expect(host.tools.get(`${base}-h1`)).toBeDefined())
      expect(stopAssignment).not.toHaveBeenCalled()
      expect(host.runtime.store.tickets.get(ticket!.id)!.manualStop).toBeUndefined()
      expect(host.runtime.store.tickets.get(ticket!.id)!.assignments.at(-1)?.sessionId).toBe(`${base}-h1`)
    } finally { await host.stop() }
  })
})

describe('background cleanup failures are not reported as stopped', () => {
  it('puts a cleanup failure in the Project hard-pause API result and Router notice, not in stopped', async () => {
    cleanup.fail = false
    const host = await startRuntime()
    try {
      const { project, tickets: [ticket] } = await createProject(host, '94', 'Cleanup pause', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running'))
      cleanup.fail = true
      const paused = (await host.api('POST', `projects/${project.id}/pause`, { paused: true, mode: 'hard' })).body as
        { paused: boolean; workers: { stopped: string[]; failures: { ticketId: string; error: string }[] } }
      expect(paused.paused).toBe(true)
      expect(paused.workers.stopped).toEqual([])
      expect(paused.workers.failures).toEqual([{ ticketId: ticket!.id, error: 'cleanup denied' }])
      const notice = () => host.relays(host.runtime.masterId).filter(item => item.kind === 'projectPausedByUser')
      await vi.waitFor(() => expect(notice()).toHaveLength(1))
      expect(notice()[0]!.failures).toEqual([{ ticketId: ticket!.id, error: 'cleanup denied' }])
      expect(notice()[0]!.stopped_tickets).toEqual([])
      // The domain stop happened, but the report says its cleanup failed.
      expect(host.runtime.store.tickets.get(ticket!.id)!.manualStop).toMatchObject({ scope: 'project' })
    } finally { cleanup.fail = false; await host.stop() }
  })

  it('starts no replacement Worker when a handoff cannot clean up, and keeps the old job', async () => {
    cleanup.fail = false
    const host = await startRuntime()
    try {
      const { project, tickets: [ticket] } = await createProject(host, '95', 'Cleanup transfer', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running'))
      const base = workerSessionId(ticket!.id)
      host.jobs.run(base, 'a long build')
      cleanup.fail = true
      await expect(host.runTool(project.pmSessionId, 'orchestrator_project_ticket_handoff', { ticket_id: ticket!.id,
        reason: 'Stuck', summary: 'Continue' })).rejects.toThrow(/background work could not be stopped|cleanup denied/i)
      const stored = host.runtime.store.tickets.get(ticket!.id)!
      expect(stored.ended).toBeUndefined()
      expect(stored.delivery?.error).toContain('cleanup denied')
      expect(stored.assignments.at(-1)).toMatchObject({ state: 'ended', endedReason: 'handoffCleanupFailed' })
      expect(host.agents.has(`${base}-h1`)).toBe(false)
      expect(host.tools.get(`${base}-h1`)).toBeUndefined()
      expect(host.jobs.service.list(base).find(job => job.status === 'running')).toBeDefined()
    } finally { cleanup.fail = false; await host.stop() }
  })
})

describe('a Handoff is bound to its source Assignment', () => {
  it('refuses an old request after user approval and PM revive created a new Assignment', async () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    h.engine.stopAssignment(sourceTicket.id, sourceTicket.assignments[0]!.id)
    h.engine.allowResume(sourceTicket.id)
    h.engine.reviveProjectTicket(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id)
    const revived = latestAssignment(h.repo.tickets.get(sourceTicket.id)!)!
    expect(revived.id).not.toBe(sourceTicket.assignments[0]!.id)
    expect(assignmentSessionId(sourceTicket.id, revived)).toBe(handoff.from.sessionId)
    expect(() => h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).toThrow(new UserError('notHandoffable'))
  })

  it('makes a fresh request after a transfer to worker-h1, not reusing the old id', async () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const first = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    await h.engine.transferTicket(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { reason: 'Hand to h1', summary: 'Moved to a new Worker' })
    const latest = latestAssignment(h.repo.tickets.get(sourceTicket.id)!)!
    const second = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    expect(second.id).not.toBe(first.id)
    expect(second.from.assignmentId).toBe(latest.id)
    expect(second.from.sessionId).toBe(latest.sessionId)
    expect(second.from.sessionId).toBe(`${workerSessionId(sourceTicket.id)}-h1`)
  })

  it('accepts a pre-P3 Assignment with no sessionId by deriving its base Session', () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const stored = h.repo.tickets.get(sourceTicket.id)!
    delete stored.assignments[0]!.sessionId
    h.repo.tickets.save(stored)
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    expect(handoff.from.assignmentId).toBe(sourceTicket.assignments[0]!.id)
    expect(handoff.from.sessionId).toBe(workerSessionId(sourceTicket.id))
    expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id, { action: 'accept' }).ticket)
      .toBeDefined()
  })

  it('refuses a legacy record without assignmentId rather than binding it to a newer Assignment', () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    const stored = h.repo.tickets.get(sourceTicket.id)!
    stored.handoffs = [{ ...stored.handoffs![0]!, from: { ticketId: sourceTicket.id, projectId: h.source.project.id } }]
    h.repo.tickets.save(stored)
    expect(() => h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).toThrow(new UserError('notHandoffable'))
    // A fresh request under the current Assignment upgrades the malformed record and is accepted.
    const fresh = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    expect(fresh.from.assignmentId).toBe(sourceTicket.assignments[0]!.id)
    expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, fresh.id,
      { action: 'accept' }).ticket).toBeDefined()
  })
})

describe('a decided Handoff answers only its own action', () => {
  it('rejects contradicting decisions and is idempotent for the same one', () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const accepted = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    const result = h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, accepted.id, { action: 'accept' })
    expect(result.handoff.status).toBe('accepted')
    expect(() => h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, accepted.id,
      { action: 'reject' })).toThrow(new UserError('handoffHandled'))
    expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, accepted.id,
      { action: 'accept' }).ticket?.id).toBe(result.ticket!.id)

    const second = twoProjects()
    const ticket = second.source.tickets[0]!
    const rejected = second.engine.requestProjectHandoff(second.source.project.id, second.source.project.pmSessionId, ticket.id,
      { ...request, targetProjectId: second.target.project.id })
    second.engine.decideProjectHandoff(second.target.project.id, second.target.project.pmSessionId, rejected.id,
      { action: 'reject', reason: 'No' })
    expect(() => second.engine.decideProjectHandoff(second.target.project.id, second.target.project.pmSessionId, rejected.id,
      { action: 'accept' })).toThrow(new UserError('handoffHandled'))
    expect(second.engine.decideProjectHandoff(second.target.project.id, second.target.project.pmSessionId, rejected.id,
      { action: 'reject' }).handoff.status).toBe('rejected')
  })
})

describe('a PM handoff receipt uses the recorded decision', () => {
  it('sends no contradictory receipt when an accepted request is rejected again', async () => {
    const host = await startRuntime()
    try {
      const source = await createProject(host, '96', 'Receipt source', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      const target = await createProject(host, '97', 'Receipt target', [{
        title: 'Footer', goal: 'Fix the footer', worktree_name: 'fix-footer' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(source.tickets[0]!.id)?.assignments.at(-1)?.state).toBe('running'))
      const requested = await host.runTool(source.project.pmSessionId, 'orchestrator_project_ticket_handoff_to_project', {
        ticket_id: source.tickets[0]!.id, target_project_id: target.project.id, title: 'Footer', goal: 'Finish it',
        reason: 'Belongs there', summary: 'Summary' }) as { handoff_id: string }
      const accepted = await host.runTool(target.project.pmSessionId, 'orchestrator_project_ticket_handoff_decide',
        { handoff_id: requested.handoff_id, action: 'accept' }) as { handoff: { status: string } }
      expect(accepted.handoff.status).toBe('accepted')
      await vi.waitFor(() => expect(host.relays(source.project.pmSessionId)
        .filter(item => item.kind === 'handoff_decision' && item.handoff_id === requested.handoff_id)).toHaveLength(1))
      const receipts = () => host.relays(source.project.pmSessionId)
        .filter(item => item.kind === 'handoff_decision' && item.handoff_id === requested.handoff_id)
      expect(receipts()[0]).toMatchObject({ action: 'accepted' })
      // Repeating accept keeps the record and its receipt; a later reject is refused and sends nothing.
      await host.runTool(target.project.pmSessionId, 'orchestrator_project_ticket_handoff_decide',
        { handoff_id: requested.handoff_id, action: 'accept' })
      await expect(host.runTool(target.project.pmSessionId, 'orchestrator_project_ticket_handoff_decide',
        { handoff_id: requested.handoff_id, action: 'reject' })).rejects.toThrow(/already decided/i)
      expect(receipts()).toHaveLength(1)
      expect(receipts().some(item => item.action === 'rejected')).toBe(false)
    } finally { await host.stop() }
  })

  it('sends no accepted receipt when a rejected request is accepted again', async () => {
    const host = await startRuntime()
    try {
      const source = await createProject(host, '98', 'Reject source', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      const target = await createProject(host, '99', 'Reject target', [{
        title: 'Footer', goal: 'Fix the footer', worktree_name: 'fix-footer' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(source.tickets[0]!.id)?.assignments.at(-1)?.state).toBe('running'))
      const requested = await host.runTool(source.project.pmSessionId, 'orchestrator_project_ticket_handoff_to_project', {
        ticket_id: source.tickets[0]!.id, target_project_id: target.project.id, title: 'Footer', goal: 'Finish it',
        reason: 'Belongs there', summary: 'Summary' }) as { handoff_id: string }
      await host.runTool(target.project.pmSessionId, 'orchestrator_project_ticket_handoff_decide',
        { handoff_id: requested.handoff_id, action: 'reject', reason: 'No capacity' })
      await vi.waitFor(() => expect(host.relays(source.project.pmSessionId)
        .filter(item => item.kind === 'handoff_decision' && item.handoff_id === requested.handoff_id)).toHaveLength(1))
      const receipts = () => host.relays(source.project.pmSessionId)
        .filter(item => item.kind === 'handoff_decision' && item.handoff_id === requested.handoff_id)
      expect(receipts()[0]).toMatchObject({ action: 'rejected' })
      await expect(host.runTool(target.project.pmSessionId, 'orchestrator_project_ticket_handoff_decide',
        { handoff_id: requested.handoff_id, action: 'accept' })).rejects.toThrow(/already decided/i)
      expect(receipts()).toHaveLength(1)
      expect(receipts().some(item => item.action === 'accepted')).toBe(false)
      // Repeating the reject is idempotent.
      await host.runTool(target.project.pmSessionId, 'orchestrator_project_ticket_handoff_decide',
        { handoff_id: requested.handoff_id, action: 'reject', reason: 'No capacity' })
      expect(receipts()).toHaveLength(1)
    } finally { await host.stop() }
  })
})

describe('a same-Project split ends the source Ticket', () => {
  it('creates an independent Ticket in the Project and ends the source as handedOff, without a parent', () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    const before = h.repo.tickets.get(ticket!.id)!
    const result = h.engine.splitTicket(project.id, project.pmSessionId, ticket!.id, { title: 'Footer follow-up',
      goal: 'Finish the footer', reason: 'Beyond the header Ticket', summary: 'The footer remains', unfinished: ['Check links'],
      worktree_name: 'fix-footer' })
    const target = h.repo.tickets.get(result.ticket!.id)!
    expect(target.id).not.toBe(ticket!.id)
    expect(target.projectId).toBe(project.id)
    expect(target.mandate.basis).toMatchObject({ via: 'delegated', projectId: project.id })
    expect(target.execution?.directory).not.toBe(before.execution?.directory)
    expect(target).not.toHaveProperty('parentId')
    expect(h.repo.tickets.get(ticket!.id)).toMatchObject({ ended: { by: 'executor', outcome: 'handedOff' } })
    expect(h.repo.tickets.get(ticket!.id)!.assignments.at(-1)).toMatchObject({ state: 'ended', endedReason: 'handedOff' })
    expect(result.handoff).toMatchObject({ kind: 'split', status: 'accepted',
      from: { ticketId: ticket!.id, assignmentId: before.assignments[0]!.id }, to: { ticketId: target.id } })
    expect(target.handoffs).toEqual([result.handoff])
  })

  it('is reachable through the PM tool and stays inside its Project', async () => {
    const host = await startRuntime()
    try {
      const { project, tickets: [ticket] } = await createProject(host, '90', 'Split tool', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running'))
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_handoff_new_ticket', {
        ticket_id: ticket!.id, title: 'Footer', goal: 'Finish the footer', worktree_name: 'fix-footer',
        reason: 'Beyond the header', summary: 'Footer remains', unfinished: ['Check links'] }) as
        { ticket: { ticket_id: string; project_id: string }; source_ticket_id: string }
      expect(result.ticket.project_id).toBe(project.id)
      expect(result.ticket.ticket_id).not.toBe(ticket!.id)
      expect(host.runtime.store.tickets.get(ticket!.id)).toMatchObject({ ended: { outcome: 'handedOff' } })
      await vi.waitFor(() => expect(host.tools.get(workerSessionId(result.ticket.ticket_id))).toBeDefined())
    } finally { await host.stop() }
  })
})
