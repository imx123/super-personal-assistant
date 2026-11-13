/** Minimal domain composition for the standalone control-plane kernel. No DSH or Runtime dependency. */
import { Engine } from '../core/index.ts'
import type { Assessor, DomainEvent, Executor, OutboundMessage, Outbox, Policy, Repositories, ReplyStatus, SourceScope }
  from '../core/index.ts'

/** A deliberately simple Policy for the kernel: human triggers are explicit, inferred work is refused. */
export const kernelPolicy: Policy = {
  version: 'control-plane-kernel/v1',
  paused: false,
  gate: trigger => trigger.human
    ? { admissible: true, strength: 'explicit', basis: { via: 'listed', sender: trigger.actor.id } }
    : { admissible: false, reason: 'inferred work is not enabled in the kernel' },
  revalidate: () => true,
  admitsInferred: () => false,
  evalTimeoutMs: 120_000,
}

/** The kernel receives every Source trigger it is given; Source filtering belongs to the real control plane later. */
export const kernelScope: SourceScope = { scope: () => ({ listened: true, observed: false }) }

/** The kernel runs no Assessor; callers use Engine decisions directly. */
export const kernelAssessor: Assessor = { request: () => {} }

/** The kernel runs no Worker; execution is the node's responsibility. */
export const kernelExecutor: Executor = { start: () => {}, deliver: () => {}, stop: () => {} }

/** An in-memory Outbox so Engine replies are recorded without a Source or channel. */
export class KernelOutbox implements Outbox {
  private readonly messages = new Map<string, OutboundMessage>()
  private readonly statuses = new Map<string, ReplyStatus>()

  send(message: OutboundMessage): void {
    if (this.messages.has(message.id)) return
    this.messages.set(message.id, message)
    this.statuses.set(message.id, 'pending')
  }

  status(id: string): ReplyStatus | undefined { return this.statuses.get(id) }

  withdraw(id: string): void {
    if (!this.messages.has(id)) return
    this.statuses.set(id, 'dropped')
  }

  all(): OutboundMessage[] { return [...this.messages.values()] }
}

export interface KernelDomain {
  engine: Engine
  outbox: KernelOutbox
  events: DomainEvent[]
}

/**
 * Build the domain Engine for the standalone kernel. `kernelExecutor` keeps the domain usable without a node (tests and
 * state-only modes); a caller with an execution backend passes its own Executor, such as `NodeExecutor`.
 */
export function createKernelDomain(store: Repositories, now?: () => string, executor: Executor = kernelExecutor): KernelDomain {
  const events: DomainEvent[] = []
  const outbox = new KernelOutbox()
  const engine = new Engine({
    repo: store,
    policy: () => kernelPolicy,
    scope: kernelScope,
    assessor: kernelAssessor,
    executor,
    outbox,
    ...(now ? { now } : {}),
    emit: event => { events.push(event) },
  })
  return { engine, outbox, events }
}
