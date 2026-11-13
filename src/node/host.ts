/** The node side of the in-process boundary: what the control plane may construct and drive. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HttpHost } from '../app/http.ts'
import type { Store } from '../app/store.ts'
import type { Deployment, Probe } from '../deployment.ts'
import type { RoleModel } from '../policy.ts'
import type { Effects } from '../app/effects.ts'
import type { Prompts } from '../app/prompts.ts'
import type { SessionTarget, Sessions } from '../app/sessions.ts'
import type { Tool } from '../app/tools/tool.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Machine } from '../deployment.ts'
import type { Variable } from '../app/execution-environment.ts'
import type { Ticket, Trigger } from '../core/index.ts'
import type { DshExecutor, ExecutorHost } from '../executor/dsh.ts'

/** The node side of the in-process boundary; later this is replaced by a NodePort. */
export interface NodeHost {
  readonly sessions: Sessions
  readonly executor: DshExecutor
}

/**
 * Everything the node side needs to build its DSH runtime. The control plane hands this across the seam, so `context`
 * stays `unknown` and only `createDshNode` casts it to DSH's `Context`: no control-side file names DSH.
 */
export interface NodeRuntimeInput {
  /** The DSH Cordis context, typed as unknown so the control side does not import DSH. */
  context: unknown
  store: Store
  prompts: Prompts
  effects: Effects
  masterId: string
  stateDir: string
  machine: Pick<Machine, 'stateDir'>
  lifetime: AbortSignal
  cleanupTimeoutMs?: number
  closing(): boolean
  paused(): boolean
  environment(ticket: Ticket): Variable[]
  tools(agent: Agent, target: SessionTarget): Tool[]
  engine(): ExecutorHost['engine']
  sourceLink: ExecutorHost['sourceLink']
  repliedTo: ExecutorHost['repliedTo']
  health: { models: HealthEntry; worker: HealthEntry }
}

/**
 * The node runtime the control plane owns: DSH's Context, Sessions and Executor stay behind this interface, which also
 * fixes the startup, cancellation and shutdown order. The control plane never holds a DSH Context.
 */
export interface NodeRuntime {
  readonly sessions: Sessions
  readonly executor: DshExecutor
  install(): void
  resume(): void
  cancelLoaded(ids: readonly string[]): void
  waitIdle(): Promise<void>
  stopExecutor(): Promise<void>
  disposeExecutor(): void
  disposeSessions(): void
  flushPersistence(): Promise<void>
  models(): Promise<ModelCatalog>
}

export type NodeRuntimeFactory = (input: NodeRuntimeInput) => NodeRuntime

/**
 * What the host process hands the Runtime so the Runtime never imports DSH: logging, HTTP registration, the node runtime
 * factory, and narrow ports for everything the control-plane components need from DSH. The Cordis context stays inside
 * the platform closure. `lifetime` aborts when the host disposes the plugin; the Runtime links its own lifetime to it.
 */
export interface RuntimePlatform {
  readonly logger: { warn(format: unknown, ...param: unknown[]): void }
  registerHttp(host: HttpHost): () => void
  node(input: Omit<NodeRuntimeInput, 'context'>): NodeRuntime
  readonly lifetime: AbortSignal
  /** Probes CLIs the way worker shells run them, using `stateDir` as cwd and aborting with `signal`. */
  probe(stateDir: string, signal: AbortSignal): Probe
  /** Verifies that worker git invocations resolve the deployment's credential helper. */
  verifyEnvironment(deployment: Deployment, signal: AbortSignal): Promise<void>
  /** Resolves a configured model route through the live provider, rejecting an unavailable one. */
  resolveRoleModel(model: RoleModel): Promise<void>
  /** Registers a `workspace/session-activity` listener; the platform passes the waterfall through `next`. */
  onSessionActivity(listener: (sessionId: string) => void): () => void
  /** Registers a `workspace/session-stop` listener. */
  onSessionStop(listener: (sessionId: string) => void): () => void
  /** The host's durable archive set, or undefined when the host offers none. */
  archivedSessionIds(): readonly string[] | undefined
  /** The events of one DSH Session, for reading its transcript. */
  sessionEvents(sessionId: string): Promise<readonly SessionEvent[]>
  /** The host's model catalog. */
  modelCatalog(): Promise<ModelCatalog>
}
