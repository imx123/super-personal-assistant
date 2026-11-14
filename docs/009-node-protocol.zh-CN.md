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

- `NodeCommand` 是控制面发给节点的判别联合：注册、心跳、项目绑定、PM/Worker 创建、消息、取消、归档、状态查询、权限、工作区。
- 每条命令带 `protocolVersion`、`nodeId`、`idempotencyKey`、`at`；节点必须对重复的幂等键最多执行一次。
- 创建 Session 的命令必须带 `sessionToken`；`session.message` 可选携带控制面当前 token。节点把它当作不透明字符串，不解析、不记录、不本地验签（节点没有 secret），只透传给工具层。
- `NodeEvent` 是节点回传的事件：节点状态、Session 状态、Session 事件、状态应答、工具调用。
- 事件带 `seq`，控制面用它检测丢事件和排序。
- `session.inspect` 要求节点回一条 `session.inspected`，`requestId` 回显命令的 `idempotencyKey`；应答带 `found`、可选 `status`、`backendSessionId` 和 `ready`。`ready=false` 表示 Session 已存在但角色提示词/工具安装失败，控制面必须按失败处理，不能因为收到过 `idle` 就当成功。
- 显式状态查询是控制面确认 `starting`/`failed` 记录的唯一无损手段：命令回执和第一次状态事件都可能丢失，重发命令不足以证明 Session 的真实状态。
- `session.message` 和 `session.archive` 只在后端真正接受/完成后回执；投递或归档失败必须让命令失败，控制面不会把 HTTP 200 当作成功。

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
