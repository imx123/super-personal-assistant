/**
 * The console's memory page.
 *
 * The page names what the control plane can see and what it cannot. A capability the control plane does not have is named
 * as absent: the durable history index and the candidate queue do not exist yet, and the console's own log is bounded and
 * must never be shown as a history that can be read back in full.
 */
import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConsoleProject, LiveStateSnapshot, Overview } from '../src/console/api.ts'
import { EventHistoryPanel, LiveStatePanel, LongTermMemoryPanel, MemoryHead } from '../src/console/memory.tsx'

/** The control plane's own snapshot, as the shell reads it. */
const overview = (over: Partial<Overview> = {}): Overview => ({
  at: '2026-11-19T08:00:00.000Z',
  runningTickets: 2,
  runningWorkers: 1,
  pendingReviews: 1,
  features: { router: true, schedules: true },
  schedules: { plans: 0, enabled: 0, failed: 0, interrupted: 0, delivered: 0 },
  counts: { projects: 1, tickets: 3, sessions: 4, nodes: 1 },
  nodes: [{ nodeId: 'local', backend: 'dsh', version: '0.1.0', online: true, at: '2026-11-19T08:00:00.000Z' }],
  events: { seq: 120, retained: 100 },
  audit: { entries: 7 },
  retention: { eventDays: 7, eventRows: 20000, auditDays: 0 },
  ...over,
})

/** The live state the control plane answered with, as the console reads it. */
const liveState = (over: Partial<LiveStateSnapshot> = {}): LiveStateSnapshot => ({
  at: '2026-11-19T08:05:00.000Z',
  audience: 'operator',
  nodes: { rows: [{ nodeId: 'local', isPrimary: true, connection: 'online', lastSeenAt: '2026-11-19T08:04:00.000Z',
    backends: [{ backendId: 'dsh', kind: 'dsh', availability: 'available',
      capabilities: { turnInterrupt: true, twoStageReceipt: false, sessionResume: true, gitReviewDiff: true } }] }],
    total: 1, omitted: 0 },
  projects: { rows: [{ projectId: 'p1', title: '控制台改造', status: 'active', pmSessionId: 'pm-p1',
    updatedAt: '2026-11-19T07:30:00.000Z' }], total: 1, omitted: 0 },
  tickets: { rows: [{ ticketId: 't1', title: '记忆页', projectId: 'p1', status: 'running', assignmentId: 'a1',
    updatedAt: '2026-11-19T07:30:00.000Z' }], total: 1, omitted: 0 },
  assignments: { rows: [{ assignmentId: 'a1', ticketId: 't1', state: 'running', sessionId: 'worker-a1',
    reportState: 'progress', epoch: 1 }], total: 1, omitted: 0 },
  sessions: { rows: [{ sessionId: 'worker-a1', role: 'worker', status: 'running', projectId: 'p1', ticketId: 't1',
    assignmentId: 'a1', nodeId: 'local', updatedAt: '2026-11-19T07:30:00.000Z' }], total: 1, omitted: 0 },
  schedules: { rows: [{ planId: 's1', projectId: 'p1', name: '每夜巡检', rule: 'daily:02:00', enabled: true,
    nextAt: '2026-11-20T02:00:00.000Z' }], total: 1, omitted: 0 },
  ...over,
})

/** One Project of the business store, with a Ticket of its own. */
const project: ConsoleProject = {
  id: 'p1',
  title: '控制台改造',
  goal: '让操作员看得到状态',
  workspace: '/workspaces/p1',
  status: 'active',
  pmSessionId: 'pm-1',
  createdAt: '2026-11-19T07:00:00.000Z',
  updatedAt: '2026-11-19T07:30:00.000Z',
  tickets: [{ id: 't1', title: '记忆页', status: 'running' }],
}

const html = (element: ReactElement): string => renderToStaticMarkup(element)

/** The history panel with the facts a control plane that answered would give it. */
const history = (over: Partial<ComponentProps<typeof EventHistoryPanel>> = {}): ReactElement =>
  createElement(EventHistoryPanel, {
    projects: { state: 'ready', rows: [] },
    events: { state: 'ready', rows: [] },
    gap: false,
    retained: 100,
    retention: { eventDays: 7, eventRows: 20000, auditDays: 0 },
    onOpenProject: () => {},
    ...over,
  })

describe('the memory page', () => {
  it('says when the facts were read and whether the stream is carrying new ones', () => {
    const connected = html(createElement(MemoryHead, { overview: overview(), stream: 'connected', refresh: () => {} }))
    expect(connected).toContain('读取时间')
    expect(connected).toContain('2026')
    expect(connected).toContain('事件流已连接')

    const reconnecting = html(createElement(MemoryHead, { overview: overview(), stream: 'reconnecting', refresh: () => {} }))
    expect(reconnecting).toContain('事件流重连中')
    expect(reconnecting).not.toContain('事件流已连接')

    const unknown = html(createElement(MemoryHead, { overview: undefined, stream: undefined, refresh: () => {} }))
    expect(unknown).toContain('事件流状态未知')
  })

  it('shows the live state the control plane answered with', () => {
    const page = html(createElement(LiveStatePanel, { snapshot: liveState(), navigate: () => {} }))
    expect(page).toContain('取样时间')
    expect(page).toContain('在线')
    expect(page).toContain('local')
    expect(page).toContain('控制台改造')
    expect(page).toContain('记忆页')
    expect(page).toContain('每夜巡检')
  })

  it('says that a read which has not answered is not an empty state', () => {
    const page = html(createElement(LiveStatePanel, { navigate: () => {} }))
    expect(page).toContain('正在读取实时状态')
    expect(page).not.toContain('控制面还没有登记任何节点')
  })

  it('says that a node it never heard of is unknown, not offline', () => {
    const page = html(createElement(LiveStatePanel, {
      snapshot: liveState({ nodes: { rows: [], total: 0, omitted: 0 } }),
      navigate: () => {},
    }))
    expect(page).toContain('控制面还没有登记任何节点')
    expect(page).not.toContain('离线')
  })

  it('says a node it cannot place is of an unknown state, not an online one', () => {
    const page = html(createElement(LiveStatePanel, {
      snapshot: liveState({ nodes: { rows: [{ nodeId: 'other', isPrimary: false, connection: 'unknown',
        backends: [{ backendId: 'dsh', kind: 'dsh', availability: 'unknown',
          capabilities: { turnInterrupt: false, twoStageReceipt: false, sessionResume: false, gitReviewDiff: false } }] }],
        total: 1, omitted: 0 } }),
      navigate: () => {},
    }))
    expect(page).toContain('状态未知')
    expect(page).not.toContain('在线')
  })

  it('never leaves an old value looking like the present one after a failed read', () => {
    const page = html(createElement(LiveStatePanel, { snapshot: liveState(), error: 'HTTP 500', navigate: () => {} }))
    expect(page).toContain('读取实时状态失败')
    expect(page).toContain('不是现在的状态')
    expect(page).toContain('刷新')
  })

  it('says the facts may not be the newest while the event stream is not connected', () => {
    const page = html(createElement(LiveStatePanel, { snapshot: liveState(), stream: 'reconnecting', navigate: () => {} }))
    expect(page).toContain('事件流未连接')
    expect(page).toContain('可能不是最新的')
  })

  it('says how many rows a cut list left out', () => {
    const page = html(createElement(LiveStatePanel, {
      snapshot: liveState({ tickets: { rows: [{ ticketId: 't1', title: '记忆页', status: 'running',
        updatedAt: '2026-11-19T07:30:00.000Z' }], total: 12, omitted: 11 } }),
      navigate: () => {},
    }))
    expect(page).toContain('另有 11 条没有显示')
    expect(page).toContain('共 12 条')
  })

  it('offers a way into the work it lists', () => {
    const page = html(createElement(LiveStatePanel, { snapshot: liveState(), navigate: () => {} }))
    expect(page).toContain('打开')
    expect(page).toContain('去项目')
    expect(page).toContain('去节点部署')
  })

  it('shows the Projects of the business store and offers to open one of them', () => {
    const page = html(history({ projects: { state: 'ready', rows: [project] } }))
    expect(page).toContain('控制台改造')
    expect(page).toContain('1 个工单')
    expect(page).toContain('打开')
  })

  it('names the console log as a bounded log and says how much of it is left', () => {
    const page = html(history())
    expect(page).toContain('不是持久历史')
    expect(page).toContain('最多保留 20000 行 / 7 天')
    expect(page).toContain('现在保留 100 行')
    expect(page).toContain('永久保留')
  })

  it('does not guess how many rows were dropped', () => {
    const page = html(history())
    expect(page).not.toMatch(/\d+ 行已经被裁掉/)
  })

  it('reports a hole in front of the log instead of hiding it', () => {
    const page = html(history({ gap: true }))
    expect(page).toContain('这段之前的事件已被裁剪，无法补读')
  })

  it('shows no gap when the control plane did not report one', () => {
    const page = html(history({ gap: false }))
    expect(page).not.toContain('无法补读')
  })

  it('says that a read which has not answered is not an empty list', () => {
    const page = html(history({
      projects: { state: 'pending' },
      events: { state: 'pending' },
    }))
    expect(page).toContain('正在读取项目')
    expect(page).toContain('正在读取事件日志')
    expect(page).not.toContain('还没有项目')
    expect(page).not.toContain('暂时没有可读的记录')
  })

  it('shows why a read failed instead of an empty list', () => {
    const page = html(history({
      projects: { state: 'error', error: 'HTTP 500' },
      events: { state: 'error', error: 'HTTP 500' },
    }))
    expect(page).toContain('HTTP 500')
    expect(page).not.toContain('还没有项目')
  })

  it('shows at most the last twelve rows of the log', () => {
    const events = Array.from({ length: 20 }, (_, index) => ({
      seq: index + 1,
      at: '2026-11-19T08:00:00.000Z',
      type: 'session.event',
      kind: 'message',
      sessionId: 's1',
      nodeId: 'local',
    }))
    const page = html(history({ events: { state: 'ready', rows: events } }))
    expect(page).toContain('序号 20')
    expect(page).not.toContain('序号 8')
  })

  it('says that the long-term memory does not exist yet and points at the manual notes', () => {
    const page = html(createElement(LongTermMemoryPanel, { onOpenProjects: () => {} }))
    expect(page).toContain('长期记忆服务与候选队列还没有建立')
    expect(page).toContain('项目 › 项目备忘')
    expect(page).toContain('去项目页记一笔')
  })

  it('does not repeat the five objects of the memory system in the console', () => {
    const page = html(createElement(LongTermMemoryPanel, { onOpenProjects: () => {} }))
    expect(page).not.toContain('五类对象')
    expect(page).not.toContain('P5-')
  })
})
