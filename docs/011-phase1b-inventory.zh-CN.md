# Phase 1B 依赖与写入盘点（1B-0 / 1B-1a / 1B-1b / 1B-2 / 1B-3a / 1B-3b / 1B-3c / 1B-3d 已完成）

本文件记录 1B-0 的结论，以及 1B-1a / 1B-1b / 1B-2 / 1B-3a / 1B-3b / 1B-3c / 1B-3d 完成后的边界。

## 1B-0：切流前的写入点

| 位置 | 写入 | 归属 |
| --- | --- | --- |
| `src/core/engine.ts` 及五个 Engine part | Trigger、Thread、Decision、Ticket、Project | 领域，Engine 唯一写入 |
| `src/app/store.ts` | SQLite、迁移、设置版本、outbox receipt、KV | Store |
| `src/app/outbox.ts` | receipt 与 `reply` effect | 控制面 |
| `src/app/settings.ts`、`prompts.ts`、`versions.ts` | 设置、Prompt、版本指针 | 控制面 |
| `src/app/sessions.ts` | Session prompt revision KV；Project `pendingNotes` | 边缘：Session 管理读取领域，少量写 Project |
| `src/executor/dsh.ts` | 通过 Engine 回调写 Ticket；`store.atomic` 只用于和 Engine 回调同一事务 | 节点，但当前直接持有 Store |
| `src/app/tools/*` | 通过 Engine 写；一小部分直接 `store.atomic` 包住 Engine 调用 | 节点/工具宿主 |
| `src/app/archive-reconcile.ts` | archive snapshot KV | 节点/归档协调 |

关键跨边界环：

```text
Engine -> Executor (start/deliver/stop)
Executor -> Engine (assignmentStarted/inputsDelivered/report/...)
Engine -> Assessor
Assessor -> Sessions (投递候选)
Sessions -> Store (读领域，少量写)
Outbox -> Sources
Settings -> Sessions (通知)
```

## 1B-1a / 1B-1b：已完成

- `ControlPlaneOwner` 拥有 Store 与 Engine；Runtime 只创建一次 owner，然后 `attach` Engine。
- `Runtime` 不再 `new Store` / `new Engine`。
- 新增 `ControlPlaneHost` 与 `NodeHost` 两个类型边界：
  - `ControlPlaneHost`：`control`、`store`、`engine`、`effects`、`outbox`；
  - `NodeHost`：`sessions`、`executor`。
- `Runtime` 同时实现两边的 host，现阶段仍在同一个进程内。
- 新增测试：
  - `tests/control-plane-owner.spec.ts`：owner 先开 Store，再 attach 唯一 Engine；
  - `tests/control-plane-boundary.spec.ts`：Runtime 不构造 Store/Engine，node 侧文件不构造它们，Runtime 实现两个 host。

## 1B-2：已完成

- `src/app/runtime.ts` 不再 import `@deepseek-ai/*`，也不再 import `executor/dsh.ts`；不 `new Sessions` / `new DshExecutor`，不持有、不传递 `platform.context`。
- 新增节点侧与 DSH-free 文件：
  - `src/node/dsh-node.ts`：`createDshNode` 在节点侧构造并持有 `Sessions` / `DshExecutor`，固定启动、取消与关闭顺序；
  - `src/node/platform.ts`：`runtimePlatform(ctx)` 把 Cordis Context 收在闭包里，向 Runtime 提供 logger、HTTP 注册、节点工厂、lifetime 以及 setup、archive、session 读取的窄端口；
  - `src/node/orchestrator-service.ts`：`OrchestratorService` 仍把 Runtime 注册为 `ctx.orchestrator`，供 Source 插件使用；
  - `src/app/source-trigger.ts`：DSH-free 的 `sourceTrigger`，Runtime 不再依赖 `executor/dsh.ts`。
- `Setup`、`Settings`、`ArchiveReconciler`、`Resources`、`tools` 改为窄端口/回调：logger、subprocess probe、`resolveRoleModel`、workspace activity/stop、`archivedSessionIds`、session events/model catalog、tool logger。
- `Runtime` 的 `ctx` 兼容属性只由测试通过 `RuntimeOptions.ctx` 注入；生产不持有 Context，也不把它传给任何控制面组件。
- 测试更新：`tests/runtime.spec.ts`、`tests/model-surface.spec.ts`、`tests/fixtures/host.ts` 改用 `new Runtime(runtimePlatform(ctx), ...)`；`tests/control-plane-*` 继续覆盖边界。

## 1B-3a：已完成

- `src/app/resources.ts`、`src/app/tools/main.ts`、`src/app/tools/executor.ts`、`src/app/archive-reconcile.ts` 不再 import `@deepseek-ai/*`，也不再 import `executor/dsh.ts`。
- 新增 DSH-free helper：
  - `src/app/tool-messages.ts`：`triggerMessage`、`batchOf`、`inputMessage`（连同 `batchLine`、`inputResource`、`capped`）从 `executor/dsh.ts` 原样移出；`executor/dsh.ts` 继续 re-export，原调用方不变；`cards.ts`、`links.ts`、`notices.ts` 改为从这里导入。
  - `src/app/session-view.ts`：DSH-free 的 `SessionEventView` 会话事件窄视图、`transcriptEntry`（原在 `context.ts`，那边保留 re-export）与 `currentTurnUserMessage`。
- 类型收窄方式：
  - `resources.ts` 的 `ResourceHost.sessionEvents`/`modelCatalog` 返回窄视图（`SessionEventView`、`ModelCatalogView`）；
  - `tools/main.ts` 的 `Agent` 换成局部 `MainSessionAgent`（`id` + `session.snapshotEvents()`），`assessor.read` 的 Session 参数同步收窄；
  - `archive-reconcile.ts` 的 `ticketOfSession` 改从 `core/index.ts` 导入；`tools/executor.ts` 删除未用的 `SessionId`。
- 新增 `tests/app-dsh-boundary.spec.ts`：扫描上述四个文件与两个新 helper，断言无 `@deepseek-ai/`、无 `executor/dsh`。
- 剩余 `src/app` 直接 import DSH 的文件：`api.ts`、`assessment.ts`、`delivery.ts`、`http.ts`、`role-models.ts`、`sessions.ts`（受保护/后续阶段），以及 `executor/dsh.ts`；`src/app` 中仍 import `executor/dsh.ts` 的只剩 `http.ts`（type）与 `sessions.ts`。

## 1B-3b：已完成

- Session 记录落库：`SessionRecord` 存进现有 SQLite `kv` 表，键族 `KV.control.session`（`control/session:<sessionId>`），未改数据库 schema。
- `ControlPlane` 构造时先遍历 `store.keys(KV.control.session)` 加载已有记录；创建 PM/Worker、Session 状态变化、归档时写回。
- 重启恢复：`close()` 后用同一 dbPath、同一 node 新建 `ControlPlane` 能读回记录；对已加载的 PM 调 `sendMessage` 会按需重签 token 并继续发送；归档状态跨重启保留（`archivedAt` 由归档事件时间补齐）。
- token 仍只在内存、不落库；重启后按需重新签发。
- 新增 `tests/control-plane-persistence.spec.ts`，覆盖创建/重启加载/token 重签/归档持久化。
- 剩余风险：
  - 恢复假设同一个 node 仍持有 Session；`openProject` 命中已加载记录时直接返回，不重新发 `pm.ensure`，真实 node 重启后 PM 不会自动恢复。
  - 重签的 token 只进内核内存，`session.message` 协议不带 token，真实 node 上的旧 token 会沿用到过期。
  - 每条 Session 事件都会写一次 KV（含消息引发的 running/idle），存在写入放大；当前量级可接受。

## 1B-3c：已完成（传输与进程拆分；真实 DSH 适配留 Phase 2）

- 新增节点 HTTP 传输：
  - `src/node/http-server.ts`：`startNodeHttpServer` 把任一 `NodePort` 暴露为 `POST /commands` 与 SSE `GET /events`，带 bearer 鉴权、256 KiB 请求体上限、15 秒 keepalive 和公开的 `/health`；
  - `src/control/http-node.ts`：`HttpNodePort` 实现控制面侧 `NodePort`，每条命令一个 `POST /commands`，每个订阅一条 `/events` SSE 流，并使用节点自己的 bearer token（不是控制面 API token）。
- 新增独立节点进程 `src/node/main.ts`（构建为 `lib/node.js`）：读 `SUPERAGENT_NODE_TOKEN`、`SUPERAGENT_NODE_PORT`、`SUPERAGENT_NODE_HOST`、`SUPERAGENT_NODE_ROOT`、`SUPERAGENT_NODE_ID`，当前仍托管 `FakeNode`；`package.json` 增加 `node` 脚本。
- `src/control/main.ts` 支持 `SUPERAGENT_NODE_URL` + `SUPERAGENT_NODE_TOKEN`：设置后走 `HttpNodePort`，否则仍用进程内 `FakeNode`；`tsdown.config.ts` 增加 `control`/`node` 两个入口。
- 新增 `tests/node-http.spec.ts`：PM/Worker 生命周期经 HTTP 驱动并回放 SSE 事件、鉴权与非法命令 400、事件扇出与退订；1B-3c 定向测试 31/31 通过。
- 剩余边界：
  - `src/node/main.ts` 仍是 `FakeNode`；真实 DSH 适配后来由 1B-3d 的 `DshNodePort` 在 DSH 插件进程内完成（见下节），`lib/node.js` 独立节点进程仍托管 FakeNode。
  - SSE 无重连/seq 回放：断线期间的事件不补发，订阅方需自行重连。
  - 明文 loopback HTTP：仅适合本机或受信网络，跨机需 TLS 或隧道。
  - 跨进程默认根目录要显式对齐：控制面的 `SUPERAGENT_WORKSPACE_ROOT` 默认在 `.superagent-control/workspaces`，节点默认 `SUPERAGENT_NODE_ROOT` 是 `.superagent-node`，两者必须指向同一工作区树，否则节点会拒绝越界 workspace。
  - `session.message` 协议仍不带 token，节点上的旧 token 会沿用到过期。

## 1B-3d：已完成（真实 DSH NodePort 适配）

- `src/node/dsh-port.ts`：`DshNodePort` 把 `NodeCommand` 映射到窄 `DshPortHost` 调用，并把 host 事件封成带 `nodeId`/`seq`/`at` 的 `NodeEvent`；不 import 任何 DSH 模块，可用 fake host 单测。
  - `node.register`/`node.heartbeat` → 发布 `node.status`；`workspace.ensure`/`project.bind` → 在 node root 下创建并校验目录；
  - `pm.ensure`/`worker.create` → `host.ensureSession`（role、workspace、title、role prompt）；
  - `session.message` → `promptSession`（携带幂等键）；`session.cancel`/`session.archive`/`permission.set` → 对应 host 调用；
  - 每个 port 实例按 `idempotencyKey` 至多执行一次，校验协议版本，workspace 逃逸 node root 一律拒绝。
- `src/node/dsh-port-host.ts`：`createDshPortHost` 是唯一的 DSH 传输适配层（`@deepseek-ai/*` 只在这里出现）：
  - `ensureSession` 用 `Sessions.ensure` 建/恢复 Session，再用 `Sessions.prompt(profile:<sessionId>, 'queue')` 安装一次角色 prompt；
  - `promptSession` 调 `Sessions.prompt(..., 'queue')`（底层 async，但 host 接口为 `void`，失败只记日志）；
  - `cancelSession` 用 `ctx.agents.get(id)?.cancel({ kind: 'user' }, { keepInbox: true })`；
  - `archiveSession` 用 `workspaceRegistry.archiveSession(id, { stopActivity: true })`；
  - `setPermission` 用 `permissionPresets.set(agent.session, permission)`，agent 未加载时直接抛错；
  - 事件映射：`agent/created`、`agent/status`、`agent/error`，以及 `session/event` 中的 `turn/start`、`turn/end`、`user/message`、`assistant/message`。
- `src/index.ts`：仅当 `SUPERAGENT_NODE_TOKEN` 与 `SUPERAGENT_NODE_PORT` 同时设置时，才在插件启动后为该进程的 `nodeRuntime` 启动 `DshNodePort` + `startNodeHttpServer`；二者未设置时不开端口、现有行为不变。setup 未完成时跳过并告警；端口启动失败只记日志，不阻塞插件。
- 新增 `tests/dsh-port.spec.ts`：9 个测试（含 `DshNodePort` 在 `startNodeHttpServer` 后的 HTTP/SSE 集成）；typecheck/build 通过。
- 剩余边界：
  - `setPermission` 对未加载的 agent 会抛错（控制面收到 400）。
  - `Sessions.prompt` 是 async，而 host 的 `promptSession` 是 `void`：投递失败只记日志，不向控制面回报。
  - 事件只映射 turn、用户/助手消息、错误与 agent 状态；模型流、工具调用等其余 DSH 事件不跨边界。
  - `lib/node.js`（`src/node/main.ts`）仍是 FakeNode；真实 DSH node 目前由 DSH 插件进程内的 `src/index.ts` 启动，独立节点进程尚未接入 `DshNodePort`。
  - 节点根目录需与控制面 workspace 对齐（`SUPERAGENT_NODE_ROOT`，插件内默认 `<stateDir>/node`）。
  - 幂等键与事件 `seq` 只在内存中保存，不跨进程/重启持久化：重启后同一命令可能再次执行，`seq` 也从零重新计数。

## 1B 幂等/重试修复：已完成

- 失败可重试：`ControlPlane.openProject`/`createWorkerSession` 遇到 `failed` 或未确认的 `starting` 记录时不再直接返回，而是复用原记录身份（`createdAt` 不变），重置为 `starting`、重签 token、持久化并重新发送 ensure；`ControlPlaneServer` 对返回 `failed` 记录的 PM/Worker 创建请求返回 502（ensure 直接抛错时仍为 500）。
- 命令 key：心跳、消息、cancel、archive、permission 的幂等键改为 `前缀:scope:进程UUID:序号`（`uniqueKey`），固定时钟下也不会重复；ensure/bind/register 首次创建仍用稳定逻辑 key，重试/确认改用 `*-confirm` 新 key（见下节）。
- 节点侧幂等：`DshNodePort.send` 用 `done`（已成功的 key）与 `inflight`（运行中的 key→Promise）实现——已成功的 key 直接确认，运行中的并发同键共享同一个 Promise，只有成功的 run 进入 `done`，失败的 key 保留可重试；`ensureSession` 安装角色 prompt 仍用稳定的 `profile:<sessionId>` key。
- 新增回归测试：`tests/control-plane-retry.spec.ts`（5 个）、`tests/dsh-port-idempotency.spec.ts`（5 个）。
- 剩余风险：
  - `done`/`inflight`、`instanceId`/`sequence` 都只在内存，不跨进程/重启持久化：控制面重启后同一逻辑动作会拿到新 key，节点可能再次执行；节点重启后 `seq` 从零、去重表清空。
  - 502 只在控制面拿到 `failed` 记录时返回；ensure 抛错（例如 HTTP 节点拒绝）仍以 500 暴露给调用方。
  - `done` 集合随进程生命周期只增不减，长期运行时需关注内存增长。

## 1B 回执丢失修复：已完成

- `NODE_CONFIRMED` 状态集合：`idle`、`running`、`stopping`、`stopped`、`archived` 表示节点已确认 Session 生命周期；记录处于这些状态时 `openProject`/`createWorkerSession` 直接返回，ensure 之后抛出的传输错误也不会把它覆盖成 `failed`。
- 只有仍 `starting` 才失败：`settleEnsureFailure` 以节点在命令 pending 期间同步上报的状态为准；记录已被节点改为 `idle`/`failed` 等非 `starting` 状态时保留并持久化该状态，只有完全没有状态确认、仍为 `starting` 时才置 `failed` 并重新抛错。
- 命令 key：首次创建用稳定 key（`workspace:<projectId>`、`project-bind:<projectId>`、`pm-ensure:<projectId>`、`worker-create:<assignmentId>`）；失败或 `starting` 记录的重试/确认改用带 `*-confirm` 的新 key（`workspace-confirm`、`project-bind-confirm`、`pm-ensure-confirm`、`worker-create-confirm` + 进程 UUID/序号），避免节点静默 ack 已完成的旧 key 后记录永远停在 `starting`。
- 重启恢复：从 SQLite 加载的 `starting` 记录不直接返回，而是重签 token 并用 `*-confirm` key 重新 ensure；只有节点确认后的状态才视为完成。
- HTTP：节点先报 `idle` 再丢回执 → 200（返回 idle 记录）；节点报 `failed` → 502；完全没有状态 → `failed` 抛错（500）。
- 新增 `tests/control-plane-lost-ack.spec.ts`（8 个）；1B 定向测试共 33 个通过。
- 剩余风险：
  - 真实 DSH 对已存在的 Session 重发 ensure 不保证再发一次状态事件，记录仍可能停在 `starting`（HTTP 返回 200 但状态未确认）。
  - 彻底解决需要协议层状态查询或显式 ack；当前 `NodePort` 只有 `send`/`subscribe`。

## 1B 跨层修复：已完成

- `session.inspect` 显式确认：`NodePort.inspect?` 可用时直接调用，否则 `ControlPlane` 走协议命令 `session.inspect`（请求 id 即幂等键，节点用 `session.inspected` 事件回传，带超时回退）。`confirmExisting`/`settleEnsure`/`recoverEnsureFailure` 在重试或缺少状态事件时以 inspection 的 `found`/`status`/`ready` 为准；`starting` 记录永不作为成功返回，只有 `NODE_CONFIRMED` 且 `ready !== false` 才算确认。
- 单飞：同一 Session 的并发 `openProject`/`createWorkerSession` 共享 `pendingEnsures` 中的同一个 Promise，节点只收到一次 `pm.ensure`/`worker.create`。
- 角色安装失败 502：`createDshPortHost` 记录每次 ensure 的 `ready`/`error`；即使 agent 已报 `idle`，角色 prompt 安装失败时 inspection 仍返回 `ready:false`，控制面置 failed 并抛 `SessionEnsureError`，HTTP 返回 502。
- 消息/归档结果不再静默成功：`promptSession` 把 `Sessions.prompt` 的拒绝向上返回，消息被节点拒绝时命令失败、HTTP 不再回 `{sent:true}`；`archive` 只在 host 归档成功后发布 `archived` 状态，控制面收到成功回执后本地记录 `archived`/`archivedAt`，即使状态事件丢失也不会停在旧状态。
- 未知/非法命令：节点先 `validateNodeCommand` 再执行；不支持的协议版本与未知命令 → 400，字段非法（含 workspace 越界）→ 422，执行失败 → 500（`NodeCommandError` 分类）；普通 host 错误由 `DshNodePort` 包装为 `execution-failed`。
- 启动 fail-fast：`startControlPlane` 先建 kernel/server、注册节点，成功后才 listen；注册失败会关闭 server 与 control（含数据库锁）再把错误抛出，`control/main` 以非零退出，不会留下半启动的 API。
- `NodeExecutor`：`ControlPlane` 构造时把它注入 Engine；`start` 为 Assignment 创建 `worker-<assignmentId>` Worker Session，成功后回调 `assignmentStarted`、失败回调 `assignmentFailed`；`deliver` 把待投递的 text/note 拼成一条消息（无文本则 `NO_TEXT`）；`stop` 取消 Worker Session；无 `projectId` 的 Ticket 明确失败。
- 测试：crosslayer 12、executor 6、node-command-results 21、lost-ack 8、retry 5、dsh-idempotency 5、control-plane-tools 14、http-node-inspect-timeout 3（按实际计数）。
- 剩余边界：
  - 真实 DSH Agent + 真实模型的 PM 建单 → Worker 执行 → Report 回写同一 Ticket/Assignment 尚未在真机跑通；
  - `inputsRead` 与模型 turn 细节未回写；
  - stop cleanup（Worker 侧后台清理）未完成；
  - Session token 默认 1h 且无刷新通道；长任务 Report 可能 401。

## 1B 并发与 inspect 超时修复：已完成

- `openProject`/`createWorkerSession` 在检查已有 confirmed 记录之前先检查 `pendingEnsures`；同一 Session 的并发请求 await 同一个在途 Promise，不会再提前返回 200。
- `HttpNodePort.inspect` 的超时覆盖整次操作：建立 SSE、POST `/commands`、等待 `session.inspected` 共用一个 AbortController；超时先 abort 再 reject，并清理 reader/listener/timer，不产生未处理拒绝。
- 新增 `tests/http-node-inspect-timeout.spec.ts`（3 个）与 crosslayer 并发用例。

## 1B 任务内容与 inputs：已完成

- `NodeExecutor.taskPrompt` 从 Ticket 的来源 Trigger `meta` 读取 `title/goal/scope/note`，并附 `execution.assignment` 与来源文本；Worker 首条消息不再只有标题。
- `NodeExecutor.deliver` 只投递当前 `ticket.undelivered` 中的 text/note，成功后调用 `inputsDelivered` 清空；失败保留 undelivered，不重复发送历史。
- 新增 executor 的 prompt/inputs 用例。

## 1B 工具桥：已完成

- 控制面新增 `/v1/tools/pm/tickets` 与 `/v1/tools/worker/report`，只认 Session token（`verifySessionToken` + Session 记录存在、`pid/role/aid` 一致）。
- PM：`control_create_tickets` → `engine.createProjectTickets`；Worker：`control_report` → `engine.report`，回写原 Ticket/当前 Assignment。
- `DshPortHost.ensureSession` 在 Session 上注册 `control_create_tickets` / `control_report`；RoleProfile prompt/tools 增加这两个名字；`SUPERAGENT_CONTROL_URL` 存在时才注册。
- 新增 `tests/control-plane-tools.spec.ts`（14 个），覆盖 token/角色/Assignment/Ticket 校验与工具 HTTP 调用。
- 未覆盖：真实 DSH + 真实模型端到端；token TTL 刷新。

## 1B PM 上下文读取工具：已完成

- 控制面新增 `ControlPlane.pmContext(sessionId)`：用 Session 记录确认 role=pm 且该 Session 就是 Project 的 `pmSessionId`，返回只读摘要 `{ project: { id, title, goal, status, pauseMode?, latestReport? }, tickets: [{ id, title, status, assignment?: { id, state, report? } }] }`；不含 Mandate、token、内部 actor，也不返回其他 Project 的 Ticket。
- Ticket `status` 由现有数据推导，取值 `open|running|blocked|failed|completed|stopped|archived`：archived 优先于 ended；ended 的 `completed`/`merged` 记为 `completed`，其余 outcome 记为 `stopped`；未结束的 Ticket 按最近 Assignment 的 report（blocked/failed 且仍等待人）、operator stop / manualStop、运行中的 Assignment 依次判定，否则为 `open`。
- HTTP 新增 `GET /v1/tools/pm/context`，走现有 `verifyToolToken`、要求 role=pm，调用 `pmContext(claims.sid)`，错误映射沿用工具路由（401/403/400）。
- `DshPortHost` 按角色注册工具数组：PM 注册 `control_project`（新增，无参数，GET 读取）与 `control_create_tickets`；Worker 仍只有 `control_report`。新增 GET 请求走统一的 `requestControl`，错误传播与 POST 一致；GET 不携带 body（`fetch` 拒绝 GET 带空字符串 body）。
- `PM_PROFILE` prompt 明确“用 `control_project` 读取本 Project 及其 Ticket，用 `control_create_tickets` 建单”，tools 增加 `control_project`；节点在角色 prompt 后追加的说明同步为同一句。
- `tests/control-plane-tools.spec.ts` 增加到 18 个：PM 上下文读取（自己的 Project/Ticket、不含其他 Project、Worker token 403）、Ticket 状态推导（running/blocked/completed/archived）、`control_project` 注册与 GET 调用（Bearer token、无 body）、拒绝错误传播。

## 1B PM 远程读取：已完成

- 新增 `GET /v1/tools/pm/context`：只认 PM Session token，返回 token 所属 Project 的安全摘要和已有 Ticket 的 id/title/status/latest assignment；不返回 Mandate、token 或内部 actor。
- PM Session 新增 `control_project` 代理工具（GET），与 `control_create_tickets` 一起注册；RoleProfile prompt/tools 同步。
- 新增 control-plane-tools 用例：PM 读自己的 Project/Tickets、不读别的 Project、Worker token 403、控制面 token 401，以及 `control_project` 的 GET/URL/token 传播。
- 这解决了 PM 首轮被要求读取 Project/Tickets 却没有远端读取工具的缺口。

## 1B 真实 DSH 全链路：通过

- 使用隔离 DSH profile、独立控制面进程、真实 DSH 插件和真实模型 `opencode-go/deepseek-v4.1-flash` 完成：
  - PM 首轮通过 `control_project` 读取 Project/Tickets，并产出 Project report；
  - PM 通过 `control_create_tickets` 建单；
  - NodeExecutor 创建 Worker Session；
  - Worker 通过 `control_report` 以 `ready` 回写同一 Ticket/当前 Assignment，Ticket completed。
- 证据：`.artifacts/phase1-live-run-BzkxEa/acceptance.json`（ticket `ec8bb645…`、assignment `39801d00…`、report `ready`）。
- 仍属 Phase 2：独立 DSH 节点进程、token 刷新、`inputsRead`/turn 细节、stop 清理、生产面板认证/TLS/SSE 重连。

## 1B 模拟 DSH 全链路：已完成

- 新增 `tests/control-plane-e2e.spec.ts`（2 个）：
  - PM tool API 建 Ticket → NodeExecutor 创建 `worker-<assignmentId>` → 检查 Worker 首条 prompt 含 Ticket/Goal/Scope/Note → Worker tool API `ready` Report 回写同一 Ticket/Assignment，Ticket 完成；
  - 错误 Assignment 的 Report 返回 400/403，Ticket 不变。
- 这是模拟 DSH 宿主 + 真实 `ControlPlaneServer`/fetch/FakeNode 的链路，不是真实模型端到端。
- 仍未覆盖：真实 DSH Agent + 真实模型、token TTL 刷新、`inputsRead`/turn 细节、stop cleanup。

## 还没做（Phase 2）

- `src/app/assessment.ts` 仍有 DSH 的 `Agent` 类型依赖（`orchestrator_eval_read` 的图片投递需要真实 Agent），下一步继续收窄。
- 进程入口已拆出（`lib/control.js` / `lib/node.js`），但独立节点进程默认仍用 FakeNode；真实 DSH NodePort 已由 1B-3d 在插件进程内提供，面板认证、TLS/SSE 重连与生产级部署属于 Phase 2。
