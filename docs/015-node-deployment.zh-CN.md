# 节点部署：控制面进程与独立 DSH 节点

> 本文说明独立控制面与单个 DSH 节点的部署。早期双进程恢复与工具边界验收见 [013](013-p2d-node-spike.zh-CN.md) 和 [014](014-p2d2-recovery.zh-CN.md)。当前控制台验收记录见仓库根目录的 `project_handoff.md`。
> 关系：[009 节点协议](009-node-protocol.zh-CN.md) 定义命令/事件；[010 控制面内核](010-control-plane-kernel.zh-CN.md) 定义控制面；[006 部署](006-deployment.md) 是单进程 Web profile 的部署指南；本文对应其中的“节点分进程”形态。
> 边界：控制面 viewer/operator 认证与 SSE 压测已在 P2-C 完成（本文只列部署相关变量）；TLS/反向代理仍是部署建议，见 `docs/016-control-plane-tls.zh-CN.md`（按编号规则用纯文本提及，不建立 Markdown 链接）。本文的示例 profile（`examples/profile.node/`）由 E2E 实际启动过的 profile 整理而来，仓库内副本只做了 YAML/字段静态校验，没有在写文档时重新启动服务。

## 1. 形态

一条生产链路有两个进程，各自启动、各自停止：

```text
控制面进程                               DSH 节点进程
node lib/control.js                      dsh --profile superagent-node
  ─ SQLite / Engine / Ticket               ─ dsh-base + workspace + preset registry
  ─ 工单、项目、Assignment、事件             ─ PM/Worker preset + dsh-superagent/node
  ─ GET /health, /v1/*                     ─ GET /health, POST /commands, GET /events
  ─ SUPERAGENT_CONTROL_TOKEN               ─ SUPERAGENT_NODE_TOKEN
  ─ 127.0.0.1:<control port>               ─ 127.0.0.1:<node port>
```

- 两个 PID。控制面重启不影响节点进程，节点重启也不重置控制面数据库。
- 两个进程令牌（operator 与 node）加一个可选的只读 viewer 令牌。控制面 operator 令牌给 `/v1/*` 的读写；节点令牌给控制面调用 `/commands`；viewer 令牌只能 GET 控制面读路由，未设置时不启用。三者都应是不同的秘密，不要互换使用。
- 节点没有 Web app、没有浏览器窗口、没有面板 HTTP 路由；它只监听节点端口。控制面另开一条到节点的 SSE 事件流（节点是服务端，控制面是客户端）。
- 控制面是唯一的业务写入方：Ticket、Project、Assignment 只存在于控制面 SQLite。节点只创建/恢复 Session、跑工具、回传事实。
- 节点不加载 `dsh-superagent` 顶层 bundle，因此没有 Runtime、Store、Engine、Sources、面板和主 Session。

对照：[006](006-deployment.md) 的 `superagent` profile 是 Web 形态，一个进程里同时有面板和 Runtime；`examples/profile.cordis.patch.yml` 是给那个 profile 的补丁（`webserver`、`stateDir`）。本文的 profile 是完整 profile，不是补丁；不要把两者放进同一个 `$DSH_HOME` 或同一个进程。

## 2. 环境变量

节点进程启动时由 `src/node/plugin.ts` 的 `readNodeEnvironment()` 读取；缺 token、缺端口、root 非绝对路径、control URL 非 http(s) 都会直接抛错，让 DSH 启动失败，而不是“起了一个不监听的空节点”。

| 变量 | 进程 | 必填 | 说明 |
| --- | --- | --- | --- |
| `DSH_HOME` | 节点 | 是（专用目录） | DSH 的 profile、Session、`storages/`、`.credentials.yaml` 都在这里。必须是**专用目录**，绝不能指向用户的 `~/.dsh` |
| `DSH_AGENTS_HOME` | 节点 | 建议 | 隔离 skills 与 `AGENTS.md`，避免节点读到操作者个人 agent 配置 |
| `DSH_TELEMETRY_DISABLED` | 节点 | 否 | 隔离环境可设为 `1` |
| `SUPERAGENT_NODE_TOKEN` | 节点 + 控制面 | 是 | 节点 bearer token，建议 32 字节以上随机值；两侧必须一致；错误值得到 401 |
| `SUPERAGENT_NODE_PORT` | 节点 | 是 | 监听端口。生产用固定端口；`0` 只适合一次性测试（控制面无法预知实际端口） |
| `SUPERAGENT_NODE_HOST` | 节点 | 否 | 默认 `127.0.0.1`；不要在没有 TLS/反代时改成对外地址 |
| `SUPERAGENT_NODE_ID` | 节点 + 控制面 | 否 | 默认 `local`；两侧必须一致，且跨重启保持稳定。不一致时 `/v1/state` 会出现另一个节点键，且节点 `offline → online` 不会轮换 Session 代次 |
| `SUPERAGENT_NODE_ROOT` | 节点必填；控制面可选 | 是（节点） | 节点根目录，必须绝对路径；控制面的 workspace 必须落在它下面。控制面未设时默认 `./.superagent-control` |
| `SUPERAGENT_CONTROL_URL` | 节点 | 否 | 控制面 base URL。设置后节点给 PM/Worker 注册 `control_project`/`control_create_tickets`/`control_report` 代理工具；不设置时节点仍可启动，但 PM 建不了 Ticket、Worker 报不了 report，只适合排障 |
| `SUPERAGENT_CONTROL_TOKEN` | 控制面 | 是 | 操作员 bearer token；`/v1/*` 用它，`/v1/tools/*` 例外（只认控制面签发的 Session token） |
| `SUPERAGENT_CONTROL_VIEWER_TOKEN` | 控制面 | 否 | 可选只读 bearer token；未设置/空 = 不启用。只能 GET 读路由（state/projects/tickets/sessions/events/stream/session），写操作 403；必须不同于 operator token，相同会在构造时拒绝并释放 DB 锁；详见 `docs/016-control-plane-tls.zh-CN.md` |
| `SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS` | 控制面 | 否 | Session token 过期后允许 refresh 的宽限秒数，默认 `300`；`0` 关闭宽限；只对 refresh 路由生效，普通工具/消息路由始终严格。非法值启动失败 |
| `SUPERAGENT_CONTROL_PORT` | 控制面 | 否 | 默认 `0`（临时端口）；部署时设固定值 |
| `SUPERAGENT_CONTROL_HOST` | 控制面 | 否 | 默认 `127.0.0.1` |
| `SUPERAGENT_CONTROL_DB` | 控制面 | 否 | SQLite 文件，默认 `<node root>/control.sqlite`；启动时锁住它的父目录 |
| `SUPERAGENT_CONTROL_DEPLOYMENT_FILE` | 控制面 | 否 | 控制台写入的下次启动控制面设置。默认放在启动时业务库旁的 `.superagent-private/control.json`。若业务库在节点根目录内，移动到根目录同级的 `<节点目录名>.superagent-private` |
| `SUPERAGENT_NODE_DEPLOYMENT_FILE` | 两端 | 节点使用控制台配置时必填 | 控制台写入的节点设置。控制面未指定时保存到 `.superagent-private/node.json`，DSH 节点启动器填写该文件的绝对路径。文件应位于节点和工作区之外 |
| `SUPERAGENT_CONSOLE_DB` | 控制面 | 否 | 保存事件、操作日志、项目备忘、会话检查和定时任务等控制台数据。默认在业务数据库旁创建 `console.sqlite` |
| `SUPERAGENT_CONSOLE_DIR` | 控制面 | 否 | 构建好的控制台前端目录，默认包自己的 `lib`（其中应有 `console.js`）；目录里只读这一个文件 |
| `SUPERAGENT_CONSOLE_EVENT_ROWS` | 控制面 | 否 | 事件保留条数上限，默认 20000，至少 1 |
| `SUPERAGENT_CONSOLE_EVENT_DAYS` | 控制面 | 否 | 事件保留天数，默认 7；0 关闭按天数清理 |
| `SUPERAGENT_CONSOLE_AUDIT_DAYS` | 控制面 | 否 | 审计保留天数，默认 0，表示长期保留 |
| `SUPERAGENT_RECONCILE_INTERVAL_MS` | 控制面 | 否 | 自动清理残留会话的间隔（毫秒）。默认 `0`，可在节点部署页手动检查。 |
| `SUPERAGENT_REPORT_PROGRESS_INTERVAL_MS` | 控制面 | 否 | 同一上级收到两条**普通进展**报告的最小间隔（毫秒）。默认 `60000`（一分钟）：Worker 每一步都汇报时，上级不会每一步都被叫醒。`0` = 每条普通进展立刻送达。终态、阻塞、失败、丢弃、就绪**不**受此节流影响。非法值启动失败 |
| `SUPERAGENT_DENIAL_WINDOW_MS` | 控制面 | 否 | 权限拒绝计数的**滑动窗口**宽度（毫秒），默认 `600000`（十分钟）。窗口外的拒绝不进旧窗口。非法值启动失败 |
| `SUPERAGENT_DENIAL_THRESHOLD` | 控制面 | 否 | 一个窗口内累计多少次**有效拒绝**才生成一次上级审查，默认 `3`。同一回合重复的同一拒绝只算一次有效拒绝。非法值启动失败 |
| `SUPERAGENT_DENIAL_COOLDOWN_MS` | 控制面 | 否 | 一次审查之后同一范围安静多久（毫秒），默认 `600000`（十分钟）。**上界有限**：冷却永不到期等于把升级永久关掉。非法值启动失败 |
| `SUPERAGENT_DENIAL_FUSE_LIMIT` | 控制面 | 否 | 同一回合内多少次被拒调用会打断该回合，默认 `5`。打的是回合打断，不是整会话停机。非法值启动失败 |
| `SUPERAGENT_SCHEDULER_OFFSET_MINUTES` | 控制面 | 否 | 定时任务的**固定**时基偏移（分钟，东为正），默认 `0` = UTC。取值范围 −720…840，非法值启动失败。用命名时区会带上夏令时规则，所以这里只给固定偏移；控制台会把这个偏移显示出来 |
| `SUPERAGENT_SCHEDULER_TICK_MS` | 控制面 | 否 | 调度器查看「到点计划」的周期（毫秒），不设置时用模块自己的默认（5 秒）。`0` = 计划仍然存在，但**不自己**到点运行，只能手动跑 |
| `SUPERAGENT_WORKSPACE_ROOT` | 控制面 | 否 | 默认 `<node root>/workspaces`；**必须**在 `SUPERAGENT_NODE_ROOT` 之内，否则节点报 `Workspace escapes the node root` |
| `SUPERAGENT_NODE_URL` | 控制面 | 生产必填 | 节点 base URL。不设置时控制面使用内置 `FakeNode`（测试/兼容），不会连接真实节点 |
| `SUPERAGENT_NODE_TOKEN` | 控制面 | `NODE_URL` 存在时必填 | 与节点侧相同 |

规则：

1. **两个 home 都是专用的。** `DSH_HOME`、`DSH_AGENTS_HOME`、`SUPERAGENT_NODE_ROOT`、`SUPERAGENT_CONTROL_DB` 的父目录、`SUPERAGENT_WORKSPACE_ROOT` 都应属于服务账号，不要复用个人目录。E2E 的隔离口径见 [014 §3](014-p2d2-recovery.zh-CN.md)。
2. **令牌只存在于进程环境和机器的密钥存储里。** 不写进 `cordis.patch.yml`、`package.json`、示例、控制面数据库或日志；不要用命令行参数传（会出现在进程列表）。轮换时两侧同时改，再依次重启节点和控制面。
3. 控制面进程也读 `SUPERAGENT_NODE_ROOT`/`SUPERAGENT_NODE_ID`，用于 `SUPERAGENT_WORKSPACE_ROOT` 的默认值和节点键；两个进程的 `NODE_ID` 不一致时，`/v1/state` 里的键与节点事件里的 id 会对不上，代次轮换也不会发生在控制面认为的那个节点上。
4. `SUPERAGENT_WORKSPACE_ROOT` 必须位于 `SUPERAGENT_NODE_ROOT` 内。节点也会检查子目录中的符号链接或 Windows 目录联接是否指向根目录之外。

## 3. Profile 与模型

节点 profile 的安装文件在 `examples/profile.node/`：`package.json`（`dsh.profile.bundles = ["@deepseek-ai/dsh-base"]`，`dependencies.dsh-superagent` 指向仓库）和 `cordis.patch.yml`（workspace、preset registry、PM/Worker preset、`dsh-superagent/node`）。完整安装步骤、`--dump-config` 校验和 Windows 注意事项见该目录的 README；本文只列与运维相关的约束。

- 节点只从构建产物 `lib/` 加载，不直接跑 `src/*.ts`。DSH 内置 Node 是 strip-only，参数属性这类语法会直接失败；升级仓库后先 `pnpm build`。
- profile 里由仓库根 `cordis.patch.yml` 复制来的 PM/Worker preset 行必须保留。Session 恢复需要按 preset id 重新挂载；删掉后 resume 会失败。
- 不要用 `--from-default-profile` 重建一个已经配置过的节点 profile：那会替换 `cordis.patch.yml`，连同 preset 和模型行一起清掉。

模型是节点自己的能力，不是控制面的：

1. profile 必须挂 `agent-default-model`（provider/model/reasoningEffort）和 `llm-pi-ai`（或等价的 provider 行，通过 `apiKeyEnv` 指定环境变量）。只挂其中一个不够：前者提供默认选择，后者提供可用的 provider。
2. 凭据放专用的 `$DSH_HOME/.credentials.yaml`（`refs.<apiKeyEnv 指定的变量名>`），或直接放同名环境变量。文件属主/ACL 只给服务账号；不要复制进 profile 目录、仓库或示例。
3. `NodeSessions.ensure` 在 create、resume、复用 live Agent 三条路径上调用 `applyDefaultModel` → `initializeRoleModel`，在 turn 1 前把 profile 的 `currentSelection()` 写成 Agent 的 `model/selection`。`RoleProfile.model` 仍优先；已有 selection 或 request header 时不重复写。因此不需要 `p2d-model-default` 之类的 model shim——那是上一轮 evidence-only 方案，已从最终 profile 删除（见 [013 §0.1](013-p2d-node-spike.zh-CN.md)）。
4. 缺少模型行时，节点仍能启动并创建 Session，但第一次模型 turn 会以 `agent ... has no provider/model` 失败。看到这个错误先查模型行和凭据，不要先怀疑控制面。
5. 控制面 `PM_PROFILE`/`WORKER_PROFILE` 目前不填 `model`，PM/Worker 的路由由节点 profile 的默认值决定。要让不同角色走不同路由，属于后续改动，不在本文的部署步骤里。

## 4. 启动、健康与停止

启动顺序是**先节点、后控制面**：控制面启动时先 `registerNode`，注册失败会关闭监听和数据库，不会留下半启动的 API。停止顺序相反：先控制面、后节点。

```bash
# 节点（一个终端）
export DSH_HOME=/srv/superagent/node/dsh-home
export DSH_AGENTS_HOME=/srv/superagent/node/agents
export DSH_TELEMETRY_DISABLED=1
export SUPERAGENT_NODE_TOKEN='<random node token>'
export SUPERAGENT_NODE_PORT=47101
export SUPERAGENT_NODE_HOST=127.0.0.1
export SUPERAGENT_NODE_ID=node-1
export SUPERAGENT_NODE_ROOT=/srv/superagent/node
export SUPERAGENT_CONTROL_URL=http://127.0.0.1:47100
dsh --profile superagent-node --dump-config > /dev/null
dsh --profile superagent-node
# 启动日志只有节点自己的监听行：
# dsh-superagent node listening on http://127.0.0.1:47101
```

```bash
# 控制面（另一个终端）
export SUPERAGENT_CONTROL_TOKEN='<operator token>'
export SUPERAGENT_CONTROL_PORT=47100
export SUPERAGENT_CONTROL_DB=/srv/superagent/control/control.sqlite
export SUPERAGENT_WORKSPACE_ROOT=/srv/superagent/node/workspaces
export SUPERAGENT_NODE_URL=http://127.0.0.1:47101
export SUPERAGENT_NODE_TOKEN='<same node token>'
export SUPERAGENT_NODE_ID=node-1
node lib/control.js
# superagent control plane listening on http://127.0.0.1:47100
# superagent console at http://127.0.0.1:47100/console
```

浏览器打开 `/console` 后输入 `SUPERAGENT_CONTROL_TOKEN`，当前标签页刷新时会自动恢复连接。定时任务检查间隔、自动清理残留会话的间隔和会话令牌过期宽限保存后立即生效。「恢复启动设置」会重新采用本次启动的参数。部署与凭据页保存的设置在相应进程重启后应用，查看和修改这组设置都需要控制台连接密钥。

### 4.1 健康检查

| 检查 | 期望 |
| --- | --- |
| `curl -fsS http://127.0.0.1:47101/health` | `{"ok":true,"service":"superagent-node"}`；公开路由，不需要 token |
| `curl -fsS http://127.0.0.1:47100/health` | `{"ok":true,"service":"superagent-control-plane"}` |
| `curl -fsS -H "Authorization: Bearer $SUPERAGENT_CONTROL_TOKEN" http://127.0.0.1:47100/v1/state` | `nodes["node-1"].online` 为 `true`；`events` 至少 1（注册/心跳） |
| 用 viewer token `GET /v1/state`（已设置时） | `200`，只读路由；viewer 对任何写 POST/PUT 返回 `403` |
| 无 token / 错误 token 调控制面 `GET /v1/state` | `401`；Session token 也不能读控制面读路由 |
| 错误 token 调节点 `POST /commands` | `401` `{"error":"A node bearer token is required"}` |
| 错误 token 调控制面 `GET /v1/state` | `401` |
| `curl -fsS http://127.0.0.1:47101/` | `404`：节点没有面板/Web 路由 |

节点在线由控制面的心跳维持：默认每 10s 一次，一次失败就记 `online:false`；恢复后下一次成功心跳（或重连）把它记回在线。观测到的离线延迟因此可能只有 1–2s（恰好紧挨着一次心跳），最长约一个心跳周期。

### 4.2 停止

- 控制面：`SIGTERM`/`SIGINT` → 停心跳 → `server.close()`（先结束所有 SSE 流，再关监听）→ `control.close()`（关 Store，释放数据库目录锁）→ 退出。优雅停机不会留下 stale 锁。
- 节点：`SIGTERM`/`SIGINT` 由 DSH 启动器统一 dispose 插件树；`dsh-superagent/node` 通过 `ctx.effect` 注册的关闭动作会关闭节点 HTTP 监听，同时 abort 在途投递。节点进程退出后，控制面在一个心跳内把它标为 offline。
- 不要用 `taskkill /F`、`kill -9` 代替优雅停止。控制面被强杀会留下数据库目录锁（见 §5.1）；节点被强杀会丢掉仍在跑的 turn，且只保留已持久化的 Session。

## 5. 故障手册

### 5.1 控制面强杀后起不来：`Lock file is already being held`

现象：`superagent control plane failed: Lock file is already being held`，进程退出。

原因是控制面用 `proper-lockfile` 锁住 `SUPERAGENT_CONTROL_DB` 的父目录（`stale: 30_000`），防止两个写者共用同一个 SQLite。被 `taskkill /F` 之类的强杀后，锁文件还在，且锁龄小于 30s 时下一次启动会拒绝。

处置：

1. 确认没有另一个控制面进程还在运行（尤其是服务管理器自动拉起的那一个）。
2. 等锁过期后，用同一组环境变量重试。30s 是判定阈值，不是精确的重试时间；E2E 里到锁龄 87.9s 才成功，所以按 10–15s 间隔重试直到成功即可。
3. **不要删除锁文件。** 删除只绕过了检查，不能证明原来的写者已经退出；两个控制面同时打开同一个 SQLite 会带来更糟的后果。若等待后仍然失败，先停掉所有控制面实例，检查锁文件的时间与持有进程是否确实不可达，并保留数据库目录备份后再处理；不要靠反复删除锁文件“修复”启动问题。

优雅停止（SIGTERM/SIGINT）不会触发这个问题。要支持“kill 后立即重启”，需要优雅关闭或启动时等待锁过期；当前没有实现，属 P2-F/运维事项（[014 §6.1](014-p2d2-recovery.zh-CN.md)）。

### 5.2 节点失联：命令返回 502

现象：控制面能响应 `/health`，但创建 PM/Worker 或发消息返回 `502`，body 类似：

```text
The node node-1 is offline; the command was not sent
```

含义是控制面**没有**把命令发出去，不是节点执行失败。检查顺序：

1. 节点进程还在吗？`curl http://127.0.0.1:47101/health` 是否 200。
2. 端口/主机是否与 `SUPERAGENT_NODE_URL` 一致；节点是否监听在 `127.0.0.1` 而控制面连的是另一个地址。
3. token 是否两侧一致（错误 token 是 401，不是 502）。
4. 等节点恢复后看 `/v1/state` 的 `online`，无需手动 heartbeat；注册/心跳成功会自动恢复。

节点恢复后不要手工改数据库里的 Session 状态。控制面会在使用 Session 前 re-ensure（见 §5.3）。

### 5.3 节点重启后的 generation 与 re-ensure

节点重启（或控制面重启、SSE 断线重连）会轮换 `SessionRecord.nodeGeneration`。此前确认过的 Session 记录带的是旧代次，控制面在 `openProject`、`createWorkerSession`、`sendMessage` 之前会先 re-ensure：

- 节点侧 `ensure` 先看 live Agent，没有则用 `sessionQuery.observeSession` 判断是否已持久化，再 `agents.resume` 或 `agents.create`；同一 `sessionId` 恢复后 `createdAt` 不变。
- `session.inspect` 在“已持久化但未挂载”时返回 `found:true` + `backendSessionId`，**没有 `status`**。这是正常答案，不是探测失败；控制面据此 re-ensure。不要把它当 `idle`，也不要因为无 `status` 就新建一个 Session。
- `stopped`/`archived` 是终止状态，不会因代次轮换被重新拉起。

排障时可以直接 `curl` 节点的 `/commands` 发 `session.inspect`，但要注意 token 和命令 envelope；更简单的是看控制面 `/v1/sessions` 与节点日志。

### 5.4 事件 `seq` 是控制面自己的序号

节点进程内的事件序号在重启后归零，**对外的 `seq` 已经是控制面自己的序号**，跨控制面重启单调（见 [009](009-node-protocol.zh-CN.md)）。节点自己的计数以 `nodeSeq` 保留在事件里，`nodeSeq` 变小即节点重启过。日志有界，被裁掉的那一段会明确告知（`gap`），不会悄悄少一段。

### 5.5 控制台页面显示“尚未构建”

控制面进程正常、`/v1/*` 正常，但 `/console` 提示前端没构建：包里没有 `console.js`。处置：在源码目录执行 `pnpm build`（产物在 `lib/console.js`）后重启控制面，或用 `SUPERAGENT_CONSOLE_DIR` 指向已构建的目录。控制台与控制面同源，不加载任何第三方资源。

### 5.6 其他常见错误

| 现象 | 原因与处置 |
| --- | --- |
| 节点启动即退出，提示 `SUPERAGENT_NODE_TOKEN is required` / `PORT` / `ROOT` | 环境变量没进到服务进程；检查服务包装器的环境，而不是只检查当前 shell |
| `SUPERAGENT_NODE_ROOT must be an absolute path` | root 用了相对路径；改成绝对路径 |
| 启动报 `EADDRINUSE` | 端口被占用；`netstat -ano \| findstr :47101`（Windows）或 `ss -ltnp` 找到进程，换端口并同步控制面 `SUPERAGENT_NODE_URL` |
| `Workspace escapes the node root` | `SUPERAGENT_WORKSPACE_ROOT` 不在 `SUPERAGENT_NODE_ROOT` 内；对齐两个 root |
| `agent ... has no provider/model` | 缺模型行或凭据；见 §3。只影响模型 turn，不影响 `/health` |
| `The agent preset dsh-superagent-worker is not usable on this node` | profile 的 preset 行被删或激活失败；从 bundle 的 `cordis.patch.yml` 恢复 |
| DSH 启动日志说某 bundle 被跳过/不兼容 | `engines.dsh` 与运行的 DSH 版本不匹配；安装匹配版本或放宽仓库的范围，不要改 `node_modules` |
| PM 在操作员消息前自行开始 turn 1 | 这是 role prompt 投递的产品行为，不是部署故障；需要“干净的一问一答”要先做产品决策（[014 §6.4](014-p2d2-recovery.zh-CN.md)） |

### 5.7 Session token 过期后 refresh：默认 5 分钟宽限

Session token 默认 TTL 3600s。过期后普通工具/消息路由严格返回 `401`；只有 `POST /v1/tools/token/refresh` 在默认 **300 秒**宽限内仍允许自续一次，同时接受 `current` 或 `current - 1` 版本。

- 调整：`SUPERAGENT_TOKEN_REFRESH_GRACE_SECONDS=<秒>`；`0` 关闭宽限；只接受非负整数，非法值让控制面启动失败。
- 刷新会自增 `tokenVersion`，同一秒刷新出的 token 也不同；旧 token 刷新后不能再打开普通工具，但可在宽限内再 refresh 一次。
- 取舍：超过 `TTL + 5min` 且期间完全没有工具调用的长任务仍然失败；不要把宽限理解成“过期 token 仍可正常使用”。

### 5.8 半失联节点：命令超时 10s

`HttpNodePortOptions.commandTimeoutMs` 默认 **10_000ms**（代码选项，不是 env）。它覆盖一次 `POST /commands` 的总时长，并合并调用方 signal；超时错误包含 command type 和毫秒数，不含 token。

现象：节点进程还在、端口还能连，但请求迟迟不返回。心跳会在 command timeout 后失败，控制面本地记 `online:false`，下次心跳继续重试；节点恢复应答后自动 online。注意默认超时是 10s，不要在 180ms 的审计窗口里期待 offline；测试用 50ms 注入证明恢复语义。

### 5.9 stop/cancel 的 10s deadline

`DshPortHostInput.cancelTimeoutMs` 默认 **10_000ms**（代码选项，不是 env）。`cancelSession` 把 `stopBackground + cancel + whenIdle` 包在同一个 deadline race 里；超时抛 `Stopping the Session <id> did not settle within <ms> ms`，命令失败，不让调用方永远挂住。

清理失败不会回滚已结束的 Assignment：Ticket 仍保持 `stopped`/`ended`，失败写 `Ticket.stopFailure` 并发 `ticket.stopFailed` 事件；后续成功 stop 会清除该记录。不要再把“取消命令 200”当成 cleanup 一定成功；需要确认时看 Ticket 的 `stopFailure` 和事件。

## 6. `lib/node.js` 不是生产节点

`pnpm node` / `node lib/node.js` 启动的是 `FakeNode`（`src/node/main.ts`）：它只实现协议外壳，没有真实 DSH Context、Session、模型或工具。它用于：

- 不依赖 DSH 的协议集成测试；
- 兼容旧的单进程/本地调试方式。

生产节点只有一个入口：`dsh --profile superagent-node` + `dsh-superagent/node`（`package.json` 的 `exports["./node"]` → `lib/node-plugin.js`）。不要用 `pnpm node` 接控制面做验收，也不要把它写进服务配置。

## 7. 升级与回滚

### 7.1 控制面

1. 先优雅停止控制面，确认没有控制面进程再动数据库。
2. 备份 `SUPERAGENT_CONTROL_DB`（连同同目录的 `-wal`/`-shm`，如果有）到数据库目录之外。
3. 在仓库 `git pull`、`pnpm install`（`prepare` 会重建 `lib/`）、`pnpm build`。
4. 启动控制面，检查 `/health`、`/v1/state` 和日志；数据库迁移是单向的，旧版本打不开新库。

回滚：停控制面 → 恢复备份的数据库 → 切回旧提交并重建 → 启动。没有备份就无法回滚被新版本迁移过的库。

### 7.2 节点

1. 先停控制面（不再产生新命令），再优雅停止节点。
2. 更新仓库并 `pnpm build`。如果 profile 用 `link:` 指向仓库，节点下次启动就会加载新的 `lib/`；如果 `dsh-superagent` 的 manifest/导出变了，重跑一次 `dsh plugin --profile superagent-node add ...`。
3. `dsh --profile superagent-node --dump-config` 确认 preset、`dsh-superagent/node`、模型行都在。
4. 启动节点，再启动控制面；Session 会按 `sessionId` resume，持久化在 `$DSH_HOME/sessions/`。

回滚：停两个进程 → 切回旧提交并重建 → 恢复旧的 profile `cordis.patch.yml`（如果升级改过）→ 启动。控制面不运行 DSH，DSH 升级只影响节点侧；升级前备份整个 `$DSH_HOME/sessions/`，不要用旧 DSH 直接读新版本写过的 Session 目录。

## 8. 日志与脱敏

- 节点启动日志只有一行监听 URL；节点进程没有 Web/日志查看器，标准输出/错误就是排障入口。不要为了“看日志”给生产 profile 加 evidence-only 的 log 插件。
- 令牌只从环境读取，不打印、不写文件。排障时不要 `env | grep TOKEN` 后贴日志；需要确认时只比对长度/哈希，或临时换一个新 token 复现 401。viewer token 同样是 bearer secret，泄露只给只读访问，但仍不应进入日志/工单。
- 模型凭据在 `$DSH_HOME/.credentials.yaml`：只给服务账号读权限（Unix `chmod 600`，Windows 用 `icacls` 收紧），不要放进仓库/profile/工单目录。错误日志里出现 key 时按凭据泄漏处理并轮换。
- 控制面错误、Session 日志会包含 sessionId、workspace 路径、Ticket id；对外粘贴前替换绝对路径和 id。控制面没有面板层的统一脱敏，别假设它会自动清掉所有敏感串。
- 报告问题时建议附：两侧 `/health`、`/v1/state`（可脱敏 id）、节点启动行、控制面启动行、错误发生时间；不要附 token 和 `.credentials.yaml`。

## 9. 清理残留会话

在节点部署页点击「检查并清理」，或在运行设置里设置自动检查间隔。控制面只检查自己记录的会话。任务或项目已结束时，系统会请节点确认相应会话是否还在运行，再停止并归档确认的会话。磁盘上的会话日志、工作区与数据库仍按各自的生命周期保留。

| 位置 | 内容 |
| --- | --- |
| `$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd` | DSH Session 日志；resume 的依据 |
| `$DSH_HOME/storages/workspace.json` | Workspace 注册表 |
| `SUPERAGENT_WORKSPACE_ROOT` 下的目录 | PM/Worker 的工作目录 |
| 控制面 SQLite | Project/Ticket/Assignment/SessionRecord |

来源不明的会话或目录需要单独核对。需要回收磁盘空间时，可按以下步骤排查：

1. 停之前先导出 `GET /v1/sessions`、`GET /v1/tickets` 作为对照清单。
2. 停控制面、停节点，确保没有进程在写。
3. 把候选目录**移动**到隔离目录（不要直接删），保留至少一个保留周期；先确认 `/v1/state` 不引用它们。
4. 重启后验证 PM/Worker 仍能 resume；确认无影响后再删除隔离目录。

不要删除 `$DSH_HOME` 根、`storages/workspace.json`，也不要在控制面数据库还在引用某个 Session 时删它的日志。控制面数据库删除后没有恢复路径；清理前先备份。

## 10. Windows 服务化注意

节点在 Windows 上由 `dsh.cmd` 启动，控制面由宿主 Node 启动；两者都可以被服务包装器托管，但要处理以下约束：

1. **PATH。** `dsh.cmd` 可能不在服务账号的 PATH 里。服务配置里写完整路径：`<DSH 安装目录>/resources/runtime/cli/bin/dsh.cmd`。控制面用 `node lib/control.js` 时也要固定 Node 可执行文件（`engines.node` 为 `^22.19.0 || >=24.0.0`）。
2. **Electron 注入。** `dsh.cmd` 通过 Electron 二进制 + `ELECTRON_RUN_AS_NODE=1` 运行 CLI。不要自己设置或清除这个变量；某些服务包装器会注入/剥离 Electron 环境，导致“没有窗口、退出码 0”或反过来弹出应用窗口。排障时先确认子进程的实际环境，再怀疑 profile。
3. **固定工作目录与专用账号。** 服务的工作目录、`DSH_HOME`、`DSH_AGENTS_HOME`、`SUPERAGENT_NODE_ROOT`、`SUPERAGENT_WORKSPACE_ROOT`、`SUPERAGENT_CONTROL_DB` 都用绝对路径，并属于同一个专用服务账号；不要用 LocalSystem 去读某个用户目录。
4. **停止语义。** Windows 服务没有 POSIX 的 SIGTERM；包装器的停止动作可能是 `taskkill`（不带 `/F` 时 Node 仍可能收不到可处理的信号）或直接强杀。强杀控制面会留下 §5.1 的锁，强杀节点会丢在途 turn。上线前实测一次“服务停止 → 两个进程都退出、数据库锁释放”；如果包装器只能强杀，把重启策略设计成等待锁过期，不要删锁。
5. **端口与防火墙。** 两个进程都只监听 `127.0.0.1`；需要远程访问时用 SSH 隧道或受控的 TLS 反代，不要直接把节点/控制面端口暴露到网络。
6. **单写者。** 同一个 `SUPERAGENT_CONTROL_DB` 只能有一个控制面实例；服务管理器不要配成多副本。

## 11. 未完成与边界

- viewer 认证、写操作 403 校验与 SSE 压测已在 P2-C 完成；TLS/反向代理仍不在本文实现，部署建议与威胁模型见 `docs/016-control-plane-tls.zh-CN.md`（纯文本提及）。本文不把 loopback 部署描述成“已经安全地暴露到网络”。
- token refresh 默认 5 分钟宽限、cancel/command 默认 10 秒 deadline 都是上限，不是精确时间；超过 TTL+grace 且无工具调用的长任务仍失败，半失联节点可能到 10 秒才 offline。
- 控制台的定时任务会向已启动且可用的项目 PM 发消息。独立控制面只连接一个 DSH 节点，跨节点调度和故障接替尚未实现。
- 独立 DSH 节点安装 PM 和 Router 的角色提示词时会等待实际消息。角色工具边界按 `RoleProfile` 判定：`deny` 先于 `tools`，被 deny 的名字即使在 allow 列表里也被拒绝。工作区的越界由**后端自己的文件沙箱**负责，节点只读它结构化的拒绝码（`FS_SANDBOX_DENIED`）并按调用 id 与回合配对后上报；节点自己另守一条明确规则：改文件的工具不得指向工作区的 Git 元数据。
- 控制面锁 stale（§5.1）是已知限制；事件 `seq` 的跨重启语义已经收口为控制面自己的序号（§5.4）。
