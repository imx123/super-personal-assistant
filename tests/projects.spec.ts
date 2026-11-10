/** P2.1: Project creation, its gate-only Decision and PM Mandate, idempotency, Store persistence, read views, and the main Session tool. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, key, projectOfSession, pmSessionId, type Assessor, type Candidate,
  type DomainEvent, type Executor, type Policy, type ProjectProfile, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { PM_TOOLS } from '../src/app/sessions.ts'
import { projectDetail, projectList } from '../src/app/views/projects.ts'
import { startRuntime, feishu } from './fixtures/host.ts'

const actor = { source: 'main-session', id: 'dsh-user' }
function trigger(id = 'p1', overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'main-session', threads: [{ source: 'main-session', id }], actor, human: true, addressed: 'direct',
    at: `2026-11-10T00:00:0${id.slice(-1)}Z`, text: `Create a project ${id}`, meta: {}, ...overrides }
}
/** Engine on in-memory repositories, with the gate admitting `actor` and refusing anyone else. */
function harness() {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const events: DomainEvent[] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: (t: Trigger) => t.actor.id === actor.id ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : { admissible: false, reason: 'not the operator' },
    revalidate: () => true, admitsInferred: () => false }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor, outbox,
    emit: event => { events.push(event) }, now: () => '2026-11-10T00:00:00.000Z' })
  return { repo, engine, requests, events, policy }
}

describe('Project creation', () => {
  it('creates the Project Profile, its PM Mandate and a real gate-only project Decision without an assessor', () => {
    const h = harness()
    h.engine.recordTriggerForRouting(trigger())
    const project = h.engine.createProject('p1', 'Website', 'Ship the new site')
    const decision = h.repo.decisions.get(project.decisionId)!
    expect(project).toMatchObject({ id: key('project', 'p1'), title: 'Website', goal: 'Ship the new site', status: 'active',
      pmSessionId: `pm-${key('project', 'p1')}`, mandate: { projectId: key('project', 'p1'), goal: 'Ship the new site', strength: 'explicit',
        scope: 'Ship the new site', actor } })
    expect(decision).toMatchObject({ kind: 'project', projectId: project.id, triggerIds: ['p1'], strength: 'explicit',
      mandate: { projectId: project.id, goal: 'Ship the new site', scope: 'Ship the new site' } })
    expect(decision.ticketId).toBeUndefined()
    // A real Eval id, not a fabricated one, while the assessor was never asked and no ticket exists.
    expect(decision.evalId).toBe(key('eval', 'main-session:p1', 'direct', 'p1', 'project', '2026-11-10T00:00:00.000Z'))
    expect(h.requests).toEqual([])
    expect(h.repo.tickets.list()).toEqual([])
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'project.created',
      data: { projectId: project.id, decisionId: project.decisionId, pmSessionId: project.pmSessionId } }))
  })

  it('emits one Project state event per real transition, including pause mode upgrades, and none for no-ops', () => {
    const h = harness()
    h.engine.recordTriggerForRouting(trigger('p1'))
    const first = h.engine.createProject('p1', 'Website', 'Ship the new site')
    const at = '2026-11-10T00:00:00.000Z'
    const projectEvents = () => h.events.filter(event => event.type.startsWith('project.'))
    expect(projectEvents()).toEqual([{ type: 'project.created', at, data: { projectId: first.id, decisionId: first.decisionId,
      pmSessionId: first.pmSessionId } }])
    // Active -> soft, a repeated soft call, then soft -> hard and a hard no-op that must not add events.
    h.engine.pauseProject(first.id, true)
    expect(projectEvents().at(-1)).toEqual({ type: 'project.paused', at, data: { projectId: first.id, mode: 'soft' } })
    h.engine.pauseProject(first.id, true)
    expect(projectEvents()).toHaveLength(2)
    h.engine.pauseProject(first.id, true, 'hard')
    expect(projectEvents().at(-1)).toEqual({ type: 'project.paused', at, data: { projectId: first.id, mode: 'hard', from: 'soft' } })
    h.engine.pauseProject(first.id, true, 'hard')
    h.engine.pauseProject(first.id, true, 'soft')
    expect(projectEvents()).toHaveLength(3)
    // Resume from hard, then end with a reason; repeated calls add nothing.
    h.engine.pauseProject(first.id, false)
    expect(projectEvents().at(-1)).toEqual({ type: 'project.resumed', at, data: { projectId: first.id, mode: 'hard' } })
    h.engine.pauseProject(first.id, false)
    h.engine.stopProject(first.id, 'finished')
    expect(projectEvents().at(-1)).toEqual({ type: 'project.ended', at, data: { projectId: first.id, reason: 'finished' } })
    h.engine.stopProject(first.id, 'again')
    expect(projectEvents()).toHaveLength(5)
    // Archive restores the previous status; a second archive and unarchive are no-ops after their transitions.
    h.engine.recordTriggerForRouting(trigger('p2'))
    const second = h.engine.createProject('p2', 'Docs', 'Write the docs')
    h.engine.archiveProject(second.id)
    expect(projectEvents().at(-1)).toEqual({ type: 'project.archived', at, data: { projectId: second.id, from: 'active' } })
    h.engine.archiveProject(second.id)
    h.engine.unarchiveProject(second.id)
    expect(projectEvents().at(-1)).toEqual({ type: 'project.unarchived', at, data: { projectId: second.id, status: 'active' } })
    h.engine.unarchiveProject(second.id)
    expect(projectEvents().map(event => event.type)).toEqual(['project.created', 'project.paused', 'project.paused', 'project.resumed',
      'project.ended', 'project.created', 'project.archived', 'project.unarchived'])
  })

  it('is idempotent per trigger: a repeated call returns the first Project and records no second Decision', () => {
    const h = harness()
    h.engine.recordTriggerForRouting(trigger())
    const first = h.engine.createProject('p1', 'Website', 'Ship the new site')
    const second = h.engine.createProject('p1', 'Another title', 'Another goal')
    expect(second).toEqual(first)
    expect(h.repo.projects.list()).toEqual([first])
    expect(h.repo.decisions.byThread('main-session:p1')).toHaveLength(1)
  })

  it('drops a Project-routed Trigger from a queued batch before it starts (P2-A03)', () => {
    const h = harness()
    const shared = { source: 'main-session', id: 'shared' }
    h.engine.recordTriggerForRouting(trigger('p1', { threads: [shared] }))
    h.engine.createProject('p1', 'Website', 'Ship the new site')
    const thread = h.repo.threads.get('main-session:shared')!
    thread.pending.push('p1')
    h.repo.threads.save(thread)
    h.engine.recordTriggerForRouting(trigger('p2', { threads: [shared] }))
    expect(h.engine.reevaluate('p2')).toBe(true)
    h.engine.evaluateDue()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['p2'])
    const decision = h.engine.decide('p2', { kind: 'accept', title: 'Normal work', scope: 'normal', reason: 'requested' })
    expect(decision.triggerIds).toEqual(['p2'])
  })

  it('keeps a Project-routed Trigger out of a later batch accept (P2-A03)', () => {
    const h = harness()
    const shared = { source: 'main-session', id: 'shared' }
    h.engine.recordTriggerForRouting(trigger('p1', { threads: [shared] }))
    h.engine.createProject('p1', 'Website', 'Ship the new site')
    expect(h.engine.reevaluate('p1')).toBe(false)
    h.engine.recordTriggerForRouting(trigger('p2', { threads: [shared] }))
    const decision = h.engine.decide('p2', { kind: 'accept', title: 'Normal work', scope: 'normal', reason: 'requested' })
    expect(decision).toMatchObject({ kind: 'accept', triggerIds: ['p2'] })
    expect(h.repo.tickets.get(decision.ticketId!)?.origin.triggerIds).toEqual(['p2'])
  })

  it('refuses an unknown trigger and one the gate does not admit, recording neither a Project nor a Decision', () => {
    const h = harness()
    expect(() => h.engine.createProject('missing', 'Website', 'Ship')).toThrow(new UserError('unknownTrigger'))
    h.engine.recordTriggerForRouting(trigger('p2', { actor: { source: 'main-session', id: 'guest' } }))
    expect(() => h.engine.createProject('p2', 'Website', 'Ship')).toThrow('not admissible')
    expect(h.repo.projects.list()).toEqual([])
    expect(h.repo.decisions.byThread('main-session:p2')).toEqual([])
  })

  // P2-A01: a Project is a routing act, so an inferred Trigger may not create one; an explicit one still can.
  it('refuses an inferred Trigger a Project and leaves no Project or Decision, while an explicit Trigger still creates one', () => {
    const h = harness()
    h.policy.gate = (t: Trigger) => t.actor.id === actor.id
      ? { admissible: true, strength: 'inferred', basis: { via: 'admission', cell: 'listedUnaddressed' } }
      : { admissible: false, reason: 'not the operator' }
    h.engine.recordTriggerForRouting(trigger('p4'))
    expect(() => h.engine.createProject('p4', 'Inferred project', 'Must not start')).toThrow(new UserError('notExplicit'))
    expect(h.repo.projects.list()).toEqual([])
    expect(h.repo.decisions.byThread('main-session:p4')).toEqual([])
    // The refused attempt left the Trigger usable: an explicit re-evaluation can still route it to a Project.
    h.policy.gate = () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } })
    const project = h.engine.createProject('p4', 'Explicit project', 'Works')
    expect(project.mandate.strength).toBe('explicit')
    expect(h.repo.decisions.byThread('main-session:p4').map(decision => decision.kind)).toEqual(['project'])
  })

  // P2-A03: one Trigger takes one route; the other path is refused after the first commits.
  it('refuses an accept once the Trigger created a Project, leaving no independent Ticket', () => {
    const h = harness()
    h.engine.recordTriggerForRouting(trigger('p5'))
    const project = h.engine.createProject('p5', 'Project first', 'Ship the site')
    expect(() => h.engine.decide('p5', { kind: 'accept', title: 'Independent ticket', scope: 'Independent ticket',
      reason: 'requested', acknowledgement: 'ok', name: 'independent-ticket' })).toThrow(/already routed to a Project/)
    expect(h.repo.tickets.list()).toEqual([])
    expect(h.repo.projects.get(project.id)).toEqual(project)
    // Replaying the Project route stays idempotent and does not record a second Decision.
    expect(h.engine.createProject('p5', 'Project first', 'Ship the site')).toEqual(project)
    expect(h.repo.decisions.byThread('main-session:p5').map(decision => decision.kind)).toEqual(['project'])
  })

  it('refuses a Project once the Trigger accepted a Ticket, and leaves the accepted Ticket as its only route', () => {
    const h = harness()
    h.engine.recordTriggerForRouting(trigger('p6'))
    const accept = h.engine.decide('p6', { kind: 'accept', title: 'Ticket first', scope: 'Ticket first', reason: 'requested',
      acknowledgement: 'ok', name: 'ticket-first' })
    expect(() => h.engine.createProject('p6', 'Late project', 'Must not start')).toThrow(/already routed to a Ticket/)
    expect(h.repo.projects.list()).toEqual([])
    expect(h.repo.decisions.byThread('main-session:p6').map(decision => decision.kind)).toEqual(['accept'])
    expect(h.repo.tickets.list()).toHaveLength(1)
    // Replaying the accept stays idempotent and creates no second Ticket.
    expect(h.engine.decide('p6', { kind: 'accept', title: 'Again', scope: 'Again', reason: 'requested', acknowledgement: 'ok',
      name: 'again' })).toEqual(accept)
    expect(h.repo.tickets.list()).toHaveLength(1)
  })

  it('records the PM report on the Project and keeps the latest one', () => {
    const h = harness()
    h.engine.recordTriggerForRouting(trigger())
    const project = h.engine.createProject('p1', 'Website', 'Ship')
    const reported = h.engine.projectReport(project.id, 'Kickoff done; next is the information architecture.')
    expect(reported).toMatchObject({ latestReport: { summary: 'Kickoff done; next is the information architecture.',
      at: '2026-11-10T00:00:00.000Z' }, updatedAt: '2026-11-10T00:00:00.000Z' })
    h.engine.projectReport(project.id, 'Second report.')
    expect(h.repo.projects.get(project.id)?.latestReport?.summary).toBe('Second report.')
    expect(() => h.engine.projectReport('missing', 'x')).toThrow(new UserError('unknownProject'))
  })
})

describe('Project persistence and read views', () => {
  it('stores Project Profiles, lists them newest first in SQLite and in memory, and leaves Ticket.projectId empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'projects-store-'))
    const path = join(directory, 'orchestrator.sqlite')
    const store = new Store(path)
    try {
      const project = (id: string): ProjectProfile => ({ id, title: id, goal: `goal ${id}`, status: 'active', decisionId: `d-${id}`,
        pmSessionId: pmSessionId(id), mandate: { projectId: id, goal: `goal ${id}`, strength: 'explicit', policyVersion: 'v1',
          basis: { via: 'listed' }, actor, scope: id }, createdAt: 'a', updatedAt: 'b' })
      store.projects.save(project('one')); store.projects.save(project('two'))
      expect(store.projects.list().map(item => item.id)).toEqual(['two', 'one'])
      const memory = new MemoryRepositories()
      memory.projects.save(project('one')); memory.projects.save(project('two'))
      expect(memory.projects.list().map(item => item.id)).toEqual(['two', 'one'])
      const ticket: Ticket = { id: 't1', title: 't', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v1',
        basis: { via: 'listed' }, actor, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [],
        createdAt: 'a', updatedAt: 'a', origin: { triggerId: 'p1', triggerIds: ['p1'] } }
      store.tickets.save(ticket)
      expect(store.tickets.get('t1')).not.toHaveProperty('projectId')
      // The read view lists the goal, status, PM Session and latest report, and a missing id has no page.
      const view = projectList(store)
      expect(view.total).toBe(2)
      expect(view.items[0]).toMatchObject({ id: 'two', goal: 'goal two', status: 'active', pmSessionId: pmSessionId('two') })
      store.projects.save({ ...store.projects.get('one')!, latestReport: { summary: 'Reported.', at: 'c' } })
      expect(projectDetail(store, 'one')).toMatchObject({ id: 'one', latestReport: { summary: 'Reported.', at: 'c' } })
      expect(projectDetail(store, 'missing')).toBeUndefined()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // P2-A01 through the real runtime: observe mode admits this external message as inferred, which must not create a Project.
  it('refuses an inferred Trigger a Project in observe mode, while an explicit request still creates one', async () => {
    const host = await startRuntime()
    try {
      const settings = host.runtime.store.settings()
      host.runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'observe' },
        policy: { ...settings.policy, sources: { ...settings.policy.sources, feishu: { ...settings.policy.sources.feishu,
          admission: { oc_team: { unlistedAddressed: 'inferred' } } } } } })
      const inferred = feishu('34', '@bot 帮我看看这个设置页', { sender_id: 'ou_stranger' })
      // Record directly so no Settings sync replaces the admission table before the Project tool reads the gate.
      expect(host.runtime.engine.recordTriggerForRouting(inferred)).toBe('stored')
      await expect(host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: inferred.id, title: 'Inferred project', goal: 'Must not start' })).rejects.toThrow(/explicit/i)
      expect(host.runtime.store.projects.get(key('project', inferred.id))).toBeUndefined()
      expect(host.runtime.store.triggers.disposition(inferred.id)?.decisionId).toBeUndefined()
      // The same tool still creates a Project for an explicit request from the allowed member.
      const explicit = feishu('35', '@bot 开一个项目')
      expect(host.runtime.engine.recordTriggerForRouting(explicit)).toBe('stored')
      const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: explicit.id, title: 'Explicit project', goal: 'Start' }) as { project: { project_id: string } }
      expect(host.runtime.store.projects.get(created.project.project_id)?.mandate.strength).toBe('explicit')
    } finally { await host.stop() }
  })

  it('creates the Project with its PM Session through the main Session tool, and serves it on the project routes', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('31', 'Start a project for the settings site')
      host.runtime.receive(request)
      await host.runtime.idle()
      const result = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Settings site', goal: 'Ship a clearer settings site' }) as {
          project: { project_id: string }; read: string; note: string }
      const project = host.runtime.store.projects.get(result.project.project_id)!
      expect(result).toMatchObject({ read: `project/${project.id}`, note: expect.stringContaining('no Ticket or worker') })
      expect(project).toMatchObject({ title: 'Settings site', goal: 'Ship a clearer settings site', pmSessionId: `pm-${project.id}` })
      expect(project.mandate.scope).toBe('Ship a clearer settings site')
      expect(projectOfSession(project.pmSessionId)).toBe(project.id)
      // The PM has only its read, create-Ticket, message and report tools, and takes the auto preset before the narrower ones.
      expect([...host.tools.get(project.pmSessionId)!.keys()].sort()).toEqual(['orchestrator_project_report',
        'orchestrator_project_ticket_create', 'orchestrator_project_ticket_message', 'orchestrator_read'])
      expect(host.permissions.set).toHaveBeenCalledWith(expect.objectContaining({ id: project.pmSessionId }), 'auto')
      const messages = host.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === project.pmSessionId)
      expect(messages).toHaveLength(1)
      expect(JSON.parse(messages[0]!.text)).toMatchObject({ kind: 'project_created',
        project: { project_id: project.id, title: 'Settings site', goal: 'Ship a clearer settings site' } })
      // The PM reads its Project and nothing else, and reports; the read routes show the report.
      expect(await host.runTool(project.pmSessionId, 'orchestrator_read', { resource: `project/${project.id}` }))
        .toMatchObject({ project_id: project.id, title: 'Settings site' })
      await expect(host.runTool(project.pmSessionId, 'orchestrator_read', { resource: 'tickets' }))
        .rejects.toThrow('only its own Project')
      await host.runTool(project.pmSessionId, 'orchestrator_project_report', { summary: 'Kickoff done.' })
      expect((await host.api('GET', 'projects')).body).toMatchObject({ total: 1, items: [{ id: project.id, latestReport: { summary: 'Kickoff done.' } }] })
      expect((await host.api('GET', `projects/${project.id}`)).body).toMatchObject({ id: project.id, goal: 'Ship a clearer settings site' })
      expect((await host.api('GET', 'projects/missing')).status).toBe(404)
    } finally { await host.stop() }
  })

  // P2-A05: a Project whose PM Session failed to start is recoverable, and the recovery entry is idempotent.
  it('starts a failed PM Session through POST projects/:id/pm without a second project-init', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('33', 'Start a project whose PM Session fails')
      host.runtime.receive(request)
      await host.runtime.idle()
      const projectId = key('project', request.id)
      const pm = pmSessionId(projectId)
      const original = host.controller.resolveAgent.getMockImplementation()!
      host.controller.resolveAgent.mockImplementation(async (id: string) => {
        if (id === pm) throw new Error('PM Session could not start')
        return original(id)
      })
      await expect(host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Recovery', goal: 'Survive a failed PM start' })).rejects.toThrow('PM Session could not start')
      // The Project committed before the PM failed: it is active with no PM Session and no Ticket.
      expect(host.runtime.store.projects.get(projectId)?.status).toBe('active')
      expect(host.agents.get(pm)).toBeUndefined()
      expect(host.tools.get(pm)).toBeUndefined()
      host.controller.resolveAgent.mockImplementation(original)
      const first = await host.api('POST', `projects/${projectId}/pm`)
      expect(first).toEqual({ status: 200, body: { started: true, sessionId: pm } })
      expect(host.agents.get(pm)).toBeDefined()
      expect([...host.tools.get(pm)!.keys()].sort()).toEqual([...PM_TOOLS].sort())
      const init = () => host.deliveries.mock.calls.map(([call]) => call)
        .filter(call => call.sessionId === pm && (JSON.parse(call.text) as { kind?: string }).kind === 'project_created')
      expect(init()).toHaveLength(1)
      // Repeating the recovery request reopens the same Session and never sends project-init twice.
      const second = await host.api('POST', `projects/${projectId}/pm`)
      expect(second).toEqual({ status: 200, body: { started: true, sessionId: pm } })
      expect(init()).toHaveLength(1)
      // The recovered PM is decorated and answers on its Project.
      expect(await host.runTool(pm, 'orchestrator_project_report', { summary: 'Recovered.' }))
        .toMatchObject({ project: { project_id: projectId, latest_report: { summary: 'Recovered.' } } })
    } finally { await host.stop() }
  })

  it('does not relay Project state events to the main Session or the PM', async () => {
    const host = await startRuntime()
    try {
      const request = feishu('32', 'Start a project for quiet events')
      host.runtime.receive(request)
      await host.runtime.idle()
      const result = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
        { trigger_id: request.id, title: 'Quiet events', goal: 'Keep state events for audit only' }) as { project: { project_id: string } }
      const project = host.runtime.store.projects.get(result.project.project_id)!
      const deliveries = host.deliveries.mock.calls.length
      host.runtime.engine.pauseProject(project.id, true)
      host.runtime.engine.pauseProject(project.id, true, 'hard')
      host.runtime.engine.pauseProject(project.id, false)
      host.runtime.engine.archiveProject(project.id)
      host.runtime.engine.unarchiveProject(project.id)
      host.runtime.engine.stopProject(project.id, 'audit only')
      expect(host.deliveries.mock.calls).toHaveLength(deliveries)
    } finally { await host.stop() }
  })
})
