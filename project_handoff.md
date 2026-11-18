# Superagent 项目交接

2026-11-18 更新。交付分支为 `next`，项目基线为 `6875ef9`，Phase 3 阶段签收记录为 `23b97db`。接手时先用 `git status -sb` 和 `git log -5 --oneline` 核对检出版本。

## 1. 实施进度与接手顺序

| 任务 | 当前状态 | 交付提交 |
| --- | --- | --- |
| P3-0 基线核查 | 完成，记录权限、停止范围和测试基线。 | `2419bb6` |
| P3-1 会话干预 | 完成，真实 DSH 验证停止 PM 时保留项目和其他 Worker，以及 Router 插话排队和中断当前回合。 | `9f62bd5`、`9f1265d` |
| P3-2 快路由 | 完成，真实 DSH 跑通独立工单和报告，规则命中可直接向 Worker 或 PM 投递。 | `3dfbf4a` |
| P3-3 高层路由与项目交接 | 完成，真实 DSH 验证既有项目接单，以及自动创建项目后从派工到报告回 Router。 | `1b38219`、`b66ca88` |
| P3-4 工作区隔离 | Git 实验和项目页提示完成，生产继续使用共享目录。 | `3364630` |
| P3-Gate | 验收通过。已在同一版核对两条真实闭环、停止与重启、项目门禁和兼容回归。 | 受测代码 `b2ff528` |
| P4-0 协作事件与节点解析 | 设计与共享类型已签收。 | `154c313` |
| P4-1 单节点报告协调 | Claude Code 实施，Codex 独立验收。 | `phase4/p4-1` |
| P4-3 至 P4-Gate、Phase 5 记忆 | 尚未开始实施。 | — |

P3-Gate 已在 `b2ff528` 通过。类型检查、构建及 56 文件 753 项定向回归通过。真实 DSH 核对了两条闭环、会话干预和 Worker 停止后的重启恢复。全量测试的遗留问题和真实证据见 [P3-Gate 记录](docs/roadmap/PHASE3_5_EXECUTION_LOG.md#p3-gate)。

`next` 的 Phase 4 和 Phase 5 由 Claude Code 以 `max` effort 实施，Codex 负责独立验收。P4-0 已评审，当前做单节点报告协调；随后做权限拒绝审查、摘要、外部事件订阅与投递恢复。Phase 4 验收通过后进入三域记忆。 [主线计划](docs/roadmap/NEXT_MAINLINE_PLAN_v1.1.md) · [Phase 4 补充规范](docs/roadmap/NEXT_PHASE4_SUPPLEMENT_v1.0.md) · [Phase 5 补充规范](docs/roadmap/NEXT_PHASE5_MEMORY_SUPPLEMENT_v1.0.md)

`feat/multi-node` 由跨设备负责人实施和验收。两条线共用 `NodeResolver` 接口。双 Windows 通过 Tailscale 验收后，在临时集成工作树复跑双机用例、单节点回滚和届时的主线用例。Android 是后续扩展。 [跨设备计划](docs/roadmap/MULTI_NODE_PLAN_v1.1.md)

本轮沿用用户补充的三项约束。停 PM 会话与停项目解耦。Router 忙时可以提交插话，普通消息按顺序在后续回合发出，主动中断是单独操作。快路由首版使用规则，OpenSquilla 可作为后续参考。

## 2. 现在能做什么

- 在首页向 Router 派独立任务。控制面创建工单和派工，节点启动 Worker，Worker 把报告写回同一工单，Router 把结果带回首页。
- Router 正在回答时可以继续提交，插话在当前回合结束后按顺序发送。会话页可独立停止或恢复 PM。停 PM 时项目与其他 Worker 可继续运行。
- 快路由可派明确的独立任务、续接开放工单，也可向唯一匹配的项目 PM 交接。首页显示分派目标、当前状态和投递结果。见 [快路由](docs/019-phase3-fast-router.zh-CN.md)。
- 属于已有项目的普通任务可以直接交给那个项目的 PM：在首页用自然语言提出即可，不需要说「转告 PM」，也不需要点确认。高层模型只决定是哪个项目和说什么，控制面按你的原话复核后自己投递；首页显示项目、PM 会话 ID 和真实接收状态。自动交接要求从请求中核对唯一目标；节点缺回执时标记为未确认，避免自动重发造成重复执行。见 [高层自动交接](docs/021-phase3-router-handoff.zh-CN.md)。
- 从项目页或 Router 创建项目，由项目 PM 建单和派工。Worker 在项目工作区执行，报告可验收后由 PM 查看只读 Git diff，再通过验收或要求返工。项目报告可回到 Router。四条件门禁自动建项目后，工作说明会交给这个新项目的 PM，由它自行建单；Router 显式提出的转发提议仍要在控制台等你确认。

控制台提供运行概览、近期动向、项目和会话管理、定时任务历史、节点状态与清理残留会话。项目页可选已有工作区，路径与项目一起保存，PM 和 Worker 共用该目录，页面会提示并行改同一文件可能互相覆盖。首页支持 Markdown、文本附件和切换 Router 模型，也会显示最近一次请求的上下文用量。连接密钥在当前标签页刷新后可以继续使用。

定时任务向已启动、可用的项目 PM 发送一条消息。控制台保存计划与发送结果，发送失败时在近期动向显示。调度间隔、自动清理间隔和令牌过期宽限可立即应用。监听参数、数据库路径、连接密钥和节点默认模型等部署配置保存后，在相应进程重启时应用。

- 从 Router 或 Worker 会话可向独立工单追加指令。旧 Worker 会话会拒绝发送，避免把消息交给接替它的 Worker。会话页分别显示已送达、已排队和发送失败，两次主动发送相同文字各算一条消息。
- 硬暂停会列出节点未确认停止的工单。软暂停期间待验收的报告会记录到数据库，项目恢复后，控制面核对当前派工和验收轮次，再把仍待验收的报告通知 PM。
- 更改任务时区并重启控制面后，重新保存日或周计划即可按新偏移计算下次运行。按间隔运行的计划保留原节奏。调度器开始执行每条计划时读取当时有效的正文和目标项目。

## 3. 两套入口与数据归属

| 入口 | 代码 | 负责什么 |
| --- | --- | --- |
| 独立控制面 | `src/control/main.ts`、`start.ts`、`control-plane.ts`、`server.ts` | `node lib/control.js` 启动。控制面保存项目、工单、派工、会话索引和权限，通过 HTTP/SSE 与节点通信。浏览器入口是 `/console`，前端在 `src/console/`。 |
| 独立 DSH 执行节点 | `src/node/plugin.ts`、`node-sessions.ts`、`dsh-port.ts`、`dsh-port-host.ts` | DSH 的专用 profile 加载 `dsh-superagent/node`。节点创建和恢复真实 DSH 会话，安装角色工具，执行任务并回传状态。 |
| 原有 DSH 插件 | `src/index.ts`、`src/app/runtime.ts`、`src/client/` | 保留插件自身的主会话、GitHub/飞书来源、执行器与 DSH 面板。面板 API 为 `/orchestrator/api`。这套运行时与独立控制面各自持有数据。 |
| 协议测试入口 | `src/node/main.ts` | `node lib/node.js` 运行 FakeNode，适合验证协议与调试。真实节点用上一行的 DSH profile 入口。 |

`src/core/` 负责两套入口共用的工单状态和权限规则。独立控制面把业务状态保存到 `SUPERAGENT_CONTROL_DB`，把事件、操作日志、项目备忘、定时计划及运行设置保存到 `SUPERAGENT_CONSOLE_DB`。实际 DSH 对话和会话日志由节点的专用 `DSH_HOME` 持有，项目源码留在执行节点的工作区。

正常派工走 Router 或 PM 工具，再由 `src/control/executor.ts` 启动 Worker。排查执行时，以 `GET /v1/sessions` 里的记录为准。独立节点的 Worker 会话 ID 是 `worker-<assignmentId>`，底层领域记录中的 `Assignment.sessionId` 仍可能沿用旧命名。

## 4. 启动与排错

1. 在仓库根目录运行 `pnpm install` 与 `pnpm build`。控制面从 `lib/` 启动，并从这里加载 `console.js`。
2. 按节点部署文档为真实 DSH 准备专用 profile。样例在 `examples/profile.node/`，包含 Router、PM 和 Worker 预设。节点和控制面配置相同的节点标识及连接密钥，节点用 `SUPERAGENT_CONTROL_URL` 找到控制面的工具接口。
3. 先启动节点，再运行 `node lib/control.js`。打开启动日志给出的 `/console` 地址，用控制面的连接密钥登录。线上访问和 SSE 反代以部署及 TLS 文档为准。
4. 工作区路径必须是绝对路径，位于配置的工作区根目录内。控制面与执行节点都需要能按各自配置校验这条路径。现有部署若要从控制台管理节点启动参数，在节点启动器中把 `SUPERAGENT_NODE_DEPLOYMENT_FILE` 指向设置页显示的节点配置文件。

排错先分别查两个进程的 `/health`，再查控制面的 `/v1/overview`、`/v1/sessions` 和操作日志。控制面启动时注册节点失败会退出。同一个节点重新上线后会重新确认会话，业务状态从 SQLite 读取。节点命令超时默认 10 秒，超过会话令牌的有效期及刷新宽限后，长时间未调用工具的任务可能需要重新确认会话。强制终止控制面后，数据库目录锁可能需要约 30 秒才可重新取得。

启动命令、环境变量和回滚步骤见 [节点部署](docs/015-node-deployment.zh-CN.md)。反代见 [TLS 与 SSE](docs/016-control-plane-tls.zh-CN.md)，页面及操作见 [控制台](docs/017-console.zh-CN.md)。

## 5. 对照最初架构图

| 功能 | 当前范围 |
| --- | --- |
| 一个入口、工单所有权、PM 与 Worker 协作 | 单节点主流程已跑通。独立工单归 Router，项目工单归项目 PM，多次派工分别对应执行会话。 |
| 双层路由与项目创建条件 | 确定性快路由和高层 Router 已接入。自动建项目经过四条件校验，首页显示判断依据与真实 PM 状态。属于已有项目的普通任务由高层 Router 直接交给该项目的 PM，服务端按本人原话复核，无需人工确认；门禁建项目后工作说明交给新项目的 PM，由它自行建单。 |
| 事件订阅和审批 | 定时唤醒和 Agent 主动上报已接通。独立控制面还缺邮件、日历、仓库事件订阅，以及自动拒绝累计到阈值后触发上级审查。 |
| 多节点与其他运行时 | 当前只连接一个 DSH 节点。同节点恢复已经验证。节点选择、故障时改派其他节点、跨节点同步项目文件，以及 Claude/Codex 执行适配尚未实现。 |
| 三域记忆 | 已能查实时状态、工单历史和项目备忘。长期记忆的候选、审核、索引、召回和维护还没做。控制台的事件日志受保留规则约束。 |

同一项目的 Worker 当前共用工作目录。PM 的只读 diff 反映目录快照，其中可能包含其他 Worker 或人改动的内容。代码审阅要求仓库位于项目工作区，当前实现会拒绝 linked worktree 等使用外置 Git 元数据的布局。待确认的 Router 转发提议与普通 PM 通知的投递状态保存在内存。重启后可以从持久工单查报告，尚未确认的 Router 转发须重新发起。

节点的角色工具边界由许可列表和运行时守卫执行。`RoleProfile.deny` 尚未作为单独规则使用。给现有角色新增工具时，核对 `src/control/roles.ts` 和节点工具桥两处。

工作区隔离只在 Git 层验证：19 项检查通过，覆盖两个派工写不同文件、写同一文件、linked worktree 合并冲突、失败目录保留和单派工 diff。真实 DSH 没有切换路径，生产继续用共享目录和现有审阅校验，候选方案与取舍见 [工作区实验与设计记录](docs/roadmap/PHASE3_WORKSPACE_SPIKE.md)。

## 6. 验证范围

P3-3B 类型检查、构建通过，55 个定向文件共 737 项通过、1 项因 Windows 目录联接限制跳过。真实验收使用 Edge、DSH Desktop `0.2.2.0`、隔离 `phase3-live` profile、`dsh-superagent/node` 和本机 Gemma 4 12B，通过两条新验收链路，包括已有项目免确认交接并完成工单，以及门禁自动创建一个项目后由 PM 派三个工单、Worker 写出三个文件、PM 完成三次验收，项目报告回到 Router 收件箱。证据见 [执行日志](docs/roadmap/PHASE3_5_EXECUTION_LOG.md)。

P3-3B 当时未重跑全量。随后的 P3-Gate 已与开工基线对照，旧插件、Windows 工具与 jsdom 环境的失败记录见阶段验收。

2026-11-16 的控制台验收通过 **39 个测试文件、378 项定向测试**和 **5 项打包测试**。真实模型用的是 Windows 上的 DSH Desktop `0.2.2.0`、隔离的 `phase5` profile、`dsh-superagent/node` 与 `opencode-go/deepseek-v4.1-flash`。本机证据在忽略目录 `.artifacts/`，新克隆可按部署文档和相关测试重新验证。

| 证据文件（相对于仓库根目录） | 验证内容 |
| --- | --- |
| `.artifacts/claude-phase5-20261115/real-console-P9I9Tp/verified-evidence.json` | Router 真对话、转发确认、项目派工、Worker 改文件、PM 验收、定时投递、SQLite 复核。 |
| `.artifacts/claude-phase5-20261115/real-console-oYPqE5/router-standalone-evidence.json` | Router 派独立工单、Worker 回报回到首页，Router 创建项目并启动待命 PM。 |
| `.artifacts/settings-20261116/project-workspace.json` | 浏览器指定已有工作区，真实 PM 和 Worker 使用同一路径，Worker 修改其中的样例文件。 |
| `.artifacts/settings-20261116/sidebar-deployment.json` | 侧栏操作、刷新恢复，重启后新端口、密钥、日志保留、调度偏移与默认模型生效。 |
| `.artifacts/phase3-workspace/spike-20261117-181345-f41104/checks.md` | P3-4 的 19 项 Git 层检查：并行写不同文件、写同一文件、合并冲突、失败目录保留与单派工 diff。 |

## 7. 文档入口

- [节点协议](docs/009-node-protocol.zh-CN.md)与[控制面内核](docs/010-control-plane-kernel.zh-CN.md)记录命令、事件、工具及状态转换。
- [模块与测试索引](docs/007-architecture.md)列出代码和测试位置。上游插件文档保留在 `docs/000` 至 `008`。
- [阶段记录](docs/BASELINE.zh-CN.md)、[Phase 1B 盘点](docs/011-phase1b-inventory.zh-CN.md)、[Phase 2 计划](docs/012-phase2-plan.zh-CN.md)与[节点历史验收](docs/014-p2d2-recovery.zh-CN.md)保留当时的测试口径。旧插件的 [P2 验收](docs/P2_ACCEPTANCE.zh-CN.md)和 [P3 交接设计](docs/P3_HANDOFF.zh-CN.md)使用各自的阶段编号。
- 阶段规范：[会话停止](docs/018-phase3-session-stop.zh-CN.md)、[快路由](docs/019-phase3-fast-router.zh-CN.md)、[四条件建项目](docs/020-phase3-project-gate.zh-CN.md)、[高层自动交接](docs/021-phase3-router-handoff.zh-CN.md)。路线与实验记录在 [执行日志](docs/roadmap/PHASE3_5_EXECUTION_LOG.md) 和 [工作区实验](docs/roadmap/PHASE3_WORKSPACE_SPIKE.md)。
