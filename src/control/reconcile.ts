/**
 * The reconciliation of the Assignments this control plane manages against the Sessions the node really holds.
 *
 * A Worker Session can outlive the work it was created for: the Assignment ended, the Ticket was archived, the Project
 * was archived — and the node still runs the Worker. Nothing else notices: the domain says the work is over, the node
 * says a Session is alive, and the two never meet again. This reconciler is where they meet.
 *
 * It only ever acts on a Session this control plane created and still records, and only when the node itself confirms
 * that the Session is still there. A Session the node does not have is not killed, a Session whose creation is still in
 * flight is not touched, and a Session whose state the node cannot answer is left alone as well: the reconciler cleans up
 * what it can prove, and reports everything else.
 */
import type { SessionInspection, SessionRecord } from '../shared/protocol.ts'

/** The domain's facts about one Assignment. */
export interface ReconcileAssignment {
  /** The Assignment's own id. */
  id: string
  /** The Assignment's state; `ended` means the work it ran is over. */
  state: string
  /** The Ticket the Assignment belongs to. */
  ticketId: string
  /** The Project the Ticket belongs to. */
  projectId: string
  /** Whether the Ticket is archived. */
  ticketArchived: boolean
  /** Whether the Ticket has ended. */
  ticketEnded: boolean
}

/** The domain's facts about one Project. */
export interface ReconcileProject {
  /** The Project's own id. */
  id: string
  /** Its status: `active`, `paused`, `ended` or `archived`. */
  status: string
  /** The Session id of its PM. */
  pmSessionId: string
}

/** What the reconciler found about one Session. */
export interface ReconcileFinding {
  /** A stable id of the finding, so the same fact is recognised when it is found again. */
  id: string
  /**
   * What the finding is.
   *
   * `orphan-worker` is a Worker Session that still runs although its Assignment is over; `orphan-pm` is a PM Session of a
   * Project that is over; `missing-worker` is a Worker Session the node does not have although the domain still waits for
   * it; `unknown-status` is a Session whose creation is still in flight; `no-pm` is an active Project whose PM Session the
   * node does not have.
   */
  kind: 'orphan-worker' | 'orphan-pm' | 'missing-worker' | 'unknown-status' | 'no-pm'
  /** The Session the finding is about. */
  sessionId: string
  /** The Assignment it is about, when it is about one. */
  assignmentId?: string
  /** The Project it belongs to. */
  projectId: string
  /** What the reconciler did about it. */
  action: 'none' | 'stopped' | 'archived'
  /** How it ended. */
  outcome: 'ok' | 'failed' | 'reported'
  /** A short, redacted reason. */
  reason?: string
}

/** What one run of the reconciliation found. */
export interface ReconcileResult {
  /** When the run happened. */
  at: string
  /** Whether the node answered during the run. */
  nodeOnline: boolean
  /** How many Sessions the run looked at. */
  checked: number
  /** The findings of the run. */
  findings: ReconcileFinding[]
  /** How many of each kind the run found. */
  counts: { orphans: number; cleaned: number; failed: number; reported: number }
  /** What this reconciliation could not see, said plainly. */
  boundary: string
}

/**
 * What the reconciler needs from the control plane.
 *
 * The reconciler never touches the domain or the node itself: it reads facts and asks for cleanups, so the rules stay
 * here and the control plane keeps owning the domain.
 */
export interface ReconcileHost {
  /** The current time. */
  now(): string
  /** The Sessions this control plane manages. */
  sessions(): SessionRecord[]
  /** The domain's facts about one Assignment. */
  assignmentOf(assignmentId: string): ReconcileAssignment | undefined
  /** The domain's facts about one Project. */
  projectOf(projectId: string): ReconcileProject | undefined
  /** The node's own answer about one Session; undefined when the node cannot answer. */
  inspect(sessionId: string): Promise<SessionInspection | undefined>
  /** Whether the node is reachable right now. */
  nodeOnline(): boolean
  /**
   * Stop and archive one Session this control plane manages.
   *
   * The call is serialized with the Session's Ticket's other operations, so a cleanup never overlaps a re-dispatch of the
   * same Ticket.
   */
  cleanup(sessionId: string, reason: string): Promise<{ ok: boolean; reason?: string }>
  /** Record one finding in the audit trail. */
  audit(finding: ReconcileFinding): void
}

/**
 * What this reconciliation cannot see.
 *
 * The node protocol has no way to enumerate its Sessions, so the reconciler only knows the ones this control plane
 * created and still records. A Session the node holds from another source is outside its reach: the reconciler never
 * touches a workspace it does not know, and it says so instead of pretending the node is empty.
 */
export const RECONCILE_BOUNDARY = '节点协议没有会话枚举：本次对账只覆盖本控制面自己创建并记录的会话。'
  + '节点上来源不明的会话不在范围内，也不会被触碰。'

/** The status a Session is in while its creation is still in flight. */
const STARTING: ReadonlySet<string> = new Set(['starting'])

/**
 * The reconciliation itself.
 *
 * One run looks at every Session this control plane manages, asks the node about each of them, and decides what to do.
 * The decisions are conservative on purpose: only a Session the node confirms is still alive, and whose Assignment is
 * over, is cleaned up.
 */
export class Reconciler {
  constructor(private readonly host: ReconcileHost) {}

  /** Run one reconciliation and report what it found. */
  async run(): Promise<ReconcileResult> {
    const at = this.host.now()
    const sessions = this.host.sessions()
    // An offline node cannot confirm anything, so the whole run is skipped: no Session is touched and nothing is assumed.
    if (!this.host.nodeOnline()) {
      return { at, nodeOnline: false, checked: 0, findings: [], counts: { orphans: 0, cleaned: 0, failed: 0, reported: 0 },
        boundary: RECONCILE_BOUNDARY }
    }
    const findings: ReconcileFinding[] = []
    for (const session of sessions) {
      const inspection = await this.host.inspect(session.sessionId)
      findings.push(...await this.check(session, inspection))
    }
    const counts = {
      orphans: findings.filter(finding => finding.kind === 'orphan-worker' || finding.kind === 'orphan-pm').length,
      cleaned: findings.filter(finding => finding.outcome === 'ok' && finding.action !== 'none').length,
      failed: findings.filter(finding => finding.outcome === 'failed').length,
      reported: findings.filter(finding => finding.outcome === 'reported').length,
    }
    for (const finding of findings) this.host.audit(finding)
    return { at, nodeOnline: true, checked: sessions.length, findings, counts, boundary: RECONCILE_BOUNDARY }
  }

  /** What one Session's own facts say about it. */
  private async check(session: SessionRecord, inspection: SessionInspection | undefined): Promise<ReconcileFinding[]> {
    // The node could not answer: the state of this Session is unknown, so nothing may be done about it.
    if (!inspection) {
      return [this.finding(session, 'unknown-status', 'none', 'reported', '节点未返回会话状态')]
    }
    if (!inspection.found) {
      // The node does not have this Session. A Worker the domain still waits for is a missing Worker: it is reported and
      // never re-dispatched, because a re-dispatch is the PM's decision, not the reconciler's.
      if (session.role === 'worker') {
        const assignment = session.assignmentId ? this.host.assignmentOf(session.assignmentId) : undefined
        if (assignment && assignment.state !== 'ended') {
          return [this.finding(session, 'missing-worker', 'none', 'reported',
            '任务还在进行，节点找不到对应的 Worker 会话。是否重新分派由 PM 或操作员决定。')]
        }
      }
      return []
    }
    const status = inspection.status ?? ''
    if (STARTING.has(status)) {
      // The creation is still in flight: the Worker may still be coming up, and stopping it now would kill a Worker that
      // the domain has not even started to wait for.
      return [this.finding(session, 'unknown-status', 'none', 'reported', '会话正在启动')]
    }
    if (status === 'stopped' || status === 'archived') {
      // The node already stopped or archived this Session: it is not running, so there is nothing left to clean up.
      return []
    }
    if (session.role === 'worker') {
      const assignment = session.assignmentId ? this.host.assignmentOf(session.assignmentId) : undefined
      if (!assignment) return []
      const over = assignment.state === 'ended' || assignment.ticketArchived || assignment.ticketEnded
      if (!over) return []
      return [await this.cleanup(session, 'orphan-worker',
        `任务（${assignment.id}）已结束，Worker 会话仍在运行`)]
    }
    if (session.role === 'pm') {
      const project = this.host.projectOf(session.projectId)
      // Only a Project that is over for good: an archived Project may come back, and a PM that cannot be started again
      // would leave that Project without one.
      if (!project || project.status !== 'ended') return []
      return [await this.cleanup(session, 'orphan-pm',
        `PM 会话仍在运行，但它的项目（${session.projectId}）已经结束`)]
    }
    return []
  }

  /** Stop and archive one Session the node confirmed is still alive, and report how it ended. */
  private async cleanup(session: SessionRecord, kind: ReconcileFinding['kind'], reason: string): Promise<ReconcileFinding> {
    const outcome = await this.host.cleanup(session.sessionId, reason)
    return this.finding(session, kind, 'archived', outcome.ok ? 'ok' : 'failed',
      outcome.ok ? reason : (outcome.reason ?? reason))
  }

  /** One finding about one Session. */
  private finding(session: SessionRecord, kind: ReconcileFinding['kind'], action: ReconcileFinding['action'],
    outcome: ReconcileFinding['outcome'], reason: string): ReconcileFinding {
    return { id: `reconcile:${session.sessionId}:${kind}`, kind, sessionId: session.sessionId,
      ...(session.assignmentId === undefined ? {} : { assignmentId: session.assignmentId }),
      projectId: session.projectId, action, outcome, reason }
  }
}
