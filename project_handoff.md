# Superagent 项目交接

2026-11-17 更新。本地 `next` 的阶段状态见 [执行日志](docs/roadmap/PHASE3_5_EXECUTION_LOG.md)。独立控制台在 `ba84bcd` 落地，`afa1001` 修复演示审查发现的 Worker 投递、项目暂停恢复和定时任务问题。继续工作前用 `git status -sb` 和 `git log -5 --oneline` 核对当前分支。

## 1. 现在能做什么

独立控制台已用真实 DSH 跑通两条链路。

- 在首页向 Router 派独立任务。控制面创建工单和派工，节点启动 Worker，Worker 把报告写回同一工单，Router 把结果带回首页。
- Router 正在回答时可以继续提交，插话在当前回合结束后按顺序发送。会话页可独立停止或恢复 PM。停 PM 时项目与其他 Worker 可继续运行。
- 快路由可派明确的独立任务、续接开放工单，也可向唯一匹配的项目 PM 交接。首页显示分派目标、当前状态和投递结果。见 [快路由](docs/019-phase3-fast-router.zh-CN.md)。
- 从项目页或 Router 创建项目，由项目 PM 建单和派工。Worker 在项目工作区执行，报告可验收后由 PM 查看只读 Git diff，再通过验收或要求返工。项目报告可回到 Router。Router 自己提的转发提议仍要在控制台等你确认（这条默认行为在 P3-3 迁移）。

控制台提供运行概览、近期动向、项目和会话管理、定时任务历史、节点状态与清理残留会话。项目页可选已有工作区，路径与项目一起保存，PM 和 Worker 共用该目录。首页支持 Markdown、文本附件和切换 Router 模型，也会显示最近一次请求的上下文用量。连接密钥在当前标签页刷新后可以继续使用。

定时任务向已启动、可用的项目 PM 发送一条消息。控制台保存计划与发送结果，发送失败时在近期动向显示。调度间隔、自动清理间隔和令牌过期宽限可立即应用。监听参数、数据库路径、连接密钥和节点默认模型等部署配置保存后，在相应进程重启时应用。

- 从 Router 或 Worker 会话可向独立工单追加指令。旧 Worker 会话会拒绝发送，避免把消息交给接替它的 Worker。会话页分别显示已送达、已排队和发送失败，两次主动发送相同文字各算一条消息。
- 硬暂停会列出节点未确认停止的工单。软暂停期间待验收的报告会记录到数据库，项目恢复后，控制面核对当前派工和验收轮次，再把仍待验收的报告通知 PM。
- 更改任务时区并重启控制面后，重新保存日或周计划即可按新偏移计算下次运行。按间隔运行的计划保留原节奏。调度器开始执行每条计划时读取当时有效的正文和目标项目。

## 2. 两套入口与数据归属

| 入口 | 代码 | 负责什么 |
| --- | --- | --- |
| 独立控制面 | `src/control/main.ts`、`start.ts`、`control-plane.ts`、`server.ts` | `node lib/control.js` 启动。控制面保存项目、工单、派工、会话索引和权限，通过 HTTP/SSE 与节点通信。浏览器入口是 `/console`，前端在 `src/console/`。 |
| 独立 DSH 执行节点 | `src/node/plugin.ts`、`node-sessions.ts`、`dsh-port.ts`、`dsh-port-host.ts` | DSH 的专用 profile 加载 `dsh-superagent/node`。节点创建和恢复真实 DSH 会话，安装角色工具，执行任务并回传状态。 |
| 原有 DSH 插件 | `src/index.ts`、`src/app/runtime.ts`、`src/client/` | 保留插件自身的主会话、GitHub/飞书来源、执行器与 DSH 面板。面板 API 为 `/orchestrator/api`。这套运行时与独立控制面各自持有数据。 |
| 协议测试入口 | `src/node/main.ts` | `node lib/node.js` 运行 FakeNode，适合验证协议与调试。真实节点用上一行的 DSH profile 入口。 |

`src/core/` 负责两套入口共用的工单状态和权限规则。独立控制面把业务状态保存到 `SUPERAGENT_CONTROL_DB`，把事件、操作日志、项目备忘、定时计划及运行设置保存到 `SUPERAGENT_CONSOLE_DB`。实际 DSH 对话和会话日志由节点的专用 `DSH_HOME` 持有，项目源码留在执行节点的工作区。

正常派工走 Router 或 PM 工具，再由 `src/control/executor.ts` 启动 Worker。排查执行时，以 `GET /v1/sessions` 里的记录为准。独立节点的 Worker 会话 ID 是 `worker-<assignmentId>`，底层领域记录中的 `Assignment.sessionId` 仍可能沿用旧命名。

## 3. 启动与排错

1. 在仓库根目录运行 `pnpm install` 与 `pnpm build`。控制面从 `lib/` 启动，并从这里加载 `console.js`。
2. 按节点部署文档为真实 DSH 准备专用 profile。样例在 `examples/profile.node/`，包含 Router、PM 和 Worker 预设。节点和控制面配置相同的节点标识及连接密钥，节点用 `SUPERAGENT_CONTROL_URL` 找到控制面的工具接口。
3. 先启动节点，再运行 `node lib/control.js`。打开启动日志给出的 `/console` 地址，用控制面的连接密钥登录。线上访问和 SSE 反代以部署及 TLS 文档为准。
4. 工作区路径必须是绝对路径，位于配置的工作区根目录内。控制面与执行节点都需要能按各自配置校验这条路径。现有部署若要从控制台管理节点启动参数，在节点启动器中把 `SUPERAGENT_NODE_DEPLOYMENT_FILE` 指向设置页显示的节点配置文件。

排错先分别查两个进程的 `/health`，再查控制面的 `/v1/overview`、`/v1/sessions` 和操作日志。控制面启动时注册节点失败会退出。同一个节点重新上线后会重新确认会话，业务状态从 SQLite 读取。节点命令超时默认 10 秒，超过会话令牌的有效期及刷新宽限后，长时间未调用工具的任务可能需要重新确认会话。强制终止控制面后，数据库目录锁可能需要约 30 秒才可重新取得。

启动命令、环境变量和回滚步骤见 [节点部署](docs/015-node-deployment.zh-CN.md)。反代见 [TLS 与 SSE](docs/016-control-plane-tls.zh-CN.md)，页面及操作见 [控制台](docs/017-console.zh-CN.md)。

## 4. 对照最初架构图

| 功能 | 当前范围 |
| --- | --- |
| 一个入口、工单所有权、PM 与 Worker 协作 | 单节点主流程已跑通。独立工单归 Router，项目工单归项目 PM，多次派工分别对应执行会话。 |
| 双层路由与项目创建条件 | 确定性快路由已接入，普通对话和不确定请求交给现有 Router 模型。四条件自动建项目及高层自主交接待 P3-3 实现。 |
| 事件订阅和审批 | 定时唤醒和 Agent 主动上报已接通。独立控制面还缺邮件、日历、仓库事件订阅，以及自动拒绝累计到阈值后触发上级审查。 |
| 多节点与其他运行时 | 当前只连接一个 DSH 节点。同节点恢复已经验证。节点选择、故障时改派其他节点、跨节点同步项目文件，以及 Claude/Codex 执行适配尚未实现。 |
| 三域记忆 | 已能查实时状态、工单历史和项目备忘。长期记忆的候选、审核、索引、召回和维护还没做。控制台的事件日志受保留规则约束。 |

同一项目的 Worker 当前共用工作目录。PM 的只读 diff 反映目录快照，其中可能包含其他 Worker 或人改动的内容。代码审阅要求仓库位于项目工作区，当前实现会拒绝 linked worktree 等使用外置 Git 元数据的布局。待确认的 Router 转发提议与普通 PM 通知的投递状态保存在内存。重启后可以从持久工单查报告，尚未确认的 Router 转发须重新发起。

节点的角色工具边界由许可列表和运行时守卫执行。`RoleProfile.deny` 尚未作为单独规则使用。给现有角色新增工具时，核对 `src/control/roles.ts` 和节点工具桥两处。

## 5. 验证范围

2026-11-17 对 `afa1001` 的定向回归通过 **47 个测试文件、483 项测试**，类型检查和构建通过。用 Edge 和隔离 FakeNode 复验了同文连续发送、节点拒收时保留草稿，以及硬暂停后显示停止失败的工单。这一轮没有重跑全量测试或真实模型。

2026-11-16 的控制台验收通过 **39 个测试文件、378 项定向测试**和 **5 项打包测试**。真实模型用的是 Windows 上的 DSH Desktop `0.2.2.0`、隔离的 `phase5` profile、`dsh-superagent/node` 与 `opencode-go/deepseek-v4.1-flash`。本机证据在忽略目录 `.artifacts/`，新克隆可按部署文档和相关测试重新验证。

| 证据文件（相对于仓库根目录） | 验证内容 |
| --- | --- |
| `.artifacts/claude-phase5-20261115/real-console-P9I9Tp/verified-evidence.json` | Router 真对话、转发确认、项目派工、Worker 改文件、PM 验收、定时投递、SQLite 复核。 |
| `.artifacts/claude-phase5-20261115/real-console-oYPqE5/router-standalone-evidence.json` | Router 派独立工单、Worker 回报回到首页，Router 创建项目并启动待命 PM。 |
| `.artifacts/settings-20261116/project-workspace.json` | 浏览器指定已有工作区，真实 PM 和 Worker 使用同一路径，Worker 修改其中的样例文件。 |
| `.artifacts/settings-20261116/sidebar-deployment.json` | 侧栏操作、刷新恢复，重启后新端口、密钥、日志保留、调度偏移与默认模型生效。 |

## 6. 文档入口

- [节点协议](docs/009-node-protocol.zh-CN.md)与[控制面内核](docs/010-control-plane-kernel.zh-CN.md)记录命令、事件、工具及状态转换。
- [模块与测试索引](docs/007-architecture.md)列出代码和测试位置。上游插件文档保留在 `docs/000` 至 `008`。
- [阶段记录](docs/BASELINE.zh-CN.md)、[Phase 1B 盘点](docs/011-phase1b-inventory.zh-CN.md)、[Phase 2 计划](docs/012-phase2-plan.zh-CN.md)与[节点历史验收](docs/014-p2d2-recovery.zh-CN.md)保留当时的测试口径。旧插件的 [P2 验收](docs/P2_ACCEPTANCE.zh-CN.md)和 [P3 交接设计](docs/P3_HANDOFF.zh-CN.md)使用各自的阶段编号。
