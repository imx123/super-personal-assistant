// @vitest-environment jsdom
// The Project tab: the Project list, one Project's details, and its PM Session.
import { expect, it } from 'vitest'
import type { ProjectRow } from '../src/client/api.ts'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, tab, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const project: ProjectRow = {
  id: 'project-1', title: '设置站改版', goal: '让设置页更清楚', status: 'active', pmSessionId: 'pm-project-1', decisionId: 'd1',
  mandate: { projectId: 'project-1', goal: '让设置页更清楚', strength: 'explicit', scope: '让设置页更清楚',
    basis: { via: 'listed' }, actor: { source: 'main-session', id: 'dsh-user' } },
  tickets: [{ id: 'ticket-1', title: '修复页头', threads: [{ thread: 'github:41' }, { thread: 'github:42', context: true }] }],
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
