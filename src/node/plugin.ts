/**
 * The node-only plugin entry: an execution node that runs inside its own DSH profile.
 *
 * It mounts nothing but the node facade — no `Runtime`, Store, Engine, Sources, panel, Web app or `sessionController`.
 * Every value it needs comes from the environment, and a missing or unusable one fails the plugin (and therefore the DSH
 * startup) instead of degrading quietly: a node that cannot listen must not look healthy to a control plane. DSH's own
 * SIGTERM/SIGINT disposes the plugin tree, which closes the listener through the effect registered here.
 */
import { mkdirSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// These augment DSH's `Context` with the services the host and the Sessions adapter use; imports are type-only.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { resolveRoleModel } from '../app/role-models.ts'
import type { RoleModel } from '../policy.ts'
import { loadDeployment } from '../shared/deployment.ts'
import { NODE_CAPABILITY_TURN_INTERRUPT } from '../shared/protocol.ts'
import { DshNodePort } from './dsh-port.ts'
import { createDshPortHost } from './dsh-port-host.ts'
import { startNodeHttpServer } from './http-server.ts'
import { createNodeSessions } from './node-sessions.ts'

export const name = 'dsh-superagent-node'

/**
 * The services a node-only profile must provide before this plugin activates (docs/013 §1.2, verified against DSH
 * 0.2.2-rc.1). It deliberately omits `sessionController`, `fileUploads` and `webServer`: those belong to the Web app.
 */
export const inject = ['agents', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools',
  'systemPrompt', 'skills', 'subprocess', 'llm', 'agentDefaultModel', 'agentPresets']

/** Everything the node process reads from its environment. */
export interface NodeEnvironment {
  /** Bearer token the control plane must present on `/commands`. */
  token: string
  /** Port to listen on; `0` asks the operating system for a free one. */
  port: number
  host: string
  nodeId: string
  /** Absolute node root; every Session workspace must resolve inside it. */
  root: string
  /** Base URL of an independent control plane, when this node has one to register its proxy tools against. */
  controlUrl?: string
  defaultModel?: RoleModel
}

/**
 * Reads and validates the node environment.
 *
 * Fail-fast on purpose (P2-F): the token, the port and the root are the node's identity and reach, so a deployment that
 * forgot one must not start listening. A relative root is refused because it would make workspace containment depend on
 * whatever working directory DSH was started from.
 */
export function readNodeEnvironment(base: NodeJS.ProcessEnv = process.env): NodeEnvironment {
  const file = base.SUPERAGENT_NODE_DEPLOYMENT_FILE
  const env = file ? { ...base, ...loadDeployment('node', resolve(file)).values } : base
  const token = env.SUPERAGENT_NODE_TOKEN?.trim()
  if (!token) throw new Error('SUPERAGENT_NODE_TOKEN is required to start a dsh-superagent node')
  const requestedPort = env.SUPERAGENT_NODE_PORT?.trim()
  if (!requestedPort) throw new Error('SUPERAGENT_NODE_PORT is required to start a dsh-superagent node')
  const port = Number(requestedPort)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`SUPERAGENT_NODE_PORT is invalid: ${requestedPort}`)
  }
  const requestedRoot = env.SUPERAGENT_NODE_ROOT?.trim()
  if (!requestedRoot) throw new Error('SUPERAGENT_NODE_ROOT is required to start a dsh-superagent node')
  if (!isAbsolute(requestedRoot)) throw new Error(`SUPERAGENT_NODE_ROOT must be an absolute path: ${requestedRoot}`)
  const controlUrl = env.SUPERAGENT_CONTROL_URL?.trim() || undefined
  if (controlUrl !== undefined) {
    const parsed = new URL(controlUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`SUPERAGENT_CONTROL_URL must be an http(s) URL: ${controlUrl}`)
    }
  }
  const provider = env.SUPERAGENT_NODE_MODEL_PROVIDER?.trim()
  const model = env.SUPERAGENT_NODE_MODEL?.trim()
  const reasoningEffort = env.SUPERAGENT_NODE_REASONING_EFFORT?.trim()
  if (Boolean(provider) !== Boolean(model) || (!model && reasoningEffort)) {
    throw new Error('A node default model requires both provider and model')
  }
  return {
    token,
    port,
    host: env.SUPERAGENT_NODE_HOST?.trim() || '127.0.0.1',
    nodeId: env.SUPERAGENT_NODE_ID?.trim() || 'local',
    root: resolve(requestedRoot),
    ...(controlUrl === undefined ? {} : { controlUrl }),
    ...(provider && model ? { defaultModel: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } } : {}),
  }
}

/**
 * Starts the node's HTTP facade over real DSH Sessions.
 *
 * A rejected environment, a busy port or a failing `listen` rejects this plugin, so the profile starts without a node
 * rather than with a half-configured one. The only startup line names the URL the node listens on.
 */
export async function apply(ctx: Context): Promise<void> {
  const environment = readNodeEnvironment()
  if (environment.defaultModel) await resolveRoleModel(ctx, environment.defaultModel)
  mkdirSync(environment.root, { recursive: true, mode: 0o700 })
  // The node's own lifetime: a delivery already in flight is cancelled when DSH disposes this plugin.
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() })
  const node = new DshNodePort({ nodeId: environment.nodeId, root: environment.root,
    host: createDshPortHost({ context: ctx, nodeRuntime: { sessions: createNodeSessions(ctx, { signal: lifetime.signal,
      ...(environment.defaultModel ? { defaultModel: environment.defaultModel } : {}) }) },
      nodeId: environment.nodeId, root: environment.root,
      // The node can end one running turn of one Session and keep the rest of it, so it says so: the control plane
      // asks a node that cannot do it instead of pretending the turn ended.
      capabilities: [NODE_CAPABILITY_TURN_INTERRUPT],
      ...(environment.controlUrl === undefined ? {} : { controlUrl: environment.controlUrl }) }) })
  const server = await startNodeHttpServer({ node, token: environment.token, host: environment.host,
    port: environment.port })
  ctx.effect(() => () => server.close().then(() => {}, (error: unknown) => {
    ctx.logger.warn('dsh-superagent-node could not close its HTTP server: %s', String(error))
  }))
  ctx.logger.info(`dsh-superagent node listening on ${server.url}`)
}
