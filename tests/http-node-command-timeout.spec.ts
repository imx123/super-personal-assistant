/**
 * P1-3: a node that is only half reachable — it accepts the command socket but never answers — must not freeze the control
 * plane. `HttpNodePort.send` bounds every command, so `ControlPlane.heartbeat` rejects, records the node offline, and the
 * periodic loop retries; a node that answers again becomes online.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { listenFetchLoopback } from './fixtures/fetch-port.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane, type ControlPlaneState } from '../src/control/control-plane.ts'
import { DEFAULT_COMMAND_TIMEOUT_MS, HttpNodePort } from '../src/control/http-node.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeStatus } from '../src/shared/protocol.ts'

const SECRET = 'command-timeout-secret'
const API_TOKEN = 'command-timeout-api-token'
const TOKEN = 'command-timeout-node-token'
const TIMEOUT = 50
const START = '2026-01-01T00:00:00.000Z'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let closeNode: (() => Promise<void>) | undefined

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await sleep(5)
  }
}

/** Track unhandled rejections, so a timeout that leaves a rejected internal promise behind fails the test explicitly. */
function watchUnhandled(): { errors: unknown[]; stop(): void } {
  const errors: unknown[] = []
  const listener = (reason: unknown): void => { errors.push(reason) }
  process.on('unhandledRejection', listener)
  return { errors, stop: () => { process.off('unhandledRejection', listener) } }
}

interface HalfReachableNode {
  url: string
  state: {
    /** When false, `/commands` accepts the request and never answers it. */
    answer: boolean
    /** Every `/commands` request that arrived, answered or not. */
    attempts: number
    commands: NodeCommand[]
  }
}

/**
 * A node that keeps its event stream open and accepts commands, but holds every answer while `state.answer` is false.
 *
 * Holding the response is the exact half-reachability this bug is about: the TCP connection and the request body succeed,
 * so only a bound on the command itself can tell the control plane the node is not going to answer.
 */
function listenHalfReachableNode(): Promise<HalfReachableNode> {
  const state: HalfReachableNode['state'] = { answer: false, attempts: 0, commands: [] }
  const hung: ServerResponse[] = []
  const node = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.flushHeaders()
      return
    }
    if (req.url !== '/commands') {
      res.writeHead(404).end()
      return
    }
    state.attempts += 1
    const chunks: Buffer[] = []
    req.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
    req.on('end', () => {
      try {
        state.commands.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as NodeCommand)
      } catch {
        res.writeHead(400).end()
        return
      }
      if (state.answer) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        return
      }
      hung.push(res)
    })
  })
  return listenFetchLoopback(node).then(({ url }) => {
    closeNode = () => new Promise<void>((done, fail) => {
      for (const res of hung.splice(0)) res.destroy()
      // A held command answer and the open event stream must not keep the server from closing.
      node.closeAllConnections()
      node.close(error => error ? fail(error) : done())
    })
    return { url, state }
  })
}

let sequence = 0

function heartbeatCommand(): NodeCommand {
  const status: NodeStatus = { nodeId: 'local', backend: 'dsh', version: '0.1.0', online: true, at: START,
    capabilities: [] }
  return { protocolVersion: NODE_PROTOCOL_VERSION, nodeId: 'local', idempotencyKey: `beat-${++sequence}`, at: START,
    type: 'node.heartbeat', status }
}

function prepare(): void {
  directory = mkdtempSync(join(tmpdir(), 'superagent-command-timeout-'))
}

function openControl(node: HttpNodePort): ControlPlane {
  return new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces'), confirmationTimeoutMs: 50, now: () => START })
}

afterEach(async () => {
  control?.stopHeartbeat()
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  await closeNode?.().catch(() => {})
  closeNode = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('HttpNodePort command timeout', () => {
  it('defaults the command bound to ten seconds and refuses an invalid one', () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(10_000)
    expect(() => new HttpNodePort({ url: 'http://127.0.0.1:9', token: TOKEN, commandTimeoutMs: 0 }))
      .toThrow('commandTimeoutMs')
    expect(() => new HttpNodePort({ url: 'http://127.0.0.1:9', token: TOKEN, commandTimeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow('commandTimeoutMs')
  })

  it('rejects one send within the bound when the node never answers, then succeeds once it answers', async () => {
    const unhandled = watchUnhandled()
    try {
      const node = await listenHalfReachableNode()
      const port = new HttpNodePort({ url: node.url, token: TOKEN, commandTimeoutMs: TIMEOUT })

      const started = Date.now()
      const error = await port.send(heartbeatCommand()).then(() => undefined, (reason: unknown) => reason)
      const elapsed = Date.now() - started
      expect(String(error)).toContain(`The node did not answer node.heartbeat within ${TIMEOUT} ms`)
      expect(String(error)).not.toContain(TOKEN)
      expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT - 5)
      expect(elapsed).toBeLessThan(1000)

      // The same transport is not poisoned by the timed-out command: the next answer is delivered normally.
      node.state.answer = true
      await expect(port.send(heartbeatCommand())).resolves.toBeUndefined()
      expect(node.state.attempts).toBe(2)

      await sleep(20)
      expect(unhandled.errors).toEqual([])
    } finally {
      unhandled.stop()
    }
  })

  it('merges the caller signal: its abort wins well before the command bound', async () => {
    const unhandled = watchUnhandled()
    try {
      const node = await listenHalfReachableNode()
      const port = new HttpNodePort({ url: node.url, token: TOKEN, commandTimeoutMs: 5000 })
      const controller = new AbortController()
      const started = Date.now()
      const pending = port.send(heartbeatCommand(), controller.signal)
      setTimeout(() => controller.abort(new Error('caller cancelled')), 10)

      const error = await pending.then(() => undefined, (reason: unknown) => reason)
      expect(String(error)).toContain('caller cancelled')
      expect(Date.now() - started).toBeLessThan(1000)

      await sleep(20)
      expect(unhandled.errors).toEqual([])
    } finally {
      unhandled.stop()
    }
  })
})

describe('ControlPlane heartbeat against a half-reachable node', () => {
  it('records the node offline on /v1/state, then online after a bounded beat finally answers', async () => {
    prepare()
    const node = await listenHalfReachableNode()
    const port = new HttpNodePort({ url: node.url, token: TOKEN, commandTimeoutMs: TIMEOUT })
    control = openControl(port)
    server = new ControlPlaneServer(control, { token: API_TOKEN })
    const address = await server.listen(0)
    const auth = { authorization: `Bearer ${API_TOKEN}` }

    const started = Date.now()
    await expect(control.heartbeat()).rejects.toThrow('could not be reached')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(control.state().nodes.local?.online).toBe(false)

    const offline = await fetch(`${address.url}/v1/state`, { headers: auth })
    expect(offline.status).toBe(200)
    expect(((await offline.json()) as ControlPlaneState).nodes.local?.online).toBe(false)

    node.state.answer = true
    await control.heartbeat()
    expect(control.state().nodes.local?.online).toBe(true)
    const online = await fetch(`${address.url}/v1/state`, { headers: auth })
    expect(online.status).toBe(200)
    expect(((await online.json()) as ControlPlaneState).nodes.local?.online).toBe(true)
  })

  it('keeps retrying after a timed-out beat and recovers on a later beat', async () => {
    prepare()
    const node = await listenHalfReachableNode()
    const port = new HttpNodePort({ url: node.url, token: TOKEN, commandTimeoutMs: TIMEOUT })
    control = openControl(port)
    control.startHeartbeat(20)
    try {
      // Two attempts prove the loop did not await the first unanswered fetch forever.
      await until(() => control!.state().nodes.local?.online === false && node.state.attempts >= 2,
        'the heartbeat loop did not retry after a timed-out beat')
      expect(node.state.commands.filter(command => command.type === 'node.heartbeat').length).toBeGreaterThanOrEqual(2)

      node.state.answer = true
      await until(() => control!.state().nodes.local?.online === true, 'a later heartbeat did not restore the node')
    } finally {
      control.stopHeartbeat()
    }
  })
})
