# Project Handoff

本文是 superagent 的交接入口，给接手的人一份整体地图。具体设计、字段和验收细节不在这里重复，按文末“文档地图”去对应文档看。

最后更新：2026-11-14。当前 HEAD 为 `561f4b8`；工作区有 Phase 2 的未提交改动（审计修复后 69 条 `git status --porcelain`），未 push。

## 当前阶段

- Phase 0：跨后端协议、SessionToken、RoleProfile 契约完成。
- Phase 1A：可独立运行的控制面内核、NodePort、FakeNode 完成。
- Phase 1B：1B-0 / 1B-1a / 1B-1b / 1B-2 / 1B-3a / 1B-3b / 1B-3c / 1B-3d 完成。
  - `Runtime` 已 DSH-free：不 import `@deepseek-ai/*`、不 import `executor/dsh.ts`、不 `new Sessions` / `new DshExecutor`。
  - DSH Context / Sessions / DshExecutor 收在 `src/node`。
  - Session 记录落库、HTTP NodePort/SSE、控制面与节点双入口、真实 DSH NodePort 适配已完成。
- Phase 1B 后续修复：failed PM/Worker 记录可重置并重新 ensure，HTTP 对 failed 返回 502；控制面命令幂等键改为 `前缀:scope:进程UUID:序号`；`DshNodePort` 用 `done`/`inflight` 保证并发同键只执行一次、失败可重试；节点已上报 `idle` 后命令回执丢失时保留该状态，`failed`/`starting` 用 `*-confirm` 键重试确认。
- 跨层修复：`session.inspect` 显式确认、同一 Session 创建单飞、角色安装失败 502、消息/归档结果回传、未知命令 400/422/500、`startControlPlane` 注册失败 fail-fast；`NodeExecutor` 已让独立 Engine 的 Assignment 创建 Worker Session 并回写 `assignmentStarted`。
- 工具桥：`control_project` / `control_create_tickets` / `control_report` 通过 session token 调用控制面 `/v1/tools/*`；PM 可读取自己的 Project 和已有 Ticket，建单进 `createProjectTickets`，Worker Report 回原 Ticket/Assignment；RoleProfile prompt/tools 已接入。NodeExecutor 的 Worker 首条消息含 Ticket/Goal/Scope/Note/Assignment，`deliver` 成功后 `inputsDelivered` 清 undelivered。
- 真实 DSH + 真实模型全链路已通过：隔离 profile、独立控制面、真实 DSH 插件、`opencode-go/deepseek-v4.1-flash`；PM 读取 Project → `control_create_tickets` → NodeExecutor Worker → `control_report` 同一 Ticket/Assignment → completed。证据：`.artifacts/phase1-live-run-BzkxEa/acceptance.json`。
- Phase 2 已完成（未提交，HEAD `561f4b8`；审计修复后 69 条未提交）：
  - P2-A1/P2-A2 token 刷新与版本化、P2-B1/P2-B2 执行事实与 stop cleanup、P2-C viewer/SSE、P2-D 独立 DSH 节点进程（D2 恢复 + D3 无 shim 模型/工具边界）、P2-E 图片窄端口、P2-F 部署文档与示例均已完成。
  - 2026-11-14 审计 5 条已修：过期 token refresh 宽限 300s、stopFailure/取消 10s deadline、半失联心跳 command timeout 10s、Trigger 正文投递、input 已读归属（`onDelivered` 后 ready + Assignment running 校验）。
  - 最终回归：37 files / 295 tests 通过；`pnpm typecheck`、`pnpm build` 通过；`docs.spec` 仍是已知 3 个 Windows 路径失败。
  - E2E 两条证据链：`p2d-e2e-fixed-3a6c`（恢复：慢/快节点重启、控制面重启、离线 502、inspect 无 status；`.artifacts/p2d-e2e-fixed-3a6c/evidence/`）与 `p2d-model-v2-f35fac`（真实模型、无 shim：PM 建 Ticket → NodeExecutor 自动建 Worker → `control_report` ready/42 → completed；`.artifacts/p2d-model-v2-f35fac/evidence/model-v2/`）。记录见 `docs/014`。
  - 部署/认证文档：`docs/015-node-deployment.zh-CN.md`、`docs/016-control-plane-tls.zh-CN.md`；示例 profile 在 `examples/profile.node/`。
  - 下一步建议：本地 review、按目标拆分 commit（未做）；`RoleProfile.deny` 独立语义、PM role prompt 自动 turn 1、refresh 5min 宽限、cancel/command 10s deadline、强杀 lock stale、节点 `seq` 重启归零、`Assignment.sessionId` 与真实 `worker-<assignmentId>` 不一致、无控制面前端/TLS 文档保留为剩余风险/观察。

## 这是什么

一个独立的 superagent 开发基线，派生自 MIT 许可的 dsh-superagent research prototype；当前仓库使用 GPL-3.0-or-later，上游 MIT 许可保留在 `LICENSE-MIT`，归属说明见 `NOTICE`。

- 仓库：`https://github.com/imx123/super-personal-assistant`
- 分支：`main`
- 上游参考：`prototype/`，保持原样，不在其中修改
- 冻结的 V2 工具基线：`windows-v2/source`，同样不修改

## 核心模型

```text
Source → Trigger → Thread → Eval → Decision → Ticket → Mandate → Assignment → Worker Session
```

- `Engine` 是唯一写入方；SQLite `Store` 持久化；`Effects` 负责可重试的对外动作。
- 主窗口是 Router：普通聊天不建单，明确派工才走 Trigger/Decision/Ticket。
- Project 是 Router 之下的一层：Project Profile + PM Mandate + PM Session `pm-<projectId>`。
- PM 是一个项目范围内的小号 Router：只读自己的 Project、创建项目内 Ticket、向 Router 汇报，不自己实现工作。
- 项目内 Ticket 用内部 Trigger + record-only Eval + `delegated` Decision 创建；1 Decision ↔ 1 Ticket，不自动订阅 Project 源 Thread。

## 架构现状

```text
Control plane（src/app/runtime.ts，DSH-free）
  ControlPlaneOwner（Store + Engine）
  Engine / Policy / Tickets / Projects / Sources / Effects / Outbox / Passes
  RuntimePlatform（logger、HTTP 注册、node 工厂、窄端口）
        │
        │ NodePort：HTTP /commands + SSE /events，bearer 鉴权
        ▼
Node（src/node）
  DshNodePort / DshPortHost
  DSH Context / Sessions / DshExecutor
  Workspace / Permission
```

- `ControlPlaneOwner` 拥有 Store/Engine；`Runtime` 不再自行构造。
- `RuntimePlatform` 不再暴露 Cordis Context；Platform 把 Context 收在闭包内。
- `src/node/dsh-port.ts` 把 NodeCommand 映射成 DSH 操作；`dsh-port-host.ts` 是唯一集中使用 DSH API 的节点传输文件。
- `lib/control.js` 是独立控制面入口；`lib/node.js` 仍是 FakeNode 测试/兼容入口。
- 真实节点由 `dsh --profile superagent-node` 加载 `dsh-superagent/node`（`src/node/plugin.ts` + `src/node/node-sessions.ts`）；旧的插件内启动路径仍保留：同时设置 `SUPERAGENT_NODE_TOKEN` 和 `SUPERAGENT_NODE_PORT` 可启动节点服务，未设置时现有插件行为不变。

## 当前能力

### 主入口

- `main-session` Source、allowed operator、`orchestrator_user_trigger_create` + `orchestrator_route`。
- 主窗口派工走 gate-only `directEval`，不额外造 Eval 路径。
- 权限：主窗口用户会话走 Policy；PM/Worker 走 DSH 权限 preset。

### Project / PM

- Project Profile、PM Mandate、Project 状态：`active / paused / ended / archived`。
- PM Session `pm-<projectId>`：`orchestrator_read`、`orchestrator_project_ticket_create`、`orchestrator_project_ticket_message`、`orchestrator_project_report`。
- PM 只能读自己的 `project/<id>`、`project/<id>/tickets` 和项目内 `ticket/<id>`。
- PM 默认权限 `auto`；PM 默认模型 `eval.pmModel ?? eval.model`。

### Project Ticket

- PM 一次可建 1–5 张 Ticket；内部 Trigger、record-only Eval、`delegated` Decision、真实 `evalId`。
- Ticket 可显式订阅外部 Thread（`contextOnly` 可选）；不自动订阅 Project 源 Thread。
- 可选 `allow_tools` 白名单：只能从 `WORK_TOOLS` 收窄；subagent 继承；不是文件系统沙箱。
- 可选 `wake` 的 PM→Worker coordination note：落为 Ticket Input，进入历史，不授予权限；`wake=true` 仅在 Ticket 可 retry 时启动新 Assignment。

### 报告与可见性

- Router-owned Ticket 报告回主 Session。
- Project Ticket 报告/attention 回所属 PM，不回主 Session。
- PM 的 `orchestrator_project_report` 写 `latestReport`，并向主 Session relay 一条结构化 `project_report`。
- PM 下一次 prompt 会读取 `pendingNotes`（worker 归档/恢复、hard pause 恢复同步），然后清除；不主动唤醒 PM。

### 状态与归档

- `pause` 分 soft/hard：
  - soft：阻止新 Ticket/Assignment，已有 Assignment 继续，通知 PM 完成本轮 report 后停止；
  - hard：结束 Project 内 pending/running Assignment，取消 loaded PM/child Session 当前 turn，不 archive。
- `stop`：Project 置 ended，级联停止 open child Ticket。
- `archive`：Project + 所有 child Ticket 置 archived；结束 Assignment、archive PM/child Session；不删除记录。
- `unarchive`：恢复 `archivedFrom`、清 Ticket archived、unarchive Session；不自动 retry。
- DSH 原生 archive/unarchive 会通过 `ArchiveReconciler` 与 Project 状态对齐；30 秒 unref 定时器兜底 unarchive（DSH 没有 unarchive 事件）。
- `delete` 暂缓：DSH 没有稳定 session delete，硬删应用记录会留下 Session 日志，当前不做。

### 控制面 / 节点

- Session 记录持久化在 `control/session:<sessionId>` KV；重启加载，token 不落库，按需重签。`SessionRecord.nodeGeneration` 记录确认 ensure 时的节点代次；控制面启动、`offline → online`、SSE 重连都会轮换，过期记录在 PM/Worker ensure 和 `sendMessage` 前先 re-ensure。
- HTTP NodePort：`POST /commands`、SSE `GET /events`、公开 `/health`，bearer 鉴权。
- 控制面 token：operator + 可选 viewer（`SUPERAGENT_CONTROL_VIEWER_TOKEN`，只读 GET，写 403，viewer≠operator）；Session token 版本化（`tv`/`tokenVersion`，refresh 宽限 current/previous 一次）。
- 控制面没有前端；TLS/反向代理是部署建议（`docs/016`），14 客户端 SSE 压测已通过。
- `src/app/runtime.ts` 的 DSH 硬边界：无 `@deepseek-ai/*`、无 `executor/dsh`、无 `platform.context`、无 `new Sessions` / `new DshExecutor`。
- 真实 DSH NodePort 已在 `src/node/dsh-port.ts` / `dsh-port-host.ts` 实现；独立 DSH 节点进程由 `dsh --profile` + `dsh-superagent/node` 实现并在 P2-D2/D3 E2E 验证（`docs/014`）；节点在 turn 1 前消费 profile 的 `agentDefaultModel`（无 shim，PM/Worker 路由 `opencode-go/deepseek-v4.1-flash/high`），并按 `RoleProfile.tools` 应用 `tools.restrict` + `tools.guard`；`lib/node.js` 仍是 FakeNode。

### 事件

- `project.created` 以及 `project.paused / resumed / ended / archived / unarchived` domain events。
- 目前只供审计/测试，不自动 relay/notice，也不改 UI。

## 目录速查

```text
src/core/       领域模型、Engine、决策、Ticket、Project
src/control/    独立控制面内核、ControlPlaneOwner、HTTP 面板/服务、Session 持久化
src/node/       DSH 节点运行时、platform、OrchestratorService、NodePort、HTTP/SSE、DSH 适配
src/shared/     跨后端协议、SessionToken
src/app/        Runtime、Store、Settings、Tools、HTTP/views、Outbox、Effects
src/executor/   DSH Executor：worker Session、报告、恢复
src/sources/    main-session、internal、Feishu、GitHub Source
src/client/     Web 面板
prompts/        主窗口、dispatch、PM、worker 提示词
docs/           设计、授权、面板、架构、基线与验收
tests/          Vitest 测试
cordis.patch.yml  预设（router / worker / PM）
```

## 运行与验证

在仓库根目录：

```bash
pnpm install     # prepare 钩子在依赖装好后自动构建 lib/
pnpm typecheck
pnpm test        # 默认命令；vitest.config.ts 已固定 pool: 'threads'
pnpm build
pnpm control     # lib/control.js；需要 SUPERAGENT_CONTROL_TOKEN
pnpm node        # lib/node.js 的 FakeNode；需要 SUPERAGENT_NODE_TOKEN
# 真实节点：dsh --profile superagent-node（profile 内加载 dsh-superagent/node）
```

控制面与节点分进程时，常用环境变量：

- `SUPERAGENT_CONTROL_TOKEN`：控制面 API bearer token
- `SUPERAGENT_NODE_URL` / `SUPERAGENT_NODE_TOKEN`：控制面连接外部节点
- `SUPERAGENT_NODE_PORT` / `SUPERAGENT_NODE_HOST` / `SUPERAGENT_NODE_ROOT`：节点服务
- `SUPERAGENT_CONTROL_DB` / `SUPERAGENT_WORKSPACE_ROOT` / `SUPERAGENT_NODE_ID`

本轮 Phase 2 相关回归 37 files / 295 tests 通过；`pnpm typecheck`、`pnpm build` 通过。E2E `p2d-e2e-fixed-3a6c`（恢复）与 `p2d-model-v2-f35fac`（无 shim 真实模型/工具边界）均通过，后者 11 项验收全 pass。

本机 Windows 环境的已知问题：

- 全量测试仍有本机 Windows/依赖环境失败（此前基线约 44 项失败、13 个加载错误：路径分隔符、权限位、`spawn EPERM/ENOENT`、`jsdom/undici` 缺模块等），不是新增逻辑失败；本轮定向 37 files / 295 tests 通过；
- `docs.spec` 的 3 个失败是测试自身用 `/` 切 Windows `\` 路径，归一化后模块/测试表无缺失；
- 若 sandbox 在加载 Vitest 配置时仍 `spawn EPERM`，用 `node node_modules/vitest/vitest.mjs run --configLoader runner`；
- `git diff --check` 通过。

模型可见文本预算：orchestrator 61,500 字符（`model-surface` 覆盖）。

## 已知边界 / Phase 2

- `lib/node.js` 仍是 FakeNode；真实节点由 `dsh --profile superagent-node` + `dsh-superagent/node` 启动，已在隔离 E2E 验证（见 `docs/013`、`docs/014`）；部署说明见 `docs/015`，示例 profile 在 `examples/profile.node/`；插件内通过 env 启动的旧路径仍保留。
- 工具桥已接；P2-D 独立节点下的真实模型链已验收：`p2d-model-v2-f35fac`（无 shim）PM→Ticket→NodeExecutor Worker→`control_report`（`ready` + `17 + 25 = 42`）→Ticket `completed`；Phase 1B 证据仍在 `.artifacts/phase1-live-run-BzkxEa/acceptance.json`。
- P2-D3 模型/工具边界：节点在 turn 1 前消费 profile 的 `agentDefaultModel`（profile 只需 `agent-default-model` + `llm-pi-ai` 两行 + 凭据；`p2d-model-default` shim 已移除）；按 `RoleProfile.tools` 应用 `tools.restrict` + `tools.guard`，v2 实际 PM 2 个工具、Worker 20 个（shell 是 `pwsh`）。
- `RoleProfile.deny` 未单独消费（现有 PM/Worker 的 deny 名字都在各自 tools 外，行为正确但“deny 独立语义”未实现）；控制面 `PM_PROFILE`/`WORKER_PROFILE.model` 仍为空，角色路由由节点 profile 默认决定。
- PM 的 ensure role prompt 会自行开始 turn 1：v2 中 PM 在操作员消息前自建 3 个 Ticket 并起了 3 个 Worker（已取消）。这是“ensure 的 role prompt 是否应静默投递”的产品决策，不是已修复缺陷。
- P2-D2 恢复语义已实现并 E2E 验证：每次注册唯一幂等键、10s 周期 heartbeat、失败本地 `online:false` + 离线命令 502、SSE 250ms→5s 退避重连、`onReconnect` 轮换 generation、`SessionRecord.nodeGeneration` 过期先 re-ensure、`inspectSession` 对“已持久化但未挂载”返回 `found:true` + `backendSessionId` 且无 `status`。
- 2026-11-14 审计 5 条已修：token refresh 有过期宽限（默认 300s，`SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS`，`0` 关闭；普通路由仍严格）；stop 失败写 `Ticket.stopFailure` + `ticket.stopFailed`，取消有 10s deadline；`HttpNodePort` 命令总超时默认 10s，半失联心跳会 offline 并重试；Trigger 正文和 meta 一起投递；`AgentDelivery` 的 `onDelivered` 在消息真正插入 inbox 后回调，`promptSession` 收到回调才 ready，`turn/start` 只取 ready 的 Input IDs，并按 `assignmentId` 的 running 状态归属。
- 已读投递的取舍：回调契约要求宿主在插入后触发 `onDelivered`；宿主违反时可能提前/延后标记 ready，导致 `turn/start` 带错/漏带 IDs。当前 DSH 路径已按回调实现，这是契约风险而非当前缺陷。
- 其他审计取舍：refresh 超过 TTL+5min 仍失败；cancel/command 超时是上限，不是精确检测时间。
- 强杀控制面后 `proper-lockfile` 的 30s stale 会让立即重启报 `Lock file is already being held`；正常 SIGTERM 不应触发，尚未修复（P2-F/运维）。节点重启后事件 `seq` 归零也未处理，`/v1/events?after=N` 的跨重启语义待明确。
- P2-A1/P2-A2 token 已完成：可配置 TTL、`POST /v1/tools/token/refresh`、工具 401 自动刷新并重试一次；`SessionTokenClaims.tv` + `SessionRecord.tokenVersion` 做版本化，普通工具要求 current，refresh 只宽限 current/current-1 一次，同一秒刷新 token 也不同。节点仍不本地验签（节点没有 secret），验签在控制面 `/v1/tools/*`。
- P2-B1/P2-B2 已完成：`turn-start`/`turn-end` 回写 Assignment，`inputsRead` 回传 Input id；`cancelSession(sessionId, reason?)` 先 `stopBackground`（kill jobs、drain live subagents、keepInbox），再 cancel + `whenIdle`，清理失败不跳过 cancel、也不假成功；`DshNodePort` 透传 reason。
- 可选 `GET /v1/tools/context` 未实现；Ticket/Assignment id 由角色 prompt 随工具说明下发。
- P2-C viewer/SSE 已完成：`SUPERAGENT_CONTROL_VIEWER_TOKEN` 是可选只读角色，只能 GET 读路由，写操作 403，viewer 与 operator 相同会拒绝启动并释放 DB 锁；14 客户端 SSE 压测通过。仓库没有控制面前端；`src/client` 是 DSH 面板（轮询 `/orchestrator/api`），不接控制面 `/v1/events/stream`。TLS/反代部署建议见 `docs/016`，TLS 代码未实现。
- 跨进程工作区根目录需要显式对齐（`SUPERAGENT_NODE_ROOT` 与 `SUPERAGENT_WORKSPACE_ROOT`）。
- `session.message` 现在携带 token，但节点不本地验签；控制面按 `tokenVersion` 拒绝被取代的普通工具调用。旧 token 刷新后普通工具 401，但仍可 refresh 一次。
- P2-E 已完成：`src/sources/kind.ts` 用 `ImageTarget` 窄端口，`src/sources/image-target.ts` 是唯一 DSH 边界；`assessment.ts` 不再 import `@deepseek-ai/*` 或 `Agent`。`panel-eval`/`panel-execution` 的 22 个失败是 HEAD 基线 React/jsdom 环境问题，不是本批引入。
- `Assignment.sessionId` 记录的是 `worker-<ticketId>`，实际运行 Session 是 `worker-<assignmentId>`；这是现有行为，排障以 `/v1/sessions` 和节点日志为准。
- Project/Ticket 删除、Project 归档后的物理清理未做。
- soft pause 的“报告后停止”是提示词/消息约束；hard pause 才强制取消 loaded Session。
- hard pause 只取消当前进程里 loaded 的 Session；未加载的 Session 没有 turn 可取消，恢复后读 paused 状态。
- `eval.pmModel` 只影响新建 PM Session；已有 PM Session 不自动切换。
- PM domain events 没有独立消费方。
- 未做：Project Memory/RAG、Fast Router 拆分、父 Ticket/Dispatch/TaskSpec、capability 档/`denyTools`。

## 文档地图

细节按原位置查：

- [016-control-plane-tls.zh-CN.md](docs/016-control-plane-tls.zh-CN.md)：控制面 viewer/operator 认证、SSE 语义与压测、TLS 反代部署建议。
- [015-node-deployment.zh-CN.md](docs/015-node-deployment.zh-CN.md)：控制面与独立 DSH 节点的双进程部署、故障手册、升级回滚与 Windows 服务化。
- [014-p2d2-recovery.zh-CN.md](docs/014-p2d2-recovery.zh-CN.md)：P2-D2 恢复修复、D3 无 shim 模型/工具边界、隔离 E2E 证据与验收表。
- [013-p2d-node-spike.zh-CN.md](docs/013-p2d-node-spike.zh-CN.md)：P2-D spike、实现状态、E2E 验收与剩余风险。
- [012-phase2-plan.zh-CN.md](docs/012-phase2-plan.zh-CN.md)：Phase 2 目标、顺序与验收要求。
- [011-phase1b-inventory.zh-CN.md](docs/011-phase1b-inventory.zh-CN.md)：Phase 1B 依赖/写入盘点、1B-3a/3b/3c/3d 状态与剩余边界。
- [010-control-plane-kernel.zh-CN.md](docs/010-control-plane-kernel.zh-CN.md)：控制面内核、运行方式与最小 API。
- [009-node-protocol.zh-CN.md](docs/009-node-protocol.zh-CN.md)：节点协议、SessionToken、工具上下文。
- [007-architecture.md](docs/007-architecture.md)：模块表、文件职责、测试表。
- [BASELINE.zh-CN.md](docs/BASELINE.zh-CN.md)：历史基线、完成项、验证记录、已知问题；最新状态以本文件和 011 为准。
- [P2_ACCEPTANCE.zh-CN.md](docs/P2_ACCEPTANCE.zh-CN.md)：P2 场景与验收边界。
- [P3_HANDOFF.zh-CN.md](docs/P3_HANDOFF.zh-CN.md)：P3 任务交接设计讨论稿（同 Project 换执行者、跨 Project 新 Ticket、人工暂停边界）。
- [001-domain.md](docs/001-domain.md)：领域对象、状态与事件。
- [002-authorization.md](docs/002-authorization.md)：Source、Policy、Mandate、Project/PM 权限。
- [005-panel.md](docs/005-panel.md)：面板页面、API 与 Project Tab 控件。
- `docs/000`–`docs/008`：上游文档；与当前基线冲突处以 BASELINE 和新增说明为准。

## 许可与归属

- 本仓库：GPL-3.0-or-later，见 `LICENSE`。
- 上游 MIT 许可保留：`LICENSE-MIT`。
- 来源与归属：`NOTICE`；不是 DeepSeek 官方产品。
