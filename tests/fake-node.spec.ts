import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FakeNode } from '../src/node/fake-node.ts'
import {
  NODE_PROTOCOL_VERSION,
  type NodeCommand,
  type NodeEvent,
  type NodeRegistration,
  type NodeStatus,
  type RoleProfile,
} from '../src/shared/protocol.ts'

const NODE_ID = 'fake-node-1'
const NOW = '2026-01-01T00:00:00.000Z'

const PM_PROFILE: RoleProfile = {
  name: 'pm-profile',
  prompt: 'Coordinate the project.',
  tools: ['ticket.read', 'ticket.write'],
  deny: ['terminal'],
  permission: 'workspace-write',
}

const WORKER_PROFILE: RoleProfile = {
  name: 'worker-profile',
  prompt: 'Do the assigned work.',
  tools: ['fs.read', 'fs.write'],
  deny: [],
  permission: 'workspace-write',
}

const REGISTRATION: NodeRegistration = {
  protocolVersion: NODE_PROTOCOL_VERSION,
  nodeId: NODE_ID,
  backend: 'dsh',
  version: '0.0.0-test',
  capabilities: ['sessions'],
}

const ONLINE_STATUS: NodeStatus = {
  nodeId: NODE_ID,
  backend: 'dsh',
  version: '0.0.0-test',
  online: true,
  at: NOW,
  capabilities: ['sessions'],
}

let root = ''
let node: FakeNode
let keyCounter = 0

function envelope(label: string) {
  keyCounter += 1
  return {
    protocolVersion: NODE_PROTOCOL_VERSION,
    nodeId: NODE_ID,
    idempotencyKey: `${label}-${keyCounter}`,
    at: NOW,
  } as const
}

function prepareWorkspace(name: string): string {
  const workspace = join(root, name)
  mkdirSync(workspace, { recursive: true })
  return workspace
}

async function createPm(sessionId = 'pm-1', workspace = prepareWorkspace(sessionId)): Promise<string> {
  await node.send({
    ...envelope(`pm-${sessionId}`),
    type: 'pm.ensure',
    sessionId,
    project: { id: 'project-1', title: 'Test project', goal: 'Test the fake node' },
    workspace,
    profile: PM_PROFILE,
    sessionToken: `token-${sessionId}`,
    prompt: 'Coordinate the test project.',
  })
  return workspace
}

async function createWorker(
  sessionId = 'worker-1',
  assignmentId = 'assignment-1',
  workspace = prepareWorkspace(sessionId),
): Promise<string> {
  await node.send({
    ...envelope(`worker-${sessionId}`),
    type: 'worker.create',
    sessionId,
    projectId: 'project-1',
    assignmentId,
    ticketId: 'ticket-1',
    workspace,
    profile: WORKER_PROFILE,
    sessionToken: `token-${sessionId}`,
    prompt: 'Do the test work.',
  })
  return workspace
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'superagent-fake-node-'))
  keyCounter = 0
  node = new FakeNode({ nodeId: NODE_ID, root, now: () => NOW })
})

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('FakeNode', () => {
  it('emits node.status for register and heartbeat with increasing seq', async () => {
    const seen: NodeEvent[] = []
    const unsubscribe = node.subscribe(event => seen.push(event))

    await node.send({
      ...envelope('register'),
      type: 'node.register',
      registration: REGISTRATION,
    })
    await node.send({
      ...envelope('heartbeat'),
      type: 'node.heartbeat',
      status: { ...ONLINE_STATUS, online: false },
    })

    expect(node.registrations).toEqual([REGISTRATION])
    expect(node.events.map(event => event.seq)).toEqual([1, 2])
    expect(node.events[0]).toMatchObject({
      type: 'node.status',
      nodeId: NODE_ID,
      sessionId: '',
      projectId: '',
      status: { online: true },
    })
    expect(node.events[1]).toMatchObject({
      type: 'node.status',
      status: { online: false },
    })
    expect(seen.map(event => event.seq)).toEqual([1, 2])

    unsubscribe()
    await node.send({
      ...envelope('heartbeat-after-unsubscribe'),
      type: 'node.heartbeat',
      status: ONLINE_STATUS,
    })
    expect(seen.map(event => event.seq)).toEqual([1, 2])
  })

  it('creates a workspace under root and rejects path escapes', async () => {
    const workspace = join(root, 'project-a')
    await node.send({
      ...envelope('ensure-a'),
      type: 'workspace.ensure',
      projectId: 'project-a',
      workspace,
    })

    expect(existsSync(workspace)).toBe(true)
    expect(node.workspaces.get('project-a')).toBe(workspace)

    const bound = join(root, 'project-b')
    await node.send({
      ...envelope('bind-b'),
      type: 'project.bind',
      projectId: 'project-b',
      workspace: bound,
    })
    expect(node.workspaces.get('project-b')).toBe(bound)

    await expect(node.send({
      ...envelope('ensure-escape'),
      type: 'workspace.ensure',
      projectId: 'escape',
      workspace: join(root, '..', 'escaped-workspace'),
    })).rejects.toThrow(/escapes node root/)
    expect(node.workspaces.has('escape')).toBe(false)
  })

  it('creates an idle PM session, saves its token and emits session.status', async () => {
    const workspace = await createPm()

    expect(node.sessions.get('pm-1')).toMatchObject({
      sessionId: 'pm-1',
      backendSessionId: 'fake-pm-1',
      projectId: 'project-1',
      role: 'pm',
      nodeId: NODE_ID,
      workspace,
      status: 'idle',
      toolProfile: 'pm-profile',
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(node.tokens.get('pm-1')).toBe('token-pm-1')

    const idle = node.events.find(event => (
      event.type === 'session.status'
      && event.sessionId === 'pm-1'
      && event.status === 'idle'
    ))
    expect(idle).toMatchObject({
      type: 'session.status',
      sessionId: 'pm-1',
      projectId: 'project-1',
      role: 'pm',
      status: 'idle',
    })
  })

  it('creates a worker session and keeps its assignmentId', async () => {
    const workspace = await createWorker('worker-1', 'assignment-9')

    expect(node.sessions.get('worker-1')).toMatchObject({
      sessionId: 'worker-1',
      projectId: 'project-1',
      assignmentId: 'assignment-9',
      role: 'worker',
      workspace,
      status: 'idle',
      toolProfile: 'worker-profile',
    })
    expect(node.tokens.get('worker-1')).toBe('token-worker-1')

    const idle = node.events.find(event => (
      event.type === 'session.status'
      && event.sessionId === 'worker-1'
      && event.status === 'idle'
    ))
    expect(idle).toMatchObject({
      sessionId: 'worker-1',
      projectId: 'project-1',
      assignmentId: 'assignment-9',
      role: 'worker',
      status: 'idle',
    })
  })

  it('emits running, message and idle events for session.message', async () => {
    await createPm()
    const before = node.events.length

    await node.send({
      ...envelope('message'),
      type: 'session.message',
      sessionId: 'pm-1',
      text: 'hello node',
    })

    const emitted = node.events.slice(before)
    expect(emitted).toHaveLength(3)
    expect(emitted[0]).toMatchObject({ type: 'session.status', status: 'running' })
    expect(emitted[1]).toMatchObject({
      type: 'session.event',
      kind: 'message',
      data: { text: 'hello node' },
      sessionId: 'pm-1',
      role: 'pm',
    })
    expect(emitted[2]).toMatchObject({ type: 'session.status', status: 'idle' })
    expect(node.messages.get('pm-1')).toEqual(['hello node'])
    expect(node.sessions.get('pm-1')?.status).toBe('idle')
  })

  it('executes a repeated idempotencyKey at most once', async () => {
    await createPm()
    const before = node.events.length
    const command: NodeCommand = {
      ...envelope('same-message'),
      type: 'session.message',
      sessionId: 'pm-1',
      text: 'only once',
    }

    await node.send(command)
    await node.send(command)

    expect(node.messages.get('pm-1')).toEqual(['only once'])
    expect(node.events).toHaveLength(before + 3)
    expect(node.commands.filter(item => item.idempotencyKey === command.idempotencyKey)).toHaveLength(1)
  })

  it('cancels and archives a session, and rejects messages afterwards', async () => {
    await createPm()

    const afterCreate = node.events.length
    await node.send({
      ...envelope('cancel'),
      type: 'session.cancel',
      sessionId: 'pm-1',
    })
    expect(node.sessions.get('pm-1')?.status).toBe('stopped')
    expect(node.events).toHaveLength(afterCreate + 1)

    const afterCancel = node.events.length
    await node.send({
      ...envelope('cancel-again'),
      type: 'session.cancel',
      sessionId: 'pm-1',
    })
    expect(node.sessions.get('pm-1')?.status).toBe('stopped')
    expect(node.events).toHaveLength(afterCancel)

    await node.send({
      ...envelope('archive'),
      type: 'session.archive',
      sessionId: 'pm-1',
    })
    expect(node.sessions.get('pm-1')).toMatchObject({
      status: 'archived',
      archivedAt: NOW,
      updatedAt: NOW,
    })
    expect(node.events.at(-1)).toMatchObject({
      type: 'session.status',
      sessionId: 'pm-1',
      status: 'archived',
    })

    await expect(node.send({
      ...envelope('message-after-archive'),
      type: 'session.message',
      sessionId: 'pm-1',
      text: 'too late',
    })).rejects.toThrow(/archived/)
    expect(node.messages.has('pm-1')).toBe(false)
  })

  it('stores a permission and emits the permission notice', async () => {
    await createPm()
    const before = node.events.length

    await node.send({
      ...envelope('permission'),
      type: 'permission.set',
      sessionId: 'pm-1',
      permission: 'read-only',
    })

    expect(node.permissions.get('pm-1')).toBe('read-only')
    expect(node.events).toHaveLength(before + 1)
    expect(node.events.at(-1)).toMatchObject({
      type: 'session.event',
      kind: 'message',
      data: { text: 'permission:read-only' },
      sessionId: 'pm-1',
      projectId: 'project-1',
      role: 'pm',
    })
  })

  it('emits a tool.call for simulateToolCall with the session token available', async () => {
    await createPm()
    const before = node.events.length

    node.simulateToolCall('pm-1', 'fs.read', { path: 'README.md' })

    expect(node.events).toHaveLength(before + 1)
    const event = node.events.at(-1)
    expect(event).toMatchObject({
      type: 'tool.call',
      tool: 'fs.read',
      args: { path: 'README.md' },
      sessionId: 'pm-1',
      projectId: 'project-1',
      role: 'pm',
    })
    if (event?.type === 'tool.call') {
      expect(event.toolCallId).toBe(`fake-tool-${event.seq}`)
    }
    expect(node.tokens.get('pm-1')).toBe('token-pm-1')

    expect(() => node.simulateToolCall('missing', 'fs.read', {})).toThrow(/unknown session/)
  })
})
