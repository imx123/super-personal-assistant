/**
 * C5: a delegated Ticket's authority is its Project's PM Mandate. Revalidation follows the Project and that Mandate, and a
 * Policy change that revokes it stops the running Worker and keeps it from being retried, woken or revived.
 */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, type Assessor, type Assignment, type Executor, type PolicyEffect, type ProjectProfile,
  type SourceScope, type Ticket, type Trigger } from '../src/core/index.ts'
import { policyEffects, policyVersion, settingsPolicy, SettingsSchema, type Settings } from '../src/policy.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const OPERATOR = 'dsh-user'
const actor = { source: 'main-session', id: OPERATOR }
const scope: SourceScope = { scope: () => ({ listened: true, observed: true, row: 'main-session' }) }
const base = (): Settings => SettingsSchema.parse({
  policy: { sources: { 'main-session': { allowed: [{ id: OPERATOR }] } } },
  eval: { mode: 'auto' },
})
const withoutOperator = (settings: Settings): Settings => ({ ...settings, policy: { ...settings.policy,
  sources: { ...settings.policy.sources, 'main-session': { ...settings.policy.sources['main-session']!, allowed: [] } } } })
const disableCopy = (settings: Settings): Settings => ({ ...settings, policy: { ...settings.policy,
  rules: settings.policy.rules.map(rule => rule.id === 'copy' ? { ...rule, enabled: false } : rule) } })
const trigger = (id = 'p1'): Trigger => ({ id, source: 'main-session', threads: [{ source: 'main-session', id }], actor, human: true,
  addressed: 'direct', at: '2026-11-10T00:00:00.000Z', text: `Create project ${id}`, meta: {} })
const followup = (id: string): Trigger => ({ id, source: 'feishu', threads: [{ source: 'feishu', id: 'x' }], actor: { source: 'feishu', id: 'ou_alice' },
  human: true, at: '2026-11-10T00:01:00.000Z', text: 'Please also check the footer', meta: {} })

function harness() {
  const repo = new MemoryRepositories()
  const assessor: Assessor = { request: vi.fn(), release: vi.fn() }
  const starts: string[] = []
  const stops: { ticketId: string; reason: string }[] = []
  const executor: Executor = {
    start: vi.fn((ticket: Ticket) => { starts.push(ticket.id) }),
    deliver: vi.fn(),
    stop: vi.fn((ticket: Ticket, _assignment: Assignment, reason: string) => { stops.push({ ticketId: ticket.id, reason }) }),
  }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  let current = base()
  const engine = new Engine({ repo, scope, policy: () => settingsPolicy(current, scope, projectId => repo.projects.get(projectId)),
    assessor, executor, outbox, now: () => '2026-11-10T00:00:00.000Z' })
  const created = (id = 'p1') => {
    engine.recordTriggerForRouting(trigger(id))
    const project = engine.createProject(id, `Project ${id}`, `Goal ${id}`)
    const ticket = engine.createProjectTickets(project.id, project.pmSessionId,
      [{ title: 'Header', goal: 'Make the header legible', threads: [{ key: 'feishu:x' }] }])[0]!
    engine.assignmentStarted(ticket.id, repo.tickets.get(ticket.id)!.assignments[0]!.id)
    starts.length = 0
    stops.length = 0
    return { project, ticket }
  }
  const change = (next: Settings): Map<string, PolicyEffect> => {
    const old = current
    const effects = policyEffects(repo.tickets.open(), old, next, () => scope, projectId => repo.projects.get(projectId))
    current = next
    engine.policyChanged(policyVersion(old), policyVersion(next), effects)
    return effects
  }
  return { repo, engine, starts, stops, created, change, get settings() { return current } }
}

describe('a revoked Project PM Mandate', () => {
  it('stops a running delegated Worker when the PM allowed sender is removed, and refuses retry and revive', () => {
    const h = harness()
    const { project, ticket } = h.created()
    expect(h.starts).toEqual([])
    const effects = h.change(withoutOperator(h.settings))
    expect(effects.get(ticket.id)).toEqual({ delegatedAuthority: false })
    expect(h.stops).toEqual([{ ticketId: ticket.id, reason: 'stoppedByOperator' }])
    const stored = h.repo.tickets.get(ticket.id)!
    expect(stored.assignments.at(-1)).toMatchObject({ state: 'ended', endedReason: 'stoppedByOperator' })
    expect(stored.manualStop).toMatchObject({ scope: 'project', by: 'policy', reason: 'policyRevoked' })
    expect(stored.inputs).toContainEqual(expect.objectContaining({ kind: 'policy-changed',
      effect: { delegatedAuthority: false } }))
    expect(() => h.engine.retryTicket(ticket.id)).toThrow(new UserError('mandateRevoked'))
    expect(() => h.engine.reviveProjectTicket(project.id, project.pmSessionId, ticket.id)).toThrow(new UserError('mandateRevoked'))
  })

  it('revokes an inferred PM Mandate when its matched rule is disabled, and stops the running Worker', () => {
    const h = harness()
    const { project, ticket } = h.created()
    // A Project creation requires explicit strength today; the inferred PM Mandate exercises the rule/mode branch of the
    // resolver, as an accepted inferred Mandate would.
    h.repo.projects.save({ ...project, mandate: { ...project.mandate, strength: 'inferred',
      basis: { via: 'admission', cell: 'listedUnaddressed', source: 'main-session', scope: {}, observation: { mode: 'auto' }, rules: ['copy'] } } })
    expect(h.change(disableCopy(h.settings)).get(ticket.id)).toEqual({ delegatedAuthority: false })
    expect(h.stops).toEqual([{ ticketId: ticket.id, reason: 'stoppedByOperator' }])
    expect(() => h.engine.reviveProjectTicket(project.id, project.pmSessionId, ticket.id)).toThrow(new UserError('mandateRevoked'))
  })

  it('revokes an inferred PM Mandate when the accept mode leaves auto, and stops the running Worker', () => {
    const h = harness()
    const { project, ticket } = h.created()
    h.repo.projects.save({ ...project, mandate: { ...project.mandate, strength: 'inferred',
      basis: { via: 'admission', cell: 'listedUnaddressed', source: 'main-session', scope: {}, observation: { mode: 'auto' }, rules: ['copy'] } } })
    const observe = { ...h.settings, eval: { ...h.settings.eval, mode: 'observe' as const } }
    expect(h.change(observe).get(ticket.id)).toEqual({ delegatedAuthority: false })
    expect(h.stops).toEqual([{ ticketId: ticket.id, reason: 'stoppedByOperator' }])
    expect(() => h.engine.reviveProjectTicket(project.id, project.pmSessionId, ticket.id)).toThrow(new UserError('mandateRevoked'))
  })

  it('keeps a paused Project as valid authority and leaves its running Worker alone', () => {
    const h = harness()
    const { project, ticket } = h.created()
    h.engine.pauseProject(project.id, true)
    expect(h.stops).toEqual([])
    expect(h.repo.tickets.get(ticket.id)!.assignments.at(-1)!.state).toBe('running')
    expect(settingsPolicy(h.settings, scope, id => h.repo.projects.get(id)).revalidate(ticket.mandate)).toBe(true)
    // A policy change during a temporary pause does not revoke the PM Mandate either.
    expect(h.change({ ...h.settings, eval: { ...h.settings.eval, timeoutSeconds: 130 } }).size).toBe(0)
    expect(h.stops).toEqual([])
  })

  it('treats an ended or archived Project as revoked authority', () => {
    const ended = harness()
    const first = ended.created('p1')
    ended.engine.stopProject(first.project.id)
    expect(ended.stops).toEqual([{ ticketId: first.ticket.id, reason: 'stopped' }])
    expect(ended.repo.tickets.get(first.ticket.id)!.ended?.by).toBe('human')
    expect(settingsPolicy(ended.settings, scope, id => ended.repo.projects.get(id)).revalidate(first.ticket.mandate)).toBe(false)
    expect(() => ended.engine.reviveProjectTicket(first.project.id, first.project.pmSessionId, first.ticket.id))
      .toThrow(new UserError('projectEnded'))

    const archived = harness()
    const second = archived.created('p2')
    archived.engine.archiveProject(second.project.id)
    expect(archived.stops).toEqual([{ ticketId: second.ticket.id, reason: 'projectArchived' }])
    expect(archived.repo.tickets.get(second.ticket.id)!.archived).toMatchObject({ by: 'project', projectId: second.project.id })
    expect(archived.repo.tickets.get(second.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'ended', endedReason: 'projectArchived' })
    expect(settingsPolicy(archived.settings, scope, id => archived.repo.projects.get(id)).revalidate(second.ticket.mandate)).toBe(false)
    expect(() => archived.engine.reviveProjectTicket(second.project.id, second.project.pmSessionId, second.ticket.id))
      .toThrow(new UserError('projectArchived'))
  })

  it('keeps an ended delegated Ticket ended when a human follow-up would resume it under a revoked PM', () => {
    const h = harness()
    const { ticket } = h.created()
    h.engine.report(ticket.id, { state: 'dropped', summary: 'nothing left to do' })
    expect(h.repo.tickets.get(ticket.id)!.ended?.by).toBe('executor')
    h.change(withoutOperator(h.settings))
    h.engine.receive(followup('f1'))
    const stored = h.repo.tickets.get(ticket.id)!
    expect(stored.ended).toBeDefined()
    expect(stored.undelivered).toEqual([])
    expect(stored.assignments).toHaveLength(1)
    expect(h.starts).toEqual([])
  })
})

describe('a delegated Ticket through the runtime', () => {
  it('stops the Worker when a panel policy save removes the PM sender, and refuses the PM revive', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('120', 'Start a project for delegated revocation')
      host.runtime.receive(request)
      await host.runtime.idle()
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Revocation', goal: 'Ship a clearer settings site' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(created.project.project_id)!
      const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: [
        { title: 'Header', goal: 'Make the header legible', worktree_name: 'fix-header' }] }) as { tickets: { ticket_id: string }[] }
      const ticket = host.runtime.store.tickets.get(result.tickets[0]!.ticket_id)!
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)?.state).toBe('running'))
      const block = host.runtime.settings.block('policy') as { revision: number; value: Settings['policy'] }
      const removed = { ...block.value, sources: { ...block.value.sources, feishu: { ...block.value.sources.feishu!, allowed: [] } } }
      await host.runtime.settings.save('policy', removed, block.revision, 'panel')
      const stored = host.runtime.store.tickets.get(ticket.id)!
      expect(stored.assignments.at(-1)).toMatchObject({ state: 'ended', endedReason: 'stoppedByOperator' })
      expect(stored.manualStop).toMatchObject({ scope: 'project', by: 'policy', reason: 'policyRevoked' })
      expect(stored.inputs).toContainEqual(expect.objectContaining({ kind: 'policy-changed', effect: { delegatedAuthority: false } }))
      await expect(host.runTool(project.pmSessionId, 'orchestrator_project_ticket_revive', { ticket_id: ticket.id }))
        .rejects.toThrow('no longer holds')
    } finally { await host.stop() }
  })
})
