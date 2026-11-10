/** Project Profile list and detail read views: what the management API shows for the Projects the Router created. */
import type { ProjectProfile } from '../../core/index.ts'
import type { Store } from '../store.ts'

/** A Project's Mandate without its internal Policy version hash. */
function mandateOf({ policyVersion: _version, ...mandate }: ProjectProfile['mandate']) { return mandate }
/** One Project row: its goal and state, its PM Session, the Decision that created it, and its latest report. */
export function projectRow(project: ProjectProfile) {
  const report = project.latestReport
  return { id: project.id, title: project.title, goal: project.goal, status: project.status, pmSessionId: project.pmSessionId,
    decisionId: project.decisionId, mandate: mandateOf(project.mandate),
    ...(report ? { latestReport: { summary: report.summary, at: report.at } } : {}),
    createdAt: project.createdAt, updatedAt: project.updatedAt }
}
export type ProjectRow = ReturnType<typeof projectRow>
/** Every Project, newest first. */
export function projectList(store: Pick<Store, 'projects'>) {
  const projects = store.projects.list()
  return { items: projects.map(projectRow), total: projects.length }
}
export type ProjectListView = ReturnType<typeof projectList>
/** One Project's page, or undefined when no Project has that id. */
export function projectDetail(store: Pick<Store, 'projects'>, id: string): ProjectRow | undefined {
  const project = store.projects.get(id)
  return project ? projectRow(project) : undefined
}
