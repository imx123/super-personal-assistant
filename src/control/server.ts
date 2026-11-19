/** Minimal loopback HTTP API for the standalone control-plane kernel. */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { UserError, type ProjectTicketTask, type WorkerReport } from '../core/index.ts'
import { EVENT_HISTORY_KINDS, EVENT_HISTORY_LIMIT, EventHistoryQueryError,
  type EventHistoryKind, type EventHistoryPage, type EventHistoryQuery } from '../memory/event-history.ts'
import { MEMORY_MANAGER_LIST_LIMIT } from '../memory/memory-manager.ts'
import { MEMORY_LIST_LIMIT, type MemoryDecisionKind, type MemoryRefusalCode } from '../memory/memory-service.ts'
import { MEMORY_SEARCH_LIMIT } from '../memory/retriever.ts'
import { SOURCE_REF_KINDS, sourceRefKindOf, type SourceRefInput, type SourceRefKind } from '../memory/memory-scope.ts'
import { packagePath } from '../infra/paths.ts'
import { ROUTER_ATTACHMENT_BYTES, ROUTER_ATTACHMENT_COUNT, WORKER_REPORT_STATES,
  type NodeEvent, type RouterModel, type RouterTextAttachment } from '../shared/protocol.ts'
import { SessionTokenError } from '../shared/session-token.ts'
import { DeploymentError, type DeploymentScope, type DeploymentSettings } from '../shared/deployment.ts'
import { CONSOLE_BUNDLE, CONSOLE_CSP, ConsoleAssets } from './console-assets.ts'
import { ControlPlane, EVENT_REPLAY_LIMIT, OperatorError, ProjectScopeViolationError, SessionEnsureError, ToolCallError,
  type ToolCallErrorCode } from './control-plane.ts'
import { ScheduleError, describeScheduleRule, parseScheduleRule, type SchedulePlan } from './scheduler.ts'
import { type PmProjectReportKind } from './report-coordinator.ts'
import type { ExternalDeliveryMode, ExternalFieldCondition, ExternalFieldOp, ExternalSubscriptionInput,
  ExternalSubscriptionPatch, SyntheticEvent } from './event-subscriptions.ts'

/** The kinds a PM's own report about its Project may name. */
const PROJECT_REPORT_KINDS: readonly string[] = ['progress', 'blocked', 'completed', 'failed']

/**
 * What a memory that is not there is answered with.
 *
 * The answer is the same for an id that was never given, an id that names a memory that is not in force and an id that
 * was deleted: it does not say which of the three it was, so the answer never tells a caller that an id once named
 * something.
 */
const MEMORY_NOT_FOUND_MESSAGE = '记忆不存在或已被用户删除'

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

/**
 * Whether one query of the durable event history names a key at all.
 *
 * A caller that names no key asks for "everything", and the history is read by an exact key: the scope of the reader
 * says what it may read, but the key says which part of it the reader wants.
 */
function namesOneKey(query: EventHistoryQuery): boolean {
  return [query.ticketId, query.projectId, query.controlSessionId, query.assignmentId, query.nodeId]
    .some(value => value !== undefined && value !== '')
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

/**
 * The identity of one tool call.
 *
 * The node sends the id of the tool invocation with every control-plane call, so a call that is retried after a token
 * refresh is recognised as the very same call and is neither audited nor counted twice. A caller that sends none still
 * gets one: the request names itself, so two calls that are really two calls never collapse into one.
 *
 * The header is the caller's own word, so it is read as a plain token and never as an identity on its own: the control
 * plane namespaces it by the Session that sent it, and two callers that send the same text are two different calls.
 */
function toolCallId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '' && trimmed.length <= 128 && isPlainToken(trimmed)) return trimmed
  }
  return randomUUID()
}

/** Whether a text is a plain token: no whitespace and no control characters. */
function isPlainToken(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) return false
  }
  return true
}

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

/**
 * The decision one request names about one candidate.
 *
 * The five decisions are the ones the memory service knows. Anything else is a client error: a decision the control
 * plane does not understand must not be treated as a refusal of its own.
 */
function memoryDecision(value: unknown): MemoryDecisionKind {
  if (value === 'approve' || value === 'reject' || value === 'merge' || value === 'conflict' || value === 'supersede') {
    return value
  }
  throw new HttpError(400, 'The decision must be approve, reject, merge, conflict or supersede')
}

/**
 * The status a refusal of a decision is answered with.
 *
 * A decision made on a candidate that changed is a conflict, not a mistake: the caller may read the candidate again and
 * decide about the version that is really there. A candidate or a memory that is not there is a 404, and everything
 * else is a request the control plane will not carry out as it was written.
 */
function memoryRefusalStatus(code: MemoryRefusalCode): number {
  if (code === 'CANDIDATE_NOT_FOUND' || code === 'MEMORY_NOT_FOUND') return 404
  if (code === 'STALE_CANDIDATE' || code === 'CONFLICT_ALREADY_OPEN' || code === 'REEVALUATION_LIMIT_REACHED'
    || code === 'DUPLICATE_CONTENT' || code === 'STALE_MEMORY' || code === 'MEMORY_NOT_ACTIVE') {
    return 409
  }
  if (code === 'REEVALUATION_NOT_PERMITTED') return 403
  return 400
}

/**
 * The memory ids a report may name.
 *
 * They are the model's own claim about what it used, and the control plane checks every one of them against the ledger of
 * the injection it wrote itself — so a name that was never in front of the task counts for nothing. The list is bounded
 * here as well: a report that names hundreds of memories is not a report about a task.
 */
function parseAppliedMemoryIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new HttpError(400, 'appliedMemoryIds must be an array of memory ids')
  if (value.length > 20) throw new HttpError(400, 'appliedMemoryIds may name at most 20 memories')
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new HttpError(400, 'appliedMemoryIds must hold memory ids')
    const id = entry.trim()
    if (id === '') continue
    if (id.length > 128) throw new HttpError(400, 'appliedMemoryIds must hold short memory ids')
    ids.push(id)
  }
  return ids
}

/**
 * The status a refusal of the memory manager is answered with.
 *
 * A job or a candidate that is not there is a 404, a job that moved on — it is stale, finished or bound to another
 * Session — is a 409, and a Session that may not call at all is a 403. The rest is a request the control plane will not
 * carry out as it was written.
 */
function managerRefusalStatus(code: string): number {
  if (code === 'JOB_NOT_FOUND' || code === 'CANDIDATE_NOT_FOUND' || code === 'MEMORY_NOT_FOUND') return 404
  if (code === 'JOB_STALE' || code === 'JOB_FINISHED' || code === 'JOB_NOT_BOUND' || code === 'CHECKSUM_MISMATCH'
    || code === 'SOURCE_MISMATCH' || code === 'CANDIDATE_MISMATCH' || code === 'REVIEW_ALREADY_ACTIVE'
    || code === 'RETURN_LIMIT_REACHED' || code === 'STALE_CANDIDATE' || code === 'CONFLICT_ALREADY_OPEN'
    || code === 'CANDIDATE_NOT_REVIEWABLE' || code === 'JOB_EXPIRED') {
    return 409
  }
  if (code === 'NOT_A_MANAGER' || code === 'SESSION_REVOKED' || code === 'SESSION_STOPPED' || code === 'SESSION_FOREIGN'
    || code === 'SESSION_STALE' || code === 'NOT_PERMITTED' || code === 'GLOBAL_PROMOTION_REFUSED') {
    return 403
  }
  return 400
}

/**
 * The interval one stream subscription asks for, in seconds.
 *
 * A number is what the node's proxy tool sends, and a plain whole number in text is what a console sends. Anything else
 * is not an interval: the answer is `NaN`, which the caller refuses as an invalid request.
 */
function streamIntervalOf(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return Number.NaN
}

/** The ways a field of an external event's payload may be compared with a value. */
const EXTERNAL_FIELD_OPS = ['exact', 'prefix', 'contains', 'regex'] as const

/** One field condition of an external event subscription, as the console sends it. */
function externalField(value: unknown, name: string): ExternalFieldCondition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${name} must be an object`)
  }
  const field = value as Record<string, unknown>
  const path = stringValue(field.path, `${name}.path`, true)!
  const op = stringValue(field.op, `${name}.op`, true)!
  if (!EXTERNAL_FIELD_OPS.includes(op as ExternalFieldOp)) {
    throw new HttpError(400, `${name}.op must be "exact", "prefix", "contains" or "regex"`)
  }
  return { path, op: op as ExternalFieldOp, value: stringValue(field.value, `${name}.value`, true)! }
}

/** The list of field conditions of an external event subscription. */
function externalFields(value: unknown, name: string): ExternalFieldCondition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, `${name} must be a non-empty array`)
  }
  return value.map((entry, index) => externalField(entry, `${name}[${index}]`))
}

/** The kinds of event an external event subscription watches. */
function externalEventTypes(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, `${name} must be a non-empty array`)
  }
  return value.map((entry, index) => stringValue(entry, `${name}[${index}]`, true)!)
}

/** A number a console sends: a whole number, never a guess. */
function wholeNumber(value: unknown, name: string): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, `${name} must be a whole number`)
  return parsed
}

/** The external event subscription an operator asks for. */
function externalSubscriptionInput(body: Record<string, unknown>): ExternalSubscriptionInput {
  const deliveryMode = body.deliveryMode === undefined
    ? undefined
    : stringValue(body.deliveryMode, 'deliveryMode', true)! as ExternalDeliveryMode
  // The two-layer mode has no fixed target: it names one per event, and the high-level Router is the fallback.
  const targetSessionId = body.targetSessionId === undefined
    ? undefined
    : stringValue(body.targetSessionId, 'targetSessionId', true)!
  return {
    sourceId: stringValue(body.sourceId, 'sourceId', true)!,
    eventTypes: externalEventTypes(body.eventTypes, 'eventTypes'),
    fields: externalFields(body.fields, 'fields'),
    ...(targetSessionId === undefined ? {} : { targetSessionId }),
    ...(deliveryMode === undefined ? {} : { deliveryMode }),
    ...(body.leaseSeconds === undefined ? {} : { leaseSeconds: wholeNumber(body.leaseSeconds, 'leaseSeconds') }),
    ...(body.routeHint === undefined ? {} : { routeHint: stringValue(body.routeHint, 'routeHint', true)! }),
    ...(body.semanticHint === undefined ? {} : { semanticHint: stringValue(body.semanticHint, 'semanticHint', true)! }),
  }
}

/** What an operator may change on an external event subscription. */
function externalSubscriptionPatch(body: Record<string, unknown>): ExternalSubscriptionPatch {
  return {
    ...(body.eventTypes === undefined ? {} : { eventTypes: externalEventTypes(body.eventTypes, 'eventTypes') }),
    ...(body.fields === undefined ? {} : { fields: externalFields(body.fields, 'fields') }),
    ...(body.targetSessionId === undefined
      ? {} : { targetSessionId: stringValue(body.targetSessionId, 'targetSessionId', true)! }),
    ...(body.leaseSeconds === undefined ? {} : { leaseSeconds: wholeNumber(body.leaseSeconds, 'leaseSeconds') }),
    ...(body.routeHint === undefined ? {} : { routeHint: stringValue(body.routeHint, 'routeHint', true)! }),
    ...(body.semanticHint === undefined ? {} : { semanticHint: stringValue(body.semanticHint, 'semanticHint', true)! }),
  }
}

/** The synthetic event an operator injects. */
function syntheticEvent(body: Record<string, unknown>): SyntheticEvent {
  if (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload)) {
    throw new HttpError(400, 'payload must be an object')
  }
  return {
    sourceId: stringValue(body.sourceId, 'sourceId', true)!,
    eventId: stringValue(body.eventId, 'eventId', true)!,
    eventType: stringValue(body.eventType, 'eventType', true)!,
    payload: body.payload as Record<string, unknown>,
  }
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
    // The work tools the task allows: the list may only narrow the PM Mandate's, and the Engine refuses a list that
    // widens it. The names are read here so a body that carries something else is refused before the domain sees it.
    if (task.allow_tools !== undefined) {
      if (!Array.isArray(task.allow_tools)) throw new HttpError(400, `${path}.allow_tools must be an array`)
      const tools = task.allow_tools.map((name, at) => {
        if (typeof name !== 'string') throw new HttpError(400, `${path}.allow_tools[${at}] must be a string`)
        const trimmed = name.trim()
        if (trimmed === '' || trimmed.length > 64) {
          throw new HttpError(400, `${path}.allow_tools[${at}] must be a tool name`)
        }
        return trimmed
      })
      parsed.allow_tools = tools
    }
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

    // The live state: what this control plane holds right now, read once and thrown away. It is a snapshot, so the
    // answer carries the moment it was taken and says how much of each list was left out.
    if (method === 'GET' && path === '/v1/console/memory/live-state') {
      return json(res, 200, this.control.liveStateForOperator())
    }

    // The durable event history: the key facts of what this control plane did, read by their exact keys. It is the
    // control plane's own file, so it is not the console's pruned log, and the answer says how far back it reaches.
    if (method === 'GET' && path === '/v1/console/memory/event-history') {
      return json(res, 200, this.eventHistoryPage(() => this.control.eventHistoryForOperator(this.eventHistoryQuery(url))))
    }

    // The long-term memory: the queue of proposals and the memories that are in force. Both are read from the control
    // plane's own file, and both are read-only — a memory is written when a decision says so, never by a read.
    if (method === 'GET' && path === '/v1/console/memory/candidates') {
      return json(res, 200, this.control.memoryCandidatesForOperator(this.memoryCandidateQuery(url)))
    }
    if (method === 'GET' && path === '/v1/console/memory/memories') {
      return json(res, 200, this.control.memoryRecordsForOperator(this.memoryRecordQuery(url)))
    }
    // One memory by its id. A memory that is not in force, an id that was never given and an id that was deleted are
    // answered in exactly the same way: the answer does not say whether the id ever existed.
    const memoryRoute = /^\/v1\/console\/memory\/memories\/([^/]+)$/.exec(path)
    if (method === 'GET' && memoryRoute !== null) {
      const memory = this.control.memoryRecordForOperator(decodeURIComponent(memoryRoute[1] ?? ''))
      if (memory === undefined) throw new HttpError(404, MEMORY_NOT_FOUND_MESSAGE)
      return json(res, 200, { memory })
    }

    // The search of the long-term memory: the memories that answer a question, ranked, each with the reasons why it is
    // where it is. It is a read like every other one, and the operator may read every scope this control plane holds.
    if (method === 'GET' && path === '/v1/console/memory/search') {
      const query = text(url.searchParams.get('q'))
      const limit = this.limit(url.searchParams.get('limit'))
      if (limit !== undefined && limit > MEMORY_SEARCH_LIMIT) {
        throw new HttpError(400, `limit must be an integer between 1 and ${MEMORY_SEARCH_LIMIT}`)
      }
      const scopeType = url.searchParams.get('scopeType')
      const scopeId = url.searchParams.get('scopeId')
      return json(res, 200, await this.control.memorySearchForOperator({
        query,
        ...(limit === undefined ? {} : { limit }),
        ...(scopeType === null || scopeType === '' ? {} : { scopeType }),
        ...(scopeId === null || scopeId === '' ? {} : { scopeId }),
      }))
    }

    // One memory that a person says misled somebody. It is the one write a memory itself takes, and it belongs to the
    // operator alone: the confidence of the memory falls a step, and one that falls under the floor waits for a person.
    const disputeRoute = /^\/v1\/console\/memory\/memories\/([^/]+)\/dispute$/.exec(path)
    if (method === 'POST' && disputeRoute !== null) {
      const body = await readJson(req)
      const result = this.control.memoryDisputeByOperator({
        memoryId: decodeURIComponent(disputeRoute[1] ?? ''),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      })
      if (!result.ok) throw new HttpError(memoryRefusalStatus(result.code), result.reason)
      return json(res, 200, { memory: result.memory })
    }

    // The governance of a memory that is in force. All three belong to the operator alone, and all three name the version
    // they were made on: a memory that changed in the meantime is a 409, so two people never overwrite each other.
    //
    // An edit is a new version, not a rewrite: the old memory keeps its history and leaves the recall. A pin changes the
    // order and nothing else. A delete is a deletion: the body goes away with the row that held it, together with the
    // copies of those words that wait in the queue and the entries the keyword index holds. The answer names what is gone
    // and never what it said.
    const editRoute = /^\/v1\/console\/memory\/memories\/([^/]+)\/edit$/.exec(path)
    if (method === 'POST' && editRoute !== null) {
      const body = await readJson(req)
      const result = this.control.memoryEditByOperator({
        memoryId: decodeURIComponent(editRoute[1] ?? ''),
        content: text(body.content),
        checksum: text(body.checksum),
      })
      if (!result.ok) throw new HttpError(memoryRefusalStatus(result.code), result.reason)
      return json(res, 200, { memory: result.memory,
        ...(result.replaced === undefined ? {} : { replaced: result.replaced }) })
    }
    const pinRoute = /^\/v1\/console\/memory\/memories\/([^/]+)\/pin$/.exec(path)
    if (method === 'POST' && pinRoute !== null) {
      const body = await readJson(req)
      const result = this.control.memoryPinByOperator({
        memoryId: decodeURIComponent(pinRoute[1] ?? ''),
        pinned: body.pinned !== false,
        checksum: text(body.checksum),
      })
      if (!result.ok) throw new HttpError(memoryRefusalStatus(result.code), result.reason)
      return json(res, 200, { memory: result.memory })
    }
    const deleteRoute = /^\/v1\/console\/memory\/memories\/([^/]+)\/delete$/.exec(path)
    if (method === 'POST' && deleteRoute !== null) {
      const body = await readJson(req)
      const result = this.control.memoryDeleteByOperator({
        memoryId: decodeURIComponent(deleteRoute[1] ?? ''),
        checksum: text(body.checksum),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      })
      if (!result.ok) throw new HttpError(memoryRefusalStatus(result.code), result.reason)
      return json(res, 200, { deleted: result.deleted })
    }

    // The memory manager's own record: the reviews it was woken for and the daily inspection it ran. Both are read
    // from the control plane's own file, so what the console shows is what really happened.
    if (method === 'GET' && path === '/v1/console/memory/reviews') {
      return json(res, 200, { rows: this.control.memoryReviewRunsForOperator(this.memoryLimit(url)) })
    }

    // The daily inspection: its own record, its counters and when the next one is due.
    if (method === 'GET' && path === '/v1/console/memory/maintenance') {
      return json(res, 200, { rows: this.control.memoryMaintenanceRunsForOperator(this.memoryLimit(url)) })
    }

    // A run of the inspection, now, by a person. The answer is what really happened: a node that is offline is reported
    // as not run, never as a success.
    if (method === 'POST' && path === '/v1/console/memory/maintenance/run') {
      const run = await this.control.runMemoryMaintenance({ reason: 'manual' })
      return json(res, 200, { run })
    }

    // A proposal is a proposal: the operator may offer one, and it waits in the queue for a decision. There is no route
    // that writes a memory directly.
    if (method === 'POST' && path === '/v1/console/memory/candidates') {
      const body = await readJson(req)
      const result = this.control.submitMemoryCandidate({
        content: text(body.content),
        scopeType: text(body.scopeType),
        scopeId: text(body.scopeId),
        ...(body.importance === undefined ? {} : { importance: Number(body.importance) }),
        ...(body.sourceRefs === undefined ? {} : { sourceRefs: this.sourceRefs(body.sourceRefs) }),
      })
      if (!result.ok) throw new HttpError(400, result.reason)
      // A proposal that is already in the queue is answered with the row only to the caller that may see it. The
      // console is the operator's own console, so it always may; a Session that may not gets the fact and nothing else.
      const candidate = result.candidate
      if (candidate === undefined) return json(res, 201, { duplicate: true })
      return json(res, 201, { candidate, duplicate: result.duplicate })
    }

    // One decision about one proposal. It names the version it was made on, so a decision about a proposal that changed
    // in the meantime is refused instead of deciding about the wrong thing.
    const decisionRoute = /^\/v1\/console\/memory\/candidates\/([^/]+)\/decision$/.exec(path)
    if (method === 'POST' && decisionRoute !== null) {
      const body = await readJson(req)
      const result = this.control.decideMemoryCandidate({
        candidateId: decodeURIComponent(decisionRoute[1] ?? ''),
        decision: memoryDecision(body.decision),
        checksum: text(body.checksum),
        ...(body.memoryId === undefined ? {} : { memoryId: text(body.memoryId) }),
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
      })
      if (!result.ok) throw new HttpError(memoryRefusalStatus(result.code), result.reason)
      return json(res, 200, { code: result.code, candidate: result.candidate,
        ...(result.memory === undefined ? {} : { memory: result.memory }) })
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
      // The message's own id makes a repeated send the same message: a browser that repeats its request cannot make
      // the Router read it twice.
      const id = typeof body.id === 'string' && body.id !== '' ? body.id : undefined
      const result = await this.control.sendToRouter(message, attachments, routerModel(body.model),
        id === undefined ? {} : { id })
      // A message the Fast Router claimed never reached the Router's model: the control plane carried it out itself and
      // answers with the receipt of what really happened. A claim that still waits for its place in the queue says so:
      // it is queued, not carried out.
      if (result.routed) {
        return json(res, 200, { sent: false, queued: result.route.stage === 'accepted',
          requestId: result.requestId, routing: result.route })
      }
      // The fields say what the queue says: a message that waits is not sent, a message the node took is sent, and a
      // message the node refused is neither — it is answered with the reason instead of a success that never happened.
      const state = result.entry.state
      if (state === 'failed') {
        throw new HttpError(502, `The node did not take the message: ${result.entry.error ?? 'the delivery was refused'}`)
      }
      if (state === 'unconfirmed') {
        throw new HttpError(502, `The node did not confirm the message: ${result.entry.error ?? 'the receipt is missing'}`)
      }
      return json(res, 200, { sent: state === 'sent' || state === 'read',
        queued: state === 'queued' || state === 'sending', requestId: result.requestId, queue: result.entry })
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

    // The coordination of the reports: what each delivery of a Worker or a PM report did. The record is durable, so the
    // console shows it after a restart of the control plane as well. The body of the report is not part of it: the console
    // shows what happened to a delivery, never the lower-trust text the report carried.
    if (method === 'GET' && path === '/v1/console/coordination/deliveries') {
      const limit = this.limit(url.searchParams.get('limit'))
      return json(res, 200, { deliveries: this.control.coordinationDeliveries(limit ?? 50) })
    }

    // The stream subscriptions a superior asked for: who watches whom, at which rhythm, how far the watermark reached and
    // what became of the last digest. The record is durable, so the console shows it after a restart as well. The digest
    // itself is not part of it: the console shows the scope and the state, never the lower-trust text of a child Session.
    if (method === 'GET' && path === '/v1/console/stream-subscriptions') {
      const limit = this.limit(url.searchParams.get('limit'))
      return json(res, 200, { subscriptions: this.control.streamSubscriptions(limit ?? 50) })
    }

    // The external observation events an operator watches for: which source, which kinds of event, which fields of the
    // payload and the one Session the event wakes. The rules are deterministic and the delivery is direct: the event
    // reaches that Session and never the Router. The record is durable, so the console shows it after a restart as well.
    if (method === 'GET' && path === '/v1/console/external-subscriptions') {
      const limit = this.limit(url.searchParams.get('limit'))
      // The subscriptions and the dispositions of the events they saw: the dispositions carry the ids, the state and the
      // reason, never the payload of the event.
      return json(res, 200, { subscriptions: this.control.externalSubscriptions(limit ?? 50),
        dispositions: this.control.externalEventDispositions(limit ?? 50) })
    }
    if (method === 'POST' && path === '/v1/console/external-subscriptions') {
      const body = await readJson(req)
      const subscription = await this.control.createExternalSubscription(externalSubscriptionInput(body))
      return json(res, 201, { subscription })
    }
    // The operator's own changes to one subscription: a new rule, a new target, and the end of the subscription.
    const externalSubscription = /^\/v1\/console\/external-subscriptions\/([^/]+)(?:\/(cancel))?$/.exec(path)
    if (externalSubscription) {
      const subscriptionId = decodeURIComponent(externalSubscription[1]!)
      if (method === 'PUT' && externalSubscription[2] === undefined) {
        const body = await readJson(req)
        const subscription = await this.control.updateExternalSubscription(subscriptionId,
          externalSubscriptionPatch(body))
        return json(res, 200, { subscription })
      }
      if ((method === 'POST' && externalSubscription[2] === 'cancel')
        || (method === 'DELETE' && externalSubscription[2] === undefined)) {
        return json(res, 200, { subscription: this.control.cancelExternalSubscription(subscriptionId) })
      }
    }

    // The synthetic events: the observation sources of this build, injected by an operator. Nothing outside this control
    // plane is contacted — the sources are local — and the answer says what every subscription did with the event.
    if (method === 'POST' && path === '/v1/console/events/synthetic-emit') {
      const body = await readJson(req)
      const result = await this.control.emitSyntheticEvent(syntheticEvent(body))
      return json(res, 200, { result })
    }

    // The permission denials the guards refused: what each refusal was, how many the window held and what became of the
    // review. The record is durable, so the console shows it after a restart of the control plane as well. The message
    // that was sent to a superior is not part of it: the console shows the facts of a refusal, never the arguments the
    // refused call carried.
    //
    // The authorization applications are part of the same panel: a superior raised one about a review, and the operator
    // decides about it here.
    if (method === 'GET' && path === '/v1/console/denials') {
      const limit = this.limit(url.searchParams.get('limit'))
      return json(res, 200, { reviews: this.control.denialReviews(limit ?? 50),
        counters: this.control.denialCounters(limit ?? 50),
        applications: this.control.denialAuthorizations(limit ?? 50) })
    }

    // The operator's decision on one authorization application.
    //
    // The decision is a record and nothing else: it grants no capability, widens no Mandate, changes no role's tool list
    // and repeats no refused call. Any real change goes through the operator's own path, which this record never touches.
    // The application's own facts are read from the control plane's record, so no raw tool argument is copied anywhere.
    if (method === 'POST' && path === '/v1/console/denials/authorizations') {
      const body = await readJson(req)
      const applicationId = text(body.applicationId)
      const decision = text(body.decision)
      if (decision !== 'acknowledged' && decision !== 'declined') {
        throw new HttpError(400, 'decision must be "acknowledged" or "declined"')
      }
      const application = this.control.decideDenialAuthorization(applicationId, decision)
      return json(res, 200, { application })
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

    // The notices about stops: what an operator stopped, what it affected and what it left running. They are the
    // control plane's own durable facts, and they are readable by the operator and by the logical superior of the work.
    if (method === 'GET' && path === '/v1/console/stops') {
      const superiorKind = url.searchParams.get('superiorKind') ?? undefined
      const superiorId = url.searchParams.get('superiorId') ?? undefined
      const projectId = url.searchParams.get('projectId') ?? undefined
      return json(res, 200, { stops: this.control.stopNotices({
        limit: this.limit(url.searchParams.get('limit')) ?? 50,
        ...(superiorKind === undefined ? {} : { superiorKind }),
        ...(superiorId === undefined ? {} : { superiorId }),
        ...(projectId === undefined ? {} : { projectId }),
      }), sessions: this.control.stopViews() })
    }

    // The Assignment stop: one Worker's Assignment ends, its Ticket stays open and the other Workers keep running.
    const assignmentAction = /^\/v1\/console\/assignments\/([^/]+)\/(stop)$/.exec(path)
    if (method === 'POST' && assignmentAction) {
      const assignmentId = decodeURIComponent(assignmentAction[1]!)
      const body = await readJson(req)
      const result = await this.control.stopAssignmentByOperator(assignmentId,
        typeof body.reason === 'string' ? body.reason : undefined)
      return json(res, 200, result)
    }

    // The Ticket's own lifecycle: a cancel ends it, a resume clears the stop a person put on its Worker.
    const ticketAction = /^\/v1\/console\/tickets\/([^/]+)\/(cancel|resume)$/.exec(path)
    if (method === 'POST' && ticketAction) {
      const ticketId = decodeURIComponent(ticketAction[1]!)
      const body = await readJson(req)
      if (ticketAction[2] === 'cancel') {
        const result = await this.control.cancelTicketByOperator(ticketId,
          typeof body.reason === 'string' ? body.reason : undefined)
        return json(res, 200, result)
      }
      const result = await this.control.resumeTicketWorker(ticketId,
        typeof body.reason === 'string' ? body.reason : undefined)
      return json(res, 200, result)
    }

    const sessionPath = /^\/v1\/console\/sessions\/([^/]+)(?:\/(message|messages|cancel|archive|permission|revoke|resume|interrupt))?$/.exec(path)
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
      if (method === 'POST' && action === 'resume') {
        const body = await readJson(req)
        // The resume is the operator's own act: nothing else clears a stop, and only the operator may say so.
        const result = await this.control.resumeSessionByOperator(sessionId,
          typeof body.reason === 'string' ? body.reason : undefined)
        return json(res, 200, result)
      }
      if (method === 'POST' && action === 'interrupt') {
        const body = await readJson(req)
        // A Session this kernel does not know is a client error here, as it is for the other session routes.
        if (!this.control.session(sessionId)) throw new HttpError(404, 'Session not found')
        const reason = typeof body.reason === 'string' ? body.reason : undefined
        // The turn the caller saw: it names the round the operator acted on, so a round that started in the meantime is
        // never ended in its place.
        const turn = typeof body.turn === 'number' && Number.isSafeInteger(body.turn) && body.turn > 0 ? body.turn : undefined
        const said = typeof body.text === 'string' ? body.text : ''
        // The interrupt on its own ends the turn that runs now. With a text it is an interruption and a message: the
        // turn ends, and the message goes out in the round that follows it.
        if (said.trim() === '') {
          const result = await this.control.interruptSessionByOperator(sessionId, reason, turn)
          return json(res, 200, result)
        }
        const attachments = routerAttachments(body.attachments)
        const model = routerModel(body.model)
        const id = typeof body.id === 'string' && body.id !== '' ? body.id : undefined
        if (attachments.length > 0 || model !== undefined) {
          const session = this.control.session(sessionId)
          if (!session || session.role !== 'router') {
            throw new HttpError(400, 'Only a message to the Router may carry attachments or a model')
          }
        }
        const result = await this.control.interruptAndSendToSession(sessionId, said, {
          ...(reason === undefined ? {} : { reason }),
          ...(turn === undefined ? {} : { turn }),
          ...(id === undefined ? {} : { id }),
          attachments,
          ...(model === undefined ? {} : { model }),
        })
        return json(res, 200, result)
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
   * One read of the durable event history.
   *
   * A query the service will not answer as it was written — a cursor it did not write, a limit it cannot honour — is the
   * caller's mistake and says so, instead of becoming a broken server.
   */
  private eventHistoryPage(read: () => EventHistoryPage): EventHistoryPage {
    try {
      return read()
    } catch (error) {
      if (error instanceof EventHistoryQueryError) throw new HttpError(400, error.message)
      throw error
    }
  }

  /**
   * The query of one read of the durable event history.
   *
   * The keys are exact: an empty key is no key at all, and a key of another Project matches nothing. The limit is bounded
   * here as well as in the service, so one page can never be the whole index.
   */
  private eventHistoryQuery(url: URL): EventHistoryQuery {
    const params = url.searchParams
    const key = (name: string): string | undefined => {
      const value = params.get(name)
      return value === null || value === '' ? undefined : value
    }
    const limit = this.limit(params.get('limit'))
    if (limit !== undefined && limit > EVENT_HISTORY_LIMIT) {
      throw new HttpError(400, `limit must be an integer between 1 and ${EVENT_HISTORY_LIMIT}`)
    }
    const kind = key('kind')
    if (kind !== undefined && !(EVENT_HISTORY_KINDS as readonly string[]).includes(kind)) {
      throw new HttpError(400, `kind must be one of ${EVENT_HISTORY_KINDS.join(', ')}`)
    }
    const order = key('order')
    if (order !== undefined && order !== 'asc' && order !== 'desc') {
      throw new HttpError(400, 'order must be asc or desc')
    }
    const ticketId = key('ticketId')
    const projectId = key('projectId')
    const controlSessionId = key('controlSessionId')
    const assignmentId = key('assignmentId')
    const nodeId = key('nodeId')
    const cursor = key('cursor')
    return {
      ...(ticketId === undefined ? {} : { ticketId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(controlSessionId === undefined ? {} : { controlSessionId }),
      ...(assignmentId === undefined ? {} : { assignmentId }),
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(kind === undefined ? {} : { kind: kind as EventHistoryKind }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(order === undefined ? {} : { order: order as 'asc' | 'desc' }),
    }
  }

  /**
   * The source references one request offers.
   *
   * A reference names a record of the control plane's own tables and one redacted line about it. The kind must be one
   * the control plane knows: a reference to a kind it cannot look up would be a claim nobody could check, and it is
   * refused here rather than stored as if it were a fact.
   */
  private sourceRefs(value: unknown): SourceRefInput[] {
    if (!Array.isArray(value)) throw new HttpError(400, 'sourceRefs must be an array')
    return value.map(entry => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new HttpError(400, 'A source reference must be an object')
      }
      const record = entry as Record<string, unknown>
      const kind = text(record.kind)
      if (sourceRefKindOf(kind) === undefined) {
        throw new HttpError(400, `A source reference must name one of ${SOURCE_REF_KINDS.join(', ')}`)
      }
      return {
        kind: kind as SourceRefKind,
        id: text(record.id),
        ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
      }
    })
  }

  /**
   * The query of one read of the candidate queue.
   *
   * A status narrows the queue, and a limit bounds the page. Both are bounded here as well as in the service, so one
   * request can never be the whole queue.
   */
  private memoryCandidateQuery(url: URL): { status?: string; limit?: number } {
    const status = url.searchParams.get('status')
    const limit = this.limit(url.searchParams.get('limit'))
    if (limit !== undefined && limit > MEMORY_LIST_LIMIT) {
      throw new HttpError(400, `limit must be an integer between 1 and ${MEMORY_LIST_LIMIT}`)
    }
    return {
      ...(status === null || status === '' ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
    }
  }

  /**
   * The query of one read of the memories.
   *
   * The list holds the memories that are in force. A status may ask for another one — the ones that were superseded
   * keep their history — and the limit bounds the page.
   *
   * **`includeInactive` is the option that shows the rows that are not in force.** It is off by default: a person who
   * opens the list sees the memories that are in force. It may be turned on, and then the history versions and the
   * memories that wait for a review are shown beside them — they are still in the running library, and a person has to
   * be able to see what is there to govern it. The value is read as a word, not as a presence: a parameter that is there
   * but empty, or that says something else, is refused rather than guessed at.
   */
  private memoryRecordQuery(url: URL): { status?: string; limit?: number; includeInactive?: boolean } {
    const status = url.searchParams.get('status')
    const includeInactive = url.searchParams.get('includeInactive')
    const limit = this.limit(url.searchParams.get('limit'))
    if (limit !== undefined && limit > MEMORY_LIST_LIMIT) {
      throw new HttpError(400, `limit must be an integer between 1 and ${MEMORY_LIST_LIMIT}`)
    }
    if (includeInactive !== null && includeInactive !== 'true' && includeInactive !== 'false') {
      throw new HttpError(400, 'includeInactive must be true or false')
    }
    return {
      ...(status === null || status === '' ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
      ...(status === null || status === '' ? {} : { includeInactive: true }),
      ...(includeInactive === 'true' ? { includeInactive: true } : {}),
    }
  }

  /**
   * The bound one read of the manager's own record asks for.
   *
   * The list is bounded: a record of a hundred runs is no more useful to an operator than a record of twenty, and the
   * page stays a page.
   */
  private memoryLimit(url: URL): number | undefined {
    const limit = this.limit(url.searchParams.get('limit'))
    if (limit !== undefined && limit > MEMORY_MANAGER_LIST_LIMIT) {
      throw new HttpError(400, `limit must be an integer between 1 and ${MEMORY_MANAGER_LIST_LIMIT}`)
    }
    return limit
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
   * One PM tool call, with a refusal that reached outside the caller's own Project recorded as the fact it is.
   *
   * The refusal the caller sees is the ordinary one: the other Project's Ticket is unknown to it, and the answer says
   * nothing about whether it exists. The fact behind the refusal is recorded with the Session that made the call, the
   * route's own tool name and the identity the caller proved — and never with the other Project's Ticket, its id or its
   * arguments. The decision is read from the typed error the kernel raised, never from the message it carries.
   */
  private async pmToolCall<T>(sessionId: string, toolName: string, callId: string | undefined,
    call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (error instanceof ProjectScopeViolationError) {
        this.control.recordScopeDenial(sessionId, toolName, callId)
      }
      throw error
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
    // The identity of this very call, when the caller proved one: the node sends the id of the tool invocation, so a
    // retried call is recognised as the same call and never counted twice.
    const callId = toolCallId(req.headers['x-superagent-call-id'])

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
      this.control.requireTool(claims.sid, 'control_project', 'pm', callId)
      return json(res, 200, this.control.pmContext(claims.sid))
    }

    if (method === 'POST' && url.pathname === '/v1/tools/pm/tickets') {
      this.control.requireTool(claims.sid, 'control_create_tickets', 'pm', callId)
      const body = await readJson(req)
      const tickets = this.control.pmCreateTickets(claims.sid, parseTasks(body.tasks), callId)
      return json(res, 200, { tickets })
    }

    if (method === 'POST' && url.pathname === '/v1/tools/pm/project-report') {
      this.control.requireTool(claims.sid, 'control_project_report', 'pm', callId)
      const body = await readJson(req)
      const summary = stringValue(body.summary, 'summary', true)!
      if (summary.length > 4000) throw new ToolCallError('invalid', 'A Project report may contain at most 4000 characters')
      // The kind says what the report is. A report that names none is an ordinary progress report: it is throttled like
      // any other, and it is never a blocker by accident.
      const kind = body.kind === undefined ? undefined : stringValue(body.kind, 'kind', true)!
      if (kind !== undefined && !PROJECT_REPORT_KINDS.includes(kind)) {
        throw new ToolCallError('invalid', `kind must be one of ${PROJECT_REPORT_KINDS.join(', ')}`)
      }
      // The memories this Project turn really used. The control plane checks every one of them against the ledger of the
      // injection it wrote itself, so a name that was never in front of that turn counts for nothing. The Ticket the
      // report is about names the work the claim is bound to; the control plane checks that it is one of the PM's own.
      const appliedMemoryIds = parseAppliedMemoryIds(body.appliedMemoryIds)
      const ticketId = body.ticketId === undefined ? undefined : stringValue(body.ticketId, 'ticketId', true)!
      return json(res, 200, this.control.pmReportProject(claims.sid, summary, kind as PmProjectReportKind | undefined,
        appliedMemoryIds, ticketId))
    }

    // The PM's coordination message to the Worker of one of its own Tickets. The Ticket is checked against the
    // Project the token names, and an Assignment the caller names must still be the current one.
    if (method === 'POST' && url.pathname === '/v1/tools/pm/message') {
      this.control.requireTool(claims.sid, 'control_message_worker', 'pm', callId)
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const message = text(body.text)
      const assignmentId = body.assignmentId === undefined ? undefined : text(body.assignmentId)
      const result = await this.pmToolCall(claims.sid, 'control_message_worker', callId,
        async () => this.control.pmMessageWorker(claims.sid, ticketId, message, assignmentId))
      return json(res, 200, { delivered: result.delivered, ticket: result.ticket })
    }

    // The PM's request to stop a Worker. The domain ends the Assignment and asks the node to stop the Session; the
    // answer says whether the node confirmed it, so a node failure is visible rather than a silent success.
    if (method === 'POST' && url.pathname === '/v1/tools/pm/cancel') {
      this.control.requireTool(claims.sid, 'control_cancel_worker', 'pm', callId)
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const assignmentId = body.assignmentId === undefined ? undefined : text(body.assignmentId)
      const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : undefined
      const result = await this.pmToolCall(claims.sid, 'control_cancel_worker', callId,
        async () => this.control.pmCancelWorker(claims.sid, ticketId, assignmentId, reason))
      return json(res, 200, result)
    }

    // The PM's decision about a Worker's result: accept it, or reject it with a reason the Worker can act on. The
    // Ticket is checked against the Project the token names, the Assignment the caller names must be the one whose result
    // waits for review, and the review the caller names is the round it decides.
    if (method === 'POST' && url.pathname === '/v1/tools/pm/review') {
      this.control.requireTool(claims.sid, 'control_review_result', 'pm', callId)
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const assignmentId = text(body.assignmentId)
      const reviewId = text(body.reviewId)
      const action = text(body.action)
      if (action !== 'accept' && action !== 'reject') throw new HttpError(400, 'action must be "accept" or "reject"')
      const reason = body.reason === undefined ? undefined : text(body.reason)
      if (action === 'reject' && reason === undefined) throw new HttpError(400, 'A rejection needs a reason')
      const result = await this.pmToolCall(claims.sid, 'control_review_result', callId,
        async () => this.control.pmReview(claims.sid, ticketId, assignmentId,
          { action, reviewId, ...(reason === undefined ? {} : { reason }) }))
      return json(res, 200, result)
    }

    // The PM's explicit request for a new Assignment on a dispatchable Ticket of its own Project.
    // The PM's read of the code differences behind a review. The node reads the Project's own workspace with a fixed,
    // read-only Git command set; the control plane binds the request to the review the caller named and refuses another
    // Project's Ticket, another Assignment's review and a review that no longer waits for a decision.
    if (method === 'POST' && url.pathname === '/v1/tools/pm/diff') {
      this.control.requireTool(claims.sid, 'control_review_diff', 'pm', callId)
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const reviewId = text(body.reviewId)
      const assignmentId = text(body.assignmentId)
      const result = await this.pmToolCall(claims.sid, 'control_review_diff', callId,
        async () => this.control.pmReviewDiff(claims.sid, ticketId, reviewId, assignmentId))
      return json(res, 200, result)
    }

    if (method === 'POST' && url.pathname === '/v1/tools/pm/assignment') {
      this.control.requireTool(claims.sid, 'control_request_assignment', 'pm', callId)
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const assignmentId = body.assignmentId === undefined ? undefined : text(body.assignmentId)
      const result = await this.pmToolCall(claims.sid, 'control_request_assignment', callId,
        async () => this.control.pmRequestAssignment(claims.sid, ticketId, assignmentId))
      return json(res, 200, result)
    }

    // The live state, read by the Session the token names.
    //
    // The token decides who acts: the scope comes from the Session's own record and the work it owns, never from the
    // request. A PM reads its own Project, a Worker its own Assignment, and the Router the pool it manages; a node that
    // is offline does not refuse a read, because the facts are the control plane's own.
    if (method === 'GET' && url.pathname === '/v1/tools/memory/live-state') {
      this.control.requireTool(claims.sid, 'control_live_state', ['pm', 'worker', 'router'], callId)
      return json(res, 200, this.control.liveStateFor(claims.sid))
    }

    // The durable event history, read by the Session the token names.
    //
    // The token decides who acts and what may be read: the scope comes from the Session's own record and the work it
    // owns, never from the request. A key of another Project matches nothing, exactly as a key that never existed
    // matches nothing, so the answer never says whether the thing it was asked about is there. A caller that names no
    // key at all is refused: the history is read by an exact key, never by "everything".
    if (method === 'GET' && url.pathname === '/v1/tools/memory/event-history') {
      this.control.requireTool(claims.sid, 'control_event_history_query', ['pm', 'worker', 'router'], callId)
      const query = this.eventHistoryQuery(url)
      if (!namesOneKey(query)) {
        throw new HttpError(400,
          'name at least one of ticketId, projectId, controlSessionId, assignmentId or nodeId')
      }
      return json(res, 200, this.eventHistoryPage(() => this.control.eventHistoryFor(claims.sid, query)))
    }

    // The search of the long-term memory, read by the Session the token names.
    //
    // The token decides who acts and what may be read: the scope comes from the Session's own record and the work it
    // owns, never from the request. A Worker reads the Project of the Ticket it works on, a PM the Project it was really
    // delegated, the Router the pool it manages; nothing of another Project is read, counted or shown.
    //
    // **The search may also name one memory by its id.** The id is the only thing such a request carries, and the answer
    // is that memory or nothing at all: an id that was never given, an id that was deleted and a memory the Session may
    // not see are answered in exactly the same way. The search itself never answers with a memory that is not in force,
    // so a deleted id is not there to be found.
    if (method === 'GET' && url.pathname === '/v1/tools/memory/search') {
      this.control.requireTool(claims.sid, 'control_memory_search', ['pm', 'worker', 'router'], callId)
      // **The id and the query are two ways to ask, and a request names at most one of them.** A request that names a
      // memory id asks for that one memory; a request that names no id asks for the search. Both are read as raw
      // parameters first, because a parameter that is not there is not a word that is empty: the search of the past
      // (`q` alone) must not be refused as if it had named an empty id. A request that names both asks for two different
      // things at once and is refused as such; a parameter that is there but empty is refused too, because it is not a way
      // to ask for nothing.
      const rawMemoryId = url.searchParams.get('memoryId')
      const rawQuery = url.searchParams.get('q')
      if (rawMemoryId !== null && rawQuery !== null) {
        throw new HttpError(400, 'A search names either a memory id or a query, not both.')
      }
      if (rawMemoryId !== null) {
        const memory = this.control.memoryReadForSession(claims.sid, text(rawMemoryId))
        if (memory === undefined) throw new HttpError(404, MEMORY_NOT_FOUND_MESSAGE)
        return json(res, 200, { memory })
      }
      const query = text(rawQuery)
      const limit = this.limit(url.searchParams.get('limit'))
      if (limit !== undefined && limit > MEMORY_SEARCH_LIMIT) {
        throw new HttpError(400, `limit must be an integer between 1 and ${MEMORY_SEARCH_LIMIT}`)
      }
      return json(res, 200, await this.control.memorySearchForSession(claims.sid, {
        query,
        ...(limit === undefined ? {} : { limit }),
      }))
    }

    // The memory manager's four tools. The token decides who acts: only a manager Session may call them, and the job the
    // call names is the one the control plane prepared for that very Session — a job of another Session, of an older
    // generation or already finished is refused before anything is read.
    if (method === 'POST' && url.pathname === '/v1/tools/memory/review') {
      this.control.requireTool(claims.sid, 'memory_service_review_candidate', 'manager', callId)
      const body = await readJson(req)
      const result = this.control.memoryReviewFor(claims.sid, text(body.jobId))
      if (!result.ok) throw new HttpError(managerRefusalStatus(result.code), result.reason)
      return json(res, 200, { job: result.job, candidate: result.candidate })
    }

    if (method === 'POST' && url.pathname === '/v1/tools/memory/search') {
      this.control.requireTool(claims.sid, 'memory_service_search_memories', 'manager', callId)
      const body = await readJson(req)
      const result = this.control.memorySearchFor(claims.sid, text(body.jobId), text(body.query))
      if (!result.ok) throw new HttpError(managerRefusalStatus(result.code), result.reason)
      return json(res, 200, { job: result.job, rows: result.rows })
    }

    if (method === 'POST' && url.pathname === '/v1/tools/memory/decide') {
      this.control.requireTool(claims.sid, 'memory_service_decide', 'manager', callId)
      const body = await readJson(req)
      const result = this.control.memoryDecideBy(claims.sid, {
        jobId: text(body.jobId),
        candidateId: text(body.candidateId),
        checksum: text(body.checksum),
        decision: memoryDecision(body.decision),
        ...(body.memoryId === undefined ? {} : { memoryId: text(body.memoryId) }),
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
      })
      if (!result.ok) throw new HttpError(managerRefusalStatus(result.code), result.reason)
      return json(res, 200, { code: result.code, job: result.job })
    }

    if (method === 'POST' && url.pathname === '/v1/tools/memory/return') {
      this.control.requireTool(claims.sid, 'memory_service_return_candidate', 'manager', callId)
      const body = await readJson(req)
      const result = this.control.memoryReturnBy(claims.sid, {
        jobId: text(body.jobId),
        candidateId: text(body.candidateId),
        checksum: text(body.checksum),
        reason: text(body.reason),
      })
      if (!result.ok) throw new HttpError(managerRefusalStatus(result.code), result.reason)
      return json(res, 200, { job: result.job, returnId: result.returnId })
    }

    // The proposal the Router or the PM may offer. The caller is the Session the token proved: the scope is checked
    // against its own authority and every source against the records the control plane really holds. A proposal that
    // names a candidate is that same candidate, said once more by the Session it was sent back to.
    if (method === 'POST' && url.pathname === '/v1/tools/memory/propose') {
      this.control.requireTool(claims.sid, 'control_memory_propose', ['router', 'pm'], callId)
      const body = await readJson(req)
      const result = this.control.memoryProposeFor(claims.sid, {
        content: text(body.content),
        scopeType: text(body.scopeType),
        scopeId: text(body.scopeId),
        ...(body.importance === undefined ? {} : { importance: Number(body.importance) }),
        ...(body.sourceRefs === undefined ? {} : { sourceRefs: this.sourceRefs(body.sourceRefs) }),
        ...(body.candidateId === undefined ? {} : { candidateId: text(body.candidateId) }),
        ...(body.checksum === undefined ? {} : { checksum: text(body.checksum) }),
      })
      if (!result.ok) throw new HttpError(memoryRefusalStatus(result.code), result.reason)
      const candidate = result.candidate
      if (candidate === undefined) return json(res, 201, { duplicate: true })
      return json(res, 201, { candidate, duplicate: result.duplicate })
    }

    // The Router's read: the running state of every Project. Only a Router Session token opens it, so a PM or a Worker
    // token cannot borrow the Router's view and a Router token cannot borrow a PM's tools.
    if (method === 'GET' && url.pathname === '/v1/tools/router/summary') {
      this.control.requireTool(claims.sid, 'control_router_summary', 'router', callId)
      return json(res, 200, this.control.routerSummary())
    }

    if (method === 'POST' && url.pathname === '/v1/tools/router/projects') {
      this.control.requireTool(claims.sid, 'control_router_create_project', 'router', callId)
      const body = await readJson(req)
      const requestId = text(body.requestId)
      const title = stringValue(body.title, 'title', true)!
      const goal = stringValue(body.goal, 'goal', true)!
      const result = await this.control.routerCreateProject(claims.sid, requestId, title, goal)
      return json(res, 200, result)
    }

    if (method === 'POST' && url.pathname === '/v1/tools/router/project-gate') {
      this.control.requireTool(claims.sid, 'control_router_project_gate', 'router', callId)
      const body = await readJson(req)
      const requestId = text(body.requestId)
      // The decision is read and judged by the control plane: the Router states it, the control plane decides.
      const result = await this.control.routerProjectGate(claims.sid, requestId, body.decision)
      return json(res, 200, result)
    }

    if (method === 'POST' && url.pathname === '/v1/tools/router/dispatch') {
      this.control.requireTool(claims.sid, 'control_router_dispatch', 'router', callId)
      const body = await readJson(req)
      const result = this.control.routerDispatch(claims.sid, text(body.requestId),
        stringValue(body.title, 'title', true)!, stringValue(body.goal, 'goal', true)!)
      return json(res, 200, result)
    }

    if (method === 'POST' && url.pathname === '/v1/tools/router/manage') {
      this.control.requireTool(claims.sid, 'control_router_manage', 'router', callId)
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
      this.control.requireTool(claims.sid, 'control_router_pm_proposal', 'router', callId)
      const body = await readJson(req)
      const requestId = text(body.requestId)
      const projectId = text(body.projectId)
      const instruction = text(body.instruction)
      const result = await this.control.routerPmProposal(claims.sid, requestId, projectId, instruction)
      return json(res, 200, result)
    }

    // The high-level Router's own handoff: give this request to the PM of one Project.
    // The decision is read and judged by the control plane: the request has to ask for work, the Project has to be the
    // one the request names, and the instruction has to be the person's own words. A request may reach one PM only.
    if (method === 'POST' && url.pathname === '/v1/tools/router/pm-handoff') {
      this.control.requireTool(claims.sid, 'control_router_pm_handoff', 'router', callId)
      const body = await readJson(req)
      const requestId = text(body.requestId)
      const result = await this.control.routerPmHandoff(claims.sid, requestId, body.decision)
      return json(res, 200, result)
    }

    if (method === 'POST' && url.pathname === '/v1/tools/worker/report') {
      this.control.requireTool(claims.sid, 'control_report', 'worker', callId)
      const body = await readJson(req)
      const ticketId = text(body.ticketId)
      const assignmentId = body.assignmentId === undefined ? undefined : text(body.assignmentId)
      // The call's own id: the node sends the tool invocation's id, so a replayed call is recognised as the same call.
      // A node that sends none keeps the older behaviour, which never suppresses a new fact.
      const callKey = body.callKey === undefined ? undefined : stringValue(body.callKey, 'callKey', true)!
      // The memories the report names are the model's own claim about what it used. The control plane checks every one of
      // them against the ledger of the injection it wrote itself, so a name that was never in front of this task counts
      // for nothing.
      const appliedMemoryIds = parseAppliedMemoryIds(body.appliedMemoryIds)
      const ticket = this.control.workerReport(claims.sid, ticketId, assignmentId, parseWorkerReport(body.report), callKey,
        callId, appliedMemoryIds)
      return json(res, 200, { ticket })
    }

    // The explicit human authorization application a PM or the Router raises about a permission denial review.
    //
    // It names the review and nothing else. The control plane checks that the caller is the exact immediate manager of
    // that review, that the edge it governs is still alive and that the review is the current one of its scope. The
    // application is a request in front of an operator: it grants nothing, changes no Mandate and repeats no refused
    // call. One review has one application, so a retried call is clean.
    if (method === 'POST' && url.pathname === '/v1/tools/denial/authorization') {
      this.control.requireTool(claims.sid, 'control_request_authorization', ['pm', 'router'], callId)
      const body = await readJson(req)
      const reviewId = text(body.reviewId)
      const application = this.control.requestDenialAuthorization(claims.sid, reviewId)
      return json(res, 200, { application })
    }

    // The subscription of a PM or the Router to the stream of a Session it supervises.
    //
    // The subscriber is the token's own Session and is never named by the request: a token decides who acts, so the
    // request may only ever watch what the token already names. The target must be a lawful subordinate, and a refusal
    // says nothing about whether the target exists. The subscription is off by default and the answer says what it
    // became, so a repeated call is harmless.
    if (method === 'POST' && url.pathname === '/v1/tools/stream/subscribe') {
      this.control.requireTool(claims.sid, 'control_subscribe_session_stream', ['pm', 'router'], callId)
      const body = await readJson(req)
      const sessionId = text(body.sessionId)
      const intervalSeconds = streamIntervalOf(body.intervalSeconds)
      if (intervalSeconds !== undefined && !Number.isSafeInteger(intervalSeconds)) {
        throw new ToolCallError('invalid', 'intervalSeconds must be a whole number of seconds')
      }
      const subscription = this.control.subscribeSessionStream(claims.sid, sessionId, intervalSeconds, callId)
      return json(res, 200, { subscription })
    }

    // The end of one subscription. It takes effect at once: a digest that is on its way does not go out either.
    if (method === 'POST' && url.pathname === '/v1/tools/stream/unsubscribe') {
      this.control.requireTool(claims.sid, 'control_unsubscribe_session_stream', ['pm', 'router'], callId)
      const body = await readJson(req)
      const sessionId = text(body.sessionId)
      const subscription = this.control.unsubscribeSessionStream(claims.sid, sessionId, callId)
      return json(res, 200, { subscription })
    }

    // The external observation events an Agent may watch for.
    //
    // The owner is the Session the token names and never the request: a token decides who acts, so a request may only
    // ever watch what the token already names. The target is checked against the caller's own scope — a Worker watches
    // itself, a PM watches the Workers of its own Project, the Router watches the PMs and the standalone Workers — and
    // a refusal says nothing about whether the target exists.
    if (method === 'POST' && url.pathname === '/v1/tools/external/subscriptions') {
      this.control.requireTool(claims.sid, 'control_create_external_subscription', ['pm', 'worker', 'router'], callId)
      const body = await readJson(req)
      // The owner of a subscription is the Session the token names: a request may never choose one.
      if (body.ownerSessionId !== undefined || body.creatorSessionId !== undefined) {
        throw new HttpError(403, 'The owner of an external subscription is the Session this token names')
      }
      const subscription = await this.control.createExternalSubscriptionFor(claims.sid,
        externalSubscriptionInput(body))
      return json(res, 200, { subscription })
    }
    if (method === 'GET' && url.pathname === '/v1/tools/external/subscriptions') {
      this.control.requireTool(claims.sid, 'control_list_external_subscriptions', ['pm', 'worker', 'router'], callId)
      return json(res, 200, { subscriptions: this.control.externalSubscriptionsOf(claims.sid) })
    }
    const externalToolSubscription = /^\/v1\/tools\/external\/subscriptions\/([^/]+)$/.exec(url.pathname)
    if (externalToolSubscription) {
      const subscriptionId = decodeURIComponent(externalToolSubscription[1]!)
      if (method === 'PUT') {
        this.control.requireTool(claims.sid, 'control_update_external_subscription', ['pm', 'worker', 'router'], callId)
        const body = await readJson(req)
        const subscription = await this.control.updateExternalSubscriptionFor(claims.sid, subscriptionId,
          externalSubscriptionPatch(body))
        return json(res, 200, { subscription })
      }
      if (method === 'DELETE') {
        this.control.requireTool(claims.sid, 'control_delete_external_subscription', ['pm', 'worker', 'router'], callId)
        const subscription = this.control.cancelExternalSubscriptionFor(claims.sid, subscriptionId)
        return json(res, 200, { subscription })
      }
    }

    throw new HttpError(404, 'Not found')
  }
}
