// @vitest-environment jsdom
// The Project tab: the Project list, one Project's details, and its PM Session.
import { expect, it } from 'vitest'
import type { ProjectRow } from '../src/client/api.ts'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, find, tab, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const project: ProjectRow = {
  id: 'project-1', title: '设置站改版', goal: '让设置页更清楚', status: 'active', pmSessionId: 'pm-project-1', decisionId: 'd1',
  mandate: { projectId: 'project-1', goal: '让设置页更清楚', strength: 'explicit', scope: '让设置页更清楚',
    basis: { via: 'listed' }, actor: { source: 'main-session', id: 'dsh-user' } },
  tickets: [{ id: 'ticket-1', title: '修复页头', threads: [{ thread: 'github:41' }, { thread: 'github:42', context: true }],
    actions: { allowResume: false } }],
  latestReport: { summary: '已完成信息架构。', at: '2026-11-10T00:00:00Z' },
  createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
}

it('lists Projects, opens one, shows its goal and latest report, and opens its PM Session', async () => {
  server.projects = [project]
  await mount()
  await click(tab(zh['tab.project']))
  expect(tab(zh['tab.project']).getAttribute('aria-selected')).toBe('true')
  expect(text()).toContain(project.title)
  expect(text()).toContain(project.goal)
  await click(project.title)
  expect(text()).toContain(zh.projectGoal)
  expect(text()).toContain(zh.projectTickets)
  expect(text()).toContain('修复页头')
  expect(text()).toContain('github:41')
  expect(text()).toContain(`${zh.contextOnly}`)
  expect(text()).toContain(zh.projectLatestReport)
  expect(text()).toContain(project.latestReport!.summary)
  await click(zh.openPmSession)
  expect(server.opened).toEqual([project.pmSessionId])
})

it('offers Start / Retry PM Session and asks the host to reopen the PM Session', async () => {
  server.projects = [{ ...project, tickets: [...project.tickets] }]
  await mount()
  await click(tab(zh['tab.project']))
  await click(project.title)
  await click(zh.startPmSession)
  expect(server.startedPm).toBe(1)
  expect(server.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: 'projects/project-1/pm' }))
  // The entry stays available for another retry; project-init deduplication is the host's job.
  await click(zh.startPmSession)
  expect(server.startedPm).toBe(2)
})

it('pauses, resumes and stops a Project from its page, keeping the page readable afterwards', async () => {
  server.projects = [{ ...project, tickets: [...project.tickets] }]
  await mount()
  await click(tab(zh['tab.project']))
  await click(project.title)
  await click(zh.pauseProjectSoft)
  expect(server.projects[0]!.status).toBe('paused')
  expect(server.projects[0]!.pauseMode).toBe('soft')
  expect(text()).toContain(zh['projectStatus.paused'])
  expect(text()).toContain(zh['pauseMode.soft'])
  expect(server.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: 'projects/project-1/pause',
    body: { paused: true, mode: 'soft' } }))
  // A soft pause can be upgraded to hard after confirmation.
  await click(zh.pauseProjectHard)
  expect(text()).toContain(zh.pauseProjectHardTitle)
  await click(zh.confirm)
  expect(server.projects[0]!.pauseMode).toBe('hard')
  expect(text()).toContain(zh['pauseMode.hard'])
  expect(server.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: 'projects/project-1/pause',
    body: { paused: true, mode: 'hard' } }))
  await click(zh.resumeProject)
  expect(server.projects[0]!.status).toBe('active')
  expect(server.projects[0]!.pauseMode).toBeUndefined()
  expect(text()).toContain(zh['projectStatus.active'])
  // Stop asks for confirmation first, then ends the Project and keeps its page readable.
  await click(zh.stopProject)
  expect(text()).toContain(zh.stopProjectTitle)
  await click(zh.confirm)
  expect(server.projects[0]!.status).toBe('ended')
  expect(text()).toContain(zh['projectStatus.ended'])
  expect(text()).toContain(project.goal)
  expect(find(zh.openPmSession).textContent).toContain(zh.openPmSession)
  expect(server.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: 'projects/project-1/stop' }))
})

it('archives and unarchives a Project from its page', async () => {
  server.projects = [{ ...project, tickets: [...project.tickets] }]
  await mount()
  await click(tab(zh['tab.project']))
  await click(project.title)
  await click(zh.archiveProject)
  expect(server.projects[0]!.status).toBe('archived')
  expect(server.projects[0]!.archivedFrom).toBe('active')
  expect(text()).toContain(zh['projectStatus.archived'])
  expect(server.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: 'projects/project-1/archive' }))
  // The archived page offers Unarchive instead of Pause/Stop and stays readable.
  expect(text()).toContain(project.goal)
  await click(zh.unarchiveProject)
  expect(server.projects[0]!.status).toBe('active')
  expect(server.projects[0]!.archivedFrom).toBeUndefined()
  expect(text()).toContain(zh['projectStatus.active'])
  expect(server.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: 'projects/project-1/unarchive' }))
})
