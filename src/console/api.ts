/**
 * The console's own HTTP client.
 *
 * A verified key is kept in tab-scoped sessionStorage so a reload can reconnect. Requests carry it as a bearer header.
 *
 * The event stream is read with `fetch` rather than `EventSource`, because `EventSource` cannot carry a bearer token. A
 * stream that ends is opened again from the last sequence it delivered, with a growing pause between the attempts.
 */

/** A request that failed, with the status the control plane answered. */
export class ConsoleApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ConsoleApiError'
  }
}

/** One event of the control plane's stream. */
export interface StreamEvent {
  seq: number
  type: string
  at: string
  nodeId: string
  sessionId: string
  projectId: string
}

/** The counts the console's home page shows. */
export interface Overview {
  at: string
  runningTickets: number
  runningWorkers: number
  pendingReviews: number
  features: { router: boolean; schedules: boolean }
  /** What the scheduler holds; the failure count is the number of plans whose last run failed. */
  schedules: ScheduleCounts
  counts: { projects: number; tickets: number; sessions: number; nodes: number }
  nodes: NodeView[]
  events: { seq: number; retained: number }
  audit: { entries: number }
  retention: { eventDays: number; eventRows: number; auditDays: number }
}

/** One scheduled plan, as the console reads it. */
export interface SchedulePlan {
  id: string
  projectId: string
  projectTitle: string
  projectStatus: string
  name: string
  /** The rule as the operator wrote it. */
  rule: string
  /** The same rule in words a person can check against a calendar. */
  ruleText: string
  /** The note the message carries; it is data, never an order. */
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

/** One run of a plan, as the console reads it. */
export interface ScheduleRun {
  runId: string
  planId: string
  projectId: string
  name: string
  rule: string
  reason: string
  plannedAt: string
  startedAt?: string
  finishedAt?: string
  state: string
  acknowledged: boolean
  error?: string
  skipped: number
}

/** What the scheduler holds: the counts the console's home page shows. */
export interface ScheduleCounts {
  plans: number
  enabled: number
  failed: number
  interrupted: number
  delivered: number
  lastRunAt?: string
  nextRunAt?: string
}

/** One entry of the audit trail. */
export interface AuditEntry {
  seq: number
  at: string
  actor: string
  kind: string
  action: string
  targetKind: string
  targetId: string
  outcome: string
  detail: string
}

/** One Session as the control plane records it. */
export interface SessionView {
  sessionId: string
  backendSessionId?: string
  projectId: string
  assignmentId?: string
  role: string
  nodeId: string
  workspace: string
  status: string
  toolProfile: string
  model?: string
  createdAt: string
  updatedAt: string
  archivedAt?: string
  tokenVersion?: number
  revokedAt?: string
  revokedReason?: string
  /**
   * Whether an operator's message may still reach this Session.
   *
   * A Worker Session that a newer Assignment replaced cannot receive a message: it would reach the Worker that took its
   * place. The console shows that instead of offering an action the server would refuse — the server's own check is the
   * rule.
   */
  deliverable?: boolean
  /** Why the Session may not receive a message, when it may not. */
  unavailableReason?: string
  /**
   * The turn this Session runs, when the node reported one.
   *
   * The number is what an interrupt names, so the console can say which turn it would end.
   */
  currentTurn?: number
  /**
   * Whether the node can interrupt one running turn of one Session.
   *
   * A node that does not offer it says so here, and the console does not offer an action the server would refuse.
   */
  interruptible?: boolean
  /** The operator's own stop of this Session, when there is one. */
  operatorStop?: { at: string; by: string; state: string; reason?: string; error?: string }
}

/** One message of a Session. */
export interface SessionMessage {
  seq: number
  at: string
  role: string
  text: string
}

/** One message of the Router's conversation, as the console reads it. */
export interface RouterMessage {
  seq: number
  at: string
  role: string
  text: string
  attachments?: string[]
  /** The request id a person's message carries, when it is one of the Router's own requests. */
  requestId?: string
}

/**
 * One proposal to relay a person's instruction to the PM of one Project.
 *
 * The instruction is the text that would really be sent, so the person who confirms it reads what the PM will get.
 */
export interface RouterProposal {
  /** The proposal's own id: the handle the console confirms or cancels. */
  id: string
  /** The request the proposal came from. */
  requestId: string
  /** The Project whose PM would receive the instruction. */
  projectId: string
  /** The Project's title. */
  projectTitle: string
  /** The text that would really be sent to that Project's PM. */
  instruction: string
  /** When the proposal was made. */
  at: string
}

/**
 * One message a person sent to the Router, and what became of it.
 *
 * The states are facts about different moments: `queued` while the message waits for the Router's next turn, `sending`
 * while it is on its way to the node, `sent` once the node took it into the Session's inbox, `read` once a turn of that
 * Session really took it, `failed` when the node refused it, and `unconfirmed` when the control plane cannot say
 * whether it arrived. The inbox is not a turn, and the console never shows one as the other.
 */
export interface RouterQueueEntry {
  /** The message's own id. */
  id: string
  /** When the person sent it. */
  at: string
  /** The person's own words. */
  text: string
  /** The names of the files the message carried. */
  attachments?: string[]
  /** What became of it. */
  state: 'queued' | 'sending' | 'sent' | 'read' | 'failed' | 'unconfirmed'
  /** Why it failed, or why it still waits. */
  error?: string
  /** The Router request the message is. */
  requestId: string
}

/**
 * The Router's own facts, as the console reads them.
 *
 * The conversation comes from the node's own message events, so what the console shows is what really happened: the
 * person's words on one side, the model's answers on the other, and nothing in between that the console made up.
 */
export interface RouterState {
  /**
   * The Router Session, when it has been started.
   *
   * `currentTurn` is the turn the Router runs right now, as the node reported it, and `interruptible` says whether the
   * node offers to end one turn at all. The console offers the interrupt only when the backend confirms both.
   */
  session?: { sessionId: string; status: string; workspace: string; updatedAt: string; revokedAt?: string
    currentTurn?: number; interruptible?: boolean }
  /** Whether the node the Router runs on is reachable. */
  nodeOnline: boolean
  /** The conversation, oldest first. */
  messages: RouterMessage[]
  /** The proposal that waits for a person right now, when there is one. Nothing has been sent yet. */
  proposal?: RouterProposal
  /** The messages that wait for the Router, oldest first. */
  queue?: RouterQueueEntry[]
  /**
   * The notices about stops the Router is the logical superior of.
   *
   * The Router is the superior of every PM Session and of the Workers of the standalone Tickets, so an operator's stop
   * of any of them leaves a notice here.
   */
  stops?: StopNotice[]
}

/** One notice about an operator's stop, as the console reads it. */
export interface StopNotice {
  /** The notice's own id. */
  id: number
  /** When the stop was recorded. */
  at: string
  /** What was stopped. */
  target: { kind: string; id: string; sessionId?: string }
  /** How far the stop reached. */
  scope: string
  /** `requested` until the node confirmed the stop; `confirmed` afterwards. */
  state: string
  /** Who stopped it. */
  actor: string
  /** The Project the stopped work belonged to, when it had one. */
  projectId?: string
  /** What the stop affected. */
  affected: string[]
  /** What the stop left running. */
  unaffected: string[]
  /** Who may read the notice. */
  superior: { kind: string; id?: string }
  /** The diagnostic of a stop the node did not confirm. */
  error?: string
}

/** One node as the control plane knows it. */
export interface NodeView {
  nodeId: string
  backend: string
  version: string
  online: boolean
  at: string
  capabilities?: string[]
}

/** One Ticket as the console reads it. */
export interface ConsoleTicket {
  id: string
  title: string
  projectId?: string
  status: string
  assignment?: { id: string; state: string; report?: { state: string; summary: string; at: string } }
  review?: { id: string; state: string; assignmentId: string; at: string; summary?: string }
  attention?: { question: string }
  manualStop?: { scope: string; at: string }
}

/** One Project as the console reads it. */
export interface ConsoleProject {
  id: string
  title: string
  goal: string
  workspace: string
  status: string
  pauseMode?: string
  pmSessionId: string
  createdAt: string
  updatedAt: string
  latestReport?: { summary: string; at: string }
  tickets: ConsoleTicket[]
}

/** One entry of a Project's own memory. */
export interface ProjectMemoryEntry {
  id: number
  projectId: string
  at: string
  actor: string
  text: string
}

/** One finding of a reconciliation run. */
export interface ReconcileFinding {
  id: string
  kind: string
  sessionId: string
  assignmentId?: string
  projectId: string
  action: string
  outcome: string
  reason?: string
}

/** One run of the reconciliation, as the console reads it. */
export interface ReconcileRun {
  id: number
  at: string
  nodeOnline: boolean
  checked: number
  findings: ReconcileFinding[]
  counts: { orphans: number; cleaned: number; failed: number; reported: number }
  boundary: string
}

const TAB_CONNECTION_KEY = 'superagent.console.connection'
export const CONSOLE_KEY_REJECTED = 'superagent:console-key-rejected'

function restoreConsoleKey(): string {
  try {
    return window.sessionStorage.getItem(TAB_CONNECTION_KEY) ?? ''
  } catch {
    return ''
  }
}

let controlKey = restoreConsoleKey()

function setConsoleKey(value: string): void {
  controlKey = value
  try {
    if (value) window.sessionStorage.setItem(TAB_CONNECTION_KEY, value)
    else window.sessionStorage.removeItem(TAB_CONNECTION_KEY)
  } catch { /* A browser that blocks storage can still use the in-memory connection. */ }
}

export function clearConsoleKey(): void { setConsoleKey('') }

export async function connectConsole(key: string): Promise<void> {
  await request<Overview>('/v1/overview', {}, key)
  setConsoleKey(key)
}

function rejectConsoleKey(sent: string): void {
  if (!sent || sent !== controlKey) return
  clearConsoleKey()
  window.dispatchEvent(new Event(CONSOLE_KEY_REJECTED))
}

/** The key the console sends right now. */
export function consoleKey(): string { return controlKey }

/** The message of a failed request, for the console to show. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One request to the control plane, with the key in the header. */
async function request<T>(path: string, init: { method?: string; body?: unknown } = {}, key = controlKey): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    if (response.status === 401) rejectConsoleKey(key)
    let message = `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === 'string' && parsed.error !== '') message = parsed.error
    } catch {
      // The answer was not JSON; the status is the message a person needs.
    }
    throw new ConsoleApiError(response.status, message)
  }
  return (text === '' ? undefined : JSON.parse(text)) as T
}

/** One read. */
export function read<T>(path: string): Promise<T> { return request<T>(path) }

/** One write. */
export function write<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: 'POST', body })
}

/** One write that is not a creation. */
export function put<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: 'PUT', body })
}

/** One delete. */
export function remove<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}

/** How the stream is doing. */
export type StreamStatus = 'connected' | 'reconnecting'

/** What the console wants to know about the stream. */
export interface StreamHandlers {
  /** One event, in the order the control plane recorded it. */
  onEvent: (event: StreamEvent) => void
  /** The stream opened or is being opened again. */
  onStatus?: (status: StreamStatus) => void
  /** The log no longer holds events between the ones the console has: a hole it cannot fill. */
  onGap?: () => void
  /** The sequence the stream starts after; the console reads the current one and asks for what follows it. */
  from?: number
}

/** One parsed frame of the stream. */
type Frame = { kind: 'event'; event: StreamEvent } | { kind: 'gap' } | { kind: 'other' }

/** One frame of an SSE body: its data, or the comment that says the log has a hole. */
function parseFrame(raw: string): Frame {
  for (const line of raw.split('\n')) {
    if (line.trim() === ': gap') return { kind: 'gap' }
  }
  let data = ''
  let hasData = false
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field !== 'data') continue
    data = hasData ? `${data}\n${value}` : value
    hasData = true
  }
  if (!hasData) return { kind: 'other' }
  try {
    const parsed = JSON.parse(data) as StreamEvent
    if (typeof parsed?.seq !== 'number') return { kind: 'other' }
    return { kind: 'event', event: parsed }
  } catch {
    return { kind: 'other' }
  }
}

/** Read one SSE body, handing every frame to the console. */
async function readStream(body: ReadableStream<Uint8Array>, handlers: StreamHandlers): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = parseFrame(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      if (frame.kind === 'event') handlers.onEvent(frame.event)
      else if (frame.kind === 'gap') handlers.onGap?.()
      boundary = buffer.indexOf('\n\n')
    }
  }
}

/** Wait for a while, for the pause between two attempts. */
function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/**
 * Follow the control plane's event stream until the returned function is called.
 *
 * A stream that ends is opened again from the last sequence it delivered, so nothing is missed and nothing is repeated.
 * The pause between the attempts grows from a quarter of a second to five, which keeps a control plane that is down from
 * being hammered. `from` names the sequence the console already knows: the stream then carries only what follows it,
 * which is what the console needs — it reads the current facts from the API, not from the history.
 */
export function followEvents(path: string, handlers: StreamHandlers): () => void {
  let stopped = false
  let controller: AbortController | undefined
  let attempt = 0
  let lastSeq = handlers.from ?? 0

  const run = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController()
      try {
        const key = controlKey
        const response = await fetch(`${path}?after=${lastSeq}`, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: controller.signal,
        })
        if (response.status === 401) {
          rejectConsoleKey(key)
          return
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        if (!response.body) throw new Error('the event stream has no body')
        attempt = 0
        handlers.onStatus?.('connected')
        await readStream(response.body, {
          onEvent: event => {
            if (event.seq > lastSeq) lastSeq = event.seq
            handlers.onEvent(event)
          },
          ...(handlers.onGap ? { onGap: handlers.onGap } : {}),
        })
      } catch {
        // A stream that broke is opened again below; a console that was stopped simply ends.
        if (stopped) return
      }
      if (stopped) return
      handlers.onStatus?.('reconnecting')
      attempt += 1
      await delay(Math.min(250 * 2 ** (attempt - 1), 5000))
    }
  }
  void run()
  return () => {
    stopped = true
    controller?.abort()
  }
}
