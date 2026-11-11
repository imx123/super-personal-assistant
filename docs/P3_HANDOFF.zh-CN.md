# P3 任务交接设计

> 状态：P3-A、P3-B 与两轮 P3 审核修复（原生 DSH 停止、cleanup 失败传播、Handoff assignment 绑定、同 Project split、异步 split/跨 Project 接收、starting 状态与启动恢复、transfer 并发复核、cancel 标记按回合绑定）均已实现。本文保留设计边界与决策记录；实现细节见 `docs/001`、`docs/002`、`docs/005`、`docs/007` 与 BASELINE。

## 1. 先区分三种“交接”

| 机制 | 做什么 | 是否本次任务交接 |
| --- | --- | --- |
| `orchestrator_report` / `orchestrator_reply` | Worker 向 Router/人交付结果、问题或 attention | 否，是结果交付 |
| `orchestrator_trigger_handback` | Worker 把一条不属于本 Ticket 的**人消息/Trigger**退回 Router | 否，是消息路由 |
| 任务交接 | 把正在执行的工作所有权交给另一个 Agent，或把越界工作拆到新的 Ticket | 是 |

`handback` 只处理“这条消息不是我的”，不转移 Ticket、Assignment、worktree、Mandate。

## 2. 已确定的边界

- **交接只发生在 Agent 之间**。人不作为 handoff 的目标。
- 人提出暂停某个任务时，由上级 Agent 按现有 stop 流程终止：
  - 单张 Ticket：soft = `stopAssignment`（只停当前 Assignment，Ticket 保持 open）；hard = `stopTicket`（结束 Ticket）；
  - Project 范围：soft/hard = `pauseProject` 的 soft/hard；必要时 `stopProject`；
  - 不新增 `human-owned` 状态，也不要求人“接管 Session”。
- **人直接按 Session 停止按钮 = hard stop**，与上级 Agent 执行 hard stop 同义，不走 soft 收尾；只停目标 Session/任务，其他 Worker 默认继续；停止后必须给上级 Agent 留一条“用户已终止某 Session”的提醒，由上级判断影响或提问。
- **不能自动重启用户终止的单个 Worker**；上级 Agent 可以自行决定其他 Worker（继续、暂停、停止、handoff）。要恢复被单个 Worker 停止的 Worker，必须由人明确批准。
- **Project 整体 hard pause 的 Worker 可以在 Project resume 后由 PM 主动恢复**；Project resume 会清除这些 Worker 的 `scope: 'project'` 人工停止标签。
- 两种人工停止标签必须分开：单个 Worker 停止写 `scope: 'worker'`，Project hard pause 写 `scope: 'project'`；Project resume 只清 project 标签，不清 worker 标签。
- **PM 的 Project 控制增加一个“项目暂停”入口**，按下后选择 soft 或 hard：
  - soft：现有 Project soft pause，阻止新 Ticket/Assignment，让 PM 收尾；
  - hard：一次性结束 Project 内所有 Worker 的 Assignment、取消 Project 内所有 Session 的当前回合，并提醒 Router“该 Project 被人工暂停”；
  - Project 级暂停与单 Session stop 是两个不同作用域。
- Worker 不能自行换 Session；它只能报告“需要接手”，由 PM 执行 handoff。
- 跨 Project 由 **目标 PM 最终决定**是否接收；源 PM 负责结束源 Ticket、提供摘要和链接。
- 跨 Project 只传摘要、Ticket/Thread 链接和未完成项；不复制/移动 worktree，不传未提交改动。
- Project 处于 paused 时拒绝 handoff，先 resume 或走 stop。
- 交接目标是 **同 Project + 跨 Project**。
- 同一 Ticket 换执行者时，**沿用原 worktree**，旧 Session 停止，新 Worker Session 命名为 `worker-<ticketId>-h<seq>`。
- 跨 Project 不移动同一 Ticket；旧 Ticket 结束，目标 Project 新建独立 Ticket（新 Mandate）。
- 不建立父 Ticket、不引入 `parentId`。

## 3. 两种交接形态

### 3.1 同 Project：同一 Ticket 换执行者

适用：当前 Worker 无法继续、需要另一个 Worker 接手，但 Ticket、Project、Mandate、worktree 都不变。

流程：

1. 发起方：Worker 只报告“需要接手”，由 PM 发起 handoff：原因、摘要、待办、上下文链接、建议目标（新 Worker）。
2. 上级 PM 批准。PM 是该 Project 的上级，不经过 Router。
3. PM 结束旧 Assignment（`endedReason: 'handedOff'`），停止旧 Session 的自动回合，并等待旧 Worker 的后台 cleanup 成功；
4. cleanup 成功后同一 Ticket 的新 Assignment 才启动，新 Session 为 `worker-<ticketId>-h<seq>`；cleanup 失败则新 Assignment 结束为 `handoffCleanupFailed`、Handoff 记为 `failed`、Ticket 保持 open 并写 delivery error；
5. 新 Session 收到 handoff 说明；Ticket 历史保留，不创建新 Decision/Mandate；
6. Ticket 保持 open；worktree 不变。

约束：

- 旧 Assignment 必须已经结束或可安全结束；不能两个 Assignment 同时写同一 worktree。
- 旧 Worker 的后台 cleanup 成功前，替代 Worker 不得准备目录或启动；等待期间 Ticket 被停止、重试或再次 handoff 时，旧 Handoff 记为 `failed`，不得启动替代 Worker。
- 新 Session 继承原 Ticket 的 Mandate、Project scope 和 `allowTools` 限制；不扩大权限。
- handoff 记录必须包含 from/to session、原因、摘要、批准者；旧 Session 的历史不删除。
- 同一 Ticket 多次 handoff 使用递增后缀 `h1`、`h2`……。

待确认：无。Worker 只报告请求，PM 执行；Worker 没有直接换 Session 的工具。

### 3.2 跨 Project：旧 Ticket 结束，新 Project 新建 Ticket

适用：工作超出当前 Project 的目标/权限，或目标 Project 的 PM 更合适。

流程：

1. 源 PM 向目标 PM 提交跨 Project handoff 请求：目标 Project、原因、摘要、已完成/待完成、上下文链接。
2. 目标 PM 决定是否接收；接收后在其 Project 内创建新 Ticket（独立 Mandate、独立 worktree）。
3. 源 PM 结束源 Ticket，结果记为 `handedOff`；不归档、不删除历史。
4. 两个 Ticket 用 handoff 记录双向关联，**不使用 parentId**。
5. 只传摘要、Ticket/Thread 链接和未完成项；不移动 worktree、不复制未提交改动；新 Ticket 从自己的目录开始。
6. 目标 PM 接收时先停止源 Worker 并等待后台 cleanup 成功，之后才创建目标 Ticket 并记录 accepted；cleanup 失败或等待期间源 Ticket 被停止/改派时，Handoff 记为 `failed`、源 Ticket 保持 open 并写 delivery error，不创建目标 Ticket。

约束：

- 跨 Project 必须重新经过目标 Project 的 PM Mandate，不能沿用源 Ticket 的 Mandate。
- 源 Project 和目标 Project 的 PM 都不能单方面改写对方 Project。
- 目标 Ticket 是独立 Ticket，不是源 Ticket 的子票。
- 目标 PM 有最终接收决定权；源 PM 只负责结束源 Ticket 并提供摘要。

### 3.3 人工直接停止 Session 与上级提醒

人直接按 Session 停止按钮时，按 **hard stop** 处理，不走 soft 收尾，但**作用域只限按钮指向的那个 Session/任务**：

- 停止 Worker Session：结束该 Worker 对应的 Assignment/Ticket 范围；其他 Worker 不受影响；
- 停止 PM Session：只停 PM Session；child Worker 默认继续运行，不自动跟着停；
- 只有明确按 Project 级“项目暂停”或 Project stop，才作用于整个 Project；
- **不能自动重启被人工终止的 Worker**；上级可以自行决定其他 Worker 继续/暂停/停止/handoff，但要重启被终止的 Worker，必须由人明确要求；
- 不自动重试、不自动恢复，也不自动连带停止其他 Worker；
- **必须给上级 Agent 留一条 durable 提醒**：`用户已终止某 Session`，包含 sessionId、所属 Ticket/Project、停止范围和 at；还要说明哪些 Worker/任务未受影响，避免上级误判。
- 上级 Agent 自己判断影响并处理：继续、handoff、pause/stop 更大范围，或向人提问等指示；不得把单 Session stop 静默扩大成 Project 暂停。

提醒的载体：

- 父级是 PM：进入 `Project.pendingNotes`，kind 例如 `userStopped`；PM 下一次 prompt 读取，不主动唤醒；
- 父级是 Router：进入主 Session 的待处理提醒/notice；只告知，不自动改变 Project/Ticket/其他 Session 状态；
- 若被停止的是 PM Session：Router 收到提醒，由 Router 决定是否暂停/停止 Project、是否让 child Worker 继续，或向人提问；child Worker 不会因 PM Session 停止自动终止。

这条不是 handoff，不创建 `Handoff` 记录；它只复用 hard stop 流程并增加 parent notification。

P3 审核补充：真实 DSH 的“停止生成”会让 `turn/end` 为 `aborted` + `reason.kind='user'`，但不会自动结束 Assignment。`DshExecutor.workerIdle` 把它识别为人工 hard stop，先把该回合的 `idleAt`/`interruptedAt` 记到 Assignment（沿用旧 `interrupt_turn` 路径的回合记录），再调用同一个 `Engine.stopAssignment`，从而结束 Assignment、写 `manualStop.scope='worker'` 并发 hard-stop 的 `execution_status`（带 `needs_user_approval`）。该识别对**所有来源**的 Ticket 生效（不只 main-session），并有测试覆盖。插件自己发起的 cancel（operator stop、handoff、Project hard pause、shutdown、后台清理）必须在发出前记录 expected；标记绑定到具体 Assignment 与回合号，`agent/status running` 不会清掉它，同一回合的重复 idle 仍按 expected 处理，而更晚回合的结束会丢弃标记并按原生 Stop 处理。已有 `manualStop.scope='project'` 的 Ticket 和 handoff 旧 Assignment 的 turn end 也忽略。

### 3.4 PM 的“项目暂停”按钮

Project 控制中增加专门的**项目暂停**入口，按下后明确选择：

| 模式 | 行为 |
| --- | --- |
| soft | 复用 `pauseProject(soft)`：阻止新 Ticket/Assignment，已有 running Assignment 继续，通知 PM 完成本轮汇报后停止 |
| hard | 对 Project 内每个 Worker **逐个执行同一个 worker hard-stop 原语**，再设置 Project `paused`；不能直接批量改 Assignment 状态绕过 Session 取消/清理 |

hard 的语义要求：

- **必须复用单 Worker 停止按钮的同一命令/路径**（同一个 `hardStopWorker`，包含取消当前 turn、停止 background work、结束 Assignment、Ticket 状态和停止记录）；不能写一套“项目批量停止”捷径，否则同一个 Worker 经两条路径会得到不同状态。
- 每个 Worker 的 Assignment、Session、Ticket 结果必须与手工逐个按停止一致；差异只能来自停止顺序/并发，不能来自不同实现。
- 外层额外做两件事：Project 状态置 `paused`；Router 收到一条聚合 `projectPausedByUser` 提醒，说明 Project 被人工暂停、模式和范围。
- 聚合提醒只能在所有已启动的 cleanup 结束后发出（`pauseProjectReport`）：同步 `pauseProject` 只改状态、不等待 cleanup，也不发聚合提醒，避免在失败 cleanup 尚未结束时把 Worker 报成已停止。
- 若某个 Worker 停止失败：继续处理其余 Worker，记录失败并在 Router 提醒中列出；Project 不能显示为“全部已停止”，失败项按同一原语重试或由人处理。
- PM Session 是 Project 级控制对象，由 hard pause 单独取消；不要把它算进“逐个 Worker”循环，也不要让 PM 的取消改变单个 Worker 的停止结果。
- 每个被 Project hard pause 停下的 Worker 写入 `manualStop.scope = 'project'`；如果该 Worker 事先已有 `scope = 'worker'` 标签，保留原标签，不覆盖。
- Project resume（Router 经用户同意，或用户在 PM 界面点恢复）只删除本 Project 所有 Worker 的 `scope = 'project'` 标签；PM 随后可主动恢复这些 Worker。
- 单个 Worker 停止写 `manualStop.scope = 'worker'`；Project resume 不清除它，PM 不能主动恢复，必须由用户明确批准后清除标签。
- 不自动重启任何被暂停的 Worker；恢复必须经 Project resume / 用户批准 / 人工指示。
- 与单 Session stop 的 `userStopped` 提醒分开：Project hard pause 对外只发聚合提醒；每个 Worker 的停止记录仍保留，但不再向已停止的 PM 逐个投递。
- P3-A 实现补充：单 Worker 停止与 Project hard pause 的 Assignment 都结束为 `stoppedByOperator`（唯一的 `Tickets.hardStopWorker`）；单 Worker 停止的父级回执复用 `execution_status`，并附 `manual_stop` 与 `needs_user_approval`；Project hard pause 的逐 Worker 回执被 `DshExecutor` 抑制，只发一条 `projectPausedByUser`。R2 修复补充：这条聚合事件仅由异步 `pauseProjectReport` 在等待全部 cleanup 后发出；同步 `pauseProject` 不再提前发，避免失败 cleanup 被报成已停止；HTTP `POST projects/:id/pause` 仍走异步版。
- P3-A 实现补充：Project resume 清掉 `project` 标签后，PM 的 revive 以“open、最新 Assignment 由 operator 停止且无标签”为可恢复记录；因此用户批准（清 `worker` 标签）后同一条 revive 也能生效。PM revive 不会重开已结束的 Ticket。

## 4. 数据模型草案

不新增 `Dispatch` 层，也不新增父子 Ticket。建议：

```ts
type HandoffKind = 'transfer' | 'split'

interface Handoff {
  id: string
  at: string
  kind: HandoffKind
  // 同 Project transfer: from/to 同一个 ticketId，不同 sessionId
  // 跨 Project split: from/to 不同 ticketId/projectId
  from: { ticketId: string; projectId: string; sessionId: string }
  to: { ticketId: string; projectId: string; sessionId?: string }
  reason: string
  summary: string
  approvedBy: { kind: 'pm' | 'router'; sessionId?: string }
}
```

- `Ticket.manualStop?: ManualStop`，区分来源：

```ts
interface ManualStop {
  at: string
  scope: 'worker' | 'project'
  by: string
  sessionId?: string
  reason?: string
}
```

- 单个 Worker 停止：`scope: 'worker'`；PM 的 revive/resume 工具检测到后拒绝，返回“需要用户批准”。
- Project hard pause：给命中的 Worker 写 `scope: 'project'`；Project resume 只清除这些标签，PM 可主动恢复。
- Project resume 和用户批准使用独立入口，不能由 PM 自行清除 `scope: 'worker'`。
- `Ticket.handoffs?: Handoff[]` 或独立 `handoff` 表；优先不做独立聚合，避免多一层。
- `Assignment.endedReason` 增加 `'handedOff'`。
- `Ticket.ended.outcome` 增加 `'handedOff'`（仅跨 Project split 的源 Ticket 使用）。
- 同 Project transfer 不结束 Ticket，只结束旧 Assignment。
- 新 Session id：`worker-<ticketId>-h<seq>`；所有按 `workerSessionId(ticketId)` 的查找需要支持 handoff session 列表，不能假设唯一。

P3-B 实现补充：

- `Assignment.sessionId?: string` 记录该派工实际运行的 Worker Session；旧记录没有时按 `worker-<ticketId>` 解释。`workerSessionId(ticketId, seq)` 统一生成 id，`ticketOfSession` 解析 `-h<n>` 后缀，`latestSessionId`/`workerSessionsOf` 服务查找、报告路由、面板链接、归档、暂停和关停。
- `Handoff` 增加 `status: 'pending' | 'starting' | 'accepted' | 'rejected' | 'failed'`、`failure`（失败原因）、`request`（目标 Project 应建的新 Ticket 任务）、`approvedBy`、`decidedAt`、`decisionReason`；`from`/`to` 的 `ticketId` 在 pending 请求阶段只有 `from` 与 `to.projectId`。跨 Project 记录在同一 `Ticket.handoffs` 数组上双向保存，不建独立表、不加 `parentId`。`starting` 表示已停止源 Worker、正在等待 cleanup 或第二阶段提交：此期间只有发起方持有该请求，其他决策一律 `handoffHandled`；进程重启后由启动恢复把它改成 `failed`。`failed` 只用于 cleanup/启动失败或恢复，绝不与 `accepted` 并存于同一记录。
- 同 Project transfer：旧 Assignment 结束为 `handedOff`，旧 Session 取消并停后台；Ticket/Mandate/worktree 不变；新 Assignment 的 Session 为 `-h<seq>`，并通过 text Input 收到交接摘要；Ticket 保持 open，不建 Decision。
- 跨 Project：源 PM 用 `orchestrator_project_ticket_handoff_to_project` 写 pending 并通知目标 PM；目标 PM 用 `orchestrator_project_ticket_handoff_decide` 接收/拒绝。接收时先停源 Worker 并等待 cleanup，成功后才经正常 delegated 路径在目标 Project 新建独立 Ticket（新 Decision/Mandate/worktree），双向写 accepted Handoff，源 Ticket 以 `handedOff` 结束；cleanup 失败或等待期间源 Ticket 被停止/改派、目标 Project 被暂停时，Handoff 记为 `failed`、源 Ticket 保持 open 并写 delivery error，不创建目标 Ticket。不移动/复制 worktree，不传未提交改动。目标 paused/archived/ended 或非其 PM 均拒绝。
- PM 工具边界增加 `orchestrator_project_ticket_handoff`、`orchestrator_project_ticket_handoff_to_project`、`orchestrator_project_ticket_handoff_decide`；Worker 只能报告需要接手，没有换 Session 的工具。

P3 审核修复补充：

- `HandoffEndpoint.assignmentId`：源端必须记录请求时的 Assignment id，目标端在接收时记录目标 Ticket 的首个 Assignment。跨 Project 请求 id 包含源 Assignment/Session；transfer 后换到 `-h1` 的同一 Ticket 再发同样内容会得到新请求。接收时必须 `latestAssignment(origin).id === from.assignmentId` 且 Session 匹配；用户批准 + PM revive 后的新 Assignment 会拒绝。升级前没有 `sessionId` 的 Assignment 用 `assignmentSessionId` 推导 base Session；没有 `assignmentId` 的旧 Handoff 记录明确拒绝并要求重新请求，不静默绑定新 Assignment。
- 后台 cleanup 失败传播：`Executor.stop` 可返回 cleanup Promise；`DshExecutor.track`/`stopping` 保留 rejection，launch 在准备目录/创建 Session 前等待，失败即不启动替换 Worker。Project hard pause 的 `pauseProjectReport` 等待 cleanup，失败项从 `workers.stopped` 移到 `workers.failures`，Router `projectPausedByUser` 与 API 同步；同步 `pauseProject` 不等待、不发该聚合事件。同 Project transfer 在 cleanup 成功后才启动新 Assignment；失败时新 Assignment 结束为 `handoffCleanupFailed`、Handoff 记为 `failed`、Ticket 保持 open 并记录 delivery error，不创建新 Session。
- 同 Project split 与跨 Project 接收也走两阶段：先在事务里写 `starting` Handoff、结束源 Assignment 并取得 cleanup；cleanup 成功后才在第二个事务里创建目标 Ticket、双向写 accepted Handoff 并结束源 Ticket。失败时 Handoff 为 `failed`、Ticket 为 open + delivery error，目标 Ticket 与目标 Worker 都不存在。transfer 的第一阶段同样写 `starting`，只有 `completeTransfer` 才与 launch 一起改成 accepted。
- **启动恢复**：`Runtime.initialize` 在任何 Worker resume 之前调用 `Engine.recoverInterruptedHandoffs()`，把上一进程遗留的 `starting` Handoff 全部改为 `failed`（写 `failure` 与 delivery error）；transfer 预留但从未 launch 的 pending Assignment 结束为 `handoffCleanupFailed`，重试继续使用同一个 `-h<seq>` 槽。恢复不创建目标 Ticket、不启动任何 Worker，且幂等。这样进程在“第一阶段已提交、第二阶段未提交”之间退出，不会留下 open 但不可 retry 的 Ticket。
- 进行中的跨 Project 接收：源端在开始 cleanup 时把请求从 `pending` 改为 `starting`，因此并发的 reject/accept 都得到 `handoffHandled`，源 Ticket 状态与 Handoff 记录不会被第二个决策改写；崩溃后同一记录由启动恢复失败化。并发 retry 已创建更新的运行中 Assignment 时，`failHandoffAway` 只把 Handoff 标为 `failed`，不写当前 Worker 的 delivery error。
- transfer 并发复核：等待 cleanup 期间 Ticket/Handoff 可能被停止、重试或第二次 transfer 改写。`completeTransfer` 重新校验 Handoff 仍是 `starting` transfer、`to.assignmentId` 匹配且该 Assignment 仍是 Ticket 最新的 pending Assignment；不满足则不启动并抛错。`failTransfer` 总是把该 Handoff 标为 `failed` 并在该 Ticket 仍归本次尝试时写 delivery error，不再因 Assignment 非 pending 而静默返回。
- 原生 Stop 与插件 cancel 的区分：expected 标记从 `WeakSet<Agent>` 改为按 `{ assignmentId, turn }` 绑定；`agent/status running` 不清标记，同一回合的重复 idle 仍识别为 expected，更晚回合的结束时丢弃标记并按原生 Stop 处理；即使停止时 agent 已 idle 也记录标记，避免覆盖后续回合的原生 Stop。原生 Stop 路径保留 `idleAt`/`interruptedAt` 记录并发 hard-stop 的 `execution_status` 回执，且对所有 Ticket 来源生效。
- 重复决策：已 accepted 再 reject、已 rejected 再 accept 抛 `handoffHandled`；同一 action 幂等。PM 工具的回执按 Engine 返回的 `handoff.status` 写 accepted/rejected，不按本次请求参数。
- 同 Project Worker→PM 缺口：新增 `orchestrator_project_ticket_handoff_new_ticket`。Worker 报告越界工作后，PM 可在同 Project 新建独立 Ticket（新 Decision/Mandate/worktree），源 Ticket 停止 Worker 并以 `handedOff` 结束；两个 Ticket 通过 Handoff 关联，无 parentId。PM 工具边界现为 9 个。

## 5. 批准层级

| 场景 | 批准者 |
| --- | --- |
| 同 Project Worker → Worker | 该 Project 的 PM |
| Worker → PM（越界） | 该 Project 的 PM；由 PM 决定新建 Ticket |
| PM → 同 Project 新 Ticket | 该 Project 的 PM（自身） |
| 跨 Project | 目标 PM 最终决定是否接收；源 PM 结束源 Ticket 并提供摘要 |
| 人直接按 Session 停止 | 只 hard stop 目标 Session/任务，其他 Worker 默认继续；父级收到 `userStopped` 提醒后自行判断影响或提问；被终止 Worker 不自动重启 |
| PM 的 Project 暂停（soft） | 该 Project 的 PM/操作者；阻止新工作，PM 收尾 |
| PM 的 Project 暂停（hard） | 该 Project 的 PM/操作者；一次性停止 Project 内所有 Worker，Router 收到 `projectPausedByUser` 提醒 |

## 6. 与现有工具的关系

- `orchestrator_trigger_handback` 保持不变，只处理消息退回。
- 同 Project transfer 新增 PM 工具 `orchestrator_project_ticket_handoff`（P3-B 已实现）；Worker 只能报告，不能调用。
- 跨 Project 新增 PM-to-PM 请求/决定工具 `orchestrator_project_ticket_handoff_to_project` 与 `orchestrator_project_ticket_handoff_decide`（P3-B 已实现；目标 PM 接收/拒绝）；不需要 Router 单独批准。
- 同 Project Worker→PM 越界新增 PM 工具 `orchestrator_project_ticket_handoff_new_ticket`（审核修复已实现）：目标 Ticket 与源 Ticket 都留在本 Project，源 Ticket 以 `handedOff` 结束，不建父子关系。
- 人要求暂停任务：建议新增 PM/Router 的 stop 工具（例如 `orchestrator_project_ticket_stop`，mode=`assignment`|`ticket`），因为当前 PM 只有读取/建单/消息/汇报工具，主入口也没有 stop 工具；否则“上级终止任务”只能走面板 API。
- 人工直接停止：面板/API 走 hard stop，并在父级写入 `userStopped` 提醒；不新增 handoff 工具。
- PM 的“项目暂停”：Project 控制/PM 面板增加 soft/hard 二选一入口，复用 `POST projects/:id/pause`；hard 额外写 Router `projectPausedByUser` 提醒，并只清除 `scope: 'project'` 标签。
- 建议新增 PM 工具 `orchestrator_project_ticket_revive`（P3-A 已实现）：Project resume 后可主动恢复 `scope: 'project'` 的 Worker；遇到 `scope: 'worker'` 标签必须拒绝并提示“需要用户批准”。
- 建议新增用户审批入口（面板按钮/API）：清除单 Worker 的 `scope: 'worker'` 标签后才允许 PM revive；PM 不能自己清 worker 标签。P3-A 已实现为 `POST tickets/:id/allow-resume` 与“允许恢复”按钮，只清标签、不自动恢复。
- Project resume 入口（Router 经用户同意，或用户在 PM 界面点恢复）负责清除 project 标签；不是 PM 自行清除。

## 7. 验收场景（草案）

1. 同 Project Worker→Worker：旧 Assignment `handedOff`，新 Session `...-h1`，Ticket/worktree/Mandate 不变，旧 Session 停止。
2. 同 Project Worker→PM：PM 用 `orchestrator_project_ticket_handoff_new_ticket` 新建独立 Ticket，源 Ticket `handedOff` 结束，不建父子关系（审核修复已实现）。
3. 跨 Project：目标 PM 接收，目标 Project 新建 Ticket/Mandate；源 Ticket `handedOff`；无 parentId。
4. 权限：handoff 不能扩大 `allowTools`/Mandate；paused/archived/ended Project 拒绝。
5. 旧 Session：历史保留、自动回合停止；handoff 摘要和批准记录可读。
6. 人暂停：上级 Agent 对单 Ticket 用 soft/hard stop，对 Project 用 soft/hard pause；不产生 human-owned 状态。
7. 人直接按 Session 停止：只 hard stop 目标 Session/任务；父级 PM 或 Router 收到 `userStopped` 提醒，并自行判断影响、必要时提问；其他 Worker 不被自动终止，被终止 Worker 不自动重启。
8. **等价性**：同一 Worker 分别经“单 Session 停止”和“Project hard pause 批量”两条路径停止，Assignment 结束原因、Session 取消、Ticket 状态、停止记录必须一致；差异只能来自顺序/并发和 `manualStop.scope`。
9. **部分失败**：Project hard pause 中一个 Worker 停止失败，其余 Worker 仍按同一原语停止；Router 聚合提醒列出失败项，Project 不得显示全部已停止。
10. **Project 恢复**：Project resume 清除所有 `scope: 'project'` 标签，PM 可用 revive 主动恢复这些 Worker。
11. **单 Worker 恢复**：`scope: 'worker'` 标签在 Project resume 后仍保留；PM revive 被拒绝，用户明确批准并清除标签后才能恢复。
12. **混合标签**：一个 Worker 先被单个停止、后遇 Project hard pause，保留 `scope: 'worker'`，不能被 project 标签覆盖；Project resume 后仍需用户批准。
13. PM 的 Project hard pause 与逐个 Worker stop 共用同一个 `hardStopWorker` 原语；批量层只额外设置 Project `paused`、写标签和聚合提醒。
14. PM 项目暂停 soft：阻止新 Ticket/Assignment，PM 收尾；其他运行中 Worker 按原 soft 语义继续。
15. **split / 跨 Project 接收的 cleanup**：源 Worker cleanup 失败时源 Ticket 保持 open、Handoff 为 `failed` 且写 delivery error，目标 Ticket 与目标 Worker 都不创建；cleanup 成功前目标 Ticket 不存在，成功后才出现。
16. **transfer 并发**：cleanup 等待期间 stop 掉新 Assignment 或发起第二次 transfer，第一次 transfer 抛错、其 Handoff 为 `failed`，替代 Worker 不启动；第二次 transfer 仍可正常完成。
17. **同步暂停不提前报停止**：同步 `pauseProject(hard)` 不发 `project.pausedByUser`；只有 `pauseProjectReport` 在等待 cleanup 后发一条，且失败的 Worker 只出现在 `failures`。
18. **cancel 标记按回合**：停止时 Worker 已 idle、同一 cancel 产生多个 idle、cancel 后出现新回合，三种情况下后续原生 Stop 仍能被识别，不会被旧标记吞掉。
19. **重启恢复**：在 split/跨 Project 接收/transfer 的第一阶段提交后模拟进程退出，重启时 `starting` Handoff 被改为 `failed`、源 Ticket 保持 open 且有 delivery error、不创建目标 Ticket/不启动替代 Worker；源 Ticket 可被 retry（transfer 重试使用预留的 `-h1`）。恢复幂等。
20. **进行中决策互斥**：跨 Project accept 的 cleanup 等待期间 reject 被 `handoffHandled` 拒绝，且不改变 source/Ticket/Handoff；cleanup 成功后 accept 正常完成。

## 8. 已定与待实现

已定：

1. Worker 只报告“需要接手”，PM 执行 handoff，Worker 没有直接换 Session 的工具。
2. “另一个 Worker”只是新的 Worker Session；当前没有可选的人/worker 身份池。
3. 跨 Project 由目标 PM 最终决定是否接收；源 PM 结束源 Ticket、提供摘要。
4. 跨 Project 只传摘要/链接/未完成项，不复制或移动 worktree。
5. Project paused 时拒绝 handoff，先 resume 或走 stop。
6. 人直接按停止 = hard stop，但只作用于目标 Session/任务；其他 Worker 默认继续，由上级 Agent 判断影响、处理或向人提问。
7. PM 的“项目暂停”是独立 Project 级入口，soft/hard 二选一；hard 对每个 Worker 复用同一个 `hardStopWorker` 原语并写 `scope: 'project'` 标签，再设置 Project `paused` 和 `projectPausedByUser` 聚合提醒。
8. Project resume 清除 project 标签，PM 可主动恢复这些 Worker；单 Worker 的 `scope: 'worker'` 标签保留，PM revive 被拒绝，必须用户批准。
9. `hard project pause` 不是批量改状态；每个 Worker 的结果必须与单 Session stop 一致，失败项单独记录/重试。

实现时仍需定：

1. 面板“停止”按钮的精确作用域（P3-A 已定）：工单页“停止本次派工”= 单 Worker hard stop（`scope: 'worker'`）；工单页“停止工单”= 结束 Ticket；Project 页“项目暂停（soft/hard）”= Project 级；按钮和确认文案已写清各自作用域。
2. `userStopped` 提醒（P3-A 已定）：单 Worker 停止沿用执行回执 relay，payload 附 `manual_stop`/`needs_user_approval`；Project hard pause 只发一条 durable `projectPausedByUser` relay，逐 Worker 回执被抑制。
3. 同 Project transfer 用 `Assignment.endedReason='handedOff'`（P3-B 已完成）；人工 stop 仍用 `stoppedByOperator`，两者在 Ticket 的 `assignment.endedReason` 上可直接区分。
4. 抽出唯一的 `hardStopWorker` 原语（P3-A 已完成）；`pauseProject` 只做逐 Worker 循环和聚合，不再直接改 Assignment 状态。
5. 新 Session `worker-<ticketId>-h<n>`（P3-B 已完成）：`workerSessionId(ticketId, seq)`、`ticketOfSession` 解析后缀、`Assignment.sessionId` 记录所属 Session、`latestSessionId`/`workerSessionsOf` 覆盖查找、报告路由、面板链接、归档/暂停/关停；旧 Session 只保留历史，工具守卫拒绝其继续工作。
6. 同 Project handoff 是否允许 Ticket 已 ended 后重开（P3-B 已定）：不允许；handoff 只接受 open 且最新 Assignment 未结束的 Ticket，不负责重开。
7. 新增 `Ticket.manualStop`（scope `worker`/`project`）（P3-A 已完成）：单 Worker 停止写 worker，Project hard pause 写 project；已有 worker 标签不被 project 覆盖。
8. 新增 PM `orchestrator_project_ticket_revive`（P3-A 已完成）：只允许在 Project active 时恢复；worker 标签返回“需要用户批准”；resume 后的“无标签但最新 Assignment 由 operator 停止”也是可恢复记录。
9. 新增用户审批入口（API/面板）清除 worker 标签（P3-A 已完成：`POST tickets/:id/allow-resume`）；Project resume 入口清除 project 标签，PM 不能自行清 worker 标签。

