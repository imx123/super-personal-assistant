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

## 6. P4-3 权限拒绝审查（实现口径）

权限拒绝只有一个来源：**守卫真正拒绝的那一次调用**。控制面工具入口与节点工具桥各是一个守卫点，两处都以结构化事实回报，绝不从模型输出、日志行、任意工具报错或不可信请求文本推断。四个原因码是全部： `ROLE_TOOL_DENIED`、`PROJECT_SCOPE_VIOLATION`、`MANDATE_EXCEEDED`、`WORKSPACE_OUT_OF_BOUNDS`。节点离线、可刷新的令牌过期、模型传错 JSON 参数、普通命令非零退出、网络超时、人工停机与 Worker 主动的 `blocked` 报告都不计入。

**双端判定顺序**：`RoleProfile.deny` 先于 `RoleProfile.tools`，被 deny 的名字即使在 allow 列表里也被拒绝；allow 列表之外的名字同样被拒绝。控制面按 Session 记录里的档案名取档案，档案未知即拒绝。节点侧除角色边界外还守工作区，但**只守后端自己守得住的那部分**：后端原生的文件沙箱拒绝了越界写入时，节点读它**结构化**的错误码（`FS_SANDBOX_DENIED`），按工具调用 id 把「调用」与「结果」配对，只在回合、Session、工具三者都对得上时以 `WORKSPACE_OUT_OF_BOUNDS` 上报。节点自己另守一条明确的规则：**改文件的工具**（`write`/`edit`）不得指向工作区的 Git 元数据；判定只看调用点名的路径分段是否含 `.git`，不看绝对路径、不做符号链接解析，也不声称能限制 shell。读工具照常，命令自身的输出、工具的报错文本与模型的话永远不变成安全事实；结果里没有结构化错误码的失败（参数写错的升级请求等）一律忽略。

**可信节点入口**：节点的 `guard.denial` 事件走节点已认证的通道，控制面另行核对来源节点/后端、Session、角色、Assignment 与**当前活动的回合**；迟到、异节点、异后端、代号不符、无回合或原因码不在四个之列的事实一律拒收，不计数。事件里的工具名、原因码与标识符在**落库与事件流之前**先被裁剪成安全字段：被拒调用的参数、路径与报错文本不进入日志。

**调用身份**：节点侧用后端给出的工具调用 id（后端不给时节点自己给这次工具调用起一个），控制面入口用调用方自己带来的 `x-superagent-call-id`（没有时由这次请求自己起一个）。两者都是**调用方可控**的原文，所以控制面一律再按「来源 Session + 生命周期代际」加命名空间：两个 Session 用同一个 id 是两次不同的调用，一个角色无法用同一个头压掉另一个角色的事实；命名空间来自控制面自己的记录，所以重启后重放仍是同一次调用，既不重复审计也不重复计数。没有身份的调用方也不会把五次调用折叠成一次：**每一次真实调用都逐条审计，熔断按真实调用次数计**。

**计数与升级**（`src/control/denial-escalator.ts`，落库 `permission_denial_counters`）：按 `(controlSessionId, ticketId, assignmentEpoch, managerTarget)` 在**滑动窗口**（默认 10 分钟）内统计**有效拒绝** —— 窗口始终覆盖该范围最近 10 分钟的历史，而不是从第一次拒绝起框定的固定窗口，所以滑动时旧数字不会整段清零。有效拒绝是「同一回合、同一工具、同一原因码」的一堵墙（同回合并发折算），但**每一次真实调用都逐条审计**。达到阈值（默认 3）生成一次 `system_denial_review`；审查的身份由**范围 + 窗口当前持有的那几堵墙**派生，所以再次撞同一堵墙不会生成第二次审查，而冷却锁（默认 10 分钟，有限且可配置）**跨窗口滑动继续有效**，两者一起防止唤醒风暴。

**失控熔断**：熔断按**同一回合内的原始拒绝次数**计（默认 5），与升级的语义折算分开，所以同一回合五次独立拒绝会触发一次打断，而同回合重复同一调用只算一次有效拒绝却仍能被熔断看见。熔断绑定**当前真实活动的回合**并以条件写认领，同一回合只打断一次；后续回合与其它回合不受影响。打的是回合打断，**不是整会话停机**：Session 的身份、权限与收件箱都不变。

**升级目标**：项目 Worker → 本项目 PM；独立工单 Worker → Router；PM → Router；Router → 操作员告警（控制台记录，无更上层 Agent）。升级记录与 Worker 主动的 `blocked` 报告分路，互不混写。

**送达的两段认领**：审查行先被**持久化认领**（`pending_manager_online` → `dispatching`）才允许上线路，认领是条件写，重试与并发恢复只有一个能拿到。发出前与线上前**各查一次**：来源 Session 仍然存在、未被撤权、未被人工停机、仍跑着同一个 Assignment、仍拥有它的 Project/工单、仍活在同一代；目标必须是「该 Project 现任 PM」或「Router」，角色与 Session 都要对上。任何一次 `await` 之后都重读目标与代际；**绝不恢复被停掉的上级**。已知未送达（离线、人工停机）的审查保持 `pending_manager_online`，等**那个上级被明确恢复**或**节点重新上线**时再送出，不会定时盲目重试。审查在途时控制面崩溃 → 结果未知（`unconfirmed`），**不再重发**。审查消息与控制台视图只带脱敏、有界的结构化元数据，不带原始参数、绝对路径、工具报错或凭据；审查的原因只存控制面自己的固定措辞，不存节点任意错误串（那里面可能有路径、任务输入或凭据）。

**持久化与恢复**：计数、逐条审计、有效拒绝与审查记录都写在控制面自己的库里。审查按它持有的那几堵墙认领，重启后不会二次唤醒；仍待上线的审查在有证据表明上级可达时按同一幂等键补送一次。

**审查消息里的任务上下文**：审查单除了标识符与原因码，还带一段**有界的、自有范围的受控投影**：Ticket 的阶段、Assignment 的阶段、本范围最近一次报告的类别、该 Ticket 的 review 状态、Project 的阶段。投影只读控制面自己的记录，只读**受治理的那一段**（该 Assignment 所属的 Ticket、该 Session 所属的 Project），**不读**标题、目标、note、路径、报告正文或任何模型/人的原话；没有自有 Ticket 的范围（PM、Router）如实写「无自有工单」，不借用别处的上下文。同一段投影也出现在控制台审查记录里。

**人工授权申请单（§3.2 的 (b) 出口）**：审查单明确告诉上级「可以改方案，或者向操作员申请显式授权」，但只有**真正能走完这条路**才算数：

- **工具**：新增窄口径工具 `control_request_authorization`，只带一个参数：审查 id。它同时挂在 PM 与 Router 的角色档案里（两个都是「直属上级」），Worker 没有。
- **证据来自已鉴权的调用方**：控制面按**调用方自己的 Session 记录**判定资格 —— 必须是该审查的**直接上级**（`review.targetSessionId` 与调用方 Session 相同、角色相同），必须**未被撤权、未被人工停机**，且该审查必须是其范围**当前**的那一次（被新审查取代的旧审查不算）。Worker、别的 PM、被停机或撤权的上级、乱写的审查 id 一律拒绝。**受治理的那条边必须还活着**：被拒的 Session 仍活在被拒时的那个 Assignment/代际里，上级仍是该工作的现任上级。
- **一条审查一张申请单**：申请单 id 由审查 id 派生，落库 `denial_authorization_applications`；重复请求读回同一张单（重试干净），不产生第二张。
- **零授权变化**：申请单只是把审查摆到操作员面前，**不授予任何权限、不改任何 Mandate、不改任何角色的工具表、不重放被拒的调用**。工具本身没有「批准」语义，操作员在控制台的「已知悉 / 不授权」也只是**一条记录**；真正变更 Mandate 或配置仍走操作员自己的既有路径。申请单不携带模型的原话，只带结构化事实（审查 id、范围、原因码、工具、窗口内次数）。

**PM Mandate 守卫（创建工单时）**：`src/core/engine.ts` 的 `prepareAllowTools` 里，「任务显式列出的 `allow_tools` 比 PM Mandate 更宽」原本与「参数写错」同属一类（都是 `invalidProjectTask`）。现在它有**类型化信号** `MandateExceededError`：对外仍是同一个 `invalidProjectTask` 错误体（同样的状态码与同样的文案），对内控制面按**已鉴权请求的调用 id** 记成一条 `MANDATE_EXCEEDED`。**未知工具、重复工具、不是数组、超长等畸形列表仍然只是普通无效任务，不计数**。

**节点侧的收窄 Mandate**：Ticket 的 Mandate 里的 `allowTools` 是 Worker 的委派边界，独立控制面原先**完全忽略**它（Worker 一律拿整份 `worker.v1` 档案）。现在控制面把该 Ticket 的**可信收窄名单**随 `worker.create` 一起交给节点（`RoleProfile.mandateTools`），节点在自己的角色守卫里**在执行前**据此拒绝：角色给了、但委派没给的工具按 `MANDATE_EXCEEDED` 拒绝并上报。委派不管辖的工具（Session 自己的 `control_report` 等）照常可用，与旧插件的 `workOnly` 语义一致。被收窄的工具**仍然对模型可见**——拒绝本身就是控制面要计数与升级的事实，工具直接消失会把事实藏起来。

## 7. 合流与验收

- `next` 新增逻辑位于独立模块，控制面保持薄委托。Phase 4 使用 `coordination_deliveries`、`session_stream_subscriptions`、`permission_denial_counters`（连同 `permission_denial_calls`、`permission_denial_effective`、`permission_denial_reviews`）和 `external_event_subscriptions`，独立于跨设备的绑定与节点回传去重表。新增记录预留 `node_id`、`backend_id`，协议在 `COORDINATION & MEMORY V1` 尾部区块追加。
- P4-1 验证双 Worker 报告及重启不重复验收。P4-3 验证真实拒绝、冷却与按回合熔断。P4-2 验证程序化单路摘要及水位线。P4-4 验证三种模式及合成事件链路。P4-5 用故障注入验证未发送、已入箱及无回执的恢复分支。
- P4-3 已落地：`src/control/denial-escalator.ts` 与 `permission_denial_counters`（连同逐条审计表 `permission_denial_calls`、有效拒绝表 `permission_denial_effective`、审查表 `permission_denial_reviews` 与人工授权申请单表 `denial_authorization_applications`），控制面工具入口与节点工具桥双端守卫，`RoleProfile.deny` 先于 `allow` 的判定顺序，节点侧 `guard.denial` 结构化事件、后端原生 `FS_SANDBOX_DENIED` 的配对上报与改文件工具的 Git 元数据边界，协议尾部追加 `GUARD_DENIAL_REASON_CODES` 与 `GuardDenialFacts`。审查单带自有范围的受控任务上下文投影；PM/Router 可用窄口径工具 `control_request_authorization` 就一次审查发起人工授权申请单（一条审查一张、资格取自已鉴权调用方、零授权变化），操作员在控制台用既有鉴权记录一条决定。创建工单时超出 PM Mandate 的 `allow_tools` 有类型化信号（`MandateExceededError`）并按已鉴权请求 id 记为 `MANDATE_EXCEEDED`，畸形列表不计数；节点侧按 Ticket Mandate 的可信收窄名单在执行前拒绝并分类为 `MANDATE_EXCEEDED`。2026-11-18 已由 Codex 完成真实 DSH 与 Edge 验收，记录见 Phase 3–5 执行日志的 P4-3 节。
- P4-2 已落地：`src/control/stream-subscriptions.ts` 与落库表 `session_stream_subscriptions`。**管辖权只向下**：Router 可订阅活跃 PM 或独立工单当前有效 Worker，PM 只可订阅本项目当前有效 Worker，Worker 无此工具；跨 Project 是**类型化越权拒绝**（走 P4-3 的 `PROJECT_SCOPE_VIOLATION` 管道），而未知、换代、异节点、被停机或被撤权的目标一律按**同一种措辞**拒绝，不透露存在性、也不计入拒绝计数。**订阅者身份只来自 Session token**，请求体没有订阅者字段。**零 LLM**：聚合是控制面自己事件日志的一段纯程序化读取——状态与最新回合号、工具名与成功/失败计数、**可归属于该 Session 自身工作区的成功改动相对路径**、最新模型输出尾部 ≤300 字符，全部有界；工具事实来自节点新增的 `tool.fact` 事件（节点把后端 `tool/call` 与 `tool/result` 按调用 id 配对后才上报，只带工具名、成败、调用 id 与工作区相对路径，入参与输出永不上报；真实 DSH 的 `arguments` 是一段序列化 JSON，节点只解析**有界的对象文本**、只读路径键）。**隔离**：控制面在**入口**核对 `tool.fact` 的来源节点、被指名 Session 的**当下角色、Assignment 与有效 Project**，并**重新构造**窄信封与窄事实，异节点、异角色、异 Assignment 的事实进不了日志；聚合时每一行还要对上**来源节点、角色与 Assignment**，旧行、异节点行与异 Assignment 行**一律不引用**。**投递**在 ensure 之前与紧贴传输前各重查一次（订阅状态、下级仍是同一条 Assignment、订阅者仍是管辖者、收件人仍可送达、解析出的就是订阅者自己），**已知过期就连 ensure 都不做**；解析抛错只结清这一条的认领，定时器照常挂上。**水位线** `last_pushed_seq` 只在摘要真正送达时推进；回执丢失记 `unconfirmed` 并同样推进（可能已到达，绝不重发），控制面重启时在途摘要按未确认恢复；节点拒绝或不可达则水位线不动，下个周期把积压**合并成一份**最新摘要。无增量的区间静默跳过，重复订阅是**无害幂等**（水位线不动，只允许改间隔，新间隔自下一个到期时刻起生效），退订立即生效且在途摘要不发。子会话结束、被人工停止、被撤权或换代使订阅 `terminal`，继任者不继承。摘要正文按不可信数据封装（去控制字符、脱敏凭据与绝对路径、围栏引用），保留「这是系统事实、不授予任何权限」的信封；整条消息**按预算拼装**（清单各自分额，围栏与末尾的会话详情引用完整保留），控制台只展示范围、状态，并给出直接打开该会话详情页的按钮。
- 旧单节点配置和历史数据继续可读。Phase 4 验收前使用隔离副本核对旧插件、Scheduler 和 Phase 3 自动交接。合流后的双 Windows 验收由跨设备负责人执行，集成版本还需复跑已有主线回归。
