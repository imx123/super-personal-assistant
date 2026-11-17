/** Minimal loopback HTTP API for the standalone control-plane kernel. */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { UserError, type ProjectTicketTask, type WorkerReport } from '../core/index.ts'
import { packagePath } from '../infra/paths.ts'
import { ROUTER_ATTACHMENT_BYTES, ROUTER_ATTACHMENT_COUNT, WORKER_REPORT_STATES,
  type NodeEvent, type RouterModel, type RouterTextAttachment } from '../shared/protocol.ts'
import { SessionTokenError } from '../shared/session-token.ts'
import { DeploymentError, type DeploymentScope, type DeploymentSettings } from '../shared/deployment.ts'
import { CONSOLE_BUNDLE, CONSOLE_CSP, ConsoleAssets } from './console-assets.ts'
import { ControlPlane, EVENT_REPLAY_LIMIT, OperatorError, SessionEnsureError, ToolCallError,
  type ToolCallErrorCode } from './control-plane.ts'
import { ScheduleError, describeScheduleRule, parseScheduleRule, type SchedulePlan } from './scheduler.ts'

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
  /**
   * The directory the built console lives in.
   *
   * It defaults to the package's own `lib` directory, where the build puts the console's bundle. The directory holds one
   * file, `console.js`; nothing else of the package is served.
   */
  consoleDir?: string
  deployment?: Record<DeploymentScope, DeploymentSettings>
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

function routerModel(value: unknown): RouterModel | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Invalid Router model')
  const model = value as Record<string, unknown>
  const provider = text(model.provider).trim()
  const id = text(model.model).trim()
  if (provider.length > 128 || id.length > 256) throw new HttpError(400, 'Invalid Router model')
  return { provider, model: id }
}

function routerAttachments(value: unknown): RouterTextAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ROUTER_ATTACHMENT_COUNT) {
    throw new HttpError(400, `Attach up to ${ROUTER_ATTACHMENT_COUNT} files`)
  }
  let bytes = 0
  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new HttpError(400, 'Invalid attachment')
    const name = text(entry.name).split(/[\\/]/).at(-1)!.trim()
    if (name === '' || name.length > 240 || /[\x00-\x1f]/.test(name)
      || typeof entry.text !== 'string' || entry.text.includes('\0')) {
      throw new HttpError(400, 'Attach a UTF-8 text file with a valid name')
    }
    bytes += Buffer.byteLength(entry.text, 'utf8')
    if (bytes > ROUTER_ATTACHMENT_BYTES) throw new HttpError(413, 'Attachments exceed 48 KB in total')
    return { name, text: entry.text }
  })
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

/**
 * Run one scheduler call and turn its refusal into a status the client can read.
 *
 * A rule that cannot be read is the caller's to correct (400), and a plan that does not exist is simply not there (404).
 */
function schedule<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof ScheduleError) throw new HttpError(error.code === 'unknown-plan' ? 404 : 400, error.message)
    throw error
  }
}

/**
 * One plan, as the console reads it.
 *
 * The rule comes twice: the way the operator wrote it, and the way a person can check it against a calendar. The time base
 * is the scheduler's own fixed offset, so the console never has to guess which clock the plan uses.
 */
interface SchedulePlanView {
  id: string
  projectId: string
  projectTitle: string
  projectStatus: string
  name: string
  rule: string
  ruleText: string
  message: string
  enabled: boolean
  nextAt: string
  lastAt?: string
  lastState?: string
  lastError?: string
  lastRunId?: string
  createdAt: string
  updatedAt: string
}

/** One plan as the console reads it, with the Project it belongs to named. */
function scheduleView(control: ControlPlane, plan: SchedulePlan): SchedulePlanView {
  const project = control.projects().find(entry => entry.id === plan.projectId)
  let ruleText = plan.rule
  try {
    ruleText = describeScheduleRule(parseScheduleRule(plan.rule))
  } catch {
    // A rule that cannot be read is shown as it was written: the page says what is stored, not a guess.
  }
  return { id: plan.id, projectId: plan.projectId, projectTitle: project?.title ?? plan.projectId,
    projectStatus: project?.status ?? 'unknown', name: plan.name, rule: plan.rule, ruleText, message: plan.message,
    enabled: plan.enabled, nextAt: plan.nextAt, ...(plan.lastAt === undefined ? {} : { lastAt: plan.lastAt }),
    ...(plan.lastState === undefined ? {} : { lastState: plan.lastState }),
    ...(plan.lastError === undefined ? {} : { lastError: plan.lastError }),
    ...(plan.lastRunId === undefined ? {} : { lastRunId: plan.lastRunId }),
    createdAt: plan.createdAt, updatedAt: plan.updatedAt }
}

/** HTTP facade over `ControlPlane`; it adds authentication and JSON parsing, not domain rules. */
export class ControlPlaneServer {
  private readonly server: Server
  private readonly token: string
  private readonly viewerToken: string | undefined
  private readonly host: string
  private readonly keepaliveMs: number
  /** The console's own files: the page and the bundle it runs. */
  private readonly assets: ConsoleAssets
  /** Event streams that are currently open, so `close` can end them instead of waiting on their sockets. */
  private readonly streams = new Set<ServerResponse>()
  private closed = false

  constructor(private readonly control: ControlPlane, private readonly options: ControlPlaneServerOptions) {
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
    this.assets = new ConsoleAssets({ directory: options.consoleDir ?? packagePath('lib') })
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
      // The console's own page and bundle are public: the page holds no credential, and the browser is asked for the
      // control-plane key itself. Every `/v1` route below keeps its bearer check.
      if (url.pathname === '/console' || url.pathname === '/console/') return this.consoleShell(res)
      if (url.pathname === `/console/${CONSOLE_BUNDLE}`) return this.consoleScript(res)
      if (!url.pathname.startsWith('/v1')) throw new HttpError(404, 'Not found')
      // Tool routes authenticate the acting Session, not the operator: a token issued for one PM or Worker is the only
      // authority there, so the control-plane API token must never open them (and vice versa).
      if (url.pathname.startsWith('/v1/tools/')) return await this.handleTool(req, res, url)

      const method = req.method ?? 'GET'
      // Authentication runs before routing, so a route added below can never forget the check. A viewer passes only for
      // the reads further down — every one of them is a `GET` — and every write is refused right here.
      this.authenticate(req.headers.authorization, method, url.pathname.startsWith('/v1/console/deployment/'))

      if (method === 'GET' && url.pathname === '/v1/state') return json(res, 200, this.control.state())
      if (method === 'GET' && url.pathname === '/v1/overview') return json(res, 200, this.control.overview())
      if (method === 'GET' && url.pathname === '/v1/audit') {
        const limit = this.limit(url.searchParams.get('limit'))
        const kind = url.searchParams.get('kind')
        return json(res, 200, { entries: this.control.auditEntries({
          ...(limit === undefined ? {} : { limit }), ...(kind === null || kind === '' ? {} : { kind }) }) })
      }
      if (method === 'GET' && url.pathname === '/v1/projects') return json(res, 200, { projects: this.control.projects() })
      if (method === 'GET' && url.pathname === '/v1/tickets') return json(res, 200, { tickets: this.control.tickets() })
      if (method === 'GET' && url.pathname === '/v1/sessions') {
        // The Sessions with what may still be done with them: a Worker Session that a newer Assignment replaced cannot
        // receive a message, and the console is told so instead of offering an action the server would refuse.
        return json(res, 200, { sessions: this.control.consoleSessions() })
      }
      if (method === 'GET' && url.pathname === '/v1/events') {
        const after = Number(url.searchParams.get('after') ?? 0)
        if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'after must be a non-negative integer')
        const history = this.control.eventHistory(after)
        // A gap is reported instead of hidden: the log is bounded, and the events it dropped cannot be delivered again.
        return json(res, 200, { events: history.events, ...(history.gap ? { gap: true } : {}) })
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

      // The console's own namespace: every human action on a Project or a Session, and the Router's conversation.
      // The low-level routes below keep the semantics they always had, so an older client is not broken by the console's
      // own vocabulary.
      if (url.pathname.startsWith('/v1/console/')) return await this.handleConsole(req, res, url)

      const pm = /^\/v1\/projects\/([^/]+)\/pm$/.exec(url.pathname)
      if (method === 'POST' && pm) {
        const body = await readJson(req)
        const session = await this.control.openProject(decodeURIComponent(pm[1]!), typeof body.workspace === 'string' ? body.workspace : undefined)
        if (session.status === 'failed') throw new HttpError(502, 'The node could not create the PM Session')
        // Defensive: a starting record is not an answer, and the client must retry rather than believe it.
        if (session.status === 'starting') throw new HttpError(502, 'The node did not confirm the PM Session')
        return json(res, 200, { session })
      }

      // The low-level Worker creation: a Worker Session for an Assignment the caller names. It is not offered to the
      // browser — a Worker exists because an Assignment does — and it keeps the semantics it always had.
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
          // A revoked Session has no authority left: the refusal is a fact about the Session, not about one credential.
          if (this.control.session(sessionId)?.revokedAt) {
            throw new HttpError(409, `The Session ${sessionId} was revoked; it cannot receive a message any more`)
          }
          // The low-level delivery: the message goes straight to the Session the caller named.
          await this.control.sendMessage(sessionId, text(body.text))
          return json(res, 200, { sent: true })
        }
        if (method === 'POST' && action === 'cancel') {
          const body = await readJson(req)
          // The low-level cancel: the Session is stopped on the node, and nothing else about it changes.
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
      if (error instanceof DeploymentError) return json(res, error.status, { error: error.message })
      // A refused operator action: the request was understood and the domain's own rules forbid it.
      if (error instanceof OperatorError) return json(res, error.status, { error: error.message })
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
   * The console's own routes: the human actions on a Project and a Session, the reconciliation, and the Router.
   *
   * They live in their own namespace, so the low-level routes keep the semantics they always had: a client that cancels a
   * Session still cancels that Session and nothing else, and a client that archives a PM Session still archives it. Every
   * action here goes through the domain's own primitives, and every answer says what really happened: a stop the node did
   * not confirm is reported as unconfirmed, never as a success.
   */
  private async handleConsole(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET'
    const path = url.pathname

    const deploymentScope = path === '/v1/console/deployment/control' ? 'control'
      : path === '/v1/console/deployment/node' ? 'node' : undefined
    if (deploymentScope && this.options.deployment) {
      const configuration = this.options.deployment[deploymentScope]
      if (method === 'GET') return json(res, 200, configuration.view())
      if (method === 'PUT') return json(res, 200, configuration.save(await readJson(req)))
    }

    if (path === '/v1/console/settings') {
      if (method === 'GET') return json(res, 200, this.control.runtimeSettings())
      if (method === 'PUT') return json(res, 200, this.control.saveRuntimeSettings(await readJson(req)))
      if (method === 'DELETE') return json(res, 200, this.control.resetRuntimeSettings())
    }

    if (method === 'GET' && path === '/v1/console/projects') {
      // The console's own read of the Projects: the same facts, with the status of each Ticket derived by the kernel
      // instead of by the browser.
      return json(res, 200, { projects: this.control.consoleProjects(), workspaceRoot: this.control.projectWorkspaceRoot(),
        standaloneTickets: this.control.consoleStandaloneTickets() })
    }
    if (method === 'POST' && path === '/v1/console/projects') {
      const body = await readJson(req)
      const title = stringValue(body.title, 'title', true)!
      const goal = stringValue(body.goal, 'goal', true)!
      // The Project is created through the domain; the PM is ensured on its own by `/v1/console/projects/:id/pm`.
      const workspace = stringValue(body.workspace, 'workspace', false)
      const project = this.control.createProjectFromOperator(title, goal, workspace)
      return json(res, 201, { project })
    }

    // The Router: its own facts, and the message a person sends it. The first message starts the Router, so a person
    // never has to go to another page before the conversation works.
    if (method === 'GET' && path === '/v1/console/router') {
      return json(res, 200, this.control.routerState())
    }
    if (method === 'GET' && path === '/v1/console/router/options') {
      return json(res, 200, await this.control.routerOptions())
    }
    if (method === 'POST' && path === '/v1/console/router/message') {
      const body = await readJson(req)
      const attachments = routerAttachments(body.attachments)
      const message = attachments.length > 0 && (body.text === undefined || body.text === '')
        ? '请阅读本条消息附带的文件。' : text(body.text)
      const result = await this.control.sendToRouter(message, attachments, routerModel(body.model))
      return json(res, 200, { sent: true, requestId: result.requestId })
    }
    // The proposal a person confirms or cancels. These routes live in the console's own namespace, so they need the
    // console key: a Router Session token may propose, but only a person may confirm. A proposal that was cancelled or
    // that already waited too long is refused with the reason, and a proposal that was really sent cannot be sent again.
    const proposal = /^\/v1\/console\/router\/proposal\/([^/]+)\/(confirm|cancel)$/.exec(path)
    if (proposal && method === 'POST') {
      const proposalId = decodeURIComponent(proposal[1]!)
      if (proposal[2] === 'cancel') {
        return json(res, 200, await this.control.cancelRouterProposal(proposalId))
      }
      return json(res, 200, await this.control.confirmRouterProposal(proposalId))
    }

    // The reconciliation of the Assignments against the Sessions the node holds. It is read on its own routes and run
    // on demand: the control plane has no scheduler of its own yet.
    if (method === 'GET' && path === '/v1/console/reconcile/latest') {
      const runs = this.control.reconcileRuns(1)
      return json(res, 200, { run: runs[0] ?? null })
    }
    if (method === 'GET' && path === '/v1/console/reconcile/runs') {
      const limit = this.limit(url.searchParams.get('limit'))
      return json(res, 200, { runs: this.control.reconcileRuns(limit ?? 10) })
    }
    if (method === 'POST' && path === '/v1/console/reconcile/run') {
      const result = await this.control.reconcile()
      return json(res, 200, { result })
    }

    // The scheduled plans: the plans themselves, and what every run of them did.
    //
    // A plan is a clock and a sentence. It never runs a command, never starts a Session and never dispatches a Worker: at
    // the moment it comes due it hands one message to the PM a Project already has, and the PM decides what to do with it.
    // The routes below only write the plan; the delivery is the scheduler's own work.
    if (method === 'GET' && path === '/v1/console/schedules') {
      return json(res, 200, {
        plans: this.control.schedulePlans().map(plan => scheduleView(this.control, plan)),
        overview: this.control.scheduleOverview(),
        timeZoneOffsetMinutes: this.control.scheduler.timeZoneOffsetMinutes,
      })
    }
    if (method === 'POST' && path === '/v1/console/schedules') {
      const body = await readJson(req)
      const projectId = stringValue(body.projectId, 'projectId', true)!
      const name = stringValue(body.name, 'name', true)!
      const rule = stringValue(body.rule, 'rule', true)!
      const message = stringValue(body.message, 'message', true)!
      const enabled = body.enabled
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        throw new HttpError(400, 'enabled must be a boolean')
      }
      // The Project is checked against the domain: a plan that names a Project nobody has would fail at every moment it
      // came due, and the operator deserves to be told at once.
      const plan = schedule(() => this.control.createSchedule({ projectId, name, rule, message,
        ...(enabled === undefined ? {} : { enabled }) }))
      return json(res, 201, { plan: scheduleView(this.control, plan) })
    }
    const schedulePath = /^\/v1\/console\/schedules\/([^/]+)(?:\/(pause|resume|run|runs))?$/.exec(path)
    if (schedulePath) {
      const planId = decodeURIComponent(schedulePath[1]!)
      const action = schedulePath[2]
      if (method === 'GET' && action === undefined) {
        const plan = this.control.schedulePlan(planId)
        if (!plan) throw new HttpError(404, 'There is no such scheduled task')
        return json(res, 200, { plan: scheduleView(this.control, plan) })
      }
      if (method === 'GET' && action === 'runs') {
        const limit = this.limit(url.searchParams.get('limit'))
        return json(res, 200, { runs: this.control.scheduleRuns(planId, limit ?? 50) })
      }
      if (method === 'PUT' && action === undefined) {
        const body = await readJson(req)
        const patch: { name?: string; rule?: string; message?: string; projectId?: string } = {}
        if (body.name !== undefined) patch.name = stringValue(body.name, 'name', true)!
        if (body.rule !== undefined) patch.rule = stringValue(body.rule, 'rule', true)!
        if (body.message !== undefined) patch.message = stringValue(body.message, 'message', true)!
        if (body.projectId !== undefined) {
          // The Project of a plan is checked against the domain, exactly as at its creation: a plan may only name a
          // Project the control plane really has.
          const projectId = stringValue(body.projectId, 'projectId', true)!
          if (!this.control.projects().some(project => project.id === projectId)) {
            throw new HttpError(400, `Unknown Project ${projectId}`)
          }
          patch.projectId = projectId
        }
        // Whether a plan comes due is not an edit: it has its own routes. The moment a plan comes due moves when its rule
        // changes and when its time base changed — a change of its text alone never moves it.
        const plan = schedule(() => this.control.scheduler.updatePlan(planId, patch))
        return json(res, 200, { plan: scheduleView(this.control, plan) })
      }
      if (method === 'DELETE' && action === undefined) {
        const removed = schedule(() => this.control.scheduler.deletePlan(planId))
        if (!removed) throw new HttpError(404, 'There is no such scheduled task')
        return json(res, 200, { deleted: true })
      }
      if (method === 'POST' && action === 'pause') {
        const plan = schedule(() => this.control.scheduler.pausePlan(planId))
        return json(res, 200, { plan: scheduleView(this.control, plan) })
      }
      if (method === 'POST' && action === 'resume') {
        const plan = schedule(() => this.control.scheduler.resumePlan(planId))
        return json(res, 200, { plan: scheduleView(this.control, plan) })
      }
      if (method === 'POST' && action === 'run') {
        const outcome = await this.control.scheduler.runNow(planId)
        if (outcome.status === 'unknown-plan') throw new HttpError(404, 'There is no such scheduled task')
        // A run that was not delivered is not a success: the answer says why, and the run is on the record either way.
        if (outcome.status === 'failed') throw new HttpError(502, outcome.reason ?? 'The scheduled task was not delivered')
        if (outcome.status === 'busy') throw new HttpError(409, outcome.reason ?? 'This task is running right now')
        return json(res, 200, { outcome })
      }
    }

    // The Project's own lifecycle, through the domain's own primitives.
    const projectAction = /^\/v1\/console\/projects\/([^/]+)\/(pm|pause|stop|archive|unarchive|memory)$/.exec(path)
    if (projectAction && method === 'POST') {
      const projectId = decodeURIComponent(projectAction[1]!)
      const action = projectAction[2]
      const body = await readJson(req)
      if (action === 'pm') {
        const session = await this.control.startProjectPm(projectId,
          typeof body.workspace === 'string' ? body.workspace : undefined)
        if (session.status === 'failed') throw new HttpError(502, 'The node could not create the PM Session')
        // Defensive: a starting record is not an answer, and the client must retry rather than believe it.
        if (session.status === 'starting') throw new HttpError(502, 'The node did not confirm the PM Session')
        return json(res, 200, { session })
      }
      if (action === 'pause') {
        const paused = body.paused === undefined ? true : body.paused
        if (typeof paused !== 'boolean') throw new HttpError(400, 'paused must be a boolean')
        const mode = body.mode === undefined ? 'soft' : body.mode
        if (mode !== 'soft' && mode !== 'hard') throw new HttpError(400, 'mode must be "soft" or "hard"')
        const result = await this.control.pauseProject(projectId, paused, mode)
        return json(res, 200, result)
      }
      if (action === 'stop') {
        const reason = typeof body.reason === 'string' ? body.reason : undefined
        // The answer says which Workers are really gone and which are not: a stop the node did not confirm is reported.
        return json(res, 200, await this.control.stopProject(projectId, reason))
      }
      if (action === 'archive') {
        return json(res, 200, await this.control.archiveProject(projectId))
      }
      if (action === 'unarchive') {
        return json(res, 200, { project: this.control.unarchiveProject(projectId) })
      }
      // The Project's own memory: what an operator wrote down for it.
      const entry = stringValue(body.text, 'text', true)!
      return json(res, 201, { entry: this.control.rememberProject(projectId, entry) })
    }

    const memory = /^\/v1\/console\/projects\/([^/]+)\/memory$/.exec(path)
    if (method === 'GET' && memory) {
      const projectId = decodeURIComponent(memory[1]!)
      return json(res, 200, { entries: this.control.projectMemory(projectId) })
    }

    const sessionPath = /^\/v1\/console\/sessions\/([^/]+)(?:\/(message|messages|cancel|archive|permission|revoke))?$/.exec(path)
    if (sessionPath) {
      const sessionId = decodeURIComponent(sessionPath[1]!)
      const action = sessionPath[2]
      if (method === 'GET' && action === 'messages') {
        // The messages the node reported for this Session, read from the control plane's own log.
        return json(res, 200, { messages: this.control.sessionMessages(sessionId) })
      }
      if (method === 'POST' && action === 'message') {
        const body = await readJson(req)
        // The message goes where the Session's role says it belongs: straight to a PM, and through its Ticket to a
        // Worker, so the domain keeps the record of it. A message may name the Assignment it is meant for: it must be
        // the Session's own, and the Session's own must still be the Ticket's current one.
        const assignmentId = typeof body.assignmentId === 'string' && body.assignmentId !== ''
          ? body.assignmentId : undefined
        const result = await this.control.sendToSession(sessionId, text(body.text),
          assignmentId === undefined ? {} : { assignmentId })
        return json(res, 200, { sent: true, ...result })
      }
      if (method === 'POST' && action === 'cancel') {
        const body = await readJson(req)
        // A Session this kernel does not know is still a client error here, even though the domain treats a Session that
        // was never created as a Worker that never ran.
        if (!this.control.session(sessionId)) throw new HttpError(404, 'Session not found')
        const result = await this.control.stopSessionByOperator(sessionId,
          typeof body.reason === 'string' ? body.reason : undefined)
        // A stop the node did not confirm is reported, never hidden behind a success.
        return json(res, 200, { cancelled: result.stopped, ...result })
      }
      if (method === 'POST' && action === 'archive') {
        const result = await this.control.archiveSessionByOperator(sessionId)
        return json(res, 200, { ...result })
      }
      if (method === 'PUT' && action === 'permission') {
        const body = await readJson(req)
        const permission = text(body.permission)
        await this.control.setPermission(sessionId, permission)
        return json(res, 200, { permission })
      }
      if (method === 'POST' && action === 'revoke') {
        const body = await readJson(req)
        const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : undefined
        const result = await this.control.revokeSession(sessionId, reason)
        return json(res, 200, result)
      }
    }

    throw new HttpError(404, 'Not found')
  }

  /**
   * Accept one control-plane bearer token for one request, or throw the status the client should see.
   *
   * The operator token may do anything below. The optional viewer token may only `GET`, which is exactly the read half of
   * the API; a write with it is an authenticated 403, never a 401, and the message says why without echoing any token. A
   * missing, wrong or Session token stays a 401 before either role is considered.
   */
  private authenticate(header: string | undefined, method: string, deployment = false): void {
    if (tokenMatches(header, this.token)) return
    if (this.viewerToken !== undefined && tokenMatches(header, this.viewerToken)) {
      if (deployment) throw new HttpError(403, '部署设置需要使用控制台连接密钥。')
      if (method !== 'GET') throw new HttpError(403, 'A read-only viewer token may only GET /v1 read routes')
      return
    }
    throw new HttpError(401, 'A control-plane bearer token is required')
  }

  /**
   * The console's page: a shell without any credential.
   *
   * The browser asks for the control-plane key itself and keeps it in memory, so a copy of this page, a proxy that cached
   * it or a screenshot of it holds no secret. The page's own policy forbids every resource but this origin.
   */
  private consoleShell(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': CONSOLE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
    res.end(this.assets.shell())
  }

  /** The console's bundle; it is served only when the console was built. */
  private consoleScript(res: ServerResponse): void {
    const body = this.assets.script()
    if (!body) {
      json(res, 503, { error: 'The console was not built; run the build to produce it' })
      return
    }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache',
      'content-security-policy': CONSOLE_CSP, 'x-content-type-options': 'nosniff' })
    res.end(body)
  }

  /** A page size a client asked for; a value that is not one is refused instead of guessed. */
  private limit(value: string | null): number | undefined {
    if (value === null || value === '') return undefined
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
      throw new HttpError(400, 'limit must be an integer between 1 and 500')
    }
    return parsed
  }

  /**
   * The control plane's event stream: replay what the kernel already recorded, then follow it live.
   *
   * Authentication is a control-plane bearer token, checked before this method runs: the operator's, or the read-only
   * viewer's because this is a GET, and never a Session token. `after` (query) or `Last-Event-ID` (header) names the last
   * event the client saw; the query wins when both are present. Each frame carries its `seq` as the SSE id and the event
   * as JSON, so a client that reconnects with the id it last read receives exactly the events it missed and none twice.
   * The sequence is the control plane's own, so a client that reconnects after the control plane restarted still receives
   * the events it missed; a log that no longer holds them says so with a `gap` comment instead of hiding the hole.
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
    // The replay runs in pages until the log is exhausted, all in this one turn: an event recorded meanwhile is
    // delivered by the subscription instead, and the pages between it are never skipped.
    let replayAfter = after
    let gap = false
    for (;;) {
      const history = this.control.eventHistory(replayAfter)
      for (const event of history.events) write(event)
      if (history.gap) gap = true
      const last = history.events.at(-1)?.seq
      if (last === undefined || history.events.length < EVENT_REPLAY_LIMIT) break
      replayAfter = last
    }
    if (gap) {
      // The log is bounded: the events it no longer holds cannot be delivered, and the client is told so.
      try { res.write(': gap\n\n') } catch { /* a broken socket needs no comment */ }
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

    if (method === 'POST' && url.pathname === '/v1/tools/pm/project-report') {
      if (claims.role !== 'pm') throw new ToolCallError('forbidden', 'A PM Session token is required')
      const body = await readJson(req)
      const summary = stringValue(body.summary, 'summary', true)!
      if (summary.length > 4000) throw new ToolCallError('invalid', 'A Project report may contain at most 4000 characters')
      return json(res, 200, this.control.pmReportProject(claims.sid, summary))
    }

    // The PM's coordination message to the Worker of one of its own Tickets. The Ticket is checked against the
    // Project the token names, and an Assignment the caller names must still be the current one.
    if (method === 'POST' && url.pathname === '/v1/tools/pm/message') {
      if (claims.role !== 'pm') throw new ToolCallError('forbidden', 'A PM Session token is required')
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const message = text(body.text)
      const assignmentId = body.assignmentId === undefined ? undefined : text(body.assignmentId)
      const result = this.control.pmMessageWorker(claims.sid, ticketId, message, assignmentId)
      return json(res, 200, { delivered: result.delivered, ticket: result.ticket })
    }

    // The PM's request to stop a Worker. The domain ends the Assignment and asks the node to stop the Session; the
    // answer says whether the node confirmed it, so a node failure is visible rather than a silent success.
    if (method === 'POST' && url.pathname === '/v1/tools/pm/cancel') {
      if (claims.role !== 'pm') throw new ToolCallError('forbidden', 'A PM Session token is required')
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const assignmentId = body.assignmentId === undefined ? undefined : text(body.assignmentId)
      const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : undefined
      const result = await this.control.pmCancelWorker(claims.sid, ticketId, assignmentId, reason)
      return json(res, 200, result)
    }

    // The PM's decision about a Worker's result: accept it, or reject it with a reason the Worker can act on. The
    // Ticket is checked against the Project the token names, the Assignment the caller names must be the one whose result
    // waits for review, and the review the caller names is the round it decides.
    if (method === 'POST' && url.pathname === '/v1/tools/pm/review') {
      if (claims.role !== 'pm') throw new ToolCallError('forbidden', 'A PM Session token is required')
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const assignmentId = text(body.assignmentId)
      const reviewId = text(body.reviewId)
      const action = text(body.action)
      if (action !== 'accept' && action !== 'reject') throw new HttpError(400, 'action must be "accept" or "reject"')
      const reason = body.reason === undefined ? undefined : text(body.reason)
      if (action === 'reject' && reason === undefined) throw new HttpError(400, 'A rejection needs a reason')
      const result = await this.control.pmReview(claims.sid, ticketId, assignmentId,
        { action, reviewId, ...(reason === undefined ? {} : { reason }) })
      return json(res, 200, result)
    }

    // The PM's explicit request for a new Assignment on a dispatchable Ticket of its own Project.
    // The PM's read of the code differences behind a review. The node reads the Project's own workspace with a fixed,
    // read-only Git command set; the control plane binds the request to the review the caller named and refuses another
    // Project's Ticket, another Assignment's review and a review that no longer waits for a decision.
    if (method === 'POST' && url.pathname === '/v1/tools/pm/diff') {
      if (claims.role !== 'pm') throw new ToolCallError('forbidden', 'A PM Session token is required')
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const reviewId = text(body.reviewId)
      const assignmentId = text(body.assignmentId)
      const result = await this.control.pmReviewDiff(claims.sid, ticketId, reviewId, assignmentId)
      return json(res, 200, result)
    }

    if (method === 'POST' && url.pathname === '/v1/tools/pm/assignment') {
      if (claims.role !== 'pm') throw new ToolCallError('forbidden', 'A PM Session token is required')
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const assignmentId = body.assignmentId === undefined ? undefined : text(body.assignmentId)
      const result = await this.control.pmRequestAssignment(claims.sid, ticketId, assignmentId)
      return json(res, 200, result)
    }

    // The Router's read: the running state of every Project. Only a Router Session token opens it, so a PM or a Worker
    // token cannot borrow the Router's view and a Router token cannot borrow a PM's tools.
    if (method === 'GET' && url.pathname === '/v1/tools/router/summary') {
      if (claims.role !== 'router') throw new ToolCallError('forbidden', 'A Router Session token is required')
      return json(res, 200, this.control.routerSummary())
    }

    if (method === 'POST' && url.pathname === '/v1/tools/router/projects') {
      if (claims.role !== 'router') throw new ToolCallError('forbidden', 'A Router Session token is required')
      const body = await readJson(req)
      const requestId = text(body.requestId)
      const title = stringValue(body.title, 'title', true)!
      const goal = stringValue(body.goal, 'goal', true)!
      const result = await this.control.routerCreateProject(claims.sid, requestId, title, goal)
      return json(res, 200, result)
    }

    if (method === 'POST' && url.pathname === '/v1/tools/router/dispatch') {
      if (claims.role !== 'router') throw new ToolCallError('forbidden', 'A Router Session token is required')
      const body = await readJson(req)
      const result = this.control.routerDispatch(claims.sid, text(body.requestId),
        stringValue(body.title, 'title', true)!, stringValue(body.goal, 'goal', true)!)
      return json(res, 200, result)
    }

    if (method === 'POST' && url.pathname === '/v1/tools/router/manage') {
      if (claims.role !== 'router') throw new ToolCallError('forbidden', 'A Router Session token is required')
      const body = await readJson(req)
      const action = body.action
      if (action !== 'message_ticket' && action !== 'stop_ticket' && action !== 'retry_ticket'
        && action !== 'archive_project' && action !== 'unarchive_project') {
        throw new ToolCallError('invalid', 'Unknown Router action')
      }
      const result = await this.control.routerManage(claims.sid, text(body.requestId), action, text(body.targetId),
        stringValue(body.text, 'text', false))
      return json(res, 200, result)
    }

    // Propose a relay to one Project's PM on behalf of a person's request.
    // It proposes; it does not send. The request id names the request the Router may propose for, the Project is
    // checked against the domain, and a request may carry at most one proposal.
    if (method === 'POST' && url.pathname === '/v1/tools/router/pm-proposal') {
      if (claims.role !== 'router') throw new ToolCallError('forbidden', 'A Router Session token is required')
      const body = await readJson(req)
      const requestId = text(body.requestId)
      const projectId = text(body.projectId)
      const instruction = text(body.instruction)
      const result = await this.control.routerPmProposal(claims.sid, requestId, projectId, instruction)
      return json(res, 200, result)
    }

    if (method === 'POST' && url.pathname === '/v1/tools/worker/report') {
      if (claims.role !== 'worker') throw new ToolCallError('forbidden', 'A Worker Session token is required')
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const assignmentId = body.assignmentId === undefined ? undefined : text(body.assignmentId)
      // The call's own id: the node sends the tool invocation's id, so a replayed call is recognised as the same call.
      // A node that sends none keeps the older behaviour, which never suppresses a new fact.
      const callKey = body.callKey === undefined ? undefined : stringValue(body.callKey, 'callKey', true)!
      const ticket = this.control.workerReport(claims.sid, ticketId, assignmentId, parseWorkerReport(body.report), callKey)
      return json(res, 200, { ticket })
    }

    throw new HttpError(404, 'Not found')
  }
}
