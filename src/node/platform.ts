/**
 * DSH-backed platform for the Runtime. This is the only place that turns the plugin's Cordis context into the runtime
 * seam, so `src/app/runtime.ts` never imports DSH: the context stays in this closure, and logging, HTTP registration,
 * node runtime construction, setup probes, archive events and session reads cross the boundary as narrow ports.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import { resolveRoleModel } from '../app/role-models.ts'
import { registerHttp } from '../app/http.ts'
import { workerProbe } from '../deployment.ts'
import { verifyEnvironment } from '../infra/environment.ts'
import { createDshNode } from './dsh-node.ts'
import type { RuntimePlatform } from './host.ts'

/** Builds the platform for one plugin fiber; its lifetime aborts when the host disposes that fiber. */
export function runtimePlatform(ctx: Context): RuntimePlatform {
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() })
  return {
    logger: ctx.logger,
    registerHttp: host => registerHttp(ctx, host),
    node: input => createDshNode({ ...input, context: ctx }),
    lifetime: lifetime.signal,
    probe: (stateDir, signal) => workerProbe(ctx.subprocess, stateDir, stateDir, signal),
    verifyEnvironment: (deployment, signal) => verifyEnvironment(deployment, ctx.subprocess, signal),
    resolveRoleModel: async model => { await resolveRoleModel(ctx, model) },
    // A waterfall listener that does not call next would block every other provider and the archive itself.
    onSessionActivity: listener => ctx.on('workspace/session-activity', (request, next) => {
      listener(String(request.sessionId))
      return next()
    }),
    onSessionStop: listener => ctx.on('workspace/session-stop', request => { listener(String(request.sessionId)) }),
    archivedSessionIds: () => {
      const registry = ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly string[] } | undefined
      return Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds : undefined
    },
    sessionEvents: async sessionId => (await ctx.sessionController.inspect(sessionId as SessionId)).events,
    modelCatalog: () => ctx.sessionController.modelCatalog(),
  }
}
