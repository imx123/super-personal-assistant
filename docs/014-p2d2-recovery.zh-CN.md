# P2-D2/D3 节点恢复、无 shim 模型与工具边界验收记录

> 状态：P2-D2 恢复修复与 P2-D3 模型/工具边界已实现；D2 E2E 与 D3 v2 无 shim 真实模型 E2E 均已跑（2026-11-14）。P2-D 验收项全 pass，Phase 2 其余项（P2-A2/B2/C/E/F）也已完成；未 commit、未 push。
> 关系：[013-p2d-node-spike.zh-CN.md](013-p2d-node-spike.zh-CN.md) 记录 spike、方案与实现状态；本文记录 P2-D2 的恢复修复、P2-D3 的无 shim 模型链与工具边界、E2E 证据和验收表，不重复 spike 论证，也不把“第一阶段实现”写成“全部完成”。

## 1. 范围与结论

- 工作区基线：HEAD `561f4b8` + 既有 Phase 2 未提交改动（D2 run 时 37 条，D3 run 时 39 条）；两次 run 都未改被跟踪文件。
- 已通过（D2）：独立 DSH 节点进程、控制面/节点双进程、存活与离线语义、慢/快节点重启、控制面重启、Session 代次 re-ensure、`session.inspect` 持久化探测、profile prompt 跨 resume 幂等。
- 已通过（D3 v2，无 shim）：真实模型 PM→Ticket→NodeExecutor Worker→`control_report`；PM 工具表 2 个、Worker 20 个；PM/Worker 路由由产品代码在 turn 1 前写入 `opencode-go/deepseek-v4.1-flash/high`。
- Phase 2 其余项已完成：P2-A2 token 版本化/refresh 宽限、P2-B2 stop cleanup、P2-C viewer/SSE、P2-E 图片窄端口、P2-F 部署文档与示例（`docs/015`、`examples/profile.node/`）；详见 `docs/012`。
- 2026-11-14 审计 5 条已修：过期 token refresh 宽限 300s、stopFailure/取消 10s deadline、半失联 command timeout 10s、Trigger 正文投递、input 已读归属；最终回归 37 files / 299 tests。
- 最终回归：37 files / 299 tests 通过；`pnpm typecheck`、`pnpm build` 通过；D2 的 18 行验收表在 D3 v2 补齐模型项后为 18/18 pass，D3 v2 自身 11 项验收全 pass。

## 2. 修复内容（D2 + D3）

| 修复 | 位置 | 行为 |
| --- | --- | --- |
| DSH 0.2.2 投递事件 | `src/app/delivery.ts` | `AgentDelivery` 识别 `agent/inbox/spliced`，只把 `inserted` 非空的 splice 当作一次投递；live 流与持久化历史走同一读取路径，profile prompt 跨 resume 只投一次。 |
| 持久化状态探测 | `src/node/dsh-port-host.ts` | `inspectSession` 在无 live Agent 时回退 `sessionQuery.observeSession`：持久化存在 → `found:true` + `backendSessionId`、**无 `status`**（“已持久化但未挂载”，控制面据此 re-ensure）；不存在 → `found:false`；其他读错误抛出；observation lease 随即释放。有 live Agent 时仍返回真实 `status`/`ready`。 |
| 控制面存活与重连 | `src/control/control-plane.ts`、`src/control/http-node.ts`、`src/control/start.ts` | `registerNode` 每次使用唯一幂等键；周期 heartbeat 默认 10s（可注入，`close` 清理 timer）；心跳失败在本地记录 `node.status online:false`，离线命令返回 502；SSE 断线从 250ms 起逐次翻倍、上限 5s 重连；`onReconnect` 先 `nodeReconnected()` 轮换 generation，再发 heartbeat 刷新存活。 |
| Session 代次与 re-ensure | `src/shared/protocol.ts`、`src/control/control-plane.ts` | `SessionRecord.nodeGeneration` 在控制面启动、`offline → online`、SSE 重连时轮换；确认 ensure 时写入。代次过期时 `openProject`/`createWorkerSession` 与 `sendMessage` 先 re-ensure（Worker 用 assignment→ticket/assignmentId 回退）；`stopped`/`archived` 不因代次复活。 |
| 真实 backend Session id | `src/control/control-plane.ts` | 创建响应采用节点确认的真实 `backendSessionId`，不再是 `fake-` 前缀；节点报不出时保留占位，控制面不发明 id。 |
| 默认模型（D3） | `src/node/node-sessions.ts` | ensure 在 create/resume/复用的 live Agent 三条路径上调用 `applyDefaultModel` → `initializeRoleModel`，把 profile `agent-default-model` 的 `currentSelection()` 写成 Agent 的 `model/selection`；`RoleProfile.model` 仍优先，已有 selection/header 不重复写。profile 只需 `agent-default-model` + `llm-pi-ai` 两行和凭据，不再需要 `p2d-model-default` shim。 |
| 工具边界（D3） | `src/node/dsh-port-host.ts` | ensure 首轮前按 `RoleProfile.tools` 应用 `tools.restrict`：PM 把全部继承工具 deny，Worker 只保留 allow 命中的继承工具；`control_*` 在边界后注册，留在 own layer。`tools.guard` 作为 scope-local/越界调用的兜底；v2 的 PM 请求表没有 scope-local 残留，guard 实际拒绝由 `tests/node-tool-boundary.spec.ts` 单测覆盖。`RoleProfile.deny` 未单独消费（现有 deny 名字都在各自 tools 外，行为仍正确）。 |

## 3. E2E 环境

| 项 | 值 |
| --- | --- |
| Run | `p2d-e2e-fixed-3a6c`（2026-11-14 08:19–08:30 Asia/Shanghai，Windows） |
| 仓库 | HEAD `561f4b8` + 既有 P2-D2 工作区改动；本轮未改生产代码 |
| DSH | `0.2.2-rc.1`；节点是真实 `dsh --profile superagent-node` |
| 控制面 | 独立 `node lib/control.js`（宿主 Node `v26.12.1`） |
| 端口 | 节点 `127.0.0.1:47831`，控制面 `127.0.0.1:47830` |
| 隔离 | `DSH_HOME`、`DSH_AGENTS_HOME`、`SUPERAGENT_NODE_ROOT`、`SUPERAGENT_WORKSPACE_ROOT`、`SUPERAGENT_CONTROL_DB`、profile 都在 run 目录内 |
| 系统 home | `~/.dsh` 未作为 `DSH_HOME` 传入，也未读取其配置或凭据 |
| 凭据 | 节点 token 与控制面 token 只存在于 run 的 `tmp/` 和进程环境；证据与文档不含 token |
| Profile | `home/profiles/superagent-node/`（`dsh-base` bundle、PM/Worker preset、12 项 inject）；`node_modules/dsh-superagent` 的 `package.json`/`lib/` 与仓库同名文件逐一相同（`profile-build.txt`） |

节点只监听 47831（另有一条控制面事件流的 ESTABLISHED，不是监听端口），没有 Web/面板；控制面只监听 47830。

### 3.1 P2-D3 v2（无 shim）

| 项 | 值 |
| --- | --- |
| Run | `p2d-model-v2-f35fac`（2026-11-14 09:30–09:50 Asia/Shanghai） |
| 仓库/构建 | HEAD `561f4b8` + P2-D3 工作区改动；profile 内 `dsh-superagent` 是仓库 `package.json` + `lib/`（24 个文件，09:24 构建） |
| DSH / 控制面 | DSH `0.2.2-rc.1`；节点端口 47841，独立 `node lib/control.js` 端口 47840（宿主 Node `v26.12.1`） |
| Profile 模型行 | 只有 `agent-default-model`（`opencode-go` / `deepseek-v4.1-flash` / `high`）与 `llm-pi-ai`（`apiKeyEnv`）；`p2d-model-default` **0 行、0 目录** |
| 凭据 | 从上一轮 run 的 `.artifacts/p2d-e2e-fixed-3a6c/home/.credentials.yaml` 只读复制；系统 `~/.dsh` 未读写，凭据未打印 |
| Project / PM | `14c5fe9d4581b4b76fe5f8d4e406b2ab` / `pm-14c5fe9d4581b4b76fe5f8d4e406b2ab` |
| Ticket / Assignment / Worker | `b5289e02446599100758712c4abd08f8` / `b7f520f539e2d66561da781c7e73e17f` / `worker-b7f520f539e2d66561da781c7e73e17f`（NodeExecutor 自动创建） |
| report | `state=ready`，`17 + 25 = 42`；Ticket `ended.by=executor`、`outcome=completed` |
| 路由 | PM/Worker 都是 `opencode-go` / `deepseek-v4.1-flash` / `high`；`model/selection` 由产品代码在 turn 1 前写入 |
| 工具表 | PM 2 个：`control_project`、`control_create_tickets`；Worker 20 个，含 `control_report`、`read`/`write`/`pwsh`，不含 `control_project`/`control_create_tickets`/`orchestrator_*` |
| 验收 | `summary.json` 的 11 项验收全部 pass |

D3 v2 是对上一轮 shim 方案的替代验收：`.artifacts/p2d-e2e-fixed-3a6c/evidence/model/`（evidence-only `p2d-model-default`）只作为历史对照，不是最终验收。

## 4. 验收表

| # | 验收项 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 节点是真实 DSH、`--profile superagent-node`；控制面是独立 `node lib/control.js` | pass | `processes-boot1.json`、`processes-boot2.json` |
| 2 | 节点只监听 47831（无 Web/面板）；控制面监听 47830 | pass | `processes-boot1.json` 的 `nodeListeningSockets` |
| 3 | 两侧 `/health` 200；错误 node token 401 | pass | `health-node-http.json`、`health-control.json`、`auth-wrong-node-token.json` |
| 4 | `/v1/state` 显示 node online，无手动 heartbeat（10s `node.status` 序列） | pass | `state-online.json`、`events-before-control-restart.json` |
| 5 | PM 200；`sessionId == project.pmSessionId`；`backendSessionId == sessionId`（非 `fake-`）；`idle` | pass | `pm-create.json` |
| 6 | Worker 200；`backendSessionId == worker sessionId` | pass | `worker-create.json` |
| 7 | Worker message 200 `sent:true`；JSONL 有 `turn/start`、`turn/end` 与预期 `no provider/model` | pass | `worker-message.json`、`sessions-before.stats.json` |
| 8 | 慢重启：20s 内确认 `online:false` | pass（1.8s） | `state-offline-timeline.json`、`state-offline.json` |
| 9 | 慢重启离线窗口：PM 502、worker message 502 | pass | `pm-offline.json`、`worker-message-offline.json` |
| 10 | 慢重启恢复：20s 内 online，无手动 heartbeat | pass | `state-resume-timeline.json`、`node-2.stdout.log` |
| 11 | 慢重启后 PM 200，`sessionId`/`createdAt` 不变 | pass | `pm-after-slow-restart.json` |
| 12 | 慢重启后 worker message 200（先 re-ensure） | pass | `worker-message-after-slow-restart.json` |
| 13 | 重启后 `session.inspect`(PM)：`found:true`、`backendSessionId == pmSessionId`、**无 status** | pass | `node-inspect-pm-after-slow-restart.json`（worker 同样通过） |
| 14 | 每个 Session 的 `dsh-superagent:profile:<id>` inserted 次数 == 1 | pass | `prompt-counts.json`、`sessions-*.stats.json` |
| 15 | 快重启（心跳间隔内）：online、message 200、generation 轮换 | pass（间隔 1.1s） | `state-fast-restart-timeline.json`、`worker-message-after-fast-restart.json` |
| 16 | 控制面重启：同 DB/端口、node 自动 online、PM 同 id、message 200、prompt 1/1、无持续 stream failed | pass | `pm-after-control-restart.json`、`worker-message-after-control-restart.json`、`control-3.stderr.log` |
| 17 | 真实模型 PM→Ticket→NodeExecutor Worker→`control_report`（D3 v2，无 shim） | pass | `p2d-model-v2-f35fac`：Ticket `b5289e02…`、Worker `worker-b7f520…`、report `ready` + `17 + 25 = 42`、Ticket `completed` |
| 18 | 两次 run 均未改被跟踪文件、未 commit/push | pass | D2 `git-status-final.txt`（37 条，与运行前一致）；D3 `git-status-final.txt`（39 条，与运行前一致） |

> 计数口径：本表沿用 D2 证据 `README.md` 的 18 行验收表。D2 时点第 17 项为 blocked；D3 v2 补齐后为 18/18 pass。D3 v2 的 `summary.json` 另有 11 项验收，全部 pass。

## 5. 关键观测

- **慢重启**：kill 节点后 1.8s 首次采样到 `online:false`（10s 心跳失败立即 `markNodeOffline`，不是手动心跳）；离线窗口 PM 与 worker message 都是 502，body 为 `The node p2d-fixed-node is offline; the command was not sent`；同 profile 重启后自动 online，PM `sessionId`/`createdAt` 不变，generation 从 `8284d294…` 轮换为 `063aa822…`；worker message 前记录仍是旧 generation，200 说明 `sendMessage` 先做了 re-ensure。
- **inspect 的两种答案**：重启后、任何 ensure 之前，PM 与 Worker 都是 `{"found":true,"backendSessionId":"<same id>"}`，没有 `status`；PM ensure 之后再次 inspect 是 `{"found":true,"status":"idle","backendSessionId":"pm-…","ready":true}`。这区分了“已持久化但未挂载”和探测失败。
- **快重启**：kill 到重新监听 1.1s，小于 10s 心跳间隔，12s 内 59 次 `/v1/state` 采样 `offlineSamples=0`；SSE 掉线重连触发 `onReconnect` 轮换 generation，worker message 200，generation 变为 `0e230304…`。
- **控制面重启**：第一次重启被 stale lock 拒绝（见 §6.1），锁龄 87.9s 后第二次成功；`/v1/state` 自动 online，PM 200 同 id/`createdAt`，worker message 200，prompt 仍 1/1；`control-1.stderr.log` 只有两条与两次节点宕机对应的 `lost, reconnecting`，`control-3.stderr.log` 为空。
- **Profile prompt**：重启前、慢重启后、快重启后、控制面重启后，PM 与 Worker 的 inserted 计数都是 1；Worker 共 5 个 `turn/start`（role prompt + 4 条 message），role prompt 没有因 resume 重复。
- **D3 v2 无 shim**：`profile-check.txt`/`profile-dump.txt` 里 `p2d-model-default` 0 行、0 目录；profile 只剩 `agent-default-model` + `llm-pi-ai` 两行模型配置和凭据；`--dump-config` exit 0、stderr 0 字节、unknown plugin 0 条。凭据从上一轮 run 的 artifact 只读复制，系统 `~/.dsh` 未读写。
- **D3 v2 模型路由**：PM/Worker 的 `model/selection` 由 `node-sessions.applyDefaultModel` → `initializeRoleModel` 在 turn 1 前写入；两边 `request/header.config` 都是 `opencode-go/deepseek-v4.1-flash/high`，不是 shim 产物。
- **D3 v2 工具表**：PM 的 `request/header.tools` 只有 `["control_project","control_create_tickets"]`；Worker 20 个，含 `control_report`、`read`/`write`/`pwsh`，不含 `control_project`/`control_create_tickets`/`orchestrator_*`。Windows 上 `bash` 被 preset 禁用，Worker 的 shell 是 `pwsh`（不是同时有 bash/pwsh）。`restrict` 使请求表收窄；`guard` 作为 scope-local/越界调用的兜底，本轮没有 scope-local 残留，因此 guard 没有实际开火对象，其拒绝行为由 `tests/node-tool-boundary.spec.ts` 覆盖。
- **D3 v2 链路**：PM 用 `control_create_tickets` 建 Ticket `b5289e02…`，NodeExecutor 自动创建 Worker `worker-b7f520…` 并投递 task prompt，Worker 的模型 turn 调 `control_report` 写回同一 Ticket/Assignment（`ready`、`17 + 25 = 42`），Ticket 由 executor 结束为 `completed`；v2 `summary.json` 的 11 项验收全 pass。
- **PM 自动 turn 1**：role prompt 投递本身开始 PM turn 1；v2 中 PM 在操作员消息前自行建了 3 个 Ticket 并起了 3 个 Worker（随后取消）。这是产品行为/待决策项，不是本轮缺陷（见 §6.4）。
- **旧 shim 对照**：`.artifacts/p2d-e2e-fixed-3a6c/evidence/model/` 的 `p2d-model-default` 是上一轮 evidence-only 方案，只用于说明为什么需要 D3；不要把它当作最终验收。

## 6. 运维发现与剩余风险

1. **强杀控制面后的 proper-lockfile stale（未修复）**：E2E 用 `taskkill /F` 强杀控制面，锁仍年轻于 `stale: 30_000`，立即重启失败：`superagent control plane failed: Lock file is already being held`；等待锁过期后同 DB/端口重启成功。正常 SIGTERM/优雅停机不应触发。若要求 kill 后立即重启，需要优雅关闭或让启动等待锁过期；归 P2-F/运维，**当前没有修复**。
2. **节点重启后事件 `seq` 从 1 重新计数（未处理）**：E2E 观察到节点重启后 `seq` 回到 1；跨节点重启的 `/v1/events?after=N` 游标语义需要 P2-C/P2-F 明确。
3. **`RoleProfile.deny` 没有被单独消费（未实现）**：当前由 `RoleProfile.tools` 的 allowlist 收窄 + `tools.guard` 覆盖；现有 PM/Worker 的 deny 名字都不在各自 tools 内，所以行为正确，但“deny 独立语义”仍需后续实现。详见 [013 的剩余风险](013-p2d-node-spike.zh-CN.md)。
4. **PM 的 ensure role prompt 会自行开始 turn 1（产品观察，不是 bug）**：模型可用后，role prompt 投递本身会开始 PM 的 turn 1；v2 中 PM 在验收消息前自行建了 3 个 Ticket 并让 NodeExecutor 起了 3 个 Worker，这些 Worker 已取消以避免继续动作。当前产品行为是“role prompt 即首条消息”；若验收要求“干净的一问一答”，需要产品侧决定 ensure 是否应静默投递 role prompt。
5. **角色模型仍由节点 profile 默认决定**：控制面 `PM_PROFILE`/`WORKER_PROFILE` 没有 `model`；D3 让节点消费 profile 的 `agentDefaultModel`，所以角色路由由节点 profile 的默认值决定。若要让控制面按角色固定路由，仍需填 `RoleProfile.model`（产品决策/后续）。
6. **Phase 2 其余项已完成**：P2-A2、P2-B2、P2-C、P2-E、P2-F 已完成；TLS 直接实现、反向代理代码、控制面前端仍未做（TLS/反代部署建议见 `docs/016-control-plane-tls.zh-CN.md`，纯文本提及，本文不链接后续编号）。
7. **`Assignment.sessionId` 与真实 Session id 不一致（观察）**：Assignment 记录的是 `worker-<ticketId>`，而 NodeExecutor 实际创建并运行的是 `worker-<assignmentId>`；排障时以 `/v1/sessions` 和节点日志为准，不要据此新建 Session。

## 7. 证据索引

| 文件 | 内容 |
| --- | --- |
| `.artifacts/p2d-e2e-fixed-3a6c/evidence/README.md` | 本轮完整叙述、隔离项、偏差与验收表 |
| `.artifacts/p2d-e2e-fixed-3a6c/evidence/summary.json` | ids、createdAt、backendSessionId、generation、online 时间线、状态码、prompt 计数、PID/端口、验收表 |
| `pm-create.json`、`worker-create.json`、`worker-message.json` | 首次 PM/Worker/message 响应 |
| `pm-after-slow-restart.json`、`worker-message-after-slow-restart.json` | 慢重启后 PM/消息响应 |
| `pm-offline.json`、`worker-message-offline.json` | 离线窗口 502 |
| `worker-message-after-fast-restart.json`、`pm-after-control-restart.json`、`worker-message-after-control-restart.json` | 快重启/控制面重启后的消息与 PM 响应 |
| `state-online.json`、`state-offline-timeline.json`、`state-resume-timeline.json`、`state-fast-restart-timeline.json`、`state-final.json` | `/v1/state` 快照与时间线 |
| `events-*.json` | `/v1/events?after=0` 事件历史 |
| `node-inspect-pm-after-slow-restart.json`、`node-inspect-worker-after-slow-restart.json`、`node-inspect-pm-after-slow-ensure.json` | 节点协议直连 `session.inspect` |
| `sessions-before/`、`sessions-after-slow-restart/`、`sessions-after-fast-restart/`、`sessions-after-control-restart/`、`sessions-*.stats.json` | Session JSONL 与 profile/turn 统计 |
| `prompt-counts.json` | 原始字符串 + inserted 双口径的 profile 计数 |
| `processes-*.json`、`kill-*.json`、`control-*.stderr.log` | 进程、kill、锁错误与重连日志 |
| `git-status-final.txt` | 结束时的 `git status --porcelain`（37 条，与运行前既有改动集合一致） |

### 7.1 P2-D3 v2（`.artifacts/p2d-model-v2-f35fac/evidence/model-v2/`）

| 文件 | 内容 |
| --- | --- |
| `README.md` | 无 shim 模型链叙述、profile 证明、时间线与验收对照 |
| `summary.json` | ids、route、report、工具表、11 项验收、时间线、收尾 |
| `profile-check.txt` | profile 行数/哈希、构建来源、`--dump-config` 行数（`p2d-model-default` 0） |
| `profile-dump.txt` | `--dump-config` 全量（只有配置，无键值） |
| `tool-tables.json` | PM/Worker 实际工具表、禁用/必备集合、路由判定 |
| `pm-session.jsonl`、`worker-b7f520-session.jsonl` | 解压后的 PM/Worker Session 日志（无密钥） |
| `tickets-after-report.json`、`tickets-final.json`、`sessions-final.json` | Ticket/Assignment/report、取消后的 Ticket、Session 列表 |
| `events.json`、`chain-1-timeline.json` | 控制面事件流与轮询输出 |
| `pm-create.json`、`pm-message-1.json` | PM 创建、操作员消息 |
| `secret-scan.json`、`git-status-final.txt`、`ports-after-shutdown.txt` | 凭据泄漏扫描、最终 git 状态、停机证明 |

复现命令和 run 内脚本分别见两次 run 的 evidence `README.md` 与 `tmp/`；token 已脱敏，本文不重复启动参数。

P2-F 的部署文档与示例：`docs/015-node-deployment.zh-CN.md`、`docs/016-control-plane-tls.zh-CN.md`、`examples/profile.node/`（纯文本路径，本文不建立后续编号的 Markdown 链接）。
