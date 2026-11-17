# 节点协议

本文只定义控制面与执行节点之间的最小契约；不描述具体后端。

## 边界

```text
控制面                         执行节点
  Store / Engine / Policy   →   Session / Workspace / Permission
  NodePort.send(command)    →   后端（当前 DSH，未来 Claude/Codex）
  NodePort.subscribe(event) ←   NodeEvent
```

- 控制面是唯一业务写入方；节点不能写 Ticket、Project、Assignment 或 Memory。
- 节点只负责 Session 生命周期、工作区、权限、工具宿主和事件回传。
- 现在只实现 DSH；`BackendKind` 已为 Claude Code / Codex 预留，但不改变契约。

## 命令与事件

- `NodeCommand` 是控制面发给节点的判别联合：注册、心跳、项目绑定、PM/Worker 创建、Router 创建、消息、取消、归档、状态查询、权限、工作区、只读代码审阅（`review.diff`）。
- 每条命令带 `protocolVersion`、`nodeId`、`idempotencyKey`、`at`；节点必须对重复的幂等键最多执行一次。
- 创建 Session 的命令必须带 `sessionToken`；`session.message` 可选携带控制面当前 token。节点把它当作不透明字符串，不解析、不记录、不本地验签（节点没有 secret），只透传给工具层。
- `NodeEvent` 是节点回传的事件：节点状态、Session 状态、Session 事件、状态应答、只读代码审阅结果、工具调用。
- 事件带 `seq`，控制面用它检测丢事件和排序。
- `router.ensure` 为控制面的 Router 创建独立会话。命令包含 `sessionId`、工作区、角色 profile、`sessionToken` 和提示词。`dsh-superagent-router` 预设下的代理工具允许它查进度、建项目、派独立工单、管理工单或项目和提交 PM 转发提议。工具契约见 `src/control/roles.ts`。旧版本节点可能拒绝该命令。
- **`control_router_pm_proposal` 只提交提议，不投递**：`control_router_pm_instruction` 这个名字已经不用了——旧的那个名字是「直接转达」，会让人以为 Router 自己就能把话送到某个项目的 PM。现在这个工具只在控制面里记下一条**待确认的转发提议**（目标 Project、真正会发出去的原文、提议 id），真正发送要等人在控制台里确认，Router 的 token 开不了那条确认端点。节点侧的工具名、profile 的提示词与控制面的端点是一起改的，旧节点不认识新工具名就等于没有这条写路径。
- **对外的 `seq` 是控制面自己的序号**，不是节点的：节点重启会从 1 重新计数，而控制面把每条事件写进自己的持久日志，序号跨控制面重启单调递增。客户端看到的 `seq` 一律是控制面的序号，`after=` / `Last-Event-ID` 用它续接；节点自己的计数以 `nodeSeq` 保留在同一条事件里，所以节点重启仍然看得见（`nodeSeq` 变小即节点重启过）。
- 日志有界（默认 20000 条 / 7 天）。被裁掉的那一段用 `gap` 明确告知（`GET /v1/events` 返回 `gap: true`，SSE 写一条 `: gap` 注释），不会悄悄少一段。
- `tool.call` 事件在**记录与广播时都不带 `args`**：工具入参是模型自己的输入，可能含人粘贴进去的密钥。审计里另有该次工具调用的记录（只有工具名）。
- `session.inspect` 要求节点回一条 `session.inspected`，`requestId` 回显命令的 `idempotencyKey`；应答带 `found`、可选 `status`、`backendSessionId` 和 `ready`。`ready=false` 表示 Session 已存在但角色提示词/工具安装失败，控制面必须按失败处理，不能因为收到过 `idle` 就当成功。
- 显式状态查询是控制面确认 `starting`/`failed` 记录的唯一无损手段：命令回执和第一次状态事件都可能丢失，重发命令不足以证明 Session 的真实状态。
- `session.message` 和 `session.archive` 只在后端真正接受/完成后回执；投递或归档失败必须让命令失败，控制面不会把 HTTP 200 当作成功。
- **`schedule.run` 是控制面自己发的一条事件，不是节点回传的**：一次定时运行结束时控制面把它写进自己的事件日志并推给 SSE，客户端因此能在**现有的事件流**上看到后台触发的定时任务。节点永远不报这种事件，协议版本也不因此往上抬。事件里只有这次运行的 id、计划 id、结果与失败原因，没有消息正文，也没有任何凭据。

## 只读代码审阅（`review.diff`）

- 命令只带 `projectId`，**不带路径、不带 Git 参数**：节点读它自己为该项目绑定的工作区（`workspace.ensure`/`project.bind`/`pm.ensure` 时记录），命令里任何别的字段都被忽略。调用方无法指定目录，也无法指定要跑的 Git 命令。
- 节点用固定 argv、无 shell 的方式执行只读 Git 命令：仓库根核对、基线核对（`rev-parse --verify HEAD`）、工作区对基线的 diff（`--no-ext-diff --no-textconv`）、空白检查（`diff --check`）和未跟踪文件的**文件名**（`ls-files --others`）。每条命令有超时与输出上限，整次审阅有总预算（默认 8s），环境变量从零构造（不带 `GIT_DIR`/`GIT_WORK_TREE`/`GIT_CONFIG_*`，系统与全局配置关闭），因此宿主的环境、操作员的全局配置、外部 diff 程序与 textconv 过滤都进不来。
- **Git 程序固定**：在 `PATH` 的绝对目录里找一次 `git`（Windows 只认 `git.exe`），之后每条命令都用这个绝对路径执行；`PATH` 里的相对项不搜，工作区放自己的 `git` 抢不到前面。每条命令还带 `-c core.fsmonitor=false`（明确关掉文件系统监视器）与 `-c core.pager=cat`，这两项与 `--no-ext-diff`/`--no-textconv` 一样压过仓库本地配置。
- **仓库自己的配置由节点读**：节点自己解析 `<workspace>/.git/config`（以及 `config.worktree`），凡是**会被审阅的命令读到或跑到的**外部程序与项目外路径（`alias.*`、`credential.*`、`filter.*`、`include.path`/`includeIf.*`、`diff.external`、`diff.*.command`、`diff.*.textconv`、`core.attributesFile`/`core.excludesFile`/`core.hooksPath`/`core.worktree`、`core.sshCommand`/`core.gitProxy`/`core.askPass`/`core.editor`/`core.sequenceEditor`、`gpg.program`/`gpg.ssh.program`、`diff.orderFile`）一律**拒绝**这次审阅；审阅命令走不到的配置（remote、branch、submodule、user 身份）留着不动。仓库布局也要核对：`.git` 必须是工作区自己的目录（指向别的仓库的 `.git` 文件或链接拒绝）、`commondir` 不存在、`objects` 在仓库之内、`objects/info/alternates` 为空。
- 节点回一条 `review.diff` 事件，`requestId` 回显命令的 `idempotencyKey`，内容是 `ReviewDiffResult`：`status`（`ok`/`truncated`/`no-repository`/`no-baseline`/`refused`/`timeout`/`failed`）、基线提交、diff 文本、涉及的文件、未跟踪文件名、空白问题、`complete`（辅助命令没跑完时为 `false`）、`reason`。
- **这条事件不进事件历史**：控制面收到它就只交给那次被授权的请求，不记进 `GET /v1/events`、不推给 SSE、不进通知与日志；回传要核对请求 id、节点 id 与 Project id。
- 边界：工作区必须是**自己那个仓库的根**（只落在某个父仓库里的目录被拒绝，审阅不向上爬），真实路径必须落在节点根之内，外部 diff/textconv/可配置外部执行路径全部关闭。
- 语义边界：结果只是**共享工作区的一个快照**，无法证明哪个 Worker 改了哪个文件，也无法显示“改了又改回去”的变更。

## SessionRecord 与状态查询

`SessionRecord` 以 `sessionId` 为主键；`backendSessionId` 是后端自己的 resume id（DSH session id 等），只用于恢复同一段会话，从不替代 `sessionId`。

`nodeGeneration` 记录该 Session 最近一次 ensure 被确认时所在的节点代次：

- 控制面启动、节点 `offline → online`、SSE 事件流重连都会轮换代次；
- ensure 确认时写入当前代次；代次过期的记录在 `openProject`/`createWorkerSession` 以及 `session.message` 前先 re-ensure（Worker 用 assignment→ticket/assignmentId 回退）；
- `stopped`/`archived` 是终止状态，不因代次轮换被复活；
- 字段可选，旧记录加载后视为过期，不会被当成当前代次。

`tokenVersion`（可选）是该 Session 的 token 版本：refresh 时自增并持久化，旧记录没有该字段按 0 处理。普通工具路由只接受当前版本；refresh 路由额外接受上一版（`current - 1`）一次。这样刷新后的旧 token 不能再打开普通工具，但仍可在宽限内自续一次。

`session.inspect` 的 `SessionInspection` 约定：

- 节点有 live Agent：`found:true`，带 `status`（`idle`/`running`/`archived`）、`backendSessionId` 和 `ready`；`ready:false` 表示角色提示词/工具安装失败，控制面必须按失败处理。
- 没有 live Agent、但后端持久化中存在该 Session：`found:true`、`backendSessionId`，**不带 `status`**。这是“已持久化但未挂载”的准确表达；控制面必须据此 re-ensure，不能把无 `status` 当作不存在，也不能把它当作 `idle`。
- 持久化中也不存在：`found:false`。
- 其他读取错误：节点抛出，不伪装成 `found:false`；`sessionQuery` 的 observation lease 随即释放，不能长期 pin 住 prepared Session。

## Session Token

控制面签发短期 HMAC-SHA256 token，claims 包含：

- `sid`：控制面内部 Session id；
- `pid`：Project id；
- `aid`：Worker 的 Assignment id（PM/Scout 没有）；
- `role`：`pm` / `worker` / `scout`；
- `backend`：`dsh` / `claude` / `codex`；
- `tv`：token 版本，与 `SessionRecord.tokenVersion` 对应；无 `tv` 的旧格式 token 按 malformed 拒绝；
- `nodeId`、`iat`、`exp`。

工具调用只从验证后的 token 取得这些字段，**不信任工具参数里的 `sessionId` 或 `projectId`**。token 本身不写入 `SessionRecord`（只持久化 `tokenVersion`），也不写日志。

token 可续期：`POST /v1/tools/token/refresh` 用当前 Session token 换一个新版本 token。刷新会自增 `tokenVersion` 并持久化，同一秒内刷新的 token 也不同；普通工具/消息路由要求 `tv === tokenVersion`，被取代的旧 token 返回 401。refresh 路由自己接受 `current` 或 `current - 1`，并默认允许已过期不超过 300 秒的 token 自续一次（`SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS` 可覆盖，`0` 关闭）；超过宽限或普通路由上的过期 token 仍是 401。节点没有 secret，因此 `session.message` 携带的 token 只用于更新工具凭据，真正的验签仍在控制面 `/v1/tools/*`。

## 工具上下文

`ToolContext` 是工具处理器的唯一身份来源。以后接 MCP 时，MCP server 只是换一个 transport，仍然先验证同一个 token，再把 `ToolContext` 交给同一个 handler。

## 三条规则

1. 控制面唯一业务写入；节点只报告事实。
2. PM/Worker 的工具上下文来自 session token，不来自参数。
3. MCP 是未来的 transport，不是新的业务层。
