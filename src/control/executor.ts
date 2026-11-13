/** Engine's Executor port over the control plane's NodePort: one Worker Session per Assignment. */
import type { Assignment, Executor, Ticket } from '../core/index.ts'

/**
 * What the Executor asks of the control plane. The callbacks keep this module free of a ControlPlane import, so the
 * domain and the standalone kernel can be composed without a dependency cycle.
 */
export interface NodeExecutorHost {
  /** Create the Worker Session for an Assignment; resolves with its control-plane Session id. */
  createWorkerSession(projectId: string, assignmentId: string, ticketId: string, prompt: string): Promise<{ sessionId: string }>
  /** Deliver one message to a Worker Session. */
  sendMessage(sessionId: string, text: string): Promise<void>
  /** Cancel a Worker Session's turn; a failure propagates to the caller that waits for the cleanup. */
  cancelSession(sessionId: string, reason: string): Promise<void>
  /** The Engine's fact that the Assignment runs. */
  assignmentStarted(ticketId: string, assignmentId: string): void
  /** The Engine's fact that launching or delivering to the Assignment failed. */
  assignmentFailed(ticketId: string, assignmentId: string, error: string): void
  /** The brief a Worker Session starts from: the Ticket, its task facts, and the source request. */
  taskPrompt(ticket: Ticket): string
  /** The Engine's fact that `inputIds` reached the Assignment's Worker Session. */
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void
  /** The Session id `createWorkerSession` gives this Assignment. */
  workerSessionId(ticketId: string, assignmentId: string): string
}

/**
 * The text of one delivery's Inputs. A trigger Input carries only an id here, so only the Inputs that hold text
 * (messages from the main Session and notes) can be joined; callers use a fallback when none does.
 */
function waitingText(ticket: Ticket, inputIds: readonly string[]): string | undefined {
  const byId = new Map(ticket.inputs.map(input => [input.id, input]))
  const texts = inputIds.flatMap(id => {
    const input = byId.get(id)
    return input && (input.kind === 'text' || input.kind === 'note') ? [input.text] : []
  })
  return texts.join('\n\n').trim() || undefined
}

/** The useful text of a failure, which the Engine records on the Ticket. */
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Sent when the waiting Inputs carry no text of their own, so the Worker still learns that there is new input. */
const NO_TEXT = 'New input for this Assignment'

/**
 * Executor for the standalone control plane: it maps the Engine's Assignment lifecycle calls onto the Worker Sessions that
 * a NodePort runs. The Engine calls these methods inside a domain transaction, so `start` and `deliver` begin their
 * asynchronous work without awaiting it; they report completion through `assignmentStarted` / `assignmentFailed` and never
 * hold the transaction open or throw into it.
 */
export class NodeExecutor implements Executor {
  /** Input ids a send has already started for an Assignment, so a second delivery in flight never repeats them. */
  private readonly sending = new Map<string, Set<string>>()

  constructor(private readonly host: NodeExecutorHost) {}

  /**
   * Create the Assignment's Worker Session without blocking the Engine transaction that queued it. A Ticket without a
   * Project cannot be executed by a node, so it fails explicitly instead of remaining pending.
   */
  start(ticket: Ticket, assignment: Assignment): void {
    const projectId = ticket.projectId
    if (!projectId) {
      this.fail(ticket.id, assignment.id, 'project required')
      return
    }
    try {
      // No await: the node round trip runs asynchronously, and its continuation, not this call, reports back.
      const prompt = this.host.taskPrompt(ticket)
      void this.host.createWorkerSession(projectId, assignment.id, ticket.id, prompt)
        .then(() => { this.host.assignmentStarted(ticket.id, assignment.id) })
        .catch(error => { this.fail(ticket.id, assignment.id, errorText(error)) })
    } catch (error) {
      this.fail(ticket.id, assignment.id, errorText(error))
    }
  }

  /**
   * Send the Inputs that still wait as one message. Only the current `ticket.undelivered` is read, and Inputs whose send
   * already started are left out: back-to-back notes produce two messages that never repeat one another. The Engine
   * clears exactly the ids of a successful send, so a later delivery never includes them again. A failure is recorded on
   * the Assignment and never becomes a synchronous exception inside the Engine transaction that asked for delivery.
   */
  deliver(ticket: Ticket, assignment: Assignment): void {
    const sending = this.sending.get(assignment.id) ?? new Set<string>()
    const inputIds = ticket.undelivered.filter(id => !sending.has(id))
    if (inputIds.length === 0) return
    for (const id of inputIds) sending.add(id)
    this.sending.set(assignment.id, sending)
    const text = waitingText(ticket, inputIds) ?? NO_TEXT
    const sessionId = this.host.workerSessionId(ticket.id, assignment.id)
    const settle = (): void => {
      for (const id of inputIds) sending.delete(id)
      if (sending.size === 0 && this.sending.get(assignment.id) === sending) this.sending.delete(assignment.id)
    }
    try {
      void this.host.sendMessage(sessionId, text)
        .then(() => {
          settle()
          // The message went out: record its Inputs before a later delivery can include them again. A host that cannot
          // record the fact must not turn a completed send into a failed Assignment.
          try { this.host.inputsDelivered(ticket.id, assignment.id, inputIds) } catch { /* delivery still happened */ }
        })
        .catch(error => {
          settle()
          this.fail(ticket.id, assignment.id, errorText(error))
        })
    } catch (error) {
      settle()
      this.fail(ticket.id, assignment.id, errorText(error))
    }
  }

  /** Cancel the Assignment's Worker Session; a failure propagates to the caller waiting for the Worker's cleanup. */
  async stop(ticket: Ticket, assignment: Assignment, reason: string): Promise<void> {
    await this.host.cancelSession(this.host.workerSessionId(ticket.id, assignment.id), reason)
  }

  /** Report a background failure without letting a host callback reject the promise chain it runs in. */
  private fail(ticketId: string, assignmentId: string, error: string): void {
    try {
      this.host.assignmentFailed(ticketId, assignmentId, error)
    } catch {
      // A host that cannot record the failure must not turn it into an unhandled rejection here.
    }
  }
}
