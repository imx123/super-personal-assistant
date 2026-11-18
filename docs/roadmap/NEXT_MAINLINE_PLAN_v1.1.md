# Superagent `next` 主线后续执行计划（Phase 3 收尾与 Phase 4–5 执行规范）

> **文档状态**：执行主规范 / v1.1 · 2026-11-17  
> **工作分支**：`next`（建议各子任务在短期分支 `phase4/<task-id>`、`phase5/<task-id>` 独立验收后合入 `next`）  
> **当前仓库实况**：开发基线 `6875ef9`，已完成 `P3-0`（`2419bb6`）、`P3-1`（`9f62bd5`、`9f1265d`）、`P3-2`（`3dfbf4a`）、`P3-3`（`1b38219`、`b66ca88`）、`P3-4`（`3364630`）；当前停在 **`P3-Gate` 待验收**  
> **并行开发背景**：另一独立工作树 `feat/multi-node` 将从 `P3-Gate` 签收提交切出，并行推进跨设备多节点连接与后端适配器拆分。**本文件已完整内联双分支防冲突接口契约，无需读取外部跨设备计划文档。**

---

## 0. 执行总则：先完成 `P3-Gate` 锚点，再按接缝契约推进 Phase 4–5

你是 `next` 主线的实现与独立验收代理。本规范衔接仓库内的《Phase 3–5 总任务书 v1.1》（`Phase3-5_Codex_Master_Taskbook_v1.1_2026-11-17.md`）、`project_handoff.md` 与 `docs/roadmap/PHASE3_5_EXECUTION_LOG.md`：

1. **核对检出版本与保护现场**：运行 `git status -sb` 与 `git log -8 --oneline`，确认 `b66ca88` 与 `3364630` 已在当前分支历史中；若有本地未跟踪的旧审计草稿，归档至忽略目录 `.artifacts/`，严禁使用破坏性 Git 命令覆盖修改。
2. **不重做已验收任务，不跨阶段大包提交**：`P3-0` 至 `P3-4` 已完成实现与验证。请严格按 **`P3-Gate -> P4-0 -> P4-1 -> P4-3 -> P4-2 -> P4-4 -> P4-5 -> P4-Gate -> Phase 5`** 顺序逐个任务交付、独立提交，并同步更新 `docs/roadmap/PHASE3_5_EXECUTION_LOG.md`。
3. **坚守 v1.1 自主分派与安全边界**：Router 在既有授权范围内派独立工单、向已有 Project PM 交接普通工作（经用户连续原话复核）、以及在四条件同时满足时自动建项目并委派 PM，**一律保持默认免人工确认并在界面展示目标身份与真实接收状态**；歧义、多候选、跨项目越权、新增授权与高风险不可逆操作继续走澄清或显式审批门禁。

---

## 1. 与并行分支 `feat/multi-node` 的零冲突契约（本文件自包含）

为确保 `next` 在推进 Phase 4–5 期间不与并行开发的 `feat/multi-node` 分支产生架构或合并冲突，所有新增代码必须遵守以下四条硬性边界：

### 1.1 统一通过 `src/control/node-resolver.ts` 解析执行目标

在 `P4-0` / `P4-1` 中新建 `src/control/node-resolver.ts`，**必须原样采用以下共享类型签名**，禁止在 Phase 4/5 新增业务代码中直接裸调单实例 `this.nodePort`：

```ts
export interface ExecutionTargetBinding {
  readonly nodeId: string;
  readonly backendId: string;
  readonly logicalWorkspaceKey?: string;
}

export interface ThreeLayerGeneration {
  readonly nodeTrustEpoch: number;      // 节点注册/重连信任代际
  readonly assignmentEpoch: number;     // Assignment 或受管 Session 生命周期代际
  readonly toolTokenVersion: number;    // 工具令牌版本
}

export interface NodeLiveSnapshot {
  readonly nodeId: string;
  readonly displayName?: string;
  readonly isPrimary: boolean;
  readonly connectionStatus: 'online' | 'offline' | 'reconnecting';
  readonly lastSeenAt?: string;
  readonly backends: ReadonlyArray<{
    readonly backendId: string;
    readonly kind: string;
    readonly available: boolean;
    readonly capabilities: {
      readonly turnInterrupt: boolean;
      readonly twoStageReceipt: boolean;
      readonly sessionResume: boolean;
      readonly gitReviewDiff: boolean;
    };
  }>;
}

export type NodeResolutionErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'NODE_OFFLINE'
  | 'BACKEND_UNAVAILABLE'
  | 'OWNERSHIP_MISMATCH'
  | 'STALE_GENERATION'
  | 'PERMISSION_REVOKED'
  | 'MANUALLY_STOPPED';

export type NodeResolutionResult<T> =
  | { readonly ok: true; readonly handle: T; readonly generation: ThreeLayerGeneration }
  | { readonly ok: false; readonly code: NodeResolutionErrorCode; readonly reason: string; readonly nodeId?: string };

export interface NodeResolver<THandle = unknown> {
  resolveForSession(
    controlSessionId: string,
    op: 'ensure' | 'message' | 'interrupt' | 'stop' | 'resume' | 'reconcile'
  ): Promise<NodeResolutionResult<THandle>>;
  resolveForAssignment(
    ticketId: string,
    assignmentId: string,
    op: 'dispatch' | 'message' | 'stop' | 'verify_callback'
  ): Promise<NodeResolutionResult<THandle>>;
  getLiveNodeSnapshots(): ReadonlyArray<NodeLiveSnapshot>;
}
```

在 `next` 主线上，`node-resolver.ts` 仅需提供面向当前唯一 DSH 节点的单节点实现（按当前权威状态校验归属、人工停止、撤权与三层代际，绝不在目标失效时回退默认目标）。待后续合入 `feat/multi-node` 时，只需替换底层注册表委托即可自动获得多节点能力。

### 1.2 模块外置、SQLite 表隔离与协议追加准则

| 维度 | `next`（本分支 Phase 4–5）专属范围 | 并行分支保留范围（禁止占用） | 共享文件修改硬规则 |
| --- | --- | --- | --- |
| **新增代码模块** | `src/control/node-resolver.ts`（单节点实现）、`report-coordinator.ts`、`denial-escalator.ts`、`stream-subscriptions.ts`、`event-subscriptions.ts`、`delivery-outbox.ts`、`src/memory/*` | `src/control/node-registry.ts`、`src/node/adapter.ts`、`src/node/adapters/*`、`src/node/outbox.ts`、`src/node/workspace-resolver.ts` | 严禁往 `src/control/control-plane.ts` 塞入超过 30 行的内联逻辑，一律拆分为独立模块并在 `control-plane.ts` 做薄委托 |
| **SQLite 新增表** | `coordination_deliveries`、`session_stream_subscriptions`、`permission_denial_counters`、`external_event_subscriptions`、`event_history_index`、`memory_candidates`、`long_term_memories`、`memory_maintenance_runs` | `node_bindings`、`assignment_targets`、`inbound_report_dedup` | 不使用冲突的顺序迁移号；使用独立表名与幂等 `CREATE TABLE IF NOT EXISTS` |
| **多节点字段预留** | Phase 4/5 所有新增事件、投递、快照与长期记忆表均预留可选列 `node_id TEXT`、`backend_id TEXT`；长期记忆作用域枚举支持 `global \| project \| node` | 填充实际多节点 `node_id` 与 `backend_id` | 单节点运行时填入当前配置的 `nodeId` 与 `dsh`，防止日后多机合流时把单机本地环境经验污染为全局记忆 |
| **`protocol.ts`** | 仅在文件末尾 `// === COORDINATION & MEMORY V1 ===` 注释块下追加新类型 | 文件末尾 `// === MULTI-NODE & ADAPTER V1 ===` 注释块 | 禁止重命名、重排或删除任何现有协议类型与字段 |

---

## 2. 第一步：`P3-Gate` 阶段签收与测试基线加固

在启动 `P4-0` 之前，先在同一版代码上完成 `P3-Gate` 验收并建立干净分叉锚点：

1. **加固测试临时端口分配（仅改测试辅助设施，不改业务行为）**：
   - 针对 `PHASE3_BASELINE.md` 与 `PHASE3_5_EXECUTION_LOG.md` 中多次出现的随机临时端口命中 Chromium/Undici `fetch` 禁用端口段（如 `6000`、`6665-6669`、`10080`）报 `bad port` 的问题，统一封装测试端口获取辅助函数（若随机分配到禁用端口则立即关闭重绑）。
2. **逐项核验 Phase 3 出口条件**：
   - 复核 `P3-1`（停 PM 保留活跃 Project 与其他 Worker、人工停止防自动复活、绑定回合号打断 `aborted`、Router 忙时插话持久排队）、`P3-2`（快路由 0 模型回合直派与唯一项目直投）、`P3-3A/3B`（四条件门禁结构化核验、连续原话复核免确认交接 PM、真实三工单写三文件验收并回报 Router）、`P3-4`（19 项 Git 隔离实验证据与项目页并发覆盖风险提示）。
   - 运行 `tsc --noEmit`、构建与 55+ 个定向测试文件全集，核实旧 DSH 插件（`/orchestrator/api`）、独立控制台、Token/Node 协议与 Scheduler（含时区偏移与软暂停待验收通知恢复）全部通过；如实记录 Windows 目录联接限制导致的已知跳过项。
3. **提交并记录分叉锚点**：
   - 更新 `docs/roadmap/PHASE3_5_EXECUTION_LOG.md` 将 `P3-Gate` 标记为 `DONE`，记录该次提交 SHA（作为后续并行分支的共同锚点 `<fork-sha>`）。

---

## 3. Phase 4 实施规范：自主协调、权限审查与外部事件唤醒

> **阶段目标**：常规协作无需人工复制上下文；上级默认 Report 驱动并支持按需订阅下级周期摘要；真实权限守卫连续拒绝自动触发上级审查但不提权；外部观察事件按条件直接唤醒预定目标。本阶段继续在单 DSH 节点上运行，所有节点交互强制经过 `NodeResolver`。

### P4-0 · 协作事件模型与统一节点解析评审（设计门禁，不改业务行为）

- **产出文档**：`docs/022-phase4-coordination-architecture.zh-CN.md` 及 `src/control/node-resolver.ts` 类型定义。
- **评审必答内容**：
  1. 厘清三类机制边界对照表：① 旧插件 `Source / Trigger / Thread Subscription`（`subscriptions: string[]`）；② 独立控制面 `Session event / Report / Scheduler`；③ `P3-3B` 免确认自动交接（`router_handoff`）与保留的显式人工确认 `Relay Proposal`。
  2. 列出五条受约束路径（派工与追加指令、会话命令与干预、报告/摘要/通知与定时投递、外部事件直唤醒、节点回传与重启恢复）在**首次发送、`ensure` 返回后、重试前**的权威状态与三层代际核验矩阵。
  3. 明确区分授权拒绝（`PERMISSION_REVOKED`）、目标消失（`TARGET_NOT_FOUND`）、换代失效（`STALE_GENERATION`）、人工停用（`MANUALLY_STOPPED`）、节点离线（`NODE_OFFLINE`）与回执未确认（`DELIVERY_UNCONFIRMED`）的独立记录口径。

### P4-1 · Report 驱动的自动协调与单节点 `NodeResolver` 落地（P0）

- **模块位置**：`src/control/node-resolver.ts` + `src/control/report-coordinator.ts`。
- **实现要求**：
  - 将派工、会话干预与报告通知统一接入 `NodeResolver` 单节点实现。
  - 完善 `Worker -> PM`（项目工单）、`Worker -> Router`（独立工单）及 `PM -> Router`（仅限项目级进展与重大阻塞）的 `progress / blocked / completed / failed / dropped` 报告投递：终态与严重阻塞即时上报，常规进展按配置节流，禁止向上级模型推送全量子会话原始对话。
  - 报告附带目标引用、`assignmentId`、Review 轮次、来源 `node_id/backend_id` 与投递确认状态；报告正文按不可信数据隔离封装，不得改变系统权限。
- **验收**：真实 DSH 并发运行两个 Worker（一个 `blocked`、一个 `completed`），PM 准确收到两份报告并作出不同协调响应；控制面重启后不重复处理已完成的旧 Review；投递失败在控制台可查。

### P4-3 · 真实权限守卫拒绝检测与上级审查（P0，优先于订阅扩展）

- **模块位置**：`src/control/denial-escalator.ts`（落库表：`permission_denial_counters`）。
- **实现要求**：
  - **必须挂接在控制面与节点工具桥的权威 Permission Guard 拒绝点**，严禁靠解析模型输出文本猜测“被拒绝”，且绝不把节点离线、普通工具报错或常规令牌刷新计入权限拒绝。
  - 按 `(controlSessionId, ticketId, assignmentEpoch, managerTarget)` 在持久表中统计配置时间窗内的连续真实拒绝。
  - 达到可配置阈值时生成独立的 `system_denial_review` 审查通知，通过 `NodeResolver` 唤醒合法直接上级并附上被拒操作事实与任务摘要，抑制重复唤醒风暴。
  - **安全底线**：原被拒操作继续阻断；上级被唤醒**不自动提权、不自动重放原被拒操作**；与 Worker/PM 主动发起的 `blocked / escalation` 工具报告完全分路。
- **验收**：真实 Guard 拦截连续越权操作 -> 仅唤醒上级一次且原操作仍被拒；普通网络/工具错误零误触；跨 Project 不得借拒绝触发越权访问。

### P4-2 · 上级按需订阅下级信息流摘要（P1）

- **模块位置**：`src/control/stream-subscriptions.ts`（落库表：`session_stream_subscriptions`）。
- **实现要求**：
  - Router/PM 可显式订阅或退订具有合法直接管辖关系的下级 Session 周期性信息流摘要（默认不订阅；跨 Project 越权订阅返回 `403`）。
  - 与“外部观察事件订阅”严格区分业务模型。按配置间隔推送增量摘要与上下文引用链接，不复制全量历史；子任务结束、撤权或停止时自动停推，重连后不无限补发。
- **验收**：真实 DSH 下 PM 订阅 Worker A 而不订阅 Worker B，仅按周期收到 A 的摘要，取消后立即停止，越权订阅被拒。

### P4-4 · 外部观察事件订阅与直唤醒（P1）

- **模块位置**：`src/control/event-subscriptions.ts`（落库表：`external_event_subscriptions`）。
- **实现要求**：
  - 仅针对**外部观察事件**建立 `Source -> Trigger -> Subscription` 条件匹配与目标唤醒（用户指令、内部报告与既有定时任务维持原路径）。
  - 支持用户与获授权 Agent 执行订阅 CRUD（带角色配额上限、来源、条件、预定唤醒目标与生命周期）。条件支持确定性规则/正则及受控的 Router 语义判断。
  - 外部事件内容按不可信数据边界封装防提示注入。条件命中时经 `NodeResolver` **直接唤醒预定 Router/PM/Worker**；若关联 Ticket/Project 已结束、权限已撤销或目标已被人工停止，明确记为失效/拒绝，**不自动改派、不重新路由、不自动建 Project、不扩权**。
  - 首版采用可重放的**合成外部事件源**完成端到端验证，不接入真实私人邮箱/日历。
- **验收**：合成外部事件命中规则直接唤醒指定 Worker（无需绕行 Router）；重复事件去重；过期 Ticket 订阅不再激活；恶意事件载荷无法越权调用工具。

### P4-5 · 协调投递持久化与恢复（P1）

- **模块位置**：`src/control/delivery-outbox.ts`（落库表：`coordination_deliveries`，不占用 7 天裁剪的 Console Event Log）。
- **实现要求**：
  - 分离**授权寿命**与**消息寿命**。将控制面已接受的自动派单/交接、Report 通知、拒绝审查通知与外部事件唤醒写入持久投递表（含幂等键、尝试次数、目标代际与确认状态）。
  - 重启恢复时经 `NodeResolver` 重查权威状态：确属“尚未发出”且目标、代际和授权仍有效的记录按原幂等键补发；“已尝试发出但缺回执”的记录先查接收证据，无证据时保留 `unconfirmed` 而不盲目重发导致重复执行；旧版显式人工 `Relay Proposal` 过期或撤权后绝不复活。普通任务分派保持免人工确认体验。
- **验收**：FakeNode 故障注入与控制面重启对账全过，未确认消息不谎报已送达，无重复实质执行。

### P4-Gate · Phase 4 阶段总验收

- 受控用例完整验证五类路径经 `NodeResolver` 处理目标消失、代际变化、撤权、节点离线与丢回执，核对底层节点调用与 SQLite 记录。
- 真实 DSH 演示自动分派、双 Worker 并发报告、单路摘要订阅、连续拒绝触发上级审查与合成事件直唤醒；旧插件、Scheduler 与 Phase 3 回归全过。

---

## 4. Phase 5 实施规范：三域记忆系统（Live State / Event History / Long-term Memory）

> **阶段目标**：清晰划分实时状态、任务事件历史与长期可复用知识，跑通 `Candidate -> Manager Review -> Service Commit -> Weighted Retrieval` 全链路，杜绝跨作用域泄漏、无界模型调用或误删原始历史。

### P5-0 · 数据源清查、记忆数据契约与 ADR 门禁

- 清查 `control.sqlite`、`console.sqlite`、节点 `DSH_HOME` 会话日志与项目工作区，严格区分 `Project Profile`、`project_memory`（手工项目备忘）、`Event History` 与 `Long-term Memory`，禁止靠重命名旧表冒充长期记忆。
- 输出 `docs/023-phase5-memory-contract.zh-CN.md`，定义作用域模型（`global`、`project:<id>`、`node:<id>`）、来源引用、冲突状态机与脱敏规则。
- **ADR 门禁**：底层向量库选型、评分衰减参数与物理归档/销毁策略未定稿。在引入任何不可逆外部存储依赖前，必须先提交含 2 个以上候选方案的 ADR（首版推荐基于 SQLite + 可替换检索接口构建最小确定性/混合检索实现）供用户决策。

### P5-1 · Live State 统一只读获取（P0）

- **模块位置**：`src/memory/live-state.ts`。
- 按请求 Agent 的权限范围实时聚合 Node（读取 `NodeResolver.getLiveNodeSnapshots()`）、Session、Ticket、Assignment、Project 与运行计划，标注抓取时间与 `online / offline / unknown` 真实状态。
- **禁令**：每次实时状态查询不得写入长期记忆或触发 LLM；断线必须如实返回 `offline/unknown`。

### P5-2 · Durable Event History 持久事件历史（P0）

- **模块位置**：`src/memory/event-history.ts`（落库表：`event_history_index`）。
- 独立于默认 `20,000` 条 / `7` 天自动裁剪的 Console Event Log，按 `ticketId / projectId / controlSessionId / assignmentId / nodeId` 建立持久可查的关键事件索引（Trigger、派工、交接、Report、Review、人工停止、权限拒绝、调度结果与关键错误），不建全局全对话向量库。提交留存与脱敏方案，未经批准不自动删除历史记录。

### P5-3 · 无 LLM 的 Memory Service 与候选持久队列（P0）

- **模块位置**：`src/memory/memory-service.ts`（落库表：`memory_candidates`、`long_term_memories`）。
- **零 LLM 约束**：`Memory Service` 内部严禁调用任何 LLM SDK，纯以程序接口完成候选持久入队、幂等去重、审核状态流转、版本冲突拦截、作用域权限校验、确认落库与索引同步。未经审核通过的候选不得进入常规可信检索结果。

### P5-4 · Memory Manager LLM 审核与每日维护（P1）

- **模块位置**：`src/memory/memory-manager.ts`（落库表：`memory_maintenance_runs`）。
- Router/PM 仅从关键结论与用户稳定偏好中提炼跨任务候选（附精确来源引用与 `global | project | node` 建议作用域，禁止把 Worker 全量聊天灌入队列）。
- Memory Manager 模型负责查重、识别矛盾、核查来源有效性并调用 `Memory Service` 工具写入；缺乏证据或前后矛盾时退回提出者或标为待确认，不得凭模型偏好静默覆盖较新事实。
- 实施可配置的每日维护巡检（查重、时效、冲突与索引核对），如实记录运行结果；未调度或节点离线时不得伪称维护已完成。

### P5-5 · 权限前置过滤与可配置权重检索（P1）

- **模块位置**：`src/memory/retriever.ts`。
- **安全过滤顺序**：必须先在存储查询层按调用者权限与作用域（含 `projectId` 与 `nodeId` 匹配）完成硬过滤，再计算查询相关性 $R$ 与记忆优先级 $P$，严禁先召回无权限记忆再交给模型筛选。
- **参数化评分与防自激加权**：使评分真正驱动排序并输出可解释分项（例如将 $Score = R \cdot (0.5 + 0.5P)$、$P = 0.35I + 0.25C + 0.25F + 0.15U$、$F = \exp(-\lambda_{\text{type}} \cdot \Delta t)$ 作为可配置默认参数，配合小型固定评估集验证）。严格区分**仅被检索召回**与**在实际任务执行中被证实有效采用**，仅对后者赋予更高且带上限的效用 $U$ 增长；过期记忆降权并显式提示，不直接销毁底层事实；外部文本带不可信来源隔离标记。

### P5-6 & P5-Gate · 端到端融合演示与全阶段签收

- 真实 DSH 完整跑通：创建任务 -> Router 结合 Live State 与长期记忆自主分派 -> Worker 执行回报 -> 候选入队经 Memory Manager 审核落库 -> 下一张新工单在合法作用域内按需召回该知识，且原任务独立保存在 Event History 中，重启后依然有效。
- 复验 Phase 3、Phase 4、Phase 5 核心回归与越权/提示注入防护，全部通过后更新 `PHASE3_5_EXECUTION_LOG.md` 完成签收。

---

## 5. 后续与 `feat/multi-node` 的集成合流检查单

当并行分支 `feat/multi-node` 完成双 Windows 真机验收准备合入 `next` 时，在临时集成工作树核验以下四项：

1. 将 `src/control/node-resolver.ts` 切换至 `feat/multi-node` 的 `NodeRegistry` 多节点实现，确认 Phase 4 的报告、摘要订阅、拒绝审查、事件唤醒与投递恢复无需改业务代码即可按目标绑定寻址对应节点。
2. 确认双方各自的独立模块文件、`protocol.ts` 尾部追加区块及正交 SQLite 表名零冲突共存。
3. 确认 `Live State` 自动展示多节点在线/后端能力快照，且单节点专属记忆受 `node:<id>` 作用域约束不跨机污染。
4. 在同一份集成构建上通过单节点回滚、Phase 3–5 主链路与双机真机回归后再合入 `next`。

---

## 6. 每轮任务交付回复模板

```text
[Branch / Task] next · <例如 P3-Gate | P4-0 | P4-1 | P5-3>
[Base HEAD / Worktree] <sha> / <clean-or-dirty>
[Current status] INVESTIGATING | IMPLEMENTED_UNVERIFIED | TESTED_FAKE_NODE | VERIFIED_REAL_DSH | BLOCKED | DONE
[Seam check] <确认遵守 NodeResolver 签名、独立模块拆分、独立 SQLite 表名、node_id/backend_id 预留及 protocol.ts 尾部追加规则>
[What exists] <现有相关实现路径与行为证据>
[Change] <本轮确切修改与保持的关键不变量>
[Tests] <执行命令、通过/失败/跳过计数、是否真实 DSH>
[Evidence] <日志、测试文件或 .artifacts/ 脱敏证据真实路径>
[Risks] <遗留风险、兼容性与安全评估>
[Commit/PR] <提交 SHA 或明确未提交>
[Next] <下一项最小任务>
[Needs human decision?] <仅触发任务书 §2.4 或 P5-0 ADR 门禁时填写；否则 none>
```