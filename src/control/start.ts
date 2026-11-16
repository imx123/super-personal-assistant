/**
 * Startup sequence of the standalone control plane: build the kernel and HTTP API, register with the node, then listen.
 *
 * It is separate from `main.ts` so a test can exercise a failed registration without spawning a process. A failed
 * registration closes both halves before the error escapes, and the process entry point turns that error into a
 * non-zero exit instead of a half-started API.
 */
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { packagePath } from '../infra/paths.ts'
import { FakeNode } from '../node/fake-node.ts'
import type { NodePort } from '../shared/protocol.ts'
import { DeploymentError, DeploymentSettings } from '../shared/deployment.ts'
import { ControlPlane, type ControlPlaneOptions } from './control-plane.ts'
import { HttpNodePort } from './http-node.ts'
import { ControlPlaneServer, type ControlPlaneServerOptions } from './server.ts'
import { DEFAULT_AUDIT_DAYS, DEFAULT_EVENT_DAYS, DEFAULT_EVENT_ROWS } from './console-store.ts'

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

/**
 * The period of the periodic reconciliation, in milliseconds; `0` leaves it off.
 *
 * The loop is opt-in: a deployment that wants the orphan Sessions cleaned up on its own says so. What the loop may do is
 * decided by the evidence, not by the clock — only a Session the node confirms is still running although its Assignment is
 * over is ever touched.
 */
function reconcileIntervalMs(env: Record<string, string | undefined>): number {
  const value = env.SUPERAGENT_RECONCILE_INTERVAL_MS
  if (value === undefined || value === '') return 0
  if (!/^\d+$/.test(value)) throw new Error('SUPERAGENT_RECONCILE_INTERVAL_MS is invalid')
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647) {
    throw new Error('SUPERAGENT_RECONCILE_INTERVAL_MS is invalid')
  }
  return milliseconds
}

/**
 * Where the built console lives.
 *
 * The build puts the console's bundle in the package's own `lib` directory. A deployment that keeps it elsewhere says so;
 * a package whose manifest cannot be read still serves the API, it just has no console page to serve.
 */
function consoleDirectory(env: Record<string, string | undefined>): string {
  const configured = env.SUPERAGENT_CONSOLE_DIR
  if (configured !== undefined && configured !== '') return configured
  try {
    return packagePath('lib')
  } catch {
    return join(env.SUPERAGENT_NODE_ROOT ?? join(process.cwd(), '.superagent-control'), 'console')
  }
}

/**
 * The time base of the scheduled plans, as a fixed offset in minutes east of UTC.
 *
 * Unset means UTC. A named timezone would carry a daylight-saving rule, and a plan that fires at 03:30 on the day the
 * clocks change is a plan that surprises its operator, so the offset is fixed and shown in the console.
 */
function schedulerOffsetMinutes(env: Record<string, string | undefined>): number | undefined {
  const value = env.SUPERAGENT_SCHEDULER_OFFSET_MINUTES
  if (value === undefined || value === '') return undefined
  if (!/^-?\d+$/.test(value)) throw new Error('SUPERAGENT_SCHEDULER_OFFSET_MINUTES is invalid')
  const minutes = Number(value)
  if (!Number.isSafeInteger(minutes) || minutes < -720 || minutes > 840) {
    throw new Error('SUPERAGENT_SCHEDULER_OFFSET_MINUTES is invalid')
  }
  return minutes
}

/**
 * How often the scheduler looks for plans that came due, in milliseconds.
 *
 * Unset leaves the scheduler's own default; `0` keeps the plans in the file but never looks for them on its own, which is
 * a deployment that wants every plan to be run by hand.
 */
function schedulerTickMs(env: Record<string, string | undefined>): number | undefined {
  const value = env.SUPERAGENT_SCHEDULER_TICK_MS
  if (value === undefined || value === '') return undefined
  if (!/^\d+$/.test(value)) throw new Error('SUPERAGENT_SCHEDULER_TICK_MS is invalid')
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647) {
    throw new Error('SUPERAGENT_SCHEDULER_TICK_MS is invalid')
  }
  return milliseconds
}

function retentionNumber(env: Record<string, string | undefined>, name: string, minimum: number): number | undefined {
  const raw = env[name]
  if (!raw) return undefined
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > 1_000_000) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function deploymentSettings(base: Record<string, string | undefined>, hasSessions: () => boolean) {
  const root = base.SUPERAGENT_NODE_ROOT ?? join(process.cwd(), '.superagent-control')
  const db = resolve(base.SUPERAGENT_CONTROL_DB ?? join(root, 'control.sqlite'))
  const workspace = resolve(base.SUPERAGENT_WORKSPACE_ROOT ?? join(root, 'workspaces'))
  const nextToDatabase = join(dirname(db), '.superagent-private')
  const directory = base.SUPERAGENT_NODE_ROOT && inside(root, nextToDatabase)
    ? join(dirname(resolve(root)), `${basename(resolve(root))}.superagent-private`)
    : nextToDatabase
  const controlFile = resolve(base.SUPERAGENT_CONTROL_DEPLOYMENT_FILE || join(directory, 'control.json'))
  const nodeFile = resolve(base.SUPERAGENT_NODE_DEPLOYMENT_FILE || join(directory, 'node.json'))
  if (relative(controlFile, nodeFile) === '') throw new Error('Control and node deployment profiles must use different files')

  const privateFiles = (workspaceRoot: string, nodeRoot?: string): void => {
    if ([controlFile, nodeFile].some(file => inside(workspaceRoot, file) || (nodeRoot && inside(nodeRoot, file)))) {
      throw new DeploymentError(400, '部署文件必须放在工作区和执行节点根目录之外。请调整启动时的部署文件路径。')
    }
  }
  const checkControl = (env: typeof base): void => {
    const stores = [env.SUPERAGENT_CONTROL_DB!, env.SUPERAGENT_CONSOLE_DB!]
    if (relative(stores[0]!, stores[1]!) === '' || stores.some(path => [controlFile, nodeFile].some(file => relative(path, file) === ''))) {
      throw new DeploymentError(400, '两个数据库和部署文件必须使用不同的路径。')
    }
    if (env.SUPERAGENT_CONTROL_VIEWER_TOKEN && env.SUPERAGENT_CONTROL_VIEWER_TOKEN === env.SUPERAGENT_CONTROL_TOKEN) {
      throw new DeploymentError(400, '只读密钥必须与控制台连接密钥不同。')
    }
    const assets = env.SUPERAGENT_CONSOLE_DIR!
    if (relative(assets, consoleDirectory(base)) !== '' && !existsSync(join(assets, 'console.js'))) {
      throw new DeploymentError(400, '控制台构建目录中找不到 console.js。')
    }
  }

  const defaults = { ...base,
    SUPERAGENT_CONTROL_HOST: base.SUPERAGENT_CONTROL_HOST ?? '127.0.0.1',
    SUPERAGENT_CONTROL_PORT: String(controlPort(base)),
    SUPERAGENT_CONTROL_DB: db, SUPERAGENT_CONSOLE_DB: resolve(base.SUPERAGENT_CONSOLE_DB ?? join(dirname(db), 'console.sqlite')),
    SUPERAGENT_CONSOLE_DIR: resolve(consoleDirectory(base)), SUPERAGENT_WORKSPACE_ROOT: workspace,
    SUPERAGENT_CONSOLE_EVENT_ROWS: base.SUPERAGENT_CONSOLE_EVENT_ROWS || String(DEFAULT_EVENT_ROWS),
    SUPERAGENT_CONSOLE_EVENT_DAYS: base.SUPERAGENT_CONSOLE_EVENT_DAYS || String(DEFAULT_EVENT_DAYS),
    SUPERAGENT_CONSOLE_AUDIT_DAYS: base.SUPERAGENT_CONSOLE_AUDIT_DAYS || String(DEFAULT_AUDIT_DAYS),
    SUPERAGENT_SCHEDULER_OFFSET_MINUTES: base.SUPERAGENT_SCHEDULER_OFFSET_MINUTES || '0',
  }
  const nodeDefaults = { ...base, SUPERAGENT_NODE_HOST: base.SUPERAGENT_NODE_HOST ?? '127.0.0.1',
    SUPERAGENT_NODE_ID: base.SUPERAGENT_NODE_ID ?? 'local', SUPERAGENT_NODE_ROOT: base.SUPERAGENT_NODE_ROOT ?? '' }
  // Either form validates the resulting deployment against the other form's latest saved values.
  const control: DeploymentSettings = new DeploymentSettings('control', controlFile, defaults, false, env => {
    checkControl(env)
    if (hasSessions() && relative(control.active.SUPERAGENT_WORKSPACE_ROOT!, env.SUPERAGENT_WORKSPACE_ROOT!) !== '') {
      throw new DeploymentError(409, '当前数据库已有会话，更改工作区根目录需要先迁移现有会话。')
    }
    const nodePlan = node.view().values
    privateFiles(env.SUPERAGENT_WORKSPACE_ROOT!, nodePlan.SUPERAGENT_NODE_URL ? nodePlan.SUPERAGENT_NODE_ROOT : undefined)
  })
  const node: DeploymentSettings = new DeploymentSettings('node', nodeFile, nodeDefaults, Boolean(base.SUPERAGENT_NODE_DEPLOYMENT_FILE), env => {
    const workspaceRoot = control.view().values.SUPERAGENT_WORKSPACE_ROOT!
    privateFiles(workspaceRoot, env.SUPERAGENT_NODE_ROOT)
    if (hasSessions() && (env.SUPERAGENT_NODE_ID !== node.active.SUPERAGENT_NODE_ID
      || env.SUPERAGENT_NODE_ROOT !== node.active.SUPERAGENT_NODE_ROOT)) {
      throw new DeploymentError(409, '当前数据库已有会话，更改节点标识或根目录需要先迁移现有会话。')
    }
    if (env.SUPERAGENT_NODE_URL && !env.SUPERAGENT_NODE_TOKEN) {
      throw new DeploymentError(400, '使用真实节点地址时需要设置节点连接密钥。')
    }
    const hasModel = Boolean(env.SUPERAGENT_NODE_MODEL)
    if (hasModel !== Boolean(env.SUPERAGENT_NODE_MODEL_PROVIDER) || (!hasModel && env.SUPERAGENT_NODE_REASONING_EFFORT)) {
      throw new DeploymentError(400, '节点默认模型需要同时填写供应商和模型。使用节点 profile 默认值时请清空这三个字段。')
    }
  })
  return { control, node }
}

/** Build the kernel and server, register with the node, and only then start listening. */
export async function startControlPlane(options: ControlPlaneStartOptions = {}): Promise<StartedControlPlane> {
  const base = options.env ?? process.env
  let hasSessions = (): boolean => false
  const deployment = deploymentSettings(base, () => hasSessions())
  const env = { ...deployment.control.active, ...deployment.node.overrides }
  const token = required(env, 'SUPERAGENT_CONTROL_TOKEN')
  const nodeId = env.SUPERAGENT_NODE_ID ?? 'local'
  const root = env.SUPERAGENT_NODE_ROOT ?? join(process.cwd(), '.superagent-control')
  const dbPath = env.SUPERAGENT_CONTROL_DB ?? join(root, 'control.sqlite')
  // The console's own file: the event log with a sequence of its own and the audit trail. It sits beside the domain's
  // file and is never the same one, so the domain's schema stays what it always was.
  const consoleDbPath = env.SUPERAGENT_CONSOLE_DB ?? join(dirname(dbPath), 'console.sqlite')
  // Where the built console lives; the build puts it in the package's own `lib` directory.
  const consoleDir = consoleDirectory(env)
  const workspaceRoot = env.SUPERAGENT_WORKSPACE_ROOT ?? join(root, 'workspaces')
  const host = env.SUPERAGENT_CONTROL_HOST ?? '127.0.0.1'
  const port = controlPort(env)
  const refreshGraceSeconds = tokenRefreshGraceSeconds(env)
  const schedulerOffset = schedulerOffsetMinutes(env)
  const schedulerTick = schedulerTickMs(env)
  const eventRows = retentionNumber(env, 'SUPERAGENT_CONSOLE_EVENT_ROWS', 1)
  const eventDays = retentionNumber(env, 'SUPERAGENT_CONSOLE_EVENT_DAYS', 0)
  const auditDays = retentionNumber(env, 'SUPERAGENT_CONSOLE_AUDIT_DAYS', 0)

  const nodeUrl = env.SUPERAGENT_NODE_URL
  const node: NodePort = options.node ?? (nodeUrl
    ? new HttpNodePort({ url: nodeUrl, token: required(env, 'SUPERAGENT_NODE_TOKEN'), nodeId })
    : new FakeNode({ nodeId, root: workspaceRoot }))
  const controlOptions: ControlPlaneOptions = { dbPath, consoleDbPath, nodeId, node, secret: token, workspaceRoot,
    reconcileIntervalMs: reconcileIntervalMs(env),
    ...(eventRows === undefined ? {} : { consoleEventRows: eventRows }),
    ...(eventDays === undefined ? {} : { consoleEventDays: eventDays }),
    ...(auditDays === undefined ? {} : { consoleAuditDays: auditDays }),
    ...(refreshGraceSeconds === undefined ? {} : { sessionTokenRefreshGraceSeconds: refreshGraceSeconds }),
    ...(schedulerOffset === undefined ? {} : { schedulerTimeZoneOffsetMinutes: schedulerOffset }),
    ...(schedulerTick === undefined ? {} : { schedulerTickMs: schedulerTick }) }
  const control = new ControlPlane(controlOptions)
  hasSessions = () => control.sessions.size !== 0
  // The viewer token is optional: unset (or empty), the API keeps exactly the single-token behaviour it always had.
  const serverOptions: ControlPlaneServerOptions = { token, host, consoleDir, deployment,
    viewerToken: env.SUPERAGENT_CONTROL_VIEWER_TOKEN }
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
    // The orphan reconciliation runs on its own only when the deployment asks for it; the console can always run it by hand.
    control.startReconcile()
    // The scheduler looks for the plans that came due. It is started after the registration, because a plan needs a node to
    // deliver to, and it is stopped before the database closes.
    control.startScheduler()
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
        control.stopReconcile()
        // The order matters: the API stops first, so no new request arrives; the scheduler stops next, so a delivery still
        // in flight is finished and written down; the kernel closes last, and it is what closes the database.
        await api.close().catch(() => {})
        await control.stopScheduler().catch(() => {})
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
