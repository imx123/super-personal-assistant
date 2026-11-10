# 002 Authorization

Authorization determines who may start work and what that work may include. This document builds on [001 Domain model](001-domain.md).

The host enforces allowed lists, rules and Mandates. Messages, comments and quoted documents are inputs to a decision; they cannot change those permissions.

## Two paths for a Trigger

### Eval: deciding whether to start work

The Source records whether a message addresses the agent: `mention` for a mention of the bot or agent account, and `direct` for a direct message. The gate checks the sender and the Source's Policy:

- An allowed person who addresses the agent makes an explicit request.
- A person's follow-up on a Thread with Tickets follows the rules below.
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
- The PM Session (`pm-<projectId>`) runs under `dsh-superagent-pm` with three tools: `orchestrator_read`, `orchestrator_project_ticket_create` and `orchestrator_project_report`. It is a small Router: it keeps the Project's goal in view, delegates its Tickets and reports to the Project. Its read tool accepts its own `project/<id>`, its `project/<id>/tickets`, and a `ticket/<id>` only when that Ticket's `projectId` is its Project; every other resource is refused. It takes the `auto` permission preset when the host offers it, else `workspace-write`, then `read-only`; full access only when none exists.

### A PM's delegated Tickets

The PM creates Tickets only inside its own Project, never arbitrary work, with `orchestrator_project_ticket_create`. One call takes 1–5 tasks, each with a title, goal, optional scope and note, optional worktree name, optional `allow_tools`, and optional external Threads.

- The Engine requires the Project's own PM Session id and validates that the Project is active. An unknown Project, a non-PM caller, a call that omits the PM Session, or an ended Project creates nothing.
- Each task records one Trigger of the built-in `internal` Source: actor `{source: 'internal', id: pmSessionId}`, `human: false`, no addressed mark, and one internal Thread of its own.
- A record-only Eval with a real Eval id records a `delegated` Decision, without asking the assessor and without delivering a candidate. Its basis is `{via: 'delegated', projectId, pmSessionId}`; its strength comes from the PM Mandate. The Decision names the Ticket and the Project, and records the Ticket's Mandate.
- The Ticket's Mandate copies the PM Mandate's strength, Policy version and actor, narrows the scope to the task's scope (or goal), and carries the delegated basis. `Policy.revalidate` accepts a delegated Mandate directly: the PM Mandate is its authority, so no external allowed list is checked.
- A task's `allow_tools` becomes the Ticket's `Mandate.allowTools`. Omitted or empty means the PM Mandate's own `allowTools` when it has one, else no restriction (every Worker tool). A task may only name known Worker tools, once each, at most 32, and may only narrow a PM Mandate's list, never widen it; an invalid list refuses the whole batch. `WORK_TOOLS` is the single declared set.
- `allowTools` narrows tool visibility only. It is not a filesystem, permission or sandbox boundary, and policy still governs what the work may be. The Executor's `workOnly` gives a Worker only the intersection of its Mandate's list and the tools the host actually offers; a subagent of that Worker inherits the same intersection and cannot reach a forbidden tool.
- The Ticket has no Channel and does not subscribe to the Project's source Thread. It subscribes only to the external Threads its task names; a `contextOnly` Thread is recorded in `Thread.context`, so its messages reach the worker without granting authority and do not resume an ended Ticket. Unknown thread keys or malformed references refuse the whole batch.
- Batch atomicity and idempotence: if one task is invalid, no Trigger, Decision or Ticket from the call remains. A repeated call reuses the Ticket each task position already produced.
- The PM remains the Project's only voice outward; a child Ticket does not reply to its external Threads.

### Project status and controls

A Project is `active`, `paused` or `ended`.

- Only an active Project creates Tickets. `createProjectTickets` reports `projectPaused` while paused and `projectEnded` after the end, and creates nothing in either case. The PM tool surfaces the same refusal.
- Pausing or resuming changes only the Project status: an active Project becomes paused, a paused one becomes active again, and repeating the same request changes nothing. Existing child Tickets keep running and their reports still reach the PM while paused.
- Ending a Project is idempotent and cascades to every still-open Ticket it owns, using the ordinary Ticket stop semantics: each ends as stopped by a person, its history, Session and directory stay. An already ended Project returns unchanged. The Project is not deleted.
- Pause and stop are management operations on `POST projects/:id/pause` and `POST projects/:id/stop`, available only through the same-origin management API and panel. Neither the PM nor a Worker has a tool for them. After a Project ends its page remains readable and its PM Session is kept for viewing.

### Report routing

A Worker's status reports, questions for a person, failure receipts, turn-end notices and stop receipts are relays. A Router-owned Ticket's relays go to the main Session, as before. A Project Ticket's relays go to its Project's PM Session (`project.pmSessionId`) while the Project is active or paused; an ended Project, or a Project that is gone, falls back to the main Session. The PM Session need not be loaded yet: the relay handler resolves it through DSH. The main Session therefore receives no child `worker_report` or `worker_attention`, and child lifecycle notices are not sent to it.

The PM reads a child's report or attention with `orchestrator_read ticket/<id>` and its Project's child list with `project/<id>/tickets`. If a child attention needs a person, the PM records the blocker in `orchestrator_project_report`; it does not answer the child directly in this phase. Each Project report is also relayed to the main Session once as a structured `project_report` (`project_id`, `title`, `status`, `summary`, `at`, `read`), with an idempotent request id, while the Project's `latestReport` remains what the Project page shows. The Router thus receives Project-level reports, not every child report.

The Project Profiles, their latest reports and their child Ticket ids are read through `GET projects` and `GET projects/:id`, and through the `projects`, `project/<id>` and `project/<id>/tickets` read resources.

## Strength

| Strength | Cases |
| --- | --- |
| explicit | A person on the list addresses the agent, or follows up on a Thread that already has a Ticket; a cell of the admission table set to explicit request |
| inferred | A person not on the list follows up on a Thread with a Ticket, unless their cell of the admission table is explicit; a cell of the admission table set to inferred candidate; a message of a bot on the Source's bot list that addresses the agent or arrives where the Source receives every message |
| not admitted | Any other bot's message, everything the admission table ignores, and every inferred case while the accept mode is `off` |

For an unlisted person, an explicit admission cell takes precedence even on a Thread with Tickets and works in every accept mode. Otherwise their follow-up is inferred and is not admitted in `off` mode. Messages on Threads followed only for context use the admission table instead of follow-up strength.

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

Setting the unlisted-addressed cell to explicit lets anyone in that scope request work by mentioning the agent. This can be useful for a dedicated support chat. Inferred candidates still depend on the accept mode. Follow-ups normally bypass this table, except that an explicit cell still grants explicit strength.

The admission table is part of the Policy version. Weakening a cell does not immediately stop open Tickets accepted under it. It can revoke their Mandates when they are revalidated before resuming.

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
- the requester may no longer start work; or
- proactive work is no longer accepted, for example because the mode changed from `auto`.

Unaffected Tickets receive no notice. The change does not immediately revoke live Tickets' Mandates.

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

If revalidation fails, the Ticket stays ended and takes none of its waiting messages. Each message is treated as having reached no Ticket; if no other Ticket owns it, it goes to Eval. The main Session is not told it reached a worker. This also applies after a processing pause. Attaching to the Ticket is refused, and further work requires a new accept.

- **A person saying "stop" in a Thread is an ordinary Trigger,** and Eval decides stop. An Executor cannot declare that a person asked it to stop.
- **Stop in the panel is a command.** It acts on the Ticket directly and is recorded as a manual stop.
- **Waiting conditions belong to Sources.** A condition such as "no assignee for N hours" would be a Source that waits and checks again itself; Eval never waits.

## When Eval does not finish

The time limit starts when the candidate reaches the main Session. Time spent waiting for delivery does not count, and an undelivered candidate never expires.

An expired Eval queues its Triggers for another attempt. After two consecutive retries, the third expiry records `unavailable`. An assessment failure also records `unavailable`; a later Trigger can start a new Eval. A Policy change or a decision made against an outdated Policy records `unavailable` and immediately queues the batch under the current version.

The `evals` health entry reports unresolved unavailable Decisions from the last hour. `scripts/dsh-superagent status` includes that error.

The panel asks for human attention only when the unavailable Decision is less than 24 hours old, is still the latest Decision on its Thread, has not been dismissed, and the Thread is neither queued nor evaluating. A person can evaluate the Trigger again or dismiss the problem.
