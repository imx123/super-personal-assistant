/**
 * DSH implementation of the node runtime: it builds `Sessions` and `DshExecutor` on the plugin's Cordis context and
 * exposes them through `NodeRuntime` only. Construction, startup, cancellation and teardown order live here, so the
 * control plane can hold a `NodeRuntime` and never a DSH `Context`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
// These augment DSH's `Context` with the services the app side names (`ctx.tools`, `ctx.skills`, ...); the imports are
// type-only and exist so the control-plane files need not name DSH themselves.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Sessions } from '../app/sessions.ts'
import { DshExecutor } from '../executor/dsh.ts'
import type { NodeRuntime, NodeRuntimeInput } from './host.ts'

/**
 * Builds the DSH-backed node runtime with the same constructors, inputs and steps `Runtime` used before the seam: the
 * control plane keeps the lifecycle, while this factory keeps everything DSH-specific on the node side.
 */
export function createDshNode(input: NodeRuntimeInput): NodeRuntime {
  const context = input.context as Context
  const sessions = new Sessions({ context, store: input.store, prompts: input.prompts, effects: input.effects,
    health: input.health.models, masterId: input.masterId, stateDir: input.stateDir, lifetime: input.lifetime,
    closing: input.closing, environment: input.environment, tools: input.tools })
  const executor = new DshExecutor({ context, get engine() { return input.engine() }, store: input.store,
    effects: input.effects, health: input.health.worker, machine: input.machine, lifetime: input.lifetime,
    cleanupTimeoutMs: input.cleanupTimeoutMs, sessions, closing: input.closing, paused: input.paused,
    environment: input.environment, sourceLink: input.sourceLink, repliedTo: input.repliedTo })
  /** The agents `cancelLoaded` stopped; `waitIdle` waits for their turns to settle before the Executor shuts down. */
  let canceled: Agent[] = []
  return {
    sessions,
    executor,
    install() { sessions.install(); executor.install() },
    resume() { executor.resume() },
    cancelLoaded(ids) {
      canceled = []
      const failures: unknown[] = []
      for (const id of ids) {
        const agent = context.agents.get(id as SessionId)
        if (!agent) continue
        canceled.push(agent)
        try { agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch (error) { failures.push(error) }
      }
      // Every loaded Session got its cancel; one failing still lets the rest stop.
      if (failures.length) throw failures[0]
    },
    waitIdle() { return Promise.allSettled(canceled.map(agent => agent.whenIdle())).then(() => {}) },
    stopExecutor() { return executor.shutdown() },
    disposeExecutor() { executor.dispose() },
    disposeSessions() { sessions.dispose() },
    flushPersistence() { return context.sessionPersistence.flush() },
    models() { return context.sessionController.modelCatalog() },
  }
}
