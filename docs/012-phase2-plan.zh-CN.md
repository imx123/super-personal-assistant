# Phase 2 计划：执行后端生产化

本文定义 Phase 2 的目标、顺序和验收要求。Phase 1B 已通过真实 DSH + 真实模型链路验收；Phase 2 不再改业务入口语义，重点是把执行后端做成可长期运行、可恢复、可观测的生产设施。

> 状态：Phase 2 验收通过（2026-11-14；真实 DSH 主链路 + inputsRead 复验通过）。已提交到本地 `main`，尚未 push。

## 当前基线

- 控制面 `Runtime` 已 DSH-free；Store/Engine 归 `ControlPlaneOwner`。
- DSH Context / Sessions / DshExecutor 收在 `src/node`；`DshNodePort` + `DshPortHost` 已接真实 DSH。
- HTTP NodePort/SSE、Session 持久化、控制面/节点双入口、PM/Worker 工具桥已存在。
- 真实链路已通过：PM `control_project` 读取 → `control_create_tickets` → NodeExecutor Worker → `control_report` 回原 Ticket/Assignment。
- `lib/node.js` 仍是 FakeNode；真实 DSH 节点由 `dsh --profile` + `dsh-superagent/node` 在独立进程中启动。
- 最终回归：37 files / 299 tests 通过；`pnpm typecheck`、`pnpm build` 通过；`docs.spec` 仍是已知的 3 个 Windows 路径失败。

## 目标

### P2-A Session token 生命周期：P2-A1 / P2-A2 已完成

- Session token TTL 可配置：`ControlPlaneOptions.sessionTokenTtlSeconds`，默认 3600 秒。（P2-A1）
- 长任务在 token 过期后能刷新：`POST /v1/tools/token/refresh` 用当前 Session token 换新 token；节点工具遇 401 自动刷新一次并用新 token 重放原请求。（P2-A1）
- `session.message` 等需要鉴权的节点命令携带 token：`session.message` 可选携带 `sessionToken`，`DshNodePort`/host 透传并更新已注册工具；节点没有 secret，本地不验签。（P2-A1）
- 旧 token 版本化（P2-A2）：`SessionTokenClaims` 增加 `tv: number`，`SessionRecord.tokenVersion?` 持久化，`issueToken` 带 `tv`；无 `tv` 的旧格式 token 按 malformed 拒绝。
- 校验规则：普通工具路由要求 `tv === tokenVersion`；refresh 路由允许 `current` 或 `current - 1` 一次；`refreshToolToken` 自增并 persist，同一秒刷新的 token 也不同。旧 token 刷新后普通工具 401，但仍可 refresh 一次；二次刷新后最早 token 连 refresh 也 401。P2-A1 的 401→refresh→retry 在 current/previous 下都可用。
- token 本身不落库、不进日志、不进入工具参数；只持久化版本号。
- 测试：`control-plane-token-refresh` 6、`protocol` 10、`control-plane-persistence` 3、`dsh-port-token-refresh` 8、`control-plane-tools` 18（45 定向通过）。
- 验收：旧 token 被拒、refresh 宽限、401→refresh→retry 均有定向测试；真实模型长任务刷新链路没有单独 E2E，按这些定向测试验收，不把它写成已跑真实模型长任务。

### P2-B 执行事实回写：P2-B1 / P2-B2 已完成

- 已完成（P2-B1）：`turn-start`/`turn-end` 经 ControlPlane 回写 Assignment（`turnBegan`/`turnEnded`，turn-end 的 idle 事实沿用原路径）；`DshPortHost.cancelSession` await `agent.whenIdle()`，`session.cancel` 命令成功代表 turn 已结束。
- 已完成（P2-B2 inputsRead）：`session.message` 携带本次投递的 `inputIds`；节点在投递前按 `dsh-superagent:<idempotencyKey>` 登记，收到 `AgentDelivery.send` 的 `onDelivered`（由 DSH 的 `agent/inbox/spliced` 在消息真正插入 inbox 时触发，早于 `turn/start`；`followup` 返回后的回调只作无事件后端兜底）才标记 ready，`turn/start` 只回传 ready 的 IDs 并清空；控制面只取非空字符串数组，调用 `engine.inputsRead` 给 trigger Input 写 `readAt`，未知/旧 Assignment 静默忽略且不影响 `turnBegan`。
- 已完成（P2-B2 stop cleanup）：`DshPortHost.cancelSession(sessionId, reason?)` 先 `stopBackground`（kill 该 Session 的 running jobs、drain live subagents、`keepInbox=true`），再 cancel + `whenIdle`；清理失败不跳过 cancel，单个错误原样抛出、多个错误用 `AggregateError`，不假成功；无 jobs/subagents 服务时退化为只 cancel；无 live Agent 仍 kill jobs。
- `DshPortHost.cancelSession` 接口与 `DshNodePort` 透传 `reason`。
- 新增 `tests/node-stop-cleanup.spec.ts`（8 个）与 `dsh-port.spec.ts` 的 reason 透传；P2-B2 定向 82 tests 通过。`tests/control-plane-turn-facts.spec.ts`、`tests/control-plane-inputs-read.spec.ts` 覆盖 turn/input 事实。

### P2-C 控制面 viewer/SSE：已完成；TLS/反代/控制面前端见文档

- 已完成（P2-C SSE）：`ControlPlane.subscribe` 让每个收到的节点事件在 `receive` 中同步通知订阅者，单个订阅者抛错只记录、不打断接收；`GET /v1/events/stream` 用控制面 bearer token 认证，按 `after` 查询或 `Last-Event-ID` 头回放 `seq > after` 后接实时流，帧为 `id: <seq>` + `NodeEvent` JSON，连接写 `: connected`、每 15 秒 `: keepalive`；客户端断开退订并清 timer，`ControlPlaneServer.close()` 结束所有流；`/v1/events` 轮询保留不动。
- 已完成（P2-C viewer）：`ControlPlaneServerOptions.viewerToken`（`SUPERAGENT_CONTROL_VIEWER_TOKEN`，空/未设置=未启用）；viewer 仅 GET 读路由（state/projects/tickets/sessions/events/stream/session），所有写 POST/PUT（nodes/register、heartbeat、PM/Worker、message/cancel/archive/permission）403；无/坏/Session token 401；viewer==operator 在构造时直接拒绝并释放 DB 锁；`/health` 公开；`/v1/tools/*` 仍只认 Session token。
- 新增 `tests/control-plane-auth.spec.ts`（5 个）与 `tests/control-plane-sse-load.spec.ts`（1 个：14 并发 operator/viewer 流，逐条事件、无丢失、无交叉、keepalive 清理、close 5s）；与 events/crosslayer/control-plane 共 26 tests。
- **未做**：TLS 直接实现、反向代理代码、控制面前端。TLS/反代部署建议与威胁模型见 `docs/016-control-plane-tls.zh-CN.md`。`src/client` 是 DSH 面板（仍轮询 `/orchestrator/api`），不是控制面前端；仓库没有控制面 UI，**不要写成“前端已接 SSE”**。
- 验收：认证 401/403 已有测试；SSE 并发与重连语义已有测试；TLS 部署和真实网络暴露未在本仓库实现或验收。

### P2-D 独立 DSH 节点进程（已完成并 E2E 验证：真实模型、无 shim、工具边界）

- 真实节点由 `dsh-superagent/node` 在独立 DSH profile 中启动（`dsh --profile <name>`）；`lib/node.js` 保留为 FakeNode 测试/兼容入口，不再冒充真实节点。
- 控制面通过 HTTP 连接独立节点；节点侧不运行控制面 Engine 的写路径。
- 启动/停止/健康检查/重启恢复有明确语义；节点失联时控制面不会假成功。
- 验收：控制面进程 + 独立真实 DSH 节点进程完成 PM→Worker→Report 链路；节点重启后 Session/Assignment 对账；FakeNode 只保留为测试替身。
- 说明：DSH Context 必须由 DSH 宿主提供；如果无法做“裸 Node 进程”，节点服务可以作为独立 DSH profile/插件宿主运行，但必须与控制面分进程，并在文档中写清部署方式。
- **已完成并 E2E 验证（节点进程 + P2-D2 恢复 + P2-D3 模型/工具边界，见 `docs/013` §0.1、§5.8）**：
  - 节点入口：`src/node/node-sessions.ts`（`DshPortSessions`，不挂 `sessionController`/`fileUploads`/`webServer`）与 `src/node/plugin.ts`（`dsh-superagent/node`，12 项 `inject`、env fail-fast、`ctx.effect` 关闭监听）；真实节点由 `dsh --profile superagent-node` 启动，控制面仍是独立 `node lib/control.js`。
  - 恢复修复（D2）：`AgentDelivery` 识别 DSH 0.2.2 的 `agent/inbox/spliced`，profile prompt 跨 resume 只投一次；`DshPortHost.inspectSession` 无 live Agent 时回退 `sessionQuery.observeSession`，持久化存在 → `found:true` + `backendSessionId`、**无 `status`**；控制面每次注册用唯一幂等键，周期 heartbeat 默认 10s（可注入，`close` 清理），失败本地记 `node.status online:false` 且离线命令 502，SSE 断线从 250ms 起翻倍、上限 5s 重连，`onReconnect` 先 `nodeReconnected()` 轮换 generation 再 heartbeat；`SessionRecord.nodeGeneration` 过期时 `openProject`/`createWorkerSession` 与 `sendMessage` 先 re-ensure（Worker 用 assignment→ticket/assignmentId 回退），`stopped`/`archived` 不因代次复活；创建响应 `backendSessionId` 已是节点真实 id（报不出时保留占位）。
  - 默认模型（D3）：节点在 create/resume/复用的 live 路径调用 `initializeRoleModel` 消费 profile 的 `agentDefaultModel`，在 turn 1 前写入 `model/selection`；profile 只需 `agent-default-model` + `llm-pi-ai` 两行和凭据，不再需要 `p2d-model-default` shim。PM/Worker 实际路由为 `opencode-go/deepseek-v4.1-flash/high`。
  - 工具边界（D3）：`DshPortHost.ensureSession` 首轮前按 `RoleProfile.tools` 应用 `tools.restrict`（PM 继承工具全 deny；Worker 按 allow 保留工作工具）+ `tools.guard`（scope-local/越界兜底），`control_*` 在边界后注册仍在 own layer。v2 实际工具表：PM 2 个（`control_project`/`control_create_tickets`）、Worker 20 个（含 `control_report`，shell 是 `pwsh`）。`RoleProfile.deny` 未单独消费。
  - E2E D2 `p2d-e2e-fixed-3a6c`（隔离 `DSH_HOME`/`DSH_AGENTS_HOME`/profile，真实 `dsh` + 独立控制面）：恢复项覆盖双进程/无 Web、health/401、慢重启 offline 1.8s + 离线 502 + 恢复后同 id/`createdAt`、inspect found+backend id 无 status、prompt 1/1、快重启 SSE 轮换 generation、控制面重启自动 online。
  - E2E D3 v2 `p2d-model-v2-f35fac`（无 shim，凭据从上一轮 run 的 artifact 只读复制，系统 `~/.dsh` 未读写）：PM 建 Ticket `b5289e02…`，NodeExecutor 自动建 `worker-b7f520…`，Worker `control_report` 写回同一 Ticket/Assignment（`state=ready`、`17 + 25 = 42`），Ticket `completed`；v2 的 11 项验收全 pass。
  - D3 收口时相关回归 28 files / 223 tests 通过（审计/投递修复后最终回归 37 files / 299 tests，见“当前基线”）；当前 `tests/node-plugin.spec.ts` 26、`tests/dsh-port.spec.ts` 29、`tests/node-tool-boundary.spec.ts` 6、`tests/control-plane-recovery.spec.ts` 14。
  - 仍未完成/观察：`RoleProfile.deny` 的独立语义；PM role prompt 自动开始 turn 1 的产品决策；控制面 `PM_PROFILE`/`WORKER_PROFILE.model` 仍为空（路由由节点 profile 默认决定）；强杀控制面后的 proper-lockfile 30s stale、节点事件 `seq` 重启归零、`Assignment.sessionId` 与真实 `worker-<assignmentId>` 不一致，保留为剩余风险/观察（`docs/013` §6.9、§6.10）。

### P2-E app 层收尾：已完成

- `src/sources/kind.ts` 用 `ImageTarget` 窄端口替代 `Agent`；`src/sources/image-target.ts` 是唯一 DSH 边界（`imageTargetOf(agent)`），`feishu-image.ts`/`feishu-read.ts`/`registry.ts`/`assessment.ts`/`app/tools/main.ts` 已适配。
- `assessment.ts` 不再 import `@deepseek-ai/*`，也不出现 `Agent`；图片/附件通过窄端口。
- 控制面 app 文件不再直接依赖 DSH；node 侧是唯一 DSH 边界。
- 测试：assessment 7、feishu-image 6、registry 10、app-dsh-boundary 3（26 定向通过）；`panel-eval`/`panel-execution` 的 22 个失败是 HEAD 基线 React/jsdom 环境问题，不是本批引入。

### P2-F 运维与部署：文档/示例已完成

- 新增 `docs/015-node-deployment.zh-CN.md`：双进程、环境变量、profile/模型、启动停止/health、lock stale、失联/generation/inspect/seq、`lib/node.js` FakeNode、升级回滚、日志脱敏、孤儿清理、Windows 服务化。
- 新增示例目录 `examples/profile.node/`（`README.md`、`package.json`、`cordis.patch.yml`），已删除 evidence-only 行；不是单个 `examples/profile.node.cordis.patch.yml` 文件。
- 新增 `docs/016-control-plane-tls.zh-CN.md`：viewer/operator 认证、401/403、viewer≠operator、SSE 语义与 14 客户端压测、TLS 反代示例、无控制面前端、日志/令牌脱敏。
- 验收：最终回归 37 files / 299 tests 通过；`pnpm typecheck`、`pnpm build` 通过。TLS/反向代理是部署文档，不是本仓库已实现的代码。

### 2026-11-14 审计修复（5 条）

- **P0-1 过期 token 无法 refresh**：`verifySessionToken(token, secret, nowSeconds?, { allowExpiredSeconds })` 默认严格；只有 refresh 路由传 `allowExpiredSeconds`。`ControlPlaneOptions.sessionTokenRefreshGraceSeconds` 默认 **300s**，`SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS` 覆盖，`0` 关闭，非法值启动失败。refresh 同时允许 current / current-1 版本；普通工具/消息路由仍严格，过期 401。取舍：超过 TTL+5min 且期间完全无工具调用的长任务仍会失败。
- **P0-2 停止结果/取消无截止**：`Ticket.stopFailure?: { at; assignmentId; error }` 与 `ticket.stopFailed` 事件；`hardStopWorker`/`retry`/`end` 的 executor.stop 始终挂 rejection handler，失败写 `stopFailure`、成功清除；Ticket 仍保持 stopped/ended，不因 cleanup 失败回滚，也不再有 unhandled rejection。`DshPortHostInput.cancelTimeoutMs` 默认 **10_000ms**，`cancelSession` 把 `stopBackground + cancel + whenIdle` 包在 deadline race，超时抛 `Stopping the Session <id> did not settle within <ms> ms`。
- **P1-3 半失联心跳冻结**：`HttpNodePortOptions.commandTimeoutMs` 默认 **10_000ms**；`send()` 用 AbortController+timer 做总超时并合并 caller signal，超时错误含 command type/ms、不含 token。heartbeat 超时 → `markNodeOffline`，循环继续重试；节点恢复应答后 online。注意：默认超时是 10s，审计脚本的 180ms 等待仍显示 `online:true` 是预期；50ms 注入测试证明会 offline/恢复，不要写成“默认 10s 内立刻 offline”。
- **P1-4 Trigger 正文投递**：`NodeExecutorHost.inputText`；ControlPlane 用 `trigger.text` + meta 的 `title`/`goal`/`scope`/`note` 组装，`waitingText` 不再只认 text/note；审计消息现在包含 `Use the revised total 72 instead of 42.`。
- **P1-5 已读归属**：`AgentDelivery.send` 增加 `onDelivered` 回调——通过监听 DSH 的 `agent/inbox/spliced`（消息真正插入 inbox 时）触发，早于 `turn/start`；`followup`/`steer`/`inject` 返回后的回调只作无事件后端的兜底。重试命中 inbox pending 也调用；只在持久化历史已读（seen）不调用；插入前失败不调用。`DshPortHost.promptSession` 在调用前按 `dsh-superagent:<idempotencyKey>` 登记该次投递的 Input IDs，收到回调才 ready；`turn/start` 只取 ready 的 IDs。因此成功投递的第一轮 turn 就能带上 IDs，插入前失败不会带出，旧 Assignment 的迟到事件仍被 `record.assignmentId` 校验拒绝。`inputsRead(ticketId, inputIds, assignmentId?)` → `Assignments.read` 带 assignmentId 时必须 `running` 才写，控制面传 `record.assignmentId`，in-process executor 也传对应 Assignment。
- 验证：审计脚本输出 `unhandled:[]`、`stopFailure.error:"synthetic node cancel failure"`、cancel-hang `failed`；相关回归 **37 files / 299 tests 全过**，`pnpm typecheck`、`pnpm build` 通过。

### Phase 2 剩余风险与观察

- `RoleProfile.deny` 仍不单独消费，当前由 tools allowlist + `tools.guard` 覆盖（现有 PM/Worker 的 deny 名字都在各自 tools 外，行为正确）。
- token refresh 的 5min 宽限只覆盖 refresh 路由；超过 TTL+grace 且期间无工具调用的长任务仍失败，普通工具路由始终严格。
- cancel 的 10s deadline 与命令/心跳的 10s command timeout 是上限，不是精确检测时间；半失联节点可能在默认超时后才被标记 offline。
- 已读投递依赖事件/兜底契约：`onDelivered` 由 DSH 的 `agent/inbox/spliced` 在插入时触发；无该事件的后端只能靠 `followup` 返回后的回调兜底，若该后端在返回前就启动 turn，标记可能延后。宿主违反回调契约时也可能提前/延后，导致 `turn/start` 带错/漏带 IDs。
- PM 的 ensure role prompt 投递会自行开始 turn 1；这是“是否应静默投递”的产品决策，不是已修复缺陷。
- 强杀控制面后 `proper-lockfile` 的 30s stale 会让立即重启失败；正常 SIGTERM 不触发，未修复（P2-F/运维）。
- 节点重启后事件 `seq` 从 1 重新计数，`/v1/events?after=N` 的跨重启游标语义未定义。
- `Assignment.sessionId` 记录的是 `worker-<ticketId>`，而实际运行 Session 是 `worker-<assignmentId>`；这是现有行为，排障时以 `/v1/sessions` 和节点日志为准。
- TLS 直接实现、反向代理代码、控制面前端仍未做；`src/client` 是 DSH 面板，不是控制面 UI。

## 非目标

- 不在 Phase 2 重做产品 UI、Project Memory/RAG、Fast Router、父 Ticket/Dispatch/TaskSpec。
- 不做多节点调度/故障转移；单节点生产化稳定后再评估。
- 不改变已签收的 PM/Worker 业务语义；只补执行事实和运维能力。

## 验收总则

- `pnpm typecheck`、`pnpm build`、`git diff --check` 通过。
- 新增测试覆盖每个目标；全量测试不得新增非环境失败（当前本机基线约 44 个 Windows/依赖环境失败、13 个加载错误）。
- 真实 DSH 链路至少跑一次：控制面独立进程 + 节点 + 真实模型；保留 evidence JSON/日志。
- 每个目标单独提交，提交信息写清范围；不 push 前先确认。
- 任何安全相关变更（token、认证、TLS）必须单独列出威胁与回滚方式。

## 顺序

1. P2-A（token）和 P2-B（执行事实）先做，接口稳定后再动进程拆分。
2. P2-C（面板/SSE）可与 P2-B 并行，但不要同时改 `control-plane.ts` 的状态机。
3. P2-D 先做 spike：验证 DSH 宿主能否提供独立节点进程；结论写入 `docs/011` 后再实现。
4. P2-E、P2-F 收尾，最后跑真实链路和生产化验收。

## 证据

- 控制面/节点进程日志（脱敏）。
- PM/Worker/Ticket/Assignment/Session ID 与 Report JSON。
- SSE 重连前后事件序号。
- token 过期/刷新测试（含 P2-A2 的 `tv`/`tokenVersion`、旧 token 拒绝与 refresh 宽限）。
- control-plane viewer 401/403 与 SSE 14 客户端并发测试。
- 节点重启/失联对账记录。
