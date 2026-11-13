/** A `NodePort` over the node's HTTP + SSE transport; no DSH imports. */
import { randomUUID } from 'node:crypto'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeEvent, type NodePort, type SessionInspection }
  from '../shared/protocol.ts'

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
}

interface Subscription {
  listener: (event: NodeEvent) => void
  controller: AbortController
  /** Resolves once the SSE response is open, so a command sent after it cannot race the connection. */
  ready: Promise<void>
  settleReady(error?: Error): void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isEvent(value: unknown): value is NodeEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === 'string'
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
  private readonly subscriptions = new Set<Subscription>()

  constructor(options: HttpNodePortOptions) {
    if (!options.token) throw new Error('A node bearer token is required')
    const url = new URL(options.url)
    this.baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
    this.token = options.token
    this.nodeId = options.nodeId ?? 'local'
    this.now = options.now ?? (() => new Date().toISOString())
    this.inspectionTimeoutMs = options.inspectionTimeoutMs ?? 5000
  }

  async send(command: NodeCommand, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.baseUrl}/commands`, { method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(command), ...(signal ? { signal } : {}) })
    if (response.ok) return
    const detail = await response.text().catch(() => '')
    throw new Error(`Node rejected ${command.type}: HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`)
  }

  /**
   * Ask the node for a Session's status over the existing command/event protocol.
   *
   * The whole operation shares one deadline: opening the SSE stream, POSTing `session.inspect`, and waiting for its
   * `session.inspected` answer. A node that stalls at any step rejects within `inspectionTimeoutMs` with an explicit
   * timeout error; the deadline aborts the fetch and the stream reader, and the timer and listener are cleaned up. The
   * control plane then fails the request instead of returning a stale `starting` record or waiting forever.
   */
  async inspect(sessionId: string): Promise<SessionInspection> {
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
        at: this.now(), type: 'session.inspect', sessionId }, controller.signal)
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
    const subscription = this.attach(listener)
    return () => { this.detach(subscription) }
  }

  /**
   * Open one SSE stream; the caller owns its disposal and may await `ready` before sending a command. A caller that
   * passes its own controller can abort the stream together with the work that depends on it.
   */
  private attach(listener: (event: NodeEvent) => void, controller = new AbortController()): Subscription {
    let settleReady!: (error?: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = error => error ? reject(error) : resolve()
    })
    // A stream nobody awaits must not surface as an unhandled rejection; `consume` still reports the error.
    ready.catch(() => {})
    const subscription: Subscription = { listener, controller, ready, settleReady }
    this.subscriptions.add(subscription)
    void this.consume(subscription).catch(error => {
      subscription.settleReady(error instanceof Error ? error : new Error(describe(error)))
      if (!subscription.controller.signal.aborted) {
        process.stderr.write(`superagent node event stream failed: ${describe(error)}\n`)
      }
    })
    return subscription
  }

  private detach(subscription: Subscription): void {
    if (!this.subscriptions.delete(subscription)) return
    subscription.controller.abort()
  }

  private async consume(subscription: Subscription): Promise<void> {
    const response = await fetch(`${this.baseUrl}/events`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
      signal: subscription.controller.signal,
    })
    if (!response.ok) throw new Error(`event stream rejected with HTTP ${response.status}`)
    if (!response.body) throw new Error('event stream has no body')

    const reader = response.body.getReader()
    subscription.settleReady()
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
