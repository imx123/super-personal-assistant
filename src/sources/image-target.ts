/**
 * DSH boundary for image reads: narrows the main Session's live `Agent` to the `ImageTarget` port SourceKinds read
 * through. This is the only place that touches the Agent's scoped services, its Session route, and its options.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ImageAttachments, ImageModels, ImageTarget } from './kind.ts'

/** The route header the main Session's latest request carries, narrowed to the provider and model an image read resolves. */
export interface ImageRoute {
  readonly config: { readonly provider?: string; readonly model?: string }
}

/**
 * The live Agent surface `imageTargetOf` narrows to `ImageTarget`: the agent-scoped Cordis services, the Session's
 * latest request route, and the selected route when no request header exists yet.
 */
export interface ImageAgent {
  /** Agent-scoped services; only the `attachments` and `llm` looked up here are read. */
  readonly ctx: { get(name: string): unknown }
  readonly session: { requestHeader(): ImageRoute | undefined }
  /** The Agent's selected provider/model route, which `session.requestHeader()` overrides once a request exists. */
  readonly options?: { readonly provider?: string; readonly model?: string }
}

/** DSH's live `Agent` is the surface `imageTargetOf` narrows; the default fails the typecheck if that shape drifts. */
export type NarrowedImageAgent<T extends ImageAgent = Agent> = T
/** DSH's attachment store and model runtime fill the port's two services; their defaults fail the typecheck on drift. */
export type NarrowedAttachments<T extends ImageAttachments = AttachmentStore> = T
export type NarrowedModels<T extends ImageModels = LlmRuntime> = T

/**
 * Narrows the main Session's Agent to the image port a SourceKind reads an image through. The Session's latest request
 * header wins over the Agent's selected options, so a Session that switched models reads its images with the new route.
 */
export function imageTargetOf(agent: ImageAgent): ImageTarget {
  const route = agent.session.requestHeader()?.config
  return {
    attachments: agent.ctx.get('attachments') as ImageTarget['attachments'],
    llm: agent.ctx.get('llm') as ImageTarget['llm'],
    provider: route?.provider ?? agent.options?.provider,
    model: route?.model ?? agent.options?.model,
  }
}
