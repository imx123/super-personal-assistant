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
import { ControlPlaneServer, type ControlPlaneServerOptions } from './server.ts'

export interface ControlPlaneStartOptions {
  /** Environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Test seam: use this node instead of one derived from the environment. */
  node?: NodePort
  /**
   * Period of the node heartbeat this control plane starts after registering, in milliseconds; `0` disables the loop.
   * Tests shorten it to observe liveness transitions, and `ControlPlane.startHeartbeat` also accepts an override.
   */
  heartbeatMs?: number
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

/**
 * The bounded grace an expired Session token gets on the refresh route.
 *
 * Unset (or empty) keeps the kernel's explicit default. A configured value must be a non-negative whole number of seconds;
 * anything else fails startup before the kernel takes the database lock, because a typo must not silently turn the grace
 * off or into an unbounded one.
 */
function tokenRefreshGraceSeconds(env: Record<string, string | undefined>): number | undefined {
  const value = env.SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS
  if (value === undefined || value === '') return undefined
  // Whole digits only: a unit suffix, sign, exponent or fraction is a deployment typo, not a number to interpret loosely.
  if (!/^\d+$/.test(value)) throw new Error('SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS is invalid')
  const seconds = Number(value)
  if (!Number.isSafeInteger(seconds)) throw new Error('SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS is invalid')
  return seconds
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
  const refreshGraceSeconds = tokenRefreshGraceSeconds(env)

  const nodeUrl = env.SUPERAGENT_NODE_URL
  const node: NodePort = options.node ?? (nodeUrl
    ? new HttpNodePort({ url: nodeUrl, token: required(env, 'SUPERAGENT_NODE_TOKEN'), nodeId })
    : new FakeNode({ nodeId, root: workspaceRoot }))
  const controlOptions: ControlPlaneOptions = { dbPath, nodeId, node, secret: token, workspaceRoot,
    ...(refreshGraceSeconds === undefined ? {} : { sessionTokenRefreshGraceSeconds: refreshGraceSeconds }) }
  const control = new ControlPlane(controlOptions)
  // The viewer token is optional: unset (or empty), the API keeps exactly the single-token behaviour it always had.
  const serverOptions: ControlPlaneServerOptions = { token, host, viewerToken: env.SUPERAGENT_CONTROL_VIEWER_TOKEN }
  let server: ControlPlaneServer | undefined
  try {
    // Built inside the guarded block, so a refused configuration — a viewer token equal to the operator's — releases the
    // database lock the kernel already holds instead of leaving a half-started process behind.
    const api = new ControlPlaneServer(control, serverOptions)
    server = api
    // A node can restart between two heartbeats, so the reopened stream is the only warning that its in-memory Sessions
    // may be gone. Rotate the generation first (so the next delivery re-ensures), then refresh the liveness fact.
    if (node instanceof HttpNodePort) {
      node.onReconnect = () => {
        control.nodeReconnected()
        void control.heartbeat().catch(() => {})
      }
    }
    await control.registerNode()
    // Registration is the fail-fast gate; from here liveness is kept current by a beat the kernel owns and `close` clears.
    if (options.heartbeatMs !== 0) control.startHeartbeat(options.heartbeatMs)
    const address = await api.listen(port)
    let closed = false
    return {
      control,
      server: api,
      address,
      close: async () => {
        if (closed) return
        closed = true
        control.stopHeartbeat()
        await api.close().catch(() => {})
        await control.close().catch(() => {})
      },
    }
  } catch (error) {
    // Fail closed: no API listener and no held database lock behind a process that could not register.
    await server?.close().catch(() => {})
    await control.close().catch(() => {})
    throw error
  }
}
