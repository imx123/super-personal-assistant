/**
 * P2-C SSE pressure test: a dozen-plus panel clients open the control-plane event stream at once, all of them must see
 * the complete event history in order with no gap and no cross-talk, and closing them must end every stream and its
 * keepalive timer instead of leaving work behind for the process to carry.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const OPERATOR_TOKEN = 'sse-load-operator-token'
const VIEWER_TOKEN = 'sse-load-viewer-token'
const SECRET = 'sse-load-test-secret'
const NOW = '2026-01-01T00:00:00.000Z'
/** One operator stream and one viewer stream per pair: both roles must see the same events. */
const CLIENTS = 14
/** Upper bound for every wait in this test, so a hung stream fails instead of blocking the run. */
const WAIT_MS = 5000
const OPERATOR = { authorization: `Bearer ${OPERATOR_TOKEN}` }
const VIEWER = { authorization: `Bearer ${VIEWER_TOKEN}` }

interface Frame {
  id?: number
  data?: string
  comment?: string
}

/** One SSE frame: `id:` becomes a number, `data:` is kept raw, and a `:` line is a comment such as `connected`. */
function parseFrame(raw: string): Frame {
  const frame: Frame = {}
  for (const line of raw.split('\n')) {
    if (line === '') continue
    if (line.startsWith(':')) {
      frame.comment = line.slice(1).trim()
      continue
    }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'id') frame.id = Number(value)
    else if (field === 'data') frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`
  }
  return frame
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Resolve once `predicate` holds, or throw after `timeoutMs`; used to observe background server cleanup. */
async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(10)
  }
}

/** Give the event loop a turn so a late rejection or socket close is observed before the assertions. */
function settle(): Promise<void> {
  return delay(25)
}

/**
 * One open event stream, read frame by frame in the background.
 *
 * The same minimal reader the event-stream spec uses; it is repeated here because a helper module would be shared state
 * between spec files, and this test needs to count these exact clients and prove each one closed.
 */
class SseClient {
  readonly frames: Frame[] = []
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private readonly waiters = new Set<() => void>()
  private readonly ended: Promise<void>
  private resolveEnded!: () => void
  private buffer = ''
  private finished = false
  private endedByUs = false
  private failure: Error | undefined

  constructor(response: Response, private readonly controller: AbortController) {
    if (!response.body) throw new Error('the event stream has no body')
    this.reader = response.body.getReader()
    this.ended = new Promise<void>(resolve => { this.resolveEnded = resolve })
    void this.pump()
  }

  static async open(url: string, headers: Record<string, string>): Promise<SseClient> {
    const controller = new AbortController()
    const response = await fetch(url, { headers, signal: controller.signal })
    if (response.status !== 200) {
      const detail = await response.text().catch(() => '')
      throw new Error(`the event stream answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    return new SseClient(response, controller)
  }

  /** The data frames received so far, in arrival order; comment frames such as keepalives are excluded. */
  get events(): Frame[] {
    return this.frames.filter(frame => frame.data !== undefined)
  }

  async waitForEvents(count: number, timeoutMs = WAIT_MS): Promise<Frame[]> {
    const deadline = Date.now() + timeoutMs
    while (this.events.length < count) {
      if (this.failure) throw this.failure
      if (this.finished) throw new Error(`the event stream ended after ${this.events.length}/${count} events`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out after ${this.events.length}/${count} events`)
      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const wake = (): void => {
          if (timer !== undefined) clearTimeout(timer)
          this.waiters.delete(wake)
          resolve()
        }
        timer = setTimeout(wake, remaining)
        this.waiters.add(wake)
      })
    }
    return this.events
  }

  /** Resolve once the stream ended, whether the client or the server ended it. */
  async waitForEnd(timeoutMs = WAIT_MS): Promise<void> {
    const timeout = delay(timeoutMs).then(() => { throw new Error('the event stream did not end') })
    await Promise.race([this.ended, timeout])
  }

  close(): void {
    this.endedByUs = true
    this.controller.abort()
    void this.reader.cancel().catch(() => {})
    this.resolveEnded()
  }

  private async pump(): Promise<void> {
    try {
      while (true) {
        const { done, value } = await this.reader.read()
        if (done) break
        this.buffer += this.decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
        let boundary = this.buffer.indexOf('\n\n')
        while (boundary >= 0) {
          this.frames.push(parseFrame(this.buffer.slice(0, boundary)))
          this.buffer = this.buffer.slice(boundary + 2)
          boundary = this.buffer.indexOf('\n\n')
        }
        this.wake()
      }
    } catch (error) {
      // Closing the client is this test's own doing; any other failure must fail the test instead of hanging it.
      if (!this.endedByUs) this.failure = error instanceof Error ? error : new Error(String(error))
    } finally {
      this.finished = true
      this.wake()
      this.resolveEnded()
      try { this.reader.releaseLock() } catch { /* a reader already released is fine */ }
    }
  }

  private wake(): void {
    for (const wake of [...this.waiters]) wake()
  }
}

/** Every interval created while tracking, and the ones cleared, so teardown can prove no keepalive outlived its stream. */
interface IntervalTracker {
  readonly created: Set<NodeJS.Timeout>
  readonly cleared: Set<NodeJS.Timeout>
  restore(): void
}

function trackIntervals(): IntervalTracker {
  const created = new Set<NodeJS.Timeout>()
  const cleared = new Set<NodeJS.Timeout>()
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  // The DOM and Node global declarations disagree on the handle type; Node's is the one that exists at runtime here.
  const startTimer = originalSet as unknown as (handler: () => void, timeout?: number) => NodeJS.Timeout
  const stopTimer = originalClear as unknown as (timer: NodeJS.Timeout) => void
  // The stream keepalive is the only interval this test starts, so wrapping the globals makes "no timer left" checkable.
  globalThis.setInterval = ((handler: () => void, timeout?: number) => {
    const timer = startTimer(handler, timeout)
    created.add(timer)
    return timer
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((timer: NodeJS.Timeout) => {
    cleared.add(timer)
    stopTimer(timer)
  }) as unknown as typeof clearInterval
  return {
    created,
    cleared,
    restore(): void {
      globalThis.setInterval = originalSet
      globalThis.clearInterval = originalClear
    },
  }
}

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: NOW, text: 'Build it', meta: {} }
}

let directory = ''
let node: FakeNode
let control: ControlPlane
let server: ControlPlaneServer | undefined
const clients: SseClient[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-control-sse-load-'))
  node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces') })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces') })
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane SSE load', () => {
  it('delivers every event to 14 concurrent operator and viewer streams without loss or mix-up', async () => {
    await control.registerNode()
    server = new ControlPlaneServer(control, { token: OPERATOR_TOKEN, viewerToken: VIEWER_TOKEN, keepaliveMs: 25 })
    const address = await server.listen(0)

    const intervals = trackIntervals()
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    const timed = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
      const timeout = delay(ms).then(() => { throw new Error(`${what} did not settle within ${ms} ms`) })
      return Promise.race([work, timeout])
    }

    try {
      for (let index = 0; index < CLIENTS; index += 1) {
        clients.push(await SseClient.open(`${address.url}/v1/events/stream?after=0`,
          index % 2 === 0 ? OPERATOR : VIEWER))
      }
      // Every client first replays the registration event that predates it.
      await Promise.all(clients.map(client => client.waitForEvents(1)))

      // Produce events through the ordinary kernel paths: heartbeats, a PM ensure, a message and a tool call.
      for (let beat = 0; beat < 5; beat += 1) await control.heartbeat()
      control.store.triggers.save(trigger())
      const project = control.createProject('trigger-1', 'Project', 'Goal')
      const pm = await control.openProject(project.id)
      await control.sendMessage(pm.sessionId, 'hello over the load test')
      node.simulateToolCall(pm.sessionId, 'control_project', {})

      const expected = control.events.map(event => JSON.stringify(event))
      expect(expected.length).toBeGreaterThan(1)
      const received = await Promise.all(clients.map(client => client.waitForEvents(expected.length)))
      for (const [index, events] of received.entries()) {
        // Each stream carries exactly the kernel history: no gap, no duplicate, no event meant for another client.
        expect(events.map(frame => frame.data), `client ${index}`).toEqual(expected)
        const ids = events.map(frame => frame.id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids).toEqual([...ids].sort((left, right) => (left ?? 0) - (right ?? 0)))
      }
      // Alternating roles do not change the bytes: a viewer sees exactly what an operator sees.
      expect(new Set(received.map(events => events.map(frame => frame.data).join('\u0000'))).size).toBe(1)
      for (const events of received) {
        for (const frame of events) {
          expect(frame.data).not.toContain(OPERATOR_TOKEN)
          expect(frame.data).not.toContain(VIEWER_TOKEN)
        }
      }

      // Closing the clients ends every stream server-side, and each stream's keepalive ends with it.
      for (const client of clients) client.close()
      await Promise.all(clients.map(client => timed(client.waitForEnd(), WAIT_MS, 'a closed stream')))
      await until(() => intervals.created.size > 0 && [...intervals.created].every(timer => intervals.cleared.has(timer)),
        WAIT_MS, 'the keepalive timers to be cleared')
      expect(intervals.created.size).toBe(CLIENTS)

      // The server closes although it once held a dozen open streams, and nothing is left pending afterwards.
      await timed(server.close(), WAIT_MS, 'the server close')
      server = undefined
      await settle()
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
      intervals.restore()
    }
  }, 10_000)
})
