/** Project Profile list and detail read views: what the management API shows for the Projects the Router created. */
import type { ProjectProfile, Thread, Ticket } from '../../core/index.ts'
import type { Store } from '../store.ts'

/** A Project's Mandate without its internal Policy version hash. */
function mandateOf({ policyVersion: _version, ...mandate }: ProjectProfile['mandate']) { return mandate }
/** One child Ticket as a Project page lists it: its title and the external Threads it subscribes to. */
export interface ProjectTicketRow { id: string; title: string; threads: { thread: string; context?: true }[] }
/** A child Ticket's external Threads, marking those it follows for context only. */
function ticketThreads(ticket: Ticket, threads: readonly Thread[]): ProjectTicketRow['threads'] {
  return threads.filter(thread => thread.subscriptions.includes(ticket.id))
    .map(thread => ({ thread: thread.key, ...thread.context?.includes(ticket.id) ? { context: true as const } : {} }))
}
/** One Project row: its goal and state, its PM Session, the creating Decision, latest report, and child Tickets. */
export function projectRow(project: ProjectProfile, tickets: readonly Ticket[] = [], threads: readonly Thread[] = []) {
  const report = project.latestReport
  return { id: project.id, title: project.title, goal: project.goal, status: project.status,
    ...(project.archivedFrom ? { archivedFrom: project.archivedFrom } : {}),
    pmSessionId: project.pmSessionId,
    decisionId: project.decisionId, mandate: mandateOf(project.mandate),
    tickets: tickets.map(ticket => ({ id: ticket.id, title: ticket.title, threads: ticketThreads(ticket, threads) })),
    ...(project.pendingNotes?.length ? { pendingNotes: project.pendingNotes } : {}),
    ...(report ? { latestReport: { summary: report.summary, at: report.at } } : {}),
    createdAt: project.createdAt, updatedAt: project.updatedAt }
}
export type ProjectRow = ReturnType<typeof projectRow>
/** Every Project, newest first, each with its child Tickets. */
export function projectList(store: Pick<Store, 'projects' | 'tickets' | 'threads'>) {
  const projects = store.projects.list(), tickets = store.tickets.list(), threads = store.threads.list()
  return { items: projects.map(project => projectRow(project, tickets.filter(ticket => ticket.projectId === project.id), threads)), total: projects.length }
}
export type ProjectListView = ReturnType<typeof projectList>
/** One Project's page with its child Tickets, or undefined when no Project has that id. */
export function projectDetail(store: Pick<Store, 'projects' | 'tickets' | 'threads'>, id: string): ProjectRow | undefined {
  const project = store.projects.get(id)
  if (!project) return undefined
  return projectRow(project, store.tickets.list().filter(ticket => ticket.projectId === id), store.threads.list())
}
