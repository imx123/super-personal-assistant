/** What the node side may use from the control plane; it does not gain a second domain writer. */
import type { Effects } from '../app/effects.ts'
import type { Outbox } from '../app/outbox.ts'
import type { Store } from '../app/store.ts'
import type { Engine } from '../core/index.ts'
import type { ControlPlaneOwner } from './owner.ts'

/** The control-plane side of the in-process boundary. */
export interface ControlPlaneHost {
  readonly control: ControlPlaneOwner
  readonly store: Store
  readonly engine: Engine
  readonly effects: Effects
  readonly outbox: Outbox
}
