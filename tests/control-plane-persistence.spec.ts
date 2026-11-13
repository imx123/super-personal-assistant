import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { KV } from '../src/kv.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { verifySessionToken } from '../src/shared/session-token.ts'

const SECRET = 'control-persistence-secret'

let directory = ''
let node: FakeNode
const opened: ControlPlane[] = []

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: '2026-01-01T00:00:00.000Z', text: 'Build it',
    meta: {} }
}

function open(): ControlPlane {
  const control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces') })
  opened.push(control)
  return control
}

/** The kernel's in-memory tokens are private and must never reach the Store; tests read them only to prove re-issue. */
function memoryTokens(control: ControlPlane): Map<string, string> {
  return (control as unknown as { tokens: Map<string, string> }).tokens
}

afterEach(async () => {
  for (const control of opened.splice(0)) await control.close().catch(() => {})
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane Session persistence', () => {
  it('writes Sessions to the Store KV area and reloads them after a restart', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-control-persist-'))
    node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces') })
    const first = open()
    await first.registerNode()
    first.store.triggers.save(trigger())
    const project = first.createProject('trigger-1', 'Project', 'Goal')
    const pm = await first.openProject(project.id)
    const worker = await first.createWorkerSession(project.id, 'assignment-1', 'ticket-1', 'Do the work')
    await first.sendMessage(pm.sessionId, 'hello')

    expect(first.store.keys(KV.control.session)).toEqual(expect.arrayContaining([
      KV.control.session(pm.sessionId), KV.control.session(worker.sessionId)]))
    const stored = first.store.get(KV.control.session(pm.sessionId))
    expect(stored).toMatchObject({ sessionId: pm.sessionId, projectId: project.id, role: 'pm', status: 'idle' })
    expect(JSON.stringify(stored)).not.toContain(node.tokens.get(pm.sessionId))
    await first.close()

    const second = open()
    expect(second.state().sessions).toHaveLength(2)
    expect(second.session(pm.sessionId)).toMatchObject({ sessionId: pm.sessionId, projectId: project.id, role: 'pm',
      status: 'idle', workspace: pm.workspace, toolProfile: pm.toolProfile })
    expect(second.session(worker.sessionId)).toMatchObject({ sessionId: worker.sessionId, projectId: project.id,
      assignmentId: 'assignment-1', role: 'worker', status: 'idle', workspace: worker.workspace })
  })

  it('re-issues a token for a loaded Session and keeps its archived status across restarts', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-control-persist-'))
    node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces') })
    const first = open()
    await first.registerNode()
    first.store.triggers.save(trigger())
    const project = first.createProject('trigger-1', 'Project', 'Goal')
    const pm = await first.openProject(project.id)
    await first.close()

    const second = open()
    expect(second.session(pm.sessionId)?.status).toBe('idle')
    expect(memoryTokens(second).size).toBe(0)
    await second.sendMessage(pm.sessionId, 'after restart')
    expect(node.messages.get(pm.sessionId)).toEqual(['after restart'])
    const token = memoryTokens(second).get(pm.sessionId)
    expect(token).toBeTruthy()
    expect(verifySessionToken(token!, SECRET)).toMatchObject({ sid: pm.sessionId, pid: project.id, role: 'pm' })

    await second.archiveSession(pm.sessionId)
    expect(second.session(pm.sessionId)).toMatchObject({ status: 'archived', archivedAt: expect.any(String) })
    await second.close()

    const third = open()
    expect(third.state().sessions).toHaveLength(1)
    expect(third.session(pm.sessionId)).toMatchObject({ status: 'archived', archivedAt: expect.any(String) })
    await expect(third.sendMessage(pm.sessionId, 'too late')).rejects.toThrow(/not running/)
  })
})
