# Superagent 跨设备协作实施计划（`feat/multi-node` 执行规范）

> **文档状态**：执行主规范 / v1.1（对齐仓库 2026-11-17 主线基线）  
> **工作分支**：`feat/multi-node`（必须使用独立 Git Worktree 检出）  
> **分叉基线要求**：从包含 `b66ca88`（P3-3B 高层自动交接）与 `3364630`（P3-4 工作区实验提示）、且工作区干净的 `next` 稳定提交切出（建议在 `next` 完成 `P3-Gate` 签收提交后立即切出，记该锚点为 `<fork-sha>`）  
> **并行对端分支**：`next` 主线（同步推进 Phase 4 协调/事件订阅与 Phase 5 三域记忆；本文件已自包含双分支防冲突契约，无需读取对端任务书）

---

## 0. 第一条指令：先核对基线与源码，再动手实现

你是 `feat/multi-node` 分支的实现与验证代理。本文件是工作约束与验收规范，请严格按以下顺序执行：

1. **核对分叉基线与隔离工作树**：
   - 运行 `git status -sb`、`git log -8 --oneline`，并执行 `git merge-base --is-ancestor b66ca88 HEAD` 与 `git merge-base --is-ancestor 3364630 HEAD`，确认 P3-1 会话干预、P3-2 快路由、P3-3B 高层自动交接及 P3-4 工作区提示均已在当前基线内。
   - 使用独立工作树开发（例如 `git worktree add ../superagent-multi-node -b feat/multi-node <fork-sha>`），严禁与 `next` 主线共用工作目录、测试 SQLite 数据库或测试 `DSH_HOME`。
2. **阅读仓库现有实现与规范（以实际源码为准）**：
   - 交接与架构文档：`project_handoff.md`、`docs/009-node-protocol.zh-CN.md`、`docs/010-control-plane-kernel.zh-CN.md`、`docs/015-node-deployment.zh-CN.md`、`docs/016-control-plane-tls.zh-CN.md`、`docs/017-console.zh-CN.md`、`docs/018-phase3-session-stop.zh-CN.md`、`docs/019-phase3-fast-router.zh-CN.md`、`docs/020-phase3-project-gate.zh-CN.md`、`docs/021-phase3-router-handoff.zh-CN.md`、`docs/roadmap/PHASE3_5_EXECUTION_LOG.md`、`docs/roadmap/PHASE3_WORKSPACE_SPIKE.md`。
   - 核心代码检查起点：`src/control/start.ts`、`src/control/control-plane.ts`、`src/control/executor.ts`、`src/control/router-handoff.ts`、`src/control/roles.ts`、`src/shared/protocol.ts`、`src/node/plugin.ts`、`src/node/dsh-port-host.ts`、`src/node/review-diff.ts`。
3. **先提交只读调查结论（`F-0`）**：
   - 在改动业务代码前，先核实现有单节点连接、会话 ID 映射、工具令牌校验及停止状态流转，确认测试基线通过，再按 **F-1 -> F-2 -> F-3 -> F-4** 逐阶段独立提交。禁止跨阶段大包提交。
4. **严守并行防冲突边界**：
   - 严格遵守本文 **§2 双分支并行零冲突契约**。不要在 `src/control/control-plane.ts` 中堆砌大段多节点内联逻辑，所有新增机制拆入独立模块并通过薄委托接入。

---

## 1. 首版目标、部署拓扑与架构不变量

### 1.1 首版目标

在两台 Windows 电脑组成的 Tailscale 私网（tailnet）中，用户从同一个主窗口向两台机器各派发独立工单。两台机器各自调用本地配置好的真实后端执行，完成报告自动写回原工单并通知 Router，在主窗口实时可见。两台机器的真实后端可以相同（例如均为独立 DSH Desktop Profile），同时必须用两套行为和能力矩阵不同的模拟适配器（Fake Adapters）验证协议与控制面可安全处理异构后端。Android 设备能力接入作为下一阶段扩展目标，不在本分支首版范围内。

### 1.2 部署与安全拓扑

- **网络与传输**：最小部署使用同一个 Tailscale tailnet。建议将控制面部署在主节点同一台 Windows（机器 A）上以便本地维护。控制面主动连接两台执行节点的命令与 SSE 事件接口；远端执行节点主动回调控制面的报告与工具接口。联调需同时验证双向 HTTP 请求与 SSE 断线重连。
- **凭据隔离与 TLS**：各执行节点在本地独立保存各自后端的运行凭据，控制面不集中托管后端私有凭据。端点仅监听 tailnet 或受控内网地址；**节点连接密钥**与**控制台操作员凭据**必须分开配置。TLS 可采用仓库既有的 HTTPS 反代方案（见 `docs/016-control-plane-tls.zh-CN.md`）或 tailnet 内的 Tailscale Serve。

### 1.3 组件职责划分

| 组件 | 核心职责与约束 |
| --- | --- |
| **控制面（Control Plane）** | 唯一权威持久化 Ticket、Assignment、会话索引、目标绑定和报告。按权威状态选定并解析执行节点与后端，执行三层代际校验，更新业务状态。独立工单报告回原 Ticket 并通知 Router。 |
| **主节点（Primary Node）** | 运行 Superagent 节点程序并接入承载 Router Session 的后端实例。首次配置启动时持久化记录 Router 的 `{ nodeId, backendId }` 绑定；后续重启必须沿用同一绑定。若启动配置与持久记录不符，立即显式报配置冲突退出，拒绝覆盖既有 Router 会话。首版不设在线更换 Router 后端的操作入口。 |
| **执行节点（Execution Node）** | 每台机器运行 Superagent 节点程序（主节点自身也可作为 Worker 的执行节点）。接收派工、管理本机逻辑工作区路径解析、维护节点本地断网待发箱（Outbox）、调用后端适配器并回传执行事实。 |
| **后端适配器（Backend Adapter）** | 将创建/恢复会话、投递消息、按回合号中断、查询状态、停止会话和交付报告等操作映射为具体后端能力。DSH 继续通过专用 Profile 加载插件作为适配入口；控制面与节点通用调度层不保留 DSH 宿主专用启动代码。 |
| **执行后端（Backend Host）** | 实际创建、持有并运行 Agent Session。节点程序只记录外部会话引用与代际元数据，跨进程恢复时通过适配器向原后端实例查询对账。 |

### 1.4 核心架构约束与不变量

1. **单张独立工单固定节点（禁止同单跨机改派）**：
   - 独立工单在创建首个 Assignment 时确定 `{ nodeId, backendId }` 并持久化。
   - 由于工单重派前必须确认旧执行已停止，且独立工单拥有本地专属工作区目录，**同一张独立工单的后续重试、追加指令与续接固定留在首次选定的节点**（同一节点内若配置了共享同一本地工作区的兼容备用后端，仅在确认旧会话已停止后允许按策略切换后端；若需换另一台电脑执行，必须新建独立工单）。这保证了远端节点离线时不会触发跨机重派死锁，也不会因跨机重派丢失上一轮产出的本地文件。
2. **既有 Project 维持原节点执行**：
   - 当前项目内 PM 与 Worker 共用项目工作区，PM 的只读 `review.diff` 强绑定项目本地仓库。本轮仅对**独立工单**开放跨节点选择；Project 的 PM 与项目内 Worker 继续固定在该项目绑定的原节点运行。跨节点项目审阅留待后续工作区产物传递方案确定后再议。
3. **主从分级启动（副节点离线不阻塞控制面）**：
   - 当前单节点实现中，控制面启动时若注册节点失败会直接退出。扩展为多节点静态清单后，控制面启动仅强校验主节点配置冲突与可达性（或主节点待命握手）；静态清单中的副节点关机、休眠或未连入 tailnet 时，控制面正常启动并将该副节点标为 `offline`，后台按退避策略重连。
4. **选路零幻觉与失败关闭（Fail-Closed）**：
   - 未显式指定节点时，独立工单默认归主节点。
   - 用户显式指定副节点时，若该副节点当前 `offline`、后端不可用或无法满足工单权限，控制面必须明确返回不可用或拒绝状态，**严禁静默回退投递给主节点**。

---

## 2. 与 `next` 分支并行的零冲突契约（必须遵守）

`next` 主线正在同步推进 Phase 4（协调、权限审查、事件订阅）与 Phase 5（三域记忆）。为确保两分支后续在集成工作树平滑合并，必须严格遵守以下接缝约定：

### 2.1 共享统一节点解析契约（`src/control/node-resolver.ts`）

两分支使用完全相同的类型签名定位执行目标，禁止在新增逻辑中直接裸调单实例 `NodePort`：

```ts
export interface ExecutionTargetBinding {
  readonly nodeId: string;
  readonly backendId: string;
  readonly logicalWorkspaceKey?: string;
}

export interface ThreeLayerGeneration {
  readonly nodeTrustEpoch: number;      // 节点注册/重连信任代际
  readonly assignmentEpoch: number;     // Assignment 或受管 Session 生命周期代际
  readonly toolTokenVersion: number;    // 工具令牌版本（允许有效派工在断网重连后安全续期）
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

在本分支中，`src/control/node-resolver.ts` 委托给新建的 `src/control/node-registry.ts`（管理静态多节点连接池、心跳与后端能力）。合并时将无缝接管 `next` 分支 Phase 4 的全部单节点桩调用。

### 2.2 模块路径、SQLite 表与协议文件隔离表

| 维度 | `feat/multi-node`（本分支）负责范围 | `next`（Phase 4–5）负责范围 | 防冲突硬规则 |
| --- | --- | --- | --- |
| **新增代码文件** | `src/control/node-registry.ts`、`src/node/adapter.ts`、`src/node/adapters/*`、`src/node/outbox.ts`、`src/node/workspace-resolver.ts` | `src/control/report-coordinator.ts`、`stream-subscriptions.ts`、`denial-escalator.ts`、`event-subscriptions.ts`、`delivery-outbox.ts`、`src/memory/*` | 新逻辑全部外置为独立模块；不在 `control-plane.ts` 内写超过 30 行的内联实现 |
| **SQLite 新增表** | 控制库新增 `node_bindings`、`assignment_targets`、`inbound_report_dedup`；节点侧使用本地目录文件 Outbox | 控制/控制台库新增 `coordination_deliveries`、`session_stream_subscriptions`、`permission_denial_counters`、`external_event_subscriptions`、`event_history_index`、`memory_*` | 严禁争用顺序迁移版本号；表名完全正交，使用幂等 `CREATE TABLE IF NOT EXISTS` |
| **`protocol.ts`** | 仅在文件尾部的 `// === MULTI-NODE & ADAPTER V1 ===` 注释块下追加新类型 | 仅在文件尾部的 `// === COORDINATION & MEMORY V1 ===` 注释块下追加新类型 | 严禁删除、重排或重命名现有协议字段；单节点旧字段保持向后兼容 |
| **测试端口分配** | 使用过滤危险端口（如 `6000`、`6665-6669`、`10080`）的安全临时端口辅助函数 | 相同规则 | 消除 Chromium/Undici `fetch` 偶发的 `bad port` 测试失败 |

---

## 3. 对照现有实现的五大改造设计

### 3.1 节点连接池与后端适配器解耦

1. **静态节点清单与单节点兼容（改造 `src/control/start.ts`）**：
   - 支持配置静态节点列表（包含每个节点的 `nodeId`、显示名称、`url`、独立连接密钥、`isPrimary` 标记）。
   - 当未提供多节点列表而仅提供旧版单一 `SUPERAGENT_NODE_URL` 时，自动映射为单条主节点配置，保持 100% 向后兼容。
2. **后端适配器契约与主键隔离（改造 `src/node/plugin.ts` 与会话索引）**：
   - 控制面当前在登记、心跳与 Session Token 中将 backend 硬编码为 `dsh`，且协议中的 `dsh | claude | codex` 仅为名称预留。本分支抽出通用 `BackendAdapter` 接口，把 DSH 宿主交互彻底封装进 `DshBackendAdapter`，实际支持能力一律以适配器运行时返回的 `BackendCapabilities` 为准。
   - **主键规范化**：控制面内部统一以 `controlSessionId`（如 `router`、`pm-<projectId>`、`worker-<assignmentId>`）作为唯一会话主键，同步清理底层领域记录中 `Assignment.sessionId` 的旧命名不一致遗留；外部后端会话统一按复合键 `(nodeId, backendId, backendSessionId)` 索引。即便两个节点或两套模拟适配器返回完全相同的 `backendSessionId`，状态查询、插话、打断与报告回调也互不串线。
3. **能力矩阵诚实降级**：
   - 针对 `P3-1B` 已落地的“绑定当前回合编号打断（`aborted`）”和“节点收件箱入队 vs 模型回合读取两阶段回执”，若某个异构适配器声明 `turnInterrupt: false`，控制面对纯回合打断请求必须明确返回 `UNSUPPORTED_CAPABILITY` 并在前端禁用该按钮，严禁用销毁整个会话的 `cancel` 冒充回合中断；若 `twoStageReceipt: false`，前端如实展示单阶段送达状态。

### 3.2 主窗口双层选路与连续原话复核

1. **只读节点状态注入**：在 Router 处理请求前，注入 `getLiveNodeSnapshots()` 返回的在线节点与可用后端摘要（只读事实，不写长期记忆）。
2. **快路由选路（扩展 P3-2）**：支持显式设备标签（如 `@node:<nodeId>` 或唯一设备别名规则）直接将独立工单分派至目标节点，0 模型回合完成创建并展示目标 `nodeId`、`backendId` 与投递状态；若指定节点离线，直接返回明确未送达原因，不升级给模型瞎猜。
3. **高层路由选路与原话复核（扩展 P3-3B）**：
   - 在独立工单派发工具中增加可选 `targetNodeId` 与 `targetNodeQuote`。
   - 沿用 `src/control/router-handoff.ts` 的连续原话复核机制：**仅当用户本人连续原话中明确点名目标设备时**，控制面复核通过才派往副节点；未点名设备时一律派往主节点；名称匹配多个节点存在歧义时退回要求澄清。

### 3.3 双层事件游标、节点本地 Outbox 与离线对账

1. **分离上下游事件游标**：
   - 控制面向每个执行节点订阅事件流时，按 `(nodeId, nodeBootId, lastSeq)` 独立维护上游游标；单节点断线重连只影响并重放该节点自身的事件。
   - 控制面向浏览器控制台推送 SSE 时，维持现有的控制面全局游标，并在事件对象中附带 `nodeId` 与 `backendId`。
2. **节点本地文件待发箱（`src/node/outbox.ts`）**：
   - 控制面持有 SQLite，执行节点自身无业务 SQLite。为保证断网期间产出的完成报告与终态回执不丢失，执行节点在 `<SUPERAGENT_NODE_DATA_DIR>/outbox/` 目录下以原子写入方式保存待上报事件文件（携带稳定幂等键）。
   - 重连成功后按序补交；控制面在 `inbound_report_dedup` 表中按 `(ticketId, assignmentId, reportIdempotencyKey)` 幂等落库，确保重放报告只产生一次可见状态流转与一次 Router 通知。控制面确认接收后，节点清理对应本地文件。
3. **跨断网令牌续期与三层代际拦截**：
   - 若节点 B 执行耗时加断网时长超过了短效工具令牌宽限期，重连补交报告时可凭节点连接密钥请求 `token.exchange`：控制面校验 `nodeId`、`backendId`、`assignmentId` 的 `assignmentEpoch` 仍有效且未撤权时，换发新 `toolTokenVersion` 允许提交。
   - 若断网期间该工单已被取消、撤权（`revoke`）或更换派工，控制面按 `STALE_GENERATION` 或 `PERMISSION_REVOKED` 拒绝（返回 `409/403`），节点将该条目移入本地 `dead-letter/` 目录留存审计，绝不覆盖控制面工单状态。
4. **离线停止对账与定向残留清理（`reconcile`）**：
   - 对离线节点上的会话发起停止时，控制面持久化记录 `stop_pending_ack`（前端显示“停止待节点确认”，并严格遵守 `P3-1A` 不变量：未获节点确认停止前禁止恢复会话）。节点重连后立即执行挂起的停止指令并在确认后转为 `stopped`。
   - 控制台手动或定时 `reconcile` 只扫描并清理当前 `online` 节点的残留会话，跳过 `offline` 节点，防止误报失败或破坏重连对账。

### 3.4 跨盘符逻辑工作区解析与产物引用

1. **逻辑工作区安全解析（`src/node/workspace-resolver.ts`）**：
   - 两台 Windows 的盘符与目录层级可能不同。独立工单派工协议改传 `logicalWorkspaceKey`（如 `standalone/<ticketId>`），由目标执行节点在本地配置的 `<NODE_WORKSPACE_ROOT>` 下解析为物理绝对路径。
   - 节点端强制执行路径安全校验：拦截 `..`、绝对盘符注入、UNC 路径与符号链接越界，确保规范化后的真实路径严格位于 `<NODE_WORKSPACE_ROOT>` 之内，并保持现有的 Git 元数据校验边界。旧单节点历史工单保留原路径语义兼容读取。
2. **结构化产物引用（`ArtifactRef`）与节点作用域元数据**：
   - 首版产出文件留在目标执行节点本地，完成报告除正文摘要外回传结构化产物引用 `{ nodeId, logicalWorkspaceKey, relativePath, sizeBytes, sha256, updatedAt }`，供主窗口直接展示核验。
   - 所有会话与报告记录均落库保存 `nodeId` 与 `backendId`，为后续合入记忆系统提供准确的设备作用域标记。

---

## 4. 实施阶段、验收门禁与暂停准则

### 4.1 四阶段推进表

| 阶段 | 核心交付 | 通过条件（Gate） |
| --- | --- | --- |
| **F-0 · 基线核查与接缝就位** | 检出独立 worktree；提交只读基线核查结论；落地 `src/control/node-resolver.ts` 接口定义与测试安全端口辅助函数。 | `tsc --noEmit`、构建及现有定向回归全过，无随机端口报错。 |
| **F-1 · 拆出节点与后端适配器接口** | 落地 `BackendAdapter`、`BackendCapabilities` 与复合会话键；将 DSH 插件收敛至 `DshBackendAdapter`；清理 `Assignment.sessionId` 旧命名；实现两套能力不同且故意返回相同 `backendSessionId` 的模拟适配器。 | 原有单节点配置无需改动即可启动并跑完独立工单与项目工单；两套模拟适配器会话 ID 相同但并发派工、插话、打断、停止和报告各自准确；不支持回合打断的模拟后端诚实降级报错。 |
| **F-2 · 接通双节点静态清单与选路** | 实现 `NodeRegistry`、主从分级启动（副节点离线不阻塞）、双层事件游标；接入快路由设备标签与高层路由连续原话复核选路；实现节点 `workspace-resolver` 与 `ArtifactRef`；控制台显示目标节点、后端、接收状态与产物摘要。 | 两张独立工单分别绑定模拟节点 A、B 并行执行，各自在不同模拟根目录写出验收文件并正确回报；副节点离线时控制面正常启动，显式指定离线副节点被明确拦截且不回退主节点；同单重试锁定原节点。 |
| **F-3 · 离线 Outbox、续期与对账** | 实现节点本地文件 `Outbox` 与控制面 `inbound_report_dedup`；落地跨断网 `token.exchange` 与三层代际校验；补齐离线 `stop_pending_ack` 对账与在线限定 `reconcile`。 | 断开 B 期间 A 正常工作；B 离线完成的报告持久化并在重连后仅产生一次可见状态更新；断网超期但有效的派工可续期交报告，错节点、错后端、撤权或过期派工回调一律被拒；离线停止在重连后自动闭环。 |
| **F-4 · 双 Windows 真机与合流验收** | 在两台专用 Windows 测试环境完成 6 项真机实测并留存脱敏证据；随后在临时集成工作树与最新 `next` 合并执行交叉回归。 | 6 项真机用例、单节点回滚检查及合流后的 `next` 全链路回归全部通过。 |

### 4.2 必须暂停并提交 ADR 的边界

低风险工程实现直接推进；仅当遇到以下情况时停下并提交包含 2 个以上候选方案的简明 ADR 请用户决策：
- 需要改变 Ticket/Project 所有权、放宽角色工具权限边界，或允许跨节点自动接替未确认停止的运行中工单。
- 需要引入跨设备文件自动覆盖同步或破坏单节点旧版 SQLite 数据兼容性的迁移。

---

## 5. 双 Windows 真机验收脚本与合流步骤

### 5.1 六项必测真机用例（F-4）

1. **双机并行与跨盘符产物核验**：在同一主窗口下发起两张独立工单（一张默认主节点 A，一张用自然语言点名机器 B），分别写入带随机标记的文本。现场核对文件确实落在 A、B 各自配置的工作区目录，主窗口刷新后仍能从各自工单查到报告、目标 `nodeId`、相对路径与 `sha256`。
2. **定向干预与隔离保护**：向机器 B 正在运行的 Worker 追加一句插话指令，并分别验证按回合中断（如后端支持）与停止操作，由 B 的实际后端回执确认；全过程中机器 A 的会话与工单不受干扰继续推进。
3. **回执丢失与断网 Outbox 补交**：在派工应答阶段断开机器 B，控制台如实显示送达未确认，重连查询原 Session 后再更新状态；另一张机器 B 工单在断链期间产生完成报告（含模拟超过常规 Token 宽限期的断网），网络恢复后从本地 `outbox/` 自动补交一次，重启控制面也能恢复原执行绑定。
4. **离线停止对账与同单禁换绑**：断开机器 B 期间，在控制台对 B 的运行中工单点击停止并尝试恢复或重派。确认界面维持 `stop_pending_ack`、拒绝未确认恢复且拒绝将该工单改派给机器 A；恢复 B 连接后自动完成停止确认。
5. **Router 主节点固定防冲突**：在主节点 A 重启原 Router 后端，确认原会话绑定可恢复；改用指向另一个后端实例的隔离测试配置启动控制面，确认启动立即显式报配置冲突，既有 Router 会话记录不被覆盖。
6. **单节点兼容与回滚**：使用升级前的单节点配置格式和部署前备份的数据副本启动单节点模式，验证独立工单、项目 PM 建单审阅、报告及历史工单读取均正常。

### 5.2 与 `next` 的集成工作树合并步骤

1. 双机真机验收通过后，从当时的 `next` 最新提交新建临时集成工作树（如 `git worktree add ../superagent-integ -b integ/multi-node-next next`），合并 `feat/multi-node`。
2. 将 `src/control/node-resolver.ts` 指向 `NodeRegistry` 多节点实现，核对两分支各自新增的独立模块与 SQLite 表无命名冲突。
3. 在同一份集成构建上复跑 `P3-Gate`、`next` 已落地的 Phase 4/5 测试套件及双机用例，确认无退化后快进合入 `next`。

---

## 6. 开工前确认项与每轮汇报模板

### 6.1 进入真机阶段（F-4）前需确认的环境信息（不阻塞 F-0 至 F-3 代码与模拟测试）

- 两台 Windows 的 Tailscale 连通情况及双向通信拟采用的 TLS 方式（Tailscale Serve 或现有 HTTPS 反代）。
- 两台机器各自挂载的真实后端实例，以及主节点首次绑定的 Router 后端实例。
- 两台机器用于隔离验收的工作区根目录与节点本地数据目录路径。

### 6.2 每轮任务交付回复模板

```text
[Branch / Task] feat/multi-node · <F-0 | F-1 | F-2 | F-3 | F-4>
[Base HEAD / Worktree] <sha> / <clean-or-dirty>
[Current status] INVESTIGATING | IMPLEMENTED_UNVERIFIED | TESTED_FAKE_ADAPTER | VERIFIED_TWO_WINDOWS | BLOCKED | DONE
[Seam check] <确认遵守 NodeResolver 签名、独立模块拆分、独立 SQLite 表名及 protocol.ts 尾部区块追加规则>
[What exists] <现有相关实现路径与行为证据>
[Change] <本轮确切修改与保持的关键不变量>
[Tests] <执行命令、通过/失败/跳过计数、是否双机真机验证>
[Evidence] <日志、测试文件或 .artifacts/ 脱敏证据真实路径>
[Risks] <遗留风险、兼容性与回滚说明>
[Commit/PR] <提交 SHA 或明确未提交>
[Next] <下一阶段最小任务>
[Needs human decision?] <仅触发 §4.2 边界时附 ADR 与唯一决策问题；否则 none>
```