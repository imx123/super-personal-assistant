# 023 Phase 5 三域记忆契约

> **文档状态**：Phase 5 数据契约与设计门禁 / v1.0 · 2026-11-19
> **适用范围**：`next` 主线 `P5-0` 至 `P5-6`（三域记忆系统），并为 `feat/multi-node` 预留 `node_id` / `backend_id`
> **上位依据**：`docs/roadmap/NEXT_MAINLINE_PLAN_v1.1.md` §4 的 `P5-0`、已批准的 Phase 5 补充规范（工作树内 `.artifacts/phase5-p5-0-20261119/approved-memory-supplement.md`，与 `docs/roadmap/NEXT_PHASE5_MEMORY_SUPPLEMENT_v1.0.md` 的**已提交版本**同源）、[控制面内核](010-control-plane-kernel.zh-CN.md)、[控制台](017-console.zh-CN.md)
> **本文件的效力**：这是一份**契约**，不是实现。`P5-0` 那一轮不落任何新表、不开任何写入路径、不删除任何真实数据；后续每一轮都照这份契约落**它自己那一步**的部分。
> **已实现的部分**：`P5-1` 的实时状态（§7.1）、`P5-2` 的持久事件历史（§7.2）与 `P5-3` 的记忆服务（§7.3）已经上线；其余部分仍然是契约。

---

## 0. 本文件的读法与效力

### 0.1 这是什么

`P5-0` 的产出是三件事：

1. **数据源清查**（§1）：把控制面今天真实持有的每一份记录列清楚，并指出它们**不是**什么。记忆系统的第一步错误永远是「把已有的某张表叫做记忆」，所以本文件先把边界钉死。
2. **契约**（§2–§7）：作用域、逻辑键、来源可信度、脱敏、事务边界、索引与查询、生命周期、权限矩阵，以及一组**可写成测试**的不变量。
3. **门禁与 ADR**（§8）：存储与检索选型、遗忘语义与备份策略。每一条都给出**两个以上真实方案**与取舍，凡是需要不可逆操作或外部重依赖的，一律标为「待用户决策」，本轮不实施。

后续工程师接手时，`P5-1` 至 `P5-6` 的顺序、每一步要满足哪条不变量、哪一步的产物接在哪张表上，见 §10。

### 0.2 一份必须先记录的冲突

已提交的 `docs/roadmap/NEXT_PHASE5_MEMORY_SUPPLEMENT_v1.0.md` 在 §4.2 规定：用户手工删除一条长期记忆时，除把记录标为 `forgotten` 外，还要在 `memory_tombstones` 表里记录其**规范化内容指纹与作用域**；此后每日维护或历史报告重审若再提取出命中墓碑指纹的候选，直接静默拦截（除非用户再次通过 `operator_explicit` 显式重新设定）。**墓碑即逻辑抑制**：内容可以被物理删除，但「不要再把它提取出来」这件事本身被持久地记下来。

本工作树里，同一个路径 `docs/roadmap/NEXT_PHASE5_MEMORY_SUPPLEMENT_v1.0.md` 上还挂着一份**未提交**的改动：它把上述条款改成**永久删除**——删除时抹掉正文、待审副本、关键词索引与向量，**不为该条记忆保留墓碑或归档副本**，删除后按 ID 读取与未知 ID 返回同一种「记忆不存在或已被用户删除」。也就是说：**已提交的版本是基线，工作树里的改动是提案**，两者并存于同一个文件的工作区状态中。

本文件的处置：

- **不修改、不暂存、不删除、不恢复、不采纳**那份未提交改动。它保持为工作树里一份未提交的提案，与已提交的基线并存。
- **不实现任何一边**：本轮不删任何真实数据，也不新增任何持久写入。
- **如实记录冲突与后果**，见 §0.2 与 §8.3（ADR-3）。需要用户裁决；裁决之前，两条路径都不进入实现。

### 0.3 需要用户决策的事项

| 编号 | 事项 | 状态 |
| --- | --- | --- |
| D1 | 遗忘语义：指纹抑制（墓碑）还是物理删除，还是两者并存 | 待决策，见 §8.2 / §8.3。`P5-3` 那一轮**没有实现任何一边**：没有 `memory_tombstones` 表，也没有删除入口，其余流程照 §7.3 落地 |
| D2 | 物理删除与备份的关系：删除是否必须穿透已有备份 | 待决策，见 §8.2 |
| D3 | 存储与检索的最终形态：本地 SQLite + FTS5，还是引入外部向量库 | 首版按可逆方案落地，外部方案待批准，见 §8.1 |

**D4 不是待决策项。** 已批准的补充规范 §1.2 已经把**同一原子快照组**写成硬约束：无论记忆表族放在 `control.sqlite` 里还是放在独立库里，备份与回滚都必须把它与 `control.sqlite` 当作一个原子快照组处理，防止回滚后记忆的来源 `ticketId` / `assignmentId` 变成悬空引用。这条是**要求**，不是**选项**。剩下的只是一个**摆放位置**的实现选择：默认放在 `control.sqlite`（见 §8.4 的 ADR-4），备选的独立库布局延后到需要时再启用。两者都遵守同一条快照组约束。

---

## 1. 数据源清查

本节只写**源码核对过的事实**。每个结论都给出文件与位置，便于后续核对而不必重读。

### 1.1 `control.sqlite`：控制面的业务库

- **路径**：`SUPERAGENT_CONTROL_DB`，默认 `<SUPERAGENT_NODE_ROOT>/control.sqlite`（`src/control/start.ts:210`、`src/control/start.ts:287`）。
- **打开**：`src/app/store.ts` 用 `node:sqlite` 的 `DatabaseSync` 打开，目录 `0700`、文件 `0600`，`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`。控制面启动时用 `proper-lockfile` 锁住**目录**（`src/control/control-plane.ts:1938`），锁的 stale 阈值 30 秒。
- **迁移方式**：域模型走 `kv['schema']` 里的版本号（当前 `SCHEMA_VERSION = 11`，`src/app/migration.ts:20`），迁移在事务里跑；控制面自有的表走**幂等 `CREATE TABLE IF NOT EXISTS`** 加事后 `ALTER TABLE ADD COLUMN`，**没有独立的 schema 版本表**。
- **域模型表**（`src/app/store.ts:64`、`src/app/store.ts:71`）：

  | 表 | 逻辑键 | 形态 | 备注 |
  | --- | --- | --- | --- |
  | `kv` | `key TEXT PRIMARY KEY` | `value` JSON blob | 控制面的 Session 记录就在这里：`kv['control/session:<sessionId>']` |
  | `trigger` | `id TEXT PRIMARY KEY` | `value` JSON | 人的原话在 `value.text` |
  | `disposition` | `id TEXT PRIMARY KEY`（= trigger id） | `value` JSON | 一个 Trigger 去了哪里 |
  | `thread` | `key TEXT PRIMARY KEY` | `value` JSON | 会话绑定 |
  | `ticket` | `id TEXT PRIMARY KEY` | `value` JSON | **工单、派工、报告、验收、停止、交接的事实都在这里** |
  | `decision` | `id TEXT PRIMARY KEY` | `value` JSON + `thread` 列 | 门禁结论 |
  | `project` | `id TEXT PRIMARY KEY` | `value` JSON | **项目档案：目标、工作区、PM Mandate、状态** |
  | `outbox` | `id TEXT PRIMARY KEY` | `value` JSON | 控制面**不写**这张表（用内存 `KernelOutbox`） |
  | `trigger_thread` | `(thread, id)` | 关系表 | |
  | `effect` | `(kind, key)` | `value` JSON | 控制面**不写**这张表 |

- **控制面自有的协调表**（全部带 `node_id` / `backend_id` 预留列，除注明外）：
  - `coordination_deliveries`（`src/control/delivery-outbox.ts:428`）：六类协调投递的持久表。`delivery_id` 唯一；`dedup_key` 上有一个**部分唯一索引**，只覆盖活跃状态，用来保证「一条相同的投递只有一条」。字段里有 `project_id` / `ticket_id` / `assignment_id` / `review_id` / `source_session_id` / `target_session_id` / `target_role` / `node_id` / `backend_id` / `expected_*` 代际 / `payload` / `error` / `context` / `expires_at`。
  - `permission_denial_counters`、`permission_denial_calls`、`permission_denial_effective`、`permission_denial_reviews`、`denial_authorization_applications`（`src/control/denial-escalator.ts:491`）：真实权限拒绝的计数、逐次调用、有效拒绝、审查与人工授权申请。**被拒调用的参数与输出不落库**，只留工具名、原因码、轮次与计数。
  - `external_event_subscriptions`、`external_event_dispositions`（`src/control/event-subscriptions.ts:294`）：外部观察事件的订阅与逐事件处置。**事件载荷本身不落库**。
  - `session_stream_subscriptions`（`src/control/stream-subscriptions.ts:93`）：下级会话的周期摘要订阅与水位。**摘要正文不落库**，它每次从控制台的事件日志现算。
- **没有外键**：全部 DDL 里没有 `REFERENCES`，`PRAGMA foreign_keys` 从未打开。跨表引用（`ticket.projectId` → `project.id`、`target_session_id` → `kv['control/session:<id>']`）**只在 TypeScript 里成立**。
- **保留**：域表**永久**。`coordination_deliveries` 没有 `DELETE`，只有消息寿命 `expires_at`（默认 7 天），过期是**关闭**而不是删除。拒绝计数与审查表也不裁剪。

**对契约的含义**：事件历史的**权威事实**在 `ticket.value` 与 `project.value` 里；投递、拒绝、外部事件、摘要订阅这些**协调事实**已经是持久且不受裁剪的，可以直接作为 `P5-2` 事件索引的原料，不需要先搬家。

### 1.2 `console.sqlite`：控制台自己的库与它的裁剪

- **路径**：`SUPERAGENT_CONSOLE_DB`，默认与 `control.sqlite` 同目录（`src/control/start.ts:242`）。两个库的路径**被强制要求不同**（`src/control/start.ts:226`）。
- **表**（`src/control/console-store.ts:338`）：`console_meta`、`audit`、`event_log`、`project_memory`、`reconcile_run`、`stop_notice`、`router_queue`、`fast_route`、`project_gate`、`router_handoff`；调度器另占 `sched_plan`、`sched_run`、`sched_meta`（`src/control/scheduler.ts:370`）。调度器与控制台库**共用同一个文件**（`db: consoleDb.db`）。
- **裁剪规则**（`src/control/console-store.ts:1036` 的 `prune()`；调度器的运行历史另由 `scheduler.ts` 的 `pruneRuns()` 处理）：

  | 表 | 保留规则 | 默认值 |
  | --- | --- | --- |
  | `event_log` | **行数** + **天数**（全局，不按会话或项目分） | 20 000 行 / 7 天 |
  | `audit` | 只按**天数**；`0` 表示永久。**没有行数上限** | **0（永久）** |
  | `stop_notice` | 只按行数（全局） | 1 000 行 |
  | `router_queue` | 只裁**终态**行（`read`/`failed`/`routed`）；未终态的行永不删 | 200 条终态行 |
  | `fast_route` | 裁的是**在途**阶段（`queued`/`assigned`/`escalated`/`model`/`failed`/`unconfirmed`）；**已落定的行永不删** | 200 条在途行 |
  | `project_gate` | **无状态过滤**，纯按最新 200 行 | 200 行 |
  | `router_handoff` | 与 `fast_route` 同形：裁**在途**阶段，已落定的行永不删 | 200 条在途行 |
  | `project_memory` | 按项目行数，**只在写入时**裁 | 每项目 200 条，每条 ≤ 500 字（单次读取只取 20 条） |
  | `sched_run` | 只裁**终态**运行（`delivered`/`failed`/`interrupted`）；在途的永不删 | 500 条 |
  | `sched_plan` | **只软删**（`deleted=1`），从不物理删除 | — |
  | `reconcile_run`、`console_meta`、`sched_meta` | 不裁 | — |

  `event_log` 的行号**不复用**：文件自己的计数器独立于被删的行，所以断口是可判定的。`/v1/events` 会明确报告 `gap`（`src/control/control-plane.ts:8325`），因为被裁掉的事件**再也送不回来**。裁剪每记满 1000 条事件触发一次，控制面启动时也做一次（`src/control/control-plane.ts:8998`、`:1974`）。三个保留数字都可由环境变量改：`SUPERAGENT_CONSOLE_EVENT_ROWS`、`SUPERAGENT_CONSOLE_EVENT_DAYS`、`SUPERAGENT_CONSOLE_AUDIT_DAYS`。
- **按天数裁剪有两处需要留意的口径**：① 天数比较是**字符串比较**——`olderThan()` 返回 `.toISOString()`，`event_log.at` 与它按字典序比（`src/control/console-store.ts:1069`）；② `event_log.at` **多数来自节点自己的时钟**（节点事件的 `at` 是节点写的），不是控制面的钟。所以「7 天」是以**远端机器的时钟**为准的。**事件历史若要按时间归档，自己的 `at` 必须取控制面的钟**，不能沿用节点的时间戳。
- **`event_log` 的读没有按种类或类型的过滤器**：所有读法只按 `seq` 或 `session_id` 过滤（`eventsAfter`、`messagesFor`、`sessionEventsBetween`）。`audit` 反而有按 `kind` 的过滤（`GET /v1/audit?kind=`）。
- **一条必须记住的事实**：控制面保存的**会话对话本身**就住在 `event_log` 里。节点报来的 `session.event` 被整条序列化进 `payload`（`src/control/control-plane.ts:8990`），其中 `kind='message'` 的事件带的是**人与模型的原话**（`src/node/dsh-port-host.ts:2432`）。控制台的会话页就是从这张表读消息的（`GET /v1/console/sessions/:id/messages` → `sessionMessages()` → `event_log` 中 `kind='message'` 的行）。也就是说，**对话不是持久的**：它和事件日志一起被 20 000 行 / 7 天裁掉。这正是 `P5-2` 要另建 `event_history_index` 的原因，也是「持久事件历史不得寄生在 `event_log` 上」的硬理由。
- **一处必须记为风险的读法**：`sessionMessages()` 用的是 `ORDER BY seq LIMIT 200`（`src/control/console-store.ts:502`），取的是**最早**的 200 条，不是最近的；超过 200 条时**最新的消息被静默省略**，且这条路径**不报告 `gap`**。Router 的对话页与 PM/Worker 的会话页都走它。对照之下 `/v1/events` 与 `/v1/events/stream` 都明确报告断口。本契约要求：**任何拿事件日志当历史读的路径，都必须像 `/v1/events` 那样把断口说出来**（§6.2 I19）。
- **`event_log` 并非「所有节点事件」的堆放**：节点协议里的 `review.diff` 与 `delivery.evidence` **从不入日志**（`src/control/control-plane.ts:8886`、`:8892`），`tool.fact` 要通过 `acceptsToolFact()` 才入（`:8898`），`tool.call` 的 `args` 被抹掉只留调用本身（`:9033`）。日志里真正记下的是 `node.status`、`session.status`、`session.event`、`session.inspected`、`tool.call`、`tool.fact`、`schedule.run`。
- **`audit` 的语义**：它是**操作事实**的轨迹（创建了项目、分派了工单、验收通过、节点断开），不是事件流水。它的 `detail` 是 `redactCredentials(detail).slice(0, 300)`——凭据被抹、**路径保留**（`src/control/console-audit.ts:57`），从不写请求体、令牌、原始 diff 或定时任务正文。
- **自由文本在哪里，以及是否脱敏**：`console.sqlite` 是控制面里**自由文本最集中**的库。

  | 列 | 内容 | 写入前处理 |
  | --- | --- | --- |
  | `project_memory.text` | 操作员的手工便签 | **不脱敏**（就是操作员写的话） |
  | `router_queue.text` | 人发给 Router 的消息与附件 | **不脱敏** |
  | `fast_route.text` / `project_gate.text` / `router_handoff.text` | 快路由、门禁、交接读到的**人的原话** | **不脱敏** |
  | `router_handoff.instruction` / `rationale` | 真正发给 PM 的话与理由 | **不脱敏** |
  | `event_log.payload` | 事件的完整载荷，**含人与模型的对话原文** | **不脱敏**（只有 `tool.call` 的 `args`、被拒调用的参数被抹） |
  | `audit.detail` | 短的脱敏描述 | `redactCredentials`（**路径保留**）+ 截断 300 |
  | 调度器写入的审计 detail / 运行 error | 定时任务相关的描述 | 完整 `redact`（**路径也抹**）+ 截断 300（`src/control/scheduler.ts:1223`） |
  | `fast_route.detail` / `project_gate.detail` / `router_handoff.detail` | 规则与门禁的措辞 | **不脱敏** |
  | `sched_plan.message` / `sched_run.message` | 定时任务正文 | **不脱敏** |

  **长期记忆与事件历史若引用这些来源，只能引用其 id 与一段已脱敏的摘要**，不能把原文搬进去（见 §3.2、§3.3）。

**对契约的含义**：

- `event_log` **不得**承载 `Event History` 或 `Long-term Memory`。它按定义会被裁掉，规范 §1.2 已经这么写；这里补上原因——控制面连**对话本身**都只存在这张表里，它连「曾经发生过什么」的完整性都不保证。
- `audit` 即使默认永久，**也不能**当作事件历史：它记的是「谁做了什么」，不是「什么时候发生了什么」，两者查同一件事给出的答案不同。
- `project_memory` 是**手工**上下文，**不是**长期记忆。它没有检索、没有可信度、没有来源引用、没有作用域判定。
- `fast_route` / `project_gate` / `router_handoff` 三张表的裁剪口径与各自注释描述的意图**不一致**（注释说「只裁已落定的」，代码裁的是在途的；`project_gate` 则完全不按状态过滤）。这是既有实现的事实，**本轮不改**；但 `P5-2` 若以这些表为事件原料，必须按「随时可能被裁、且不报告断口」来设计，不能假定它们是完整的。

### 1.3 节点侧的 DSH 会话出处（只核对源码，不读任何真实日志）

- 控制面**从不**读节点上的会话日志：源码里没有 `DSH_HOME` 这个名字，也没有别的指向 DSH profile home 的路径（`src` 全目录检索无命中）。会话留在节点自己的 DSH profile 里，落盘形态由节点部署文档记录为 `$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`（`docs/015-node-deployment.zh-CN.md` §节点部署），一份 JSONL 装下整个会话事件流——**没有单独的「工具调用日志」或「消息日志」**。
- **更强的边界**：`src/control/**` 与 `src/core/**` 里**没有一个 `@deepseek-ai/*` 导入**（`src/control/` 全目录检索为空）。控制面连 DSH 的类型都拿不到，只能经 HTTP/SSE 与节点通信（`src/control/http-node.ts` / `src/node/http-server.ts`），而节点协议里**没有任何读 transcript 的命令**（`src/shared/protocol.ts` 的命令集 + `src/node/command-validation.ts`）。
- 节点插件**也不读** `DSH_HOME`：它跑在 DSH 宿主里，由 DSH 自己解析 home；插件只读 `SUPERAGENT_NODE_*` 与 `SUPERAGENT_CONTROL_URL`（`src/node/plugin.ts:57`）。
- **一个有用的对应**：在节点上，**DSH 会话 id 就是控制会话 id**（`agents.create({ sessionId: id })`，`src/node/node-sessions.ts:252`；`inspectSession` 回 `backendSessionId: sessionId`，`src/node/dsh-port-host.ts:891`）。所以控制面记录的 `controlSessionId` 已经足以定位节点上的那一段会话，不需要另存路径。
- 需要分清一处例外：**旧插件运行时**（`src/app/`）有自己的 `ticket/<id>/transcript` 资源（`src/app/resources.ts:40`），读的是它自己那份运行时的事件视图。旧插件与独立控制面**各自持有数据**（`project_handoff.md` §3），所以那条 transcript 不是控制面能读的记录，也不属于本契约的来源。
- 本仓库读 DSH 会话日志的地方**只有一处**：旧插件的 `AgentDelivery.history()`（`src/app/delivery.ts:84`）经 `ctx.sessionPersistence.open(agent.id, 'read')` 读**已落盘**的会话日志，只取**投递用的消息 id**（`eventDeliveryIds`），用来让投递在重启后仍然幂等。控制面侧没有对应物。
- **拿得到的**：会话是否存在、它的后端 id、角色、Assignment、Project、工具调用的事实（工具名、成败、call id、改动过的相对路径）。
- **拿不到的**：完整对话、模型的原话、私密日志全文。节点侧的边界写得很清楚——调用的参数与工具的输出**不离开节点**（`src/node/dsh-port-host.ts`）。
- **节点侧没有会话日志的清理**：`src/node/**` 里没有任何删除会话文件的代码。控制台的「检查并清理」只是让节点**停止并归档**残留会话（`session.archive` → `workspaceRegistry.archiveSession`），不删文件。会话日志、工作区与数据库按各自的生命周期保留（`docs/015-node-deployment.zh-CN.md`）。
- 控制面自己这边留下的**可引用**事实是：`ticket.value.assignments[].id`（派工 id）、`ticket.value.assignments[].report`（报告）、`ticket.value.reviews[]`（验收轮次）、`kv['control/session:<id>']`（会话）、`coordination_deliveries.delivery_id`（投递）、`audit.seq`（操作事实）。

**对契约的含义**：记忆的**来源引用只能指向控制面自己持有的记录**（`ticketId` / `assignmentId` / `reviewId` / `deliveryId` / `controlSessionId` / `auditSeq`）。任何形如「节点上某段对话里说过」的说法都**不可核验**，不能作为 `verified_execution` 的依据。真要读回一段会话，**必须先在节点协议上新增一个 transcript 读取命令**——本契约不假装控制面今天能做这件事。

### 1.4 项目工作区

- 项目的工作区在 `project.value.workspace`（绝对路径），会话的工作区在 `kv['control/session:<id>'].workspace`。路径必须绝对（控制面入口拒绝相对路径与控制字符，`src/control/control-plane.ts:2831`），且必须落在配置的**工作区根目录**内，符号链接与 Windows 联接都要解开再判（`src/shared/workspace-path.ts:22`：`within()` 的词法判断 **与** `resolveDirectory()` 的 realpath 判断**两道都要过**）。节点侧再按**节点自己的根**校验一次（`src/node/dsh-port.ts:125`）。项目的工作区**一旦设定不可改**（`src/control/control-plane.ts:6657`）。
- **工作区内容今天只有一处被读**：PM 验收时看代码差异。控制面把审查绑到项目（命令里**只有项目 id，没有路径**，`src/shared/protocol.ts:344`），**节点**去做只读 Git diff（`src/node/review-diff.ts`，固定 argv、无 shell、超时与字节上限、拒绝 linked worktree 与外借对象库），diff 文本在这一次被授权的请求里被消费，**不落库**、不进事件历史。
  - 一条硬证据：`review.diff` 事件**被显式排除**在事件日志与事件流之外（`src/control/control-plane.ts:8886`：「it carries the content of a Project's workspace… it is neither recorded nor announced」），只作为这一次 HTTP 答复交给发问的 PM。
- 顺带澄清一处常被误认的读取：周期摘要（`src/control/stream-subscriptions.ts`）读的是**事件日志**里「某个工具调用改了哪些相对路径」与「模型最后一段输出的尾巴」，不是去读工作区文件。那段输出是**模型的原话**，属不可信数据。
- 能从工作区得到的、可核验的标识只有 Git 层面的东西，而且**很窄**：仓库根、**基线提交号**（`rev-parse --verify --quiet HEAD` 的完整 40 位 sha）、改动文件**名**列表、未跟踪文件**名**列表、空白检查结果。**没有分支名**（`src/node/review-diff.ts` 不读分支），也没有远端、作者。**未跟踪文件的内容从不读**，只读名字。这些必须由**节点**读、由**控制面**转述，并且记成 `verified_execution`（因为它经过了一次已验收的审查）或 `external_tainted`（未经人工核实）。
- **从工作区落进 SQLite 的只有元数据**：`tool.fact` 事件里的**相对路径**（≤ 20 条、每条 ≤ 200 字符、绝对路径与 `..` 被拒，`src/control/control-plane.ts:1594`）。文件内容一次也没有落库。

**对契约的含义**：工作区的文件内容**不是**记忆的来源。禁止把 diff 文本、源文件片段或报告正文整段复制进候选或长期记忆。

### 1.5 五类对象：分别枚举

规范 §1.1 列了五类。逐个说清**今天在哪里**、**今天不是什么**、**本轮做什么**。

| 对象 | 权威存储（今天） | 今天真实持有的内容 | 今天**不是**什么 | 本轮 | 后续 |
| --- | --- | --- | --- | --- | --- |
| **Live State** 实时状态 | 内存聚合：`overview()`（`src/control/control-plane.ts:8349`）、`NodeResolver.getLiveNodeSnapshots()`（`src/control/node-resolver.ts:199`） | 节点在线状态与会话数、工单数、项目数、会话数、待验收数、事件序号与保留数 | 不是记录，不进任何长期存储，不触发模型 | 接到控制台 `#/memory` 的「实时状态」面板（只读） | `P5-1` |
| **Project Profile** 项目档案 | `control.sqlite` 的 `project` 表 + `kv` 的 PM Mandate | 项目标题、目标、工作区、PM 会话 id、状态、`pauseMode`、`latestReport.summary`、PM Mandate | 不是 RAG 知识库，不进长期记忆 | 不动 | 保持 |
| **Project Memo** 项目备忘 | `console.sqlite` 的 `project_memory` | 操作员手工写的项目便签：`id`、`project_id`、`at`、`actor`、`text`，每项目最多 200 条 | 不是模型提取的候选，不是检索索引，没有可信度与来源引用 | 不动；在「记忆」页点名它并指向「项目 › 项目备忘」 | 保持 |
| **Durable Event History** 持久事件历史 | **不存在**。今天能查的是「项目与工单的当前状态」（`control.sqlite`）与「控制台事件日志」（`console.sqlite`，被裁剪） | — | 控制台事件日志**不是**持久事件历史；审计**不是**事件流水 | 在「记忆」页如实区分，并在契约里给出 `event_history_index` 的最小字段 | `P5-2` |
| **Long-term Memory** 长期记忆 | **已随 `P5-3` 建立**：`memory_candidates`、`long_term_memories`、`memory_conflicts` 在 `control.sqlite` 里；`memory_tombstones` 仍**没有建**（D1 未决，见 §8.2），`memory_maintenance_runs` 留给 `P5-4` | 候选队列、生效中的长期记忆、版本更替链与冲突记录 | 不是对话档案；`project_memory` 不是长期记忆；`audit` 不是长期记忆 | `P5-3` 已交付：入队、去重、作用域门禁、状态流转、版本更替、人工决定 | `P5-4`（记忆管理员与维护巡检）、`P5-5`（检索与召回） |

**禁止条款**（可写成测试）：

- 不得通过重命名 `project_memory`、`audit`、`event_log`、`ticket` 或 `project` 来冒充长期记忆或持久事件历史。
- 不得把 `project.value.goal`、`project.value.latestReport.summary`、`ticket.value.assignments[].report.summary` 整段复制进记忆表充当「记忆」；它们是**来源**，记忆必须带来源引用。
- 不得让实时状态查询写入任何长期存储或触发任何模型调用。

**项目备忘今天的实际去处**：`pmContext()`（`src/control/control-plane.ts:5150`）把该项目的备忘作为**确定性的置顶说明**放进 PM 的只读项目上下文；PM 通过 `control_project` 工具读到它（该工具向 `/v1/tools/pm/context` 取数，`src/node/dsh-port-host.ts:1406`）。Router 与 Worker 今天读不到它。这正是它与长期记忆的分界：它是**人写死、按项目直接给的**，没有作用域判定、没有可信度、没有来源引用，也不参与任何检索排序。

---

## 2. 作用域模型与逻辑键

### 2.1 四级作用域

与规范 §3.1 一致，并补上**绑定键**与**越权时的后果**：

| `scope_type` | `scope_id` 格式 | 存什么 | 谁可以读 | 越界时的强制结果 |
| --- | --- | --- | --- | --- |
| `user_global` | `global` | 跨项目通用偏好、交互习惯、通用编码与安全准则 | Router；任意活跃 PM；任意活跃 Worker（只读） | 候选提出者无权直接写入该作用域：强制 `pending_human_confirm` |
| `node_env` | `node:<nodeId>` | 指定机器的盘符路径、已安装工具链版本、本机硬件与后端限制 | Router；绑定在该 `nodeId` 上执行的 PM 与 Worker | 读其他 `node:` 的记忆即越权，存储层直接过滤掉，不进模型上下文 |
| `project` | `project:<projectId>` | 该项目的架构约定、模块边界、测试命令、业务术语 | Router；该项目绑定的 PM；该项目下属工单的 Worker | 读别的项目的记忆即越权，存储层过滤 |
| `ticket`（**不入长期库**） | `ticket:<ticketId>` | 单张工单的临时报错堆栈、一次性草稿过程 | 仅按 `ticketId` 精确查询的授权调用方 | **不得**出现在 `long_term_memories` 的任何一行里 |

`ticket:<id>` 只以两种形态存在：① 持久事件历史 `event_history_index` 里的 `scope_key`；② 候选的 `source_refs` 里的一条引用。两者都不是长期记忆。

### 2.2 `node_id` / `backend_id` 预留

Phase 5 的**每一张**新表都必须带：

```
node_id    TEXT NOT NULL DEFAULT '',
backend_id TEXT NOT NULL DEFAULT ''
```

这与 `coordination_deliveries`、`external_event_subscriptions`、`session_stream_subscriptions` 的既有做法一致（`src/control/delivery-outbox.ts:428` 等）。规则：

- 默认：单节点运行时填当前配置的 `nodeId`（`SUPERAGENT_NODE_ID`，默认 `local`）与后端 `dsh`。
- **例外一**：`scope_type = 'user_global'` 的行，`node_id` 与 `backend_id` **必须为空串**：全局事实不带机器身份，否则多机合流时一台机器的全局记忆会污染另一台。
- **例外二**：`scope_type = 'node_env'` 的行，`node_id` **必须**等于 `scope_id` 里 `node:` 后的那个 id（不是「当前节点」，而是这条事实描述的那台机器）。
- 未来 `feat/multi-node` 合流时，只需要替换节点注册表，不改表结构。

### 2.3 逻辑键

| 对象 | 逻辑键 | 规则 |
| --- | --- | --- |
| 长期记忆 | `memory_id TEXT PRIMARY KEY`，形如 `mem_<单调不重复的串>` | **代理 id，与内容解耦**。内容会被编辑、版本会更替、被遗忘；id 必须单调、永不复用，这样「按 ID 读取」才有稳定语义 |
| 候选 | `candidate_id TEXT PRIMARY KEY`，形如 `cand_<单调不重复的串>` | 同上 |
| 记忆的内容指纹 | `content_fingerprint TEXT NOT NULL` | `sha256(NFKC(规范化正文) ‖ scope_type ‖ scope_id)`，取前 32 位十六进制。规范化 = NFKC → 折叠连续空白 → 去首尾空白 → 小写 |
| 候选的幂等键 | `candidate_idempotency_key TEXT NOT NULL` | `sha256(source_ref 的稳定键 ‖ content_fingerprint ‖ 建议作用域)`，取前 32 位 |
| 事件的幂等键 | `event_idempotency_key TEXT NOT NULL` | `sha256(kind ‖ scope_key ‖ 源记录的稳定 id ‖ 源记录的序号)`，取前 32 位 |

**唯一约束**（部分索引，只约束活跃状态）：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS long_term_memories_live_fingerprint
  ON long_term_memories(scope_type, scope_id, content_fingerprint)
  WHERE status = 'active';
```

有了它，「纯重复」的判定不再依赖模型：重复就是撞上这个索引。

### 2.4 权限矩阵

**这张表混合了两件事，必须分开读**：前三列（Router / PM / Worker）与「操作员」是**今天真实存在**的权限；最后一列 `memory_manager.v1` 是 **P5-4 才会存在的受限系统角色**，本轮不实现、今天也没有任何会话以它的名义运行。今天**不存在**的长期记忆表族同样让其中大部分「读」与「提候选」暂时没有对象——表里的 ✅ 表示**该角色被允许做这件事**，不是**今天做了就有用**。

今天真实存在的角色（`src/control/roles.ts` 的 `ROLE_PROFILES`）：`router.v1`、`pm.v1`、`worker.v1`、`scout.v1`。

| 能力 | Router | PM | Worker | 操作员（控制台） | `memory_manager.v1`（P5-4 新增） |
| --- | --- | --- | --- | --- | --- |
| 读 `user_global` 长期记忆 | ✅ | ✅ | ✅（只读） | ✅ | ✅（仅审核需要时） |
| 读 `node_env` 长期记忆 | ✅ | ✅ 仅限自己绑定的 node | ✅ 仅限自己绑定的 node | ✅ | ❌ |
| 读 `project` 长期记忆 | ✅ | ✅ 仅限自己的项目 | ✅ 仅限自己项目的工单 | ✅ | ❌ |
| 读 `ticket` 事件历史 | ✅ 仅限自己的工单/项目 | ✅ 仅限自己项目的工单 | ✅ 仅限自己当前的工单 | ✅ | ❌ |
| 提候选 | ✅ | ✅ | ✅ 仅限当前工单 | ✅（`operator_explicit`） | ❌ |
| 提议 `user_global` | ✅ | ✅ **被强制降级为待确认** | ❌ | ✅（`operator_explicit`，等待审核） | ❌ |
| 审核候选、落库、合并、版本更替、挂起冲突 | ❌ | ❌ | ❌ | ✅（人工确认） | ✅ 仅 `memory_service.*` 工具 |
| 编辑、置顶、遗忘一条长期记忆 | ❌ | ❌ | ❌ | ✅ | ❌ |
| 运行每日维护巡检 | ❌ | ❌ | ❌ | ✅（手动触发） | ❌（只执行被调度的核查） |
| 扩充角色工具集、跨角色发消息、读写文件、执行命令 | ❌ | ❌ | ❌ | — | **严禁** |

**没有任何一条路径可以绕过审核把一条记忆直接置为已生效**：

- **PM 提议 `user_global`** 被强制降级为 `pending_human_confirm`，永远不能自动生效。
- **操作员的显式全局**同样要过审核。它在等待期间可以被标为 `provisional_same_session`（见 §5.5）：这条标记只表示「这条是操作员刚刚亲口说的，可以先在本会话里用着」，**不是**「已经生效」。审核通过后它才成为正式的长期记忆；被拒就只是被拒。**ACL 里没有直接生效的旁路**——把 `status` 直接写成 `active` 的写入路径不存在，写入路径对 `status` 的流转只有 §5.1 那一条。
- **`memory_manager.v1`** 的审核结论也只覆盖 `memory_service.*` 的工具，它同样不能绕过作用域门禁（§4.3 的存储层硬过滤对审核者也一样生效）。

`memory_manager.v1` 的最小权限是硬边界：它只拥有 `memory_service.*` 的审核与查询工具，**不**拥有文件读写、命令执行、工单创建/修改、跨角色发消息。

**命名必须与既有约定对齐**（否则角色档案查不到，工具调用会被一律拒绝）：

- **角色档案名**用 `ROLE_PROFILES` 的稳定名：`router.v1`、`pm.v1`、`worker.v1`、`scout.v1`；`P5-4` 新增的写 `memory_manager.v1`（同样的 `<角色>.v<版本>` 形状）。会话记录里存的就是这个名字，权限守卫按名字查档案，**查不到就全拒**。
- **审计的 actor 词表**是 `AuditActor`（`src/control/console-audit.ts:12`）：`operator` / `pm` / `worker` / `router` / `system`。`memory_manager.v1` 的动作记为 `system`，候选的 `proposed_by_role` 记实际提出者。
- **审计的 kind 词表**是 `AuditKind`：`project` / `ticket` / `assignment` / `report` / `review` / `node` / `session` / `schedule` / `denial`。记忆相关的动作需要**新 kind**（例如 `memory`），并在 `P5-4` 一并扩这个词表——扩的是词表，不是既有语义。
- **审计 detail 的既有处理**：`redactCredentials(detail).slice(0, 300)`，凭据被抹、路径保留。记忆相关的审计行沿用同一处理。

---

## 3. 来源可信度、引用、脱敏与事务边界

### 3.1 来源可信度分级

与规范 §3.2 一致，三级：

| `source_trust` | 含义 | 谁能产生 | 自动落 `user_global` |
| --- | --- | --- | --- |
| `operator_explicit` | 人在主窗口或控制台直接声明的规则与偏好 | 操作员；Router 转述的人的原话（须逐字复核） | ✅ |
| `verified_execution` | 经控制面确认完成、或经 PM 验收通过的工单结论 | PM、Router（只能引用带 `ticketId` / `assignmentId` / `reviewId` 的事实） | ✅（但须同时满足 §3.2 的核验） |
| `external_tainted` | 含外部观察事件载荷，或未经人工核实的第三方文本 | 外部事件订阅命中的内容；未经核实的 Worker 报告 | **❌ 一律禁止** |

`external_tainted` 的候选在注入模型上下文时**必须**保留不可信来源警示标签。

### 3.2 可核验的来源引用

每条候选与每条长期记忆都必须带 `source_refs`，是一个 JSON 数组，每项：

```ts
interface SourceRef {
  readonly kind: 'ticket' | 'assignment' | 'review' | 'delivery' | 'audit' | 'console_note' | 'operator_message' | 'external_event'
  readonly id: string          // 该类记录在控制面自己的库里的稳定 id 或序号
  readonly at: string          // ISO 8601
  readonly summary: string     // ≤ 200 字符，已脱敏
}
```

**核验规则**（可测试）：

- `kind = 'ticket' | 'assignment' | 'review'`：`id` 必须能在 `control.sqlite` 的 `ticket.value` 里查到；查不到 → 降级为 `external_tainted`。
- `kind = 'delivery'`：`id` 必须能在 `coordination_deliveries.delivery_id` 里查到。注意**这一行的 `payload` 里装着报告正文**（Worker 的摘要与提问，被围栏包着，`src/control/delivery-outbox.ts:571`），所以引用它时只能取**一段已脱敏的摘要**，**不得**把 `payload` 搬进记忆正文（I21）。**`external_wakeup` 这一类投递永远是 `external_tainted`**：它是外部观察，不是控制面确认过的结论，那圈不可信信封只让它读起来安全，不让它变得可信——靠它撑起来的事实不得因此升格，也不得进入全局作用域。
- `kind = 'audit'`：`id` 必须能在 `console.sqlite` 的 `audit.seq` 里查到。
- `kind = 'external_event'`：**永远**是 `external_tainted`，且 `id` 只能指向 `external_event_dispositions.disposition_id`（**事件载荷本身不落库**，所以引用只能是处置记录，不是载荷）。
- `kind = 'console_note'`：指向 `project_memory.id`；来源**只**在 `project` 作用域内有效。
- 没有任何一类允许指向「节点上的某段对话」或「工作区里的某个文件」。

**外部事件的原始载荷与有界不可信信封，是两件必须分开的东西。**

控制面确实**不**把外部事件的原始载荷写进任何库（§1.2：`external_event_subscriptions` / `external_event_dispositions` 都不存载荷）。但是当一个外部事件真的唤醒了一个会话，唤醒用的那段文字**会**落在协调 outbox 里——落在 `coordination_deliveries.payload` 这一列。

那不是原始载荷，是**有界不可信信封**（`src/control/event-subscriptions.ts:1950` 的 `envelope()`）：

| | 原始载荷 | 有界不可信信封 |
| --- | --- | --- |
| 内容 | 外部观察源给的那份数据，逐字段 | 一个 `<untrusted_external_event>` 围栏包住的头（`source` / `event_id` / `subscription_id` / `delivery_mode`）+ 声明 + 逐行转义并 `redact()` 过的字段值 |
| 边界 | 观察源自己决定多大 | **有界**：整段 ≤ `EXTERNAL_ENVELOPE_LIMIT`（4096 字节，`src/control/event-subscriptions.ts:237`）；放不下时截断，最后一行被切到边界内 |
| 围栏 | 无 | 必须**恰好**一个开标签与一个闭标签，否则整段不发（`fenceHolds()`） |
| 落库 | **不落库** | 落在 `coordination_deliveries.payload`（`external_wakeup` 这一类） |
| 可信度 | `external_tainted` | **仍是** `external_tainted`：围栏与转义不改变来源的可信度，只改变它被读时的安全边界 |

对本契约的三条后果：

1. **引用只能指向处置记录**（`external_event_dispositions.disposition_id`），不是信封，也不是原始载荷。信封是那一次投递的**产物**，不是事件的**来源**。
2. **信封正文不得搬进记忆正文**（I21 同样管它）。信封里已经是转义过的不可信文本；再抄一遍进记忆，只会把不可信文本第二次变成「系统的说法」。
3. **信封的边界不能被当成记忆的边界**。信封 ≤ 4096 字节是**投递通道**的限制，不是候选正文或记忆正文的长度许可；候选正文另有自己的上限与脱敏规则（§3.3）。

**参考的实现**：`src/control/report-call.ts` 的报告调用账本只存 `payloadHash`，不存报告正文——那是既有代码里「引用而不搬运」的现成做法，照它做。

### 3.3 脱敏

- 写入长期记忆与候选的**正文**，一律先过 `src/infra/redact.ts` 的 `redact()`：它会抹掉凭据名与值、已知令牌格式、URL userinfo、query 值、`file:` URL、Windows 盘符路径与 POSIX 绝对路径。
- `redactCredentials()`（只抹凭据、保留路径）**不适用**于记忆正文：路径对操作员有用，但对跨项目、跨机器复用的记忆是泄漏面。审计与对话日志继续用 `redactCredentials()`，保持既有行为不变。
- **顺带厘清一个同名物**：`src/core/memory.ts` **不是**记忆存储。它是 `Repositories` 端口的**内存实现**（`MemoryRepositories`，六个 `Map` + `structuredClone` + `atomic()` 快照回滚），**只被测试用**（`tests/core-engine.spec.ts` 等）；生产实现是 SQLite 的 `Store`（`src/app/store.ts`）。文件名里的 "memory" 指的是**内存**，不是记忆系统。
- 记忆正文里**不得**出现：连接密钥、模型 API key、人的原话全文（只允许结论与必要引用）、请求体、原始 diff、绝对路径。发现即在写入前拒绝该候选并记 `redaction_rejected`。
- `source_refs.summary` 同样过 `redact()`，且长度 ≤ 200。

### 3.4 事务边界

| 动作 | 事务范围 | 说明 |
| --- | --- | --- |
| 候选入队 | 一个事务：幂等键查重 → 写 `memory_candidates` → 写内容指纹 → 同步 FTS5 | 查重与写入必须原子，否则并发会写出两条同指纹候选 |
| 审核落库 | 一个事务：候选状态流转 → 写/改 `long_term_memories` → 追加 `source_refs` → 刷新 `last_verified_at` → 更新指纹表 → 同步 FTS5 | 版本更替时，旧行 `status='superseded'` 与新行 `status='active'` 必须同事务，否则会出现两条活跃的同指纹记忆 |
| 纯重复归并 | 一个事务：追加 `source_refs` → 刷新 `last_verified_at` → 置信度小幅上调 | 不改记忆正文，不新建行 |
| 冲突挂起 | 一个事务：候选转 `conflict_pending` → 写 `memory_conflicts` | 冲突期间两端都**不**进入常规召回 |
| 每日维护巡检 | 一个事务：写 `memory_maintenance_runs` 一行 + 巡检产生的状态变更 | 巡检结果与它造成的变化同生共死；节点离线时如实记 `skipped_offline`，**不得**标 `succeeded` |
| FTS5 同步 | 与主表同事务 | FTS5 是同库虚表，可以同事务写；索引与主表不一致是**不可接受**的状态 |

**零 LLM 约束**：`Memory Service`（`src/memory/memory-service.ts`，`P5-3`）**不 import 任何模型 SDK**，不发起任何网络请求。审核由 `memory_manager.v1` 通过工具调用 `Memory Service` 完成；`Memory Service` 只做纯程序化操作。这条可以用「`src/memory/**` 的 import 图里没有模型 SDK」写成静态测试。

---

## 4. 存储与检索的最小契约

### 4.1 表与字段

字段名沿用既有风格（下划线列名，SQLite `TEXT`/`INTEGER`）。表名沿用规范 §1.2 的清单。

**下面这些表一张都还没有建**。以下是**契约**：字段名、类型、约束与索引在 `P5-2` 至 `P5-4` 落库时必须照此实现，以免同一份数据在两个版本里有两套形状。本轮只写下它们，不建它们。

#### `event_history_index`（`P5-2`）

```sql
CREATE TABLE IF NOT EXISTS event_history_index (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL,          -- trigger / dispatch / handoff / report / review / manual_stop / denial / schedule / error
  at TEXT NOT NULL,
  scope_key TEXT NOT NULL,           -- ticket:<id> | project:<id> | control_session:<id> | assignment:<id> | node:<id>
  ticket_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  control_session_id TEXT NOT NULL DEFAULT '',
  assignment_id TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL DEFAULT '',
  backend_id TEXT NOT NULL DEFAULT '',
  source_table TEXT NOT NULL,        -- 事实的出处：ticket / project / coordination_deliveries / audit / ...
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,             -- 已脱敏，≤ 500 字符
  detail TEXT NOT NULL DEFAULT '',   -- 已脱敏 JSON
  created_at TEXT NOT NULL
);
```

- **不建全局全对话向量索引**（规范 §5.1、P5-2 验收要点）。
- **不受 `console.sqlite` 的 7 天 / 20000 行裁剪影响**：它要么放在 `control.sqlite` 里，要么独立成库（默认与备选见 §8.4 的 ADR-4）；**不得**寄生在 `event_log` 上。
- 唯一约束：`event_id`（幂等键）。

**这张表索引的是「有界的关键事实」，不是一份对话档案的迁移。**

这两件事必须分开：

| | 有界关键事实（本表做的事） | 完整对话档案（**不做**的事） |
| --- | --- | --- |
| 一行是什么 | **一条事实**：发生了什么（`event_kind`）、它属于谁（`scope_key` 与各 id）、发生在什么时候（`at`）、出处是谁（`source_table` / `source_id`）、一句已脱敏的摘要（`summary` ≤ 500 字符）与已脱敏的结构化补充（`detail`） | 一整段会话：人说了什么、模型回了什么、上下文有多少 |
| 正文从哪来 | 从**已经是事实**的记录里**提炼**（`ticket.value` 的报告与验收、`coordination_deliveries` 的处置、`audit` 的动作） | 从 `event_log.payload` 里**搬运**对话原文 |
| 原文 | **不搬运**：I21 规定正文里不出现对话原文 | —— |
| 检索 | 按 `ticketId` / `projectId` / `scope_key` **精确查**（I14） | 全库语义检索 |

理由有三条，都来自 §1.2 的源码事实：

1. **对话本来就不持久**：控制面把会话对话整条序列化进 `event_log.payload`（`kind='message'` 的行带人与模型的原话），并跟着 20 000 行 / 7 天一起被裁掉。**「把对话搬进另一张表」不是修复，而是把同一个问题复制一份**——搬过去的对话同样有原文，同样要脱敏，同样会变成一个无界的库。
2. **对话原文不可核验**：§1.3 已经说明，控制面今天读不到节点上的会话日志。任何声称「某段对话里说过什么」的引用都无法验证（I21、§3.2）。
3. **索引与原文是两种不同的东西**：索引的价值在于「按工单/项目精确查一件事」，而 §1.2 明确指出的读法缺口（`sessionMessages()` 取最早 200 条且不报断口）是**读法**的问题，要用 I19 的「读法必须报断口」来修，不是用一张新表把对话整体搬一遍。

**因此 `P5-2` 的产出是「一张按作用域精确查询的事实索引」，不是「一份被搬进新库的对话历史」。** 若某条事实的摘要确实需要引用一段对话，那段对话只能以 §3.2 的 `source_refs` 摘要形式出现（≤ 200 字符、已脱敏），并保留原记录的位置，而不是把原文写进 `summary` 或 `detail`。

#### `memory_candidates`（`P5-3`）

```sql
CREATE TABLE IF NOT EXISTS memory_candidates (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  scope_type TEXT NOT NULL,          -- user_global | node_env | project
  scope_id TEXT NOT NULL,
  proposed_scope_type TEXT NOT NULL,
  proposed_scope_id TEXT NOT NULL,
  content TEXT NOT NULL,             -- 已脱敏
  content_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,              -- queued | reviewing | active | duplicate | superseded | conflict_pending | pending_human_confirm | expired_candidate | needs_reverify | rejected
  source_trust TEXT NOT NULL,
  source_refs TEXT NOT NULL,         -- JSON 数组，见 §3.2
  proposed_by_session_id TEXT NOT NULL DEFAULT '',
  proposed_by_role TEXT NOT NULL DEFAULT '',
  revision_count INTEGER NOT NULL DEFAULT 0,
  returned_to_session_id TEXT NOT NULL DEFAULT '',
  conflict_with_id TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0,
  node_id TEXT NOT NULL DEFAULT '',
  backend_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT ''
);
```

#### `long_term_memories`（`P5-3`）

```sql
CREATE TABLE IF NOT EXISTS long_term_memories (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL,          -- user_global | node_env | project（**永不出现 ticket**）
  scope_id TEXT NOT NULL,
  content TEXT NOT NULL,             -- 已脱敏
  content_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,              -- active | superseded | forgotten | needs_reverify | conflict_pending
  source_trust TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  supersedes_id TEXT NOT NULL DEFAULT '',
  superseded_by_id TEXT NOT NULL DEFAULT '',
  conflict_with_id TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0,   -- I ∈ [0,1]
  confidence REAL NOT NULL DEFAULT 0,   -- C ∈ [0,1]
  utility REAL NOT NULL DEFAULT 0,      -- U ∈ [0,1]
  exposure_count INTEGER NOT NULL DEFAULT 0,
  effective_use_count INTEGER NOT NULL DEFAULT 0,
  disputed_count INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  deprecated_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT '',
  backend_id TEXT NOT NULL DEFAULT ''
);
```

**`ticket` 作用域永不出现**：这张表上有一条可写成测试的约束 —— 写入路径对 `scope_type = 'ticket'` 直接拒绝。

#### `memory_tombstones`（`P5-3`，**受 D1 决策约束**）

```sql
CREATE TABLE IF NOT EXISTS memory_tombstones (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,          -- 规范化内容指纹
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  memory_id TEXT NOT NULL DEFAULT '', -- 被遗忘的那条的 id，仅供审计，不参与匹配
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_tombstones_fingerprint
  ON memory_tombstones(scope_type, scope_id, fingerprint);
```

> 这张表**是否建立、是否使用，取决于 D1 的裁决**。见 §8.2、§8.3。本轮不建立。

#### `memory_maintenance_runs`（`P5-4`）

```sql
CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  state TEXT NOT NULL,                -- succeeded | failed | skipped_offline | skipped_no_node
  node_id TEXT NOT NULL DEFAULT '',
  checked INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  expired INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT ''
);
```

#### `memory_conflicts`（`P5-3`）

```sql
CREATE TABLE IF NOT EXISTS memory_conflicts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  conflict_id TEXT NOT NULL UNIQUE,
  memory_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL DEFAULT '',
  other_memory_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,                -- open | resolved_merge | resolved_supersede | resolved_human | expired
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT ''
);
```

### 4.2 最小索引

不追求覆盖索引，只保证四条查询路径：

```sql
-- 作用域硬过滤（检索的第 0 步）
CREATE INDEX IF NOT EXISTS long_term_memories_scope_active
  ON long_term_memories(scope_type, scope_id, status);
-- 关键词检索
CREATE VIRTUAL TABLE IF NOT EXISTS long_term_memories_fts
  USING fts5(content, content='long_term_memories', content_rowid='seq', tokenize='unicode61');
-- 候选队列
CREATE INDEX IF NOT EXISTS memory_candidates_status
  ON memory_candidates(status, created_at);
-- 事件历史按工单/项目精确查
CREATE INDEX IF NOT EXISTS event_history_index_scope
  ON event_history_index(scope_key, at);
CREATE INDEX IF NOT EXISTS event_history_index_ticket
  ON event_history_index(ticket_id, at);
```

### 4.3 查询契约

**唯一入口**：

```ts
search(input: {
  readonly caller: { role: string; sessionId: string; nodeId: string; projectId?: string; ticketId?: string }
  readonly query: string
  readonly limit: number          // 默认 ≤ 5
}): { hits: MemoryHit[]; degraded: boolean; asOf: string }
```

`S_allowed`（调用方可以读的 `(scope_type, scope_id)` 集合）由 `Memory Service` **按调用方身份自行推导**，不接受请求方自报：Router 得 `user_global` + 全部 `node_env` + 全部 `project`；PM 与 Worker 只得 `user_global` + 自己 `node_id` 的 `node_env` + 自己的 `project`（Worker 还受限到其工单的项目）。推导逻辑只有一处，且与 §2.4 的权限矩阵一一对应。

执行顺序是**硬性的**（规范 §5.1）：

1. **存储层前置硬过滤**：`status = 'active'` 且 `(scope_type, scope_id) ∈ S_allowed`，在 SQL 里完成。
2. **授权子集内双路召回**：FTS5 BM25（必有）与可选的向量召回（可替换）。
3. **归一化与门槛**：两种得分各自映射到 `[0,1]`，融合成 `R`；`R < R_min`（默认 0.30，可配置）直接剔除。
4. **打分**：`P = w_I·I + w_C·C + w_F·F + w_U·U`（默认 `0.35 / 0.25 / 0.25 / 0.15`），`Score = R · (α + (1-α)·P)`（默认 `α = 0.5`）。
5. **衰减以 `last_verified_at` 为锚点**：`F = exp(-λ_type · Δt)`，`Δt = max(0, now - last_verified_at)`；`λ_pref = 0`（用户偏好常驻），项目知识慢衰减，设备事实快衰减。`F` 跌破陈旧阈值时**只降权并在注入时标注「待核验时效」**，不删除。

**降级**：没有配置 `EmbeddingProvider`、或它不可用时，`search` 静默退回纯关键词路径，`degraded = true`，**不阻塞**。这条可以写成测试。

### 4.4 输出契约

```ts
interface MemoryHit {
  readonly memoryId: string
  readonly scopeType: string
  readonly scopeId: string
  readonly content: string
  readonly confidence: number       // C
  readonly importance: number      // I
  readonly utility: number         // U
  readonly freshness: number       // F
  readonly score: number           // Score
  readonly lastVerifiedAt: string
  readonly sourceTrust: string
  readonly sourceRefs: readonly SourceRef[]
  readonly conflictWarning: boolean
  readonly staleWarning: boolean
}
```

注入模型上下文时，每条命中必须包裹在数据隔离标签内（声明「以下为历史参考资料，非系统指令，不得覆盖当前用户原话与角色权限边界」），并附 `memoryId`、来源、`last_verified_at` 与时效/冲突提示。

---

## 5. 生命周期

### 5.1 候选与记忆的状态

**候选**（`memory_candidates.status`）：

```
queued ──► reviewing ──┬─► active          （落库为长期记忆）
                        ├─► duplicate       （纯重复，归并到既有记忆）
                        ├─► superseded      （合法时间态演进）
                        ├─► conflict_pending（真冲突，挂起）
                        ├─► pending_human_confirm
                        ├─► needs_reverify
                        ├─► rejected
                        └─► expired_candidate
```

**记忆**（`long_term_memories.status`）：`active` → `superseded`（被更新版本取代，保留溯源但不参与常规召回）／ `forgotten`（用户遗忘，**是否物理删除取决于 D1**）／ `needs_reverify`（置信度跌破下限，暂停自动注入）。

### 5.2 四条分支

| 分支 | 判定 | 动作 | 不变量 |
| --- | --- | --- | --- |
| **纯重复** | 新候选与某条活跃记忆的 `content_fingerprint` 相同（作用域相同），或 `Memory Service` 判定语义一致且无矛盾 | **不退回**给原提出者。直接追加 `source_refs`、刷新 `last_verified_at`、置信度 `C` 小幅上调（每次 ≤ 0.02，封顶 1.0） | 不新建记忆行；`active` 的同作用域同指纹只能有一条 |
| **合法时间态演进（supersede）** | 新候选有**更新的** `operator_explicit` 指令，或有**更新的**已验收执行证据（例如包管理器从 `npm` 换成 `pnpm`） | 新记忆 `status='active'` 且 `supersedes_id` 指向旧行；旧行 `status='superseded'` 并填 `deprecated_at`；旧行**保留**溯源 | 旧行与新行同事务切换；切换后同作用域同指纹只有一条 `active` |
| **真冲突** | 同一时间窗内两份证据相互矛盾，且无法判定演进顺序 | 候选 `status='conflict_pending'`，写 `memory_conflicts`；两端都**不**进常规召回；检索命中时附 `conflict_warning` 并乘惩罚系数 | 冲突期间两端都不可被自动注入 |
| **证据不足** | 候选缺少可核验来源，或来源核验失败 | 进 `pending_human_confirm` 队列，在控制台展示；超过配置保留期仍无补充证据 → `expired_candidate`，**不进**可信记忆库 | 未审结的候选不得进入常规可信检索结果 |

### 5.3 被动有界退回（关键不变量）

规范 §4.1.3 明确：退回原提出者（Router 或 PM）时，**严禁**违反 `P3-1` 不变量去自动唤醒或恢复处于 `MANUALLY_STOPPED`、`paused`、`ended` 状态的会话。

本契约把它写成可测的规则：

1. 退回通知**只写入目标的被动待办队列**，不触发 `ensure`、不触发 `message`。
2. 只有当目标会话处于**正常活跃运行态**时才消费这条待办。
3. 单条候选最多退回重评 **1 次**（`revision_count ≤ 1`）；超限仍未解决 → `pending_human_confirm`。
4. 目标会话处于 `MANUALLY_STOPPED` / `paused` / `ended` / 已撤销时，退回请求**留在队列里**，直到该会话被**显式恢复**；系统**不得**替操作员做这个决定。
5. 退回后候选的 `returned_to_session_id` 被记下，控制台能看到「它被退回了、给谁、等了多久」。

### 5.4 过期与冷置

| 对象 | 过期条件 | 结果 |
| --- | --- | --- |
| 候选 | `expires_at` 到期且仍是 `queued` / `pending_human_confirm` | `expired_candidate`，不删除审计痕迹 |
| 记忆 | `F`（新鲜度）跌破陈旧阈值 | **只降权**并在注入时标注「待核验时效」；**不删除**记忆，也**不删除**底层 `Event History` |
| 记忆 | `C < C_floor` | `needs_reverify`，暂停自动注入，等下次维护核查 |
| 事件历史 | 无自动过期 | 提交留存与脱敏方案；**未经批准不自动删除**（规范 P5-2 验收要点） |

### 5.5 `provisional_same_session`：等待审核期间的会话内读穿透

规范 §4.2 要求消除「用户刚说了偏好，下一条指令却读不到」的滞后：主窗口里 `operator_explicit` 的候选在**审核尚未完成**时，允许在**当前 Router 会话内**被读到。

它由一条**标记**实现，而不是一条**生效**路径：

- 候选带 `provisional_same_session` 标记时，**只**参与发起它的那一个会话的后续拼装；别的会话读不到它。
- 它**不是** `long_term_memories` 里的一行。它没有 `memory_id`，不进检索索引，不参与常规召回，也**不能**被 `memory_manager.v1` 之外的任何路径改写。
- 审核通过后，它成为一条正式记忆（`status='active'`，有 `memory_id` 与 `source_refs`）；被拒就只是被拒。标记在任一方向上都不会**变成**一个「已经生效但未记录来源」的东西。
- 标记**只对 `source_trust = 'operator_explicit'` 的 `user_global` 候选开放**。`external_tainted` 的候选**永远**没有这条读穿透（§3.1），PM 的 `user_global` 提议被强制降级为 `pending_human_confirm`，同样没有。
- 读写不对称：**读**可以在本会话穿透，**写**不行。任何会话都不能因为「这条正在等审核」就自己把它写进长期记忆表。

这条不改变 §2.4 的结论：ACL 里**没有**直接生效的旁路。`provisional_same_session` 只是把「等待中」这件事讲清楚，而不是把审核跳过。

---

## 6. 权限与可测试的不变量

### 6.1 权限细则

**操作员（控制台）**：

- 可以：查看长期记忆列表与来源、手动编辑、置顶、遗忘；查看候选队列与 `pending_human_confirm`；手动触发一次维护巡检。
- 不可以：替模型改写来源引用；查看别的节点无权看的机器事实（在多节点形态下按 `node_id` 过滤）；直接改写审计。
- 遗忘操作**必须**是显式的：一次点击 + 一次确认，且界面必须说明它对**指纹抑制**与**物理删除**的不同后果（D1 裁决后确定文案）。

**Router / PM / Worker**：

- 只能**提候选**，不能审核、不能落库、不能遗忘、不能改别人作用域的记忆。
- PM 提议 `user_global` → **强制** `pending_human_confirm`，绝不自动生效。
- `external_tainted` 的候选 → 禁止自动审结进 `user_global`。
- Worker 只能提**当前工单**范围内的候选。

**`memory_manager.v1`（P5-4 新增）**：

- 只有 `memory_service.*` 的审核与查询工具。
- **没有**文件读写、命令执行、工单创建/修改、跨角色发消息。
- 审核是**受限**：它可提交「归并 / 通过 / 版本更替 / 挂起冲突 / 退回」结论，但「通过」在 `scope_type = 'user_global'` 且 `source_trust = 'external_tainted'` 时**必须**失败。
- **等待人工确认的候选只能由人决定**：`status = 'pending_human_confirm'` 的候选，管理器**不得**通过、归并、版本更替或挂起冲突——那几条决定都会让一条事实生效或改动既有记忆。退回不算生效，仍可由管理器提交。
- **不可信的事实不碰全局作用域**：管理器的「归并 / 版本更替 / 挂起冲突」在 `scope_type = 'user_global'` 且 `source_trust = 'external_tainted'` 时**同样必须**失败，不只是「通过」。

### 6.2 可测试的不变量

这些写成测试的断言，每条都指明它应该落在哪个文件里。

| 编号 | 不变量 | 落点 |
| --- | --- | --- |
| I1 | 检索先在存储层按作用域与状态硬过滤，再计算得分；代码里不存在「先 Top-K 召回再过滤」的路径 | `src/memory/retriever.ts` 单测 |
| I2 | `Memory Service` 的 import 图里没有模型 SDK，也没有网络调用 | 静态 import 检查 |
| I3 | `long_term_memories` 里不存在 `scope_type = 'ticket'` 的行；写入路径对 `ticket` 直接拒绝 | 写入单测 |
| I4 | 同一 `(scope_type, scope_id, content_fingerprint)` 至多一条 `active` | 部分唯一索引 + 并发写入测试 |
| I5 | 纯重复的归并不创建新记忆行，只追加 `source_refs` 并刷新 `last_verified_at` | 归并单测 |
| I6 | 版本更替时旧行转 `superseded` 并写 `deprecated_at`，且与新行同事务 | 事务回滚测试 |
| I7 | 退回不唤醒被人工停止 / 暂停 / 结束 / 撤销的会话；`revision_count` 超过 1 转 `pending_human_confirm` | 退回单测（对齐 `P3-1` 不变量） |
| I8 | 曝光（`exposure_count`）**不**增加 `utility`；只有**已验收完成**的 Assignment 才增加 `effective_use_count` 并刷新 `last_verified_at` | 效用归因单测 |
| I9 | `external_tainted` 的候选不能自动审结进 `user_global`；`user_global` 的写入必须带 `operator_explicit` 或可核验的 `verified_execution` | 作用域门禁单测 |
| I10 | 所有写入长期记忆与候选的正文都过 `redact()`；含凭据或绝对路径的候选被拒绝 | 脱敏单测 |
| I11 | 没有配置 `EmbeddingProvider` 时检索退回关键词路径并置 `degraded = true`，不抛错、不阻塞 | 降级单测 |
| I12 | `memory_maintenance_runs` 在节点离线时记 `skipped_offline`，绝不记 `succeeded` | 维护单测 |
| I13 | `event_history_index` 不挂在 `console.sqlite` 的 `event_log` 上，也不受其 20000 行 / 7 天裁剪影响 | 存储位置测试 + 裁剪测试 |
| I14 | 事件历史查询按 `ticketId` / `projectId` 精确隔离；跨项目查询返回空 | 隔离单测 |
| I15 | 记忆 id 单调、永不复用；按 id 读取**不泄露**这个 id 是否曾经存在：未知 id 与已被遗忘的 id 给出**同一种**未找到答复（这一点与 D1 的裁决无关，两条路径都必须满足） | id 单调性测试 |
| I16 | 实时状态查询不写任何长期存储、不触发任何模型调用 | 写入计数测试 |
| I17 | 断线时实时状态如实返回 `offline` / `unknown`，绝不返回上一轮的在线值 | 断线注入测试 |
| I18 | FTS5 索引与 `long_term_memories` 在同一事务内更新；两者行数一致 | 一致性测试 |
| I19 | 任何拿事件日志当历史读的路径，**都必须像 `/v1/events` 那样把断口说出来**：被裁掉的部分不得静默省略（现状：`sessionMessages()` 取最早 200 条且不报断口，见 §1.2，这是本契约要求修掉的读法） | 读法测试 |
| I20 | 事件历史自己的 `at` 取**控制面**的钟，不沿用节点的时间戳（节点时钟可能偏，且 `event_log` 的天数比较是字符串比较） | 时间戳来源测试 |
| I21 | 长期记忆与事件历史的正文里**不出现**对话原文：`coordination_deliveries.payload`（报告正文）、`event_log.payload`（对话）、`router_queue.text` 等列只能被**引用**（id + 已脱敏摘要），不能被**搬运** | 内容来源测试 |

---

## 7. 控制台契约

本轮已经把「记忆」页接进控制台（`#/memory`，侧栏标签「记忆」，`src/console/memory.tsx`）。它是**只读**的：读控制面已有的 API，用控制台已有的连接密钥，不新增任何 HTTP 端点、不新增任何写入、不新增任何轮询（实时事实由外壳读好后传下来）。

页面由三部分组成：一个页头（读取时间 + 事件流状态 + 刷新）、三个可切换的同级面板（实时状态 / 事件历史 / 长期记忆），以及每个面板自己的标题与 `aria-labelledby`（页面的 `<h1>` 由外壳给出，面板不再重复它）。

三个面板各自如实说明自己是什么：

| 面板 | 数据来源（现有端点） | 现在是什么 | 权限 | 操作员能做的动作 | 扩展步骤 |
| --- | --- | --- | --- | --- | --- |
| **实时状态** | `GET /v1/console/memory/live-state`（`P5-1` 起；`PageProps.stream` 仍由外壳给出） | 控制面在 `liveState.at` 那一刻读到的**实时快照**：节点的真实 `online / offline / unknown` 状态、项目、工单、Assignment、会话与定时计划，各自带自己的状态。节点未登记时是**未知**，不是离线；一个从未连上的后端是**未知**，不是可用。读取时间在页头说一次，**取样时间**在面板里另说一次 | 任何已连接的操作员（控制台连接密钥，或只读密钥的 `GET`） | 刷新、跳到项目 / 会话 / 节点部署 | 已上线（`P5-1`） |
| **事件历史** | `GET /v1/console/projects`、`GET /v1/console/memory/event-history`、`GET /v1/events?after=…`、`overview.retention` | 三类**已经存在**的记录，用两种底色分开：**项目档案与工单**（业务库的当前状态，随控制面重启保留）、**持久事件历史**（`event_history_index` 的精确查询面板，`P5-2` 起，见 §7.2）与**控制台短期日志**（会按保留规则被裁掉的短期日志，最多显示最近 12 条）。日志那块明写保留上限与当前保留行数，**不猜**已被裁掉多少行；断口只在服务端说 `gap` 时才说 | 同上 | 打开某个项目（跳到「项目」并选中它）；按项目与工单过滤持久事件历史、加载更多 | **已上线（`P5-2`）** |
| **长期记忆** | `GET /v1/console/memory/candidates`、`GET /v1/console/memory/memories`、`POST /v1/console/memory/candidates`、`POST /v1/console/memory/candidates/:id/decision`（`P5-3` 起，见 §7.3） | **已上线**：控制面自己的记忆服务。**候选队列**（每条候选带着作用域、来源可信度、状态与来源引用，等待一次人工决定）与**已保存的长期记忆**（生效中的那些，带着 id、最后核验时间与来源引用），外加一个「提出一条候选」的表单。候选先入队、再由人决定；界面上没有直接写入记忆的动作，也没有遗忘入口（做法待决） | 读取：任何已连接的操作员或只读密钥；写入：只有操作员 | 提出候选；对待决的候选「通过」或「退回」 | **已上线（`P5-3`）**；编辑、置顶、遗忘与维护巡检留给后面 |

**读什么时候开始**：`实时状态` **在该面板被打开时**读一次，之后每有一条事件或一次刷新再读一次，用面板自己的当前 `revision` 与既有 `useLoaded` 钩子；`事件历史` 的两个列表同样**只在该面板被打开时才读**；`长期记忆` 的候选队列与已保存列表也在该面板被打开时才读。**加载中、读失败与读到了空列表是三件不同的事**，页面上分开说：没回答就是「正在读取……」，失败就是失败的原因，读到了零行才是「还没有」。**读失败时不得把旧值当成实时值**：失败会被明说，屏幕下方的旧数据会被标成「上一次读到的」。

**已上线域与未来域的映射**（供后续按表扩展）：

| 域 | 页面 | 数据源 | 状态 | 权限 | 成员动作 | 扩展步骤 |
| --- | --- | --- | --- | --- | --- | --- |
| 实时状态 | `#/memory` › 实时状态 | `/v1/console/memory/live-state`、`NodeResolver` | 已上线（只读） | 操作员 | 刷新、跳转 | 已上线（`P5-1`） |
| 项目档案 | `#/projects` | `control.sqlite` 的 `project` 表 | 已上线 | 操作员 | 现有的项目生命周期动作 | 不变 |
| 项目备忘 | `#/projects` › 项目备忘 | `console.sqlite` 的 `project_memory`；PM 侧由 `pmContext()` 带进 `control_project` 的上下文 | 已上线 | 操作员写、PM 读 | 记一笔 | 不变；**不得**并入长期记忆 |
| 会话对话 | `#/sessions`、首页 Router 线程 | `console.sqlite` 的 `event_log`（`kind='message'`） | 已上线，但**读法有已知缺口**：`sessionMessages()` 取**最早** 200 条且不报断口 | 操作员 | 现有的消息与干预动作 | `P5-2`：改从 `event_history_index` 读，并按 I19 报断口 |
| 持久事件历史 | `#/memory` › 事件历史 | `event_history_index`（`control.sqlite`） | 已上线（只读） | 操作员 + 受限查询工具 | 按工单/项目精确查、加载更多 | 已上线（`P5-2`，接口见 §7.2） |
| 长期记忆 | `#/memory` › 长期记忆 | `long_term_memories`（`control.sqlite`） | 已上线（只读 + 人工决定） | 操作员（治理）+ `memory_manager.v1`（审核，`P5-4`） | 查看来源；通过或退回候选 | 已上线（`P5-3`，接口见 §7.3）；编辑、置顶、遗忘留给后面（遗忘待 D1 裁决） |
| 候选与审核 | `#/memory` › 长期记忆 | `memory_candidates` / `memory_conflicts` | 候选队列与人工决定已上线；记忆管理员与冲突分支留给 `P5-4` | 操作员 + `memory_manager.v1` | 确认、退回（已上线）；标记冲突、版本更替（服务里已有，`P5-4` 的界面未接） | `P5-4` |
| 维护巡检 | `#/memory` › 长期记忆 | `memory_maintenance_runs`（待建） | 未建 | 操作员 | 查看、手动触发一次 | `P5-4` |

### 7.1 `P5-1` 已上线的实时状态接口

`P5-1` 把实时状态做成了 `src/memory/live-state.ts` 里的一个**只读投影**，控制面只做薄委托（把参数交给它、把它的答案原样送出去）。

**两个读端点，都是 `GET`**：

| 端点 | 谁用它 | 授权 | 范围 |
| --- | --- | --- | --- |
| `GET /v1/console/memory/live-state` | 控制台 | 控制台连接密钥，或只读密钥（只读密钥只能 `GET`） | 本控制面的全部：节点、项目、工单、Assignment、会话、计划 |
| `GET /v1/tools/memory/live-state` | Router / PM / Worker | 该 Session 自己的工具令牌（`verifyToolToken`） | 由**该 Session 的记录**决定：Router 读它管理的池；PM 读它自己的项目与它绑定的那台节点；Worker 读它当前的 Assignment、那张工单与该工单所属项目的元数据 |

**范围从不被请求决定**：调用者是谁，由它证明的令牌决定（`verifyToolToken` → 会话记录 → 角色档案 → PM 的委托）。无效、过期、被撤权、被人工停止、已被刷新顶掉的令牌，以及角色不对的调用，一律按同一套规则拒绝。**读不需要节点在线**：事实是控制面自己的记录，节点离线不构成拒绝的理由。

**读的人必须是那段工作的主人**，这是范围之外的第二道闸：

- **Worker**：Assignment 属于解析器点名的那一个 Session——权威的 `worker-<assignmentId>`。别的 Session 记录哪怕**声称**同一个 Assignment，也只是一条记录，不是那个 Worker，它读不到这段工作的状态（`src/control/control-plane.ts` 的 `liveStateFor` 比对 `resolved.handle.sessionId` 与令牌证明的那条记录）。解析器给出的目标还必须绑在本控制面自己的节点与后端上。
- **PM**：项目按**真实的委托**解析——`pmSessionId` 指向谁，谁才是这个项目的 PM（`src/memory/live-state.ts` 的 `pmScope`）。记录里写着别的项目、或者属于别的节点的 Session，读的是别处的工作，一律拒绝；PM 的范围里也只留下本控制面自己节点的 Worker 记录。**空的旧绑定照旧保留**（绑定存在之前的记录不受牵连）。
- 这道闸只挡**能指向另一个受管对象**的不一致；它不会因为节点离线而拒绝一次本来合规的本地读取。

**答应的形状**是一个显式受限的快照：`at`（控制面自己的钟）、`audience`，以及六份有界清单（节点、项目、工单、Assignment、会话、计划）。每份清单带 `rows` / `total` / `omitted`，被截断时不会让人误以为看到了全部。字段只有**稳定的公开标识、状态与人写的标签**：工作区路径、令牌、模型凭据、报告正文、计划正文与控制台登录信息都不在其中。

**Assignment 清单只列每张工单当前的那一次尝试**：实时状态说的是「现在在跑什么」，之前的尝试属于**历史**，归 `P5-2` 的事件历史管。工单行上的 `epoch` 仍然数着它这是第几次尝试。

**节点的真实状态**：解析器说 `reconnecting` 就是 `unknown`（不是离线），后端的可用性在节点未知时是 `unknown`——**绝不**断言为可用；节点离线时是 `offline` / `unavailable`，回到在线时才是 `online` / `available`。

**Agent 侧的工具**是只读的 `control_live_state`，注册给 Router、PM 与 Worker（`src/control/roles.ts` 的三份角色档案、`src/node/dsh-port-host.ts` 的真实注册），它不带参数，用该 Session 自己的令牌发一次 `GET /v1/tools/memory/live-state`。

**本轮不动 Agent 的引导提示**：角色提示与节点的使用说明一字未改，工具靠它自己的说明被模型看见。实时状态的内容也**不进任何提示词**——它只从那个只读端点被读到，不被注入到 Agent 的上下文里。路由与派工同样未改。

### 7.2 `P5-2` 已上线的持久事件历史

`P5-2` 把持久事件历史做成了 `src/memory/event-history.ts` 里的一个**只读索引 + 一组写入点**，控制面只做薄委托（把参数交给它、把它的答案原样送出去）。

**表在哪儿**：`event_history_index` 建在 `control.sqlite` 里——ADR-4 的方案 B，与业务表同一个文件、同一个原子快照组；它**不**在 `console.sqlite` 的 `event_log` 上，也不受那 20000 行 / 7 天的裁剪影响（I13）。迁移是幂等的 `CREATE TABLE IF NOT EXISTS`，不占版本号；旧库重新打开时补上表，既有数据不动。

**一行是什么**：一条**事实**。`event_kind` 取 `trigger / dispatch / handoff / report / review / manual_stop / denial / schedule / error`；`scope_key` 与五个独立键（`ticket_id` / `project_id` / `control_session_id` / `assignment_id` / `node_id`）一起给出它属于谁；`source_table` / `source_id` / `source_seq` 给出它是从哪条记录的第几次提炼出来的；`summary` 是一句已脱敏的摘要，`detail` 是已脱敏的结构化补充。**正文里没有对话原文**：报告只留状态，评审只留决定，拒绝只留工具名与原因码，定时计划只留运行结果，失败只留代码与一段已脱敏的诊断；报告正文、原始 diff、请求体与绝对路径都不进来（I21）。

**什么时候写**：写在**真正发生它的那条路径**上，不写在「给这条记录贴个标签」的地方。域内提交的事实（派工、评审、人工停止、停止失败、工单交接）由域自己的提交事件带出来，与业务写在**同一个事务**里；入口侧的事实（请求、路由交接、报告、拒绝、定时运行）写在入口自己的事务里——其中**拒绝**与**定时运行**是两处明确的例外：拒绝的计数行在拒绝升级器的事务里，历史行紧随其后（中间崩溃只会留下「有拒绝、没有历史行」，绝不会反过来）；定时运行的运行行在 `console.sqlite`、历史行在 `control.sqlite`，两个库两个事务，运行行先写、历史行后写。**「同一个事务」说的是这一行写在哪里，不是说这一行一定在**：写失败时控制面把失败记进 stderr，那条事实就此丢失（不补写），而产生它的那笔业务仍然提交——这是一个真实存在的缺口，不是隐藏的失败。

**幂等**：事件的幂等键是 `sha256(kind ‖ scope_key ‖ 源记录的稳定 id ‖ 源记录的序号)` 的前 32 位十六进制（§2.3）。同一件事写两次写一次：重试的调用、重放的投递、重启后的补写都落在同一行上。同一源记录上**可以重复**的事（同一派工的第 n 次报告、同一工单的多次人工停止）靠 `source_seq` 区分。

**读的两个端点，都是 `GET`**：

| 端点 | 谁用它 | 授权 | 范围 |
| --- | --- | --- | --- |
| `GET /v1/console/memory/event-history` | 控制台 | 控制台连接密钥，或只读密钥（只读密钥只能 `GET`） | 本控制面的全部；可按 `ticketId` / `projectId` / `kind` 精确过滤，`limit` ≤ 100，`cursor` 是键集游标 |
| `GET /v1/tools/memory/event-history` | Router / PM / Worker | 该 Session 自己的工具令牌（`verifyToolToken`） | 由**该 Session 的记录**决定：Router 读它管理的池；PM 读它自己的项目；Worker 读它当前那张工单 |

**范围从不被请求决定**：与 §7.1 同一套闸——角色来自会话记录，PM 的项目按**真实的委托**解析，Worker 的 Assignment 必须仍是工单当前的那一次、且属于解析器点名的那个 Worker Session。范围与调用方给的精确键在**同一个 WHERE 子句**里，分页在它之后：不在范围里的一行既不被计数，也不被翻页越过（I14）。

**三档范围**：Router 读它管理的那个池（与 `P5-1` 的实时状态同一口径；§2.4 那一行给 Router 写的「仅限自己的工单/项目」更窄，本轮按 `P5-1` 执行，这一处差异记在这里）；PM 读它**真正被委托**的那个项目（按 `pmSessionId` 解析，不看会话记录自带的 `projectId`）、该项目下的工单，以及它自己会话下的事实——那份会话只属于这一个项目，够不到别处；Worker **只**读它当前那张工单——它所属项目的其他工单不在它的范围里，它的 Assignment 与会话也不是一条可以单独放行的旁路。

**不泄露别的项目是否存在**：别的项目的键**读不到任何行**，`total` 也是 0，与「这个键从来不存在」的答案完全一样；不存在与不允许，说的是同一句话。调用方**至少要给一个精确键**——没有键的查询被拒绝（400），历史不是按「全部」读的。

**读法必须报断口**（I19）：答案带 `coverage`，里面是索引里最早的一条（`since`）、已有的事实种类、以及「索引不按天数或行数裁剪，也不会自动删除」的保留规则。索引从它建立的那一刻开始，**更早的事实没有记录，也补不回来**——这一点在接口与控制台界面上都照实说出来。`coverage` 与行、`total` 一样**按读取者的范围算**：受限的读取者拿到的 `since` 与 `kinds` 只来自它自己的范围，不会从别的项目那里听说索引里还有它没有的事实种类、或者索引其实从更早的时候就开始了。操作员与 Router 没有范围限制，看的是整个索引。

**Agent 侧的工具**是只读的 `control_event_history_query`，注册给 Router、PM 与 Worker（`src/control/roles.ts` 的三份角色档案、`src/node/dsh-port-host.ts` 的真实注册），它带 `ticketId` / `projectId` / `controlSessionId` / `assignmentId` / `limit` 五个参数，用该 Session 自己的令牌发一次 `GET /v1/tools/memory/event-history`。**本轮同样不动 Agent 的引导提示**：工具靠它自己的说明被模型看见，历史正文不进任何提示词。

**控制台那一块是 loader 加 view**（`src/console/memory.tsx`）：loader 负责读、持有行、游标与各个标志；view 只负责把它们画出来，自己不读也不持有状态。这样这一块可以在没有自己那份 React 的地方被渲染出来（控制台自己的测试就是这么做的），筛选、加载、分页与失败都按同一份 props 断言。

**每一页都属于它被问的那个范围**：筛选变了、控制面自己的事实动了、面板关上了，这一代（generation）就结束；在旧的一代上回来的那一页**被丢掉**——它既不改行，也不改游标，也不改错误，也不改 busy 标志。一个 Project 的事实因此不会落进另一个 Project 的列表里。**当前这一次请求失败**时，第一页的行**留在屏幕上**，失败照实说出来，并且可以再问一次。

### 7.3 `P5-3` 已上线的记忆服务

`P5-3` 把长期记忆做成了 `src/memory/memory-service.ts` 里的**一个写入点**与 `src/memory/memory-scope.ts` 里的**一份规范**：作用域、权限与来源引用的核验只有一处，`Memory Service`、`P5-4` 的记忆管理员与 `P5-5` 的检索器都问它。

**表在哪儿**：`memory_candidates`、`long_term_memories` 与 `memory_conflicts` 建在 `control.sqlite` 里——与 `P5-2` 的 `event_history_index` 同一个原子快照组。迁移是幂等的 `CREATE TABLE IF NOT EXISTS`，不占版本号。**`memory_tombstones` 仍然没有建**：D1 未决，先不预埋（见 §8.2）。**FTS5 索引也没有建**：检索是 `P5-5` 的事，`I18` 随之留在 `P5-5`。

**它不调用模型**：`src/memory/**` 的 import 图里没有模型 SDK，不发起网络请求，不启动 Session，不跑命令。审核由人（控制台）或 `P5-4` 的记忆管理员通过同一个服务完成；**服务只做纯程序化操作**。

**候选先入队，记忆才由决定产生**。候选进入 `memory_candidates`（`queued` 或 `pending_human_confirm`），**在一次决定之前不进入可信的活跃视图**。没有一条路径把 `status` 直接写成 `active`：写入路径对 `status` 的流转只有服务里那几条。

**正文先过检查再落库**：正文必须说得出话、不得太长、**不得带路径或密钥**——带了的候选被**拒绝**（不是遮住：遮住的密钥仍然是文件里的密钥）。落库前仍过一次 `redact()`，来源引用的摘要同样过 `redact()` 且不超过 200 字符。来源引用**只引用**控制面自己持有的记录（工单、派工、评审、投递、审计、控制台便签、操作员原话、外部事件处置），**不搬运**原文。

**可信度是从来源推导的，不是申报的**：人自己的话是 `operator_explicit`；控制面确认过的结论（**已通过**的评审、**已结束**的派工、**已结束**的工单）是 `verified_execution`；其余——包括一切来自外部的观察——是 `external_tainted`，并且**一路保持**不可信。**带了一个控制面查不到的来源的事实一律算不可信，不管是谁提的**：人的原话是原话，可它背后的那条记录查不到，这条事实就不能因此升格。**不可信的事实永远不能被提升为全局事实**：全局作用域的写入必须带 `operator_explicit` 或可核验的 `verified_execution`，否则批准被拒绝。

**权限来自会话，不来自请求**：调用方是它证明出来的那一个 Session（角色、节点、真正被委托的项目），作用域由它推导。请求体里的角色、节点、项目与可信度标签**一律不作数**。

**写一次就是一次**：候选的幂等键是「来源引用 ‖ 正文指纹 ‖ 作用域」，同一条提案（重试、重放、重启后补写）落在同一行；同一作用域里的同一段话（NFKC 归一化后指纹相同）也只有一条待审候选。长期记忆的活跃指纹由**部分唯一索引**兜住，同一作用域里同一段话至多一条 `active`。**重复的那一条不回嘴**：提出者本人、操作员与记忆管理员看得见那一行（它的校验值、来源与审核意见），别的会话只得到一句「已经在队列里」——没有行、没有校验值、没有来源、没有是谁提的。这条规则住在 `memory-scope.ts` 里，`P5-4` 的管理员读的是同一处。

**查不到的来源不留下调用方自己的字**：控制面查不到的来源引用**不消失**（它仍然在列，仍然标为未核验），但它**不带走调用方说的时刻**——那不是控制面的钟；它的 `id` 也被限界并剥去不是 id 的字符，所以一条路径或一个令牌不会被当成记录的名字写进表里。事实的可信度因此**不因为 id 长得像什么而变**：查不到就是查不到。

**决定带版本**：决定带上读到的那个版本的校验值；候选在这期间变了，决定被拒绝（409），读一遍再来。版本更替时旧行转 `superseded` 并写 `deprecated_at`，与新行同事务切换；纯重复不新建记忆行，只追加来源引用、刷新 `last_verified_at` 并小幅上调置信度；真冲突把两端都移出可信视图、把冲突记进 `memory_conflicts`，且**同一个冲突只能提一次**。

**决定的闸门在同一个事务里**：候选的读取、版本校验与「能不能决定」的检查都在这一次决定的保存点里做完，因此两个决定不会在彼此看不见的情况下动同一条候选。

**等着人确认的候选只能由人决定**：`status = 'pending_human_confirm'` 的候选，**通过 / 归并 / 版本更替 / 挂起冲突**这四条决定只有操作员能下（它们都会让一条事实生效，或改动一条既有记忆）；退回不算生效，管理器仍可提交。

**不可信的事实不碰全局作用域**：全局作用域里 `source_trust = 'external_tainted'` 的候选，**任何**一条决定都动不了全局记忆——不新建、不归并进、不替换、不拿它去挂冲突。它也**不能把无关的既有全局记忆降级**（挂起冲突同样会把那一端移出可信视图）。全局作用域因此保持原样。

**冲突的两端必须是同一个作用域**：挂起冲突之前先比作用域，不一致就拒绝，且**不碰**目标记忆——冲突是同一件事的两种说法之间的矛盾，不是跨作用域的相互压制。

**按 id 读取**：记忆的 id 来自一个只增不减的计数器，**永不复用**；按 id 读取先看状态再看作用域，一个不生效的记忆与一个从未给过的 id 给出**同一种**「没有找到」（I15）。作用域过滤在 SQL 里完成。

**写后即读的那一条标记**（§5.5）：`operator_explicit` 的全局候选可以带 `provisional_same_session` 标记，**只**参与发起它的那一个会话的后续拼装。它**不是**长期记忆表里的一行，没有 `memory_id`，不进检索索引。别的会话读不到它；未审结的候选也不会进入任何可信检索结果。

**遗忘仍未决**：这一轮**没有任何删除入口**，`memory_tombstones` 没有建，没有任何路径会忘掉一条记忆。编辑与置顶也留给后面的阶段。

**控制台那一块**（`src/console/memory.tsx`）：同样是 loader 加 view——loader 读队列、读生效中的记忆、持有表单与动作的状态；view 只负责把它们画出来。**加载中 / 失败 / 空**分开说：没回答是「正在读取……」，失败照实说出来，读到零行才是「还没有」。决定的结果（通过、退回、归并、冲突、取代）各自有一句人话；失败时显示控制面自己的理由。

**控制台这一轮接的四条路**（都是控制台自己的命名空间，操作员凭连接密钥读，凭连接密钥写；只读密钥只能 `GET`）：

| 端点 | 谁用它 | 授权 | 范围 |
| --- | --- | --- | --- |
| `GET /v1/console/memory/candidates` | 控制台 | 控制台连接密钥，或只读密钥（只读密钥只能 `GET`） | 整个候选队列；`status` 可收窄，`limit` 有界 |
| `GET /v1/console/memory/memories` | 控制台 | 同上 | 生效中的长期记忆；`status` 可收窄，`limit` 有界 |
| `POST /v1/console/memory/candidates` | 控制台 | **只有操作员**（只读密钥 403，无凭据 401） | 提出一条候选：`content`、`scopeType`、`scopeId`，可选 `importance` 与 `sourceRefs` |
| `POST /v1/console/memory/candidates/:id/decision` | 控制台 | **只有操作员** | 一次决定：`decision`（`approve` / `reject` / `merge` / `conflict` / `supersede`）、`checksum`，`merge`/`conflict`/`supersede` 还要 `memoryId` |

---

## 8. ADR

### ADR-1：存储与检索

**背景**。Phase 5 需要三件事：候选队列、审核后的长期记忆、带权检索。检索要能在本地小模型（16K 窗口）的前提下工作，也要能在多机合流后不把单机环境经验污染成全局事实。规范 §0.2 要求：在引入任何**不可逆的外部存储依赖**之前，先提交含两个以上候选方案的 ADR 由用户决策。

**方案 A（推荐，首版落地）：本地 SQLite + FTS5 + 可替换的向量编码接口**

- 存储：与 `control.sqlite` 或独立库同族的 SQLite（见 ADR-1 的子决策）。
- 关键词检索：SQLite FTS5 + BM25（`unicode61` 分词器，中文另配 `trigram` 或外部分词）。
- 语义检索：一个**只做数值编码**的接口 `EmbeddingProvider`（输入文本 → 浮点向量，无提示词、无对话）。未配置或不可用时，检索器**平滑降级**为纯关键词路径（`degraded = true`）。
- 优点：零外部依赖；随 `control.sqlite` 一起备份与回滚；降级路径始终可用；`EmbeddingProvider` 是接口，外部向量库将来可以**换进去**而不改业务代码。
- 缺点：单机规模下向量检索的召回质量不如专用库；FTS5 的中文分词需要额外配置。
- 可逆性：**高**。换检索实现只改 `src/memory/retriever.ts` 的一个分支；换存储只动一个模块。

**方案 B（延后，需用户批准）：外部向量库 / 集群**

- 例：Qdrant、Milvus、pgvector，或独立的向量服务。
- 优点：亿级规模、分布式、多租户、成熟的 ANN 索引。
- 缺点：新增外部有状态依赖；备份与回滚要跨两个系统做原子快照；跨机部署与鉴权面变大；故障时降级路径必须自己实现（而 FTS5 降级是免费的）；运维成本对一个单节点控制面是过剩的。
- 可逆性：**低**。引入后数据落在外部系统，回滚要迁回。

**建议与门禁**。首版按方案 A 落地，并把它写成**可替换**的：存储层只有 `src/memory/` 里的模块知道表结构；检索层只有一个 `retriever.ts` 知道打分。方案 B **延后到需要时**，且必须先有 ADR-2（数据规模与真实召回质量的证据）与用户的明确批准。首版**不**引入任何外部向量依赖。

**待用户决策**：D3。

### ADR-2：遗忘语义与备份

**背景**。规范 §4.2 要求「用户手工删除某条记忆时，除标为 `forgotten` 外，还要记录规范化内容指纹与作用域；此后提取出命中指纹的候选直接静默拦截」。未提交的改动稿要求改为「永久删除正文、待审副本、关键词索引与向量，不保留墓碑或归档副本」。二者对**备份**的处理也完全不同：规范只谈运行库；改动稿的措辞（「删除操作不为该条记忆保留墓碑或归档副本」）在备份里如何兑现，并没有被界定。

**方案 A：逻辑抑制（指纹墓碑），正文可留可删**

- 删除 = `status = 'forgotten'` + 在 `memory_tombstones` 记 `(scope_type, scope_id, fingerprint)`。正文是否同时物理删除是**独立**的一步。
- 效果：此后每日维护或历史报告重审再提取出同指纹候选 → **静默拦截**（除非用户再次通过 `operator_explicit` 显式重设）。
- 备份：备份里可能仍有旧正文（备份是历史快照，不受运行库删除影响）。
- 优点：**可防复活**；可解释（能说出「为什么这条没进来」）；对操作员风险低。
- 缺点：指纹与正文仍在库内，严格的「已删除」无法对审计方证明；备份里的旧正文仍然存在。

**方案 B：物理删除，不留墓碑**

- 删除 = 抹掉正文、待审副本、关键词索引行、向量；不留墓碑、不留归档副本；旧 id 不再分配。
- 效果：再提取出同内容 → 会被**当成新记忆**重新进入队列（改动稿只保证「旧 ID 不得重新分配」与「按 ID 读取时未知/已删除 ID 同一种错误」）。
- 备份：备份里的旧正文**依然存在**，除非另有「备份也必须清理」的流程。
- 优点：对「这条内容已经不在系统里」的语义最干净。
- 缺点：**无法防复活**——维护巡检重审历史报告时会再次提取出同一条被用户明确忘掉的事实；这正是墓碑条款要解决的问题。风险最高。

**方案 C：物理删除 + 墓碑并存（正文删掉，指纹留下）**

- 删除 = 物理删正文/索引/向量，**同时**留一条墓碑（只有指纹与作用域）。
- 效果：既防复活，又不保留正文。
- 备份：备份里仍有旧正文（运行库已删，备份是历史）。
- 优点：兼顾两者。
- 缺点：墓碑表本身是「关于某条被删内容的记录」，操作员若要求「彻底不存在」，仍需回答墓碑的存在。

**备份的第三个独立问题**：备份是历史快照，**不因运行库的删除而改变**。因此：

- 选项 1（不做）：接受「删除只对运行库与之后的备份生效」。这是绝大多数系统的默认，也是**最可逆**的。
- 选项 2（做）：删除时同步改写历史备份，或用「加密密钥销毁」这类间接手段让旧备份不可读。这**不可逆**，且与「不主动销毁数据」的默认立场冲突。

**建议与门禁**。在用户裁决前：

- **不实施任何一条**。本轮不删任何真实数据，也不新增任何删除端点。
- 建议方向：**方案 A 或 C**（保留抑制能力），备份按**选项 1**（不改写历史备份），并把这一点写进操作员确认文案。
- 若用户选择方案 B（纯物理删除且不留墓碑），必须同时确认它**接受「维护重审会再次提取出被遗忘内容」**这一后果，并确认是否需要选项 2。

**待用户决策**：D1、D2。

### ADR-3：与已提交规范的冲突记录

| 维度 | 已提交规范（本文件的基线） | 未提交改动稿（未采纳） | 后果差异 |
| --- | --- | --- | --- |
| 遗忘动作 | `status='forgotten'` + `memory_tombstones` 记指纹与作用域 | 永久删除正文/副本/索引/向量，**不留墓碑** | 决定被忘掉的事实会不会再次被提取出来 |
| 重审再提取 | 命中墓碑指纹 → **静默拦截**，除非用户 `operator_explicit` 重设 | 无墓碑 → 走正常候选流程 | 方案 B 下「用户已经明确忘掉」这件事丢失 |
| 表清单 | `memory_candidates`、`long_term_memories`、`memory_tombstones`、`memory_maintenance_runs` | 同上但**去掉** `memory_tombstones` | 少一张表，少一个「为什么没进来」的解释 |
| 按 ID 读取 | 规范未明写；墓碑保留 `memory_id` 仅供审计 | 明确要求未知 ID 与已删除 ID 同一种「记忆不存在或已被用户删除」 | 本契约取**两条路径都满足**的写法（§6.2 I15）：按 id 读取不泄露该 id 是否曾经存在 |
| P5-3 / P5-6 验收 | P5-3 含「墓碑防复活」；P5-6 含「遗忘拦截」 | P5-3 含「永久删除与按 ID 读取未找到错误」；P5-6 含「删除后按 ID 读取返回未找到」 | 测试口径不同，不能互相替代 |
| 备份 | 规范未界定 | 措辞只覆盖运行库 | 两者都需要回答「备份里的旧正文怎么办」 |

**处置**：本文件以上表的**左列**为基线，因为它是已提交、已被 `P5-0` 任务书引用的规范；右列作为**提案**如实记录，不实施、不静默批准。工作树里那份未提交改动**保持原样**，本文件不修改它。裁决之后，本文件与被采纳的那一份同步更新。

**待用户决策**：D1（并连带 D2）。

### ADR-4：记忆表族摆在 `control.sqlite` 里，还是独立成库

**背景**。规范 §1.2 已经确定了一条**硬约束**：`event_history_index` 与长期记忆表族「可置于不受裁剪策略影响的独立 SQLite 库（如 `SUPERAGENT_MEMORY_DB`）或控制面持久库中；备份与回滚脚本必须将其与 `control.sqlite` 作为**同一原子快照组**处理，防止回滚后记忆的来源 `ticketId` / `assignmentId` 变成悬空引用」。

这条约束**不因摆在哪里而改变**：两种摆法都必须与 `control.sqlite` 同属一个原子快照组。ADR-4 决定的只是**默认摆法**，以及备选摆法什么时候才需要。

**方案 A：独立库 `SUPERAGENT_MEMORY_DB`**，与 `control.sqlite` 一起做原子快照组。
**方案 B：放进 `control.sqlite`**，天然同一事务与同一备份。

- A 的优点：记忆表与业务库分文件，记忆库的体积增长不影响业务库的备份时间与锁竞争。
- B 的优点：来源引用与被引用的行在同一个文件里，回滚天然一致；备份最简单；少一个必须成对操作的步骤。
- A 的风险：两份库必须一起备份、一起回滚，运维上多一个必须成对的步骤；一旦备份脚本漏掉一份，就出现悬空引用。
- B 的风险：记忆表与业务表共享同一个文件与同一个锁；`control.sqlite` 变大。

**建议与门禁**：**首版按方案 B 落地**（放进 `control.sqlite`）。理由：记忆的来源引用全部指向 `control.sqlite` 里的记录（`ticket`、`coordination_deliveries`、`kv['control/session:*']`），把两者放在同一个文件里，原子性由 SQLite 自己保证，而不是靠一套备份脚本的纪律；而且 `control.sqlite` 本来就不受 `console.sqlite` 的裁剪影响。

**方案 A 延后**，不是被否决：若记忆表的体积或写入量真的开始拖累业务库，再迁到独立库——那时表结构不变，只需换连接，而备份脚本按 §1.2 的快照组约束把两个文件一起处理，这条约束本来就与摆法无关。

**这条建议不改变 §1.2 的约束，也不单独保证三件事**：

1. **外部审计**：记忆表的写入不自动进入 `audit`；是否单独留一条外部可读的审计痕迹，是 §7 之后的问题，与摆法无关。
2. **溯源裁剪**：`source_refs` 的摘要允许被裁剪（§3.3 的脱敏规则），被裁掉的溯源在同文件里也不会自动复活。
3. **外键引用不会悬空**：同文件让**回滚**不至于悬空，但库里的 DDL 没有 `REFERENCES`（§1.1），跨表引用只在 TypeScript 里成立；删除一个 `ticket` 仍可能让一条记忆的来源指向不存在的行。这三条各自需要自己的机制，同文件只是免去了「两份库被分开回滚」这一种悬空。

**本 ADR 的效力**：它给出**默认值**（`control.sqlite`）与**备选摆法的启用条件**，不需要用户逐条裁决；无论采哪种摆法，§1.2 的同一原子快照组约束都成立。

---

## 9. 交付与验收边界

`P5-0` 那一轮**已交付**：

1. 本文件：数据源清查、五类对象枚举、字段级边界与逻辑键、来源可信度与脱敏、事务边界、最小索引/查询/输出契约、生命周期、权限矩阵、可测试不变量、四个 ADR。
2. 控制台的只读「记忆」页：`#/memory`，侧栏「记忆」，三个面板（实时状态 / 事件历史 / 长期记忆），如实区分已有记录与尚未提供的能力。事件历史的两项读取**只在该面板被打开时**才开始，加载中 / 失败 / 空是三件分开说的事。

`P5-0` 那一轮**明确没有做**（留给 `P5-1` 之后）：

- 没有建立 `memory_candidates`、`long_term_memories`、`memory_tombstones`、`memory_maintenance_runs`、`event_history_index` 中的任何一张表。
- 没有新增任何写入路径、任何新的 HTTP 端点、任何持久化保存、任何权限扩展、任何破坏性功能。
- 没有删除任何真实数据。
- 没有修改任何已批准的文档；工作树里那份未提交的 Phase 5 补充规范改动**保持原样**，未被采纳。

**`P5-3` 这一轮**（接口与界面见 §7.3）**已交付**：`memory_candidates`、`long_term_memories`、`memory_conflicts` 三张表与它们的写入路径；候选入队、幂等去重、作用域门禁、来源可信度推导、脱敏、状态流转、版本更替、冲突挂起、人工决定；控制台「长期记忆」面板上的候选队列、已保存记忆与人工决定。

**`P5-3` 这一轮明确没有做**：

- **没有建 `memory_tombstones`，也没有任何删除入口**：遗忘语义（D1）未决，先不预埋（§8.2）。编辑与置顶同样留给后面的阶段。
- 没有建 FTS5 索引、没有检索器、没有召回：那是 `P5-5`（`I1`、`I11`、`I18` 随之留在那里）。
- 没有建 `memory_maintenance_runs`、没有注册 `memory_manager.v1`、没有维护巡检：那是 `P5-4`（`I7`、`I12` 随之留在那里）。
- 没有给 Agent 注册任何记忆工具：`P5-4` 的 `memory_service.*` 工具与 `P5-5` 的检索工具都还没有。
- 没有删除任何真实数据，没有把任何真实对话搬进记忆表（I21）。

---

## 10. `P5-1` 至 `P5-6` 的顺序与交接

后续工程师按下面的顺序推进，每一步都必须先满足本文件的对应不变量，再进入下一步。

| 步骤 | 产出 | 必须先满足 | 完成判据 |
| --- | --- | --- | --- |
| **P5-1** | `src/memory/live-state.ts`：按角色权限返回实时快照 | I16、I17 | 节点/会话/工单/项目/计划的实时快照带抓取时间与 `online/offline/unknown`；查询不写长期存储、不触发模型；断线如实报（**已交付**，接口与界面见 §7.1） |
| **P5-2** | `src/memory/event-history.ts` + `event_history_index` | I13、I14、I19、I20 | 索引独立于 20000 行 / 7 天裁剪；按 Ticket/Project 隔离精确查询；**读法必须报断口**；自己的时间戳取控制面的钟；不建全局对话向量索引；未经批准不自动删除历史（**已交付**，接口与界面见 §7.2） |
| **P5-3** | `src/memory/memory-service.ts` + `src/memory/memory-scope.ts` + `memory_candidates` / `long_term_memories` / `memory_conflicts` | I2、I3、I4、I10、I21 | 零 LLM；幂等去重；作用域门禁；状态流转；版本更替链；脱敏；**引用而不搬运**原文（**已交付**，接口与界面见 §7.3） |
| **P5-4** | `src/memory/memory-manager.ts` + `memory_manager.v1` + `memory_maintenance_runs` | I7、I12 | 受限角色只带 `memory_service.*`；纯重复直接归并；退回不隐式复活已停会话且最多重评 1 次；离线维护如实记 `skipped_offline` |
| **P5-5** | `src/memory/retriever.ts` | I1、I8、I11、I18 | 存储层硬过滤在前；双路归一化与 `R_min` 门槛；`last_verified_at` 衰减；只有验收结单才累加 `U`；负反馈降权；索引与主表同事务 |
| **P5-6** | 端到端演示 + 控制台治理面板 | I5、I6、I9、I15 | 同会话显式偏好的写后即读；跨票复用；控制台查看来源与遗忘拦截；重启后三域状态一致 |

**交接要点**：

- `P5-3` 的 `Memory Service` 是**唯一**写长期记忆的地方。`P5-5` 的检索器只读。`P5-4` 的 Memory Manager 通过工具调用 `Memory Service`，**不直接写库**。
- `memory_tombstones` 这张表**先不建**。D1 裁决为「指纹抑制」或「两者并存」时，它随遗忘的语义一起建；裁决为「纯物理删除」时它**不存在**，而 `Memory Service` 里替代它的那段拦截逻辑也随之不写。在裁决之前，两条路径都不预埋，`P5-3` 那一轮因此**没有任何删除入口**。
- 每一张新表都要带 `node_id` / `backend_id`（§2.2），并用幂等 `CREATE TABLE IF NOT EXISTS`，不占用并行分支的表名。
- `src/memory/*` 是本阶段**唯一**新增的模块目录；`src/control/control-plane.ts` 只做**薄委托**（注册路由、把参数交给 `src/memory/` 的模块），不把记忆的逻辑写进内核文件。**不设行数配额**——「不超过 N 行」不是判据，判据是「这段逻辑该不该在内核文件里」：能在 `src/memory/` 里说清楚的事，就不该出现在控制面内核里。
- 控制台的三个面板是**接线位**：数据到位后只改对应面板的 props 与数据源，不改页面结构（§7）。

---

## 11. 文档入口

- [控制面内核](010-control-plane-kernel.zh-CN.md)：控制面持有的事实与它们的权威位置。
- [控制台](017-console.zh-CN.md)：控制台页面与操作。
- [Phase 4 协作架构](022-phase4-coordination-architecture.zh-CN.md)：本阶段沿用的权限拒绝、摘要订阅、投递恢复等既有机制。
- `docs/roadmap/NEXT_MAINLINE_PLAN_v1.1.md`：§4 的 `P5-0` 至 `P5-6` 任务书。
- `docs/roadmap/NEXT_PHASE5_MEMORY_SUPPLEMENT_v1.0.md`：本文件的直接上位依据（**已提交版本**；工作树中另有未提交改动，见 §0.2 与 §8.3）。
