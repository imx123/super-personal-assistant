/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { DshNodePort } from './node/dsh-port.ts'
import { createDshPortHost } from './node/dsh-port-host.ts'
import { startNodeHttpServer } from './node/http-server.ts'
import { OrchestratorService } from './node/orchestrator-service.ts'
import { runtimePlatform } from './node/platform.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // The Runtime stays DSH-free: the platform hands it the Cordis-backed node runtime, and the service wrapper exposes it
  // to Source plugins as `ctx.orchestrator`.
  const runtime = new Runtime(runtimePlatform(ctx), machine, restart)
  new OrchestratorService(ctx, runtime)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
  await startNodeServer(ctx, runtime, machine.stateDir)
}

/**
 * Put a `NodePort` in front of the real DSH runtime when `SUPERAGENT_NODE_TOKEN` and `SUPERAGENT_NODE_PORT` are both set.
 *
 * Nothing listens, and no port is opened, when they are not: a deployment that does not run an execution node keeps the
 * plugin's existing behavior. The node root defaults to `<stateDir>/node`, and every workspace command must resolve
 * inside it, so a control plane must send workspaces under that root (or set `SUPERAGENT_NODE_ROOT`).
 */
async function startNodeServer(ctx: Context, runtime: Runtime, stateDir: string): Promise<void> {
  const token = process.env.SUPERAGENT_NODE_TOKEN
  const requested = process.env.SUPERAGENT_NODE_PORT
  if (!token || requested === undefined || requested === '') return
  const port = Number(requested)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('SUPERAGENT_NODE_PORT is invalid')
  // The node runtime only installs its Session decoration after setup; before that there is nothing to put a port in front of.
  if (!runtime.configured()) {
    ctx.logger.warn('dsh-superagent: SUPERAGENT_NODE_TOKEN and SUPERAGENT_NODE_PORT are set, but setup is pending, so the node server is not started')
    return
  }
  const nodeId = process.env.SUPERAGENT_NODE_ID ?? 'local'
  const host = process.env.SUPERAGENT_NODE_HOST ?? '127.0.0.1'
  const root = resolve(process.env.SUPERAGENT_NODE_ROOT ?? join(stateDir, 'node'))
  // The control plane's tool API lets this node's PM and Worker Sessions act on the external control plane instead of
  // the plugin's own Store. Without the URL the node registers no proxy tool and behaves exactly as before.
  const controlUrl = process.env.SUPERAGENT_CONTROL_URL
  const node = new DshNodePort({ nodeId, root,
    host: createDshPortHost({ context: ctx, nodeRuntime: runtime.nodeRuntime, nodeId, root,
      ...(controlUrl ? { controlUrl } : {}) }) })
  try {
    const server = await startNodeHttpServer({ node, token, host, port })
    ctx.effect(() => () => server.close().then(() => {}, (error: unknown) => {
      ctx.logger.warn('dsh-superagent could not close its node HTTP server: %s', String(error))
    }))
    ctx.logger.info(`dsh-superagent node ${nodeId} listening on ${server.url}`)
  } catch (error) {
    // The node facade is optional infrastructure: a busy port must not keep the plugin from starting.
    ctx.logger.error('dsh-superagent could not start its node HTTP server on %s:%s: %s', host, String(port), String(error))
  }
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
