/**
 * P2-A: the node-side token refresh behind the control-plane proxy tools.
 *
 * A tool call that meets `401` refreshes its Session token once, adopts it, and retries the same request. These tests pin
 * the exchange with a scripted `fetch`: no control plane runs, and every Authorization header is asserted explicitly. A
 * failed refresh or a retried `401` must surface the original refusal instead of looping.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKER_PROFILE } from '../src/control/roles.ts'
import { createDshPortHost, refreshToken, type DshPortFetch } from '../src/node/dsh-port-host.ts'

const BASE_URL = 'http://control.test'

let directory = ''

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

/** One tool the host registered into the fake Agent's scoped registry. */
interface RegisteredTool {
  name: string
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

/** A DSH Agent stand-in with exactly the registry surface `createDshPortHost` uses. */
class FakeAgent {
  readonly tools = new Map<string, RegisteredTool>()
  readonly ctx = { tools: { register: (definition: RegisteredTool): (() => void) => {
    this.tools.set(definition.name, definition)
    return () => { this.tools.delete(definition.name) }
  } } }
}

interface RecordedCall {
  url: string
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
}

function jsonAnswer(value: unknown, status = 200): { ok: boolean; status: number; text(): Promise<string> } {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) }
}

/** A fetch that records every call and answers through `answer`; it may throw, like a dead transport. */
function recorder(answer: (call: RecordedCall) => ReturnType<typeof jsonAnswer>): {
  calls: RecordedCall[]
  fetch: DshPortFetch
} {
  const calls: RecordedCall[] = []
  const fetch: DshPortFetch = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return answer(call)
  }
  return { calls, fetch }
}

/** The host around a fake Agent runtime and one node root. */
function toolHost(fetch: DshPortFetch): { host: ReturnType<typeof createDshPortHost>
  agents: Map<string, FakeAgent> } {
  directory = mkdtempSync(join(tmpdir(), 'superagent-token-refresh-'))
  const root = join(directory, 'node')
  mkdirSync(root, { recursive: true })
  const agents = new Map<string, FakeAgent>()
  const sessions = {
    async ensure(sessionId: string) {
      const agent = new FakeAgent()
      agents.set(sessionId, agent)
      return agent
    },
    async prompt() {},
  }
  const context = { agents: { get: () => undefined }, workspaceRegistry: { async archiveSession() {} } }
  const host = createDshPortHost({ context, nodeRuntime: { sessions }, nodeId: 'node-1', root,
    controlUrl: BASE_URL, fetch })
  return { host, agents }
}

async function ensureWorker(host: ReturnType<typeof createDshPortHost>, token: string): Promise<void> {
  await host.ensureSession({ sessionId: 'worker-1', workspace: 'project-1', title: 'Worker ticket-1', role: 'worker',
    profile: WORKER_PROFILE, prompt: WORKER_PROFILE.prompt, sessionToken: token, ticketId: 'ticket-1', assignmentId: 'assignment-1' })
}

const EXEC = { signal: new AbortController().signal }

function report(tool: RegisteredTool): Promise<unknown> {
  return tool.execute({ ticketId: 'ticket-1', state: 'progress', summary: 'working' }, EXEC)
}

function isRefresh(call: RecordedCall): boolean {
  return call.url === `${BASE_URL}/v1/tools/token/refresh`
}

describe('node token refresh', () => {
  it('exchanges a token through the exported refresh helper', async () => {
    const { calls, fetch } = recorder(() => jsonAnswer({ token: 'next-token', expiresAt: '2026-01-01T00:10:00.000Z' }))

    await expect(refreshToken('http://control.test/', 'old-token', fetch)).resolves.toBe('next-token')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ url: 'http://control.test/v1/tools/token/refresh',
      init: { method: 'POST', headers: { authorization: 'Bearer old-token' } } })
  })

  it('rejects a refresh answer that carries no token', async () => {
    const { calls, fetch } = recorder(() => jsonAnswer({ expiresAt: '2026-01-01T00:10:00.000Z' }))

    await expect(refreshToken(BASE_URL, 'old-token', fetch)).rejects
      .toThrow('did not return a refreshed Session token')
    expect(calls).toHaveLength(1)
  })

  it('refreshes once on 401 and retries the same request with the new token', async () => {
    const { calls, fetch } = recorder(call => {
      if (isRefresh(call)) return jsonAnswer({ token: 'refreshed-token', expiresAt: '2026-01-01T00:10:00.000Z' })
      if (call.init.headers.authorization === 'Bearer expired-token') {
        return jsonAnswer({ error: 'session token has expired' }, 401)
      }
      return jsonAnswer({ ticket: { id: 'ticket-1' } })
    })
    const { host, agents } = toolHost(fetch)
    await ensureWorker(host, 'expired-token')

    await expect(report(agents.get('worker-1')!.tools.get('control_report')!))
      .resolves.toEqual({ ticket: { id: 'ticket-1' } })

    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatchObject({ url: `${BASE_URL}/v1/tools/worker/report`,
      init: { method: 'POST', headers: { authorization: 'Bearer expired-token' } } })
    // The refresh is a bodyless POST authorized by the stale token.
    expect(calls[1]).toMatchObject({ url: `${BASE_URL}/v1/tools/token/refresh`,
      init: { method: 'POST', headers: { authorization: 'Bearer expired-token' } } })
    expect(calls[1]!.init.body).toBeUndefined()
    expect(calls[1]!.init.headers['content-type']).toBeUndefined()
    // The retry is the original report, rebuilt with the new token.
    expect(calls[2]).toMatchObject({ url: `${BASE_URL}/v1/tools/worker/report`,
      init: { method: 'POST', headers: { authorization: 'Bearer refreshed-token' } } })
    expect(calls[0]!.init.headers.authorization).not.toBe(calls[2]!.init.headers.authorization)
    expect(JSON.parse(calls[2]!.init.body!)).toEqual({ ticketId: 'ticket-1', assignmentId: 'assignment-1',
      report: { state: 'progress', summary: 'working' } })

    // The refreshed token is current for the next tool call too: no second exchange.
    await expect(report(agents.get('worker-1')!.tools.get('control_report')!)).resolves.toEqual({ ticket: { id: 'ticket-1' } })
    expect(calls).toHaveLength(4)
    expect(calls[3]!.init.headers.authorization).toBe('Bearer refreshed-token')
  })

  it('propagates the original refusal when the refresh is refused, without retrying the tool', async () => {
    const { calls, fetch } = recorder(call => {
      if (isRefresh(call)) return jsonAnswer({ error: 'the token cannot be refreshed' }, 503)
      return jsonAnswer({ error: 'session token has expired' }, 401)
    })
    const { host, agents } = toolHost(fetch)
    await ensureWorker(host, 'expired-token')

    await expect(report(agents.get('worker-1')!.tools.get('control_report')!)).rejects
      .toThrow('session token has expired')
    // Exactly the refused tool call and one refresh attempt: the refresh is not retried and the tool is not re-sent.
    expect(calls).toHaveLength(2)
    expect(isRefresh(calls[1]!)).toBe(true)
  })

  it('propagates the original refusal when the refresh transport throws', async () => {
    const calls: RecordedCall[] = []
    const fetch: DshPortFetch = async (url, init) => {
      calls.push({ url, init })
      if (url === `${BASE_URL}/v1/tools/token/refresh`) throw new Error('control plane is offline')
      return jsonAnswer({ error: 'session token has expired' }, 401)
    }
    const { host, agents } = toolHost(fetch)
    await ensureWorker(host, 'expired-token')

    await expect(report(agents.get('worker-1')!.tools.get('control_report')!)).rejects
      .toThrow('session token has expired')
    expect(calls).toHaveLength(2)
  })

  it('does not refresh twice when the retry is refused with 401', async () => {
    const { calls, fetch } = recorder(call => {
      if (isRefresh(call)) return jsonAnswer({ token: 'refreshed-token' })
      return jsonAnswer({ error: 'session token has expired' }, 401)
    })
    const { host, agents } = toolHost(fetch)
    await ensureWorker(host, 'expired-token')

    await expect(report(agents.get('worker-1')!.tools.get('control_report')!)).rejects
      .toThrow('session token has expired')
    expect(calls).toHaveLength(3)
    expect(calls.filter(isRefresh)).toHaveLength(1)
    expect(calls[1]!.init.headers.authorization).toBe('Bearer expired-token')
    expect(calls[2]!.init.headers.authorization).toBe('Bearer refreshed-token')
  })

  it('does not refresh for a refusal that is not 401', async () => {
    const { calls, fetch } = recorder(() => jsonAnswer({ error: 'unknown ticket ticket-9' }, 400))
    const { host, agents } = toolHost(fetch)
    await ensureWorker(host, 'worker-token')

    await expect(report(agents.get('worker-1')!.tools.get('control_report')!)).rejects
      .toThrow('unknown ticket ticket-9')
    expect(calls).toHaveLength(1)
    expect(isRefresh(calls[0]!)).toBe(false)
  })

  it('adopts the token a session.message carries for the already registered tools', async () => {
    const { calls, fetch } = recorder(() => jsonAnswer({ ticket: { id: 'ticket-1' } }))
    const { host, agents } = toolHost(fetch)
    await ensureWorker(host, 'registered-token')
    const tool = agents.get('worker-1')!.tools.get('control_report')!

    // A node has no signing secret: the message token is adopted, not verified. The control plane verifies it later.
    await host.promptSession('worker-1', 'message-1', 'continue', 'message-token')
    await expect(report(tool)).resolves.toEqual({ ticket: { id: 'ticket-1' } })
    expect(calls[0]!.init.headers.authorization).toBe('Bearer message-token')
  })
})
