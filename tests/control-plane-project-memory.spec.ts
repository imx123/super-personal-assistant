/**
 * The Project page's own capabilities: a real Project, its PM, and the memory that Project's PM reads.
 *
 * A Project is created through the domain's own path and its PM through the node's own ensure; the console never creates
 * a Worker by hand. The memory is a note for one Project: it is written to the control plane's own file, only that
 * Project's PM reads it, and the PM reads a bounded slice of it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPlane } from '../src/control/control-plane.ts'
import { FetchControlPlaneServer as ControlPlaneServer } from './fixtures/fetch-servers.ts'
import { FakeNode } from '../src/node/fake-node.ts'

const SECRET = 'memory-secret'
const API_TOKEN = 'memory-api-token'
const START = '2026-01-01T00:00:00.000Z'

let directory = ''
let control: ControlPlane | undefined
let server: ControlPlaneServer | undefined
let node: FakeNode
let address = { url: '', port: 0 }

function post(path: string, body: unknown = {}, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function get(path: string, token = API_TOKEN): Promise<Response> {
  return fetch(`${address.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

/** A control plane with a node, listening on a random port. */
async function open(): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'superagent-memory-'))
  const root = join(directory, 'workspaces')
  node = new FakeNode({ nodeId: 'local', root, now: () => START })
  control = new ControlPlane({ dbPath: join(directory, 'control.sqlite'), nodeId: 'local', node, secret: SECRET,
    workspaceRoot: root, now: () => START, confirmationTimeoutMs: 50 })
  await control.registerNode()
  server = new ControlPlaneServer(control, { token: API_TOKEN })
  address = await server.listen(0)
}

/** Create a Project over the operator API and return its id. */
async function createProject(title: string): Promise<string> {
  const response = await post('/v1/console/projects', { title, goal: `${title} 的目标` })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { project: { id: string } }
  return body.project.id
}

/** The PM's own token, as the node holds it. */
function tokenOf(sessionId: string): string {
  const token = node.tokens.get(sessionId)
  if (!token) throw new Error(`No token for ${sessionId}`)
  return token
}

afterEach(async () => {
  await server?.close().catch(() => {})
  server = undefined
  await control?.close().catch(() => {})
  control = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('the Project page', () => {
  it('creates a real Project and starts its PM through the node', async () => {
    await open()
    const projectId = await createProject('控制台项目')

    // The Project is a domain fact, not a row in the console's own file.
    const project = control!.store.projects.get(projectId)
    expect(project).toMatchObject({ title: '控制台项目', status: 'active' })
    expect(project!.pmSessionId).not.toBe('')

    // The PM is ensured by the node, and the console reads the fact back.
    const started = await post(`/v1/projects/${projectId}/pm`)
    expect(started.status).toBe(200)
    const body = (await started.json()) as { session: { sessionId: string; role: string; status: string } }
    expect(body.session.sessionId).toBe(project!.pmSessionId)
    expect(body.session.role).toBe('pm')
    expect(node.commands.filter(command => command.type === 'pm.ensure')).toHaveLength(1)
  })

  it('keeps a Project memory and hands it to that Project\'s PM only', async () => {
    await open()
    const first = await createProject('第一个项目')
    const second = await createProject('第二个项目')

    const written = await post(`/v1/console/projects/${first}/memory`, { text: '客户要求周五之前上线' })
    expect(written.status).toBe(201)
    const body = (await written.json()) as { entry: { text: string; actor: string } }
    expect(body.entry.text).toBe('客户要求周五之前上线')
    expect(body.entry.actor).toBe('operator')

    const read = await get(`/v1/console/projects/${first}/memory`)
    expect(read.status).toBe(200)
    const entries = (await read.json()) as { entries: { text: string }[] }
    expect(entries.entries.map(entry => entry.text)).toEqual(['客户要求周五之前上线'])

    // The other Project keeps its own memory.
    const other = await get(`/v1/console/projects/${second}/memory`)
    const otherEntries = (await other.json()) as { entries: unknown[] }
    expect(otherEntries.entries).toHaveLength(0)

    // The PM of the first Project reads the note; the PM of the second one does not.
    await post(`/v1/projects/${first}/pm`)
    await post(`/v1/projects/${second}/pm`)
    const firstPm = control!.store.projects.get(first)!.pmSessionId
    const secondPm = control!.store.projects.get(second)!.pmSessionId

    const context = await fetch(`${address.url}/v1/tools/pm/context`,
      { headers: { authorization: `Bearer ${tokenOf(firstPm)}` } })
    const firstBody = (await context.json()) as { memory?: { text: string }[] }
    expect(firstBody.memory?.map(entry => entry.text)).toEqual(['客户要求周五之前上线'])

    const otherContext = await fetch(`${address.url}/v1/tools/pm/context`,
      { headers: { authorization: `Bearer ${tokenOf(secondPm)}` } })
    const otherBody = (await otherContext.json()) as { memory?: unknown[] }
    expect(otherBody.memory).toBeUndefined()
  })

  it('bounds the memory a PM reads and says so when it cuts a long entry', async () => {
    await open()
    const projectId = await createProject('长笔记')
    const long = 'x'.repeat(900)
    const written = await post(`/v1/console/projects/${projectId}/memory`, { text: long })
    expect(written.status).toBe(201)
    const body = (await written.json()) as { entry: { text: string } }
    expect(body.entry.text.length).toBeLessThan(long.length)
    expect(body.entry.text).toContain('已截断')

    // Only the newest entries are read: the PM sees a bounded slice, not the whole history.
    for (let index = 0; index < 25; index += 1) {
      await post(`/v1/console/projects/${projectId}/memory`, { text: `第 ${index} 条` })
    }
    await post(`/v1/projects/${projectId}/pm`)
    const pmSession = control!.store.projects.get(projectId)!.pmSessionId
    const context = await fetch(`${address.url}/v1/tools/pm/context`,
      { headers: { authorization: `Bearer ${tokenOf(pmSession)}` } })
    const contextBody = (await context.json()) as { memory?: { text: string }[] }
    expect(contextBody.memory).toHaveLength(20)
    expect(contextBody.memory?.[0]?.text).toBe('第 24 条')
  })

  it('refuses an empty memory entry and an unknown Project', async () => {
    await open()
    const projectId = await createProject('空笔记')
    expect((await post(`/v1/console/projects/${projectId}/memory`, { text: '   ' })).status).toBe(400)
    expect((await post('/v1/console/projects/does-not-exist/memory', { text: 'x' })).status).toBe(404)
  })
})
