/** P2.5-B: native DSH archive reconciliation and Project pending notes. */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { liveTicket } from '../src/core/index.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const stopSession = (host: Host, sessionId: string): void => {
  host.ctx.emit('workspace/session-stop', { sessionId: sessionId as SessionId })
}

/** Create a Project with one or two Tickets through the main and PM Sessions, and wait for their worker Sessions. */
async function projectWith(host: Host, id: string, tasks: string[]) {
  const request = feishu(id, `Start a project ${id}`)
  host.runtime.receive(request)
  await host.runtime.idle()
  const created = await host.runTool(host.runtime.masterId, 'orchestrator_project_create',
    { trigger_id: request.id, title: `Project ${id}`, goal: 'Ship a clearer settings site' }) as { project: { project_id: string } }
  const project = host.runtime.store.projects.get(created.project.project_id)!
  const result = await host.runTool(project.pmSessionId, 'orchestrator_project_ticket_create', { tasks: tasks.map((title, index) => ({
    title, goal: `Do ${title}`, worktree_name: `task-${id}-${index}` })) }) as { tickets: { ticket_id: string }[] }
  const tickets = result.tickets.map(card => host.runtime.store.tickets.get(card.ticket_id)!)
  for (const ticket of tickets) await vi.waitFor(() => expect(host.tools.get(workerSessionId(ticket.id))).toBeDefined())
  await host.runtime.reconcileArchives()
  return { project, tickets }
}

describe('native DSH archive reconciliation', () => {
  it('archives a Project whose PM Session was archived in DSH, then restores it on unarchive', async () => {
    const host = await startRuntime()
    try {
      const { project, tickets } = await projectWith(host, '71', ['Header', 'Footer'])
      host.workspace.archived.add(project.pmSessionId)
      // The activity waterfall listener must record the candidate and still pass through to the next provider.
      await expect(host.ctx.waterfall('workspace/session-activity', { sessionId: project.pmSessionId as SessionId },
        async () => [])).resolves.toEqual([])
      await vi.waitFor(() => expect(host.runtime.store.projects.get(project.id)?.status).toBe('archived'))
      expect(host.runtime.store.projects.get(project.id)?.archivedFrom).toBe('active')
      for (const ticket of tickets) expect(host.runtime.store.tickets.get(ticket.id)?.archived).toMatchObject({ projectId: project.id })
      // A second pass absorbs the child Sessions archived by this command, without adding worker notes.
      await host.runtime.reconcileArchives()
      expect(host.runtime.store.projects.get(project.id)?.pendingNotes).toBeUndefined()
      expect(host.workspace.archiveSession).toHaveBeenCalledWith(project.pmSessionId, { stopActivity: true })
      for (const ticket of tickets) expect(host.workspace.archiveSession).toHaveBeenCalledWith(workerSessionId(ticket.id), { stopActivity: true })

      for (const id of [project.pmSessionId, ...tickets.map(ticket => workerSessionId(ticket.id))]) host.workspace.archived.delete(id)
      stopSession(host, project.pmSessionId)
      await vi.waitFor(() => expect(host.runtime.store.projects.get(project.id)?.status).toBe('active'))
      for (const ticket of tickets) expect(host.runtime.store.tickets.get(ticket.id)?.archived).toBeUndefined()
      // Restoring the Project restores its child Sessions; that is not a Worker restored by hand, so no notes.
      expect(host.runtime.store.projects.get(project.id)?.pendingNotes).toBeUndefined()
    } finally { await host.stop() }
  })

  it('ends only the archived worker Assignment, keeps the Ticket open, and gives the PM one pending note', async () => {
    const host = await startRuntime()
    try {
      const { project, tickets } = await projectWith(host, '72', ['Header'])
      const ticket = tickets[0]!
      const assignment = ticket.assignments.at(-1)!
      const before = host.deliveries.mock.calls.filter(([call]) => call.sessionId === project.pmSessionId).length
      host.workspace.archived.add(workerSessionId(ticket.id))
      stopSession(host, workerSessionId(ticket.id))
      await vi.waitFor(() => expect(host.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.endedReason).toBe('sessionArchived'))
      const stored = host.runtime.store.tickets.get(ticket.id)!
      expect(stored.archived).toBeUndefined()
      expect(stored.ended).toBeUndefined()
      expect(liveTicket(stored)).toBe(true)
      expect(host.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.id).toBe(assignment.id)
      const projectNote = host.runtime.store.projects.get(project.id)!
      expect(projectNote.pendingNotes).toHaveLength(1)
      expect(projectNote.pendingNotes![0]).toMatchObject({ kind: 'workerArchived', ticketId: ticket.id,
        sessionId: workerSessionId(ticket.id) })
      // No PM delivery was queued by the note; the PM's next prompt carries and consumes it.
      expect(host.deliveries.mock.calls.filter(([call]) => call.sessionId === project.pmSessionId)).toHaveLength(before)
      const section = host.sections.get(project.pmSessionId)!
      const prompt = section({})
      expect(prompt).toContain('Pending notes:')
      expect(prompt).toContain('Worker Session archived')
      expect(host.runtime.store.projects.get(project.id)?.pendingNotes).toBeUndefined()
      // A repeated reconcile does not add the note again.
      await host.runtime.reconcileArchives()
      expect(host.runtime.store.projects.get(project.id)?.pendingNotes).toBeUndefined()
      // Unarchiving the worker leaves the Assignment and Ticket alone and adds the optional restored note.
      const assignments = host.runtime.store.tickets.get(ticket.id)!.assignments.length
      host.workspace.archived.delete(workerSessionId(ticket.id))
      stopSession(host, workerSessionId(ticket.id))
      await vi.waitFor(() => expect(host.runtime.store.projects.get(project.id)?.pendingNotes?.[0]?.kind).toBe('workerRestored'))
      expect(host.runtime.store.tickets.get(ticket.id)?.assignments).toHaveLength(assignments)
      expect(host.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.endedReason).toBe('sessionArchived')
    } finally { await host.stop() }
  })

  it('reconciles an already archived PM when the snapshot is missing, and a self-archive does not loop', async () => {
    const host = await startRuntime()
    try {
      const { project } = await projectWith(host, '73', ['Header'])
      host.runtime.store.delete(KV.archive.sessionSnapshot)
      host.workspace.archived.add(project.pmSessionId)
      stopSession(host, project.pmSessionId)
      await vi.waitFor(() => expect(host.runtime.store.projects.get(project.id)?.status).toBe('archived'))
      await host.runtime.reconcileArchives()
      expect(host.runtime.store.projects.get(project.id)?.pendingNotes).toBeUndefined()
      // Restore it, then archive from the Project's own API: the resulting archived set is not treated as a second cascade.
      host.workspace.archived.delete(project.pmSessionId)
      stopSession(host, project.pmSessionId)
      await vi.waitFor(() => expect(host.runtime.store.projects.get(project.id)?.status).toBe('active'))
      host.runtime.engine.unarchiveProject(project.id)
      await host.api('POST', `projects/${project.id}/archive`)
      const archived = host.runtime.store.projects.get(project.id)!
      expect(archived.status).toBe('archived')
      await host.runtime.reconcileArchives()
      await host.runtime.reconcileArchives()
      expect(host.runtime.store.projects.get(project.id)?.status).toBe('archived')
      expect(host.runtime.store.projects.get(project.id)?.pendingNotes).toBeUndefined()
    } finally { await host.stop() }
  })
})
