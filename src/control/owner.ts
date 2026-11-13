/** The control plane's ownership of the domain Store and Engine. */
import { Store } from '../app/store.ts'
import { Engine, type EngineOptions } from '../core/index.ts'

export interface ControlPlaneOwnerOptions {
  /** SQLite file; the caller owns the state-directory lock. */
  dbPath: string
  /** Receives errors thrown by after-commit callbacks. */
  report?: (error: unknown) => void
}

/**
 * Owns the two objects that define domain authority: the Store and the Engine. A Runtime creates
 * this owner first, builds its node-side pieces, then attaches the Engine once its ports exist.
 */
export class ControlPlaneOwner {
  readonly store: Store
  private attached?: Engine

  constructor(options: ControlPlaneOwnerOptions) {
    this.store = new Store(options.dbPath, options.report)
  }

  /** Attach the Engine once its ports exist; only one Engine may own this Store. */
  attach(options: Omit<EngineOptions, 'repo'>): Engine {
    if (this.attached) throw new Error('The control plane already has an Engine')
    this.attached = new Engine({ ...options, repo: this.store })
    return this.attached
  }

  get engine(): Engine {
    if (!this.attached) throw new Error('The control plane Engine is not attached yet')
    return this.attached
  }

  /** Idempotent; the Store closes once. */
  close(): void { this.store.close() }
}
