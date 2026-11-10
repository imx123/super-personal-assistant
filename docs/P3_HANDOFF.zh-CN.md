# P3 任务交接设计

> 状态：P3-A（人工停止标签、Project hard pause、PM revive、用户批准）已实现；P3-B（同 Project 换执行者、跨 Project 新 Ticket）待实现。本文只记录 P3 任务交接的边界、流程和待确认项；实现与验收另开提交。

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
3. PM 结束旧 Assignment（`endedReason: 'handedOff'`），停止旧 Session 的自动回合；
4. 同一 Ticket 新建 Assignment，新 Session 为 `worker-<ticketId>-h<seq>`；
5. 新 Session 收到 handoff 说明；Ticket 历史保留，不创建新 Decision/Mandate；
6. Ticket 保持 open；worktree 不变。

约束：

- 旧 Assignment 必须已经结束或可安全结束；不能两个 Assignment 同时写同一 worktree。
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
- 若某个 Worker 停止失败：继续处理其余 Worker，记录失败并在 Router 提醒中列出；Project 不能显示为“全部已停止”，失败项按同一原语重试或由人处理。
- PM Session 是 Project 级控制对象，由 hard pause 单独取消；不要把它算进“逐个 Worker”循环，也不要让 PM 的取消改变单个 Worker 的停止结果。
- 每个被 Project hard pause 停下的 Worker 写入 `manualStop.scope = 'project'`；如果该 Worker 事先已有 `scope = 'worker'` 标签，保留原标签，不覆盖。
- Project resume（Router 经用户同意，或用户在 PM 界面点恢复）只删除本 Project 所有 Worker 的 `scope = 'project'` 标签；PM 随后可主动恢复这些 Worker。
- 单个 Worker 停止写 `manualStop.scope = 'worker'`；Project resume 不清除它，PM 不能主动恢复，必须由用户明确批准后清除标签。
- 不自动重启任何被暂停的 Worker；恢复必须经 Project resume / 用户批准 / 人工指示。
- 与单 Session stop 的 `userStopped` 提醒分开：Project hard pause 对外只发聚合提醒；每个 Worker 的停止记录仍保留，但不再向已停止的 PM 逐个投递。
- P3-A 实现补充：单 Worker 停止与 Project hard pause 的 Assignment 都结束为 `stoppedByOperator`（唯一的 `Tickets.hardStopWorker`）；单 Worker 停止的父级回执复用 `execution_status`，并附 `manual_stop` 与 `needs_user_approval`；Project hard pause 的逐 Worker 回执被 `DshExecutor` 抑制，只发一条 `projectPausedByUser`。
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
- 同 Project transfer 建议新增 PM 工具：`orchestrator_project_ticket_handoff`；Worker 只能报告，不能调用。
- 跨 Project 建议新增 PM-to-PM 请求工具：`orchestrator_project_ticket_handoff_to_project`（目标 PM 接收/拒绝）；不需要 Router 单独批准。
- 人要求暂停任务：建议新增 PM/Router 的 stop 工具（例如 `orchestrator_project_ticket_stop`，mode=`assignment`|`ticket`），因为当前 PM 只有读取/建单/消息/汇报工具，主入口也没有 stop 工具；否则“上级终止任务”只能走面板 API。
- 人工直接停止：面板/API 走 hard stop，并在父级写入 `userStopped` 提醒；不新增 handoff 工具。
- PM 的“项目暂停”：Project 控制/PM 面板增加 soft/hard 二选一入口，复用 `POST projects/:id/pause`；hard 额外写 Router `projectPausedByUser` 提醒，并只清除 `scope: 'project'` 标签。
- 建议新增 PM 工具 `orchestrator_project_ticket_revive`（P3-A 已实现）：Project resume 后可主动恢复 `scope: 'project'` 的 Worker；遇到 `scope: 'worker'` 标签必须拒绝并提示“需要用户批准”。
- 建议新增用户审批入口（面板按钮/API）：清除单 Worker 的 `scope: 'worker'` 标签后才允许 PM revive；PM 不能自己清 worker 标签。P3-A 已实现为 `POST tickets/:id/allow-resume` 与“允许恢复”按钮，只清标签、不自动恢复。
- Project resume 入口（Router 经用户同意，或用户在 PM 界面点恢复）负责清除 project 标签；不是 PM 自行清除。

## 7. 验收场景（草案）

1. 同 Project Worker→Worker：旧 Assignment `handedOff`，新 Session `...-h1`，Ticket/worktree/Mandate 不变，旧 Session 停止。
2. 同 Project Worker→PM：PM 新建独立 Ticket，源 Ticket `handedOff` 结束，不建父子关系。
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
3. 同 Project transfer 用 `Assignment.endedReason='handedOff'`；人工 stop 用 `userStopped`/`operatorStopped` 的区分（待 P3-B）。
4. 抽出唯一的 `hardStopWorker` 原语（P3-A 已完成）；`pauseProject` 只做逐 Worker 循环和聚合，不再直接改 Assignment 状态。
5. 新 Session `worker-<ticketId>-h<n>` 需要改造所有 `workerSessionId(ticketId)` 查找、报告路由和面板链接；旧 Session 只保留历史，不再被自动唤醒（待 P3-B）。
6. 同 Project handoff 是否允许 Ticket 已 ended 后重开；建议必须先 resume/retry，handoff 不负责重开 Ticket（待 P3-B）。
7. 新增 `Ticket.manualStop`（scope `worker`/`project`）（P3-A 已完成）：单 Worker 停止写 worker，Project hard pause 写 project；已有 worker 标签不被 project 覆盖。
8. 新增 PM `orchestrator_project_ticket_revive`（P3-A 已完成）：只允许在 Project active 时恢复；worker 标签返回“需要用户批准”；resume 后的“无标签但最新 Assignment 由 operator 停止”也是可恢复记录。
9. 新增用户审批入口（API/面板）清除 worker 标签（P3-A 已完成：`POST tickets/:id/allow-resume`）；Project resume 入口清除 project 标签，PM 不能自行清 worker 标签。

