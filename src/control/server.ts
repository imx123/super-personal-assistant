/** Minimal loopback HTTP API for the standalone control-plane kernel. */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { UserError, type ProjectTicketTask, type WorkerReport } from '../core/index.ts'
import { WORKER_REPORT_STATES } from '../shared/protocol.ts'
import { SessionTokenError } from '../shared/session-token.ts'
import { ControlPlane, SessionEnsureError, ToolCallError, type ToolCallErrorCode } from './control-plane.ts'

export interface ControlPlaneServerOptions {
  /** Bearer token required by every `/v1` route; `/health` stays public. */
  token: string
  host?: string
}

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
  private readonly host: string

  constructor(private readonly control: ControlPlane, options: ControlPlaneServerOptions) {
    if (!options.token) throw new Error('A control-plane API token is required')
    this.token = options.token
    this.host = options.host ?? '127.0.0.1'
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
    if (!this.server.listening) return
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? this.host}`)
      if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'superagent-control-plane' })
      if (!url.pathname.startsWith('/v1')) throw new HttpError(404, 'Not found')
      // Tool routes authenticate the acting Session, not the operator: a token issued for one PM or Worker is the only
      // authority there, so the control-plane API token must never open them (and vice versa).
      if (url.pathname.startsWith('/v1/tools/')) return await this.handleTool(req, res, url)
      if (!tokenMatches(req.headers.authorization, this.token)) throw new HttpError(401, 'A control-plane bearer token is required')

      const method = req.method ?? 'GET'
      if (method === 'GET' && url.pathname === '/v1/state') return json(res, 200, this.control.state())
      if (method === 'GET' && url.pathname === '/v1/projects') return json(res, 200, { projects: this.control.projects() })
      if (method === 'GET' && url.pathname === '/v1/tickets') return json(res, 200, { tickets: this.control.tickets() })
      if (method === 'GET' && url.pathname === '/v1/sessions') return json(res, 200, { sessions: [...this.control.sessions.values()] })
      if (method === 'GET' && url.pathname === '/v1/events') {
        const after = Number(url.searchParams.get('after') ?? 0)
        if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'after must be a non-negative integer')
        return json(res, 200, { events: this.control.events.filter(event => event.seq > after) })
      }

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
   * The control-plane tools a PM or Worker calls through its Session token.
   *
   * These routes exist for the node's proxy tools: the token proves which Session acts, and the kernel derives the
   * Project and Assignment from it. The body only names work inside that scope, never authority.
   */
  private async handleTool(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET'
    const token = bearer(req.headers.authorization)
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
