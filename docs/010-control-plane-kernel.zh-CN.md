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

当前仍是同一进程、同一个插件入口；Phase 1B 只切所有权，不切进程。独立进程、真实 DSH 适配和面板认证仍在后续阶段。

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
POST /v1/nodes/register
POST /v1/nodes/:id/heartbeat
POST /v1/projects/:id/pm
POST /v1/projects/:id/workers
POST /v1/sessions/:id/message
POST /v1/sessions/:id/cancel
POST /v1/sessions/:id/archive
PUT  /v1/sessions/:id/permission

# Session token only（role 与 pid/aid 从 token 取，请求体不能改身份）
POST /v1/tools/pm/tickets       { tasks: [{ title, goal, scope?, note?, threads? }] }
POST /v1/tools/worker/report    { ticketId, assignmentId?, report: { state, summary, question? } }
```

节点侧在设置 `SUPERAGENT_CONTROL_URL` 后，会在 `Sessions.ensure` 返回的 Agent 上注册 `control_create_tickets`（PM）或 `control_report`（Worker），并用 `pm.ensure` / `worker.create` 携带的 `sessionToken` 调这两个端点；未设置时行为不变。

## 现在不做什么

- 不接真实 DSH Session：Phase 2。
- 不迁移现有 `Runtime` 的 Source/SSE/面板：Phase 1B。
- 不做 MCP、Claude/Codex、多节点、完整 Memory。
- Session 记录目前只在内存；Phase 2 落库。
- PM 工作区当前仍是项目目录；Phase 3 再和项目工作区/工具组对齐。
