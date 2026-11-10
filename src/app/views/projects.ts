/** Project Profile list and detail read views: what the management API shows for the Projects the Router created. */
import type { Handoff, ManualStop, ProjectProfile, Thread, Ticket } from '../../core/index.ts'
import type { Store } from '../store.ts'

/** A Project's Mandate without its internal Policy version hash. */
function mandateOf({ policyVersion: _version, ...mandate }: ProjectProfile['mandate']) { return mandate }
/** One incoming cross-Project handoff request a Project's PM may accept or reject. */
export interface ProjectHandoffRow { handoff_id: string; at: string; ticket_id: string; title: string; project_id?: string
  reason?: string; summary: string; unfinished?: string[]; request?: Handoff['request'] }
/** One child Ticket as a Project page lists it: its title, the external Threads it subscribes to, and its manual stop. */
export interface ProjectTicketRow { id: string; title: string; threads: { thread: string; context?: true }[]
  /** A person's stop of its Worker, which the page shows with the action that clears or revives it. */
  manualStop?: ManualStop
  actions: { allowResume: boolean } }
/** A child Ticket's external Threads, marking those it follows for context only. */
function ticketThreads(ticket: Ticket, threads: readonly Thread[]): ProjectTicketRow['threads'] {
  return threads.filter(thread => thread.subscriptions.includes(ticket.id))
    .map(thread => ({ thread: thread.key, ...thread.context?.includes(ticket.id) ? { context: true as const } : {} }))
}
/** One Project row: its goal and state, its PM Session, the creating Decision, latest report, child Tickets, and pending handoffs. */
export function projectRow(project: ProjectProfile, tickets: readonly Ticket[] = [], threads: readonly Thread[] = [],
  handoffRequests: readonly ProjectHandoffRow[] = []) {
  const report = project.latestReport
  return { id: project.id, title: project.title, goal: project.goal, status: project.status,
    ...(project.pauseMode ? { pauseMode: project.pauseMode } : {}),
    ...(project.archivedFrom ? { archivedFrom: project.archivedFrom } : {}),
    pmSessionId: project.pmSessionId,
    decisionId: project.decisionId, mandate: mandateOf(project.mandate),
    tickets: tickets.map(ticket => ({ id: ticket.id, title: ticket.title, threads: ticketThreads(ticket, threads),
      ...ticket.manualStop ? { manualStop: ticket.manualStop } : {},
      actions: { allowResume: ticket.manualStop?.scope === 'worker' } })),
    ...(handoffRequests.length ? { handoffRequests } : {}),
    ...(project.pendingNotes?.length ? { pendingNotes: project.pendingNotes } : {}),
    ...(report ? { latestReport: { summary: report.summary, at: report.at } } : {}),
    createdAt: project.createdAt, updatedAt: project.updatedAt }
}
export type ProjectRow = ReturnType<typeof projectRow>
/** Cross-Project handoff requests this Project's PM has not decided yet, read from the source Tickets that hold them. */
function pendingHandoffs(store: Pick<Store, 'tickets'>, projectId: string): ProjectHandoffRow[] {
  return store.tickets.list().flatMap(ticket => (ticket.handoffs ?? [])
    .filter(handoff => handoff.kind === 'split' && handoff.status === 'pending' && handoff.to.projectId === projectId)
    .map(handoff => ({ handoff_id: handoff.id, at: handoff.at, ticket_id: ticket.id, title: ticket.title, project_id: ticket.projectId,
      ...handoff.reason ? { reason: handoff.reason } : {}, summary: handoff.summary,
      ...handoff.unfinished?.length ? { unfinished: handoff.unfinished } : {}, ...handoff.request ? { request: handoff.request } : {} })))
}
/** Every Project, newest first, each with its child Tickets. */
export function projectList(store: Pick<Store, 'projects' | 'tickets' | 'threads'>) {
  const projects = store.projects.list(), tickets = store.tickets.list(), threads = store.threads.list()
  return { items: projects.map(project => projectRow(project, tickets.filter(ticket => ticket.projectId === project.id), threads,
    pendingHandoffs(store, project.id))), total: projects.length }
}
export type ProjectListView = ReturnType<typeof projectList>
/** One Project's page with its child Tickets, or undefined when no Project has that id. */
export function projectDetail(store: Pick<Store, 'projects' | 'tickets' | 'threads'>, id: string): ProjectRow | undefined {
  const project = store.projects.get(id)
  if (!project) return undefined
  return projectRow(project, store.tickets.list().filter(ticket => ticket.projectId === id), store.threads.list(), pendingHandoffs(store, id))
}
