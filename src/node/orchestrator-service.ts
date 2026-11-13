/**
 * The `orchestrator` Cordis service Source plugins reach through `ctx.orchestrator`. Registering a Cordis service needs
 * DSH, so the wrapper lives on the node side and delegates every `SourceHost` method to the DSH-free Runtime.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Runtime } from '../app/runtime.ts'
import type { SourceContext, SourceHost } from '../sources/host.ts'

declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }

/** Exposes the DSH-free Runtime to Source plugins as the `orchestrator` service. */
export class OrchestratorService extends Service implements SourceHost {
  constructor(ctx: Context, private readonly runtime: Runtime) {
    super(ctx, 'orchestrator')
  }
  get sources() { return this.runtime.sources }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return this.runtime.context(kind) }
}
