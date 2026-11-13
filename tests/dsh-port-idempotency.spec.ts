/** Concurrency and retry semantics of `DshNodePort.send`: one host call per key even when duplicates arrive together. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DshNodePort, type DshPortEvent, type DshPortHost } from '../src/node/dsh-port.ts'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeStatus, type RoleProfile, type SessionInspection }
  from '../src/shared/protocol.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'node-1'

const PM_PROFILE: RoleProfile = { name: 'pm.v1', prompt: 'Manage the Project.', tools: [], deny: [],
  permission: 'read-only' }

/** A promise a test settles by hand, so it can hold a host call open and observe who waits on it. */
interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A host whose `ensureSession` calls stay pending until a test settles them, recording every call in order. */
class GatedHost implements DshPortHost {
  readonly ensured: Parameters<DshPortHost['ensureSession']>[0][] = []
  readonly gates: Deferred[] = []
  private readonly waiters: { count: number; resolve: () => void }[] = []
  private readonly listeners = new Set<(event: DshPortEvent) => void>()

  ensureSession(input: Parameters<DshPortHost['ensureSession']>[0]): Promise<void> {
    this.ensured.push(input)
    const gate = deferred()
    this.gates.push(gate)
    this.notify()
    return gate.promise
  }

  /** Resolves once at least `count` `ensureSession` calls have arrived. */
  async waitForCalls(count: number): Promise<void> {
    if (this.ensured.length >= count) return
    await new Promise<void>(resolve => this.waiters.push({ count, resolve }))
  }

  /** The gate of one recorded call, so a test settles exactly that call. */
  gate(index: number): Deferred {
    const gate = this.gates[index]
    if (!gate) throw new Error(`no ensureSession call at index ${index}`)
    return gate
  }

  async promptSession(): Promise<void> {}
  cancelSession(): void {}
  async archiveSession(): Promise<void> {}
  async inspectSession(sessionId: string): Promise<SessionInspection> {
    return { sessionId, found: false }
  }
  setPermission(): void {}
  onEvent(listener: (event: DshPortEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  nodeStatus(): NodeStatus {
    return { nodeId: NODE_ID, backend: 'dsh', version: '0.1.0', online: true, at: NOW }
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) {
      if (this.ensured.length < waiter.count) continue
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }
}

let directory = ''
let root = ''
let host: GatedHost
let port: DshNodePort

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-dsh-port-idempotency-'))
  root = join(directory, 'node')
  mkdirSync(root, { recursive: true })
  host = new GatedHost()
  port = new DshNodePort({ host, nodeId: NODE_ID, root, now: () => NOW })
})

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

function envelope(idempotencyKey: string): { protocolVersion: typeof NODE_PROTOCOL_VERSION; nodeId: string
  idempotencyKey: string; at: string } {
  return { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: NODE_ID, idempotencyKey, at: NOW }
}

function pmEnsure(idempotencyKey: string, sessionId = 'pm-1'): NodeCommand {
  return { ...envelope(idempotencyKey), type: 'pm.ensure', sessionId,
    project: { id: 'project-1', title: 'Project', goal: 'Ship it' }, workspace: join(root, 'project-1'),
    profile: PM_PROFILE, sessionToken: 'session-token', prompt: PM_PROFILE.prompt }
}

/** Lets every already-scheduled microtask run, including the port's deferred command execution. */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round++) await Promise.resolve()
}

describe('DshNodePort.send idempotency', () => {
  it('hands a concurrent duplicate the run already in flight and settles both only once the run does', async () => {
    const first = port.send(pmEnsure('ensure-key'))
    const second = port.send(pmEnsure('ensure-key'))
    // The duplicate waits on the very same Promise; it is not a second execution acknowledged early.
    expect(second).toBe(first)

    let settled = 0
    void first.then(() => settled++, () => settled++)
    void second.then(() => settled++, () => settled++)

    await host.waitForCalls(1)
    await flushMicrotasks()
    expect(host.ensured).toHaveLength(1)
    expect(settled).toBe(0)

    host.gate(0).resolve()
    await Promise.all([first, second])
    expect(host.ensured).toHaveLength(1)
    expect(settled).toBe(2)
  })

  it('retries the same key once the host rejects, calling the host again', async () => {
    const first = port.send(pmEnsure('retry-key'))
    await host.waitForCalls(1)
    host.gate(0).reject(new Error('host unavailable'))
    await expect(first).rejects.toThrow('host unavailable')
    expect(host.ensured).toHaveLength(1)

    const retry = port.send(pmEnsure('retry-key'))
    expect(retry).not.toBe(first)
    await host.waitForCalls(2)
    host.gate(1).resolve()
    await expect(retry).resolves.toBeUndefined()
    expect(host.ensured).toHaveLength(2)
  })

  it('acknowledges a key that already succeeded without calling the host again', async () => {
    const first = port.send(pmEnsure('done-key'))
    await host.waitForCalls(1)
    host.gate(0).resolve()
    await first

    await expect(port.send(pmEnsure('done-key'))).resolves.toBeUndefined()
    await flushMicrotasks()
    expect(host.ensured).toHaveLength(1)

    // The protocol version is checked before the key lookup, so an invalid copy is rejected even for a completed key.
    await expect(port.send({ ...pmEnsure('done-key'), protocolVersion: 99 } as unknown as NodeCommand))
      .rejects.toThrow(/protocol version/)
  })

  it('executes distinct keys once each while they run concurrently', async () => {
    const first = port.send(pmEnsure('pm-key', 'pm-1'))
    const second = port.send(pmEnsure('other-key', 'pm-2'))
    expect(second).not.toBe(first)

    await host.waitForCalls(2)
    expect(host.ensured.map(call => call.sessionId)).toEqual(['pm-1', 'pm-2'])
    host.gate(0).resolve()
    host.gate(1).resolve()
    await Promise.all([first, second])
    expect(host.ensured).toHaveLength(2)
  })

  it('rejects concurrent duplicates together when their shared run fails, then retries the key', async () => {
    const first = port.send(pmEnsure('shared-failure'))
    const second = port.send(pmEnsure('shared-failure'))
    expect(second).toBe(first)

    await host.waitForCalls(1)
    host.gate(0).reject(new Error('backend down'))
    await expect(first).rejects.toThrow('backend down')
    await expect(second).rejects.toThrow('backend down')
    expect(host.ensured).toHaveLength(1)

    const retry = port.send(pmEnsure('shared-failure'))
    await host.waitForCalls(2)
    host.gate(1).resolve()
    await expect(retry).resolves.toBeUndefined()
    expect(host.ensured).toHaveLength(2)
  })
})
