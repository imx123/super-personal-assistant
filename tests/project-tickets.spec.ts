/** P2.2a/P2.2b: PM-created Project Tickets, delegated Decisions, external Threads, and their optional worker tool allowlist. */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, key, type Assessor, type Candidate, type DomainEvent, type Executor,
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
        origin: { triggerIds: [key('trigger', h.project.id, 'delegated', String(index))] },
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

  it('is idempotent per task position and records no second Trigger, Eval or Decision', () => {
    const h = harness()
    const first = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)
    const second = h.engine.createProjectTickets(h.project.id, h.project.pmSessionId, tasks)
    expect(second.map(ticket => ticket.id)).toEqual(first.map(ticket => ticket.id))
    expect(h.repo.tickets.list()).toHaveLength(2)
    expect(h.repo.decisions.byThread(`internal:${key('trigger', h.project.id, 'delegated', '0')}`)).toHaveLength(1)
    expect(h.repo.triggers.get(key('trigger', h.project.id, 'delegated', '1'))).toBeDefined()
    expect(h.launches).toHaveLength(2)
  })

  it('creates nothing when one task is invalid, including an unknown Thread key or a duplicate worktree name', () => {
    const badThread = harness()
    expect(() => badThread.engine.createProjectTickets(badThread.project.id, badThread.project.pmSessionId,
      [tasks[0]!, { title: 'Bad', goal: 'Bad', threads: [{ key: 'not-a-thread-key' }] }]))
      .toThrow(new UserError('invalidThread', { thread: 'not-a-thread-key' }))
    expect(badThread.repo.tickets.list()).toEqual([])
    expect(badThread.repo.decisions.byThread(`internal:${key('trigger', badThread.project.id, 'delegated', '0')}`)).toEqual([])
    expect(badThread.repo.triggers.get(key('trigger', badThread.project.id, 'delegated', '0'))).toBeUndefined()
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

  it('revalidates a delegated Mandate without an external allowed list', () => {
    const h = harness()
    const settings = SettingsSchema.parse({})
    const policy = settingsPolicy(settings, { scope: () => ({ listened: false, reason: 'off' }) })
    expect(policy.revalidate(mandateFor(h.project))).toBe(true)
  })
})

describe('a Project PM Session through the runtime', () => {
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

  it('falls back to the main Session when a Project Ticket\'s PM Session is missing', async () => {
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
      // Remove the PM Session: the Ticket's report must still reach the main Session.
      host.agents.delete(project.pmSessionId)
      await host.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'No PM is loaded.' })
      await vi.waitFor(() => expect(host.deliveries.mock.calls.some(([call]) => call.sessionId === host.runtime.masterId
        && call.text.includes(ticket.id) && call.text.includes('"kind":"worker_report"'))).toBe(true))
    } finally { await host.stop() }
  })
})
