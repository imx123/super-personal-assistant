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
- 需要驱动 Session 的命令带 `sessionToken`；节点把它当作不透明字符串，不解析、不记录。
- `NodeEvent` 是节点回传的事件：节点状态、Session 状态、Session 事件、状态应答、工具调用。
- 事件带 `seq`，控制面用它检测丢事件和排序。
- `session.inspect` 要求节点回一条 `session.inspected`，`requestId` 回显命令的 `idempotencyKey`；应答带 `found`、`status`、`backendSessionId` 和 `ready`。`ready=false` 表示 Session 已存在但角色提示词/工具安装失败，控制面必须按失败处理，不能因为收到过 `idle` 就当成功。
- 显式状态查询是控制面确认 `starting`/`failed` 记录的唯一无损手段：命令回执和第一次状态事件都可能丢失，重发命令不足以证明 Session 的真实状态。
- `session.message` 和 `session.archive` 只在后端真正接受/完成后回执；投递或归档失败必须让命令失败，控制面不会把 HTTP 200 当作成功。

## Session Token

控制面签发短期 HMAC-SHA256 token，claims 包含：

- `sid`：控制面内部 Session id；
- `pid`：Project id；
- `aid`：Worker 的 Assignment id（PM/Scout 没有）；
- `role`：`pm` / `worker` / `scout`；
- `backend`：`dsh` / `claude` / `codex`；
- `nodeId`、`iat`、`exp`。

工具调用只从验证后的 token 取得这些字段，**不信任工具参数里的 `sessionId` 或 `projectId`**。token 不写入 `SessionRecord`，也不写日志。

## 工具上下文

`ToolContext` 是工具处理器的唯一身份来源。以后接 MCP 时，MCP server 只是换一个 transport，仍然先验证同一个 token，再把 `ToolContext` 交给同一个 handler。

## 三条规则

1. 控制面唯一业务写入；节点只报告事实。
2. PM/Worker 的工具上下文来自 session token，不来自参数。
3. MCP 是未来的 transport，不是新的业务层。
