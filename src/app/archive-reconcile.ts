/** Reconciling native DSH Session archives with Project and Ticket state, without changing state from the event itself. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Engine, ProjectProfile } from '../core/index.ts'
import { projectOfSession } from '../core/index.ts'
import { ticketOfSession, workerSessionId } from '../executor/dsh.ts'
import { KV } from '../kv.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'

export interface ArchiveReconcileHost {
  readonly context: Context
  readonly store: Pick<Store, 'projects' | 'tickets' | 'get' | 'set'>
  readonly engine: Pick<Engine, 'archiveProject' | 'unarchiveProject' | 'workerSessionArchived' | 'workerSessionUnarchived'>
  readonly sessions: Pick<Sessions, 'archiveProject' | 'unarchiveProject' | 'archivedSession'>
  configured(): boolean
  closing(): boolean
}

/** How often an unarchive that emits no event is found anyway; event handlers request an earlier pass. */
const RECONCILE_MS = 30_000

/**
 * Keeps application Project/Ticket state consistent with the host's durable DSH archive set. `workspace/session-activity`
 * and `workspace/session-stop` only record a candidate and request a pass; every decision reads
 * `workspaceRegistry.archivedSessionIds` and compares it with a KV snapshot, so an archive that was refused or an unarchive
 * without an event converges on the next pass. Only this plugin's `pm-<projectId>` and `worker-<ticketId>` Sessions matter.
 */
export class ArchiveReconciler {
  private timer?: ReturnType<typeof setInterval>
  private scheduled = false
  private stopped = false
  private running?: Promise<void>
  private again = false
  private readonly candidates = new Set<string>()
  private readonly unarchivedProjects = new Set<string>()
  private readonly warned = new Set<string>()
  private readonly disposers: (() => void)[] = []
  private unavailableLogged = false
  constructor(private readonly host: ArchiveReconcileHost) {}

  /** Record the native archive events without changing any state; the waterfall listener must pass through `next`. */
  install(): void {
    this.disposers.push(this.host.context.on('workspace/session-activity', (request, next) => {
      this.record(String(request.sessionId))
      // A waterfall listener that does not call next would block every other provider and the archive itself.
      return next()
    }))
    this.disposers.push(this.host.context.on('workspace/session-stop', request => { this.record(String(request.sessionId)) }))
  }
  /** Start the low-frequency fallback pass, and one pass now for Sessions archived before this process started. */
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { this.request() }, RECONCILE_MS)
    this.timer.unref?.()
    this.request()
  }
  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    for (const dispose of this.disposers.splice(0)) dispose()
    await this.running
  }
  /** Run one reconcile now; callers may await it, such as tests or an explicit pass. */
  reconcile(): Promise<void> {
    if (this.running) { this.again = true; return this.running }
    const running = this.run().catch(error => {
      this.host.context.logger.warn('dsh-superagent could not reconcile Project archives: %s', String(error))
    }).finally(() => {
      if (this.running !== running) return
      this.running = undefined
      if (this.again) { this.again = false; this.request() }
    })
    this.running = running
    return running
  }
  private record(sessionId: string): void {
    this.candidates.add(sessionId)
    this.request()
  }
  /** Coalesce event bursts into one pass, but do not wait for the 30-second fallback. */
  private request(): void {
    if (this.scheduled || this.stopped) return
    this.scheduled = true
    const timer = setTimeout(() => {
      this.scheduled = false
      void this.reconcile()
    }, 0)
    timer.unref?.()
  }
  private async run(): Promise<void> {
    if (this.stopped || this.host.closing() || !this.host.configured()) return
    const registry = this.host.context.get('workspaceRegistry') as { archivedSessionIds?: readonly string[] } | undefined
    if (!registry || !Array.isArray(registry.archivedSessionIds)) {
      if (!this.unavailableLogged) {
        this.unavailableLogged = true
        this.host.context.logger.warn('dsh-superagent: the host offers no archivedSessionIds; Project archive reconciliation waits')
      }
      return
    }
    const current = [...new Set(registry.archivedSessionIds.map(String))]
    const snapshot = this.host.store.get(KV.archive.sessionSnapshot)
    const first = snapshot === undefined
    const previous = new Set(snapshot ?? [])
    const added = first ? current : current.filter(id => !previous.has(id))
    const removed = first ? [] : [...previous].filter(id => !current.includes(id))
    this.candidates.clear()
    this.unarchivedProjects.clear()
    let ok = true
    const attempt = async (run: () => Promise<void> | void): Promise<void> => {
      try { await run() } catch (error) {
        ok = false
        this.host.context.logger.warn('dsh-superagent could not reconcile an archived Session: %s', String(error))
      }
    }
    // A restored PM goes first, then a newly archived PM, so its child workers see the Project's definitive state.
    for (const sessionId of removed) if (projectOfSession(sessionId)) await attempt(() => this.unarchiveProject(sessionId))
    const handled = new Set<string>()
    for (const sessionId of added) if (projectOfSession(sessionId)) { handled.add(sessionId); await attempt(() => this.archiveProject(sessionId)) }
    // A snapshot may already have recorded a PM whose Project was not archived, such as an upgrade from before this check.
    for (const sessionId of current) if (projectOfSession(sessionId) && !handled.has(sessionId)) await attempt(() => this.ensureProjectArchived(sessionId))
    for (const sessionId of added) if (!projectOfSession(sessionId)) await attempt(() => this.archiveWorker(sessionId))
    for (const sessionId of removed) if (!projectOfSession(sessionId)) await attempt(() => this.unarchiveWorker(sessionId))
    // Only a clean pass advances the snapshot; a failed application step is retried on the next event or timer. Re-read the
    // host set because archiving or unarchiving the Project changed its child Sessions during this pass.
    if (ok) {
      const settled = [...new Set(registry.archivedSessionIds.map(String))]
      this.host.store.set(KV.archive.sessionSnapshot, settled)
    }
  }
  private async archiveProject(sessionId: string): Promise<void> {
    const project = this.projectOf(sessionId)
    if (!project) return
    if (project.status === 'ended') { this.warn(`the PM Session for ended Project ${project.id} is archived; keeping the Project ended`); return }
    // The Project may already be archived by an earlier pass whose Session archive failed partway; archive its Sessions
    // again so the missing ones are retried (P2-A04). DSH archive is idempotent, and already archived Sessions are skipped.
    const archived = project.status === 'archived' ? project : this.host.engine.archiveProject(project.id)
    await this.archiveSessions(archived)
  }
  private async ensureProjectArchived(sessionId: string): Promise<void> {
    const project = this.projectOf(sessionId)
    if (!project || project.status === 'ended') return
    const archived = project.status === 'archived' ? project : this.host.engine.archiveProject(project.id)
    await this.archiveSessions(archived)
  }
  /**
   * Ask the host to archive every PM and child Session the Project's archived state expects. A failure rejects so the pass
   * does not advance the snapshot and the next reconcile retries; a Project whose Sessions are all archived is left alone.
   */
  private async archiveSessions(project: ProjectProfile): Promise<void> {
    if (!this.missingSessions(project).length) return
    const result = await this.host.sessions.archiveProject(project)
    if (result.failures.length) throw new Error(`Project ${project.id} Session archive failed: ${result.failures.map(failure => `${failure.sessionId}: ${failure.error}`).join('; ')}`)
  }
  /** The Project's PM and child worker Sessions the host does not report archived; a host without that view reports none. */
  private missingSessions(project: ProjectProfile): string[] {
    const expected = [project.pmSessionId, ...this.host.store.tickets.list()
      .filter(ticket => ticket.projectId === project.id).map(ticket => workerSessionId(ticket.id))]
    return expected.filter(sessionId => this.host.sessions.archivedSession(sessionId) === false)
  }
  private async unarchiveProject(sessionId: string): Promise<void> {
    const project = this.projectOf(sessionId)
    if (!project || project.status !== 'archived') return
    const restored = this.host.engine.unarchiveProject(project.id)
    this.unarchivedProjects.add(project.id)
    await this.host.sessions.unarchiveProject(restored)
  }
  private archiveWorker(sessionId: string): void {
    const ticketId = ticketOfSession(sessionId)
    if (!ticketId) return
    this.host.engine.workerSessionArchived(ticketId, sessionId)
  }
  private unarchiveWorker(sessionId: string): void {
    const ticketId = ticketOfSession(sessionId)
    if (!ticketId) return
    // A Project's own unarchive already restores every child Session; that is not a Worker restored by hand.
    const ticket = this.host.store.tickets.get(ticketId)
    if (ticket?.projectId && this.unarchivedProjects.has(ticket.projectId)) return
    this.host.engine.workerSessionUnarchived(ticketId, sessionId)
  }
  private projectOf(sessionId: string) {
    const projectId = projectOfSession(sessionId)
    return projectId === undefined ? undefined : this.host.store.projects.get(projectId)
  }
  private warn(detail: string): void {
    if (this.warned.has(detail)) return
    this.warned.add(detail)
    this.host.context.logger.warn('dsh-superagent: %s', detail)
  }
}
