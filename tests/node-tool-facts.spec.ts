/**
 * The facts the node reports about the tool calls its backend made.
 *
 * A digest of a Session's activity is built from facts, never from a guess: the node pairs the call the backend made with
 * the result that answers it, and reports the tool's name, how the call ended and — for a call that changed a file
 * inside the Session's own workspace — the relative path it changed.
 *
 * The arguments of a call and the output of a tool never leave the node. A path is resolved against the workspace the
 * Session really works in, and a path that leaves it is left out: a digest may name a place in the work, never a place
 * on the machine.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WORKER_PROFILE } from '../src/control/roles.ts'
import type { DshPortEvent, DshPortHost } from '../src/node/dsh-port.ts'
import { createDshPortHost } from '../src/node/dsh-port-host.ts'

/** A Cordis-like context that remembers the handlers the host registered. */
class FakeContext {
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  readonly agents = { get: () => undefined }
  readonly workspaceRegistry = { async archiveSession() {} }

  on(event: string, handler: (...args: unknown[]) => void): () => void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {
      const current = this.handlers.get(event) ?? []
      this.handlers.set(event, current.filter(entry => entry !== handler))
    }
  }

  /** Deliver one event to the handlers that wait for it. */
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }
}

type EnsureInput = Parameters<DshPortHost['ensureSession']>[0]

let directory = ''
let root = ''
let context: FakeContext

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-node-facts-'))
  root = join(directory, 'node')
  mkdirSync(root, { recursive: true })
  context = new FakeContext()
})

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

/** A host over a fake Agent, with the events it publishes collected. */
function harness(): { host: DshPortHost; events: DshPortEvent[] } {
  const agent = { session: { id: 'worker-1' } }
  const sessions = {
    async ensure() { return agent },
    async prompt() {},
  }
  // No control URL: the host installs no control-plane tools, so a minimal Agent is enough for the facts.
  const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: 'node-1', root })
  const events: DshPortEvent[] = []
  host.onEvent(event => { events.push(event) })
  return { host, events }
}

/** An ensure command for a Worker, with the profile's real tool list. */
function workerInput(overrides: Partial<EnsureInput> = {}): EnsureInput {
  return { sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
    profile: WORKER_PROFILE, prompt: WORKER_PROFILE.prompt, sessionToken: 'worker-token', ticketId: 'ticket-1',
    assignmentId: 'assignment-1', ...overrides }
}

/** The one Session event the backend reports, as the host reads it. */
function sessionEvent(type: string, data: unknown): void {
  context.fire('session/event', { id: 'worker-1' }, { type, data })
}

/** The tool facts the host published. */
function factsOf(events: DshPortEvent[]): { toolName: string; outcome: string; callId: string; turnId?: string;
  changedPaths?: readonly string[] }[] {
  const facts: { toolName: string; outcome: string; callId: string; turnId?: string
    changedPaths?: readonly string[] }[] = []
  for (const event of events) {
    if (event.type !== 'tool.fact') continue
    const fact = event.fact
    facts.push({
      toolName: fact.toolName,
      outcome: fact.outcome,
      callId: fact.callId,
      ...(fact.turnId === undefined ? {} : { turnId: fact.turnId }),
      ...(fact.changedPaths === undefined ? {} : { changedPaths: fact.changedPaths }),
    })
  }
  return facts
}

describe('the facts of a tool call', () => {
  it('reports the tool and how the call ended', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'read', turn: 3 })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(factsOf(events)).toEqual([{ toolName: 'read', outcome: 'succeeded', callId: 'call-1', turnId: '3' }])
  })

  it('reports a call the backend refused as failed', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'bash' })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: true } })

    expect(factsOf(events)).toEqual([{ toolName: 'bash', outcome: 'failed', callId: 'call-1' }])
  })

  it('reports the relative path a call changed inside the workspace', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'write', arguments: { path: 'src/answer.ts' } })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(factsOf(events)[0]).toMatchObject({ toolName: 'write', outcome: 'succeeded', changedPaths: ['src/answer.ts'] })
  })

  it('reports an absolute path inside the workspace as a relative one', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    const absolute = join(root, 'project-1', 'src', 'answer.ts')
    sessionEvent('tool/call', { callId: 'call-1', name: 'edit', arguments: { file_path: absolute } })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(factsOf(events)[0]).toMatchObject({ changedPaths: ['src/answer.ts'] })
  })

  it('leaves a path outside the workspace out of the fact', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'write', arguments: { path: '../outside.ts' } })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(factsOf(events)[0]!.changedPaths).toBeUndefined()
  })

  it('names no path for a call that failed', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'write', arguments: { path: 'src/answer.ts' } })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: true } })

    expect(factsOf(events)[0]!.changedPaths).toBeUndefined()
  })

  it('reports nothing for a result whose call was never seen', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/result', { message: { toolCallId: 'call-unknown', isError: false } })

    expect(factsOf(events)).toEqual([])
  })

  it('reports a call once, however often its result arrives', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'read' })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(factsOf(events)).toHaveLength(1)
  })

  it('keeps the arguments of a call and the output of a tool out of the fact', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'bash', arguments: { command: 'cat secret.txt' } })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false, content: 'the secret' } })

    const fact = factsOf(events)[0]!
    expect(JSON.stringify(fact)).not.toContain('secret.txt')
    expect(JSON.stringify(fact)).not.toContain('the secret')
  })
})

describe('the arguments the real backend sends', () => {
  it('reads the path out of the serialized arguments of a write', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    // The real DSH hands the arguments as a serialized JSON object: the path it names is an absolute one inside the
    // workspace of the Session.
    const absolute = join(root, 'project-1', 'p42-worker-a-proof.txt')
    sessionEvent('tool/call', { callId: 'call-1', name: 'write',
      arguments: JSON.stringify({ file_path: absolute, content: 'fixture' }) })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(factsOf(events)[0]).toMatchObject({ toolName: 'write', outcome: 'succeeded',
      changedPaths: ['p42-worker-a-proof.txt'] })
  })

  it('keeps the content of a serialized argument out of the fact', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    const absolute = join(root, 'project-1', 'answer.ts')
    sessionEvent('tool/call', { callId: 'call-1', name: 'write',
      arguments: JSON.stringify({ file_path: absolute, content: 'the secret' }) })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(JSON.stringify(factsOf(events))).not.toContain('the secret')
  })

  it('leaves a serialized argument that names no path out of the fact', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'write', arguments: JSON.stringify({ content: 'fixture' }) })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(factsOf(events)[0]!.changedPaths).toBeUndefined()
  })

  it('leaves a serialized argument that is not an object out of the fact', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'write', arguments: 'not json at all' })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(factsOf(events)[0]!.changedPaths).toBeUndefined()
  })

  it('leaves a serialized argument that is too long out of the fact', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    const huge = JSON.stringify({ file_path: join(root, 'project-1', 'answer.ts'), content: 'x'.repeat(70_000) })
    sessionEvent('tool/call', { callId: 'call-1', name: 'write', arguments: huge })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(factsOf(events)[0]!.changedPaths).toBeUndefined()
  })
})

describe('the call a result belongs to', () => {
  it('names no path when the result answers another turn', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'write', turn: 3, arguments: { path: 'src/answer.ts' } })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false }, turn: 4 })

    // The call is still a fact about the work, but a result of another turn does not answer it: it names no file.
    expect(factsOf(events)).toEqual([{ toolName: 'write', outcome: 'succeeded', callId: 'call-1', turnId: '3' }])
  })

  it('names the path of the turn the result really answers', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'write', turn: 3, arguments: { path: 'src/answer.ts' } })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false }, turn: 3 })

    expect(factsOf(events)[0]).toMatchObject({ changedPaths: ['src/answer.ts'] })
  })

  it('names the path once, however often the result is replayed', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'write', arguments: { path: 'src/answer.ts' } })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })
    sessionEvent('tool/result', { message: { toolCallId: 'call-1', isError: false } })

    expect(factsOf(events)).toHaveLength(1)
    expect(factsOf(events)[0]).toMatchObject({ changedPaths: ['src/answer.ts'] })
  })

  it('names no path when the result belongs to another Session', async () => {
    const { host, events } = harness()
    await host.ensureSession(workerInput())

    sessionEvent('tool/call', { callId: 'call-1', name: 'write', arguments: { path: 'src/answer.ts' } })
    // Another Session answers a call of the same id: the fact of this Session is not that answer.
    context.fire('session/event', { id: 'worker-2' }, { type: 'tool/result',
      data: { message: { toolCallId: 'call-1', isError: false } } })

    expect(factsOf(events)).toEqual([])
  })
})
