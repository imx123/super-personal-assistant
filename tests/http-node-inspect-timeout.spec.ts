/** HttpNodePort.inspect bounds the whole inspect: opening the SSE stream, POSTing the command, and waiting for the answer. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpNodePort } from '../src/control/http-node.ts'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeEvent } from '../src/shared/protocol.ts'

const TOKEN = 'inspect-timeout-node-token'
const TIMEOUT = 80
const START = '2026-01-01T00:00:00.000Z'

let closeServer: (() => Promise<void>) | undefined

/** Start a loopback HTTP server whose every answer is controlled by the test. */
function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string }> {
  const server = createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address() as AddressInfo
      closeServer = () => new Promise<void>((done, fail) => {
        // Open SSE connections and a never-answered command must not keep the server from closing.
        server.closeAllConnections()
        server.close(error => error ? fail(error) : done())
      })
      resolve({ url: `http://127.0.0.1:${address.port}` })
    })
  })
}

function requestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

function subscriptionCount(port: HttpNodePort): number {
  return (port as unknown as { subscriptions: Set<unknown> }).subscriptions.size
}

/** Track unhandled rejections, so a timeout that leaves a rejected internal promise behind fails the test explicitly. */
function watchUnhandled(): { errors: unknown[]; stop(): void } {
  const errors: unknown[] = []
  const listener = (reason: unknown): void => { errors.push(reason) }
  process.on('unhandledRejection', listener)
  return { errors, stop: () => { process.off('unhandledRejection', listener) } }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
})

describe('HttpNodePort.inspect timeout', () => {
  it('rejects when /events never sends response headers', async () => {
    const unhandled = watchUnhandled()
    try {
      const server = await listen((req, res) => {
        // The SSE request hangs before its headers: the timeout must cover opening the stream, not only the answer.
        if (req.url === '/events') return
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })
      const port = new HttpNodePort({ url: server.url, token: TOKEN, inspectionTimeoutMs: TIMEOUT })

      const started = Date.now()
      await expect(port.inspect('session-1')).rejects.toThrow(
        `The node did not answer session.inspect for session-1 within ${TIMEOUT} ms`)
      expect(Date.now() - started).toBeLessThan(1000)
      expect(subscriptionCount(port)).toBe(0)
      await sleep(20)
      expect(unhandled.errors).toEqual([])
    } finally {
      unhandled.stop()
    }
  })

  it('rejects when /events is open but /commands never answers', async () => {
    const unhandled = watchUnhandled()
    try {
      const server = await listen((req, res) => {
        if (req.url === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
          res.flushHeaders()
          return
        }
        // Drain the command body but never answer it: the POST is inside the same deadline.
        req.resume()
      })
      const port = new HttpNodePort({ url: server.url, token: TOKEN, inspectionTimeoutMs: TIMEOUT })

      await expect(port.inspect('session-1')).rejects.toThrow(
        `The node did not answer session.inspect for session-1 within ${TIMEOUT} ms`)
      expect(subscriptionCount(port)).toBe(0)
      await sleep(20)
      expect(unhandled.errors).toEqual([])
    } finally {
      unhandled.stop()
    }
  })

  it('returns the inspection the node emits for the command', async () => {
    const unhandled = watchUnhandled()
    let events: ServerResponse | undefined
    const commands: NodeCommand[] = []
    try {
      const server = await listen((req, res) => {
        if (req.url === '/events') {
          events = res
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
          res.flushHeaders()
          return
        }
        if (req.url !== '/commands') {
          res.writeHead(404).end()
          return
        }
        void requestBody(req).then(text => {
          const command = JSON.parse(text) as NodeCommand
          commands.push(command)
          const sessionId = command.type === 'session.inspect' ? command.sessionId : ''
          const event: NodeEvent = { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: 'local', sessionId,
            projectId: 'project-1', role: 'worker', seq: 1, at: START, type: 'session.inspected',
            requestId: command.idempotencyKey, inspection: { sessionId, found: true, status: 'idle' } }
          events!.write(`data: ${JSON.stringify(event)}\n\n`)
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        })
      })
      const port = new HttpNodePort({ url: server.url, token: TOKEN, inspectionTimeoutMs: 1000 })

      await expect(port.inspect('session-1')).resolves.toEqual({ sessionId: 'session-1', found: true, status: 'idle' })
      expect(commands).toHaveLength(1)
      expect(commands[0]).toMatchObject({ type: 'session.inspect', sessionId: 'session-1' })
      expect(subscriptionCount(port)).toBe(0)
      await sleep(20)
      expect(unhandled.errors).toEqual([])
    } finally {
      unhandled.stop()
    }
  })
})
