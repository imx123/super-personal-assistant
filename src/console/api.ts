/**
 * The console's own HTTP client.
 *
 * A verified key is kept in tab-scoped sessionStorage so a reload can reconnect. Requests carry it as a bearer header.
 *
 * The event stream is read with `fetch` rather than `EventSource`, because `EventSource` cannot carry a bearer token. A
 * stream that ends is opened again from the last sequence it delivered, with a growing pause between the attempts.
 */

/** A request that failed, with the status the control plane answered. */
export class ConsoleApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ConsoleApiError'
  }
}

/** One event of the control plane's stream. */
export interface StreamEvent {
  seq: number
  type: string
  at: string
  nodeId: string
  sessionId: string
  projectId: string
}

/** The counts the console's home page shows. */
export interface Overview {
  at: string
  runningTickets: number
  runningWorkers: number
  pendingReviews: number
  features: { router: boolean; schedules: boolean }
  /** What the scheduler holds; the failure count is the number of plans whose last run failed. */
  schedules: ScheduleCounts
  counts: { projects: number; tickets: number; sessions: number; nodes: number }
  nodes: NodeView[]
  events: { seq: number; retained: number }
  audit: { entries: number }
  retention: { eventDays: number; eventRows: number; auditDays: number }
}

/** One scheduled plan, as the console reads it. */
export interface SchedulePlan {
  id: string
  projectId: string
  projectTitle: string
  projectStatus: string
  name: string
  /** The rule as the operator wrote it. */
  rule: string
  /** The same rule in words a person can check against a calendar. */
  ruleText: string
  /** The note the message carries; it is data, never an order. */
  message: string
  enabled: boolean
  nextAt: string
  lastAt?: string
  lastState?: string
  lastError?: string
  lastRunId?: string
  createdAt: string
  updatedAt: string
}

/** One run of a plan, as the console reads it. */
export interface ScheduleRun {
  runId: string
  planId: string
  projectId: string
  name: string
  rule: string
  reason: string
  plannedAt: string
  startedAt?: string
  finishedAt?: string
  state: string
  acknowledged: boolean
  error?: string
  skipped: number
}

/** What the scheduler holds: the counts the console's home page shows. */
export interface ScheduleCounts {
  plans: number
  enabled: number
  failed: number
  interrupted: number
  delivered: number
  lastRunAt?: string
  nextRunAt?: string
}

/** One entry of the audit trail. */
export interface AuditEntry {
  seq: number
  at: string
  actor: string
  kind: string
  action: string
  targetKind: string
  targetId: string
  outcome: string
  detail: string
}

/** One Session as the control plane records it. */
export interface SessionView {
  sessionId: string
  backendSessionId?: string
  projectId: string
  assignmentId?: string
  role: string
  nodeId: string
  workspace: string
  status: string
  toolProfile: string
  model?: string
  createdAt: string
  updatedAt: string
  archivedAt?: string
  tokenVersion?: number
  revokedAt?: string
  revokedReason?: string
  /**
   * Whether an operator's message may still reach this Session.
   *
   * A Worker Session that a newer Assignment replaced cannot receive a message: it would reach the Worker that took its
   * place. The console shows that instead of offering an action the server would refuse — the server's own check is the
   * rule.
   */
  deliverable?: boolean
  /** Why the Session may not receive a message, when it may not. */
  unavailableReason?: string
  /**
   * The turn this Session runs, when the node reported one.
   *
   * The number is what an interrupt names, so the console can say which turn it would end.
   */
  currentTurn?: number
  /**
   * Whether the node can interrupt one running turn of one Session.
   *
   * A node that does not offer it says so here, and the console does not offer an action the server would refuse.
   */
  interruptible?: boolean
  /** The operator's own stop of this Session, when there is one. */
  operatorStop?: { at: string; by: string; state: string; reason?: string; error?: string }
}

/** One message of a Session. */
export interface SessionMessage {
  seq: number
  at: string
  role: string
  text: string
}

/** One message of the Router's conversation, as the console reads it. */
export interface RouterMessage {
  seq: number
  at: string
  role: string
  text: string
  attachments?: string[]
  /** The request id a person's message carries, when it is one of the Router's own requests. */
  requestId?: string
}

/**
 * One proposal to relay a person's instruction to the PM of one Project.
 *
 * The instruction is the text that would really be sent, so the person who confirms it reads what the PM will get.
 */
export interface RouterProposal {
  /** The proposal's own id: the handle the console confirms or cancels. */
  id: string
  /** The request the proposal came from. */
  requestId: string
  /** The Project whose PM would receive the instruction. */
  projectId: string
  /** The Project's title. */
  projectTitle: string
  /** The text that would really be sent to that Project's PM. */
  instruction: string
  /** When the proposal was made. */
  at: string
}

/**
 * One message a person sent to the Router, and what became of it.
 *
 * The states are facts about different moments: `queued` while the message waits for the Router's next turn, `sending`
 * while it is on its way to the node, `sent` once the node took it into the Session's inbox, `read` once a turn of that
 * Session really took it, `failed` when the node refused it, and `unconfirmed` when the control plane cannot say
 * whether it arrived. The inbox is not a turn, and the console never shows one as the other.
 */
export interface RouterQueueEntry {
  /** The message's own id. */
  id: string
  /** When the person sent it. */
  at: string
  /** The person's own words. */
  text: string
  /** The names of the files the message carried. */
  attachments?: string[]
  /** What became of it. */
  state: 'queued' | 'sending' | 'sent' | 'read' | 'failed' | 'unconfirmed' | 'routed'
  /** Why it failed, or why it still waits. */
  error?: string
  /** The Router request the message is. */
  requestId: string
}

/**
 * One routing the Fast Router made, as the console reads it.
 *
 * The receipt is the control plane's own account of one message: which rule read it, which target it found, and how far
 * it really got. The stage never claims more than happened — a Worker that was asked to start is not running until the
 * node says so, and the Session status beside it is the node's own word.
 */
export interface FastRouteReceipt {
  /** The Router request this routing is; the message's own id. */
  requestId: string
  /** When the message was accepted. */
  at: string
  /** The person's own words. */
  text: string
  /**
   * Which way the message went.
   *
   * `fast` is a message the rules carried out themselves, without a model turn. `model` is a message the Router's own
   * model handles in the very same `router.v1` Session — an ordinary conversation, or a request the rules were not sure
   * about. The console shows the two apart, because they cost different things.
   */
  path: 'fast' | 'model'
  /** What the rule decided. */
  outcome: 'existing_ticket' | 'existing_project_pm' | 'standalone_ticket' | 'read_only' | 'escalate' | 'ordinary_reply'
  /** How far the message got. */
  stage: 'accepted' | 'routing' | 'queued' | 'assigned' | 'escalated' | 'model' | 'failed' | 'unconfirmed'
  /** How sure the rule was, between 0 and 1. */
  confidence: number
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** The target the rule found, when it found one. */
  target?: { kind: string; id: string; title: string }
  /** The Ticket the work landed in, when one was created or addressed. */
  ticketId?: string
  /** The Worker Session of that Ticket, when it is known. */
  sessionId?: string
  /** The live status of that Session, as the control plane knows it. */
  sessionStatus?: string
  /** Why it failed, when it failed. */
  error?: string
  /**
   * The answer to a question about the state of a thing.
   *
   * The record itself answered it: no model turn ran and nothing was dispatched, so the answer is the control plane's
   * own word about what is true right now.
   */
  answer?: string
}

/**
 * One decision of the Project Gate, as the console reads it.
 *
 * The four findings are what the decision said about each condition, and the modules are what it said the work is made
 * of. Both are shown, because the reason the gate gave is only checkable against them.
 */
export interface ProjectGateRecord {
  /** The Router request this decision was made for. */
  requestId: string
  /** Which try of that request this is. */
  attempt: number
  /** When the decision was made. */
  at: string
  /** The person's own words. */
  text: string
  /** The title the decision would have given the Project. */
  title: string
  /** The goal the decision would have given the Project. */
  goal: string
  /** What became of it: `created`, `refused` or `failed`. */
  outcome: string
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** The four findings, as they were read. */
  conditions: { condition: string; met: boolean; evidence: string }[]
  /** The modules, as they were read. */
  modules: { name: string; responsibility: string; independent: boolean; evidence: string; anchor: string }[]
  /** The condition that failed, when one did. */
  failedCondition?: string
  /** The Project the request named outright, when it named one. */
  existingProject?: { id: string; title: string }
  /** The Project that was created, when one was. */
  projectId?: string
  /** The PM Session of that Project, when there is one. */
  pmSessionId?: string
  /** The state of that PM Session, as the control plane knows it. */
  pmStatus?: string
  /** Why it failed, when it failed. */
  error?: string
}

/**
 * One handoff of a request to a Project's PM, as the console reads it.
 *
 * The record is the control plane's own account of one delivery: the Project it went to, the PM Session that took it,
 * the words that really travelled and how far the delivery got. The stage never claims more than happened — a PM that
 * was asked to take the work is not working on it until the node says so.
 */
export interface RouterHandoffRecord {
  /** The Router request this handoff is; the message's own id. */
  requestId: string
  /**
   * Which kind of handoff this is.
   *
   * `handoff` is the high-level Router's own decision to give a request to the PM of a Project that already existed.
   * `brief` is the work brief the Project Gate published to the PM of the Project it just created.
   */
  kind: 'handoff' | 'brief'
  /** When the decision was made. */
  at: string
  /** The person's own words. */
  text: string
  /** The Project the work goes to. */
  projectId: string
  /** The title of that Project, as the console shows it. */
  projectTitle: string
  /** The PM Session that received the work. */
  pmSessionId: string
  /** The live status of that PM Session, as the control plane knows it. */
  pmStatus?: string
  /** The words that really travelled to that PM. */
  instruction: string
  /** The short, checkable reason the Router gave. */
  rationale: string
  /** How far the handoff got. */
  stage: 'accepted' | 'routing' | 'queued' | 'assigned' | 'refused' | 'failed' | 'unconfirmed'
  /** The stable code of the reason. */
  reason: string
  /** The reason in words. */
  detail: string
  /** Why it failed, when it failed. */
  error?: string
}

/**
 * The Router's own facts, as the console reads them.
 *
 * The conversation comes from the node's own message events, so what the console shows is what really happened: the
 * person's words on one side, the model's answers on the other, and nothing in between that the console made up.
 */
export interface RouterState {
  /**
   * The Router Session, when it has been started.
   *
   * `currentTurn` is the turn the Router runs right now, as the node reported it, and `interruptible` says whether the
   * node offers to end one turn at all. The console offers the interrupt only when the backend confirms both.
   */
  session?: { sessionId: string; status: string; workspace: string; updatedAt: string; revokedAt?: string
    currentTurn?: number; interruptible?: boolean }
  /** Whether the node the Router runs on is reachable. */
  nodeOnline: boolean
  /** The conversation, oldest first. */
  messages: RouterMessage[]
  /** The proposal that waits for a person right now, when there is one. Nothing has been sent yet. */
  proposal?: RouterProposal
  /** The messages that wait for the Router, oldest first. */
  queue?: RouterQueueEntry[]
  /**
   * The routings the Fast Router made, oldest first.
   *
   * A message that plainly named its target never reached the Router's model: the control plane carried it out itself,
   * and these receipts say which target it found and how far the work got.
   */
  routes?: FastRouteReceipt[]
  /**
   * The decisions of the Project Gate, oldest first.
   *
   * A record names the human request the decision was made for, the four findings and the modules they were made of, the
   * reason the gate gave, and — when a Project really was created — the Project and the PM that belong to it. A refusal is
   * a record too, so a person may ask why their request did not become a Project.
   */
  gates?: ProjectGateRecord[]
  /**
   * The handoffs the high-level Router made to a Project's PM, oldest first.
   *
   * A record names the request the work came from, the Project it went to, the PM Session that took it, the words that
   * really travelled and how far the delivery got. A refusal is a record too, so a person may see why a request did not
   * reach a PM.
   */
  handoffs?: RouterHandoffRecord[]
  /**
   * The notices about stops the Router is the logical superior of.
   *
   * The Router is the superior of every PM Session and of the Workers of the standalone Tickets, so an operator's stop
   * of any of them leaves a notice here.
   */
  stops?: StopNotice[]
}

/** One notice about an operator's stop, as the console reads it. */
export interface StopNotice {
  /** The notice's own id. */
  id: number
  /** When the stop was recorded. */
  at: string
  /** What was stopped. */
  target: { kind: string; id: string; sessionId?: string }
  /** How far the stop reached. */
  scope: string
  /** `requested` until the node confirmed the stop; `confirmed` afterwards. */
  state: string
  /** Who stopped it. */
  actor: string
  /** The Project the stopped work belonged to, when it had one. */
  projectId?: string
  /** What the stop affected. */
  affected: string[]
  /** What the stop left running. */
  unaffected: string[]
  /** Who may read the notice. */
  superior: { kind: string; id?: string }
  /** The diagnostic of a stop the node did not confirm. */
  error?: string
}

/**
 * One delivery of a report, as the console reads it.
 *
 * It carries the facts of the delivery and never the body of the report: the stored message is the lower-trust text of
 * the Worker or the PM, and a console shows what happened to a delivery rather than what it said.
 */
export interface CoordinationDelivery {
  /** The delivery's own id. */
  deliveryId: string
  /** The kind of coordination: `auto_handoff`, `worker_report`, `pm_report`, `stream_digest`, `denial_review` or
   * `external_wakeup`. */
  kind: string
  /** When the delivery was accepted. */
  at: string
  /** The state the delivery reached. */
  status: string
  /** The kind of the report. */
  reportKind: string
  /** The Project the report belongs to. */
  projectId: string
  /** The Ticket the report is about. */
  ticketId: string
  /** The Assignment the report is about. */
  assignmentId: string
  /** The review round the report waits for. */
  reviewId: string
  /** The Session that made the report. */
  sourceSessionId: string
  /** The Session the report is delivered to. */
  targetSessionId: string
  /** What the target Session is for. */
  targetRole: string
  /** The node the report came from. */
  nodeId: string
  /** The backend the report came from. */
  backendId: string
  /** How many times the delivery was attempted. */
  attemptCount: number
  /** The lifecycle generation of the target when the delivery was enqueued. */
  expectedAssignmentEpoch: number
  /** The credential version of the target when the delivery was enqueued. */
  expectedToolTokenVersion: number
  /** The node trust the delivery was made under. */
  expectedNodeTrustEpoch: number
  /** The lifecycle generation of the Assignment the report is about. */
  sourceAssignmentEpoch: number
  /** When a held-back delivery may go out. */
  dueAt: string
  /** When the delivery was claimed and went on its way. */
  dispatchedAt: string
  /** Why the delivery failed, when it did. */
  error: string
  /** When the message itself runs out; empty when it never does. */
  expiresAt: string
  /** How many times the delivery was sent again after the node proved it never arrived. */
  resendCount: number
  /** What the node last said about this delivery. */
  evidence: string
}

/**
 * One stream subscription, as the console reads it.
 *
 * It carries the scope, the state and the reference the console needs, and never the digest itself: the digest quotes
 * the child's own words, and a console that showed it would show untrusted text as if it were the control plane's own.
 */
export interface StreamSubscription {
  /** The subscription's own id. */
  subscriptionId: string
  /** The Session that asked for the digests. */
  subscriberSessionId: string
  /** What that Session is for. */
  subscriberRole: string
  /** The Session the digests are about. */
  targetSessionId: string
  /** What that Session is for. */
  targetRole: string
  /** The Project the child belongs to; empty for a standalone Ticket. */
  targetProjectId: string
  /** The Ticket the child works on; empty for a PM. */
  targetTicketId: string
  /** The Assignment the child runs; empty for a PM. */
  targetAssignmentId: string
  /** The interval between two digests, in seconds. */
  intervalSeconds: number
  /** `active`, `unsubscribed` or `terminal`. */
  status: string
  /** The event watermark the subscription has reached. */
  lastPushedSeq: number
  /** When the last digest really reached the superior. */
  lastDeliveredAt: string
  /** When the next digest is due. */
  nextDueAt: string
  /** When the subscription was made. */
  createdAt: string
  /** Why the subscription is in this state, when there is something to say. */
  reason: string
  /** How the last digest ended. */
  digestStatus: string
  /** Why the last digest ended that way. */
  digestReason: string
  /** The console path of the child's own session panel. */
  contextRef: string
}

/**
 * One permission denial review, as the console reads it.
 *
 * It carries the facts of the refusal and what became of the review. The message that was sent to a superior is not part
 * of it, and neither are the arguments of the refused call: the console shows what the guard refused and who heard
 * about it, never what the model said.
 */
export interface DenialReview {
  /** The review's own id. */
  noticeId: string
  /** `system_denial_review` or `operator_denial_alert`. */
  kind: string
  /** When the review was made. */
  at: string
  /** `pending_manager_online`, `dispatching`, `notified` or `unconfirmed`. */
  status: string
  /** The Session that was refused. */
  controlSessionId: string
  /** The role of that Session. */
  role: string
  /** The Project the Session belongs to. */
  projectId: string
  /** The Ticket the Session works on. */
  ticketId: string
  /** The Assignment the Session runs. */
  assignmentId: string
  /** The turn the refusals were made in. */
  turnId: string
  /** The tool that was refused. */
  toolName: string
  /** Why it was refused. */
  reasonCode: string
  /** How many effective denials the window held. */
  denialCount: number
  /** The Session the review went to; empty for an operator alert. */
  targetSessionId: string
  /** The role of that Session. */
  targetRole: string
  /** The node the refusal came from. */
  nodeId: string
  /** The backend the refusal came from. */
  backendId: string
  /** Why the review is in that state, when there is something to say. */
  reason: string
  /**
   * The bounded projection of the governed work, in controlled fields only.
   *
   * It says which phase the Ticket, the Assignment and the Project are in, which kind of report the own scope made last
   * and how its review stands. It never carries a title, a goal, a path or a sentence of a person or a model.
   */
  taskContext: string
}

/**
 * One explicit human authorization application, as the console reads it.
 *
 * It names the review it is about, who raised it and what the operator decided. The arguments of the refused call and
 * the words of the model are not part of it: an application is a request in front of an operator, never a grant.
 */
export interface DenialAuthorization {
  /** The application's own id. */
  applicationId: string
  /** The review it is about. */
  reviewId: string
  /** `pending`, `acknowledged` or `declined`. */
  status: string
  /** The Session that raised it. */
  applicantSessionId: string
  /** The role of that Session. */
  applicantRole: string
  /** The Session that was refused. */
  controlSessionId: string
  /** The Project the refused Session belongs to. */
  projectId: string
  /** The Ticket the refused Session works on. */
  ticketId: string
  /** The Assignment the refused Session runs. */
  assignmentId: string
  /** Why the call was refused. */
  reasonCode: string
  /** The tool that was refused. */
  toolName: string
  /** How many effective denials the window held. */
  denialCount: number
  /** When the application was raised. */
  requestedAt: string
  /** When the operator decided about it. */
  decidedAt: string
  /** The operator's decision; empty while the application waits. */
  decision: string
}

/**
 * One denial counter, as the console reads it.
 *
 * It carries the numbers of one scope's window and nothing else: the refused calls themselves are not listed, and their
 * arguments are not kept at all.
 */
export interface DenialCounter {
  /** The scope the counter runs in. */
  scopeKey: string
  /** The Session the counter belongs to. */
  controlSessionId: string
  /** The role of that Session. */
  role: string
  /** The Project the Session belongs to. */
  projectId: string
  /** The Ticket the Session works on. */
  ticketId: string
  /** The Assignment the Session runs. */
  assignmentId: string
  /** The superior the denials are escalated to. */
  managerTarget: string
  /** The node the refusals came from. */
  nodeId: string
  /** The backend the refusals came from. */
  backendId: string
  /** When the window opened. */
  windowStartedAt: string
  /** How many effective denials the window holds. */
  windowCount: number
  /** When the last refusal happened. */
  lastDenialAt: string
  /** Until when no new review is made for this scope. */
  cooldownUntil: string
  /** The review the window produced, when it produced one. */
  noticeId: string
}

/**
 * One condition on a field of the payload of an external event.
 *
 * The path is dotted, and it is looked for in the payload first and in the whole event afterwards: a rule may name
 * `text` or `payload.text`, and both mean the same thing.
 */
export interface ExternalFieldCondition {
  /** The path of the field inside the payload, such as `groupId` or `text`. */
  path: string
  /** How the field is compared with the value: `exact`, `prefix`, `contains` or `regex`. */
  op: string
  /** The value the field is compared with. */
  value: string
}

/**
 * One external event subscription, as the console reads it.
 *
 * It names the source the events come from, the kinds of event it watches, the conditions the payload has to hold and
 * the one Session the event wakes. The lease, the rate and the state are here too, so a person may see why a
 * subscription woke nobody.
 */
export interface ExternalSubscription {
  /** The subscription's own id: the handle the console cancels or changes. */
  subscriptionId: string
  /** The observation source the events come from. */
  sourceId: string
  /** The kinds of event the subscription watches. */
  eventTypes: string[]
  /** The conditions the payload has to hold; every one of them has to hold. */
  fields: ExternalFieldCondition[]
  /**
   * The Session the event wakes.
   *
   * It is empty in the two-layer mode: that mode has no fixed target, and the fast route names one per event.
   */
  targetSessionId: string
  /** What that Session is for; empty in the two-layer mode, which names no Session at all. */
  targetRole: string
  /** The Project the target belongs to. */
  targetProjectId: string
  /** The Ticket the target works on. */
  targetTicketId: string
  /** The Assignment the target runs. */
  targetAssignmentId: string
  /** The lifecycle generation of the target when the subscription was made. */
  targetAssignmentEpoch: number
  /**
   * How the event reaches the target: `direct_initiator`, `direct_designated` or `dual_layer_router`.
   *
   * The first one wakes the Session that made the subscription, the second one the Session it names, and the third one
   * lets the fast route name one per event with the high-level Router as the fallback.
   */
  deliveryMode: string
  /** `active`, `cancelled` or `expired_by_scope`. */
  status: string
  /**
   * How many events the subscription may wake with in its window.
   *
   * The direct mode allows three in a minute; the two-layer mode allows one in five minutes, because every event of the
   * two-layer mode costs a Router turn as well.
   */
  ratePerMinute: number
  /**
   * The window of the rate limit, in seconds.
   *
   * It is sixty for the direct mode and three hundred for the two-layer one, so the count alone never says how often a
   * subscription may really wake. A control plane that does not have the window yet is read as one minute.
   */
  rateWindowSeconds?: number
  /**
   * The operator's own routing hint, when there is one.
   *
   * It belongs to the two-layer mode: the fast route reads it when it names a target for one event.
   */
  routeHint?: string
  /** When the lease runs out. */
  leaseExpiresAt: string
  /** When the last delivery really went out. */
  lastDeliveredAt: string
  /** When the subscription was made. */
  createdAt: string
  /** When the subscription was last changed. */
  updatedAt: string
  /** Why the subscription is in this state, when there is something to say. */
  reason: string
  /** The console path of the target's own session panel. */
  contextRef: string
  /**
   * Who made the subscription: `operator`, `pm`, `worker` or `router`.
   *
   * A person's own subscription is the operator's; the other three belong to the Agents of this control plane, and each
   * of them owns what it made.
   */
  ownerRole?: string
  /**
   * The Session that made the subscription.
   *
   * It is empty for a subscription a person made.
   */
  ownerSessionId?: string
  /**
   * How many events were merged into the throttle counter of this subscription.
   *
   * It grows once per throttled event and never for a replay of one.
   */
  throttledCount?: number
  /**
   * How many events were refused because the subscription had already seen them.
   *
   * It grows once per replay and says nothing about how many events really went out.
   */
  duplicateCount?: number
}

/**
 * One disposition of an external event, as the console reads it.
 *
 * It carries the ids, the state and the reason, and never the payload of the event: a console that showed the payload
 * would show the words of the outside world as if they were the control plane's own.
 */
export interface ExternalDisposition {
  /** The disposition's own id. */
  dispositionId: string
  /** The subscription the event was about. */
  subscriptionId: string
  /** The observation source the event came from. */
  sourceId: string
  /** The event's own id. */
  eventId: string
  /** The kind of event it was. */
  eventType: string
  /**
   * `dispatching`, `sent`, `duplicate`, `unconfirmed`, `blocked`, `throttled`, `failed` or `semantic_eval_degraded`.
   *
   * The last one is an event whose optional semantic condition could not be evaluated: the event fails closed and wakes
   * nobody.
   */
  status: string
  /** Why the event reached that state. */
  reason: string
  /** When it happened. */
  at: string
  /** Which try of that event it was. */
  attempt: number
}

/**
 * What one injected event did to the subscriptions that watched for it.
 *
 * The counts say how many subscriptions the event was offered to, how many stayed quiet because their rules did not
 * hold, and what became of the rest. The lists name the subscriptions, never the events they carried.
 */
export interface ExternalEmitResult {
  /** The observation source the event came from. */
  sourceId: string
  /** The event's own id. */
  eventId: string
  /** The kind of event it was. */
  eventType: string
  /** The subscriptions whose source and event kind matched. */
  considered: number
  /** Of those, the ones whose fields did not hold: they stayed quiet. */
  quiet: number
  /** The subscriptions the event really reached. */
  delivered: string[]
  /** The subscriptions the event may not wake. */
  blocked: string[]
  /** The subscriptions that were woken too often. */
  throttled: string[]
  /** The subscriptions that had already seen this event. */
  duplicates: string[]
  /** The subscriptions whose delivery failed. */
  failed: string[]
  /** The subscriptions whose delivery may have arrived and is never repeated. */
  unconfirmed: string[]
  /** The subscriptions whose semantic condition could not be evaluated, and which therefore failed closed. */
  degraded: string[]
}

/** What an operator asks for when a subscription is made. */
export interface ExternalSubscriptionInput {
  /** The observation source the events come from. */
  sourceId: string
  /** The kinds of event the subscription watches. */
  eventTypes: string[]
  /** The conditions the payload has to hold; every one of them has to hold. */
  fields: ExternalFieldCondition[]
  /**
   * The Session the event wakes.
   *
   * It is left out in the two-layer mode: that mode has no fixed target, and the control plane ignores the field anyway.
   */
  targetSessionId?: string
  /** How the event reaches the target. */
  deliveryMode?: string
  /** How long the subscription's lease lasts, in seconds. */
  leaseSeconds?: number
  /**
   * The operator's own routing hint, for the two-layer delivery.
   *
   * It is a hint and not an instruction: the control plane reads it when the two-layer mode exists, and a control plane
   * that does not know it simply ignores it.
   */
  routeHint?: string
}

/** What an operator may change on a subscription that already exists. */
export interface ExternalSubscriptionPatch {
  /** The kinds of event the subscription watches. */
  eventTypes?: string[]
  /** The conditions the payload has to hold. */
  fields?: ExternalFieldCondition[]
  /** The Session the event wakes. */
  targetSessionId?: string
  /** How long the subscription's lease lasts, in seconds. */
  leaseSeconds?: number
}

/** One node as the control plane knows it. */
export interface NodeView {  nodeId: string
  backend: string
  version: string
  online: boolean
  at: string
  capabilities?: string[]
}

/** One Ticket as the console reads it. */
export interface ConsoleTicket {
  id: string
  title: string
  projectId?: string
  status: string
  assignment?: { id: string; state: string; report?: { state: string; summary: string; at: string } }
  review?: { id: string; state: string; assignmentId: string; at: string; summary?: string }
  attention?: { question: string }
  manualStop?: { scope: string; at: string }
}

/** One Project as the console reads it. */
export interface ConsoleProject {
  id: string
  title: string
  goal: string
  workspace: string
  status: string
  pauseMode?: string
  pmSessionId: string
  createdAt: string
  updatedAt: string
  latestReport?: { summary: string; at: string }
  tickets: ConsoleTicket[]
}

/**
 * One bounded list of the live state.
 *
 * `total` is how many rows are in scope in all and `omitted` how many were left out by the bound, so the console never
 * shows a list that reads as complete when it was cut.
 */
export interface LiveStateList<T> {
  rows: T[]
  total: number
  omitted: number
}

/** One node as the live state names it. */
export interface LiveStateNode {
  nodeId: string
  displayName?: string
  isPrimary: boolean
  /** `online`, `offline` or `unknown`: a node nobody heard of is unknown, never offline. */
  connection: 'online' | 'offline' | 'unknown'
  lastSeenAt?: string
  backends: {
    backendId: string
    kind: string
    /** `available`, `unavailable` or `unknown`; an unknown backend is never reported as available. */
    availability: 'available' | 'unavailable' | 'unknown'
    capabilities: {
      turnInterrupt: boolean
      twoStageReceipt: boolean
      sessionResume: boolean
      gitReviewDiff: boolean
    }
  }[]
}

/** One Session as the live state names it. */
export interface LiveStateSession {
  sessionId: string
  role: string
  status: string
  projectId: string
  ticketId?: string
  assignmentId?: string
  nodeId: string
  updatedAt: string
  stopped?: boolean
  revoked?: boolean
}

/** One Project as the live state names it. */
export interface LiveStateProject {
  projectId: string
  title: string
  status: string
  pauseMode?: string
  pmSessionId: string
  updatedAt: string
}

/** One Ticket as the live state names it. */
export interface LiveStateTicket {
  ticketId: string
  title: string
  projectId?: string
  /** The status a PM reads for it. */
  status: string
  assignmentId?: string
  reviewState?: string
  updatedAt: string
  stopped?: boolean
}

/** One Assignment as the live state names it. */
export interface LiveStateAssignment {
  assignmentId: string
  ticketId: string
  state: string
  sessionId?: string
  /** The state of the Assignment's own last report; the report's text is not part of it. */
  reportState?: string
  epoch: number
  startedAt?: string
  endedAt?: string
}

/** One scheduled plan as the live state names it. */
export interface LiveStateSchedule {
  planId: string
  projectId: string
  name: string
  rule: string
  enabled: boolean
  nextAt: string
  lastState?: string
}

/** The live state of the control plane, as the console reads it. */
export interface LiveStateSnapshot {
  /** When the facts were read: the control plane's own clock. */
  at: string
  /** Who the facts are for. */
  audience: string
  nodes: LiveStateList<LiveStateNode>
  projects: LiveStateList<LiveStateProject>
  tickets: LiveStateList<LiveStateTicket>
  assignments: LiveStateList<LiveStateAssignment>
  sessions: LiveStateList<LiveStateSession>
  schedules: LiveStateList<LiveStateSchedule>
}

/** One entry of a Project's own memory. */
export interface ProjectMemoryEntry {
  id: number
  projectId: string
  at: string
  actor: string
  text: string
}

/** One finding of a reconciliation run. */
export interface ReconcileFinding {
  id: string
  kind: string
  sessionId: string
  assignmentId?: string
  projectId: string
  action: string
  outcome: string
  reason?: string
}

/** One run of the reconciliation, as the console reads it. */
export interface ReconcileRun {
  id: number
  at: string
  nodeOnline: boolean
  checked: number
  findings: ReconcileFinding[]
  counts: { orphans: number; cleaned: number; failed: number; reported: number }
  boundary: string
}

const TAB_CONNECTION_KEY = 'superagent.console.connection'
export const CONSOLE_KEY_REJECTED = 'superagent:console-key-rejected'

function restoreConsoleKey(): string {
  try {
    return window.sessionStorage.getItem(TAB_CONNECTION_KEY) ?? ''
  } catch {
    return ''
  }
}

let controlKey = restoreConsoleKey()

function setConsoleKey(value: string): void {
  controlKey = value
  try {
    if (value) window.sessionStorage.setItem(TAB_CONNECTION_KEY, value)
    else window.sessionStorage.removeItem(TAB_CONNECTION_KEY)
  } catch { /* A browser that blocks storage can still use the in-memory connection. */ }
}

export function clearConsoleKey(): void { setConsoleKey('') }

export async function connectConsole(key: string): Promise<void> {
  await request<Overview>('/v1/overview', {}, key)
  setConsoleKey(key)
}

function rejectConsoleKey(sent: string): void {
  if (!sent || sent !== controlKey) return
  clearConsoleKey()
  window.dispatchEvent(new Event(CONSOLE_KEY_REJECTED))
}

/** The key the console sends right now. */
export function consoleKey(): string { return controlKey }

/** The message of a failed request, for the console to show. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One request to the control plane, with the key in the header. */
async function request<T>(path: string, init: { method?: string; body?: unknown } = {}, key = controlKey): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    if (response.status === 401) rejectConsoleKey(key)
    let message = `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === 'string' && parsed.error !== '') message = parsed.error
    } catch {
      // The answer was not JSON; the status is the message a person needs.
    }
    throw new ConsoleApiError(response.status, message)
  }
  return (text === '' ? undefined : JSON.parse(text)) as T
}

/** One read. */
export function read<T>(path: string): Promise<T> { return request<T>(path) }

/**
 * The live state of this control plane, read once.
 *
 * It is a snapshot: the answer carries the moment it was taken, and it is thrown away right after. Nothing is written and
 * nothing is started by reading it.
 */
export function readLiveState(): Promise<LiveStateSnapshot> {
  return read<LiveStateSnapshot>('/v1/console/memory/live-state')
}

/**
 * One row of the durable event history, as the console reads it.
 *
 * The row names the fact, the scope it belongs to, the record it was read from and one redacted line about it. It holds
 * no report text, no diff, no prompt and no path: those stay in the records the row points at.
 */
export interface EventHistoryEntry {
  seq: number
  eventId: string
  kind: string
  at: string
  scopeKey: string
  ticketId: string
  projectId: string
  controlSessionId: string
  assignmentId: string
  nodeId: string
  backendId: string
  sourceTable: string
  sourceId: string
  sourceSeq: number
  summary: string
  detail: Record<string, string>
}

/** How much of the durable history the control plane really holds. */
export interface EventHistoryCoverage {
  /** The oldest row the index holds: the history starts here and nowhere earlier. */
  since?: string
  /** The kinds the index holds rows of. */
  kinds: string[]
  /** The index is never cut by age or by count. */
  trimmed: boolean
  /** The retention rule, in the control plane's own words. */
  retention: string
}

/** One page of the durable event history. */
export interface EventHistoryPage {
  rows: EventHistoryEntry[]
  /** The keyset position of the next page, when there is one. */
  nextCursor?: string
  /** Whether more rows are in scope than this page holds. */
  hasMore: boolean
  /** How many rows are in scope, in all. */
  total: number
  coverage: EventHistoryCoverage
}

/** The exact keys one read of the durable history names. */
export interface EventHistoryQuery {
  ticketId?: string
  projectId?: string
  kind?: string
  limit?: number
  cursor?: string
}

/**
 * Read one page of the durable event history.
 *
 * The keys are exact, and the answer says how far back the history reaches: the index starts where it was built, and the
 * facts before that are not in it.
 */
export function readEventHistory(query: EventHistoryQuery = {}): Promise<EventHistoryPage> {
  const params = new URLSearchParams()
  if (query.ticketId !== undefined && query.ticketId !== '') params.set('ticketId', query.ticketId)
  if (query.projectId !== undefined && query.projectId !== '') params.set('projectId', query.projectId)
  if (query.kind !== undefined && query.kind !== '') params.set('kind', query.kind)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor)
  const search = params.toString()
  return read<EventHistoryPage>(`/v1/console/memory/event-history${search === '' ? '' : `?${search}`}`)
}

/**
 * One source reference of a candidate or a memory, as the console reads it.
 *
 * It names the record the fact came from and one redacted line about it. It never carries the record's own text: a
 * report's body, a diff and a prompt stay where they were written.
 */
export interface MemorySourceRef {
  kind: string
  id: string
  at: string
  summary: string
  /** Whether the control plane really holds the record this reference names. */
  verified: boolean
}

/** One candidate of the queue, as the console reads it. */
export interface MemoryCandidateView {
  candidateId: string
  scopeType: string
  scopeId: string
  proposedScopeType: string
  proposedScopeId: string
  /** The body of the proposal, already redacted. */
  content: string
  status: string
  sourceTrust: string
  sourceRefs: MemorySourceRef[]
  proposedByRole: string
  proposedBySessionId: string
  /** Whether the proposal may be read inside the Session that made it while it waits. */
  provisionalSameSession: boolean
  revisionCount: number
  conflictWithId: string
  confidence: number
  importance: number
  reviewNote: string
  createdAt: string
  updatedAt: string
  reviewedAt: string
  expiresAt: string
  /** The checksum of this version of the candidate; a decision made on an older one is refused. */
  checksum: string
}

/** One page of the candidate queue. */
export interface MemoryCandidatePage {
  rows: MemoryCandidateView[]
  total: number
}

/** One memory, as the console reads it. */
export interface MemoryRecordView {
  memoryId: string
  scopeType: string
  scopeId: string
  /** The body of the memory, already redacted. */
  content: string
  status: string
  sourceTrust: string
  sourceRefs: MemorySourceRef[]
  supersedesId: string
  supersededById: string
  conflictWithId: string
  pinned: boolean
  importance: number
  confidence: number
  utility: number
  validFrom: string
  lastVerifiedAt: string
  deprecatedAt: string
  createdAt: string
  updatedAt: string
  nodeId: string
  backendId: string
  checksum: string
}

/** One page of the memories. */
export interface MemoryRecordPage {
  rows: MemoryRecordView[]
  total: number
}

/** Read the queue of candidates. */
export function readMemoryCandidates(query: { status?: string; limit?: number } = {}): Promise<MemoryCandidatePage> {
  const params = new URLSearchParams()
  if (query.status !== undefined && query.status !== '') params.set('status', query.status)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const search = params.toString()
  return read<MemoryCandidatePage>(`/v1/console/memory/candidates${search === '' ? '' : `?${search}`}`)
}

/** Read the memories that are in force. */
export function readLongTermMemories(query: { status?: string; limit?: number } = {}): Promise<MemoryRecordPage> {
  const params = new URLSearchParams()
  if (query.status !== undefined && query.status !== '') params.set('status', query.status)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const search = params.toString()
  return read<MemoryRecordPage>(`/v1/console/memory/memories${search === '' ? '' : `?${search}`}`)
}

/**
 * Offer one fact to be remembered.
 *
 * It enters the queue and waits for a decision: the console may propose a memory, and it may not write one.
 *
 * The candidate comes back with the answer when the caller may see the row. A proposal that is already in the queue is
 * answered with `duplicate: true` and no row at all when the caller may not see it — the console is the operator's own
 * console, so it always may.
 */
export function submitMemoryCandidate(input: { content: string; scopeType: string; scopeId: string }):
  Promise<{ candidate?: MemoryCandidateView; duplicate: boolean }> {
  return write<{ candidate?: MemoryCandidateView; duplicate: boolean }>('/v1/console/memory/candidates', input)
}

/**
 * Take one decision about one candidate.
 *
 * The decision names the version of the candidate it was made on, so a decision about a candidate that changed in the
 * meantime is refused rather than deciding about the wrong thing.
 */
export function decideMemoryCandidate(input: { candidateId: string; decision: string; checksum: string;
  memoryId?: string; note?: string }): Promise<{ code: string; candidate: MemoryCandidateView; memory?: MemoryRecordView }> {
  return write<{ code: string; candidate: MemoryCandidateView; memory?: MemoryRecordView }>(
    `/v1/console/memory/candidates/${encodeURIComponent(input.candidateId)}/decision`,
    { decision: input.decision, checksum: input.checksum, ...(input.memoryId === undefined ? {} : { memoryId: input.memoryId }),
      ...(input.note === undefined ? {} : { note: input.note }) })
}

/** One write. */
export function write<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: 'POST', body })
}

/** One write that is not a creation. */
export function put<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: 'PUT', body })
}

/** One delete. */
export function remove<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}

/**
 * The external event subscriptions the operator made, and the dispositions of the events they saw.
 *
 * The dispositions are the second pass's own field: a control plane that does not have them yet answers without them,
 * and the console shows the subscriptions all the same. Nothing here is filled in by the console: a gap stays a gap.
 */
export async function readExternalSubscriptions(limit = 24): Promise<{ subscriptions: ExternalSubscription[];
  dispositions: ExternalDisposition[] }> {
  const answer = await read<{ subscriptions?: ExternalSubscription[]; dispositions?: ExternalDisposition[] }>(
    `/v1/console/external-subscriptions?limit=${limit}`)
  return { subscriptions: answer.subscriptions ?? [], dispositions: answer.dispositions ?? [] }
}

/** Make one external event subscription. */
export async function createExternalSubscription(input: ExternalSubscriptionInput): Promise<ExternalSubscription> {
  const { subscription } = await write<{ subscription: ExternalSubscription }>('/v1/console/external-subscriptions', input)
  return subscription
}

/** Change one external event subscription that already exists. */
export async function updateExternalSubscription(subscriptionId: string,
  patch: ExternalSubscriptionPatch): Promise<ExternalSubscription> {
  const { subscription } = await put<{ subscription: ExternalSubscription }>(
    `/v1/console/external-subscriptions/${encodeURIComponent(subscriptionId)}`, patch)
  return subscription
}

/** Stop one external event subscription. */
export async function cancelExternalSubscription(subscriptionId: string): Promise<ExternalSubscription> {
  const { subscription } = await write<{ subscription: ExternalSubscription }>(
    `/v1/console/external-subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {})
  return subscription
}

/**
 * Publish one synthetic event, and say what every subscription did with it.
 *
 * The source is one of the control plane's own observation sources: nothing outside this control plane is contacted.
 */
export async function emitSyntheticEvent(event: { sourceId: string; eventId: string; eventType: string;
  payload: Record<string, unknown> }): Promise<ExternalEmitResult> {
  const { result } = await write<{ result: ExternalEmitResult }>('/v1/console/events/synthetic-emit', event)
  return result
}

/** How the stream is doing. */
export type StreamStatus = 'connected' | 'reconnecting'

/** What the console wants to know about the stream. */
export interface StreamHandlers {
  /** One event, in the order the control plane recorded it. */
  onEvent: (event: StreamEvent) => void
  /** The stream opened or is being opened again. */
  onStatus?: (status: StreamStatus) => void
  /** The log no longer holds events between the ones the console has: a hole it cannot fill. */
  onGap?: () => void
  /** The sequence the stream starts after; the console reads the current one and asks for what follows it. */
  from?: number
}

/** One parsed frame of the stream. */
type Frame = { kind: 'event'; event: StreamEvent } | { kind: 'gap' } | { kind: 'other' }

/** One frame of an SSE body: its data, or the comment that says the log has a hole. */
function parseFrame(raw: string): Frame {
  for (const line of raw.split('\n')) {
    if (line.trim() === ': gap') return { kind: 'gap' }
  }
  let data = ''
  let hasData = false
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field !== 'data') continue
    data = hasData ? `${data}\n${value}` : value
    hasData = true
  }
  if (!hasData) return { kind: 'other' }
  try {
    const parsed = JSON.parse(data) as StreamEvent
    if (typeof parsed?.seq !== 'number') return { kind: 'other' }
    return { kind: 'event', event: parsed }
  } catch {
    return { kind: 'other' }
  }
}

/** Read one SSE body, handing every frame to the console. */
async function readStream(body: ReadableStream<Uint8Array>, handlers: StreamHandlers): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = parseFrame(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      if (frame.kind === 'event') handlers.onEvent(frame.event)
      else if (frame.kind === 'gap') handlers.onGap?.()
      boundary = buffer.indexOf('\n\n')
    }
  }
}

/** Wait for a while, for the pause between two attempts. */
function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/**
 * Follow the control plane's event stream until the returned function is called.
 *
 * A stream that ends is opened again from the last sequence it delivered, so nothing is missed and nothing is repeated.
 * The pause between the attempts grows from a quarter of a second to five, which keeps a control plane that is down from
 * being hammered. `from` names the sequence the console already knows: the stream then carries only what follows it,
 * which is what the console needs — it reads the current facts from the API, not from the history.
 */
export function followEvents(path: string, handlers: StreamHandlers): () => void {
  let stopped = false
  let controller: AbortController | undefined
  let attempt = 0
  let lastSeq = handlers.from ?? 0

  const run = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController()
      try {
        const key = controlKey
        const response = await fetch(`${path}?after=${lastSeq}`, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: controller.signal,
        })
        if (response.status === 401) {
          rejectConsoleKey(key)
          return
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        if (!response.body) throw new Error('the event stream has no body')
        attempt = 0
        handlers.onStatus?.('connected')
        await readStream(response.body, {
          onEvent: event => {
            if (event.seq > lastSeq) lastSeq = event.seq
            handlers.onEvent(event)
          },
          ...(handlers.onGap ? { onGap: handlers.onGap } : {}),
        })
      } catch {
        // A stream that broke is opened again below; a console that was stopped simply ends.
        if (stopped) return
      }
      if (stopped) return
      handlers.onStatus?.('reconnecting')
      attempt += 1
      await delay(Math.min(250 * 2 ** (attempt - 1), 5000))
    }
  }
  void run()
  return () => {
    stopped = true
    controller?.abort()
  }
}
