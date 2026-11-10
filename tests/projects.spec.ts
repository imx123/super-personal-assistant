/** P2.1: Project creation, its gate-only Decision and PM Mandate, idempotency, Store persistence, read views, and the main Session tool. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, key, projectOfSession, pmSessionId, type Assessor, type Candidate,
  type DomainEvent, type Executor, type Policy, type ProjectProfile, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
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
  return { repo, engine, requests, events }
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

  it('is idempotent per trigger: a repeated call returns the first Project and records no second Decision', () => {
    const h = harness()
    h.engine.recordTriggerForRouting(trigger())
    const first = h.engine.createProject('p1', 'Website', 'Ship the new site')
    const second = h.engine.createProject('p1', 'Another title', 'Another goal')
    expect(second).toEqual(first)
    expect(h.repo.projects.list()).toEqual([first])
    expect(h.repo.decisions.byThread('main-session:p1')).toHaveLength(1)
  })

  it('refuses an unknown trigger and one the gate does not admit, recording neither a Project nor a Decision', () => {
    const h = harness()
    expect(() => h.engine.createProject('missing', 'Website', 'Ship')).toThrow(new UserError('unknownTrigger'))
    h.engine.recordTriggerForRouting(trigger('p2', { actor: { source: 'main-session', id: 'guest' } }))
    expect(() => h.engine.createProject('p2', 'Website', 'Ship')).toThrow('not admissible')
    expect(h.repo.projects.list()).toEqual([])
    expect(h.repo.decisions.byThread('main-session:p2')).toEqual([])
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
      // The PM has only its read and report tools, and never full machine access while workspace-write is offered.
      expect([...host.tools.get(project.pmSessionId)!.keys()].sort()).toEqual(['orchestrator_project_report', 'orchestrator_read'])
      expect(host.permissions.set).toHaveBeenCalledWith(expect.objectContaining({ id: project.pmSessionId }), 'workspace-write')
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
})
