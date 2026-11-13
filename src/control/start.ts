/**
 * Startup sequence of the standalone control plane: build the kernel and HTTP API, register with the node, then listen.
 *
 * It is separate from `main.ts` so a test can exercise a failed registration without spawning a process. A failed
 * registration closes both halves before the error escapes, and the process entry point turns that error into a
 * non-zero exit instead of a half-started API.
 */
import { join } from 'node:path'
import { FakeNode } from '../node/fake-node.ts'
import type { NodePort } from '../shared/protocol.ts'
import { ControlPlane, type ControlPlaneOptions } from './control-plane.ts'
import { HttpNodePort } from './http-node.ts'
import { ControlPlaneServer } from './server.ts'

export interface ControlPlaneStartOptions {
  /** Environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Test seam: use this node instead of one derived from the environment. */
  node?: NodePort
}

export interface StartedControlPlane {
  control: ControlPlane
  server: ControlPlaneServer
  address: { url: string; port: number }
  close(): Promise<void>
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function controlPort(env: Record<string, string | undefined>): number {
  const value = env.SUPERAGENT_CONTROL_PORT
  if (value === undefined || value === '') return 0
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('SUPERAGENT_CONTROL_PORT is invalid')
  return port
}

/** Build the kernel and server, register with the node, and only then start listening. */
export async function startControlPlane(options: ControlPlaneStartOptions = {}): Promise<StartedControlPlane> {
  const env = options.env ?? process.env
  const token = required(env, 'SUPERAGENT_CONTROL_TOKEN')
  const nodeId = env.SUPERAGENT_NODE_ID ?? 'local'
  const root = env.SUPERAGENT_NODE_ROOT ?? join(process.cwd(), '.superagent-control')
  const dbPath = env.SUPERAGENT_CONTROL_DB ?? join(root, 'control.sqlite')
  const workspaceRoot = env.SUPERAGENT_WORKSPACE_ROOT ?? join(root, 'workspaces')
  const host = env.SUPERAGENT_CONTROL_HOST ?? '127.0.0.1'
  const port = controlPort(env)

  const nodeUrl = env.SUPERAGENT_NODE_URL
  const node: NodePort = options.node ?? (nodeUrl
    ? new HttpNodePort({ url: nodeUrl, token: required(env, 'SUPERAGENT_NODE_TOKEN'), nodeId })
    : new FakeNode({ nodeId, root: workspaceRoot }))
  const controlOptions: ControlPlaneOptions = { dbPath, nodeId, node, secret: token, workspaceRoot }
  const control = new ControlPlane(controlOptions)
  const server = new ControlPlaneServer(control, { token, host })
  try {
    await control.registerNode()
    const address = await server.listen(port)
    let closed = false
    return {
      control,
      server,
      address,
      close: async () => {
        if (closed) return
        closed = true
        await server.close().catch(() => {})
        await control.close().catch(() => {})
      },
    }
  } catch (error) {
    // Fail closed: no API listener and no held database lock behind a process that could not register.
    await server.close().catch(() => {})
    await control.close().catch(() => {})
    throw error
  }
}
