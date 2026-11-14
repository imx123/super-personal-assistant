# 控制面内核

本阶段新增一个可独立运行的控面内核；现有 DSH 插件行为不变。

## 边界

```text
ControlPlane
  Store / Engine / Policy / domain state
  Session records + session tokens
  NodePort.send / subscribe
        │
        ▼
FakeNode（现在）/ DSH 节点（Phase 2）
```

- 控制面拥有业务状态；FakeNode 只记录 Session、消息、权限和事件。
- 没有 DSH import：`src/control` 与 `src/node` 可单独构建。

## Phase 1B 的进程内接线

`ControlPlaneOwner`（`src/control/owner.ts`）拥有 Store 和 Engine，`Runtime` 不再自己 `new Store` / `new Engine`：

```text
Runtime
  ├─ ControlPlaneOwner（Store + Engine）
  ├─ ControlPlaneHost（control/store/engine/effects/outbox）
  └─ NodeHost（sessions/executor）
```

当前仍是同一进程、同一个插件入口；Phase 1B 只切所有权，不切进程。`lib/control.js` 现在也可与真实 DSH 节点分进程运行（P2-D，见 `docs/013`、`docs/014`）；面板认证等仍在后续阶段。

## 运行

```bash
pnpm build
SUPERAGENT_CONTROL_TOKEN=replace-me pnpm control
```

可选环境变量：

- `SUPERAGENT_CONTROL_DB`：SQLite 文件，默认 `<node root>/control.sqlite`
- `SUPERAGENT_NODE_ROOT`：节点根目录，默认 `./.superagent-control`
- `SUPERAGENT_WORKSPACE_ROOT`：项目工作区根，默认 `<node root>/workspaces`
- `SUPERAGENT_CONTROL_HOST` / `SUPERAGENT_CONTROL_PORT`
- `SUPERAGENT_NODE_ID`

启动后 `/health` 公开；`/v1/*` 需要 `Authorization: Bearer <token>`，但 `/v1/tools/*` 例外：它只接受控制面签发的 Session token（PM/Worker 的工具凭据），不认操作员 token。

## 最小 API

```text
GET  /health
GET  /v1/state
GET  /v1/projects
GET  /v1/tickets
GET  /v1/sessions
GET  /v1/sessions/:id
GET  /v1/events?after=<seq>
GET  /v1/events/stream?after=<seq>   # SSE：先回放 seq > after 的事件，再跟随实时事件；也可用 Last-Event-ID 头
POST /v1/nodes/register
POST /v1/nodes/:id/heartbeat
POST /v1/projects/:id/pm
POST /v1/projects/:id/workers
POST /v1/sessions/:id/message
POST /v1/sessions/:id/cancel
POST /v1/sessions/:id/archive
PUT  /v1/sessions/:id/permission

# Session token only（role 与 pid/aid 从 token 取，请求体不能改身份）
GET  /v1/tools/pm/context
POST /v1/tools/pm/tickets       { tasks: [{ title, goal, scope?, note?, threads? }] }
POST /v1/tools/worker/report    { ticketId, assignmentId?, report: { state, summary, question? } }
POST /v1/tools/token/refresh    # 无请求体，返回 { token, expiresAt }
```

节点侧在设置 `SUPERAGENT_CONTROL_URL` 后，会在 `Sessions.ensure` 返回的 Agent 上注册 `control_project` / `control_create_tickets`（PM）或 `control_report`（Worker），并用 `pm.ensure` / `worker.create` / `session.message` 携带的 `sessionToken` 调这些端点；未设置时行为不变。工具请求遇到 401 时，节点调用 `POST /v1/tools/token/refresh` 一次，用返回的新 token 重放原请求；刷新失败或重试仍 401 就抛原工具错误。刷新不吊销旧 token：旧 token 在自身 `exp` 前仍可用。

## 节点状态与 Session 记录

P2-D2 之后，独立控制面通过节点 HTTP 的 SSE 事件流和周期心跳维护存活：

- `registerNode` 每次注册用唯一幂等键；`startHeartbeat` 默认每 10s 发一次心跳（测试可注入间隔，`close` 清理 timer）。
- 心跳失败时控制面在本地记一条 `node.status online:false`，不伪造成功；离线期间 `pm.ensure`、`worker.create`、`session.message` 等命令按 502 失败。
- 控制面启动、节点 `offline → online`、SSE 重连都会轮换 `SessionRecord.nodeGeneration`；ensure 确认时写入当前代次。代次过期的 Session 在 `openProject`/`createWorkerSession`/`sendMessage` 前先 re-ensure（Worker 用 assignment→ticket/assignmentId 回退）；`stopped`/`archived` 不因代次复活。
- `session.inspect` 在“已持久化但未挂载”时返回 `found:true` + `backendSessionId`、不带 `status`，控制面据此 re-ensure；完整约定见 [009 节点协议](009-node-protocol.zh-CN.md)。
- 控制面自身仍用 `proper-lockfile` 的 `stale: 30_000` 保护单写者：强杀后立即重启可能报 `Lock file is already being held`，属运维事项（P2-F），**当前未修复**。

## 现在不做什么

- 真实 DSH 节点进程已接（P2-D，见 `docs/014`）；多节点调度与故障转移仍未做。
- 不迁移现有 `Runtime` 的 Source/SSE/面板：Phase 1B。
- 不做 MCP、Claude/Codex、完整 Memory。
- Session 记录已持久化在 Store KV（Phase 1B 完成），token 不落库；旧 token 吊销仍属 P2-A2。
- PM 工作区当前仍是项目目录；Phase 3 再和项目工作区/工具组对齐。
