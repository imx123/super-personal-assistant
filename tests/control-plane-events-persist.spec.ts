/**
 * The control plane's own event sequence.
 *
 * A node restarts and counts from 1 again, so the control plane keeps a sequence of its own: monotonic across its own
 * restarts, so a client that reconnects with the last id it saw receives exactly the events it missed. The node's own
 * counter is kept beside it, so a node restart stays visible instead of silently reusing a number.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ConsoleStore } from '../src/control/console-store.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import type { NodeEvent } from '../src/shared/protocol.ts'

const TOKEN = 'control-events-persist-token'
const SECRET = 'control-events-persist-secret'

let directory = ''
const opened: ControlPlane[] = []
const servers: ControlPlaneServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => {})
  for (const control of opened.splice(0)) await control.close().catch(() => {})
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

/** A control plane on the same files as the last one, as a restart would be. */
function open(fake: FakeNode): ControlPlane {
  const control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node: fake, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces') })
  opened.push(control)
  return control
}

/** A node of its own; each one counts its events from 1, as a restarted node does. */
function node(): FakeNode {
  return new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces') })
}

/** The trigger a Project is created from. */
function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: '2026-01-01T00:00:00.000Z', text: 'Build it',
    meta: {} }
}

describe('control-plane event persistence', () => {
  it('keeps its own sequence across a restart while the node counts from 1 again', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-events-persist-'))
    const first = open(node())
    await first.registerNode()
    const before = first.events.map(event => event.seq)
    expect(before).toEqual([1])

    await first.close()

    // A new node, whose own counter starts at 1 again, and a new control plane on the same files.
    const second = open(node())
    await second.registerNode()
    const after = second.events.map(event => event.seq)

    // The control plane's sequence did not go back: it continues where the log left off.
    expect(after[0]).toBeGreaterThan(before.at(-1)!)
    expect(after).toEqual([...after].sort((left, right) => left - right))
    // The node's own counter did go back, and the control plane kept it beside its own sequence.
    const recorded = second.events[0] as NodeEvent & { nodeSeq?: number }
    expect(recorded.nodeSeq).toBe(1)
  })

  it('serves the events a client missed across a restart, without a gap and without a repeat', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-events-resume-'))
    const first = open(node())
    await first.registerNode()
    const firstServer = new ControlPlaneServer(first, { token: TOKEN })
    servers.push(firstServer)
    const firstAddress = await firstServer.listen(0)
    const history = await (await fetch(`${firstAddress.url}/v1/events?after=0`,
      { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { events: NodeEvent[] }
    const lastId = history.events.at(-1)!.seq

    await firstServer.close()
    servers.length = 0
    await first.close()

    // The control plane comes back on the same files and records one more event.
    const second = open(node())
    await second.registerNode()
    const secondServer = new ControlPlaneServer(second, { token: TOKEN })
    servers.push(secondServer)
    const secondAddress = await secondServer.listen(0)

    const resumed = await (await fetch(`${secondAddress.url}/v1/events?after=${lastId}`,
      { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { events: NodeEvent[]; gap?: boolean }
    expect(resumed.gap).toBeUndefined()
    expect(resumed.events.length).toBeGreaterThan(0)
    // Every event is newer than the one the client had, and none of them repeats it.
    expect(resumed.events.every(event => event.seq > lastId)).toBe(true)
    expect(new Set(resumed.events.map(event => event.seq)).size).toBe(resumed.events.length)
    expect(resumed.events[0]!.seq).toBe(lastId + 1)
  })

  it('keeps the arguments of a tool call out of the log while keeping the call itself', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-events-args-'))
    const fake = node()
    const control = open(fake)
    await control.registerNode()
    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    const pm = await control.openProject(project.id)

    fake.simulateToolCall(pm.sessionId, 'control_create_tickets',
      { tasks: [{ title: 'x', apiKey: 'sk-not-a-real-key' }] })
    expect(control.events.some(event => event.type === 'tool.call')).toBe(true)

    const history = control.eventHistory(0)
    const call = history.events.find(event => event.type === 'tool.call')
    expect(call).toBeDefined()
    expect(JSON.stringify(call)).not.toContain('sk-not-a-real-key')
    const named = call as { tool?: string } | undefined
    expect(named?.tool).toBe('control_create_tickets')
  })

  it('reports the gap the bounded log leaves instead of hiding it', () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-events-gap-'))
    const store = new ConsoleStore(join(directory, 'console.sqlite'), { eventRows: 2 })
    try {
      for (let index = 0; index < 4; index += 1) {
        const seq = store.nextEventSeq()
        store.appendEvent({ seq, at: '2026-01-01T00:00:00.000Z', nodeId: 'local', sessionId: '', type: 'node.status',
          kind: '', payload: JSON.stringify({ seq }) })
      }
      // The log keeps two rows and drops the two oldest ones.
      store.prune('2026-01-01T00:00:00.000Z')

      const { rows, gapFrom } = store.eventsAfter(0, 10)
      expect(rows.map(row => row.seq)).toEqual([3, 4])
      expect(gapFrom).toBe(1)

      // A client that asks from the beginning is told about the hole; one that asks from the newest row is not.
      expect(store.eventsAfter(2, 10).gapFrom).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
