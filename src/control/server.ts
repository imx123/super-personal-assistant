/** Minimal loopback HTTP API for the standalone control-plane kernel. */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { UserError, type ProjectTicketTask, type WorkerReport } from '../core/index.ts'
import { WORKER_REPORT_STATES, type NodeEvent } from '../shared/protocol.ts'
import { SessionTokenError } from '../shared/session-token.ts'
import { ControlPlane, SessionEnsureError, ToolCallError, type ToolCallErrorCode } from './control-plane.ts'

export interface ControlPlaneServerOptions {
  /** Bearer token required by every `/v1` route; `/health` stays public. */
  token: string
  /**
   * Optional read-only bearer token: it may `GET` the read routes and is refused with 403 on everything that writes.
   * Unset, the server accepts exactly the one token it always did. It must differ from `token`: one secret cannot carry
   * two roles without hiding a deployment mistake.
   */
  viewerToken?: string
  host?: string
  /** How often an open event stream writes a keepalive comment; tests shorten it. */
  keepaliveMs?: number
}

/** The interval an idle event stream is kept alive with, well under the usual 30–60 s proxy idle timeout. */
const DEFAULT_KEEPALIVE_MS = 15_000

/** A client-facing HTTP status and a message that is safe to return. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 128 * 1024) throw new HttpError(413, 'Request body is too large')
    chunks.push(bytes)
  }
  if (size === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object')
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'A non-empty string is required')
  return value
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given?.startsWith('Bearer ')) return false
  const actual = Buffer.from(given.slice('Bearer '.length), 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

/**
 * The last event a stream client already saw, from its `after` query or its `Last-Event-ID` header.
 *
 * A value may be omitted or empty (meaning "from the beginning"), and anything else must be a non-negative safe
 * integer: an unparseable cursor would silently replay the wrong slice, so it is a client error instead.
 */
function cursor(value: string | string[] | null | undefined, name: string): number {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === null || raw === undefined || raw === '') return 0
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, `${name} must be a non-negative integer`)
  return parsed
}

/** The Session token a tool request carries; a missing or malformed header is an authentication failure. */
function bearer(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'A Session bearer token is required')
  const token = header.slice('Bearer '.length)
  if (token === '') throw new HttpError(401, 'A Session bearer token is required')
  return token
}

/** The Worker report states a tool may submit; `waiting` is the Executor's own, never a Worker's claim. */
const REPORT_STATES = WORKER_REPORT_STATES

function stringValue(value: unknown, name: string, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw new HttpError(400, `${name} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`)
  const trimmed = value.trim()
  if (required && trimmed === '') throw new HttpError(400, `${name} must be a non-empty string`)
  return trimmed
}

/** One `threads` entry: a bare `source:id` key or its object form, as the Engine's task type accepts it. */
function threadValue(value: unknown, name: string): { key: string; contextOnly?: boolean } {
  if (typeof value === 'string') return { key: stringValue(value, name, true)! }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${name} must be a "source:id" key or an object with a key`)
  }
  const thread = value as Record<string, unknown>
  const key = stringValue(thread.key, `${name}.key`, true)!
  if (thread.contextOnly !== undefined && typeof thread.contextOnly !== 'boolean') {
    throw new HttpError(400, `${name}.contextOnly must be a boolean`)
  }
  return thread.contextOnly === true ? { key, contextOnly: true } : { key }
}

/** Validate the PM tool's `tasks` array into Engine task inputs; the Engine still enforces its own limits. */
function parseTasks(value: unknown): ProjectTicketTask[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'tasks must be a non-empty array')
  return value.map((item, index) => {
    const path = `tasks[${index}]`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new HttpError(400, `${path} must be an object`)
    }
    const task = item as Record<string, unknown>
    const parsed: ProjectTicketTask = { title: stringValue(task.title, `${path}.title`, true)!,
      goal: stringValue(task.goal, `${path}.goal`, true)! }
    const scope = stringValue(task.scope, `${path}.scope`, false)
    if (scope !== undefined) parsed.scope = scope
    const note = stringValue(task.note, `${path}.note`, false)
    if (note) parsed.note = note
    if (task.threads !== undefined) {
      if (!Array.isArray(task.threads)) throw new HttpError(400, `${path}.threads must be an array`)
      parsed.threads = task.threads.map((thread, at) => threadValue(thread, `${path}.threads[${at}]`))
    }
    return parsed
  })
}

/** Validate the Worker tool's `report` object; identity and Ticket rules stay with the control plane. */
function parseWorkerReport(value: unknown): WorkerReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'report must be an object')
  }
  const report = value as Record<string, unknown>
  const state = report.state
  if (typeof state !== 'string' || !(REPORT_STATES as readonly string[]).includes(state)) {
    throw new HttpError(400, `report.state must be one of ${REPORT_STATES.join(', ')}`)
  }
  const parsed: WorkerReport = { state: state as (typeof REPORT_STATES)[number],
    summary: stringValue(report.summary, 'report.summary', true)! }
  if (report.question === null) parsed.question = null
  else if (report.question !== undefined) parsed.question = stringValue(report.question, 'report.question', true)!
  return parsed
}

/** The client status a refused tool call maps onto. */
const TOOL_STATUS: Record<ToolCallErrorCode, number> = { unauthenticated: 401, forbidden: 403, invalid: 400 }

/** HTTP facade over `ControlPlane`; it adds authentication and JSON parsing, not domain rules. */
export class ControlPlaneServer {
  private readonly server: Server
  private readonly token: string
  private readonly viewerToken: string | undefined
  private readonly host: string
  private readonly keepaliveMs: number
  /** Event streams that are currently open, so `close` can end them instead of waiting on their sockets. */
  private readonly streams = new Set<ServerResponse>()
  private closed = false

  constructor(private readonly control: ControlPlane, options: ControlPlaneServerOptions) {
    if (!options.token) throw new Error('A control-plane API token is required')
    // Refused before a socket exists: treating one secret as both roles would silently widen or narrow real access.
    if (options.viewerToken !== undefined && options.viewerToken !== '' && options.viewerToken === options.token) {
      throw new Error('The read-only viewer token must differ from the control-plane API token')
    }
    this.token = options.token
    // An empty variable means "not configured", the same convention the other optional settings follow.
    this.viewerToken = options.viewerToken === '' ? undefined : options.viewerToken
    this.host = options.host ?? '127.0.0.1'
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS
    this.server = createServer((req, res) => { void this.handle(req, res) })
  }

  async listen(port = 0): Promise<{ url: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { this.server.off('error', failed); reject(error) }
      this.server.once('error', failed)
      this.server.listen(port, this.host, () => { this.server.off('error', failed); resolve() })
    })
    const address = this.server.address() as AddressInfo
    return { url: `http://${this.host}:${address.port}`, port: address.port }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // An open SSE response never finishes on its own, so the server would wait forever for it: end every stream first.
    for (const stream of [...this.streams]) {
      this.streams.delete(stream)
      try { stream.end() } catch { /* an already-broken socket needs no ending */ }
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
      if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'superagent-control-plane' })
      if (!url.pathname.startsWith('/v1')) throw new HttpError(404, 'Not found')
      // Tool routes authenticate the acting Session, not the operator: a token issued for one PM or Worker is the only
      // authority there, so the control-plane API token must never open them (and vice versa).
      if (url.pathname.startsWith('/v1/tools/')) return await this.handleTool(req, res, url)

      const method = req.method ?? 'GET'
      // Authentication runs before routing, so a route added below can never forget the check. A viewer passes only for
      // the reads further down — every one of them is a `GET` — and every write is refused right here.
      this.authenticate(req.headers.authorization, method)

      if (method === 'GET' && url.pathname === '/v1/state') return json(res, 200, this.control.state())
      if (method === 'GET' && url.pathname === '/v1/projects') return json(res, 200, { projects: this.control.projects() })
      if (method === 'GET' && url.pathname === '/v1/tickets') return json(res, 200, { tickets: this.control.tickets() })
      if (method === 'GET' && url.pathname === '/v1/sessions') return json(res, 200, { sessions: [...this.control.sessions.values()] })
      if (method === 'GET' && url.pathname === '/v1/events') {
        const after = Number(url.searchParams.get('after') ?? 0)
        if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'after must be a non-negative integer')
        return json(res, 200, { events: this.control.events.filter(event => event.seq > after) })
      }
      if (method === 'GET' && url.pathname === '/v1/events/stream') return this.eventStream(req, res, url)

      if (method === 'POST' && url.pathname === '/v1/nodes/register') {
        const body = await readJson(req)
        await this.control.registerNode({
          ...(typeof body.version === 'string' ? { version: body.version } : {}),
          ...(Array.isArray(body.capabilities) ? { capabilities: body.capabilities as string[] } : {}),
        })
        return json(res, 200, { registered: true, state: this.control.state() })
      }

      const heartbeat = /^\/v1\/nodes\/([^/]+)\/heartbeat$/.exec(url.pathname)
      if (method === 'POST' && heartbeat) {
        const body = await readJson(req)
        if (body.online !== undefined && typeof body.online !== 'boolean') throw new HttpError(400, 'online must be a boolean')
        await this.control.heartbeat(body.online !== false)
        return json(res, 200, { ok: true })
      }

      const pm = /^\/v1\/projects\/([^/]+)\/pm$/.exec(url.pathname)
      if (method === 'POST' && pm) {
        const body = await readJson(req)
        const session = await this.control.openProject(decodeURIComponent(pm[1]!), typeof body.workspace === 'string' ? body.workspace : undefined)
        if (session.status === 'failed') throw new HttpError(502, 'The node could not create the PM Session')
        // Defensive: a starting record is not an answer, and the client must retry rather than believe it.
        if (session.status === 'starting') throw new HttpError(502, 'The node did not confirm the PM Session')
        return json(res, 200, { session })
      }

      const worker = /^\/v1\/projects\/([^/]+)\/workers$/.exec(url.pathname)
      if (method === 'POST' && worker) {
        const body = await readJson(req)
        const assignmentId = text(body.assignmentId)
        const ticketId = body.ticketId === undefined ? assignmentId : text(body.ticketId)
        const session = await this.control.createWorkerSession(decodeURIComponent(worker[1]!), assignmentId, ticketId,
          typeof body.prompt === 'string' ? body.prompt : undefined)
        if (session.status === 'failed') throw new HttpError(502, 'The node could not create the Worker Session')
        if (session.status === 'starting') throw new HttpError(502, 'The node did not confirm the Worker Session')
        return json(res, 200, { session })
      }

      const sessionPath = /^\/v1\/sessions\/([^/]+)(?:\/(message|cancel|archive|permission))?$/.exec(url.pathname)
      if (sessionPath) {
        const sessionId = decodeURIComponent(sessionPath[1]!)
        const action = sessionPath[2]
        if (method === 'GET' && action === undefined) {
          const session = this.control.session(sessionId)
          if (!session) throw new HttpError(404, 'Session not found')
          return json(res, 200, { session })
        }
        if (method === 'POST' && action === 'message') {
          const body = await readJson(req)
          await this.control.sendMessage(sessionId, text(body.text))
          return json(res, 200, { sent: true })
        }
        if (method === 'POST' && action === 'cancel') {
          const body = await readJson(req)
          await this.control.cancelSession(sessionId, typeof body.reason === 'string' ? body.reason : undefined)
          return json(res, 200, { cancelled: true })
        }
        if (method === 'POST' && action === 'archive') {
          await this.control.archiveSession(sessionId)
          return json(res, 200, { archived: true })
        }
        if (method === 'PUT' && action === 'permission') {
          const body = await readJson(req)
          const permission = text(body.permission)
          await this.control.setPermission(sessionId, permission)
          return json(res, 200, { permission })
        }
      }

      throw new HttpError(404, 'Not found')
    } catch (error) {
      // Once an event stream answered, an error can only end it; writing a JSON status would throw over its headers.
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof HttpError) return json(res, error.status, { error: error.message })
      // A bad, expired or mismatched Session token is an authentication failure, never a server bug.
      if (error instanceof SessionTokenError) return json(res, 401, { error: error.message })
      if (error instanceof ToolCallError) return json(res, TOOL_STATUS[error.code], { error: error.message })
      // Engine refusals (an invalid task, an ended Ticket, a question beside a result) are the caller's to correct.
      if (error instanceof UserError) return json(res, error.missing ? 404 : 400, { error: error.message })
      if (error instanceof SessionEnsureError) return json(res, 502, { error: error.message })
      const message = error instanceof Error ? error.message : String(error)
      return json(res, /^Unknown (project|session)/.test(message) ? 404 : 500, { error: message })
    }
  }

  /**
   * Accept one control-plane bearer token for one request, or throw the status the client should see.
   *
   * The operator token may do anything below. The optional viewer token may only `GET`, which is exactly the read half of
   * the API; a write with it is an authenticated 403, never a 401, and the message says why without echoing any token. A
   * missing, wrong or Session token stays a 401 before either role is considered.
   */
  private authenticate(header: string | undefined, method: string): void {
    if (tokenMatches(header, this.token)) return
    if (this.viewerToken !== undefined && tokenMatches(header, this.viewerToken)) {
      if (method !== 'GET') throw new HttpError(403, 'A read-only viewer token may only GET /v1 read routes')
      return
    }
    throw new HttpError(401, 'A control-plane bearer token is required')
  }

  /**
   * The control plane's event stream: replay what the kernel already recorded, then follow it live.
   *
   * Authentication is a control-plane bearer token, checked before this method runs: the operator's, or the read-only
   * viewer's because this is a GET, and never a Session token. `after` (query) or `Last-Event-ID` (header) names the last
   * event the client saw; the query wins when both are present. Each frame carries its `seq` as the SSE id and the event
   * as JSON, so a client that reconnects with the id it last read receives exactly the events it missed and none twice.
   * No token is part of a frame: the kernel removes tokens before a Session record is stored, and no node event carries
   * one.
   */
  private eventStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const after = url.searchParams.has('after')
      ? cursor(url.searchParams.get('after'), 'after')
      : cursor(req.headers['last-event-id'], 'Last-Event-ID')
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
    res.flushHeaders()
    res.write(': connected\n\n')

    const write = (event: NodeEvent): void => {
      if (this.closed || res.writableEnded || res.destroyed) return
      try {
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // A broken socket must not fail the kernel call that produced the event; the close listener cleans up.
      }
    }
    // Subscribe before replaying, synchronously: no event can be delivered between the backlog and the subscription,
    // and because both run in one turn of the event loop, a replayed event cannot be written twice either.
    const unsubscribe = this.control.subscribe(write)
    for (const event of this.control.events) {
      if (event.seq > after) write(event)
    }
    const keepalive = setInterval(() => {
      if (this.closed || res.writableEnded || res.destroyed) return
      try {
        res.write(': keepalive\n\n')
      } catch {
        // The close listener below cleans up.
      }
    }, this.keepaliveMs)
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

  /**
   * The control-plane tools a PM or Worker calls through its Session token.
   *
   * These routes exist for the node's proxy tools: the token proves which Session acts, and the kernel derives the
   * Project and Assignment from it. The body only names work inside that scope, never authority.
   */
  private async handleTool(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET'
    const token = bearer(req.headers.authorization)

    // Refreshing extends the caller's own Session and reads no body: the present token selects it, so no role check is
    // needed. It is checked before the ordinary tool routes because this is the one place a token one generation behind the
    // record is still accepted, and the one place an already expired token is: the kernel's bounded grace lets a long task
    // that outlived its TTL rotate itself instead of being stranded. Every other route below verifies strictly and answers
    // 401 for both.
    if (method === 'POST' && url.pathname === '/v1/tools/token/refresh') {
      const claims = this.control.verifyToolToken(token, { allowPrevious: true,
        allowExpiredSeconds: this.control.tokenRefreshGraceSeconds })
      const refreshed = this.control.refreshToolToken(claims.sid)
      const expiresAt = new Date(this.control.verifyToolToken(refreshed).exp * 1000).toISOString()
      return json(res, 200, { token: refreshed, expiresAt })
    }

    const claims = this.control.verifyToolToken(token)

    // The PM's read path: its own Project and Tickets, derived from the token's Session and never from a body.
    if (method === 'GET' && url.pathname === '/v1/tools/pm/context') {
      if (claims.role !== 'pm') throw new ToolCallError('forbidden', 'A PM Session token is required')
      return json(res, 200, this.control.pmContext(claims.sid))
    }

    if (method === 'POST' && url.pathname === '/v1/tools/pm/tickets') {
      if (claims.role !== 'pm') throw new ToolCallError('forbidden', 'A PM Session token is required')
      const body = await readJson(req)
      const tickets = this.control.pmCreateTickets(claims.sid, parseTasks(body.tasks))
      return json(res, 200, { tickets })
    }

    if (method === 'POST' && url.pathname === '/v1/tools/worker/report') {
      if (claims.role !== 'worker') throw new ToolCallError('forbidden', 'A Worker Session token is required')
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const assignmentId = body.assignmentId === undefined ? undefined : text(body.assignmentId)
      const ticket = this.control.workerReport(claims.sid, ticketId, assignmentId, parseWorkerReport(body.report))
      return json(res, 200, { ticket })
    }

    throw new HttpError(404, 'Not found')
  }
}
