/**
 * P2-D2 event-stream recovery: a subscribed `HttpNodePort` stream reopens after the node restarts, refreshes state once,
 * stops on unsubscribe, and never turns `inspect` into an endless retry loop.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpNodePort } from '../src/control/http-node.ts'
import { NODE_PROTOCOL_VERSION, type NodeEvent } from '../src/shared/protocol.ts'

const TOKEN = 'reconnect-node-token'
const START = '2026-01-01T00:00:00.000Z'

let closeServer: (() => Promise<void>) | undefined

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean, message: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await sleep(5)
  }
}

/** Start a loopback HTTP server whose every answer is controlled by the test. */
function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string }> {
  const server = createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address() as AddressInfo
      closeServer = () => new Promise<void>((done, fail) => {
        // An open SSE connection must not keep the server from closing.
        server.closeAllConnections()
        server.close(error => error ? fail(error) : done())
      })
      resolve({ url: `http://127.0.0.1:${address.port}` })
    })
  })
}

/** A frame the node would write for one Session status fact. */
function statusEvent(seq: number): NodeEvent {
  return { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: 'local', sessionId: 'session-1', projectId: 'project-1',
    role: 'pm', seq, at: START, type: 'session.status', status: 'idle' }
}

function frame(event: NodeEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

function subscriptionCount(port: HttpNodePort): number {
  return (port as unknown as { subscriptions: Set<unknown> }).subscriptions.size
}

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
})

describe('HttpNodePort.subscribe reconnects', () => {
  it('reopens a dropped stream, delivers events from both connections, and refreshes once', async () => {
    let connections = 0
    const server = await listen((req, res) => {
      if (req.url !== '/events') {
        res.writeHead(404).end()
        return
      }
      connections += 1
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.flushHeaders()
      if (connections === 1) {
        res.write(frame(statusEvent(1)))
        // The node went away after one event: the client must reopen a stream and keep the facts it missed.
        res.end()
        return
      }
      res.write(frame(statusEvent(2)))
    })
    const port = new HttpNodePort({ url: server.url, token: TOKEN, reconnectDelayMs: 5, maxReconnectDelayMs: 20 })
    const received: NodeEvent[] = []
    let reconnects = 0
    port.onReconnect = () => { reconnects += 1 }
    const unsubscribe = port.subscribe(event => received.push(event))

    try {
      await until(() => received.length >= 2, 'the reconnected stream delivered the second event')
      expect(received.map(event => event.seq)).toEqual([1, 2])
      expect(connections).toBe(2)
      expect(reconnects).toBe(1)
    } finally {
      unsubscribe()
    }
  })

  it('cancels a pending reconnect on unsubscribe and leaves no subscription behind', async () => {
    let connections = 0
    const server = await listen((req, res) => {
      if (req.url !== '/events') {
        res.writeHead(404).end()
        return
      }
      connections += 1
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.flushHeaders()
      res.write(frame(statusEvent(connections)))
      // Every connection ends immediately, so after the first event control is inside the backoff wait.
      res.end()
    })
    const port = new HttpNodePort({ url: server.url, token: TOKEN, reconnectDelayMs: 40, maxReconnectDelayMs: 40 })
    const received: NodeEvent[] = []
    const unsubscribe = port.subscribe(event => received.push(event))

    await until(() => received.length === 1, 'the first event did not arrive')
    unsubscribe()
    expect(subscriptionCount(port)).toBe(0)

    await sleep(120)
    expect(connections).toBe(1)
    expect(received).toHaveLength(1)
  })

  it('keeps retrying a subscribed stream while the node keeps ending it', async () => {
    let connections = 0
    const server = await listen((req, res) => {
      if (req.url !== '/events') {
        res.writeHead(404).end()
        return
      }
      connections += 1
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.flushHeaders()
      res.end()
    })
    const port = new HttpNodePort({ url: server.url, token: TOKEN, reconnectDelayMs: 5, maxReconnectDelayMs: 10 })
    let reconnects = 0
    port.onReconnect = () => { reconnects += 1 }
    const unsubscribe = port.subscribe(() => {})

    try {
      await until(() => connections >= 3, 'the client did not reopen the ended stream')
      // A stream that never delivered and ended at once is still reopened; each reopen is a fresh attempt.
      expect(connections).toBeGreaterThanOrEqual(3)
    } finally {
      unsubscribe()
    }
  })

  it('stays one-shot for inspect: a rejected event stream fails once instead of retrying', async () => {
    let connections = 0
    const server = await listen((req, res) => {
      if (req.url === '/events') {
        connections += 1
        res.writeHead(503).end()
        return
      }
      res.writeHead(404).end()
    })
    const port = new HttpNodePort({ url: server.url, token: TOKEN, reconnectDelayMs: 5, maxReconnectDelayMs: 10 })
    let reconnects = 0
    port.onReconnect = () => { reconnects += 1 }

    await expect(port.inspect('session-1')).rejects.toThrow('event stream rejected with HTTP 503')
    await sleep(40)
    expect(connections).toBe(1)
    expect(reconnects).toBe(0)
    expect(subscriptionCount(port)).toBe(0)
  })
})
