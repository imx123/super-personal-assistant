# 002 Authorization

Authorization determines who may start work and what that work may include. This document builds on [001 Domain model](001-domain.md).

The host enforces allowed lists, rules and Mandates. Messages, comments and quoted documents are inputs to a decision; they cannot change those permissions.

## Two paths for a Trigger

### Eval: deciding whether to start work

The Source records whether a message addresses the agent: `mention` for a mention of the bot or agent account, and `direct` for a direct message. The gate checks the sender and the Source's Policy:

- An allowed person who addresses the agent makes an explicit request.
- A person's follow-up on a Thread with Tickets follows the rules below; for an unlisted person, the follow-up must not hit an `ignore` admission cell.
- Other human messages use the admission table for their receiving scope.
- A bot on the Source's bot list can produce an inferred candidate, never an explicit request. Other bots are not admitted.

### Subscriptions: continuing existing work

Every message on a subscribed Thread reaches its subscribed Tickets as context, including messages from bots and CI. This delivery bypasses the gate and grants no new authority. Each Ticket remains limited by its Mandate.

A person's message on a Ticket's own Thread belongs to that Ticket's Executor to decide. The same applies when the main Session attaches a message to a Ticket. While an Executor owns the message, it takes no Eval and gets no Decision. Each Executor either handles the request within its Ticket's scope or hands it back for routing elsewhere.

Ownership continues while the Ticket is live, even if a person removes its Subscription. It also covers an ended Ticket that was not stopped by a person and has the message waiting to resume it.

The main Session receives a follow-up notice. While an Executor owns the message, the main Session may only stop work on the person's request; accept, attach, ignore and requeue are refused. A stop still passes through the gate with the follow-up strength described below.

### Handing back and releasing follow-ups

An Executor hands a message back once when it asks for work beyond the Ticket's scope or belongs to another Ticket. The Ticket keeps its Subscription. If an attached Thread is unrelated, the Executor hands back the messages it owns there.

A message goes to a fresh Eval only after no Ticket still owns it. Its candidate includes the Executors' reasons. The gate judges it as an ordinary message on that Thread, and the main Session can accept it, attach it elsewhere or ignore it. Handing back a message the Ticket did not own, such as a bot message or one a person already sent to Eval, queues nothing.

When a Ticket ends, it releases follow-ups its Executor did not read or take up. These include messages never delivered to the Executor and messages delivered after its last Report or turn end, provided it neither acknowledged, answered nor handed them back. Each released message goes to Eval when no other Ticket owns it. A stop ends only the stopped Ticket's work.

A stopped Ticket does not send its stop message to Eval again unless another Ticket handed it back. The main Session that stopped it may accept the rest of the message as new work.

A person can send an owned follow-up to Eval from the panel. If the main Session then attaches it back to a live Ticket, the Executor receives it again. The panel also offers re-evaluation when no effective judgement covers the message.

### Context-only subscriptions

An Executor can follow a related Thread, such as another Issue or pull request, for context. Its messages reach the Ticket but grant no authority or follow-up strength. Human messages there do not resume an ended Ticket unless the main Session attaches a message from that Thread. Notes from the main Session about other work are also context only.

Human messages that reach no Ticket, including Threads whose Tickets were stopped by a person, take the Eval path. Bot messages take that path independently of their delivery to subscribed Tickets.

## The main Session entry

The main Session is also a Source, named `main-session`. It is not polled: when the person asks the main Session to dispatch work, its `orchestrator_user_trigger_create` tool records the current native user message as one Trigger and the main Session routes it with `orchestrator_route`.

- The Source card configures one operator ID, `dsh-user` by default. The Trigger's actor is `{source: "main-session", id: <operator>}`.
- The Policy allowed list is kept in step with that operator: saving the Source rewrites it to exactly this operator, keeping any display name already recorded for it, and startup repairs a hand-edited mismatch. The Source switch, not the list, turns the entry off.
- Only the operator on that Policy allowed list can originate work. The entry tool refuses while the Source is off or the operator is not allowed. It does not bypass the gate, and the accept still creates a normal Mandate.
- The main Session is the only Session and is allowed to dispatch by default. Its role prompt makes it read-only by default: it reads, inspects and routes, and does not write in the shared workspace or another Session's directory. A write the person asks for directly needs their confirmation first; otherwise it goes to a full-tool Ticket. This is prompt text, not a capability restriction.
- Each native message is its own domain Thread, so independent tasks do not fan out to one another. This is a deliberate choice of the entry, separate from the DSH chat Session, which stays continuous.

## Projects and their PM

Creating a Project is not an accept and does not go through `orchestrator_route`. On an explicit request that a person wants a longer goal managed, the main Session records the message with `orchestrator_user_trigger_create` and calls `orchestrator_project_create` with the trigger, a title and the goal.

- The Project's Decision still passes the gate: a Trigger the gate does not admit cannot become a Project. The Eval is gate-only: it generates a real Eval id and a Decision of kind `project`, but it never asks the assessor and never delivers a candidate.
- The same transaction creates the `project` Decision (with `projectId` and no `ticketId`), the Project Profile and the Project PM Mandate. The Project id is `key('project', triggerId)`, so a repeated call returns the Project created first and records no second Decision or PM Session.
- No Ticket is accepted and no worker starts at Project creation. The main Session receives the Project card and only acknowledges it.
- The `PMMandate` carries the gate's strength, Policy version, basis and actor, as a Ticket Mandate does, plus the Project and its goal. It authorizes managing the Project, not arbitrary file or repository work.
- The PM Session (`pm-<projectId>`) runs under `dsh-superagent-pm` with nine tools: `orchestrator_read`, `orchestrator_project_ticket_create`, `orchestrator_project_ticket_message`, `orchestrator_project_ticket_revive`, `orchestrator_project_ticket_handoff`, `orchestrator_project_ticket_handoff_new_ticket`, `orchestrator_project_ticket_handoff_to_project`, `orchestrator_project_ticket_handoff_decide` and `orchestrator_project_report`. It is a small Router: it keeps the Project's goal in view, delegates its Tickets, coordinates them, revives hard-paused Workers, hands work to new Workers or Projects, splits out-of-scope work into a new Ticket, decides requests addressed to it, and reports to the Project. Its read tool accepts its own `project/<id>`, its `project/<id>/tickets`, and a `ticket/<id>` only when that Ticket's `projectId` is its Project; every other resource is refused. It takes the `auto` permission preset when the host offers it, else `workspace-write`, then `read-only`; full access only when none exists.
- A new PM Session uses `eval.pmModel` when set, else `eval.model`; a worker still uses `executor.model` and the main Session `eval.model`. Changing `pmModel` applies to newly created PM Sessions only; an existing PM Session keeps its selection.

### A PM's delegated Tickets

The PM creates Tickets only inside its own Project, never arbitrary work, with `orchestrator_project_ticket_create`. One call takes 1–5 tasks, each with a title, goal, optional scope and note, optional worktree name, optional `allow_tools`, and optional external Threads.

- The Engine requires the Project's own PM Session id and validates that the Project is active. An unknown Project, a non-PM caller, a call that omits the PM Session, or an ended Project creates nothing.
- Each task records one Trigger of the built-in `internal` Source: actor `{source: 'internal', id: pmSessionId}`, `human: false`, no addressed mark, and one internal Thread of its own.
- A record-only Eval with a real Eval id records a `delegated` Decision, without asking the assessor and without delivering a candidate. Its basis is `{via: 'delegated', projectId, pmSessionId}`; its strength comes from the PM Mandate. The Decision names the Ticket and the Project, and records the Ticket's Mandate.
- The Ticket's Mandate copies the PM Mandate's strength, Policy version and actor, narrows the scope to the task's scope (or goal), and carries the delegated basis. `Policy.revalidate` follows that basis to the Ticket's Project: the Project must still exist, its `pmSessionId` must match the recorded one, and its status must be `active` or `paused`; its current PM Mandate must then still hold under today's settings, revalidated with a base Policy that never follows delegation again. An ended or archived Project, a missing or mismatched Project, or a PM Mandate that no longer holds revokes the Ticket. A Project's PM authority is checked, not an external allowed list for the internal Trigger.
- A task's `allow_tools` becomes the Ticket's `Mandate.allowTools`. Omitted or empty means the PM Mandate's own `allowTools` when it has one, else no restriction (every Worker tool). A task may only name known Worker tools, once each, at most 32, and may only narrow a PM Mandate's list, never widen it; an invalid list refuses the whole batch. `WORK_TOOLS` is the single declared set.
- `allowTools` narrows tool visibility only. It is not a filesystem, permission or sandbox boundary, and policy still governs what the work may be. The Executor's `workOnly` gives a Worker only the intersection of its Mandate's list and the tools the host actually offers; a subagent of that Worker inherits the same intersection and cannot reach a forbidden tool.
- The Ticket has no Channel and does not subscribe to the Project's source Thread. It subscribes only to the external Threads its task names; a `contextOnly` Thread is recorded in `Thread.context`, so its messages reach the worker without granting authority and do not resume an ended Ticket. Unknown thread keys or malformed references refuse the whole batch.
- Batch atomicity and idempotence: if one task is invalid, no Trigger, Decision or Ticket from the call remains. A repeated call with the same tasks reuses that batch's Tickets; changed tasks create new Tickets even at the same positions, and worktree names stay unique within the Project across batches.
- The PM remains the Project's only voice outward; a child Ticket does not reply to its external Threads.

### Revoking delegated authority

Delegated creation itself stays gate-less: the PM Mandate is the authority, so the internal Trigger is not re-gated. The authority is revalidated instead, at every point that would start or continue work.

- A Policy change that invalidates the Project's PM Mandate records a `policy-changed` Input with `delegatedAuthority: false` on each open delegated Ticket, and stops a running or pending Assignment through the same single-Worker stop a Project hard pause uses: the turn is cancelled, the Assignment ends as `stoppedByOperator`, and the Ticket records `manualStop` with `scope: 'project'` and reason `policyRevoked`.
- The Ticket keeps its revoked Mandate. Retry, wake from a person's follow-up, and the PM's revive refuse it with `mandateRevoked`; nothing starts or resumes it while the PM Mandate does not hold. The PM may revive it once its authority holds again, which clears the project stop and starts one new Assignment under the unchanged Mandate.
- Ending a Project still cascades to its Tickets, and archiving still marks them archived and ends their Assignments. Revalidation also reports false for such a Project, so no later path can revive work under it.
- A paused Project is temporary: it keeps its PM Mandate and its Tickets' delegated authority, and soft or hard pause procedures remain the only pause-related stop.

### PM coordination messages

`orchestrator_project_ticket_message` is available only to the Project's PM, only for a Ticket whose `projectId` is that Project. It stores the text as a `note` Ticket Input under a deterministic id, so repeating the same text and Ticket adds it once; the Input is context and grants no authority, tools, Mandate or permission. The Project must be active: paused, archived and ended Projects refuse with `projectPaused`, `projectArchived` and `projectEnded`. Router-owned Tickets and Tickets in another Project refuse with `notProjectTicket`.

`wake` defaults false. A running Assignment gets the note delivered; a pending Assignment is started; with no Assignment the note waits. With `wake=true`, a retryable Ticket starts a new Assignment through the ordinary retry path; a non-retryable Ticket returns `not_started` and still leaves the note queued. `wake` never bypasses a paused/archived/ended Project. If the worker Session is reported archived, the note is queued, nothing is delivered or started, and the tool returns `not_started`; if the host cannot report archived Sessions, `wake=true` returns `queued` rather than claiming a start.

### PM revive after a manual stop

`orchestrator_project_ticket_revive` is available only to the Project's PM, for a Ticket whose `projectId` is that Project. It restores a Worker that a Project hard pause stopped: the Project must be `active`, the Ticket must be open and its latest Assignment ended, and the Ticket keeps its Mandate and worktree. Revive clears a remaining `project` stop and starts one new Assignment; it creates no Decision, Ticket or Mandate and does not widen `allowTools`.

- A `worker` stop (a person's stop of that one Worker) refuses revive with `manualStopNeedsUserApproval` until a person clears it. A person clears it with **Allow resume** on the Ticket or Project page, the same-origin `POST tickets/:id/allow-resume` route, which starts nothing; the PM's next revive starts the Assignment. The PM cannot clear a worker stop itself.
- After a Project resume, the `project` stops are already gone. A revive is then allowed for an open Ticket whose latest Assignment an operator stopped, which is the record the hard pause left; a Ticket whose Assignment ended for another reason, or that has no stop behind it, refuses with `notManuallyStopped`. Revive with an active Assignment refuses with `workerRunning`.
- The Project's state is checked first: a paused Project refuses with `projectPaused`, an archived one with `projectArchived`, an ended one with `projectEnded`, and any other PM Session with `notProjectPm`. A Ticket outside the Project refuses with `notProjectTicket`.

### Task handoffs

Only a Project's PM hands work over. A Worker can report that it needs another Worker, but it has no tool that changes its own Session, Assignment or Ticket.

- `orchestrator_project_ticket_handoff` (same Project, `transfer`) requires the Project active, the caller its PM, and the Ticket open with a running or pending Assignment. It ends the old Assignment with `endedReason: 'handedOff'` and stops its Session, keeps the Ticket, Mandate and worktree, records a `starting` `transfer` Handoff from the old Assignment/Session to `worker-<ticketId>-h<seq>`, briefs the new Worker, and starts the new Assignment. The Ticket stays open; no Decision is created. The new Assignment starts only after the old Worker's background cleanup succeeds, and the Handoff turns `accepted` in the same transaction as that launch; after the await it rechecks that its Handoff is still the `starting` transfer and the Assignment is still the Ticket's pending latest one, so a stop, retry or second transfer cannot start a Worker over newer state. A cleanup or recheck failure ends it as `handoffCleanupFailed`, marks the Handoff `failed`, leaves the Ticket open with a delivery error, and starts no replacement Session over the old jobs.
- `orchestrator_project_ticket_handoff_new_ticket` (same Project, `split`) answers a Worker's report that work is beyond its Ticket: it records the split as `starting`, stops the source Worker and waits for its background cleanup, then creates an independent Ticket in the same Project through the delegated path (its own Decision, Mandate, worktree and Worker), marks the Handoff accepted and ends the source Ticket with `outcome: 'handedOff'`. A failed cleanup or a concurrent change marks the Handoff `failed` and leaves the source open with a delivery error; no target Ticket or Worker exists then. The two Tickets are peers; there is no parent Ticket.
- `orchestrator_project_ticket_handoff_to_project` (cross-Project request, `split`) requires both Projects active, the source caller its PM, and the source Ticket open with an active Assignment. It records a `pending` Handoff on the source Ticket, bound to the source Assignment id and Session, and notifies the target PM; the source keeps running. Only a summary, unfinished items and links travel: the worktree, uncommitted changes and the source Mandate do not.
- `orchestrator_project_ticket_handoff_decide` is available only to the target Project's PM and only for a pending request addressed to that Project. Rejecting marks it rejected and leaves the source running. Accepting claims the request as `starting` (a concurrent accept or reject then refuses with `handoffHandled`), stops the source Worker and waits for its background cleanup; only then does it create a new, independent Ticket in the target Project through the ordinary delegated path (its own Decision, Mandate and worktree), record the accepted Handoff on both Tickets, and end the source Ticket with `outcome: 'handedOff'`. A failed cleanup or a change to either Ticket while waiting marks the Handoff `failed`, leaves the source open with a delivery error and creates nothing. It finalizes only while the source Project is active, the source Ticket has no manual stop, and its latest Assignment is the exact `from.assignmentId` in the recorded Session; an older request after Allow resume and revive is refused with `notHandoffable` and must be requested again. A record without `from.assignmentId` (from before this binding) is refused rather than bound to a newer Assignment. There is no parent Ticket and no `parentId`; `to`/`from` are peers. A paused, archived or ended target Project refuses, as do a caller that is not its PM and a request addressed elsewhere. Accepting an accepted request and rejecting a rejected one are idempotent; a contradictory, failed or in-flight decision refuses with `handoffHandled` and the PM receipt carries the recorded status, not the attempted action. Runtime startup fails any `starting` Handoff a host restart left and makes its source Ticket retryable without starting a Worker.
- A new Worker Session is `worker-<ticketId>-h<seq>`; the old Session keeps its history and loses its tools through the worker guard. Archiving, pausing or shutting down a Project reaches every Session the Ticket had.

### Project status and controls

A Project is `active`, `paused`, `ended` or `archived`.

- Only an active Project creates Tickets. `createProjectTickets` reports `projectPaused` while paused, `projectArchived` while archived and `projectEnded` after the end, and creates nothing in those cases. The PM tool surfaces the same refusal.
- Pausing has `pauseMode` `soft` (default) or `hard`. A soft pause blocks new Tickets and every new Assignment (create, retry, resume, attach) but lets existing running Assignments finish; it queues one structured `project_pause` notice to the PM asking for its round's report and then a stop. A hard pause stops the Project's Workers one by one through the same `Tickets.hardStopWorker` primitive a person's single-Worker stop uses: the current turn is cancelled, background work stopped, the pending/running Assignment ended as `stoppedByOperator`, and a `manualStop` with `scope: 'project'` written unless the Worker already carries a `worker` stop, which is kept. Each Worker stops in its own transaction; a failure is recorded and the rest still stop, the Project is set `paused`, and the Router receives one durable `projectPausedByUser` notice naming the Workers stopped and those that failed. A background cleanup that rejects moves the Worker from `stopped` to `failures` in both the API result and the notice, and the Project is not shown as having stopped it. Only the asynchronous `Engine.pauseProjectReport` emits that aggregate notice, after awaiting every cleanup; the synchronous `Engine.pauseProject` compatibility form awaits nothing and emits no `projectPausedByUser`, so it never reports a Worker stopped before its cleanup. Individual Worker stops are not relayed to the PM the pause also stopped. Repeating the same pause is idempotent, and a soft pause can be upgraded to hard, which stops work immediately. `POST projects/:id/pause` uses the asynchronous form and responds after those cleanups.
- Resuming restores `active`, clears `pauseMode`, does not restart any Assignment, and after a hard pause adds one `resumedFromHard` pending note telling the PM to re-read the Project and Tickets and synchronize before continuing. Resume clears the `project` stop labels of the Project's Tickets only; a person's `worker` stop stays until a person approves it, so the PM's revive is still refused for that Worker.
- A person's single-Worker stop is `POST tickets/:id/assignment/stop` with the current Assignment id. It uses the same primitive with `scope: 'worker'`, leaves the Ticket open, and records `manualStop` with `by: 'user'`. A retry or any other new Assignment on a Ticket with a stop is refused (`manualStopNeedsUserApproval` for `worker`, `manualStopProjectPaused` for `project`); starting work again needs Allow resume and, for a Project stop, the PM's revive. Stopping the whole Ticket (`POST tickets/:id/stop`) still ends it as stopped by a person and does not create a revivable stop.
- A person pressing **Stop generation** in a Worker's native DSH Session is the same hard stop: the Executor recognises the `turn/end` with `aborted`/`user` in `workerIdle`, records the turn's `idleAt`/`interruptedAt`, calls `Engine.stopAssignment` with the same primitive, ends the Assignment as `stoppedByOperator`, writes `manualStop.scope = 'worker'`, and sends the PM/Router `execution_status` receipt with `needs_user_approval`. This applies to every Ticket source, not only main-session Tickets. A cancel this plugin issued itself (operator stop, handoff, Project hard pause, shutdown, background cleanup) is marked expected before it is issued, against the exact Assignment and turn, and is never re-read as a native Stop; the marker survives an unrelated `agent/status running`, repeated idle events for the same turn still count as expected, and a later turn's end drops the marker so its native Stop is recognized. A Project-paused Ticket (`manualStop.scope = 'project'`) and an older handoff Assignment are ignored too. The Ticket's Worker is not restarted automatically.
- Ending a Project is idempotent and cascades to every still-open Ticket it owns, using the ordinary Ticket stop semantics: each ends as stopped by a person, its history, Session and directory stay. An already ended Project returns unchanged. The Project is not deleted.
- Archiving saves the active or paused status in `archivedFrom`, sets the Project to `archived`, marks every child Ticket archived, and ends every pending or running Assignment with `projectArchived`. It deletes nothing and starts no Assignment. The PM and every child Ticket Session are then archived through the host's `workspaceRegistry.archiveSession(id, { stopActivity: true })`; an unavailable host API or a failed call is returned in the operation result and logged, while the Project state remains archived. Archiving an ended Project is refused, and repeating an archive is idempotent.
- Unarchiving restores `archivedFrom`, clears each child Ticket's archive marker, and unarchives the PM and child Sessions. It does not restart or retry any Assignment automatically: an archived Ticket returns to its open or ended state and waits for a person or the PM. A person may still retry an open Ticket's ended Assignment explicitly.
- Pause and stop are management operations on `POST projects/:id/pause` (body `{ paused, mode?: 'soft' | 'hard' }`, default soft) and `POST projects/:id/stop`; archive/unarchive are `POST projects/:id/archive` and `POST projects/:id/unarchive`. The pause response reports `workers.stopped` and `workers.failures` from a hard pause. A person's approval to make a stopped Worker revivable is `POST tickets/:id/allow-resume`, which only clears a `worker` stop. All are management API and panel operations, admitted as the signed-in DSH Web operator; the main Session/Router has `orchestrator_project_archive` and `orchestrator_project_unarchive`, and the Project's PM has `orchestrator_project_ticket_revive`. Neither the main Session nor a Worker has Allow resume or revive, and the PM has no Project pause/stop/archive tool. A Project's page and its PM Session remain readable after archive or end.
- A native DSH archive is reconciled against `workspaceRegistry.archivedSessionIds`, not acted on directly by the event: `workspace/session-activity` (a pass-through waterfall) and `workspace/session-stop` only record a candidate and request a pass. A KV snapshot (`archive/session-snapshot`) and a 30-second unref fallback find additions and removals. Archiving `pm-<projectId>` archives the Project as above; archiving the current `worker-<ticketId>` or `worker-<ticketId>-h<seq>` ends only that Ticket's current Assignment with `sessionArchived`, leaves the Ticket open, does not retry it, and adds one `workerArchived` pending note to its Project without waking the PM; an older Session a handoff left changes nothing. Unarchiving the current worker changes no Ticket or Assignment and adds an optional `workerRestored` note; unarchiving the PM restores `archivedFrom`. Only this plugin's PM/worker Session ids are considered.
- Pending notes are part of `ProjectProfile.pendingNotes` and appear only in the PM's next composed prompt, after which they are cleared. They are also visible in `orchestrator_read project/<id>` until delivered. A worker archive while its Project is already archived adds no note, so the Project's own archive does not cascade into notes; the same reconcile is idempotent and does not loop on the archive/unarchive it caused itself.

### Report routing

A Worker's status reports, questions for a person, failure receipts, turn-end notices and stop receipts are relays. A Router-owned Ticket's relays go to the main Session, as before. A Project Ticket's relays go to its Project's PM Session (`project.pmSessionId`) while the Project is active or paused; an ended or archived Project, or a Project that is gone, falls back to the main Session. The PM Session need not be loaded yet: the relay handler resolves it through DSH. The main Session therefore receives no child `worker_report` or `worker_attention`, and child lifecycle notices are not sent to it.

The PM reads a child's report or attention with `orchestrator_read ticket/<id>` and its Project's child list with `project/<id>/tickets`. If a child attention needs a person, the PM records the blocker in `orchestrator_project_report`; it does not answer the child directly in this phase. Each Project report is also relayed to the main Session once as a structured `project_report` (`project_id`, `title`, `status`, `summary`, `at`, `read`), with an idempotent request id, while the Project's `latestReport` remains what the Project page shows. The Router thus receives Project-level reports, not every child report.

The Project Profiles, their latest reports and their child Ticket ids are read through `GET projects` and `GET projects/:id`, and through the `projects`, `project/<id>` and `project/<id>/tickets` read resources.

## Strength

| Strength | Cases |
| --- | --- |
| explicit | A person on the list addresses the agent, or follows up on a Thread that already has a Ticket; a cell of the admission table set to explicit request |
| inferred | A person not on the list follows up on a Thread with a Ticket while their admission cell is inferred; a cell of the admission table set to inferred candidate; a message of a bot on the Source's bot list that addresses the agent or arrives where the Source receives every message |
| not admitted | Any other bot's message, everything the admission table ignores, and every inferred case while the accept mode is `off` |

For an unlisted person, a follow-up never overrides an `ignore` admission cell: only an inferred or explicit cell admits it, and an explicit cell takes precedence even on a Thread with Tickets and works in every accept mode. An ignored cell refuses the follow-up however many Tickets the Thread has, and the inferring cases are not admitted in `off` mode. Messages on Threads followed only for context use the admission table instead of follow-up strength.

## Admission

Each Source's Policy has an admission table. Its rows are receiving scopes:

- **Feishu:** each configured chat, other chats the bot receives mentions from, and direct messages. Other chats are received only when **其他群** is set to **仅 @** on the Feishu card.
- **GitHub:** new Issues, new pull requests, comments and the default branch's CI.

A row has up to three cells. Each cell decides whether a message becomes an explicit request, an inferred candidate or nothing:

| Cell | Choices | Default |
| --- | --- | --- |
| On the list, not addressing the agent | inferred, ignore | inferred |
| Not on the list, addressing the agent | explicit, inferred, ignore | ignore |
| Not on the list, not addressing the agent | inferred, ignore | ignore |

Cells for unaddressed messages are available only where the Source receives every message, such as a Feishu chat set to **全部消息** or a GitHub scope with its receive-all switch enabled. A CI result has no sender, so its row offers only the last cell. Bot messages use the bot list instead of these cells.

Setting the unlisted-addressed cell to explicit lets anyone in that scope request work by mentioning the agent. This can be useful for a dedicated support chat. Inferred candidates still depend on the accept mode. Follow-ups of listed senders bypass this table. An unlisted person's follow-up still reads their own cell: an `ignore` cell refuses it even on a Thread with Tickets, so a follow-up never overrides an `ignore` admission cell; an `inferred` cell makes it an inferred candidate, and an explicit cell makes it an explicit request.

The admission table is part of the Policy version. For an ordinary Ticket, weakening a cell does not immediately stop it; it can revoke the Mandate when revalidated before resuming. A delegated Ticket whose PM authority lapses is stopped immediately instead (see Revoking delegated authority).

### Bots and automated reviewers

The host recognizes GitHub Apps, logins ending in `[bot]`, and Feishu bots as bots. A Source can list bots such as `dependabot[bot]` whose messages may become inferred candidates. They must either address the agent or post in a scope that receives every message. They cannot make explicit requests or stop Tickets.

An automated reviewer using an ordinary account counts as a person to the host. Its comments reach subscribed Tickets and generate follow-up notices. Team prompt text must identify such accounts as automated reviewers.

## Routing candidates

The main Session routes explicit candidates with `orchestrator_route`. One call can contain several accept, attach, stop or ignore decisions. Each item is processed independently: a refused item or a missing field does not prevent the others from running.

An inferred candidate normally needs a full assessment. There is one shortcut: if its card clearly touches no enabled rule, such as plain chat or unrelated discussion, the main Session may ignore it directly. The Decision records `ignoredFromCard` to distinguish this from a rule assessment. The main Session reads the enabled rules in its Policy prompt section.

Accepting an inferred candidate always requires an assessment. Direct accept refuses a Trigger that the gate did not admit as explicit.

## Accept mode and rules

The accept mode is part of the Policy:

| Mode | Effect |
| --- | --- |
| `off` | Nothing inferred becomes a candidate, such as an unaddressed message, a bot's message or the follow-up of a person not on the list |
| `observe` (default) | Inferred candidates are assessed; a positive assessment is recorded as ignore marked "would accept", and nothing is accepted |
| `auto` | A positive assessment of an inferred candidate accepts it |

Explicit requests work in every mode. Start in `observe` and switch to `auto` after reviewing the recorded Decisions. Each assessment judges every enabled rule exactly once, whether it matches or not. A proactive accept requires at least one matching rule.

Each rule describes a kind of proactive work. The Ticket's Mandate records the matched rules, and its Executor receives their names and instructions.

For that Ticket, a rule's process and communication requirements override the defaults. A silence rule can suppress an acknowledgement; a review rule can name the required reviewer and approval before merge. Requirements that apply to every Ticket belong in team prompt sections instead.

## Policy version

Rules, accept mode and each Source's Policy form the Policy version. Every Mandate records the version under which it was accepted.

A version change discards running Evals and queues their Triggers again. It also sends a policy-changed Input to each affected live Ticket. The Input explains whether:

- a matched rule changed, including its new text, or no longer applies;
- the requester may no longer start work;
- proactive work is no longer accepted, for example because the mode changed from `auto`; or
- the Project PM Mandate behind a delegated Ticket no longer holds (`delegatedAuthority: false`). Its running or pending Assignment is stopped, and the Ticket cannot retry, wake or be revived until the Mandate holds again.

Unaffected Tickets receive no notice. Apart from a delegated Ticket whose PM authority lapsed, the change does not immediately revoke live Tickets' Mandates.

Source configuration is separate from Policy. It controls what enters the system: which chats are read and whether a scope receives all messages or only mentions. A Mandate records its Source and receiving scope. Resuming needs the Source to still listen to the Thread, but does not require it to still receive every message there.

Replies wait while their Source is off. They are dropped if the Source no longer listens to their destination.

A condition on what the Executor may do with its own result, such as when it may merge, does not decide who may authorize work. It is part of the agent's instructions, not of the Policy.

## Resume and stop

An ended Ticket keeps its Mandate. A person's message on one of its own Threads can resume the same work without a new Eval or Decision, regardless of who sent it. Bots and CI do not wake ended Tickets. The Executor decides whether the request fits the scope and ends the round if it does not.

Only three operations change a Mandate: accept creates it, a person's stop withdraws it, and failed revalidation revokes it. A Ticket stopped by a person stays ended and receives nothing more. Work requested there needs a new accept.

### Revalidation before resume

The Source must still listen to the original Thread. The remaining checks depend on the Mandate's basis:

- An explicit follow-up Mandate passes.
- An inferred Mandate needs `auto` mode and its matched rules still enabled.
- A Mandate admitted by a table cell must still receive at least its original strength under today's table and sender membership. Removing a sender from the list can therefore revoke a Mandate accepted through the listed-sender cell.
- A bot's Mandate requires that bot to remain on the Source's bot list. Inferred table and bot Mandates also need `auto` mode and enabled matched rules.
- Other Mandates require the sender to remain on the Source's allowed list.
- A `delegated` Mandate requires its Project to still exist, match the recorded `pmSessionId`, and be active or paused; its current PM Mandate must then still hold under today's settings, revalidated with a base Policy. A missing or mismatched Project, an ended or archived Project, and a PM Mandate that no longer holds all revoke it. A paused Project is not a revocation.

If revalidation fails, the Ticket stays ended and takes none of its waiting messages. Each message is treated as having reached no Ticket; if no other Ticket owns it, it goes to Eval. The main Session is not told it reached a worker. This also applies after a processing pause. Attaching to the Ticket is refused, and further work requires a new accept. A delegated Ticket whose PM authority lapses instead stays open and is stopped; retry, wake and revive refuse it until the authority holds again (see Revoking delegated authority).

- **A person saying "stop" in a Thread is an ordinary Trigger,** and Eval decides stop. An Executor cannot declare that a person asked it to stop.
- **Stop in the panel is a command.** It acts on the Ticket directly and is recorded as a manual stop.
- **Waiting conditions belong to Sources.** A condition such as "no assignee for N hours" would be a Source that waits and checks again itself; Eval never waits.

## When Eval does not finish

The time limit starts when the candidate reaches the main Session. Time spent waiting for delivery does not count, and an undelivered candidate never expires.

An expired Eval queues its Triggers for another attempt. After two consecutive retries, the third expiry records `unavailable`. An assessment failure also records `unavailable`; a later Trigger can start a new Eval. A Policy change or a decision made against an outdated Policy records `unavailable` and immediately queues the batch under the current version.

The `evals` health entry reports unresolved unavailable Decisions from the last hour. `scripts/dsh-superagent status` includes that error.

The panel asks for human attention only when the unavailable Decision is less than 24 hours old, is still the latest Decision on its Thread, has not been dismissed, and the Thread is neither queued nor evaluating. A person can evaluate the Trigger again or dismiss the problem.
