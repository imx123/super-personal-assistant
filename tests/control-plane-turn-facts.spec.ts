import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { NODE_PROTOCOL_VERSION, type NodeEvent, type NodePort } from '../src/shared/protocol.ts'

const START = '2026-01-01T00:00:00.000Z'
let directory = ''
let control: ControlPlane | undefined

/** A FakeNode that also lets a test publish node events into the control plane. */
class EventNode implements NodePort {
  private readonly listeners = new Set<(event: NodeEvent) => void>()
  private readonly unsubscribers: (() => void)[] = []
  constructor(private readonly inner: FakeNode) {
    this.unsubscribers.push(inner.subscribe(event => { for (const listener of this.listeners) listener(event) }))
  }
  send(command: Parameters<NodePort['send']>[0]): Promise<void> { return this.inner.send(command) }
  subscribe(listener: (event: NodeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(event: NodeEvent): void { for (const listener of this.listeners) listener(event) }
  close(): void { for (const unsubscribe of this.unsubscribers) unsubscribe() }
}

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

afterEach(async () => {
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane turn facts', () => {
  it('writes a Worker turn-end onto the current Assignment and ignores a replaced Assignment', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-turn-'))
    const inner = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces'), now: () => START })
    const node = new EventNode(inner)
    control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node,
      secret: 'turn-secret', workspaceRoot: join(directory, 'workspaces'), now: () => START, confirmationTimeoutMs: 50 })
    await control.registerNode()
    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    const pm = await control.openProject(project.id)
    const [ticket] = control.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Turn', goal: 'Do it' }])
    await until(() => control!.store.tickets.get(ticket!.id)?.assignments.at(-1)?.state === 'running', 'worker start')
    const assignment = control.store.tickets.get(ticket!.id)!.assignments.at(-1)!
    const sessionId = `worker-${assignment.id}`

    node.emit({ type: 'session.event', protocolVersion: NODE_PROTOCOL_VERSION, nodeId: 'local', sessionId,
      projectId: project.id, assignmentId: assignment.id, role: 'worker', seq: 1, at: START, kind: 'turn-end', data: {} })
    expect(control.store.tickets.get(ticket!.id)?.assignments.at(-1)?.idleAt).toBeTruthy()

    const before = control.store.tickets.get(ticket!.id)!.assignments.at(-1)!.idleAt
    node.emit({ type: 'session.event', protocolVersion: NODE_PROTOCOL_VERSION, nodeId: 'local', sessionId,
      projectId: project.id, assignmentId: 'replaced-assignment', role: 'worker', seq: 2, at: START, kind: 'turn-end', data: {} })
    expect(control.store.tickets.get(ticket!.id)?.assignments.at(-1)?.idleAt).toBe(before)
  })
})
