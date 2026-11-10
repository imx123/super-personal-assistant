/** The internal Source: Triggers a Project's PM delegates to its own Tickets, with no channel, poll, health or context reader. */
import { z } from 'zod'
import type { SourceKind } from './kind.ts'

/** Stable Source ID of the internal delegation entry. */
export const INTERNAL_SOURCE = 'internal'

/**
 * A built-in Source kind for the Triggers a Project PM creates when it delegates a Ticket. It has no configuration, no
 * outbound Channel and no polling: the Engine records one Trigger per delegated Ticket, and its Thread is the Trigger's own.
 * Its `scope` always listens, since the Engine authorizes a delegated Ticket through the PM Mandate, not through the gate.
 */
export const internalKind: SourceKind = {
  kind: INTERNAL_SOURCE,
  title: { zh: '内部派工', en: 'Internal dispatch' },
  description: {
    zh: '项目 PM 为自己项目内的工单登记的派工事件。它不是轮询来源，也没有对外渠道：每条内部触发只对应一条 Project Ticket，并由 Project 的 PM 授权。',
    en: 'Dispatch events a Project PM records for its own Project Tickets. It neither polls nor has an outbound channel: each internal Trigger corresponds to one Project Ticket and is authorized by the Project\'s PM.',
  },
  schema: z.object({}).strict(),
  fields: [],
  health: [],
  /** The Engine records these Triggers itself; nothing external can be filtered out of them. */
  scope: () => ({ listened: true, observed: false }),
}
