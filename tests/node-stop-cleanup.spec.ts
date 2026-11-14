/** P2-B2: a Worker Session's cancel kills the background work it owns before the turn it runs is settled. */
import { describe, expect, it } from 'vitest'
import { createDshPortHost } from '../src/node/dsh-port-host.ts'
import type { DshPortEvent } from '../src/node/dsh-port.ts'

const NODE_ID = 'node-1'
const ROOT = '.'

type ContextListener = (...args: any[]) => void

/** One running shell job a Session owns, as the job registry reports it. */
interface FakeJob {
  id: string
  owner?: string
  status: string
  label?: string
}

/** DSH's job registry, narrowed to what `killJobs` uses: list, wait to collect an end, and kill. */
class FakeJobs {
  readonly jobs: FakeJob[] = []
  readonly calls: string[] = []
  /** When set, every kill raises it; the waits still collected the ends. */
  killError?: Error

  list(caller: string): readonly FakeJob[] {
    this.calls.push(`list:${caller}`)
    return this.jobs
  }
  async wait(id: string, _timeoutMs: number, caller: string): Promise<{ status: string }> {
    this.calls.push(`wait:${id}:${caller}`)
    return { status: 'killed' }
  }
  kill(id: string, caller: string, reason?: string): void {
    this.calls.push(`kill:${id}:${caller}:${reason}`)
    if (this.killError) throw this.killError
    const job = this.jobs.find(item => item.id === id)
    if (job) job.status = 'killed'
  }
  readonly events = { subscribe: (_filter: { owner: string }, _listener: (event: { type: string }) => void) => () => {} }
}

/** DSH's subagent registry, narrowed to what `stopSubagents` uses: listing and draining a worker's children. */
class FakeSubagents {
  children: string[] = []
  readonly listCalls: string[] = []
  readonly drains: { agent: unknown; childIds: readonly string[] }[] = []

  async listChildren(parentSessionId: string): Promise<readonly { id: string }[]> {
    this.listCalls.push(parentSessionId)
    return this.children.map(id => ({ id }))
  }
  async drainChildren(agent: unknown, childIds: readonly string[]): Promise<void> {
    this.drains.push({ agent, childIds })
    this.children = this.children.filter(id => !childIds.includes(id))
  }
  async waitForChildren(_parent: unknown): Promise<boolean> { return true }
}

/** The live Agent a fake registry hands out; cancelling it settles its turn unless a test gates that. */
class FakeAgent {
  status: 'idle' | 'running' = 'running'
  readonly cancels: { kind: string; keepInbox?: boolean }[] = []
  whenIdleCalls = 0
  /** A cancel settles the turn at once, as DSH does; a test may override this to observe the wait. */
  onCancel?: () => void
  /** Held when set, so a test can prove the command still waits for the turn to settle. */
  whenIdleGate?: Promise<void>
  /** When set, `whenIdle` rejects instead of settling. */
  whenIdleError?: Error
  /** When set, `cancel` rejects instead of settling the turn. */
  cancelError?: Error

  constructor(readonly id: string) {}

  cancel(reason: { kind: string }, options?: { keepInbox?: boolean }): void {
    if (this.cancelError) throw this.cancelError
    this.cancels.push({ kind: reason.kind, ...(options?.keepInbox === undefined ? {} : { keepInbox: options.keepInbox }) })
    this.onCancel?.()
  }
  async whenIdle(): Promise<void> {
    this.whenIdleCalls += 1
    if (this.whenIdleGate) await this.whenIdleGate
    if (this.whenIdleError) throw this.whenIdleError
  }
}

/** A Context with the optional services the stop reads and the Agent/subagent registries it resolves ids in. */
class FakeContext {
  readonly live = new Map<string, FakeAgent>()
  readonly childIds = new Set<string>()
  readonly services = new Map<string, unknown>()
  private readonly listeners = new Map<string, Set<ContextListener>>()
  readonly agents = {
    get: (id: string): FakeAgent | { id: string } | undefined =>
      this.live.get(id) ?? (this.childIds.has(id) ? { id } : undefined),
  }

  get(name: string): unknown { return this.services.get(name) }
  on(name: string, listener: ContextListener): () => void {
    const listeners = this.listeners.get(name) ?? new Set<ContextListener>()
    listeners.add(listener)
    this.listeners.set(name, listeners)
    return () => { listeners.delete(listener) }
  }
  emit(name: string, ...args: unknown[]): void {
    for (const listener of [...this.listeners.get(name) ?? []]) listener(...args)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Build the real host over a fake Context and no backend work: every test drives one Session's stop. */
function host(options: { agent?: FakeAgent; jobs?: FakeJobs; subagents?: FakeSubagents } = {}) {
  const context = new FakeContext()
  if (options.agent) context.live.set(options.agent.id, options.agent)
  if (options.jobs) context.services.set('jobs', options.jobs)
  if (options.subagents) context.services.set('subagents', options.subagents)
  return {
    context,
    stop: createDshPortHost({ context, nodeRuntime: { sessions: {
      async ensure(): Promise<unknown> { return {} },
      async prompt(): Promise<void> {},
    } }, nodeId: NODE_ID, root: ROOT }),
  }
}

/** Every message in an error tree, including nested `AggregateError`s. */
function messagesOf(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(messagesOf)
  return [error instanceof Error ? error.message : String(error)]
}

describe('createDshPortHost cancelSession background cleanup', () => {
  it('kills the Session’s running jobs, releases its live subagents, and cancels its turn once', async () => {
    const agent = new FakeAgent('worker-1')
    agent.onCancel = () => { agent.status = 'idle' }
    const jobs = new FakeJobs()
    jobs.jobs.push({ id: 'job-1', owner: 'worker-1', status: 'running', label: 'pnpm dev' })
    jobs.jobs.push({ id: 'job-2', owner: 'worker-2', status: 'running' })
    const subagents = new FakeSubagents()
    subagents.children = ['sub-1']
    const { context, stop } = host({ agent, jobs, subagents })
    context.childIds.add('sub-1')

    await stop.cancelSession('worker-1', 'operator stopped the Session')

    // Only this Session's job was collected and killed; another owner's job is untouched.
    expect(jobs.calls).toEqual(['list:worker-1', 'wait:job-1:worker-1',
      'kill:job-1:worker-1:operator stopped the Session'])
    expect(jobs.jobs.map(job => job.status)).toEqual(['killed', 'running'])
    // Its live subagent was drained before the turn was cancelled.
    expect(subagents.listCalls).toEqual(['worker-1'])
    expect(subagents.drains).toEqual([{ agent, childIds: ['sub-1'] }])
    // `stopSubagents` cancelled the turn and waited for it; the host must not cancel the same turn again.
    expect(agent.cancels).toEqual([{ kind: 'user', keepInbox: true }])
    expect(agent.whenIdleCalls).toBe(1)
  })

  it('still cancels a loaded Agent when the host offers no jobs or subagents', async () => {
    const agent = new FakeAgent('worker-1')
    const { stop } = host({ agent })

    await stop.cancelSession('worker-1')

    expect(agent.cancels).toEqual([{ kind: 'user', keepInbox: true }])
    expect(agent.whenIdleCalls).toBe(1)
  })

  it('waits for the Agent to become idle before acknowledging the cancel', async () => {
    const agent = new FakeAgent('worker-1')
    let release!: () => void
    agent.whenIdleGate = new Promise<void>(resolve => { release = resolve })
    const { stop } = host({ agent })

    let settled = false
    const command = stop.cancelSession('worker-1').then(() => { settled = true })
    await sleep(20)
    expect(settled).toBe(false)
    expect(agent.cancels).toHaveLength(1)

    release()
    await command
    expect(settled).toBe(true)
  })

  it('kills the jobs of a Session whose Agent is no longer loaded', async () => {
    const jobs = new FakeJobs()
    jobs.jobs.push({ id: 'job-1', owner: 'worker-1', status: 'running' })
    const { stop } = host({ jobs })

    await stop.cancelSession('worker-1')

    expect(jobs.calls).toEqual(['list:worker-1', 'wait:job-1:worker-1', 'kill:job-1:worker-1:The Session was stopped'])
    expect(jobs.jobs[0]!.status).toBe('killed')
  })

  it('cancels the turn and fails the command when killing a job fails', async () => {
    const agent = new FakeAgent('worker-1')
    const jobs = new FakeJobs()
    jobs.jobs.push({ id: 'job-1', owner: 'worker-1', status: 'running' })
    jobs.killError = new Error('kill failed')
    const { stop } = host({ agent, jobs })

    const failure = await stop.cancelSession('worker-1').then(() => undefined, (error: unknown) => error)

    // The cleanup failure is reported, not swallowed, but it never skips the turn cancellation.
    expect(failure).toBeInstanceOf(AggregateError)
    expect(messagesOf(failure)).toContain('kill failed')
    expect(agent.cancels).toEqual([{ kind: 'user', keepInbox: true }])
    expect(agent.whenIdleCalls).toBe(1)
  })

  it('waits for idle and reports the failure when the cancel itself throws', async () => {
    const agent = new FakeAgent('worker-1')
    agent.cancelError = new Error('cancel failed')
    const { stop } = host({ agent })

    const failure = await stop.cancelSession('worker-1').then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(messagesOf(failure)).toContain('cancel failed')
    // The failed request does not excuse skipping the wait for a turn that may still run.
    expect(agent.whenIdleCalls).toBe(1)
  })

  it('keeps both errors when the cleanup and the turn cancellation fail', async () => {
    const agent = new FakeAgent('worker-1')
    agent.whenIdleError = new Error('whenIdle failed')
    const jobs = new FakeJobs()
    jobs.jobs.push({ id: 'job-1', owner: 'worker-1', status: 'running' })
    jobs.killError = new Error('kill failed')
    const { stop } = host({ agent, jobs })

    const failure = await stop.cancelSession('worker-1').then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(messagesOf(failure)).toEqual(expect.arrayContaining(['kill failed', 'whenIdle failed']))
    expect(agent.cancels).toHaveLength(1)
  })

  it('forwards the idle status a cancel settles the Agent into', async () => {
    const agent = new FakeAgent('worker-1')
    const { context, stop } = host({ agent })
    agent.onCancel = () => {
      agent.status = 'idle'
      context.emit('agent/status', { agent, status: 'idle' })
    }
    const events: DshPortEvent[] = []
    const dispose = stop.onEvent(event => events.push(event))
    try {
      await stop.cancelSession('worker-1')
      expect(events).toContainEqual({ type: 'session.status', sessionId: 'worker-1', status: 'idle' })
    } finally {
      dispose()
    }
  })
})
