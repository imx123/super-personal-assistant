/** A `NodePort` over the node's HTTP + SSE transport; no DSH imports. */
import { randomUUID } from 'node:crypto'
import { NODE_PROTOCOL_VERSION, NodeUnconfirmedError, type DeliveryEvidence, type DeliveryEvidenceState, type NodeCommand,
  type NodeEvent, type NodePort, type SessionInspection } from '../shared/protocol.ts'

export interface HttpNodePortOptions {
  /** Base URL of the node server, such as `http://127.0.0.1:4310`. */
  url: string
  /** The node's bearer token. It is never the control plane's API token. */
  token: string
  /** Node id stamped on commands this transport originates, such as `session.inspect`. */
  nodeId?: string
  /** Clock for those commands; tests pin it. */
  now?: () => string
  /** How long `inspect` waits for the node's `session.inspected` event. */
  inspectionTimeoutMs?: number
  /**
   * Total time one `POST /commands` may take, including reading a rejection body. A node that accepts the socket but never
   * answers is half-reachable: without this bound a heartbeat (or any command) would wait forever, so the kernel could
   * never record the node offline nor retry. Defaults to {@link DEFAULT_COMMAND_TIMEOUT_MS}.
   */
  commandTimeoutMs?: number
  /** First delay before a dropped `subscribe` stream is reopened; every failed attempt doubles it. */
  reconnectDelayMs?: number
  /** Cap of the reconnect delay, so a node that stays away is retried at a steady pace instead of forever backing off. */
  maxReconnectDelayMs?: number
  /**
   * Called once after a dropped `subscribe` stream was reopened, so the owner can refresh facts the missed events carried.
   * `startControlPlane` rotates the control-plane generation here and then refreshes the node's liveness.
   */
  onReconnect?: () => void
}

const DEFAULT_RECONNECT_DELAY_MS = 250
const DEFAULT_MAX_RECONNECT_DELAY_MS = 5_000
/** The default bound on one `send`; a heartbeat must settle well within its interval so the loop can retry. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000

interface Subscription {
  listener: (event: NodeEvent) => void
  controller: AbortController
  /** Resolves once the SSE response is open, so a command sent after it cannot race the connection. */
  ready: Promise<void>
  settleReady(error?: Error): void
  /** Whether a dropped stream is reopened; `inspect` asks for one stream and never retries. */
  reconnect: boolean
  /** Consecutive failed attempts since the stream was last open; drives the reconnect backoff. */
  attempts: number
  /** Whether this subscription already opened once, so a later open is a reconnect worth refreshing state for. */
  connected: boolean
  /** The pending backoff timer, so `detach` can cancel it instead of leaving one behind. */
  retryTimer?: ReturnType<typeof setTimeout>
  cancelRetry?: () => void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isEvent(value: unknown): value is NodeEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === 'string'
}

/** The states a node may answer a question about a delivery with. */
const EVIDENCE_STATES: ReadonlySet<string> = new Set(['inbox', 'consumed_turn', 'absent', 'unknown'])

/**
 * The answer as this transport accepts it.
 *
 * The answer arrives from the wire, so it is read as data and not trusted as a fact: a state this transport does not know
 * proves nothing, and neither does an answer that is not an answer at all. Both become `unknown`, the one answer that
 * never repeats a delivery on a guess.
 */
function validatedEvidence(value: unknown): DeliveryEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { state: 'unknown', reason: 'the node answered with something that is not an answer' }
  }
  const answer = value as { state?: unknown; reason?: unknown }
  if (typeof answer.state !== 'string' || !EVIDENCE_STATES.has(answer.state)) {
    return { state: 'unknown', reason: 'the node answered with a state this transport does not know' }
  }
  const reason = typeof answer.reason === 'string' ? answer.reason.slice(0, 300) : ''
  return { state: answer.state as DeliveryEvidenceState, ...(reason === '' ? {} : { reason }) }
}

/**
 * Commands go out as one `POST /commands` per call; events come back on one SSE stream per listener.
 * The transport does not add protocol rules: the node rejects versions and commands it does not accept.
 */
export class HttpNodePort implements NodePort {
  private readonly baseUrl: string
  private readonly token: string
  private readonly nodeId: string
  private readonly now: () => string
  private readonly inspectionTimeoutMs: number
  private readonly commandTimeoutMs: number
  private readonly reconnectDelayMs: number
  private readonly maxReconnectDelayMs: number
  /** Assignable so an owner that builds the control plane later can still refresh it when this transport reconnects. */
  onReconnect?: () => void
  private readonly subscriptions = new Set<Subscription>()

  constructor(options: HttpNodePortOptions) {
    if (!options.token) throw new Error('A node bearer token is required')
    const url = new URL(options.url)
    this.baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
    this.token = options.token
    this.nodeId = options.nodeId ?? 'local'
    this.now = options.now ?? (() => new Date().toISOString())
    this.inspectionTimeoutMs = options.inspectionTimeoutMs ?? 5000
    const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    // An invalid bound must never silently mean "no timeout": a deployment typo would freeze every heartbeat again.
    if (typeof commandTimeoutMs !== 'number' || !Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
      throw new Error('HttpNodePort commandTimeoutMs must be a positive finite number of milliseconds')
    }
    this.commandTimeoutMs = commandTimeoutMs
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS
    this.onReconnect = options.onReconnect
  }

  /**
   * POST one command, bounded by `commandTimeoutMs` and by the caller's optional signal.
   *
   * The caller's signal is merged rather than replaced: `inspect` aborts the stream and the command with its own deadline,
   * and this transport still needs its own total bound for every command no caller aborts. A timeout rejects with an error
   * naming the command type and the limit (never the token), so `ControlPlane.heartbeat` records the node offline and its
   * loop can retry instead of awaiting a fetch that will never settle. The timer and abort listener are always removed.
   *
   * The two failures are told apart: a node that answered and refused is a plain error, while a node that never answered
   * leaves the outcome unknown — the command may have been carried out — and says so with {@link NodeUnconfirmedError}.
   */
  async send(command: NodeCommand, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const timeoutError = new NodeUnconfirmedError(`The node did not answer ${command.type} within ${this.commandTimeoutMs} ms`)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(timeoutError)
    }, this.commandTimeoutMs)
    const forwardAbort = (): void => { controller.abort(signal?.reason) }
    if (signal) {
      if (signal.aborted) forwardAbort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }
    try {
      const response = await fetch(`${this.baseUrl}/commands`, { method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(command), signal: controller.signal }).catch((error: unknown) => {
        // A caller-owned abort surfaces unchanged; a transport failure leaves the outcome unknown, not a refusal.
        if (signal?.aborted) throw error
        // The command never reached the node, or the answer never came back: the outcome is unknown, not a refusal.
        throw new NodeUnconfirmedError(`The node did not answer ${command.type}: ${describe(error)}`, { cause: error })
      })
      if (response.ok) return
      const detail = await response.text().catch(() => '')
      throw new Error(`Node rejected ${command.type}: HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`)
    } catch (error) {
      // Aborting a fetch does not consistently preserve the abort reason across implementations, so the timeout flag is the
      // authority: a caller-owned abort still surfaces unchanged, a timeout always reports the node that never answered.
      if (timedOut) throw timeoutError
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  /**
   * Ask the node for a Session's status over the existing command/event protocol.
   *
   * The whole operation shares one deadline: opening the SSE stream, POSTing `session.inspect`, and waiting for its
   * `session.inspected` answer. A node that stalls at any step rejects within `inspectionTimeoutMs` with an explicit
   * timeout error; the deadline aborts the fetch and the stream reader, and the timer and listener are cleaned up. The
   * control plane then fails the request instead of returning a stale `starting` record or waiting forever.
   */
  async inspect(sessionId: string, routerDetails?: true): Promise<SessionInspection> {
    const requestId = `session-inspect:${sessionId}:${randomUUID()}`
    const controller = new AbortController()
    let resolveAnswer!: (inspection: SessionInspection) => void
    const answered = new Promise<SessionInspection>(resolve => { resolveAnswer = resolve })
    const subscription = this.attach(event => {
      if (event.type === 'session.inspected' && event.requestId === requestId) resolveAnswer(event.inspection)
    }, controller)
    const timeoutError = new Error(
      `The node did not answer session.inspect for ${sessionId} within ${this.inspectionTimeoutMs} ms`)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError)
        reject(timeoutError)
      }, this.inspectionTimeoutMs)
    })
    const work = (async () => {
      await subscription.ready
      await this.send({ protocolVersion: NODE_PROTOCOL_VERSION, nodeId: this.nodeId, idempotencyKey: requestId,
        at: this.now(), type: 'session.inspect', sessionId, ...(routerDetails ? { routerDetails } : {}) }, controller.signal)
      return await answered
    })()
    // The deadline can win while `work` is still pending; its later rejection is already observed by the race, and this
    // catch keeps a transport that ignores the abort from surfacing as an unhandled rejection.
    work.catch(() => {})
    try {
      return await Promise.race([work, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.detach(subscription)
    }
  }

  subscribe(listener: (event: NodeEvent) => void): () => void {
    const subscription = this.attach(listener, new AbortController(), true)
    return () => { this.detach(subscription) }
  }

  /**
   * Ask the node what it can prove about one delivery.
   *
   * The question names the Session and the exact key, and it travels over the existing command/event protocol: the
   * `delivery.evidence` command goes out and the node's answer comes back on the event stream. The whole operation shares
   * one deadline, so a node that stalls at any step answers `unknown` instead of hanging the recovery.
   *
   * The answer is read only when it comes from the node this transport asked, names the Session the question was about and
   * echoes the exact key the question was about. An answer that matches none of those is not an answer to this question,
   * so it proves nothing: it is ignored, the deadline runs out, and the outcome stays `unknown`. A node that does not know
   * the command refuses it, and a node that does not answer at all leaves the outcome unknown: neither is a proof that the
   * message never arrived, and the control plane may not repeat a delivery on one.
   */
  async evidence(sessionId: string, deliveryKey: string): Promise<DeliveryEvidence> {
    const requestId = `delivery-evidence:${sessionId}:${deliveryKey}:${randomUUID()}`
    const controller = new AbortController()
    let resolveAnswer!: (evidence: DeliveryEvidence) => void
    const answered = new Promise<DeliveryEvidence>(resolve => { resolveAnswer = resolve })
    const subscription = this.attach(event => {
      if (event.type !== 'delivery.evidence') return
      // The question, the node, the Session and the exact key: an answer that names another one of them is about
      // another delivery, and it is never read as this one's answer.
      if (event.requestId !== requestId) return
      if (event.nodeId !== this.nodeId) return
      if (event.sessionId !== sessionId) return
      if (event.deliveryKey !== deliveryKey) return
      resolveAnswer(validatedEvidence(event.evidence))
    }, controller)
    const timeoutError = new Error(
      `The node did not answer delivery.evidence for ${sessionId} within ${this.inspectionTimeoutMs} ms`)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError)
        reject(timeoutError)
      }, this.inspectionTimeoutMs)
    })
    const work = (async () => {
      await subscription.ready
      await this.send({ protocolVersion: NODE_PROTOCOL_VERSION, nodeId: this.nodeId, idempotencyKey: requestId,
        at: this.now(), type: 'delivery.evidence', sessionId, deliveryKey }, controller.signal)
      return await answered
    })()
    work.catch(() => {})
    try {
      return await Promise.race([work, deadline])
    } catch {
      // A node that refused the command, or never answered it, proves nothing: the outcome stays unknown.
      return { state: 'unknown', reason: 'the node did not answer the question about this delivery' }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.detach(subscription)
    }
  }

  /**
   * Open one SSE stream; the caller owns its disposal and may await `ready` before sending a command. A caller that
   * passes its own controller can abort the stream together with the work that depends on it. Only a subscription asks
   * for reopening; `inspect` gets one stream so a failed question fails once instead of waiting on a retry loop.
   */
  private attach(listener: (event: NodeEvent) => void, controller = new AbortController(),
    reconnect = false): Subscription {
    let settleReady!: (error?: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = error => error ? reject(error) : resolve()
    })
    // A stream nobody awaits must not surface as an unhandled rejection; `pump` still reports the error.
    ready.catch(() => {})
    const subscription: Subscription = { listener, controller, ready, settleReady, reconnect, attempts: 0, connected: false }
    this.subscriptions.add(subscription)
    void this.pump(subscription).catch(error => {
      subscription.settleReady(error instanceof Error ? error : new Error(describe(error)))
      if (!subscription.controller.signal.aborted) {
        process.stderr.write(`superagent node event stream failed: ${describe(error)}\n`)
      }
    })
    return subscription
  }

  private detach(subscription: Subscription): void {
    if (!this.subscriptions.delete(subscription)) return
    // A canceled backoff resolves its wait and clears its timer before the abort reaches the stream.
    subscription.cancelRetry?.()
    subscription.controller.abort()
  }

  /**
   * Keep one subscription's stream open for as long as the subscription lives.
   *
   * A one-shot stream fails once and stops. A subscribed stream reopens after the stream ends or the node restarts,
   * waiting `reconnectDelayMs` and doubling that per failed attempt up to `maxReconnectDelayMs`. A stream that opens
   * again resets the backoff and calls `onReconnect` once, because events sent while it was down were missed. An
   * unsubscribe aborts the controller and cancels a pending wait, so no timer or socket outlives the subscription.
   */
  private async pump(subscription: Subscription): Promise<void> {
    while (!subscription.controller.signal.aborted && this.subscriptions.has(subscription)) {
      try {
        await this.consume(subscription, () => { this.noteOpen(subscription) })
      } catch (error) {
        if (subscription.controller.signal.aborted || !this.subscriptions.has(subscription)) return
        if (!subscription.reconnect) {
          subscription.settleReady(error instanceof Error ? error : new Error(describe(error)))
          process.stderr.write(`superagent node event stream failed: ${describe(error)}\n`)
          return
        }
        if (subscription.attempts === 0) {
          // One line per outage: a stream that opened and then dropped, or a first connection that never opened.
          process.stderr.write(`superagent node event stream lost, reconnecting: ${describe(error)}\n`)
        }
      }
      if (subscription.controller.signal.aborted || !this.subscriptions.has(subscription)) return
      if (!subscription.reconnect) return
      // An ended or failed stream counts as one drop; consecutive failures double the wait from the base delay.
      subscription.attempts += 1
      const delay = Math.min(this.reconnectDelayMs * 2 ** (subscription.attempts - 1), this.maxReconnectDelayMs)
      if (!(await this.waitBeforeRetry(subscription, delay))) return
    }
  }

  /** Called as soon as a stream is open: a later open is a reconnect, so reset the backoff and refresh state once. */
  private noteOpen(subscription: Subscription): void {
    if (subscription.controller.signal.aborted || !this.subscriptions.has(subscription)) return
    const wasConnected = subscription.connected
    subscription.connected = true
    subscription.attempts = 0
    if (!wasConnected) return
    try {
      this.onReconnect?.()
    } catch (error) {
      process.stderr.write(`superagent node reconnect handler failed: ${describe(error)}\n`)
    }
  }

  /** Wait out one reconnect backoff; resolves false when the subscription was disposed during the wait. */
  private waitBeforeRetry(subscription: Subscription, delayMs: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (retry: boolean): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        subscription.retryTimer = undefined
        subscription.cancelRetry = undefined
        subscription.controller.signal.removeEventListener('abort', onAbort)
        resolve(retry)
      }
      const onAbort = (): void => { finish(false) }
      timer = setTimeout(() => { finish(true) }, delayMs)
      // A pending retry must not keep the process alive; `detach` still cancels it immediately.
      timer.unref?.()
      subscription.retryTimer = timer
      subscription.cancelRetry = () => { finish(false) }
      if (subscription.controller.signal.aborted) {
        finish(false)
        return
      }
      subscription.controller.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async consume(subscription: Subscription, onOpen?: () => void): Promise<void> {
    const response = await fetch(`${this.baseUrl}/events`, {
      redirect: 'error',
      headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
      signal: subscription.controller.signal,
    })
    if (!response.ok) throw new Error(`event stream rejected with HTTP ${response.status}`)
    if (!response.body) throw new Error('event stream has no body')

    const reader = response.body.getReader()
    subscription.settleReady()
    onOpen?.()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          this.dispatch(subscription, frame)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private dispatch(subscription: Subscription, frame: string): void {
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      data.push(line.slice('data:'.length).replace(/^ /, ''))
    }
    if (data.length === 0) return

    let parsed: unknown
    try {
      parsed = JSON.parse(data.join('\n')) as unknown
    } catch {
      process.stderr.write('superagent node event stream: skipping a frame that is not JSON\n')
      return
    }
    if (!isEvent(parsed)) {
      process.stderr.write('superagent node event stream: skipping a frame that is not a node event\n')
      return
    }
    if (!this.subscriptions.has(subscription)) return
    try {
      subscription.listener(parsed)
    } catch (error) {
      process.stderr.write(`superagent node event listener failed: ${describe(error)}\n`)
    }
  }
}
