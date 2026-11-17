# P3-1A：操作员停止会话的作用域与持久防复活

2026-11-17。本任务只做 **P3-1A**：停 PM/Router Session、停 Worker Assignment、取消 Ticket 的作用域、持久防复活与上级通知。回合中断、Router 插话和前端属于 **P3-1B**，Fast Router 属于 P3-2。

## 1. 三种停止，三个作用域

| 动作 | 入口 | 作用域 | 不受影响 |
| --- | --- | --- | --- |
| 停 Session | `POST /v1/console/sessions/:id/cancel`（PM / Router） | 只停那个 Session | 项目状态、项目工单、项目的其他 Worker、PM Mandate、工单归属 |
| 停 Assignment | `POST /v1/console/assignments/:assignmentId/stop` | 只结束那一个 Assignment | 工单本身（仍开着、Mandate 不变）、同一项目的其他 Worker |
| 取消 Ticket | `POST /v1/console/tickets/:ticketId/cancel` | 结束整个工单 | 同一项目的其他工单与 Worker |

三条硬约束：

1. **停 PM Session 不等于停 Project。** 它不调用 `Engine.stopProject`，也不调用 `pauseProject(hard)`。项目的 `status`、工单、派工和其他 Worker 一律不动。
2. **停 Router Session 不改任何已有工单或 PM Mandate。** 它连领域都不写。
3. **停不是撤权。** 被停的 Session 保留角色、项目、Assignment 和权限边界；它的所有权不转移。只有**显式恢复**能解除停止，恢复时轮换凭据（见第 4 节）。

对 Worker，`POST /v1/console/sessions/:id/cancel` 仍然可用，语义与「停 Assignment」一致（工单保持开着）：两个入口共用同一段代码，停止状态只写一份（Session 记录上的标记、工单上的 `worker` 停止、领域的开放停止事实）。差别只有一处：Session 入口对**已被替换**的 Assignment 仍然只停掉节点上遗留的那个 Session，而 Assignment 入口直接拒绝（409）。这是相对 P3-0 的一处**有意语义变更**：此前该路由在项目工单上写的是 `project` 作用域的停止，PM 可以自行 revive；现在改为 `worker` 作用域，**只有人**能批准恢复。

## 2. 持久防复活

停止的事实写在 Session 记录上（`SessionRecord.operatorStop`，随领域 KV 一起持久化），控制面在所有可能「把它带回来」的口径上读它：

| 口径 | 行为 |
| --- | --- |
| `ensureRouter` / `openProject`（PM）/ `createAssignmentWorker`（Worker） | 409 / `SessionEnsureError`：被停的 Session 不再 ensure |
| `sendMessage`（底层消息口） | 拒绝。**这是低层复活缺口所在**：操作者停掉的 Worker 原来仍能被 `createWorkerSession` 重新创建，现在被这里和 `createAssignmentWorker` 一起挡住 |
| 角色工具路由 | `verifyToolToken` 拒绝（403） |
| 令牌刷新 | `refreshToolToken` 拒绝（403）。刷新是唯一还认上一代 token 的路由，必须显式关掉 |
| 定时任务 | `deliverSchedule` 判失败并说明「PM Session 被操作员停止」，不唤醒 |
| 自动报告 | `sendPmWakeUp` → `sendMessage` 拒绝，记为 `failed` |
| 节点代次变化 / SSE 重连 | 代次只影响 ensure，而 ensure 已被挡住 |
| 迟到 idle | 迟到状态不撤销 `operatorStop`，Session 仍然不可用 |
| 节点或控制面重启 | `loadSessions` 读回 `operatorStop`，重启后同样挡住 |
| 角色工具 / 刷新绕过 | `verifyToolToken`、`refreshToolToken` 都读标记 |

**Worker 的权威是工单，不是 Session 记录**：`SessionRecord.operatorStop` 只知道控制面见过什么，而一个还没起 Session 就被人停掉的 Assignment 根本没有记录。因此 `createAssignmentWorker`、`sendMessage` 和 re-ensure 都按 ticket/assignment 的绑定去读域里的事实：工单已结束、Assignment 已被替换或已结束、工单上有 `manualStop`、`stopPending` 或 `stopFailure`——任何一条都拒绝重建这个 Worker。没有域记录的 Assignment（名义入口与旧协议测试）照旧放行。

**并发关口**：`ensure` 与 `stop` 同时到达时，停止先写标记，再问节点。仍在飞行中的 `ensure` 结束后会再查一次标记（`enforceOperatorStop`）：它再发一次 cancel，然后以 409 失败，而不是交回一个被人停掉的 Session。已确认记录的快路径和 `confirmExisting` 也走同一道关口。

**停止与恢复串行**：同一个 Session 的停止和恢复在一条队列上，恢复要等停止落定。停止在创建还挂起时会重复一次 cancel；恢复一旦发生，那次重复的 cancel 作废（恢复会推进 Session 的代次），恢复后的 Session 不会被晚到的 cancel 停掉。恢复之前的一批终态状态上报同样作废。

**被替换的会话**：停 Assignment 只接受该工单**当前**的 Assignment；已被替换的 Assignment 返回 409，不会停掉接替它的 Worker。

## 3. 未确认的停止

节点拒收、超时或回执丢失时：

- 回答里的 `cancelled`/`stopped` 是 **false**，`confirmed` 也是 **false**，并带 `error`；控制台不会显示成「已停止」。
- `operatorStop.state` 停在 `requested`，保留操作者意图与诊断，可对账、可重试。
- 只有**节点确认**（cancel 命令被应答，或节点报出 `stopped`/`archived` 状态）才写 `confirmed`。回执本身就是确认：节点把 cancel 收下之后可能仍然把那个 Session 显示成 `idle`（DSH 会留着它的 Agent），但**标记**说了算，Session 依旧不可用，直到有人显式恢复。
- 被停的 Session 在未确认期间同样不可用：意图由人给出，不由节点给出。
- 再停一次会重新问节点；这次节点确认了，领域自己的完成态原语会清掉 `stopPending` 与 `stopFailure`，工单才可以恢复。

## 4. 恢复

恢复是**操作员权限的单独动作**，与停止分开：

| 入口 | 作用 |
| --- | --- |
| `POST /v1/console/sessions/:id/resume` | 解除 PM / Router Session 的停止，轮换凭据后重新 ensure（同一个 Session id） |
| `POST /v1/console/tickets/:ticketId/resume` | 清除工单上**人**的 `worker` 停止标记，让 PM 可以申请新的 Assignment；**不启动任何 Worker** |

- 恢复时 `tokenVersion += 2`：停止期间流通的那个 token（以及宽限刷新）恢复后一律无效。
- 恢复不改变角色、项目、Assignment 和权限边界。
- 被**撤权**的 Session 不可恢复（409）：撤权是终局。
- 项目已结束或已归档时，它的 PM Session 不可恢复（409）。
- **只有节点确认过的停止才可以恢复**（409）：节点拒收或没回执的停止意味着那个 Worker 可能还在跑，新的 Assignment 不能压上去。操作员再停一次，等节点确认了再恢复。
- 恢复失败（节点起不来这个 Session）时，停止标记原样留下，接口不回报「已恢复」；Session 仍然是停的。
- Worker 的停止未获节点确认时不允许恢复（409）：旧 Worker 可能还在跑，新的 Assignment 不能压上去。
- PM 不能解除人的停止：领域里 `worker` 作用域的停止只有 `allowResume`（人）能清，`revive` 和自动重试都会拒绝。
- 工单的恢复与停止共用工单自己的队列：恢复不会清掉一个还在确认中的停止。

## 5. 上级通知

每次停止都会给**逻辑上级**留一条持久通知（`stop_notice` 表，在控制台自己的文件里，跨重启可查）：

| 被停的 | 上级 |
| --- | --- |
| 项目里的 Worker | 该项目的 PM |
| 独立工单的 Worker | Router |
| PM Session | Router |
| Router Session | 操作员（它上面没有会话） |

通知内容：目标、作用域、影响（`affected`）、**未受影响的子任务**（`unaffected`）、操作人和时间。正文只带被停工作所属那一个 Project 的 id，不带别的项目数据。

读取方式：`GET /v1/console/stops`（可按 `superiorKind`/`superiorId`/`projectId` 过滤）、PM 自己的 `GET /v1/tools/pm/context` 的 `stops` 字段、Router 的 `GET /v1/console/router` 的 `stops` 字段。

## 6. 兼容性

- 底层路由 `POST /v1/sessions/:id/cancel` 语义不变：只在节点上停掉那个 Session，不终结项目、不写领域。
- 老控制台路由仍在原处；新增路由是**新增**的，不替换任何一条。
- 旧插件与领域 Schema 不变：`SessionRecord` 只多了一个可选字段，`stop_notice` 在控制台自己的 SQLite 文件里，`Tickets.stopAssignment` / `Engine.stopAssignment` 只多了可选参数。
- 域名的 `Engine.stopProject`、`pauseProject(hard)` 仍只由项目自己的生命周期动作调用。

## 7. P3-1B 的接线合同

P3-1B 需要的前端与协议接口，后端已经备好：

| 需要的能力 | 现成的接口 |
| --- | --- |
| 列出 PM / Router / Worker 并显示停止状态 | `GET /v1/sessions`（`ConsoleSession` 带 `operatorStop`）、`GET /v1/console/stops` 的 `sessions` |
| 停一个 PM / Router | `POST /v1/console/sessions/:id/cancel`（回答含 `scope`、`confirmed`、`error`） |
| 停一个 Assignment / 取消一个 Ticket | `POST /v1/console/assignments/:id/stop`、`POST /v1/console/tickets/:id/cancel` |
| 恢复 | `POST /v1/console/sessions/:id/resume`、`POST /v1/console/tickets/:id/resume` |
| 显示「排队 / 已发送 / 已确认 / 未确认 / 失败」 | 停止回答里的 `stopped` 与 `confirmed` 是两件事：前者是这次请求的结果，后者是节点确认过 |
| 回合中断、Router 插话 | **尚未实现**，留给 P3-1B：节点协议仍只有 `session.cancel`，没有只打断当前回合的指令 |

## 8. 验证

本轮 47 个定向测试文件通过，605 项通过、1 项因 Windows 沙箱的目录联接限制跳过。类型检查和构建通过。停止拒绝、回执丢失和重启场景由隔离测试覆盖。

DSH Desktop 0.2.2.0 加载 `dsh-superagent/node`，在隔离 profile 上通过本机 Gemma 4 12B 运行 PM 与两个 Worker。节点确认停止 PM 后，项目和两个派工均保留；明确恢复后，同一 PM 接收消息并开始新回合。该回合因模型达到输出上限结束。浏览器操作和回合中断留在 P3-1B 验收。
