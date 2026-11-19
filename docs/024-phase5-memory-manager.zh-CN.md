# Phase 5 记忆管理员与每日巡检（P5-4）

> **文档状态**：Phase 5 实现说明 / v1.0 · 2026-11-19
> **适用范围**：`next` 主线 `P5-4`（受限系统角色 `memory_manager.v1`、候选审核、每日记忆巡检）
> **上位依据**：[Phase 5 三域记忆契约](023-phase5-memory-contract.zh-CN.md)（§2.2、§2.3、§4.1、§6.2、§7.3）、已批准的 Phase 5 补充规范 `roadmap/NEXT_PHASE5_MEMORY_SUPPLEMENT_v1.0.md`（§2.2、§3、§4.1、§6.2）、[Phase 4 协作事件与执行目标解析](022-phase4-coordination-architecture.zh-CN.md)、[控制面内核](010-control-plane-kernel.zh-CN.md)、[控制台](017-console.zh-CN.md)
> **本文件的效力**：这是**实现说明**，不是新契约。契约在 [023](023-phase5-memory-contract.zh-CN.md) 里；本文件只说 `P5-4` 这一轮把契约的哪一条落成了哪段代码、哪个端点、哪条测试。

---

## 0. 这一轮做了什么，没做什么

**做了**：

1. 受限系统角色 `memory_manager.v1`，以及它在节点工具桥上的四个工具。
2. 审核作业的队列、绑定与代际：作业在控制面这边准备，管理器只能对自己那一份作业说话。
3. Router 与被授权 PM 的候选提出路径，以及被动有界退回。
4. **有界的生命周期**：审核作业有时限（到期即未完成，不可复活，可普通重试），退回之后提出者可以**再说一次**（一次为限）。
5. 每日巡检的调度、记录与控制台读法。
6. 控制台「长期记忆」面板上的审核队列、待人工确认与巡检结果。

**没做**（留给后面的轮次）：

- **没有建 `memory_tombstones`，没有遗忘入口**：遗忘语义（D1）在 `P5-4` 当时仍未决，见 [023](023-phase5-memory-contract.zh-CN.md) §8.2；**`P5-6` 已裁决为永久删除并落地**（§7.6），既没有墓碑表，也没有「留着正文只做逻辑抑制」这条路。
- **没有检索与召回**：那是 `P5-5`（`I1`、`I11`、`I18`）。
- **没有报告时自动编排**：快路由或 Worker 报告结束时的候选提取留给 `P5-6`；`P5-4` 只保证「候选进队 → 审核 → 落库」这条路现在就能走通。
- **没有改全局提示词**：Router / PM 的角色档案里各加了一句说明新工具的话，其余提示词一字未改。
- **没有改 Scheduler、角色档案的既有条目与旧插件**：调度器、四个既有角色档案与 `src/app/**` 一行未动。

---

## 1. 角色

### 1.1 `memory_manager.v1`

| 项 | 值 |
| --- | --- |
| 档案名 | `memory_manager.v1`（`src/control/roles.ts` 的 `MEMORY_MANAGER_PROFILE`） |
| 权限档 | `read-only` |
| 工具 | `memory_service_review_candidate`、`memory_service_search_memories`、`memory_service_decide`、`memory_service_return_candidate` |
| 显式拒绝 | `write`、`edit`、`bash`、`pwsh`、`web_search`、`web_fetch`、`subagent`、`send_message`、`read`、`glob`、`grep`、`job_output`、`job_list`、`job_kill` |
| 会话 id | `memory-manager`（`MEMORY_MANAGER_SESSION_ID`），不属于任何 Project |
| 节点命令 | `memory_manager.ensure`（`src/shared/protocol.ts`，附加命令，协议版本不动） |

**它没有的东西**：文件读写、命令执行、网络、派工、跨角色发消息、控制台访问、提出候选。`src/control/roles.ts` 的 `ROLE_PROFILES` 里它是第五条；`profileFor()` 查不到就全拒，规则不变。

### 1.2 其它角色的变化

| 角色 | 变化 |
| --- | --- |
| `router.v1` | 多一个 `control_memory_propose`；提示词里多一句说明。 |
| `pm.v1` | 同上。 |
| `worker.v1` | **没有变化**。Worker 的报告语义原样保留，也不提出候选。 |
| `scout.v1` | 没有变化。 |

### 1.3 审计

审计的 `kind` 词表多了一个 `memory`（`src/control/console-audit.ts`）。管理员的动作记为 `system`：`review-started`（开始审核）、`reviewed`（提交了结论）、`returned`（退回了候选）、`maintenance`（跑了一次巡检）。候选的提出者另记在候选自己的 `proposed_by_role` 上。既有 kind 的语义一个字没改。

---

## 2. 审核作业：准备、绑定、代际

一份作业（job）在控制面这边准备，在管理器醒来之前写进 `memory_review_runs`：

| 字段 | 含义 |
| --- | --- |
| `job_id` | 作业自己的名字。 |
| `candidate_id` / `checksum` | 候选的 id 与**读到的那一版**的校验值。 |
| `scope_type` / `scope_id` | 候选的作用域：检索与比较只在这里面。 |
| `source_keys` | 候选当时带的来源（`kind:id`，排序后的集合）。 |
| `session_id` | 作业派给了哪个会话；只有它能替这份作业说话。 |
| `generation` | 派发那一刻节点的信任代际。 |
| `state` | `prepared` → `dispatched` → `completed` / `failed` / `interrupted`。 |

**一次只审一条**：`prepareReview` 拒绝给同一条候选准备第二份作业（`REVIEW_ALREADY_ACTIVE`）。候选因此不会同时被两个管理员评判，也不会被第二个决定动到第一个决定已经改过的版本。

**管理器醒来**：控制面走的是普通会话的那条路——`NodeResolver` 解析目标、`memory_manager.ensure` 命令、节点确认、会话令牌签发。管理器是**按需唤醒**的：没有候选要审时它从来没有被唤醒过。两次审核之间它什么都不持有——它的权限全部绑在那一份作业上，没有作业的调用一律被拒（`JOB_NOT_FOUND` / `JOB_FINISHED`）。

**调用要过的闸**（`MemoryManager.authorize`）：

| 检查 | 拒绝码 |
| --- | --- |
| 会话存在、是 `manager`、档案是 `memory_manager.v1` | `NOT_A_MANAGER` |
| 会话未被撤权 | `SESSION_REVOKED` |
| 会话未被人工停止 | `SESSION_STOPPED` |
| 会话属于本节点 | `SESSION_FOREIGN` |
| 凭据代际与记录一致 | `SESSION_STALE` |
| 作业存在 | `JOB_NOT_FOUND` |
| 作业派给了这个会话 | `JOB_NOT_BOUND` |
| 作业还没结束 | `JOB_FINISHED` |
| 作业的代际仍是节点当前的代际 | `JOB_STALE` |
| 候选 id 与作业一致 | `CANDIDATE_MISMATCH` |
| 校验值与作业一致 | `CHECKSUM_MISMATCH` |
| 候选现在仍是那一版、来源也没变 | `CHECKSUM_MISMATCH` / `SOURCE_MISMATCH` |

**结论只是输入**。管理器提交的是一次「决定」，交给 `MemoryService.decide()`：作用域门禁、可信度推导、等待人工确认的候选只有人能决定、不可信的事实碰不了全局作用域——这些闸对管理员和对人一样。管理员的结论**不是**旁路。

**陈旧与重放**：作业结束、候选变了、来源变了、节点换代、凭据换代、别的会话冒用——任何一条成立，调用在读候选之前就被拒。一个作业只能决定一次。

### 2.1 作业有时限

被唤醒却从不调用决定工具的管理器，会把那条候选一直占住：同一条候选不允许准备第二份作业，于是除了重启，什么都不会动。作业因此**有期限**。

| 项 | 值 |
| --- | --- |
| 默认时限 | 5 分钟（`MEMORY_REVIEW_JOB_TIMEOUT_MS`） |
| 部署覆盖 | `ControlPlaneOptions.memoryReviewTimeoutMs` |
| 落点 | `memory_review_runs.expires_at`（准备作业时写下） |

到期的作业被写成**未完成的终态**：`state = 'failed'`，`detail` 记下原因（`The review ran out of time without a decision; it waits for another review.`），控制台读作「审核未完成」。

- **授权不能复活到期的作业**：迟到的调用拿到 `JOB_EXPIRED`（409），作业仍是终态。
- **重试是普通重试**：到期后同一条候选可以照常准备新作业（`prepareReview` 先扫一遍过期作业），新作业照常受同一套闸的约束。
- 重启仍然把在途作业写成 `interrupted`——那是另一件事：进程结束时的结果未知。

---

## 3. 候选的提出路径

### 3.1 端点

| 端点 | 谁用它 | 授权 |
| --- | --- | --- |
| `POST /v1/tools/memory/propose` | Router / PM | 该 Session 自己的工具令牌（`verifyToolToken` → 会话记录 → 角色档案） |

请求体：`content`、`scopeType`、`scopeId`，可选 `importance` 与 `sourceRefs`（至多 8 条，每条是 `kind`、`id`、可选 `summary`）；**再说一次**时再带上 `candidateId` 与 `checksum`（见 §3.5）。

### 3.2 权限来自会话，不来自请求

- 调用方是**它证明出来的那一个 Session**：角色来自会话记录，Project 是**真实的委托**（`pmSessionId` 指向谁谁才是 PM），请求体里的角色、项目与可信度标签一律不作数。栅栏见 §3.6。
- 作用域按 `memory-scope.ts` 的 `proposalAuthority` 判定：Router 可提本控制面的任何作用域；PM 可提自己的 Project、自己的机器，全局提议**强制降级为 `pending_human_confirm`**；Worker 没有这条路径。
- **来源要对着调用方的范围核验**，不只是「存在」：`MemoryService.submit` 会把每一条**已核验**的来源引用再解析一次，落在别的 Project 或别的机器上的记录一律**拒绝**（`SCOPE_NOT_PERMITTED`），而不是仅仅降级为不可信。
- 没有批量抽取：一次提议只能点名有限条记录 id，没有「扫描整段对话」的入口。

### 3.3 可信度一路保持

不可信就是不可信：`external_wakeup` 投递、外部事件处置、控制面查不到的来源，都会让候选落进 `pending_human_confirm` 并带上不可信标签。**不可信的事实永远不能被自动审结进全局作用域。**

### 3.4 被动有界退回

管理员判断不了时，可以把候选退回给提出它的会话：

| 规则 | 落点 |
| --- | --- |
| 退回**只写入被动队列**（`memory_candidate_returns`），不 `ensure`、不 `message` | `MemoryManager.queueReturn` |
| 一条候选**最多退回一次**（`revision_count ≤ 1`） | `MemoryService.returnCandidate` |
| 超限后**转 `pending_human_confirm`**，等人 | `MemoryService.holdForHuman` |
| 人工停止 / 撤销 / 结束 / 项目暂停或结束的会话**不接收**退回请求，请求留在队列里 | `ControlPlane.deliverMemoryReturns` |
| 退回只在目标会话**下一次收到消息时**才交付 | `ControlPlane.sendMessage` |

退回请求还**记下两件事实**：退回那一刻候选的**版本**（`checksum`），和提出者当时**持有的权限**（角色、机器、真正被委托的 Project）。它们是「再说一次」唯一的凭据。

### 3.5 再说一次（proposer-bound 单次复评）

退回只是半程。提出者被退回之后，需要有办法**把这条候选再说一次**——这次是**同一条候选**，不是新的一条。

| 规则 | 落点 |
| --- | --- |
| 复评由**提出者本人**发起：`control_memory_propose` 带上 `candidateId` 与 `checksum` | `ControlPlane.memoryProposeFor` |
| 只能从**排队中或已交付**的退回请求发起，且必须是等在那里的那个会话 | `MemoryManager.pendingReturnOf` |
| 必须仍是**请求记下的那份权限**（角色 / 机器 / Project 一致） | `ControlPlane.memoryReevaluateFor` |
| 必须落在**请求记下的那个版本**上，否则 `STALE_CANDIDATE` | `MemoryService.reevaluate` |
| **只有一次**：第二次是 `REEVALUATION_LIMIT_REACHED`，候选转等人 | `MEMORY_REEVALUATION_LIMIT = 1` |
| 作用域**不许换**：候选还在它自己的作用域里 | `SCOPE_MISMATCH` |
| 复评后回到**它原来那一档队列**：全局作用域或不可信的事实**仍然等人**，管理员照样判不了它 | `MemoryService.statusOfSubmission` |
| 复评**不唤醒原会话**：没有人被 `ensure`，也没有人被 `message` | `ControlPlane.memoryReevaluateFor` |
| 候选回到队列的**同一行**（id、来源、可信度、作用域都不变），只有正文可以改 | `MemoryService.reevaluate` |

候选与请求的两次写是**一个事务**：要么候选回到队列且请求作废，要么两者都没动。

### 3.6 提出路径的栅栏与数据栅栏

**提出路径与 `P5-1` 的读取栅栏同一口径**（`ControlPlane.memoryProposalCaller`）：会话必须真实存在、属于本节点、未被撤权、未被人工停止；Router 必须是本控制面的那一个 Router（`router`）；PM 必须真的是某个 Project 的 PM，且那个 Project 还在进行（暂停 / 结束 / 归档的 PM 不能提）。**这一切都不要求节点在线**——它读的是会话自己的记录，不是那台机器的当前状态，也不读任何别的作用域的东西。

**管理面消息里的候选正文是数据**：正文被转义后写进 `<memory_candidate_data>` 栅栏（`&`、`<`、`>` 转义，控制字符换成空格），所以它**关不掉自己的栅栏**、开不出自己的标签、也塞不进一个换行。退回理由是模型自己的话，同样**按数据引用**（`<memory_return_data>` 栅栏）。转义实现在 `src/infra/text.ts` 的 `quotedData` / `dataFence`。

---

## 4. 每日巡检

### 4.1 调度

巡检是控制面自己的轻量时钟，不是 Scheduler 的一条计划：Scheduler 仍然只面向「已启动的项目 PM」投递消息，巡检不经过它。

| 项 | 值 |
| --- | --- |
| 配置 | `ConsoleRuntimeSettings.memoryMaintenanceEnabled`（默认开）、`memoryMaintenanceMinuteOfDay`（默认 180，即 UTC 03:00） |
| 部署开关 | `ControlPlaneOptions.memoryMaintenanceEnabled`、`memoryMaintenanceMinuteOfDay` |
| 时限 | `ControlPlaneOptions.memoryMaintenanceTimeoutMs`（默认 30 000 毫秒） |
| 起步 | `ControlPlane.startMemoryMaintenance()`（`src/control/start.ts` 在注册节点后调用） |

**错过的时间窗不补跑**：巡检只看「今天这一格」，控制面停了两天，恢复后跑的是今天这一格，不是两天前的那一格。已经跑过的那一格有记录，不会再跑第二次。

### 4.2 记录

`memory_maintenance_runs` 建在 `control.sqlite` 里（与候选、记忆同一个原子快照组）。

| 状态 | 含义 |
| --- | --- |
| `attempted` | 巡检开始了，结果还不知道。 |
| `succeeded` | 巡检跑完了：查看了队列、冷置了陈旧候选、发起了该发的审核。 |
| `failed` | 巡检没跑完：审核没发出去，或者**超时**。 |
| `skipped_offline` | 节点离线，本轮**没有运行**。 |
| `skipped_no_node` | 没有可用的节点，本轮没有运行。 |
| `skipped_disabled` | 巡检被关掉了，本轮没有运行。 |
| `interrupted` | 控制面在巡检进行中重启，结果未知。 |

**没有假完成**：离线不写 `succeeded`；重启把 `attempted` 改成 `interrupted`；超时写 `failed`；只做了检查没能处理的写 `failed`（而不是「成功但发现了问题」）。计数是有界的：`checked`、`duplicates`、`conflicts`、`expired`、`stale`。

### 4.3 端点

| 端点 | 谁用它 | 授权 |
| --- | --- | --- |
| `GET /v1/console/memory/maintenance` | 控制台 | 控制台连接密钥，或只读密钥（只读密钥只能 `GET`） |
| `POST /v1/console/memory/maintenance/run` | 控制台 | **只有操作员**（只读密钥 403，无凭据 401） |
| `GET /v1/console/memory/reviews` | 控制台 | 同上 |

手动巡检返回的是**真实结果**：节点离线时返回 `skipped_offline`，不是成功。读的是**已经落库的记录**，不是现算的。

---

## 5. 控制台

`#/memory` › 长期记忆 面板现在有五块（`src/console/memory.tsx`）：

| 块 | 内容 |
| --- | --- |
| 提出一条候选 | 不变（`P5-3`）。 |
| **等待人工确认** | `pending_human_confirm` 的候选单独列出，并给出「通过 / 不采纳」。 |
| 候选队列 | 不变，但人工的「退回」改说**「不采纳」**——被动的退回是另一件事，界面上分开说。 |
| **记忆管理员的审核队列** | 每份审核作业的状态：`已准备，尚未派发` / `审核中` / `审核已完成` / `审核未完成` / `审核被中断，结果未知`。 |
| **每日巡检** | 巡检的真实结果与计数、下次巡检时间、以及一个「立即巡检一次」的操作员动作。 |
| 已保存的长期记忆 | 不变（`P5-3` 的可信列表）。 |

**加载中 / 失败 / 空是三件不同的事**，每一块都分开说。巡检的状态词里没有「完成」以外的糊弄：离线、关闭、中断、超时各有各的话。

**窄屏与可访问性**：新块沿用既有 `memory-block` / `memory-block-head` / `memory-rows` / `setting` 结构与 `aria-labelledby` 分区，按钮有 `aria-label`（`通过候选 <id>` / `不采纳候选 <id>`），状态词是文本而不是颜色。

---

## 6. 测试目录

`tests/memory-manager.spec.ts`（新）、`tests/console-memory.spec.ts`（扩）、`tests/memory-service.spec.ts`（回归）、`tests/control-plane-tools.spec.ts` 与 `tests/node-tool-boundary.spec.ts`（角色档案与工具注册的硬编码期望）。

| 组 | 断言 |
| --- | --- |
| 角色档案 | 四个工具、别的一个都没有；`read-only`；显式拒绝写入与命令；Router / PM 多一条 `control_memory_propose`；Worker 一条不多。 |
| 真实工具桥 | 节点上注册给管理器的**正好**是那四个工具。 |
| 作业队列 | 同一条候选的第二份作业被拒；作业绑定会话与代际。 |
| 陈旧 / 重放 / 外来 | 别的会话的作业、结束的作业、旧代际、别的候选、别的校验值、变了来源的候选、被撤权 / 被停止 / 外来 / 凭据过期的会话、不是管理员的会话——逐一被拒。 |
| 唤醒与审核 | 管理器被唤醒、读到自己那条候选、在自己的作用域里检索、提交一个结论、结论落到记忆里。 |
| 双重决定 | 同一份作业的第二次决定被拒（409）。 |
| 人工闸 | 无法核验的候选落进 `pending_human_confirm`，管理员根本没被唤醒；操作员的人工决定照旧可用。 |
| 提出路径 | 别的 Project 的作用域被拒；引用别的 Project 的记录被拒。 |
| 被动退回 | 退回只进队列、不唤醒任何人；`revision_count` 记 1；记下退给了谁。 |
| **时限** | 没人做决定的审核被写成未完成的终态并记下原因；迟到的调用被拒（409）；同一条候选的**普通重试**照常通过。 |
| **再说一次** | 提出者把候选再说一次：同一条候选回到队列；第二次被拒；没有人被唤醒。 |
| **数据栅栏** | 退回理由交回提出者时是**按数据引用**的（栅栏在、正文在、栅栏关得上）。 |
| 巡检记录 | 在线跑完是 `succeeded`；离线是 `skipped_offline`；关掉是 `skipped_disabled`；超时不是 `attempted`；只读密钥能读不能跑。 |
| 巡检与重启 | 进行中的巡检在控制面重启后是 `interrupted`。 |
| 回归 | `P5-3` 的四条控制台端点与既有界面照旧工作。 |
| 控制台 | 审核队列、待人工确认、巡检结果与下次时间；加载中 / 失败 / 空分开说；「不采纳」与被动退回分开说；没有遗忘入口。 |

---

## 7. 文件

| 文件 | 这一轮改了什么 |
| --- | --- |
| `src/memory/memory-manager.ts` | **新增**：审核作业、授权、被动退回队列、每日巡检的记录与计数；作业的**时限**（`expires_at`、到期写成未完成的终态、`JOB_EXPIRED`）；退回请求记下候选的**版本**与提出者的**权限**。 |
| `src/memory/memory-service.ts` | 新增 `readCandidate`、`listMemoriesInScope`、`returnCandidate`、`holdForHuman`、`reevaluate`；候选视图多 `returnedToSessionId` 与 `reevaluations`；`submit` 多一条「来源必须在调用方范围内」的核验。 |
| `src/memory/memory-scope.ts` | 新增 `recordWithinCaller`。 |
| `src/infra/text.ts` | 新增 `quotedData` 与 `dataFence`：按数据引用一段文本的管理面栅栏。 |
| `src/control/roles.ts` | 新增 `MEMORY_MANAGER_PROFILE`；Router / PM 多一条 `control_memory_propose` 与一句提示。 |
| `src/shared/protocol.ts` | `SessionRole` 多 `manager`；新增 `memory_manager.ensure`；`ConsoleRuntimeSettings` 多两个巡检设置。 |
| `src/shared/session-token.ts` | 令牌承认 `manager` 这个角色。 |
| `src/node/dsh-port.ts`、`src/node/dsh-port-host.ts`、`src/node/fake-node.ts`、`src/node/command-validation.ts` | 管理器的会话、它的四个工具、节点侧的落点；`control_memory_propose` 多两个可选参数（`candidateId`、`checksum`）。 |
| `src/control/control-plane.ts` | 管理器的唤醒、派发、四个工具的处理、提出路径、**复评路径**、被动退回的交付、巡检的调度与记录。 |
| `src/control/server.ts` | 工具路由与控制台路由。 |
| `src/console/api.ts`、`src/console/memory.tsx` | 控制台的新读法与新块。 |

---

## 8. 与后面两轮的关系

- `P5-5` 的检索器只读长期记忆表，不碰这里的任何写入路径；`MemoryManager` 的检索工具目前是**同作用域内的确定性列举 + 关键词过滤**，不是向量召回。
- `P5-6` 的端到端演示会用到这里的三条路径：候选进队 → 管理员审核 → 落库；被动的退回；以及重启后三域状态一致。遗忘拦截仍然要等 D1 的裁决。

---

## 9. 文档入口

- [Phase 5 三域记忆契约](023-phase5-memory-contract.zh-CN.md)：本轮实现的上位契约与不变量。
- [Phase 4 协作事件与执行目标解析](022-phase4-coordination-architecture.zh-CN.md)：`NodeResolver`、代际与拒绝审查。
- [控制面内核](010-control-plane-kernel.zh-CN.md)：控制面持有的事实与它们的权威位置。
- [控制台](017-console.zh-CN.md)：控制台页面与操作。
