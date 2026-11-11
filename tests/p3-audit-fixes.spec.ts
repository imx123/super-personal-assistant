/**
 * P3 audit reproductions: a native DSH Stop is a hard stop, a plugin cancel is not; a failed background cleanup is not
 * reported as a stopped Worker and never starts a replacement; a Handoff is bound to its source Assignment; a decided
 * Handoff answers only its own action.
 */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, assignmentSessionId, latestAssignment, workerSessionId, type Assessor,
  type Candidate, type DomainEvent, type Executor, type Policy, type ProjectProfile, type Repositories, type Ticket,
  type Trigger } from '../src/core/index.ts'
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
/** An Engine on `repo`, for tests that reopen a Runtime's SQLite store or need to inspect its parts. */
function engineOn(repo: Repositories) {
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
  return { repo, engine, events, executor }
}
function harness() {
  const { repo, engine, events, executor } = engineOn(new MemoryRepositories())
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
/** Replace the fake Session's event snapshot, as DSH's own history reads. */
function setSessionEvents(host: Host, sessionId: string, events: unknown[]): void {
  const agent = host.agents.get(sessionId)!
  ;(agent as unknown as { session: { snapshotEvents: () => unknown[] } }).session.snapshotEvents = () => events
}
/** Report the fake Session's latest turn as a person's native DSH Stop, then make it idle. */
function nativeStop(host: Host, sessionId: string, turn?: number): void {
  const agent = host.agents.get(sessionId)!
  const data: Record<string, unknown> = { reason: { kind: 'aborted', reason: { kind: 'user' } } }
  if (turn !== undefined) data.turn = turn
  setSessionEvents(host, sessionId, [{ type: 'turn/end', time: Date.now(), data }])
  agent.status = 'idle'
  host.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}
/** A cleanup promise the test releases or rejects by hand, so the interleaving is deterministic, not timing-based. */
function cleanupGate() {
  let release!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((resolve, fail) => { release = resolve; reject = fail })
  // A rejection awaits a caller; keep an early one from surfacing as an unhandled rejection.
  promise.catch(() => {})
  return { promise, release, reject }
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
      // The turn record of the earlier interrupt-only path is preserved: the native Stop still says when the turn ended
      // and that it was interrupted in the UI, even though the Assignment now ends as a hard stop.
      expect(host.runtime.store.tickets.get(ticket!.id)!.assignments.at(-1)).toMatchObject({
        idleAt: expect.any(String), interruptedAt: expect.any(String) })
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
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).rejects.toThrow(new UserError('notHandoffable'))
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

  it('accepts a pre-P3 Assignment with no sessionId by deriving its base Session', async () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const stored = h.repo.tickets.get(sourceTicket.id)!
    delete stored.assignments[0]!.sessionId
    h.repo.tickets.save(stored)
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    expect(handoff.from.assignmentId).toBe(sourceTicket.assignments[0]!.id)
    expect(handoff.from.sessionId).toBe(workerSessionId(sourceTicket.id))
    expect((await h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).ticket).toBeDefined()
  })

  it('refuses a legacy record without assignmentId rather than binding it to a newer Assignment', async () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    const stored = h.repo.tickets.get(sourceTicket.id)!
    stored.handoffs = [{ ...stored.handoffs![0]!, from: { ticketId: sourceTicket.id, projectId: h.source.project.id } }]
    h.repo.tickets.save(stored)
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).rejects.toThrow(new UserError('notHandoffable'))
    // A fresh request under the current Assignment upgrades the malformed record and is accepted.
    const fresh = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    expect(fresh.from.assignmentId).toBe(sourceTicket.assignments[0]!.id)
    expect((await h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, fresh.id,
      { action: 'accept' })).ticket).toBeDefined()
  })
})

describe('a decided Handoff answers only its own action', () => {
  it('rejects contradicting decisions and is idempotent for the same one', async () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const accepted = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    const result = await h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, accepted.id, { action: 'accept' })
    expect(result.handoff.status).toBe('accepted')
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, accepted.id,
      { action: 'reject' })).rejects.toThrow(new UserError('handoffHandled'))
    expect((await h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, accepted.id,
      { action: 'accept' })).ticket?.id).toBe(result.ticket!.id)

    const second = twoProjects()
    const ticket = second.source.tickets[0]!
    const rejected = second.engine.requestProjectHandoff(second.source.project.id, second.source.project.pmSessionId, ticket.id,
      { ...request, targetProjectId: second.target.project.id })
    await second.engine.decideProjectHandoff(second.target.project.id, second.target.project.pmSessionId, rejected.id,
      { action: 'reject', reason: 'No' })
    await expect(second.engine.decideProjectHandoff(second.target.project.id, second.target.project.pmSessionId, rejected.id,
      { action: 'accept' })).rejects.toThrow(new UserError('handoffHandled'))
    expect((await second.engine.decideProjectHandoff(second.target.project.id, second.target.project.pmSessionId, rejected.id,
      { action: 'reject' })).handoff.status).toBe('rejected')
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
  it('creates an independent Ticket in the Project and ends the source as handedOff, without a parent', async () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    const before = h.repo.tickets.get(ticket!.id)!
    const result = await h.engine.splitTicket(project.id, project.pmSessionId, ticket!.id, { title: 'Footer follow-up',
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

describe('a split or cross-Project accept waits for the source Worker cleanup', () => {
  it('creates no target Ticket and records a failed Handoff when a split cleanup fails', async () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    h.executor.stop = vi.fn(() => Promise.reject(new Error('cleanup denied')))
    await expect(h.engine.splitTicket(project.id, project.pmSessionId, ticket!.id, { title: 'Footer follow-up',
      goal: 'Finish the footer', reason: 'Beyond the header', summary: 'Footer remains', worktree_name: 'fix-footer' }))
      .rejects.toThrow(new UserError('handoffCleanupFailed', { error: 'cleanup denied' }))
    const source = h.repo.tickets.get(ticket!.id)!
    // The source Ticket did not end and no target Ticket exists: nothing claims the split succeeded.
    expect(source.ended).toBeUndefined()
    expect(source.delivery?.error).toContain('cleanup denied')
    expect(source.handoffs).toHaveLength(1)
    expect(source.handoffs![0]).toMatchObject({ kind: 'split', status: 'failed', failure: 'cleanup denied' })
    expect(h.repo.tickets.list().map(item => item.id)).toEqual([ticket!.id])
  })

  it('starts the split target only after the source cleanup succeeds', async () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    const gate = cleanupGate()
    h.executor.stop = vi.fn(() => gate.promise)
    const pending = h.engine.splitTicket(project.id, project.pmSessionId, ticket!.id, { title: 'Footer follow-up',
      goal: 'Finish the footer', reason: 'Beyond the header', summary: 'Footer remains', worktree_name: 'fix-footer' })
    // The source Worker stopped and its Handoff is `starting`; the target Ticket does not exist yet.
    const waiting = h.repo.tickets.get(ticket!.id)!
    expect(waiting.assignments.at(-1)).toMatchObject({ state: 'ended', endedReason: 'handedOff' })
    expect(waiting.handoffs![0]!.status).toBe('starting')
    expect(h.repo.tickets.list()).toHaveLength(1)
    gate.release()
    const result = await pending
    expect(h.repo.tickets.get(ticket!.id)).toMatchObject({ ended: { by: 'executor', outcome: 'handedOff' } })
    expect(result.handoff).toMatchObject({ status: 'accepted', to: { ticketId: result.ticket!.id } })
    expect(h.repo.tickets.list()).toHaveLength(2)
  })

  it('creates no target Ticket and records a failed request when a cross-Project accept cleanup fails', async () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    h.executor.stop = vi.fn(() => Promise.reject(new Error('cleanup denied')))
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })).rejects.toThrow(new UserError('handoffCleanupFailed', { error: 'cleanup denied' }))
    const source = h.repo.tickets.get(sourceTicket.id)!
    expect(source.ended).toBeUndefined()
    expect(source.delivery?.error).toContain('cleanup denied')
    expect(source.handoffs![0]).toMatchObject({ id: handoff.id, status: 'failed', failure: 'cleanup denied' })
    // The target Project kept only its own initial Ticket and never got an accepted Handoff.
    const targetTickets = h.repo.tickets.list().filter(ticket => ticket.projectId === h.target.project.id)
    expect(targetTickets.map(ticket => ticket.id)).toEqual([h.target.tickets[0]!.id])
    expect(targetTickets[0]!.handoffs ?? []).toEqual([])
  })

  it('starts no target Worker until the cross-Project source cleanup succeeds', async () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    const gate = cleanupGate()
    h.executor.stop = vi.fn(() => gate.promise)
    const pending = h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })
    // The source Worker is stopped, but the target Ticket and its Worker wait for the cleanup under a `starting` record.
    expect(h.repo.tickets.get(sourceTicket.id)!.assignments.at(-1)).toMatchObject({ state: 'ended', endedReason: 'handedOff' })
    expect(h.repo.tickets.get(sourceTicket.id)!.handoffs![0]!.status).toBe('starting')
    expect(h.repo.tickets.list().filter(ticket => ticket.projectId === h.target.project.id)).toHaveLength(1)
    gate.release()
    const result = await pending
    expect(h.repo.tickets.get(sourceTicket.id)).toMatchObject({ ended: { outcome: 'handedOff' } })
    expect(result.handoff.status).toBe('accepted')
    expect(h.repo.tickets.list().filter(ticket => ticket.projectId === h.target.project.id)).toHaveLength(2)
  })
})

describe('a transfer rechecks its Handoff and Assignment after the cleanup await', () => {
  it('records a failed Handoff when a concurrent stop ended the replacement Assignment', async () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    const gate = cleanupGate()
    h.executor.stop = vi.fn(() => gate.promise)
    const pending = h.engine.transferTicket(project.id, project.pmSessionId, ticket!.id,
      { reason: 'Stuck', summary: 'Continue on a new Worker' })
    const begun = h.repo.tickets.get(ticket!.id)!
    const handoffId = begun.handoffs![0]!.id
    const replacement = latestAssignment(begun)!
    expect(replacement.state).toBe('pending')
    // Another call stops the just-created pending Assignment while the old Worker's cleanup is still awaited.
    h.engine.stopAssignment(ticket!.id, replacement.id)
    gate.release()
    await expect(pending).rejects.toThrow(new UserError('assignmentEnded'))
    const after = h.repo.tickets.get(ticket!.id)!
    expect(after.ended).toBeUndefined()
    expect(after.handoffs![0]).toMatchObject({ id: handoffId, status: 'failed',
      failure: expect.stringContaining('The handoff could not start its replacement Worker') })
    // The failure is visible even though the Assignment is no longer pending, instead of being silently dropped.
    expect(after.delivery?.error).toContain('The handoff could not start its replacement Worker')
    expect(after.assignments.at(-1)).toMatchObject({ id: replacement.id, state: 'ended', endedReason: 'stoppedByOperator' })
  })

  it('keeps the replacement session slot for a retry after a failed transfer', async () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    h.executor.stop = vi.fn(() => Promise.reject(new Error('cleanup denied')))
    await expect(h.engine.transferTicket(project.id, project.pmSessionId, ticket!.id,
      { reason: 'Stuck', summary: 'Continue' })).rejects.toThrow(new UserError('handoffCleanupFailed', { error: 'cleanup denied' }))
    // The failed transfer consumed h1, so the person's retry uses that fresh Session, not the old Worker's base Session.
    const retried = h.engine.retryTicket(ticket!.id)
    expect(retried.assignments.at(-1)).toMatchObject({ state: 'pending', sessionId: `${workerSessionId(ticket!.id)}-h1` })
  })

  it('records a failed Handoff when a second transfer superseded it during the cleanup', async () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    const first = cleanupGate(), second = cleanupGate()
    const stop = vi.fn()
    stop.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    h.executor.stop = stop
    const pending = h.engine.transferTicket(project.id, project.pmSessionId, ticket!.id, { reason: 'One', summary: 'First' })
    const superseding = h.engine.transferTicket(project.id, project.pmSessionId, ticket!.id, { reason: 'Two', summary: 'Second' })
    const begun = h.repo.tickets.get(ticket!.id)!
    expect(begun.handoffs!.map(handoff => handoff.status)).toEqual(['starting', 'starting'])
    expect(latestAssignment(begun)!.sessionId).toBe(`${workerSessionId(ticket!.id)}-h2`)
    first.release()
    await expect(pending).rejects.toThrow(new UserError('assignmentEnded'))
    const afterFirst = h.repo.tickets.get(ticket!.id)!
    // The superseded attempt is marked failed; the newer transfer's pending state owns the Ticket, so it keeps no error.
    expect(afterFirst.handoffs![0]).toMatchObject({ status: 'failed' })
    expect(afterFirst.delivery).toBeUndefined()
    second.release()
    await superseding
    const after = h.repo.tickets.get(ticket!.id)!
    expect(after.handoffs!.map(handoff => handoff.status)).toEqual(['failed', 'accepted'])
    expect(after.assignments.at(-1)).toMatchObject({ state: 'pending', sessionId: `${workerSessionId(ticket!.id)}-h2` })
    expect(h.executor.start).toHaveBeenCalledWith(expect.objectContaining({ id: ticket!.id }), after.assignments.at(-1))
  })
})

describe('an in-flight handoff refuses a second decision', () => {
  it('refuses a reject while the accept is starting and then completes the accept', async () => {
    const h = twoProjects()
    const sourceTicket = h.source.tickets[0]!
    const handoff = h.engine.requestProjectHandoff(h.source.project.id, h.source.project.pmSessionId, sourceTicket.id,
      { ...request, targetProjectId: h.target.project.id })
    const gate = cleanupGate()
    h.executor.stop = vi.fn(() => gate.promise)
    const accepting = h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'accept' })
    // The request is claimed by the accept, its source Worker already stopped; no target PM decision can race it.
    expect(h.repo.tickets.get(sourceTicket.id)!.handoffs![0]!.status).toBe('starting')
    await expect(h.engine.decideProjectHandoff(h.target.project.id, h.target.project.pmSessionId, handoff.id,
      { action: 'reject', reason: 'Racing reject' })).rejects.toThrow(new UserError('handoffHandled'))
    expect(h.repo.tickets.get(sourceTicket.id)!.handoffs![0]).toMatchObject({ status: 'starting' })
    expect(h.repo.tickets.get(sourceTicket.id)!.ended).toBeUndefined()
    expect(h.repo.tickets.list().filter(ticket => ticket.projectId === h.target.project.id)).toHaveLength(1)
    gate.release()
    const accepted = await accepting
    expect(accepted.handoff.status).toBe('accepted')
    expect(h.repo.tickets.get(sourceTicket.id)).toMatchObject({ ended: { outcome: 'handedOff' } })
    expect(h.repo.tickets.list().filter(ticket => ticket.projectId === h.target.project.id)).toHaveLength(2)
  })

  it('keeps a newer running Assignment of a concurrent retry free of the failed attempt delivery error', async () => {
    const h = harness()
    const { project, tickets: [ticket] } = h.projectWith('p1')
    h.engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
    const gate = cleanupGate()
    h.executor.stop = vi.fn(() => gate.promise)
    const splitting = h.engine.splitTicket(project.id, project.pmSessionId, ticket!.id, { title: 'Footer follow-up',
      goal: 'Finish the footer', reason: 'Beyond the header', summary: 'Footer remains', worktree_name: 'fix-footer' })
    // A retry that already owns the Ticket must keep its own delivery state; the failed attempt only marks its Handoff.
    const stored = h.repo.tickets.get(ticket!.id)!
    const retry = { id: 'assignment-retry', state: 'running' as const, createdAt: '2026-11-10T00:00:01.000Z',
      sessionId: workerSessionId(ticket!.id, 1) }
    stored.assignments.push(retry)
    h.repo.tickets.save(stored)
    gate.reject(new Error('cleanup denied'))
    await expect(splitting).rejects.toThrow(new UserError('handoffCleanupFailed', { error: 'cleanup denied' }))
    const after = h.repo.tickets.get(ticket!.id)!
    expect(after.handoffs![0]).toMatchObject({ kind: 'split', status: 'failed', failure: 'cleanup denied' })
    expect(after.delivery).toBeUndefined()
    expect(after.assignments.at(-1)).toMatchObject({ id: retry.id, state: 'running' })
  })
})

describe('a plugin cancel is scoped to the turn it cancelled', () => {
  it('does not hide a native Stop that follows a stop while the Worker was idle', async () => {
    const host = await startRuntime()
    try {
      const { tickets: [ticket] } = await createProject(host, '101', 'Idle stop', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running'))
      const base = workerSessionId(ticket!.id)
      const agent = host.agents.get(base)!
      // The plugin stops a Worker that is already idle: no turn ends for its cancel, so no marker may cover a later turn.
      agent.status = 'idle'
      const stored = host.runtime.store.tickets.get(ticket!.id)!
      await host.runtime.executor.stop(stored, stored.assignments.at(-1)!, 'handedOff')
      const stop = vi.spyOn(host.runtime.engine, 'stopAssignment')
      nativeStop(host, base, 7)
      await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(ticket!.id, stored.assignments.at(-1)!.id))
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)!.manualStop).toMatchObject({ scope: 'worker' }))
    } finally { await host.stop() }
  })

  it('keeps one plugin cancel expected across repeated idle events for its turn', async () => {
    const host = await startRuntime()
    try {
      const { tickets: [ticket] } = await createProject(host, '102', 'Extra idle', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running'))
      const base = workerSessionId(ticket!.id)
      const stop = vi.spyOn(host.runtime.engine, 'stopAssignment')
      const stored = host.runtime.store.tickets.get(ticket!.id)!
      const stopping = host.runtime.executor.stop(stored, stored.assignments.at(-1)!, 'handedOff')
      nativeStop(host, base)
      await stopping
      // A second idle event for the same cancelled turn must not turn its user abort into a native Stop.
      host.ctx.emit('agent/status', { agent: host.agents.get(base)!, status: 'idle' } as never)
      await vi.waitFor(() => expect(stop).not.toHaveBeenCalled())
      expect(host.runtime.store.tickets.get(ticket!.id)!.manualStop).toBeUndefined()
    } finally { await host.stop() }
  })

  it('recognizes a native Stop on a turn that starts after a plugin cancel', async () => {
    const host = await startRuntime()
    try {
      const { tickets: [ticket] } = await createProject(host, '103', 'New turn stop', [{
        title: 'Header', goal: 'Fix the header', worktree_name: 'fix-header' }])
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state).toBe('running'))
      const base = workerSessionId(ticket!.id)
      const agent = host.agents.get(base)!
      const stored = host.runtime.store.tickets.get(ticket!.id)!
      setSessionEvents(host, base, [{ type: 'turn/start', time: Date.now(), data: { turn: 1 } }])
      // Stop while idle, so the cancel itself ends no turn and only its turn number matters for the marker.
      agent.status = 'idle'
      const stopping = host.runtime.executor.stop(stored, stored.assignments.at(-1)!, 'handedOff')
      await stopping
      // The marked turn is 1; a newer turn 2 that a person stops must still be recognized.
      const stop = vi.spyOn(host.runtime.engine, 'stopAssignment')
      setSessionEvents(host, base, [
        { type: 'turn/start', time: Date.now(), data: { turn: 2 } },
        { type: 'turn/end', time: Date.now(), data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } }])
      agent.status = 'running'
      host.ctx.emit('agent/status', { agent, status: 'running' } as never)
      nativeStop(host, base, 2)
      await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(ticket!.id, stored.assignments.at(-1)!.id))
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket!.id)!.manualStop).toMatchObject({ scope: 'worker' }))
    } finally { await host.stop() }
  })
})

describe('a host restart recovers in-flight Handoffs', () => {
  it('fails split, accept and transfer records left starting, starts nothing, and leaves each Ticket retryable', async () => {
    const ids = { split: '', accept: '', transfer: '', target: '', targetSeedTickets: 0 }
    const host = await startRuntime(store => {
      const { engine, executor } = engineOn(store)
      // A cleanup no seed can settle: each call commits its first transaction and stops there, as a crash would.
      executor.stop = vi.fn(() => new Promise<void>(() => {}))
      const project = (id: string) => {
        engine.recordTriggerForRouting(trigger(id))
        const created = engine.createProject(id, `Project ${id}`, `Goal ${id}`)
        const [ticket] = engine.createProjectTickets(created.id, created.pmSessionId, [{ title: `Work ${id}`, goal: `Do ${id}` }])
        engine.assignmentStarted(ticket!.id, ticket!.assignments[0]!.id)
        return { project: created, ticket: ticket! }
      }
      const split = project('r1')
      void engine.splitTicket(split.project.id, split.project.pmSessionId, split.ticket.id, { title: 'Footer follow-up',
        goal: 'Finish the footer', reason: 'Beyond the header', summary: 'Footer remains', worktree_name: 'split-footer' })
      ids.split = split.ticket.id
      const acceptSource = project('r2'), acceptTarget = project('r3')
      const handoff = engine.requestProjectHandoff(acceptSource.project.id, acceptSource.project.pmSessionId,
        acceptSource.ticket.id, { ...request, targetProjectId: acceptTarget.project.id })
      void engine.decideProjectHandoff(acceptTarget.project.id, acceptTarget.project.pmSessionId, handoff.id, { action: 'accept' })
      ids.accept = acceptSource.ticket.id
      ids.target = acceptTarget.project.id
      ids.targetSeedTickets = store.tickets.list().filter(ticket => ticket.projectId === acceptTarget.project.id).length
      const transfer = project('r4')
      void engine.transferTicket(transfer.project.id, transfer.project.pmSessionId, transfer.ticket.id,
        { reason: 'Stuck', summary: 'Continue elsewhere' })
      ids.transfer = transfer.ticket.id
    })
    try {
      // Runtime startup recovered every in-flight record before any Worker resume; a second pass has nothing left.
      expect(host.runtime.engine.recoverInterruptedHandoffs()).toBe(0)
      for (const id of [ids.split, ids.accept, ids.transfer]) {
        const ticket = host.runtime.store.tickets.get(id)!
        expect(ticket.ended).toBeUndefined()
        expect(ticket.delivery?.error).toContain('host restarted while this handoff was starting')
        expect(ticket.handoffs!.every(handoff => handoff.status === 'failed')).toBe(true)
      }
      // The transfer's reserved replacement Assignment never starts after the crash.
      const transfer = host.runtime.store.tickets.get(ids.transfer)!
      expect(latestAssignment(transfer)).toMatchObject({ state: 'ended', endedReason: 'handoffCleanupFailed' })
      expect(transfer.assignments.at(-1)!.sessionId).toBe(`${workerSessionId(ids.transfer)}-h1`)
      expect(host.agents.has(`${workerSessionId(ids.transfer)}-h1`)).toBe(false)
      // The interrupted accept created no target Ticket and recorded no accepted Handoff there.
      const targetTickets = host.runtime.store.tickets.list().filter(ticket => ticket.projectId === ids.target)
      expect(targetTickets).toHaveLength(ids.targetSeedTickets)
      expect(targetTickets.flatMap(ticket => ticket.handoffs ?? []).filter(handoff => handoff.status === 'accepted')).toEqual([])
      // Every recovered source is retryable: a person's retry starts a fresh Worker, not the interrupted target work.
      expect(host.runtime.engine.retryTicket(ids.split).assignments.at(-1)).toMatchObject({ state: 'pending' })
      expect(host.runtime.engine.retryTicket(ids.accept).assignments.at(-1)).toMatchObject({ state: 'pending' })
      expect(host.runtime.engine.retryTicket(ids.transfer).assignments.at(-1)).toMatchObject({ state: 'pending',
        sessionId: `${workerSessionId(ids.transfer)}-h1` })
    } finally { await host.stop() }
  })
})

describe('a native Stop covers every Ticket source', () => {
  it('hard-stops a main-session Ticket and sends its receipt', async () => {
    const host = await startRuntime()
    try {
      const { ticket, sessionId } = await host.acceptedTicket(feishu('104', 'Fix the regression'))
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.state).toBe('running'))
      nativeStop(host, sessionId, 1)
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket.id)!.manualStop).toMatchObject({ scope: 'worker' }))
      expect(host.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'ended',
        endedReason: 'stoppedByOperator', idleAt: expect.any(String), interruptedAt: expect.any(String) })
      await vi.waitFor(() => expect(host.deliveries.mock.calls.some(([call]) => call.sessionId === host.runtime.masterId
        && call.text.includes('stop_assignment') && call.text.includes(ticket.id))).toBe(true))
    } finally { await host.stop() }
  })
})
