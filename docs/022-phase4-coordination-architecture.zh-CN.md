# Phase 4 协作事件与执行目标解析

2026-11-18，P4-0 评审稿。适用于 `next` 的独立控制面与现有单 DSH 节点。设计依据是 `docs/roadmap/` 中的 `NEXT_MAINLINE_PLAN_v1.1.md`、`NEXT_PHASE4_SUPPLEMENT_v1.0.md` 和 `MULTI_NODE_PLAN_v1.1.md` 的共享接口约定。Phase 3 业务验收版本是 `b2ff528`，阶段签收记录是 `23b97db`。

## 1. 通信机制与权威数据

| 机制 | 现有入口与权威记录 | Phase 4 交付及生命周期 |
| --- | --- | --- |
| 旧插件线程订阅 | `/orchestrator/api`；Source 经 Intake 写入 Trigger，`Thread.subscriptions` 关联 Ticket。 | 继续由旧插件独立持有；原 Thread 跟随、脱离、归档语义照常生效。 |
| 协调报告与已授权交接 | 独立控制面写 Ticket、Assignment 和 Review，再由 `notifyOwnerOfReport` / `sendPmWakeUp` 通知。已有 `router_handoff` 记录、路由队列、定时计划和显式 Relay Proposal 各有入口。 | `report-coordinator.ts` 按业务归属投递。项目 Worker 的直接上级为本项目 PM，独立 Worker 的直接上级为 Router，PM 只上报项目级进展和阻塞。Scheduler 继续要求 PM 已启动。Relay Proposal 只在有效人工确认后产生投递。 |
| 下级信息流摘要 | 独立控制台事件日志已有控制面序号和节点序号。 | `stream-subscriptions.ts` 以 `last_pushed_seq` 聚合合法下属的增量事实。默认关闭，无增量静默跳过。停止、结单、换派或撤权后停推。重连只生成一份有界摘要。 |
| 外部观察事件订阅 | 独立控制面新增来源、事件类型、条件、订阅及匹配结果。 | `event-subscriptions.ts` 绑定创建者、目标、租约与配额。默认按确定性条件匹配后直达，生命周期与用户指令、Scheduler、内部报告和旧插件 Thread 独立。 |

权限审查是独立系统通知。P4-3 从控制面及节点工具桥的权威拒绝点采集结构化事实，四种可计数原因由补充规范定义。同回合同一工具与原因只计算一次，保留原始审计。用户停机与普通运行故障分别记录。项目 Worker 升级到 PM，独立 Worker 和 PM 升级到 Router，Router 升级到操作员；拒绝仍有效，审查只能在原权限内处置或申请人工授权。熔断须绑定触发拒绝的活动回合。

## 2. 执行目标与代际

共享类型以 [`node-resolver.ts`](../src/control/node-resolver.ts) 为准。P4-0 只交付类型，P4-1 从现有单节点状态解析 `nodeId` 与后端 `dsh`；之后多节点集成可委托注册表。目标来自控制面的精确记录与归属，缺失、离线或不匹配时保留原目标并记录原因。

| 代际 | 当前数据与首版校验 |
| --- | --- |
| `nodeTrustEpoch` | 现有 `nodeGeneration` 是用于会话确认的 UUID。数值代际须关联此次注册或重连信任和后端身份；进程重启后若无法证明旧连接连续性，只通过重新检查原目标及其回执恢复可信事实。 |
| `assignmentEpoch` | Worker 以 Ticket 当前 Assignment 和受管会话索引为权威，Router、PM 以同一会话的生命周期为权威。换派或重新建立生命周期须使旧命令失效，回合干预另核对 `turnId`。旧记录兼容推导必须依赖可证明的身份，代际无法核实时返回 `STALE_GENERATION`。 |
| `toolTokenVersion` | 现有会话行持久化 `tokenVersion`。正常刷新只更换凭证；新调用检查当前版本，现有刷新宽限仅用于刷新入口。撤权与人工停机仍以持久状态为准。 |

解析结果是调用当时的快照。会话命令使用 `resolveForSession`，Worker 派工和回传使用 `resolveForAssignment`。操作本身的授权由控制面从发起者和业务对象重新求值。显式恢复沿用原权限与已确认停止门禁；报告、订阅和重试均不调用恢复。Review diff 和归档继续各自执行原有授权与作用域检查，接入既有会话或派工解析入口，无需扩充共享签名。

## 3. 五条路径的四个核验时点

| 路径 | 首次入队或发送前 | `ensure` 返回后及发送前 | 重试、重连或重启前 | 节点回传或工具调用 |
| --- | --- | --- | --- | --- |
| 派工、追加指令 | 校验 Ticket 所有权、Mandate、当前 Assignment 和工作区绑定，保存稳定幂等键。 | 重读 Ticket、Assignment、目标 Worker、项目状态与人工停止标记，核对执行绑定和代际。 | 重查原 Assignment、授权及证据，已换派的消息结束处理。 | 匹配命令键、节点、后端、Session 和 Assignment，再应用启动、终态或追加指令回执。 |
| 会话命令与干预 | 按角色验证目标和具体命令。打断记录活动回合，显式恢复检查已确认停止。 | 重查会话生命周期和撤权。打断前确认仍是同一活动回合。 | 只对原会话及原操作对账，未知回执以可核验状态记录。 | 核对受管会话、操作和回合；迟到回执不可改写新回合或后来恢复的会话。 |
| 报告、摘要、拒绝审查与定时投递 | 根据 Ticket、Assignment、Review 或 Project 确认合法上级。摘要核对直属关系及订阅，计划仍要求目标 PM 已启动。 | 重查来源和目标、Review 轮次、项目状态、订阅或计划有效性，确认后发送。 | 重查权限、当前轮次、租约和计划，重启不补发已经处理的验收或摘要。 | Ticket 报告入库前绑定来源与当前 Assignment；上级的入箱或实际消费回执单独更新投递记录。 |
| 外部事件唤醒 | 验证外部来源、订阅权限、租约、限流和幂等键，固定投递模式与目标。 | 重查目标及创建者的授权。直达模式确认精确会话或 Assignment；操作员显式选双层路由时只进入原 Router。 | 过期、撤权、换派终止；目标人工停止或项目硬暂停时记录阻断。 | 校验目标绑定及命令身份，再确认入箱；外部载荷本身不具备发用户指令或授予权限的权威。 |
| 节点回传与恢复 | 记录命令的控制会话、执行绑定、适用代际及关联对象。 | 重新从权威记录解析目标；若执行后端或生命周期改变，丢弃迟到的 ensure 结果。 | 对原节点及后端重新确认；无法辨明发送结果时保留未确认。 | 先认证连接或会话凭证，再核对节点、后端、受管身份、操作和代际。旧协议无法证明来源时只接收可归因事实。 |

Worker 报告沿用当前业务流程。`ready` 是节点工具现有协议里的待验收结果，仍须按当前 Review 规则处理。已完成、失败、丢弃和阻塞属于即时通知，常规进展节流。稳定去重键包含 Ticket、Assignment、Review 轮次、报告类别和内容摘要；报告与待投递记录在同一控制库事务中提交，正文作为隔离的引用数据。审核通过的项目工单和可直接完成的独立工单各自维持原有终态语义。

## 4. 失败、回执与恢复

| 错误或状态 | 记录口径 |
| --- | --- |
| `TARGET_NOT_FOUND` / `OWNERSHIP_MISMATCH` | 原目标缺失，或现有节点、后端、会话、项目及派工的归属不符。记录原目标和可公开原因。 |
| `STALE_GENERATION` / `PERMISSION_REVOKED` | 原生命周期已失效，或当前权限、Mandate、订阅租约失效。记录具体原因并终止原投递。 |
| `MANUALLY_STOPPED` | 权威停止状态仍有效，保留阻断事实。项目硬暂停和会话人工停机保持各自语义。 |
| `NODE_OFFLINE` / `BACKEND_UNAVAILABLE` | 原节点离线或原后端不可用，仍保留既定目标。暂停也不能证明旧请求是否曾送达。 |
| `DELIVERY_UNCONFIRMED` | 已尝试发送但缺接收证据。它属于投递结果，保留在持久待发箱和控制台，独立于解析错误码。 |

`coordination_deliveries` 独立于控制台事件日志，保存目标与来源、幂等键、代际、尝试次数、授权条件和消息到期时间。确认过的节点入箱为 `delivered_inbox`，有后端消费证据才标记 `consumed_turn`。重启时先重验当前授权及代际，再按发送阶段处理。确证尚未发送且仍有效的记录可用同一键补交。发送尝试中断后需按键查原节点的接收证据；查不到则标记 `unconfirmed`，仅在节点明确证明未接收、授权仍有效时受控补发一次。旧 Relay Proposal 在未确认、已过期或目标失效时不产生可重试记录。

投递状态本身也是一套受限词汇：`accepted_pending`、`dispatching`、`delivered_inbox`、`consumed_turn`、`unconfirmed`、`blocked_target_inactive`、`blocked_node_unavailable`、`rejected_stale_or_revoked`、`failed_permanent`、`superseded`、`deferred_for_resume`。其中 `superseded` 记录“这条进展已被更新的报告取代”——终态报告到达时，尚未发出的旧进展就地作废，绝不晚于终态送达。`deferred_for_resume` 记录“这条唤醒在等待项目恢复”：报告作出时项目仍在运行，但 Project 在投递送出前被软暂停，唤醒随记录保留，恢复后以同一幂等键补送；硬暂停、结束与撤权仍是 `blocked_target_inactive` 或 `rejected_stale_or_revoked`，不等待恢复。相同语义身份（工单、Assignment、验收轮次、报告类别、内容摘要）只允许存在一条仍然打开的投递记录，这一唯一性由表自身保证，重启后依然成立；`unconfirmed` 属于“仍然打开”，所以一条“已尝试但无回执”的报告不会被同内容的新调用再发一次。控制台通过 `GET /v1/console/coordination/deliveries` 读取这些状态，只看投递事实（目标、状态、节点、原因），不返回报告正文。

## 5. 外部事件投递模式

| 模式 | 创建权限与目标 |
| --- | --- |
| `direct_initiator` | Agent 自建默认直达自身。Worker 只可针对自己的当前 Assignment 创建订阅。 |
| `direct_designated` | 操作员手动建立订阅的默认模式。Router 可指定活跃 PM 或自己管辖的独立 Worker，PM 可指定本项目当前 Worker。直达按原受管会话或派工身份解析。 |
| `dual_layer_router` | 仅操作员手动且显式选择。匹配事件进入主 Router，采用更严格限流；外部载荷保留非用户指令的来源属性，既有用户授权和原话复核仍生效。 |

标准匹配使用确定性条件与安全正则。可选语义条件仅允许操作员在手动低频订阅中显式配置，并要求确定性前置过滤、无工具只读评估和明确配额，降级时记录 `semantic_eval_degraded`。合成事件验收覆盖授权、重复去重、过期、限流、输入封装与正文中伪造指令。直达的失效目标不触发自动重路由、建 Project 或会话恢复。

## 6. 合流与验收

- `next` 新增逻辑位于独立模块，控制面保持薄委托。Phase 4 使用 `coordination_deliveries`、`session_stream_subscriptions`、`permission_denial_counters` 和 `external_event_subscriptions`，独立于跨设备的绑定与节点回传去重表。新增记录预留 `node_id`、`backend_id`，协议在 `COORDINATION & MEMORY V1` 尾部区块追加。
- P4-1 验证双 Worker 报告及重启不重复验收。P4-3 验证真实拒绝、冷却与按回合熔断。P4-2 验证程序化单路摘要及水位线。P4-4 验证三种模式及合成事件链路。P4-5 用故障注入验证未发送、已入箱及无回执的恢复分支。
- 旧单节点配置和历史数据继续可读。Phase 4 验收前使用隔离副本核对旧插件、Scheduler 和 Phase 3 自动交接。合流后的双 Windows 验收由跨设备负责人执行，集成版本还需复跑已有主线回归。
