import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { ControlPlane } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import type { NodeEvent } from '../src/shared/protocol.ts'

const TOKEN = 'control-events-test-token'
const SECRET = 'control-events-test-secret'
const NOW = '2026-01-01T00:00:00.000Z'
const AUTH = { authorization: `Bearer ${TOKEN}` }

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

/**
 * One open event stream, read frame by frame in the background.
 *
 * The pump starts with the response, so `waitFor` only waits for frames that already begin arriving instead of racing
 * a reader; closing aborts the response, and `waitForEnd` observes the server (or the client) ending it.
 */
class SseStream {
  readonly frames: Frame[] = []
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private readonly waiters = new Set<() => void>()
  private readonly ended: Promise<void>
  private resolveEnded!: () => void
  private buffer = ''
  private finished = false
  private failure: Error | undefined

  constructor(readonly response: Response, private readonly controller: AbortController) {
    if (!response.body) throw new Error('the event stream has no body')
    this.reader = response.body.getReader()
    this.ended = new Promise<void>(resolve => { this.resolveEnded = resolve })
    void this.pump()
  }

  static async open(url: string, headers: Record<string, string>): Promise<SseStream> {
    const controller = new AbortController()
    const response = await fetch(url, { headers, signal: controller.signal })
    if (response.status !== 200) {
      const detail = await response.text().catch(() => '')
      throw new Error(`the event stream answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    return new SseStream(response, controller)
  }

  /** The data frames received so far, in arrival order; comment frames such as keepalives are excluded. */
  get events(): Frame[] {
    return this.frames.filter(frame => frame.data !== undefined)
  }

  async waitFor(predicate: (frames: Frame[]) => boolean, timeoutMs = 5000): Promise<Frame[]> {
    const deadline = Date.now() + timeoutMs
    while (!predicate(this.frames)) {
      if (this.failure) throw this.failure
      if (this.finished) throw new Error(`the event stream ended before the expected frames: ${JSON.stringify(this.frames)}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out waiting for the event stream: ${JSON.stringify(this.frames)}`)
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
    return [...this.frames]
  }

  async waitForEvents(count: number, timeoutMs = 5000): Promise<Frame[]> {
    await this.waitFor(frames => frames.filter(frame => frame.data !== undefined).length >= count, timeoutMs)
    return this.events
  }

  /** Resolve once the stream ended, whether the client or the server ended it. */
  async waitForEnd(timeoutMs = 5000): Promise<void> {
    const timeout = delay(timeoutMs).then(() => { throw new Error('the event stream did not end') })
    await Promise.race([this.ended, timeout])
  }

  close(): void {
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
      // Aborting the stream is the client's own doing; any other failure is worth reporting to the test.
      if (!this.controller.signal.aborted) this.failure = error instanceof Error ? error : new Error(String(error))
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

let directory = ''
let node: FakeNode
let control: ControlPlane
let server: ControlPlaneServer | undefined
const streams: SseStream[] = []

function track(stream: SseStream): SseStream {
  streams.push(stream)
  return stream
}

function trigger(): Trigger {
  return { id: 'trigger-1', source: 'main-session', threads: [{ source: 'main-session', id: 'thread-1' }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: NOW, text: 'Build it', meta: {} }
}

/** Assert every data frame carries a strictly increasing id and names no token. */
function expectMonotonic(events: Frame[]): void {
  const ids = events.map(frame => frame.id)
  expect(ids.every(id => id !== undefined)).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids).toEqual([...ids].sort((left, right) => (left ?? 0) - (right ?? 0)))
  for (const frame of events) {
    expect(frame.data).not.toContain(TOKEN)
    expect(frame.data).not.toContain(SECRET)
    expect(JSON.parse(frame.data!)).toMatchObject({ nodeId: 'local', seq: frame.id })
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-control-events-'))
  node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces') })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces') })
})

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close()
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  vi.restoreAllMocks()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('control-plane event subscription', () => {
  it('notifies every subscriber of every event and survives a subscriber that throws', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const seen: NodeEvent[] = []
    const unsubscribeThrowing = control.subscribe(() => { throw new Error('listener exploded') })
    const unsubscribe = control.subscribe(event => seen.push(event))

    await control.registerNode()
    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    const pm = await control.openProject(project.id)
    await control.sendMessage(pm.sessionId, 'hello')
    node.simulateToolCall(pm.sessionId, 'control_project', {})

    const types = seen.map(event => event.type)
    expect(types).toEqual(expect.arrayContaining(['node.status', 'session.status', 'session.event', 'tool.call']))
    // One notification per received event: the throwing subscriber did not stop delivery.
    expect(seen).toEqual(control.events)
    expect(stderr.mock.calls.some(call => String(call[0]).includes('event listener failed'))).toBe(true)

    unsubscribe()
    const before = seen.length
    await control.heartbeat()
    expect(seen).toHaveLength(before)
    // `receive` itself still ran: the node status the heartbeat reported is in the kernel.
    expect(control.nodes.get('local')).toMatchObject({ online: true })
    unsubscribeThrowing()
  })
})

describe('control-plane event stream', () => {
  it('replays the backlog, follows live events, and resumes from the last id without repeating', async () => {
    await control.registerNode()
    server = new ControlPlaneServer(control, { token: TOKEN, keepaliveMs: 30 })
    const address = await server.listen(0)

    const first = track(await SseStream.open(`${address.url}/v1/events/stream?after=0`, AUTH))
    expect(first.response.headers.get('content-type')).toContain('text/event-stream')
    await first.waitFor(frames => frames.some(frame => frame.data !== undefined))
    expect(first.frames[0]?.comment).toBe('connected')
    expect(first.events).toHaveLength(1)
    expect(JSON.parse(first.events[0]!.data!)).toMatchObject({ nodeId: 'local', seq: 1, type: 'node.status' })

    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    const pm = await control.openProject(project.id)
    await first.waitForEvents(2)
    await control.sendMessage(pm.sessionId, 'hello')
    await first.waitForEvents(5)
    node.simulateToolCall(pm.sessionId, 'control_project', {})
    const live = await first.waitForEvents(6)

    expect(live.map(frame => frame.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(live.slice(1).map(frame => JSON.parse(frame.data!).type)).toEqual([
      'session.status', 'session.status', 'session.event', 'session.status', 'tool.call'])
    expectMonotonic(live)
    const lastId = live.at(-1)!.id!

    // Disconnect, let one event happen unseen, then reconnect from the last id seen.
    first.close()
    await first.waitForEnd()
    await control.heartbeat()

    const second = track(await SseStream.open(`${address.url}/v1/events/stream?after=${lastId}`, AUTH))
    await second.waitForEvents(1)
    expect(second.events.map(frame => frame.id)).toEqual([lastId + 1])
    expect(JSON.parse(second.events[0]!.data!)).toMatchObject({ type: 'node.status' })

    // The header is the other way a client states the last id it saw.
    second.close()
    await second.waitForEnd()
    await control.heartbeat()
    const third = track(await SseStream.open(`${address.url}/v1/events/stream`, {
      ...AUTH, 'last-event-id': String(lastId + 1) }))
    await third.waitForEvents(1)
    expect(third.events.map(frame => frame.id)).toEqual([lastId + 2])
  })

  it('requires the control-plane bearer token and refuses a malformed cursor, keeping polling intact', async () => {
    await control.registerNode()
    server = new ControlPlaneServer(control, { token: TOKEN })
    const address = await server.listen(0)
    const auth = { ...AUTH }

    expect((await fetch(`${address.url}/v1/events/stream`)).status).toBe(401)
    expect((await fetch(`${address.url}/v1/events/stream`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    // A Session token belongs to `/v1/tools/*`, never to the operator's event stream.
    control.store.triggers.save(trigger())
    const project = control.createProject('trigger-1', 'Project', 'Goal')
    const pm = await control.openProject(project.id)
    const sessionToken = node.tokens.get(pm.sessionId)!
    expect((await fetch(`${address.url}/v1/events/stream`, { headers: { authorization: `Bearer ${sessionToken}` } })).status)
      .toBe(401)

    expect((await fetch(`${address.url}/v1/events/stream?after=abc`, { headers: auth })).status).toBe(400)
    expect((await fetch(`${address.url}/v1/events/stream`, { headers: { ...auth, 'last-event-id': '-1' } })).status).toBe(400)

    // The polling route stays as it was.
    const polled = await fetch(`${address.url}/v1/events?after=0`, { headers: auth })
    expect(polled.status).toBe(200)
    const body = await polled.json() as { events: NodeEvent[] }
    expect(body.events.length).toBeGreaterThan(0)
    expect(body.events.every(event => event.seq > 0)).toBe(true)
  })

  it('keeps an idle stream alive and ends it when the server closes', async () => {
    server = new ControlPlaneServer(control, { token: TOKEN, keepaliveMs: 20 })
    const address = await server.listen(0)
    const stream = track(await SseStream.open(`${address.url}/v1/events/stream?after=0`, AUTH))

    await stream.waitFor(frames => frames.some(frame => frame.comment === 'keepalive'))
    await server.close()

    // The server ended the response, and the kernel's listener is gone with it.
    await stream.waitForEnd()
    const before = control.events.length
    await control.heartbeat()
    expect(control.events).toHaveLength(before + 1)
  })
})
