# 控制面 TLS、viewer 认证与反向代理部署

> 状态：P2-C 收口文档（2026-11-14）。控制面的 viewer/operator 认证、写操作 403 和 14 客户端 SSE 压测已在代码与测试中完成；TLS 直接实现、反向代理代码、控制面前端**没有**在本仓库实现。最终回归 37 files / 295 tests 通过，`pnpm typecheck`、`pnpm build` 通过。
> 关系：[009 节点协议](009-node-protocol.zh-CN.md) 定义 Session token 与节点命令；[010 控制面内核](010-control-plane-kernel.zh-CN.md) 定义控制面 API；[015 节点部署](015-node-deployment.zh-CN.md) 定义双进程、环境变量和节点运维。本文只写控制面的认证、TLS/反代边界和 SSE 部署约束。

## 1. 结论

控制面默认只监听 loopback 的明文 HTTP。生产暴露到网络时，**TLS 由反向代理终止**，控制面继续只监听 `127.0.0.1`；仓库不实现证书管理、ACME、反向代理配置或控制面前端。viewer token 是给只读脚本/排障工具的**可选**第二角色，不是面板。

三个“不要”：

- 不要把控制面端口直接暴露到公网；不要把节点端口暴露到公网（节点没有 TLS，也没有 viewer 角色）。
- 不要因为配置了 viewer token 就认为已经安全；viewer 泄露仍是数据泄露，写保护不等于保密。
- 不要声称“前端已接 SSE”：`src/client` 是 DSH 面板，轮询的是 `/orchestrator/api`，不是控制面的 `/v1/*`；仓库没有控制面 UI。

## 2. 认证模型

| 角色 | 配置 | 能做什么 | 失败语义 |
| --- | --- | --- | --- |
| operator | `SUPERAGENT_CONTROL_TOKEN`（必填） | `/v1/*` 全部读写路由；`/health` 公开 | 缺失/错误 token：`401` |
| viewer（可选） | `SUPERAGENT_CONTROL_VIEWER_TOKEN`（空/未设置 = 未启用） | 仅 `GET` 读路由：`/v1/state`、`/v1/projects`、`/v1/tickets`、`/v1/sessions`、`/v1/sessions/:id`、`/v1/events`、`/v1/events/stream` | 缺失/错误/Session token：`401`；合法 viewer 发写请求：`403` |
| node | 控制面侧 `SUPERAGENT_NODE_TOKEN`；节点侧同名变量 | 仅供控制面调用节点的 `/commands` 和读取节点 `/events`；不是控制面 API token | 错误 node token：节点 `401` |
| Session | 控制面签发给 PM/Worker 的短期 token | 仅 `/v1/tools/*`；不能读控制面读路由，也不能写控制面 | 缺失/错误/过期/Session 不匹配：`401` |

规则：

- **viewer 必须不同于 operator。** 两个值相同时，`ControlPlaneServer` 在构造阶段直接抛 `The read-only viewer token must differ from the control-plane API token`；`startControlPlane` 会在监听前关闭已打开的 kernel，数据库锁随之释放，不会留下半启动进程。
- **空 viewer 值等于未启用。** `SUPERAGENT_CONTROL_VIEWER_TOKEN=''` 与不设置等价；此时 viewer 字符串不是任何角色的凭据。
- `/health` 永远公开；`/v1/tools/*` 永远只认 Session token，operator 和 viewer 都会被 `401` 拒绝。
- 认证发生在路由之前：新增的售后路由不会“忘记鉴权”；viewer 的写拒绝是认证后的 `403`，响应里不回显 token。
- Session token 只用于工具调用；控制面读路由和写路由都不接受它。

### 2.1 威胁模型

viewer 泄露的后果：

- 能读取**全部**控制面读模型：Project、Ticket、Session、事件流和 Session 详情；不是按 Project 缩小范围，也没有 per-viewer 过滤。
- 不能创建/发消息/取消/归档/改权限，也不能注册节点或心跳；这些是 `403`，不是“静默成功”。
- 不能打开 `/v1/tools/*`；即使拿到的是 Session token，也不能读控制面。

因此 viewer token 应和 operator token 一样按秘密管理：只发放给只读监控/排障脚本；泄露时立即轮换并重启控制面；不要把它写进 URL、截图、CI 日志或工单。TLS 仍然是必需的，否则同一网络上的被动嗅探者可以直接复用 bearer token。

当前**没有**：viewer 的按项目授权、审计“哪个 viewer 读了什么”、速率限制、IP 白名单、CORS/浏览器会话。需要这些能力时在反向代理或后续版本实现，不要在本仓库里假设它们存在。

### 2.2 token 生命周期与 refresh 宽限

- Session token 默认 TTL 3600s；claims 带 `tv`，`SessionRecord.tokenVersion` 持久化。普通工具/消息路由只接受 `tv === tokenVersion`。
- `POST /v1/tools/token/refresh` 同时接受 `current` 或 `current - 1`；刷新自增并持久化版本，所以同一秒刷新出的 token 也不同，旧 token 刷新后不能再打开普通工具。
- 过期宽限：默认 **300 秒**，`SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS` 覆盖，`0` 关闭；只作用于 refresh 路由，普通路由上的过期 token 始终 `401`。超过 `TTL + 5min` 且期间完全没有工具调用的长任务仍会失败。
- viewer token 不是 Session token，不能调用 `/v1/tools/token/refresh`，也不参与 tokenVersion；它只读控制面读路由，和 Session token 的权限互不替代。

## 3. SSE 语义与压测

`GET /v1/events/stream` 是控制面事件流：

- operator 或 viewer 都可打开；认证仍是 bearer token。
- `after` 查询参数或 `Last-Event-ID` 头指定最后看到的 `seq`；先回放 `seq > after` 的历史，再跟随实时事件。
- 每帧是 `id: <seq>` + `data: <NodeEvent JSON>`；连接建立写 `: connected`，空闲时每 15 秒写 `: keepalive`。
- 客户端断开退订并清 timer；`ControlPlaneServer.close()` 结束所有打开的流，不等待客户端。

`tests/control-plane-sse-load.spec.ts` 覆盖 14 个并发 operator/viewer 交替的流：每个流收到与 kernel 历史逐条一致的事件（无丢失、无重复、无串流）、事件 id 单调、viewer 与 operator 的字节一致、响应不包含任何 token；关闭客户端后 keepalive timer 全部清理，`server.close()` 在 5 秒内完成，且无 unhandled rejection。

限制：事件历史在控制面进程内存里，不是持久化事件日志；节点重启后 `seq` 会从 1 重新计数，跨节点重启的 `after` 游标语义没有定义。外接消费者不要把 `seq` 当全局持久游标；需要时按内容去重或在节点重启后从 `after=0` 重拉。

### 3.1 命令与取消的超时

- **命令超时**：`HttpNodePortOptions.commandTimeoutMs` 默认 **10_000ms**（代码选项，不是 env）。`send()` 对一次 `POST /commands` 做总超时并合并 caller signal；超时错误包含 command type 和 ms，不含 token。心跳超时会记 `online:false` 并继续重试，节点恢复应答后 online。默认是 10s，半失联节点不会在毫秒级被判定 offline。
- **取消超时**：`DshPortHostInput.cancelTimeoutMs` 默认 **10_000ms**；`cancelSession` 的 `stopBackground + cancel + whenIdle` 共用这个 deadline，超时让命令失败而不是无限等待。清理失败不回滚已结束的 Assignment；Ticket 保留 `stopFailure` 并由 `ticket.stopFailed` 事件记录，后续成功 stop 清除。
- 反向代理的读超时要比 SSE keepalive 长；命令超时是控制面到节点的 HTTP 边界，不是代理超时。不要把两者混成一个配置。

## 4. TLS 用反向代理

### 4.1 拓扑

```text
internet / operator network
        │  HTTPS（反代终止 TLS）
        ▼
reverse proxy (nginx/Caddy)  ── 127.0.0.1:47100 ──►  control plane (plain HTTP, loopback)
                                                          │
                                                          └─ 127.0.0.1:47101 ──► DSH node (plain HTTP, loopback)
```

控制面和节点都只绑 loopback。节点通常与控制面同机；如果节点在另一台机器，用 SSH 隧道或 WireGuard 把节点端口带到控制面本机，不要把节点端口直接暴露。TLS 只在反代终止，控制面不知道 `X-Forwarded-Proto`，也不做重定向。

### 4.2 nginx 示例

```nginx
server {
    listen 443 ssl;
    server_name control.example.com;

    ssl_certificate     /etc/ssl/control.example.com.pem;
    ssl_certificate_key /etc/ssl/control.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:47100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;

        # SSE：关闭缓冲和缓存，读超时必须大于 15s keepalive。
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

注意：

- 不要剥掉 `Authorization`；operator/viewer 都靠它。
- 不要对 `/v1/events/stream` 开启响应压缩或代理缓冲，否则心跳和事件会被攒住；nginx 的 `proxy_buffering off` 是必须的。
- `proxy_read_timeout` 要大于 keepalive 间隔（15s），否则长连接会被反代周期性切断。客户端可以带 `after`/`Last-Event-ID` 重连，但频繁断开没有意义。
- `/health` 公开；如果不想对外暴露，在反代按路径/IP 限制，而不是改控制面代码。

### 4.3 Caddy 示例

```caddyfile
control.example.com {
    reverse_proxy 127.0.0.1:47100 {
        flush_interval -1
    }
}
```

Caddy 自动处理证书；`flush_interval -1` 让 SSE 帧立即刷出。其余约束与 nginx 相同：只反代控制面，不反代节点；保留 `Authorization`；给流足够长的超时。

### 4.4 证书与配置边界

仓库不生成、不续期、不热加载证书；证书、私钥权限、ACME 账户、DNS 和防火墙都属于部署系统。反代配置示例是**建议**，没有在仓库测试里执行过；上线前要在目标环境验证 401/403、SSE 心跳和长连接超时。

## 5. 没有控制面前端

仓库里有两个不同的“界面”概念：

- `src/client`：DSH 插件面板，给主窗口的 Router/Project/Ticket 页面用；它调用 `/orchestrator/api`，不是控制面的 `/v1/*`，也不接控制面的 `/v1/events/stream`。
- 控制面：只有 HTTP API；没有 SPA、没有静态资源、没有浏览器会话认证。当前“界面”是 `curl`、脚本、监控系统或你自己的只读工具。

viewer token 不能变成面板：它只解决“只读 HTTP 读路由”的授权；控制面前端的认证、CSRF/同源、TLS 会话、UI 都不在本仓库。不要写“前端已接 SSE”，也不要把 `src/client` 的轮询当成控制面事件流的消费者。

## 6. 日志、令牌与脱敏

- operator/viewer/node token 只从环境读取；不要用命令行参数传（会进入进程列表），不要写进 `cordis.patch.yml`、`package.json`、示例或数据库。
- 控制面错误响应不回显 token；Session token 的校验失败只返回通用 `401`。viewer 的写拒绝消息只说明“read-only viewer”，不包含 token。
- 反向代理访问日志不要记录 `Authorization` 头；不要把 token 放进查询字符串。`curl -v`、抓包、错误堆栈都可能泄露 bearer token，排障后清理。
- 支持包/工单里附 `/health`、`/v1/state`（可脱敏 id）、时间线和错误文本即可；不要附 `.credentials.yaml`、token、完整环境变量。
- 轮换顺序：先在反代/客户端更新，再重启控制面；viewer 与 operator 分别轮换，不要把两者设成同一个值（会启动拒绝）。

## 7. 上线检查表

1. 控制面和节点都只监听 `127.0.0.1`；防火墙/安全组没有开放 47100/47101。
2. 反代终止 TLS；证书链、私钥权限、续期和到期告警已配置。
3. 反代对 SSE 关闭 buffering/cache，读超时 > 15s，保留 `Authorization`。
4. operator token 与 viewer token 不同；viewer 为空表示不启用，不是空密码。
5. 验证：无 token `401`；viewer 读 `200`；viewer 写 `403`；operator 读写 `200`；Session token 访问 `/v1/*` 为 `401`。
6. 验证 SSE：连接后有 `: connected`，空闲收到 `: keepalive`，事件 id 单调；反代断开后客户端能用 `after` 重连。
7. 确认仓库没有控制面前端假设；只读工具用 viewer token，不共享 operator token。
8. 轮换 token 后重启，检查旧 token 立即失效（控制面重启会重建内存 token 表；Session token 由 tokenVersion 管理）。

## 8. 未完成与剩余风险

- TLS/证书/ACME、反向代理配置、控制面前端：本仓库**没有实现**，本文只是部署说明。
- viewer 没有按 Project 的读权限、审计、速率限制、IP 白名单；需要时在反代或后续版本做。
- SSE 历史在内存；节点重启后 `seq` 归零，跨重启游标未定义。
- 控制面强杀后的 `proper-lockfile` 30s stale 仍会让立即重启失败（见节点部署文档的故障手册）。
- `RoleProfile.deny` 独立消费、PM role prompt 自动 turn 1、`Assignment.sessionId` 与真实 `worker-<assignmentId>` 不一致，是 Phase 2 之外的剩余观察，不在本文的认证/TLS 范围内。

最终验证口径：37 files / 295 tests 通过；`pnpm typecheck`、`pnpm build` 通过；`docs.spec` 的 3 个失败是已知 Windows 路径分隔符环境问题。
