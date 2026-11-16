import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlPlane, type StartedControlPlane } from '../src/control/start.ts'
import { readNodeEnvironment } from '../src/node/plugin.ts'
import type { DeploymentScope, DeploymentView } from '../src/shared/deployment.ts'

const initialKey = 'test-initial-control-key'
const viewerKey = 'test-initial-viewer-key'
const nextKey = 'test-rotated-control-key'
const nextNodeKey = 'test-rotated-node-key'
let root: string
let env: Record<string, string>
let running: StartedControlPlane | undefined

async function start(): Promise<void> {
  running = await startControlPlane({ env, heartbeatMs: 0 })
}

function request(path: string, token = initialKey, body?: unknown): Promise<Response> {
  return fetch(running!.address.url + path, { method: body === undefined ? 'GET' : 'PUT',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

const endpoint = (scope: DeploymentScope): string => '/v1/console/deployment/' + scope

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'superagent-deployment-'))
  const workspace = join(root, 'workspaces')
  env = { SUPERAGENT_CONTROL_TOKEN: initialKey, SUPERAGENT_CONTROL_VIEWER_TOKEN: viewerKey,
    SUPERAGENT_CONTROL_DB: join(root, 'state', 'control.sqlite'), SUPERAGENT_WORKSPACE_ROOT: workspace,
    SUPERAGENT_NODE_ROOT: workspace, SUPERAGENT_NODE_TOKEN: 'test-initial-node-key', SUPERAGENT_NODE_PORT: '4310' }
  await start()
})

afterEach(async () => {
  await running?.close()
  running = undefined
  rmSync(root, { recursive: true, force: true })
})

describe('standalone deployment settings', () => {
  it('stages a control-plane profile, hides credentials, and applies it only on restart', async () => {
    expect((await request(endpoint('control'), viewerKey)).status).toBe(403)
    expect((await request(endpoint('control'), viewerKey, {})).status).toBe(403)
    const view: DeploymentView = await (await request(endpoint('control'))).json()
    expect(view.values.SUPERAGENT_CONTROL_TOKEN).toBeUndefined()
    expect(view.credentials.SUPERAGENT_CONTROL_TOKEN).toBe(true)
    expect(JSON.stringify(view)).not.toContain(initialKey)

    const changes = { SUPERAGENT_CONTROL_TOKEN: nextKey, SUPERAGENT_CONTROL_VIEWER_TOKEN: '',
      SUPERAGENT_CONSOLE_EVENT_ROWS: '110', SUPERAGENT_SCHEDULER_OFFSET_MINUTES: '480' }
    const staged = await request(endpoint('control'), initialKey, { revision: view.revision, changes })
    expect(staged.status).toBe(200)
    const saved: DeploymentView = await staged.json()
    expect(JSON.stringify(saved)).not.toContain(nextKey)
    expect(saved.pending).toEqual(expect.arrayContaining(Object.keys(changes)))
    expect((await request(endpoint('control'), initialKey, { revision: view.revision, changes })).status).toBe(409)
    expect((await request('/v1/overview', nextKey)).status).toBe(401)
    expect(running!.control.runtimeSettings().schedulerOffsetMinutes).toBe(0)

    await running!.close()
    await start()
    expect((await request('/v1/overview')).status).toBe(401)
    expect((await request('/v1/overview', viewerKey)).status).toBe(401)
    const active = await request('/v1/overview', nextKey)
    expect(active.status).toBe(200)
    expect(await active.json()).toMatchObject({ retention: { eventRows: 110 } })
    expect(running!.control.runtimeSettings().schedulerOffsetMinutes).toBe(480)
    expect(await (await request(endpoint('control'), nextKey)).json()).toMatchObject({ pending: [] })
  })

  it('validates node fields and keeps operator credentials out of the file DSH reads', async () => {
    const view: DeploymentView = await (await request(endpoint('node'))).json()
    const save = (changes: unknown) => request(endpoint('node'), initialKey, { revision: view.revision, changes })
    expect((await save({ SUPERAGENT_CONTROL_TOKEN: nextKey })).status).toBe(400)
    expect((await save({ SUPERAGENT_NODE_URL: 'http://user:secret@127.0.0.1:4310' })).status).toBe(400)
    expect((await save({ SUPERAGENT_NODE_PORT: '65536' })).status).toBe(400)
    expect((await save({ SUPERAGENT_NODE_MODEL: 'deepseek-v4-pro' })).status).toBe(400)
    const saved = await save({ SUPERAGENT_NODE_PORT: '4320', SUPERAGENT_NODE_TOKEN: nextNodeKey,
      SUPERAGENT_NODE_MODEL_PROVIDER: 'opencode-go', SUPERAGENT_NODE_MODEL: 'deepseek-v4-pro' })
    expect(saved.status).toBe(200)
    expect(await saved.text()).not.toContain(nextNodeKey)
    expect(readFileSync(view.file, 'utf8')).not.toContain(initialKey)
    expect(readNodeEnvironment({ ...env, SUPERAGENT_NODE_DEPLOYMENT_FILE: view.file })).toMatchObject({
      port: 4320, token: nextNodeKey, defaultModel: { provider: 'opencode-go', model: 'deepseek-v4-pro' },
    })
    expect(readNodeEnvironment(env).port).toBe(4310)
  })

  it('keeps the default profile outside the node root even when the database is inside it', async () => {
    await running!.close()
    env.SUPERAGENT_CONTROL_DB = join(env.SUPERAGENT_NODE_ROOT!, 'control.sqlite')
    await start()
    const view: DeploymentView = await (await request(endpoint('control'))).json()
    expect(view.file).toBe(join(root, 'workspaces.superagent-private', 'control.json'))
    expect((await request(endpoint('control'), initialKey, { revision: view.revision,
      changes: { SUPERAGENT_CONSOLE_EVENT_ROWS: '500' } })).status).toBe(200)
  })
})
