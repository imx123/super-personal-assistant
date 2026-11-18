/**
 * The contract of the one resolver every coordination path goes through.
 *
 * Five paths reach a node: the dispatch of a Worker and the handoff of a request, the command on a Session and the
 * intervention in its turn, the report of a Worker or a PM, the digest of a stream and the review of a denial, and the
 * wake-up an external observation caused. All of them ask the same question before anything leaves this control plane:
 * may this target still be reached, and under which generations?
 *
 * The answer is a refusal with a reason, and the reason is what the console, the delivery record and the audit trail
 * read. There are six of them, and they are kept apart on purpose: a target that is gone, a target whose life was
 * replaced by a newer one, a target whose authority was withdrawn, a target a person stopped, a node that is not there
 * and a target that belongs to another machine are six different facts, and a report of one of them never stands for
 * another.
 *
 * The resolver is the one place these facts are read, so this file states them once. The paths that use it are checked
 * where they live: the coordination of the reports in `control-plane-coordination.spec.ts`, the recovery of the
 * deliveries in `control-plane-delivery-outbox.spec.ts`, the escalation of the denials in
 * `control-plane-denial-escalation.spec.ts`, the digests of a stream in `control-plane-stream-subscriptions.spec.ts` and
 * the wake-ups of an external event in `control-plane-event-subscriptions.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { Assignment, ProjectProfile, Ticket } from '../src/core/index.ts'
import { SingleNodeResolver, assignmentEpochOf, type NodeResolverHost } from '../src/control/node-resolver.ts'
import { NODE_CAPABILITY_TURN_INTERRUPT, type NodeStatus, type SessionRecord } from '../src/shared/protocol.ts'

const START = '2026-01-01T00:00:00.000Z'
const NODE_ID = 'local'
const BACKEND_ID = 'dsh'
const ROUTER = 'router'

/**
 * The records one resolution reads.
 *
 * The resolver owns no state: it answers from the control plane's own records, so a test here writes the records it
 * wants the answer to be read from. Every field a test changes is a fact the real control plane holds — a Session that
 * was revoked, a Ticket an operator stopped, an Assignment a newer one replaced.
 */
class World implements NodeResolverHost {
  readonly nodeId = NODE_ID
  readonly backendId = BACKEND_ID
  readonly sessions = new Map<string, SessionRecord>()
  readonly tickets = new Map<string, Ticket>()
  readonly projects = new Map<string, ProjectProfile>()
  /** The node's own status; absent while the node never registered. */
  status: NodeStatus | undefined = { nodeId: NODE_ID, backend: BACKEND_ID, version: '0.1.0', online: true, at: START,
    capabilities: [NODE_CAPABILITY_TURN_INTERRUPT] }
  /** The trust generation of the node. */
  trust = 1
  /** The lifecycle generation of a managed Session. */
  lifecycles = new Map<string, number>()

  session(sessionId: string): SessionRecord | undefined { return this.sessions.get(sessionId) }
  nodeStatus(): NodeStatus | undefined { return this.status }
  ticket(ticketId: string): Ticket | undefined { return this.tickets.get(ticketId) }
  ticketOfAssignment(assignmentId: string): Ticket | undefined {
    for (const ticket of this.tickets.values()) {
      if (ticket.assignments.some(item => item.id === assignmentId)) return ticket
    }
    return undefined
  }
  project(projectId: string): ProjectProfile | undefined { return this.projects.get(projectId) }
  routerSessionId(): string { return ROUTER }
  nodeTrustEpoch(): number { return this.trust }
  sessionLifecycleEpoch(sessionId: string): number { return this.lifecycles.get(sessionId) ?? 1 }

  /** The resolver over these records. */
  resolver(): SingleNodeResolver { return new SingleNodeResolver(this) }
}

function session(id: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectId: '', role: 'worker', nodeId: NODE_ID, workspace: '/work', status: 'idle',
    toolProfile: 'worker', createdAt: START, updatedAt: START, ...extra,
  }
}

function assignment(id: string, extra: Partial<Assignment> = {}): Assignment {
  return { id, state: 'running', createdAt: START, startedAt: START, ...extra }
}

function ticket(id: string, assignments: Assignment[], extra: Partial<Ticket> = {}): Ticket {
  return {
    id, title: 'Ticket', decisionId: 'd1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 's', id: 'a' },
      scope: '' },
    channels: [], assignments, inputs: [], undelivered: [], createdAt: START, updatedAt: START,
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
    ...extra,
  }
}

function project(id: string, extra: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    id, title: 'Project', goal: 'Goal', status: 'active', decisionId: 'd1', pmSessionId: `pm-${id}`,
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 's', id: 'a' },
      scope: '', projectId: id, goal: 'Goal' },
    createdAt: START, updatedAt: START,
    ...extra,
  }
}

/** The code a refusal carries, or undefined when the target was reached. */
function codeOf(result: { ok: true } | { ok: false; code: string }): string | undefined {
  return result.ok ? undefined : result.code
}

describe('the target that is gone', () => {
  it('refuses a Session the control plane does not hold', async () => {
    const world = new World()
    const result = await world.resolver().resolveForSession('worker-missing', 'message')
    expect(codeOf(result)).toBe('TARGET_NOT_FOUND')
    expect(result.ok ? '' : result.reason).toContain('worker-missing')
  })

  it('refuses a Worker whose Ticket has ended', async () => {
    const world = new World()
    world.tickets.set('t1', ticket('t1', [assignment('a1')], { ended: { at: START, by: 'human', outcome: 'closed' } }))
    world.sessions.set('worker-a1', session('worker-a1', { assignmentId: 'a1' }))
    const result = await world.resolver().resolveForAssignment('t1', 'a1', 'message')
    expect(codeOf(result)).toBe('TARGET_NOT_FOUND')
  })

  it('refuses a Worker whose Assignment has ended', async () => {
    const world = new World()
    world.tickets.set('t1', ticket('t1', [assignment('a1', { state: 'ended' })]))
    world.sessions.set('worker-a1', session('worker-a1', { assignmentId: 'a1' }))
    const result = await world.resolver().resolveForAssignment('t1', 'a1', 'message')
    expect(codeOf(result)).toBe('TARGET_NOT_FOUND')
  })

  it('refuses a PM whose Project has ended', async () => {
    const world = new World()
    world.projects.set('p1', project('p1', { status: 'ended' }))
    world.sessions.set('pm-p1', session('pm-p1', { role: 'pm', projectId: 'p1' }))
    const result = await world.resolver().resolveForSession('pm-p1', 'message')
    expect(codeOf(result)).toBe('TARGET_NOT_FOUND')
  })

  it('refuses a message to a Session that is stopped or archived', async () => {
    const world = new World()
    world.sessions.set('router', session(ROUTER, { role: 'router', status: 'archived' }))
    const result = await world.resolver().resolveForSession(ROUTER, 'message')
    expect(codeOf(result)).toBe('TARGET_NOT_FOUND')
  })
})

describe('the target whose life was replaced', () => {
  it('refuses a Worker whose Assignment a newer one replaced', async () => {
    const world = new World()
    world.tickets.set('t1', ticket('t1', [assignment('a1'), assignment('a2')]))
    world.sessions.set('worker-a1', session('worker-a1', { assignmentId: 'a1' }))
    const result = await world.resolver().resolveForAssignment('t1', 'a1', 'message')
    expect(codeOf(result)).toBe('STALE_GENERATION')
    expect(result.ok ? '' : result.reason).toContain('a2')
  })

  it('counts the Assignments a Ticket had, so a replaced Worker names a different generation', () => {
    const record = ticket('t1', [assignment('a1'), assignment('a2')])
    expect(assignmentEpochOf(record, 'a1')).toBe(1)
    expect(assignmentEpochOf(record, 'a2')).toBe(2)
    expect(assignmentEpochOf(record, 'missing')).toBe(0)
  })

  it('refuses a Worker Session that runs another Assignment', async () => {
    const world = new World()
    world.tickets.set('t1', ticket('t1', [assignment('a1'), assignment('a2')]))
    // The Session of the first Assignment holds the record of the second: the two do not match.
    world.sessions.set('worker-a2', session('worker-a2', { assignmentId: 'a1' }))
    const result = await world.resolver().resolveForAssignment('t1', 'a2', 'message')
    expect(codeOf(result)).toBe('OWNERSHIP_MISMATCH')
  })
})

describe('the target whose authority was withdrawn', () => {
  it('refuses a revoked Session', async () => {
    const world = new World()
    world.sessions.set('router', session(ROUTER, { role: 'router', revokedAt: START, revokedReason: '换人' }))
    const result = await world.resolver().resolveForSession(ROUTER, 'message')
    expect(codeOf(result)).toBe('PERMISSION_REVOKED')
  })

  it('lets the operator\'s own paths reach a revoked Session', async () => {
    const world = new World()
    world.sessions.set('router', session(ROUTER, { role: 'router', revokedAt: START }))
    const resolver = world.resolver()
    for (const op of ['stop', 'resume', 'reconcile'] as const) {
      expect(codeOf(await resolver.resolveForSession(ROUTER, op))).toBeUndefined()
    }
  })
})

describe('the target a person stopped', () => {
  it('refuses a Session an operator stopped', async () => {
    const world = new World()
    world.sessions.set('router', session(ROUTER, { role: 'router', operatorStop: { at: START, by: 'user', state: 'confirmed' } }))
    const result = await world.resolver().resolveForSession(ROUTER, 'message')
    expect(codeOf(result)).toBe('MANUALLY_STOPPED')
  })

  it('lets the operator\'s own paths reach a Session it stopped', async () => {
    const world = new World()
    world.sessions.set('router', session(ROUTER, { role: 'router', operatorStop: { at: START, by: 'user', state: 'confirmed' } }))
    const resolver = world.resolver()
    for (const op of ['stop', 'resume', 'reconcile'] as const) {
      expect(codeOf(await resolver.resolveForSession(ROUTER, op))).toBeUndefined()
    }
  })

  it('refuses a Worker whose Ticket an operator stopped', async () => {
    const world = new World()
    world.tickets.set('t1', ticket('t1', [assignment('a1')], { manualStop: { at: START, scope: 'worker', by: 'user' } }))
    world.sessions.set('worker-a1', session('worker-a1', { assignmentId: 'a1' }))
    const result = await world.resolver().resolveForAssignment('t1', 'a1', 'message')
    expect(codeOf(result)).toBe('MANUALLY_STOPPED')
  })

  it('refuses a Worker whose stop was never confirmed', async () => {
    const world = new World()
    world.tickets.set('t1', ticket('t1', [assignment('a1')],
      { stopFailure: { at: START, assignmentId: 'a1', error: 'the node did not answer' } }))
    world.sessions.set('worker-a1', session('worker-a1', { assignmentId: 'a1' }))
    const result = await world.resolver().resolveForAssignment('t1', 'a1', 'message')
    expect(codeOf(result)).toBe('MANUALLY_STOPPED')
  })

  it('refuses the PM of a hard paused Project, and reaches the PM of a soft paused one', async () => {
    const world = new World()
    world.projects.set('p1', project('p1', { status: 'paused', pauseMode: 'hard' }))
    world.sessions.set('pm-p1', session('pm-p1', { role: 'pm', projectId: 'p1' }))
    const resolver = world.resolver()
    expect(codeOf(await resolver.resolveForSession('pm-p1', 'message'))).toBe('MANUALLY_STOPPED')

    world.projects.set('p2', project('p2', { status: 'paused', pauseMode: 'soft' }))
    world.sessions.set('pm-p2', session('pm-p2', { role: 'pm', projectId: 'p2' }))
    expect(codeOf(await resolver.resolveForSession('pm-p2', 'message'))).toBeUndefined()
  })
})

describe('the node that is not there', () => {
  it('refuses a command that would leave for an offline node', async () => {
    const world = new World()
    world.status = { ...world.status!, online: false }
    world.sessions.set('router', session(ROUTER, { role: 'router' }))
    const result = await world.resolver().resolveForSession(ROUTER, 'message')
    expect(codeOf(result)).toBe('NODE_OFFLINE')
  })

  it('refuses the dispatch of a Worker while the node is offline', async () => {
    const world = new World()
    world.status = { ...world.status!, online: false }
    world.tickets.set('t1', ticket('t1', [assignment('a1')]))
    const result = await world.resolver().resolveForAssignment('t1', 'a1', 'dispatch')
    expect(codeOf(result)).toBe('NODE_OFFLINE')
  })

  it('lets an inbound callback through while the node is offline', async () => {
    const world = new World()
    world.status = { ...world.status!, online: false }
    world.tickets.set('t1', ticket('t1', [assignment('a1')]))
    world.sessions.set('worker-a1', session('worker-a1', { assignmentId: 'a1' }))
    // The callback has already arrived: the liveness of the other direction may not refuse it.
    const result = await world.resolver().resolveForAssignment('t1', 'a1', 'verify_callback')
    expect(codeOf(result)).toBeUndefined()
  })

  it('lets the operator\'s own paths through while the node is offline', async () => {
    const world = new World()
    world.status = { ...world.status!, online: false }
    world.sessions.set('router', session(ROUTER, { role: 'router' }))
    const result = await world.resolver().resolveForSession(ROUTER, 'stop')
    expect(codeOf(result)).toBeUndefined()
  })
})

describe('the target that belongs to another machine', () => {
  it('refuses a Session of another node', async () => {
    const world = new World()
    world.sessions.set('router', session(ROUTER, { role: 'router', nodeId: 'another-node' }))
    const result = await world.resolver().resolveForSession(ROUTER, 'message')
    expect(codeOf(result)).toBe('OWNERSHIP_MISMATCH')
  })

  it('refuses a PM that does not manage the Project it names', async () => {
    const world = new World()
    world.projects.set('p1', project('p1', { pmSessionId: 'pm-other' }))
    world.sessions.set('pm-p1', session('pm-p1', { role: 'pm', projectId: 'p1' }))
    const result = await world.resolver().resolveForSession('pm-p1', 'message')
    expect(codeOf(result)).toBe('OWNERSHIP_MISMATCH')
  })

  it('refuses an Assignment the named Ticket does not own', async () => {
    const world = new World()
    world.tickets.set('t1', ticket('t1', [assignment('a1')]))
    const result = await world.resolver().resolveForAssignment('t1', 'a2', 'dispatch')
    expect(codeOf(result)).toBe('OWNERSHIP_MISMATCH')
  })

  it('reaches a Worker Session whose Assignment the domain never gave out', async () => {
    const world = new World()
    // The nominal entry point and the older protocol tests name Assignments the domain never had. They are not work that
    // may be refused on a Ticket's account, so the Session itself is still reached.
    world.sessions.set('worker-a9', session('worker-a9', { assignmentId: 'a9' }))
    const result = await world.resolver().resolveForSession('worker-a9', 'message')
    expect(codeOf(result)).toBeUndefined()
    expect(result.ok ? result.generation.assignmentEpoch : undefined).toBe(0)
  })
})

describe('the generations the resolver answers with', () => {
  it('names the trust of the node, the life of the Assignment and the version of the credential', async () => {
    const world = new World()
    world.trust = 7
    world.tickets.set('t1', ticket('t1', [assignment('a1'), assignment('a2')]))
    world.sessions.set('worker-a2', session('worker-a2', { assignmentId: 'a2', tokenVersion: 3 }))
    const result = await world.resolver().resolveForAssignment('t1', 'a2', 'message')
    expect(result.ok).toBe(true)
    expect(result.ok ? result.generation : undefined).toEqual({ nodeTrustEpoch: 7, assignmentEpoch: 2, toolTokenVersion: 3 })
  })

  it('keeps a refresh of the credential out of the life of the Assignment', async () => {
    const world = new World()
    world.tickets.set('t1', ticket('t1', [assignment('a1')]))
    world.sessions.set('worker-a1', session('worker-a1', { assignmentId: 'a1', tokenVersion: 1 }))
    const resolver = world.resolver()
    const before = await resolver.resolveForAssignment('t1', 'a1', 'message')
    // The credential was refreshed: the Session lives on, and only the version of the credential moved.
    world.sessions.set('worker-a1', session('worker-a1', { assignmentId: 'a1', tokenVersion: 2 }))
    const after = await resolver.resolveForAssignment('t1', 'a1', 'message')
    expect(before.ok).toBe(true)
    expect(after.ok).toBe(true)
    if (!before.ok || !after.ok) return
    expect(before.generation.assignmentEpoch).toBe(after.generation.assignmentEpoch)
    expect(after.generation.toolTokenVersion).toBe(2)
  })
})

describe('the live snapshot of the node', () => {
  it('reports the one node as online with its capabilities', () => {
    const world = new World()
    const snapshot = world.resolver().getLiveNodeSnapshots()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({ nodeId: NODE_ID, isPrimary: true, connectionStatus: 'online' })
    expect(snapshot[0]?.backends[0]).toMatchObject({ backendId: BACKEND_ID, available: true })
    expect(snapshot[0]?.backends[0]?.capabilities.turnInterrupt).toBe(true)
    // The node protocol has no two-stage receipt: a message is known to be in the inbox, never known to have been read.
    expect(snapshot[0]?.backends[0]?.capabilities.twoStageReceipt).toBe(false)
  })

  it('reports the node as offline once it is recorded offline', () => {
    const world = new World()
    world.status = { ...world.status!, online: false }
    expect(world.resolver().getLiveNodeSnapshots()[0]).toMatchObject({ connectionStatus: 'offline' })
  })

  it('reports a node that never registered as reconnecting', () => {
    const world = new World()
    world.status = undefined
    expect(world.resolver().getLiveNodeSnapshots()[0]).toMatchObject({ connectionStatus: 'reconnecting' })
  })
})
