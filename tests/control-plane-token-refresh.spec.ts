/**
 * P2-A: Session token lifetime, generation and the refresh endpoint.
 *
 * A token is a short-lived bearer credential whose generation advances on every refresh. Ordinary tool routes accept only
 * the current generation; the refresh route also accepts the one before it, so a node that missed a rotation can still
 * recover once. These tests exercise the real HTTP facade over a `ControlPlane` whose TTL is pinned short enough to measure.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket, Trigger } from '../src/core/index.ts'
import { ControlPlane, DEFAULT_TOKEN_REFRESH_GRACE_SECONDS } from '../src/control/control-plane.ts'
import { ControlPlaneServer } from '../src/control/server.ts'
import { startControlPlane } from '../src/control/start.ts'
import { FakeNode } from '../src/node/fake-node.ts'
import { issueSessionToken, SessionTokenError, verifySessionToken } from '../src/shared/session-token.ts'

const SECRET = 'refresh-secret'
const API_TOKEN = 'refresh-api-token'
const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'
const TTL = 120

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode

function trigger(id: string): Trigger {
  return { id, source: 'main-session', threads: [{ source: 'main-session', id: `thread-${id}` }],
    actor: { source: 'main-session', id: 'alice' }, human: true, at: START, text: 'Build it', meta: {} }
}

async function until(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Wait on the real clock until `verifySessionToken` refuses the token as expired; no fake timers, no guessing. */
async function untilExpired(token: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      verifySessionToken(token, SECRET)
    } catch (error) {
      if (error instanceof SessionTokenError && error.code === 'expired') return
      throw error
    }
    if (Date.now() > deadline) throw new Error('The one-second token never expired')
    await sleep(10)
  }
}

interface Opened {
  project: ProjectProfile
  pm: { sessionId: string }
  ticket: Ticket
  assignment: Assignment
  url: string
}

/** A Project whose PM and first Worker Session exist on the FakeNode, plus the tool API on a random port. */
async function open(ttl: number | null = TTL, grace?: number): Promise<Opened> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-refresh-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: NODE_ID, root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: NODE_ID, node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50,
    ...(ttl === null ? {} : { sessionTokenTtlSeconds: ttl }),
    ...(grace === undefined ? {} : { sessionTokenRefreshGraceSeconds: grace }) })
  await control.registerNode()
  control.store.triggers.save(trigger('trigger-1'))
  const project = control.createProject('trigger-1', 'Project', 'Goal')
  const pm = await control.openProject(project.id)
  const [created] = control.engine.createProjectTickets(project.id, pm.sessionId, [{ title: 'Ticket', goal: 'Do it' }])
  const assignment = created!.assignments[0]!
  await until(() => control!.store.tickets.get(created!.id)?.assignments.at(-1)?.state === 'running',
    'the Assignment did not start')
  const url = await listenToolServer()
  return { project, pm, ticket: control.store.tickets.get(created!.id)!, assignment, url }
}

/**
 * Listen on a port the fetch implementation accepts.
 *
 * The runtime's fetch refuses a small set of ports; an ephemeral port can land on one, which would make every request in a
 * test fail with `bad port`. A public health request over the new listener detects that and picks another port.
 */
async function listenToolServer(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    server = new ControlPlaneServer(control!, { token: API_TOKEN })
    const address = await server.listen(0)
    try {
      const health = await fetch(`${address.url}/health`)
      await health.text()
      if (health.ok) return address.url
    } catch {
      // The port was refused before any request reached the server: close and try another one.
    }
    await server.close()
    server = undefined
  }
  throw new Error('Could not listen on a port the fetch implementation accepts')
}

function tokenOf(sessionId: string): string {
  const token = node.tokens.get(sessionId)
  if (!token) throw new Error(`The FakeNode has no token for ${sessionId}`)
  return token
}

/**
 * Hand-issue a token for a real Session that expired `expiredSecondsAgo` seconds ago.
 *
 * Test scaffolding pins the record's `tokenVersion` and the token's `iat`/`exp` together, so an expiry case needs no sleep.
 * The refresh route still mints the next generation through the kernel with the control plane's normal TTL.
 */
function expiredTokenFor(sessionId: string, tokenVersion: number, expiredSecondsAgo: number): string {
  const record = control?.session(sessionId)
  if (!record) throw new Error(`The control plane has no Session ${sessionId}`)
  record.tokenVersion = tokenVersion
  const now = Math.floor(Date.now() / 1000)
  return issueSessionToken({ sid: record.sessionId, pid: record.projectId,
    ...(record.assignmentId === undefined ? {} : { aid: record.assignmentId }), role: record.role, backend: 'dsh',
    nodeId: NODE_ID, tv: tokenVersion }, SECRET, 60, now - 60 - expiredSecondsAgo)
}

function post(url: string, path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${url}${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

function get(url: string, path: string, token: string): Promise<Response> {
  return fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

function refresh(url: string, token: string): Promise<Response> {
  return post(url, '/v1/tools/token/refresh', token)
}

function secondsFromNow(exp: number): number {
  return exp - Math.floor(Date.now() / 1000)
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('Session token refresh', () => {
  it('refreshes a PM token, and the new token reads the PM context', async () => {
    const { project, pm, url } = await open()
    const original = tokenOf(pm.sessionId)

    const response = await refresh(url, original)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { token: string; expiresAt: string }
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBeGreaterThan(0)

    const claims = verifySessionToken(body.token, SECRET)
    // The refresh keeps every identity claim, advances the generation and rewinds the lifetime.
    expect(claims).toMatchObject({ sid: pm.sessionId, pid: project.id, role: 'pm', backend: 'dsh', nodeId: NODE_ID,
      tv: 1 })
    expect(claims.aid).toBeUndefined()
    expect(body.expiresAt).toBe(new Date(claims.exp * 1000).toISOString())
    expect(secondsFromNow(claims.exp)).toBeGreaterThan(TTL - 10)
    expect(secondsFromNow(claims.exp)).toBeLessThanOrEqual(TTL + 1)

    const context = await get(url, '/v1/tools/pm/context', body.token)
    expect(context.status).toBe(200)
    expect(((await context.json()) as { project: { id: string } }).project.id).toBe(project.id)
    // The token that was refreshed is no longer current and cannot open an ordinary tool route.
    expect((await get(url, '/v1/tools/pm/context', original)).status).toBe(401)
  })

  it('defaults a token lifetime to one hour', async () => {
    const { pm, url } = await open(null)

    const response = await refresh(url, tokenOf(pm.sessionId))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { token: string; expiresAt: string }
    const claims = verifySessionToken(body.token, SECRET)
    expect(secondsFromNow(claims.exp)).toBeGreaterThan(3590)
    expect(secondsFromNow(claims.exp)).toBeLessThanOrEqual(3601)
    expect(body.expiresAt).toBe(new Date(claims.exp * 1000).toISOString())
  })

  it('retires the previous token for tools but lets it refresh one more generation', async () => {
    const { pm, url } = await open()
    const first = tokenOf(pm.sessionId)
    expect(verifySessionToken(first, SECRET).tv).toBe(0)
    expect((await get(url, '/v1/tools/pm/context', first)).status).toBe(200)

    const firstRefresh = await refresh(url, first)
    expect(firstRefresh.status).toBe(200)
    const second = ((await firstRefresh.json()) as { token: string }).token
    // The generation is part of the signed payload, so even a same-second refresh cannot repeat the old token.
    expect(second).not.toBe(first)
    expect(verifySessionToken(second, SECRET).tv).toBe(1)
    expect(control!.session(pm.sessionId)?.tokenVersion).toBe(1)
    expect((await get(url, '/v1/tools/pm/context', second)).status).toBe(200)

    // A refreshed token is retired for ordinary tools immediately...
    expect((await get(url, '/v1/tools/pm/context', first)).status).toBe(401)

    // ...but it is the one previous generation, so it may rotate itself once more.
    const secondRefresh = await refresh(url, first)
    expect(secondRefresh.status).toBe(200)
    const third = ((await secondRefresh.json()) as { token: string }).token
    expect(verifySessionToken(third, SECRET).tv).toBe(2)
    expect(control!.session(pm.sessionId)?.tokenVersion).toBe(2)
    expect((await get(url, '/v1/tools/pm/context', third)).status).toBe(200)
    expect((await get(url, '/v1/tools/pm/context', second)).status).toBe(401)

    // Two generations behind is beyond the refresh grace: the earliest token is spent for every route.
    expect((await refresh(url, first)).status).toBe(401)

    // The second token is now the previous generation: refused for tools, allowed exactly one rotation.
    expect((await get(url, '/v1/tools/pm/context', second)).status).toBe(401)
    const thirdRefresh = await refresh(url, second)
    expect(thirdRefresh.status).toBe(200)
    const fourth = ((await thirdRefresh.json()) as { token: string }).token
    expect(verifySessionToken(fourth, SECRET).tv).toBe(3)
    expect(control!.session(pm.sessionId)?.tokenVersion).toBe(3)
    expect((await get(url, '/v1/tools/pm/context', fourth)).status).toBe(200)
  })

  it('passes the refreshed token to the node on the next session.message', async () => {
    const { pm, url } = await open()
    const response = await refresh(url, tokenOf(pm.sessionId))
    const body = (await response.json()) as { token: string }

    await control!.sendMessage(pm.sessionId, 'carry the current token')
    expect(node.commands.at(-1)).toMatchObject({ type: 'session.message', sessionId: pm.sessionId,
      text: 'carry the current token', sessionToken: body.token })
  })

  it('refreshes a Worker token too: the route is role-agnostic', async () => {
    const { ticket, assignment, url } = await open()
    const workerSession = `worker-${assignment.id}`
    const original = tokenOf(workerSession)

    const response = await refresh(url, original)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { token: string; expiresAt: string }
    const claims = verifySessionToken(body.token, SECRET)
    expect(claims).toMatchObject({ sid: workerSession, pid: ticket.projectId, role: 'worker', aid: assignment.id, tv: 1 })

    // The retired Worker token can no longer report.
    expect((await post(url, '/v1/tools/worker/report', original, { ticketId: ticket.id,
      report: { state: 'progress', summary: 'from the retired token' } })).status).toBe(401)

    const report = await post(url, '/v1/tools/worker/report', body.token, { ticketId: ticket.id,
      report: { state: 'progress', summary: 'still working after a refresh' } })
    expect(report.status).toBe(200)
    expect(control!.store.tickets.get(ticket.id)?.assignments.at(-1)?.report)
      .toMatchObject({ state: 'progress', summary: 'still working after a refresh' })
  })

  it('refuses a missing, malformed, operator, expired, mismatched or unknown-Session token', async () => {
    const { project, pm, url } = await open()
    const path = '/v1/tools/token/refresh'

    expect((await fetch(`${url}${path}`, { method: 'POST' })).status).toBe(401)
    expect((await post(url, path, 'not-a-token')).status).toBe(401)
    expect((await post(url, path, API_TOKEN)).status).toBe(401)

    const now = Math.floor(Date.now() / 1000)
    // Expired well beyond the default five-minute refresh grace: no route may accept it.
    const expired = issueSessionToken({ sid: pm.sessionId, pid: project.id, role: 'pm', backend: 'dsh', nodeId: NODE_ID },
      SECRET, 60, now - 3600)
    expect((await post(url, path, expired)).status).toBe(401)

    // Signed correctly, but for a Session this kernel does not own.
    const ghost = issueSessionToken({ sid: 'pm-ghost', pid: project.id, role: 'pm', backend: 'dsh', nodeId: NODE_ID },
      SECRET, 600)
    expect((await post(url, path, ghost)).status).toBe(401)

    // Signed correctly and naming a real Session, but with a different Project claim than the record.
    const mismatched = issueSessionToken({ sid: pm.sessionId, pid: 'project-other', role: 'pm', backend: 'dsh',
      nodeId: NODE_ID }, SECRET, 600)
    expect((await post(url, path, mismatched)).status).toBe(401)

    // The kernel method itself refuses a Session it does not know instead of minting a token for it.
    expect(() => control!.refreshToolToken('pm-ghost')).toThrow('known Session')
  })

  it('refreshes a token that really expired within the default grace, and the new generation opens tools', async () => {
    const { pm, url } = await open()
    const record = control!.session(pm.sessionId)!
    // A hand-issued one-second token: the expiry wait below is real, while the refresh still mints the normal TTL, so the
    // new token is not racing another one-second deadline.
    record.tokenVersion = 11
    const shortLived = issueSessionToken({ sid: record.sessionId, pid: record.projectId, role: 'pm', backend: 'dsh',
      nodeId: NODE_ID, tv: 11 }, SECRET, 1)

    expect((await get(url, '/v1/tools/pm/context', shortLived)).status).toBe(200)
    await untilExpired(shortLived)

    // The strict ordinary route is refused...
    expect((await get(url, '/v1/tools/pm/context', shortLived)).status).toBe(401)
    // ...but the refresh route's bounded grace rotates the now-expired token instead of stranding the Session.
    const response = await refresh(url, shortLived)
    expect(response.status).toBe(200)
    const next = ((await response.json()) as { token: string }).token
    expect(verifySessionToken(next, SECRET).tv).toBe(12)
    expect(control!.session(pm.sessionId)?.tokenVersion).toBe(12)
    expect((await get(url, '/v1/tools/pm/context', next)).status).toBe(200)
    // Refreshing does not resurrect the expired token for ordinary use.
    expect((await get(url, '/v1/tools/pm/context', shortLived)).status).toBe(401)
  })

  it('defaults the refresh grace to five minutes and admits a token expired within it', async () => {
    const { pm, url } = await open()
    expect(control!.tokenRefreshGraceSeconds).toBe(DEFAULT_TOKEN_REFRESH_GRACE_SECONDS)
    expect(DEFAULT_TOKEN_REFRESH_GRACE_SECONDS).toBe(300)

    const expired = expiredTokenFor(pm.sessionId, 4, 120)
    const response = await refresh(url, expired)
    expect(response.status).toBe(200)
    expect(verifySessionToken(((await response.json()) as { token: string }).token, SECRET).tv).toBe(5)
  })

  it('applies the configured grace only to refresh, and refuses a refresh beyond it', async () => {
    const { pm, url } = await open(TTL, 30)

    const withinGrace = expiredTokenFor(pm.sessionId, 2, 20)
    // The ordinary tool route is strict even though this token may still rotate itself.
    expect((await get(url, '/v1/tools/pm/context', withinGrace)).status).toBe(401)
    const response = await refresh(url, withinGrace)
    expect(response.status).toBe(200)
    const next = ((await response.json()) as { token: string }).token
    expect(verifySessionToken(next, SECRET).tv).toBe(3)
    expect((await get(url, '/v1/tools/pm/context', next)).status).toBe(200)
    expect((await get(url, '/v1/tools/pm/context', withinGrace)).status).toBe(401)

    // One second past the configured grace: the refresh route refuses it too, without echoing the token.
    const beyondGrace = expiredTokenFor(pm.sessionId, 9, 31)
    const refusal = await refresh(url, beyondGrace)
    expect(refusal.status).toBe(401)
    const body = (await refusal.json()) as { error: string }
    expect(body.error).toBe('session token has expired')
    expect(body.error).not.toContain(beyondGrace)
  })

  it('disables the grace at zero, while a live token still refreshes', async () => {
    const { pm, url } = await open(TTL, 0)
    expect(control!.tokenRefreshGraceSeconds).toBe(0)

    const expired = expiredTokenFor(pm.sessionId, 1, 1)
    expect((await refresh(url, expired)).status).toBe(401)

    const live = control!.refreshToolToken(pm.sessionId)
    expect((await refresh(url, live)).status).toBe(200)
  })

  it('reads SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS at startup and fails fast on an invalid value', async () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-refresh-'))
    const root = join(directory, 'workspaces')
    const env = { SUPERAGENT_CONTROL_TOKEN: API_TOKEN, SUPERAGENT_CONTROL_DB: join(directory, 'control.sqlite'),
      SUPERAGENT_WORKSPACE_ROOT: root, SUPERAGENT_NODE_ID: NODE_ID, SUPERAGENT_CONTROL_PORT: '0' }

    for (const value of ['soon', '-1', '1.5']) {
      const node = new FakeNode({ nodeId: NODE_ID, root, now: () => START })
      await expect(startControlPlane({ env: { ...env, SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS: value }, node }))
        .rejects.toThrow('SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS is invalid')
    }

    const started = await startControlPlane({ env: { ...env, SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS: '0' },
      node: new FakeNode({ nodeId: NODE_ID, root, now: () => START }), heartbeatMs: 0 })
    try {
      expect(started.control.tokenRefreshGraceSeconds).toBe(0)
    } finally {
      await started.close()
    }
  })
})

describe('verifySessionToken expiry grace', () => {
  const claims = { sid: 'pm-1', pid: 'project-1', role: 'pm', backend: 'dsh', nodeId: NODE_ID } as const

  it('is strict by default and bounded by allowExpiredSeconds', () => {
    const token = issueSessionToken(claims, SECRET, 60, 1000) // exp = 1060
    expect(verifySessionToken(token, SECRET, 1059).sid).toBe('pm-1')
    expect(() => verifySessionToken(token, SECRET, 1060)).toThrow('expired')

    // The grace boundary moves the invalid-at-`exp` rule, it does not remove it: expired-by-1 is admitted by grace 1,
    // expired-by-2 is not. A malformed grace is a configuration error, never "accept everything".
    expect(verifySessionToken(token, SECRET, 1060, { allowExpiredSeconds: 1 }).sid).toBe('pm-1')
    expect(() => verifySessionToken(token, SECRET, 1061, { allowExpiredSeconds: 1 })).toThrow('expired')
    expect(() => verifySessionToken(token, SECRET, 1061, { allowExpiredSeconds: Number.POSITIVE_INFINITY }))
      .toThrow('grace')
    expect(() => verifySessionToken(token, SECRET, 1061, { allowExpiredSeconds: -1 })).toThrow('grace')
  })
})
