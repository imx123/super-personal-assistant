# Phase 3 基线

2026-11-17。基线为 `6875ef9215e199b7d17682baaf28fda54ce25c60`，与任务书 v1.1 一致。后续工作在 `next` 按任务独立提交。旧插件的历史 P3 使用另一套阶段编号。

## 已复验与历史记录

| 检查 | 本轮结果 |
| --- | --- |
| `node ./node_modules/typescript/bin/tsc --noEmit` | 通过 |
| `pnpm build` | Corepack 缓存路径报 `ENOENT` |
| `node ./node_modules/tsdown/dist/run.mjs` | 同一构建入口通过 |
| Vitest 定向回归 | 12 文件，198 通过、1 跳过。Windows 沙箱不支持目录联接，跳过工作区联接测试 |
| 补充详细输出 | 重跑主组的 9 个文件时，Router 的 3 项测试因临时端口触发 fetch 的 `bad port` 失败。随后单跑 Router 18 项全过 |

定向回归使用 `node ./node_modules/vitest/vitest.mjs run --maxWorkers=1`，文件为 `tests/{docs,package,control-plane-router,console-message-routing,console-project-pause,control-plane-operator-routes,control-plane-recovery,control-plane-e2e,dsh-port,node-plugin,delivery,control-plane-scheduler}.spec.ts`。本轮未跑全量或真实模型。[交接中的两次历史验收](../../project_handoff.md)记录了 `afa1001` 的 483 项定向测试及更早的 DSH Desktop 0.2.2.0、隔离 `phase5`、`dsh-superagent/node`、`opencode-go/deepseek-v4.1-flash` 实测。

## 当前能力与还缺的部分

以下是基于源码的核对。真实 DSH 的新交互留给 P3-1 验证。

| 范围 | 基线 |
| --- | --- |
| 权威写入 | 独立控制面的 `ControlPlane`、`Engine` 与 SQLite 管 Project、Ticket、Assignment、Mandate。DSH 节点负责会话执行与事件回报。旧插件共享领域代码，使用自己的运行时和状态 |
| Router | `ensureRouter` 维护一个 `router.v1` 会话。`routerDispatch` 已可由模型通过工具自动派独立工单。Fast Router、独立高层升级路径和四条件自动建项目规则缺失 |
| 交接 | `routerPmProposal` 记待确认提议，`confirmRouterProposal` 才投递。常规 Router→PM 的默认自动投递、目标和回执展示缺失 |
| 报告 | Worker 的项目工单报告写回工单并通知 PM，独立工单报告回到 Router。PM 调用 `control_project_report` 后，控制面自动尝试唤醒 Router。暂停期间待验收通知已有持久记录，普通通知状态仍在内存 |
| 会话干预 | 控制台会话页筛掉 Router，只能在首页发消息。PM 能直接收消息，但 `stopSessionByOperator` 为防止误结束项目明确拒绝停止 PM，也拒绝 Router。Worker 会话消息绑定当前 Assignment 并核对回执 |
| 续接风险 | 底层消息或 ensure 入口没有统一读取人工停止标记。真实节点 cancel 后 Agent 可以回到 idle，进程内 `stoppingSessions` 无法跨重启约束旧 Session。P3-1 需用重启和并发测试确认并关闭缺口 |
| 任务与记忆 | 定时计划只向已有 PM 发送消息。独立控制面未接外部观察事件订阅。项目备忘与有限留存的 Console Event Log 已存在，长期记忆服务、持久工单历史索引和 RAG 缺失 |
| 工作区 | 单节点内同一项目的 Worker 共用目录，PM 看到目录快照 diff。并行同文件写入和单 Assignment 归因留待 P3-4 隔离实验 |

入口见 [控制面](../../src/control/control-plane.ts)、[HTTP 路由](../../src/control/server.ts)、[角色配置](../../src/control/roles.ts)、[控制台](../../src/console/pages.tsx)、[领域状态](../../src/core/model.ts)、[调度](../../src/control/scheduler.ts)、[控制台存储](../../src/control/console-store.ts)。

## 停止作用域与状态转换

| 基线操作 | 作用域与持久事实 |
| --- | --- |
| `POST /v1/sessions/:id/cancel` | 节点单会话取消。真实 DSH host 会清理后台工作并取消当前活动，等待结束。它本身不写 Ticket 或 Project |
| `POST /v1/console/sessions/:id/cancel` | PM、Router 返回 409。Worker 走对应工单的领域停止和节点确认。现有独立工单路径调用 `stopTicket`，P3-1 要明确区分停 Assignment 与取消工单 |
| `POST /v1/console/projects/:id/pause` | Project active ↔ paused。软暂停保留执行，硬暂停逐个停 Worker 并记录 project 作用域标记。未确认项在 failures 中返回 |
| `POST /v1/console/projects/:id/stop` | Project → ended，并结束其未结束工单及派工，等待 Worker 清理 |
| `POST /v1/console/projects/:id/archive` | Project 与工单归档，停止有关派工，保留 PM 会话以便取消归档 |
| `POST /v1/console/sessions/:id/archive` | 单会话归档。项目 PM 受项目状态校验，Worker 受 Assignment 状态校验 |
| `POST /v1/console/sessions/:id/revoke` | 持久化单会话撤权并淘汰令牌，再尝试停止。与可明确恢复的普通停止分开 |
| `POST /v1/console/reconcile/run` | 清理领域工作已结束但节点仍存活的残留会话 |
| Agent 工具 | PM `control_cancel_worker` 限本项目和当前 Assignment。PM 接受验收会结束对应工单。Router `control_router_manage(stop_ticket)` 限独立工单 |

Session 的 starting、idle、running、stopped、archived、failed 是节点运行结果；停止请求和确认失败须另有记录。Assignment 从 pending 到 running 或 ended。Ticket 对应多次 Assignment，重派需确认旧执行停止。人工停止标记不能由恢复项目的操作清除。Project 的暂停、结束和归档走各自入口。

[节点协议](../../src/shared/protocol.ts)目前只有 `session.cancel`，没有只打断当前回合的指令。真实 [DSH host](../../src/node/dsh-port-host.ts)的全会话停止还会清理后台活动，不能直接复用为纯回合中断。DSH `followup` 入下一轮队列，节点收件箱确认与回合消费是两个事件。确认中断要有当前回合结束的证据，不能把 `whenIdle` 单独视为原回合确认，因为它也会等待已排队的新回合。

## 权限矩阵

| 角色 | 范围 |
| --- | --- |
| 控制台操作者 | 使用控制面密钥。可在控制台执行已授权管理动作，动作仍执行工具归属和当前派工校验 |
| 查看者 | 只读凭据，写操作返回 403 |
| Router | 固定会话和角色令牌。管理独立工单及项目级委派，不继承 PM 或 Worker 的执行权限 |
| PM | 会话令牌绑定项目。管理本项目工单、派工、验收和项目级报告 |
| Worker | 会话令牌绑定 Assignment，报告只回当前有效工单及派工 |
| Node | 注册、接收命令与回报会话事实，不写业务权威状态 |

[原插件权限说明](../002-authorization.md)记录旧入口的 Source 与 Mandate，不能当成独立控制面已接线的证据。新增操作者动作也须保留服务端校验、角色工具约束、token 与节点代次校验。

## Phase 3 实施顺序

```text
P3-0 基线 → P3-1 会话干预 → P3-2 快路由 → P3-3 高层路由和交接 → P3-Gate
     └────────────── P3-4 隔离工作区实验 ────────────────────┘
```

1. P3-1A。先用 [控制面](../../src/control/control-plane.ts)、[领域 Engine](../../src/core/engine.ts) 和 [操作员测试](../../tests/control-plane-operator-routes.spec.ts)锁定人工停止的作用域。分开持久的 Session 停止状态、停 Assignment、取消 Ticket。停止 PM 只影响 PM 本身，停止 Router 只影响 Router；现有项目、工单、授权和其他 Worker 继续。记录上级可查的持久停止通知。仅由人明确恢复，恢复前不许 ensure、发消息、刷新令牌或重连自动启动。保留旧路由的兼容语义。
2. P3-1B。在协议、FakeNode、DSH host、控制面及前端接回合中断与插话。Router 忙时仍能随时提交，普通插话按顺序在当前回合结束后自动发送。显式「中断并插话」是另一个动作。控制台列出 Router、PM、Worker，显示排队、节点接收及失败状态。检查附件、模型选择、刷新重连、旧 Assignment 和持续离线。
3. P3-2/P3-3。快层先用确定性规则匹配权威数据，OpenSquilla 和具体小模型均可选。模糊请求交给高层。自动建项目需验证四项条件，保留人明确要求创建的入口。复用现有工作入口，明确显示被分派的 Project/Ticket/Session 和已核实状态。
4. P3-4。隔离验证不同文件并行、同文件冲突、失败清理、单派工 diff。先说明当前共享目录的并行风险。生产工作区方案另行决策。

常规 Router→PM 迁移采用服务端会话、请求、目标及 Mandate 校验。目标必须从权威项目记录解析，歧义便请求澄清。只投递必要上下文，按请求和目标幂等，记录节点拒收和未确认。主窗口显示目标及投递状态。旧确认接口的兼容用途先评估，敏感跨域、高风险或新增授权走各自门禁。

每个任务单独提交。回滚当前任务用反向提交，保留已有业务数据。验证 P3-1 时先跑模拟节点和故障场景，再以隔离真实 DSH 验证排队、打断及停止 PM 不影响 Worker。通过 P3-Gate 后才能进入 Phase 4。
