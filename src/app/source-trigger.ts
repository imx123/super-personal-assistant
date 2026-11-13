/** Looking up the Trigger that opened a Ticket, without any DSH dependency. */
import type { Ticket, Trigger } from '../core/index.ts'
import type { Store } from './store.ts'

/** The Trigger a Ticket came from; undefined when its origin Trigger is gone. */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)
