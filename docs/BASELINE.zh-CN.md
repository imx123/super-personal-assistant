# 基线说明

## 这是什么

本仓库是 superagent 的独立开发基线，派生自 MIT 许可的 [dsh-superagent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。上游官方原型作为独立参考保留，不在本仓库内修改；本仓库的起点是 2026-11-09 的 19:38 工具版。

- 上游来源提交：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`
- 基线导入提交：`chore: import V2 tool baseline (2026-11-09 19:38)`
- 本仓库不附带 V2 验收记录；V2 验收属于上一轮实验，和这里的开发基线分开。

### 已完成的 P2.1

P2.1 建好了 Project Profile、PMMandate、`DecisionKind 'project'`、`project` 表、`createProject`、PM Session 和 Project Tab。这些仍在下文生效。

## 已完成的 P2.2a：PM 创建 Project Ticket + child ticket 外部 thread

P2.2a 做 PM 创建 PM-owned Ticket 的最小闭环，并允许 child ticket 在创建时订阅外部 thread；不做能力档、child 报告回 PM、Project 暂停/停止或 PM 独立模型。

已实现：

- `MandateBasis` 增加 `via: 'delegated'`（含 `projectId`、`pmSessionId`）；`DecisionKind` 增加 `delegated`，`Decision.ticketId` 对 delegated 必填，`Decision.mandate` 记录 Ticket 的 Mandate，`evalId` 是真实记录 ID。`Policy.revalidate` 对 delegated 直接返回 true，不查外部 allowed list。
- 新增内置 Source kind `internal`（`src/sources/internal.ts`）：空 schema、无 channel、无 poll、无 health、无 threadContext，`scope` 恒为 listened；Runtime 启动时注册。
- Engine 新增 `createProjectTickets(projectId, pmSessionId, tasks)`：校验 Project 存在且 active，并强制校验调用者就是该项目的 PM（不再有省略 PM Session 的 2 参重载）；每个 task 生成一条内部 Trigger（actor `{source:'internal', id: pmSessionId}`、`human:false`、不设 addressed、一条独立 Thread）、一个 record-only Eval（真实 `evalId`、`basis.via='delegated'`、strength 取 PM Mandate、不调 assessor、不投 candidate）→ `delegated` Decision → Ticket。Ticket 带 `projectId`、`decisionId`、从 PM Mandate 复制的 strength/policyVersion/actor、task scope/goal、内部 Trigger origin、`channels: []`、title、`prepareTicket` 生成的 execution，以及新 Assignment + `executor.start`；emit `ticket.created`。整批原子，一个 task 失败则全批不建；同一 projectId + task index 幂等。
- Ticket 不自动订阅 Project 的源 Thread；只订阅 task 显式列出的 `threads`。`Tickets` 新增 PM 创建入口 `createDelegated` 与公开订阅入口 `subscribeExternal(ticketId, ref, contextOnly)`：校验 ThreadRef、按 ticket 去重、`contextOnly` 写入 `Thread.context`；不写 `Ticket.follows`，不自动订阅 origin。
- PM 新增 `orchestrator_project_ticket_create`：仅 PM Session 注册；接收 1–5 个 task（title/goal 长度受限，worktree_name 在同批唯一），返回 `{ tickets: projectTicketCard[], project: projectCard, note }`，不声称 worker 已完成。PM 只能建自己项目内的 Ticket；Project 不存在或结束拒绝。
- PM Session 权限改为默认 `auto`（宿主提供 auto 时），否则 `workspace-write`、`read-only`，最后才 full；child Ticket 的 Worker 仍走现有 worker 权限逻辑（auto 优先），不额外强制 workspace-write。
- PM 读范围扩展：`orchestrator_read` 允许自己的 `project/<id>`、`project/<id>/tickets`，以及 `projectId` 属于自己项目的 `ticket/<id>`；其他资源拒绝。Project 详情/API/资源能看到 child Ticket 列表与各自 thread；面板 Project 页也列出 child Ticket 和 thread（context-only 有标记）。
- `prompts/pm.md` 更新：PM 可以创建 Ticket，只建项目内 Ticket，不自己实现，不声称 worker 已完成。

明确未做：能力档 `read-only/workspace-write/full` 与 `denyTools`、child report/attention 回 PM（仍去主 Session，已知下一段）、Project 暂停/停止/删除、PM 独立模型、父 Ticket、Dispatch、TaskSpec、Fast Router、Memory/RAG。主窗口 active dispatch 的 directEval 路线保持原样。

改动文件：

| 文件 | 变更 |
| --- | --- |
| `src/core/model.ts`、`ports.ts`、`engine.ts`、`evals.ts`、`tickets.ts`、`errors.ts`、`reasons.ts`、`index.ts` | delegated 类型与 Decision、内部 Trigger 与 record-only Eval、`createProjectTickets`、`createDelegated` / `subscribeExternal`、错误码与原因、任务边界 |
| `src/policy.ts`、`src/sources/internal.ts`、`src/app/runtime.ts` | delegated 直接认可；内置 internal Source；注册 |
| `src/app/tools/main.ts`、`sessions.ts`、`prompts.ts`、`cards.ts`、`resources.ts`、`views/projects.ts` | PM 创建/读工具与范围、PM 权限 auto、PM 提示与初始化、Project Ticket 卡片、`project/<id>/tickets`、Project 详情 child Ticket |
| `prompts/pm.md`、`src/client/projects.tsx`、`locales.ts`、`marks.ts`、`ticket.tsx` | PM 提示词；Project 页 child Ticket/thread；delegated 文案、标记与 basis 展示 |
| `docs/001`、`docs/002`、`docs/005`、`docs/007`、本文件 | 领域、授权、面板、架构与基线范围 |
| `tests/project-tickets.spec.ts`、`tests/projects.spec.ts`、`tests/panel-project.spec.tsx`、`tests/fixtures/host.ts` | 新增 PM Ticket 定向测试；PM 权限断言改 auto；Project 面板 child Ticket；权限 fixture 加 auto |

## 已完成的 P2.2b：可选工具白名单

P2.2b 只做“可选工具白名单”，不做 capability 档、不做 `denyTools`，也不做 child report/attention 回 PM。

已实现：

- `Mandate` 增加可选 `allowTools?: string[]`；`PMMandate` 与 Ticket Mandate 直接继承，不建新类型层。Ticket Mandate 的 `allowTools` 写入最终列表：task 显式 `allow_tools` 或继承 PM Mandate 的列表；都没有则不写字段 = Worker 全量工具。
- `WORK_TOOLS` 收敛为 `src/core/model.ts` 的唯一声明，`Sessions.workOnly` 从 core 导入；PM 任务校验也使用同一集合。
- PM 的 `orchestrator_project_ticket_create` task 增加可选 `allow_tools?: string[]`。省略/空数组 = 继承 PM Mandate 的列表；PM Mandate 没有列表时 = Worker 全量。PM Mandate 自身有 `allowTools` 时，child 只能取子集，扩大被拒。Project 创建时 PM Mandate 默认不设 `allowTools`。
- 校验：工具名必须是 `WORK_TOOLS` 中的名字、不能重复、最多 32 个；未知/重复/超长/扩大 PM Mandate 都抛 `invalidProjectTask`，整批回滚。PM 工具 schema 的数组上限也是 32。
- `Sessions.workOnly` 的工具 allow 集合按 `ticket.mandate.allowTools` 过滤；`limitSubagent` 继续调用同一个 `workOnly`，所以 Worker 的 subagent 与孙 subagent 继承同一白名单，不能绕过。过滤结果还会与宿主实际提供的工具取交集。
- `allowTools` 只是工具可见性，不是文件系统/权限沙箱；未引入 `denyTools`、能力档或新类型层。
- 删除 `Engine.createProjectTickets(projectId, tasks)` 2 参重载，只保留 `(projectId, pmSessionId, tasks)`；PM 工具继续传 `project.pmSessionId`。主 Session 没有 PM 工具，调用方也不能省略 PM Session 绕过身份校验。

改动文件：

| 文件 | 变更 |
| --- | --- |
| `src/core/model.ts`、`engine.ts`、`evals.ts` | `Mandate.allowTools`、`WORK_TOOLS`、`allow_tools` 校验/收窄/继承、required-PM 签名 |
| `src/app/sessions.ts`、`tools/main.ts` | `workOnly` 按 Mandate 过滤（subagent 继承）；PM task schema 增加 `allow_tools` |
| `docs/001`、`docs/002`、`docs/007`、本文件 | allow_tools 语义、默认/收窄/非沙箱说明 |
| `tests/project-tickets.spec.ts`、`tests/runtime.spec.ts` | 白名单字段与拒绝、实际 `restrict` 结果、未指定=全量、subagent 继承、无 2 参绕过 |

明确未做：Project 暂停/停止/删除、PM 独立模型、Project Memory、父 Ticket、Dispatch、TaskSpec、Fast Router/RAG、capability 档、`denyTools`。

## 已完成的 P2.3：child 报告回 PM + PM 项目汇报回 Router

P2.3 做报告路由和 PM 项目汇报；不做 Project 暂停/停止，不做 PM 直接回答 child attention。

已实现：

- `relay` effect payload 增加可选 `sessionId`；`Sessions.relay(requestId, text, summary?, sessionId?)` 默认主 Session。`relay` handler 把消息投到 payload 指定的 Session，request id 仍负责幂等。
- `DshExecutor.relay` 接收当前 Ticket：`ticket.projectId` 存在且 Project 为 active/paused 时发到 `project.pmSessionId`，否则回主 Session。`failed`、turn end/waiting、`resultRelay`、`reportRelay` 的 `worker_report` / `worker_attention`、`executionStatus`（stop 回执）都走这一路由。
- Worker 的 `orchestrator_report` 也使用同一路由；child 的 `worker_report` / `worker_attention` 只到 PM，主 Session 不收。child ticket 的 `ticket.ended` notice 也不再发主 Session。
- `orchestrator_project_report` 仍写 `ProjectProfile.latestReport`，同时向主 Session relay 一条结构化 `project_report`：`project_id`、`title`、`status`、`summary`、`at`、`read`；request id 由 project id + summary 派生，重复提交同文本不会重复打扰 Router。Project 页仍读 `latestReport`。
- PM 已可读 child `ticket/<id>` 和 `project/<id>/tickets`；child attention 到达 PM 后，PM 可在项目汇报里标出 blocker，本轮不提供直接回答 child 的半套工具。
- Router-owned Ticket 的报告仍去主 Session；Project Ticket 只在 Project 为 ended/不存在时 fallback 到主 Session。PM Session 当前未加载不回退：relay 按 Project 状态选择目标，由 DSH 解析并加载 PM Session。

改动文件：

| 文件 | 变更 |
| --- | --- |
| `src/app/effects.ts`、`sessions.ts`、`notices.ts` | relay payload `sessionId`、投递目标 Session、`relaySession` 路由规则 |
| `src/executor/dsh.ts`、`src/app/tools/executor.ts`、`src/app/runtime.ts` | DshExecutor/Worker report/stop 回执按 Ticket 路由；child lifecycle notice 不再打扰主 Session |
| `src/app/tools/main.ts` | `orchestrator_project_report` 写 latestReport + relay `project_report` 到 Router |
| `docs/002`、`docs/007`、本文件 | 报告路由：独立 Ticket → Router；Project Ticket → PM；PM → Router |
| `tests/project-tickets.spec.ts` | child report/attention 到 PM、主 Session 不收、PM report 到主 Session 且幂等、Router Ticket 回归、PM 缺失 fallback |

明确未做：PM 直接回答 child attention、Project 暂停/停止/删除、PM 独立模型、Project Memory、父 Ticket、Dispatch、TaskSpec、Fast Router/RAG、capability 档、`denyTools`。

## 已完成的 P2.4：Project 状态与控制

P2.4 只做 Project 的 active/paused/ended 状态、暂停/恢复、结束与级联停止；不做 Project 删除/归档，不暂停项目内运行中的 Worker，不做 PM 独立模型或 Fast Router/Memory。

已实现：

- `ProjectProfile.status` 扩为 `'active' | 'paused' | 'ended'`。
- `Engine.createProjectTickets` 只在 active 时建单：paused 抛 `projectPaused`，ended 抛 `projectEnded`，两者都整批不建。PM 的 `orchestrator_project_ticket_create` 同样得到明确拒绝。
- `Engine.pauseProject(projectId, paused)`：active ↔ paused 幂等；ended 不变更（保持 ended）。paused 只阻止新 Ticket，已有 child Ticket 继续运行并继续把报告送到 PM。
- `Engine.stopProject(projectId, reason?)`：幂等；把 Project 置 ended，并对所有仍 open、`projectId` 匹配的 child Ticket 调用现有 `Tickets.stop` 语义，保留历史/Session/执行目录；已 ended 直接返回。不删除 Project。
- 管理 API：`POST projects/:id/pause` body `{ paused: boolean }`、`POST projects/:id/stop`；沿用同源/header 校验，非允许来源仍 403。只给 management API/面板，不新增 PM/Worker 工具，PM 不能自己 pause/stop。
- 面板 Project 详情加 Pause/Resume 与 Stop（Stop 用现有 ConfirmButton 确认）；状态文案补 paused/ended；停止后页面仍可读，PM Session 保留可查看，未取消。

改动文件：

| 文件 | 变更 |
| --- | --- |
| `src/core/model.ts`、`engine.ts`、`errors.ts` | Project 状态联合类型、`pauseProject` / `stopProject`、级联停止、`projectPaused` |
| `src/app/api.ts`、`http.ts`、`views/projects.ts` | pause/stop management API；Project 读模型 |
| `src/client/projects.tsx`、`locales.ts` | Project 页 Pause/Resume/Stop、确认框、paused/ended 文案 |
| `src/app/notices.ts` | paused Project 的 child 报告仍送 PM；ended 才 fallback |
| `docs/001`、`docs/002`、`docs/005`、`docs/007`、本文件 | Project 状态、控制、级联语义 |
| `tests/project-tickets.spec.ts`、`tests/projects.spec.ts`、`tests/panel-project.spec.tsx`、`tests/http.spec.ts` | pause/resume/stop、级联、paused 建单拒绝、API/panel 控制与同源 403 |

明确未做：Project 删除/归档、暂停项目内运行中的 Worker、PM 独立模型、Project Memory、父 Ticket/Dispatch/TaskSpec、Fast Router/RAG、capability 档、`denyTools`。

## 已完成的 P2.5-A：Project/Ticket 归档核心

P2.5-A 只做 Project/Ticket 的归档与取消归档、级联、管理 API/面板和 Router 工具；不做删除，不做 DSH 原生 archive 事件检测/pendingNotes（P2.5-B），不做 pause 新模式、PM 模型、PM→Worker 消息或 Project domain events。

已实现：

- `ProjectProfile.status` 加 `archived`，并增加 `archivedFrom?: 'active' | 'paused'`；`Ticket` 增加 `archived?: { at; by: 'project'; projectId }`。
- `liveTicket` 同时要求未结束、未归档；`Store.tickets.open()`/`active` 和 `MemoryRepositories` 排除 archived；`ticketStage` 增加 `archived`；`canRetry`、`Sessions.workOnly` guard、intake fan-out/resume、`Tickets.wake`、`followupOwners`、`Tickets.attachable` 都拒绝或跳过 archived。
- `Engine.archiveProject`：只能归档 active/paused（ended 拒绝，archived 幂等）；保存 `archivedFrom`，Project 置 archived，所有 child Ticket 写 archived，所有 pending/running Assignment 置 ended、`endedReason='projectArchived'`，不新建 Assignment。`Engine.unarchiveProject`：恢复 `archivedFrom`、清除 Ticket archived，不自动恢复/重试 Assignment；人可显式 retry 已结束的 Assignment。两者幂等。
- `Sessions.archiveProject`/`unarchiveProject`：在 Engine 事务提交后，通过宿主 `workspaceRegistry.archiveSession(id, { stopActivity: true })` / `unarchiveSession(id)` 处理 PM 和所有 child Ticket Session；API 缺失记为 `unavailable`，单个失败记录日志并放进返回的 `failures`，Project 状态仍以应用记录为准。
- 控制入口：management API `POST projects/:id/archive`、`POST projects/:id/unarchive`；面板 Project 页 Archive/Unarchive；主 Session/Router 工具 `orchestrator_project_archive` / `orchestrator_project_unarchive`。PM/Worker 没有这些工具。
- archived Project 不能建 Ticket（`projectArchived`）；archived Ticket 不可执行、非 open，但历史、Session、Ticket 记录都保留。Project 页归档后仍可读，PM/child Session 保留（被 DSH 归档）。
- Ticket 面板状态增加 archived（`TICKET_STATES`/`stage.archived`/mark），Ended 筛选也包含归档 Ticket；Project 状态文案增加 archived。

改动文件：

| 文件 | 变更 |
| --- | --- |
| `src/core/model.ts`、`stage.ts`、`memory.ts`、`engine.ts`、`intake.ts`、`tickets.ts`、`errors.ts` | archived 类型、live/open/stage 语义、archive/unarchive、级联结束 Assignment、守卫 |
| `src/app/store.ts`、`sessions.ts`、`http.ts`、`api.ts`、`views/projects.ts` | SQLite 生成列、Session archive API 与失败结果、management routes、Project 读模型 |
| `src/app/tools/main.ts`、`src/client/projects.tsx`、`locales.ts`、`cards.ts`、`marks.ts`、`views/tickets.ts` | Router archive/unarchive 工具、面板控件、archived 文案/标记、筛选 |
| `tests/fixtures/host.ts`、`panel-server.ts`、`tests/project-tickets.spec.ts`、`panel-project.spec.tsx`、`http.spec.ts`、`model-surface.spec.ts` | Session archive fake、API/panel 控件、归档/取消归档/失败/幂等、预算 |
| `docs/001`、`docs/002`、`docs/005`、`docs/007`、本文件 | 状态、归档/取消归档、Session 与级联语义 |

明确未做（P2.5-A 当时范围）：Project/Ticket 删除；DSH 原生 archive 事件检测/pendingNotes 已由 P2.5-B 补齐；pause 新模式、PM 模型、PM 消息、Project domain events 仍留待后续。

## 已完成的 P2.5-B：DSH 原生归档联动 + Project pendingNotes

P2.5-B 只做 DSH 原生 archive/unarchive 的应用联动与 PM pendingNotes；不做删除、pause soft/hard、PM 模型、PM→Worker 消息或 Project domain events。

已实现：

- `ArchiveReconciler`（`src/app/archive-reconcile.ts`）监听 Cordis `workspace/session-activity`（waterfall，必须 `return next()`）和 `workspace/session-stop`：只记录候选 session id、请求一次 reconcile，不在事件里改状态。
- reconcile 以 `workspaceRegistry.archivedSessionIds` 为准，与 KV `archive/session-snapshot` 比较；事件即时触发，另有 30 秒 unref 定时兜底（unarchive 没有 DSH 事件）。只处理本插件的 `pm-<projectId>` / `worker-<ticketId>`。
- 新增 archived：
  - PM → `Engine.archiveProject` + `Sessions.archiveProject`，复用 P2.5-A 的 Project/Ticket/Session 级联。
  - worker → 只结束当前 Assignment（`endedReason='sessionArchived'`），Ticket 保持 open、不自动 retry；所属 Project 加一条 `workerArchived` pendingNote；不唤醒 PM。
- 从 archived 移除：PM → `Engine.unarchiveProject` + `Sessions.unarchiveProject`，恢复 `archivedFrom`；worker → 不改 Ticket/Assignment，不自动 retry，加一条可选的 `workerRestored` pendingNote。
- `ProjectProfile.pendingNotes?: ProjectNote[]`（`{ id, at, kind, ticketId, sessionId, text }`），按确定性 id 去重。worker 归档时若 Project 已 archived 则不加 note；项目自身 archive 不会产生重复 note。
- PM 下一次 prompt 通过 `pmProjectSection` 带上 pendingNotes，并在 prompt section 组合后立即清除/标记已投递；不主动唤醒 PM。`orchestrator_read project/<id>` 在投递前可见 pendingNotes。
- 启动时 snapshot 缺失视为首次 reconcile，启动前已归档的 PM/worker 会被处理；至少已归档 PM 会令 Project 状态一致。P2.5-A 的 archive/unarchive 自调用可幂等重入，不产生二次级联或循环。

改动文件：

| 文件 | 变更 |
| --- | --- |
| `src/app/archive-reconcile.ts`、`runtime.ts`、`kv.ts` | 事件监听、snapshot、30 秒兜底、启动 reconcile、`archive/session-snapshot` |
| `src/core/model.ts`、`engine.ts`、`reasons.ts` | `ProjectNote`/`pendingNotes`、worker archive/unarchive 命令、`sessionArchived` |
| `src/app/prompts.ts`、`sessions.ts`、`cards.ts`、`views/projects.ts` | PM prompt 注入并清除 notes、Project card/row 暴露 notes |
| `tests/fixtures/host.ts`、`tests/archive-reconcile.spec.ts` | archived session 集与提示词 section 捕获、原生归档定向测试 |
| `docs/001`、`docs/002`、`docs/007`、本文件 | 原生归档检测、snapshot、PM/worker 级联、pendingNotes、不唤醒/不重试 |

明确未做：Project/Ticket 删除、pause soft/hard、PM 独立模型、PM→Worker 消息、Project domain events、父 Ticket/Dispatch/TaskSpec、Fast Router/RAG。

## 已完成的 P2.6：Project pause soft / hard

P2.6 只做 Project pause 的 soft/hard 语义；不做删除、PM 模型、PM→Worker 消息或 Project domain events。

已实现：

- `ProjectProfile.pauseMode?: 'soft' | 'hard'`。`Engine.pauseProject(projectId, paused, mode = 'soft')` 保留旧 2 参 soft 语义；soft pause 阻止新 Ticket/新 Assignment 但让 running Assignment 继续；hard pause 额外把所有 open project Ticket 的 pending/running Assignment 置 ended `projectPaused` 并调用 `executor.stop`，不 archive、不结束 Ticket。
- 所有新 Assignment 入口统一守卫：`Tickets.newAssignment` 抛 `projectPaused`，覆盖 PM 建单、retry、resume、attach；`Tickets.attachable`/`retry`/`wake` 也提前处理 paused。
- `Sessions.pauseProject(project, mode)`：
  - soft 向 PM 投一条结构化 `project_pause`，要求完成本轮 `orchestrator_project_report` 后停止；request id 幂等，不重复发；PM Session 不存在时返回 failure，不阻塞 Project 状态；不取消当前 turn。
  - hard 取消 PM 和所有已加载 child Worker 的当前 turn，返回 `cancelled`/`notLoaded`；未加载 Session 没有 turn 可取消，后续 prompt 看到 paused 状态；不 archive、不删历史。
  - `resumeProject` 不自动重启 Assignment；hard resume 的 `resumedFromHard` pendingNote 由 Engine 写入。
- `pmProjectSection` 增加 paused 说明：soft 要求收尾汇报后停止；hard 表示所有工作已停止、等待 resume，恢复后需先重读 Project/Tickets 并同步状态。hard resume 的 note 通过同一 pendingNotes 机制进入 PM 下一次 prompt。
- API `POST projects/:id/pause` body `{ paused, mode?: 'soft' | 'hard' }`（默认 soft），返回 `paused/mode/sessions`；Project 页提供 Pause（soft）、Hard pause（确认）和 Resume，显示 soft/hard，soft 可升级 hard，hard 后显示 Resume。没有新增 PM/Worker 工具。

改动文件：

| 文件 | 变更 |
| --- | --- |
| `src/core/model.ts`、`engine.ts`、`tickets.ts`、`stage.ts`、`errors.ts` | pauseMode、hard pause 级联结束 Assignment、新 Assignment 守卫、hard resume note、`projectPauseMode` |
| `src/app/sessions.ts`、`http.ts`、`api.ts`、`prompts.ts`、`views/projects.ts`、`cards.ts` | soft PM 消息、hard cancel、pause API/Read 模型、PM prompt paused 说明 |
| `src/client/projects.tsx`、`locales.ts` | Pause soft/hard、Hard pause 确认、Resume、pause mode 文案 |
| `tests/project-tickets.spec.ts`、`panel-project.spec.tsx`、`http.spec.ts` | soft/hard 行为、Assignment 守卫、PM notice/cancel、API/panel |
| `docs/001`、`docs/002`、`docs/005`、`docs/007`、本文件 | soft/hard、新 Assignment 守卫、PM 收尾、hard resume 提示 |

明确未做：Project/Ticket 删除、PM 独立模型、PM→Worker 消息、Project domain events、父 Ticket/Dispatch/TaskSpec、Fast Router/RAG。

## 已完成的 P2.7：PM→Worker 协调消息

P2.7 只做 PM 给 child Ticket 的协调消息；不做删除、PM 模型、Project events、pause 新行为或父 Ticket/Dispatch/TaskSpec。

已实现：

- `Engine.messageTicket(ticketId, text, wake = false)`：把消息写成 child Ticket 的 `note` Input（确定性 id，同 Ticket/同文本只加一次），进入 Ticket 历史；只授予上下文，不授予新权限。返回 `{ delivered: 'running'|'started'|'queued'|'not_started', ticket }`。
- 校验：Ticket 存在、属于 Project、Project `active`；paused/archived/ended 分别 `projectPaused`/`projectArchived`/`projectEnded`，Router-owned `notProjectTicket`，ended Ticket `ticketEnded`。
- 投递：running Assignment 走 `addInput` 的 `executor.deliver`，pending 走现有启动；没有 running/pending 且 `wake=true` 时，只有 `canRetry` 才通过 retry 启动新 Assignment，否则结 `not_started`，note 仍保留；`wake=false` 只投递/排队，不创建新 Assignment。
- PM 工具 `orchestrator_project_ticket_message`：schema `{ ticket_id, text(1..4000), wake?: boolean }`，只在 PM Session 注册；只能发自己 Project 内 Ticket，不能发 Router-owned；`wake` 默认 false。PM restrict 允许列表和 `prompts/pm.md`/`pmProjectSection` 已补该工具。
- worker Session 已归档时：PM 工具读 `workspaceRegistry.archivedSessionIds`，把 note 入队但不投递/不启动，返回 `not_started`；宿主不能报告 archived Session 时，`wake=true` 返回 `queued`，不声称已送达。
- 主 Session 的 `orchestrator_ticket_note` 保持原样；Worker 没有这个 PM 工具。

改动文件：

| 文件 | 变更 |
| --- | --- |
| `src/core/model.ts`、`engine.ts`、`tickets.ts`、`errors.ts`、`index.ts` | `messageTicket`、`TicketMessageDelivery`、`noteWithId`/`queueNoteWithId`、`notProjectTicket` |
| `src/app/tools/main.ts`、`sessions.ts`、`prompts.ts`、`prompts/pm.md` | PM 工具、PM restrict、archived Session 检查、PM prompt 说明 |
| `tests/project-tickets.spec.ts`、`projects.spec.ts` | note 落库/投递、wake 启动、拒绝、幂等、archived worker、PM 工具列表 |
| `docs/001`、`docs/002`、`docs/007`、本文件 | note Input、wake、无新授权、跨 Project 限制 |

明确未做：Project/Ticket 删除、PM 独立模型、Project domain events、pause 新行为、父 Ticket/Dispatch/TaskSpec、Fast Router/RAG。

## 已完成的 P2.8：eval.pmModel 独立 PM 模型

P2.8 只做 PM Session 的独立模型设置；不做 Project events、删除、pause 新行为、PM→Worker 消息改动或模型设置重构。

已实现：

- `EvalConfigSchema` 增加 `pmModel: RoleModelSchema.nullable().default(null)`，`Settings['eval']['pmModel']`；`SettingsSchema.parse({})` 默认 `null`。
- 新 Session 模型：主 Session/orchestrator 用 `eval.model`；PM 用 `eval.pmModel ?? eval.model`；worker 仍用 `executor.model`。已有 PM Session 不会被自动换模型。
- Settings 保存 `eval` block 时，`model` 和 `pmModel` 分别比较并走现有 `resolveRoleModel`；变化且非 null 的 `pmModel` 非法时返回 `modelUnavailable`，错误 block 仍为 `eval`；清空 `pmModel` 不校验并回退继承。
- `resources.models` 的 `roles` 增加 `pm`（有效模型：`pmModel ?? eval.model`）。
- Eval 设置区新增“PM 模型”`ModelField`，可留空继承研判模型；block draft 保存/冲突/清空逻辑沿用现有实现。
- `settings-history` 增加 `evalPmModel` 变更项和双语 locale。

改动文件：

| 文件 | 变更 |
| --- | --- |
| `src/policy.ts`、`src/app/settings.ts`、`src/app/role-models.ts`、`src/app/sessions.ts`、`src/app/resources.ts` | pmModel schema、保存校验、PM 模型解析、roles.pm |
| `src/client/eval.tsx`、`settings-kit.tsx`、`locales.ts`、`src/app/settings-history.ts` | PM 模型字段、data-model 标记、历史变更与文案 |
| `tests/policy.spec.ts`、`settings.spec.ts`、`panel-settings.spec.tsx`、`runtime.spec.ts`、`project-tickets.spec.ts` | 默认值、非法/合法/清空保存、面板渲染编辑、history、PM/worker 模型选择 |
| `docs/002`、`docs/007`、本文件 | PM 继承语义、只影响新 Session、roles.pm |

明确未做：Project events、删除、pause 新行为、PM→Worker 消息改动、父 Ticket/Dispatch/TaskSpec、Fast Router/RAG、其他模型设置重构。

## P2.9 当前范围：Project 状态变更 domain events

P2.9 只加 Project 状态变更的审计/测试 domain events；不 relay/通知主 Session 或 PM，不改 UI，不做删除、pause 新行为、PM→Worker 消息或 PM 模型改动。

已实现：

- `DomainEvents` 新增：
  - `project.paused`：`{projectId, mode:'soft'|'hard', from?:'soft'|'hard'}`
  - `project.resumed`：`{projectId, mode?:'soft'|'hard'}`
  - `project.ended`：`{projectId, reason?:string}`
  - `project.archived`：`{projectId, from:'active'|'paused'}`
  - `project.unarchived`：`{projectId, status:'active'|'paused'}`
  - 保留 `project.created`。
- Engine 只在状态真正变化时 emit：
  - active→paused soft/hard 发 `paused`（带 mode）；paused soft→hard 发 `paused`（mode hard、from soft）；paused→active 发 `resumed`（带之前的 mode）。
  - active/paused→ended 发 `ended`（reason 透传）；active/paused→archived 发 `archived`（from）。
  - archived→恢复发 `unarchived`（恢复后 status）。
  - 幂等 no-op、archived/ended 的 pause/resume、重复 archive/unarchive 都不 emit。
  - `at` 用状态变更时间；data 无敏感信息。
- Runtime 的 `eventNotice` 不处理这些事件，因此不产生 Session relay/notice。

改动文件：

| 文件 | 变更 |
| --- | --- |
| `src/core/ports.ts`、`src/core/engine.ts` | 事件类型、四个状态方法的 emit |
| `tests/projects.spec.ts` | 事件序列、幂等 no-op、无主/PM 投递 |
| `docs/001`、`docs/007`、本文件 | 事件列表、审计/测试边界、no relay |

明确未做：relay/notice、UI、删除、pause 新行为、PM→Worker 消息、PM 模型、父 Ticket/Dispatch/TaskSpec、Fast Router/RAG。

## 主入口的权限模型

主入口现在是正式 Source：`main-session`（`src/sources/main-session.ts`）。

- 它在 Settings → Sources 里是一张“用户会话”卡片，只有一个 `operator` 字段，默认 `dsh-user`。
- Policy 的“On each Source”里增加“用户会话”的 allowed list。只有名单里的 operator 能从主 Session 发起工作。
- 新库首次启动会写入一条默认 Policy：`main-session` 允许 `dsh-user`。保存 Source 卡片时，allowed list 会自动同步成当前 operator（只保留它，已有显示名会保留）；启动时也会校正一次。它不是 `allowedSender` 的硬编码放行。
- 手改 allowed list 会被下一次保存或启动校正；要停用主入口，用 Source 卡片的启用开关，不要用删名单的方式。
- 入口工具是 `orchestrator_user_trigger_create`：主 Session 明确派工时登记当前原生消息为一条 Trigger，再由 `orchestrator_route` 建单。普通聊天不建单。
- 工具在 Source 关闭或 operator 不在 allowed list 时直接拒绝，并说明要改哪里；它不绕过 gate，accept 仍会正常创建 Mandate。
- 主入口派出的 Ticket 使用现有 Worker preset，保留全工具；只读限制不施加给 Ticket。

### 只读约束

主 Session 是唯一的，默认允许派单。它自己的工作方式是“提示词级只读”：

- 可以读、查、路由和回复；不修改共享工作区，也不改其他 Worker 或 PM 的目录。
- 人明确要求主 Session 自己写文件或执行写命令时，它先说明需要什么写操作并征求确认；确认后可以由它自己做，或者按情况派一张全工具 Ticket。
- 这不是工具或沙箱限制：Router preset 仍保留 shell，主 Session 的权限仍是 `danger-full-access`。约束在 `prompts/orchestrator.md`，靠模型遵守。

### Thread

DSH 主 Session 是一条连续聊天会话。领域里的 `Trigger.threads` 目前仍是每条消息一个独立 Thread（`main-session:<triggerId>`，V1 本地面板、V2 工具沿用的写法，不是上游原有设计）。这样多个任务不会通过同一个 Thread 互相 fan-out；thread 语义等后续任务分派/交接设计时再定。

## 已保留的通用执行控制

`stopAssignment`、`interruptedAt` / `turnBegan`、`executionStatus` 回执、面板的“停止本次派工”接口与按钮、Worker 权限预设选择、Windows 的 `pwsh` 与路径适配都保留。

`src/executor/dsh.ts` 和 `src/app/runtime.ts` 里按 `source === 'main-session'` 走的回执分支仍在；主入口重新启用后会用到它们。

## 验证

P2 总验收见 [P2_ACCEPTANCE.zh-CN.md](P2_ACCEPTANCE.zh-CN.md)。以下是本机验证记录：

2026-11-10 在本机验证 P2.9：

- `tsc --noEmit` 通过，`tsdown` 打包通过（`lib/index.js`、`lib/client.js` 与声明文件）。
- `tests/projects.spec.ts` 8 项全通过：新增一个 Project 的 `created → paused(soft) → paused(hard, from soft) → resumed(mode hard) → ended(reason)` 事件序列，另一 Project 的 `created → archived(from active) → unarchived(status active)`；重复 pause/resume/stop/archive/unarchive 不追加；Runtime 直接执行这些状态变更时 main/PM 投递数不变。
- `tests/project-tickets.spec.ts` 26 项、`tests/settings.spec.ts` 5 项、`tests/panel-settings.spec.tsx`、`tests/policy.spec.ts`、`tests/panel-project.spec.tsx` 3 项、`tests/http.spec.ts` 5 项、`tests/archive-reconcile.spec.ts` 3 项仍通过。
- `model-surface` 通过，orchestrator 预算 61,500 未变。
- 定向 `runtime`（除既有 Git 配置路径转义 1 项）、`projects`、`project-tickets`、`settings`、`panel-settings`、`role-models` 通过。
- 全量 63 个测试文件、1251 项：1203 通过，48 失败。失败仍全是既有 Windows 环境问题：sandbox `spawn EPERM`（`service-script`、`sources` 事件消费者、`environment` 等）、Windows 路径分隔符/权限位（`docs` 3 项、`store` 1 项、`runtime` Git 配置转义 1 项）以及 `prompts` 的绝对路径读取 1 项；没有新增逻辑失败。
- 本机 `pnpm`/corepack 在 sandbox 下无法创建临时目录，测试用本地 `node node_modules/vitest/vitest.mjs --pool=threads` 运行；`vitest` 默认 forks 池会 `spawn EPERM`，这是环境限制，不是测试失败。

## 后续顺序

1. 权限控制（初版已完成）
2. 任务分派 / P2.1 Project + PM（已完成）；P2.2a PM 建 Project Ticket + child thread（已完成）
3. P2.2b 可选 tool allowlist（已完成；不做 denyTools/能力档）
4. P2.3 child report/attention 回 PM + PM 项目汇报回 Router（已完成）
5. P2.4 Project 状态与控制（已完成；当时不做归档，归档见 P2.5）
6. P2.5-A Project/Ticket 归档核心（已完成）
7. P2.5-B DSH 原生归档联动 + pendingNotes（已完成）
8. P2.6 Project pause soft/hard（已完成）
9. P2.7 PM→Worker 协调消息（已完成）
10. P2.8 eval.pmModel 独立 PM 模型（已完成；只影响新 PM Session）
11. P2.9 Project 状态变更 domain events（已完成；仅审计/测试，不 relay）
12. 任务交接（下一步）；PM 直接回答 child attention 仍留待后续
13. 意外中断与恢复
14. 再扩展新功能

## 文档说明

`docs/000` 到 `docs/008` 是上游文档；与本基线不一致的地方，以本文件和新增的 `docs/002` 主入口小节为准。`docs/PHASE1_MODIFICATION_PLAN_V2.zh-CN.md` 是历史计划，不是当前验收依据。

本次改动涉及的文件：

| 文件 | 变更 |
| --- | --- |
| `src/sources/main-session.ts` | 新增内置 User Session Source：operator 配置、Policy part、scope |
| `src/app/tools/main.ts` | 恢复 `orchestrator_user_trigger_create`，增加 Source 开关与 allowed list 检查 |
| `src/core/engine.ts` | 恢复 `recordTriggerForRouting` |
| `src/core/intake.ts` | 恢复跳过评估的参数 |
| `src/policy.ts` | 不再有 `USER_SESSION_ACTOR` 特判；权限走正常 `allowedSender` |
| `src/app/runtime.ts` | 注册 User Session Source，首启写入默认 Policy，给工具提供 operator |
| `src/kv.ts` | 记录默认 Policy 是否已播种 |
| `prompts/orchestrator.md` | 主 Session 提示词级只读，写操作先确认 |
| `prompts/dispatch.md` | 恢复主入口工具的使用说明 |
| `tests/runtime.spec.ts`、`tests/policy.spec.ts` | 覆盖默认允许、operator 配置、拒绝和关闭状态 |
| `docs/002`、`docs/004`、`docs/005`、`docs/007` | 记录主入口权限、只读约束、Source 卡片和工具 |
