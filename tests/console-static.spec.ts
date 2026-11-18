/**
 * The console's own files: the page the browser opens, and the bundle it runs.
 *
 * The page must be public — it holds no credential at all — and the bundle must be the built file, served from one
 * bounded directory. Nothing else of the package is reachable through the console's routes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const TOKEN = 'console-static-test-token'
const SECRET = 'console-static-test-secret'
const ROOT = join(import.meta.dirname, '..')

let directory = ''
let control: ControlPlane
let server: ControlPlaneServer | undefined
let assets = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-console-static-'))
  assets = join(directory, 'console')
  const node = new FakeNode({ nodeId: 'local', root: join(directory, 'workspaces') })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: join(directory, 'workspaces') })
  server = new ControlPlaneServer(control, { token: TOKEN, consoleDir: assets })
})

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('console static files', () => {
  it('serves the page without any credential and with a policy that allows only its own origin', async () => {
    mkdirSync(assets, { recursive: true })
    writeFileSync(join(assets, 'console.js'), 'export {}\n')
    const address = await server!.listen(0)
    const response = await fetch(`${address.url}/console`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const policy = response.headers.get('content-security-policy') ?? ''
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("connect-src 'self'")
    expect(policy).not.toContain('unsafe-eval')

    const page = await response.text()
    // The page is a shell: the browser is asked for the key itself, so nothing here is a secret.
    expect(page).toContain('/console/console.js')
    expect(page).not.toContain(TOKEN)
    expect(page).not.toContain(SECRET)
  })

  it('serves the built bundle from the console directory and refuses every other console path', async () => {
    mkdirSync(assets, { recursive: true })
    writeFileSync(join(assets, 'console.js'), 'export const console = true\n')
    const address = await server!.listen(0)

    const bundle = await fetch(`${address.url}/console/console.js`)
    expect(bundle.status).toBe(200)
    expect(bundle.headers.get('content-type')).toContain('text/javascript')
    expect(await bundle.text()).toContain('export const console')

    expect((await fetch(`${address.url}/console/other.js`)).status).toBe(404)
    expect((await fetch(`${address.url}/console/../package.json`)).status).toBe(404)
    expect((await fetch(`${address.url}/console/`)).status).toBe(200)
  })

  it('says the console was not built instead of serving an empty page', async () => {
    const address = await server!.listen(0)
    const page = await fetch(`${address.url}/console`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('尚未构建')

    const bundle = await fetch(`${address.url}/console/console.js`)
    expect(bundle.status).toBe(503)
    expect(await bundle.text()).not.toContain(TOKEN)
  })

  it('keeps the API routes behind the bearer token while the console page stays open', async () => {
    const address = await server!.listen(0)
    expect((await fetch(`${address.url}/console`)).status).toBe(200)
    expect((await fetch(`${address.url}/v1/state`)).status).toBe(401)
    expect((await fetch(`${address.url}/v1/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
  })

  it('is built as an entry of its own, into the one file the control plane serves', () => {
    // The bundle the control plane serves has to be a build product, not a file someone keeps by hand.
    const config = readFileSync(join(ROOT, 'tsdown.config.ts'), 'utf8')
    expect(config).toContain('src/console/index.tsx')
    expect(config).toContain('console.js')
    // The console's own source must not reach for anything outside its origin.
    for (const file of ['api.ts', 'app.tsx', 'pages.tsx', 'icons.tsx', 'markdown.tsx', 'preferences.ts',
      'settings.tsx', 'index.tsx']) {
      const source = readFileSync(join(ROOT, 'src', 'console', file), 'utf8')
      expect(source, file).not.toMatch(/https?:\/\//)
      expect(source, file).not.toContain('@deepseek-ai/')
    }
  })
})
