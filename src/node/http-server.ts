/** HTTP + SSE transport for one execution node. It uses `node:http` only and never imports DSH. */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type NodeCommand, type NodeEvent, type NodePort } from '../shared/protocol.ts'
import { NodeCommandError, validateNodeCommand } from './command-validation.ts'

export interface NodeHttpServerOptions {
  /** The node whose commands and events the HTTP facade exposes. */
  node: NodePort
  /** Bearer token required by `/commands`; `/health` stays public. */
  token: string
  /** Listen address; loopback by default. */
  host?: string
  /** Port; `0` asks the operating system for a free one. */
  port?: number
}

const MAX_COMMAND_BYTES = 256 * 1024
const KEEPALIVE_MS = 15_000

/** A client-facing HTTP status and a message that is safe to return. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_COMMAND_BYTES) throw new HttpError(413, 'Command body is too large')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'Command body must be JSON')
  }
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given?.startsWith('Bearer ')) return false
  const actual = Buffer.from(given.slice('Bearer '.length), 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

/**
 * Refuse a command before dispatch when its envelope or its type's fields are not what the protocol promises.
 *
 * The node stays the authority on whether a well-formed command applies to it; this only stops a command that cannot be
 * executed at all. `validateNodeCommand` reports why, and `commandStatus` turns that into the HTTP answer.
 */
function parseCommand(value: unknown): NodeCommand {
  return validateNodeCommand(value)
}

/** The HTTP status a refused command deserves: an unknown command or protocol is bad input, bad fields unprocessable. */
function commandStatus(error: NodeCommandError): number {
  switch (error.code) {
    case 'unsupported-protocol-version':
    case 'unknown-command':
      return 400
    case 'invalid-command':
      return 422
    case 'execution-failed':
      return 500
  }
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** The HTTP/SSE facade over one `NodePort`; it adds authentication and framing, not node rules. */
class NodeHttpServer {
  private readonly server: Server
  private readonly streams = new Set<ServerResponse>()
  private readonly node: NodePort
  private readonly token: string
  private readonly host: string
  private closed = false

  constructor(options: NodeHttpServerOptions) {
    if (!options.token) throw new Error('A node bearer token is required')
    this.node = options.node
    this.token = options.token
    this.host = options.host ?? '127.0.0.1'
    this.server = createServer((req, res) => { void this.handle(req, res) })
  }

  async listen(port: number): Promise<{ url: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { this.server.off('error', failed); reject(error) }
      this.server.once('error', failed)
      this.server.listen(port, this.host, () => { this.server.off('error', failed); resolve() })
    })
    const address = this.server.address() as AddressInfo
    return { url: `http://${formatHost(this.host)}:${address.port}`, port: address.port }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const stream of [...this.streams]) {
      this.streams.delete(stream)
      stream.end()
    }
    if (!this.server.listening) return
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve())
      this.server.closeAllConnections()
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? this.host}`)
      if (url.pathname === '/health') {
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        return json(res, 200, { ok: true, service: 'superagent-node' })
      }
      if (url.pathname !== '/commands' && url.pathname !== '/events') throw new HttpError(404, 'Not found')
      if (!tokenMatches(req.headers.authorization, this.token)) throw new HttpError(401, 'A node bearer token is required')

      if (url.pathname === '/commands') {
        if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        const command = parseCommand(await readJson(req))
        try {
          await this.node.send(command)
        } catch (error) {
          // A port that predates `NodeCommandError` reports a refusal as a plain Error; keep it a client error.
          if (error instanceof NodeCommandError) throw error
          throw new HttpError(400, error instanceof Error ? error.message : String(error))
        }
        return json(res, 200, { ok: true })
      }

      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed')
      this.events(res)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof NodeCommandError) {
        return json(res, commandStatus(error), { error: error.message, code: error.code })
      }
      if (error instanceof HttpError) return json(res, error.status, { error: error.message })
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private events(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
    res.flushHeaders()
    res.write(': connected\n\n')

    const send = (event: NodeEvent): void => {
      if (this.closed || res.writableEnded || res.destroyed) return
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch {
        // A broken socket must not fail the command that produced the event; `close` unsubscribes.
      }
    }
    const unsubscribe = this.node.subscribe(send)
    const keepalive = setInterval(() => {
      if (this.closed || res.writableEnded || res.destroyed) return
      try {
        res.write(': keepalive\n\n')
      } catch {
        // The close listener below cleans up.
      }
    }, KEEPALIVE_MS)
    keepalive.unref()
    this.streams.add(res)

    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      clearInterval(keepalive)
      this.streams.delete(res)
      unsubscribe()
    }
    res.once('close', cleanup)
    res.once('error', cleanup)
  }
}

/**
 * Start the node's HTTP facade. `POST /commands` accepts a `NodeCommand`, `GET /events` streams
 * `NodeEvent`s as SSE, and `GET /health` is public. The returned `close` ends open streams and the server.
 */
export async function startNodeHttpServer(
  options: NodeHttpServerOptions,
): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const server = new NodeHttpServer(options)
  const address = await server.listen(options.port ?? 0)
  return { url: address.url, port: address.port, close: () => server.close() }
}
