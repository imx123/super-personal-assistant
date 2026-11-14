# P2-D Spike：独立 DSH 节点进程可行性

> 状态：spike 完成，结论 **GO（有条件）**；方案 A 第一阶段已实现。隔离真实 DSH 的 P2-D2 恢复 E2E 与 P2-D3 无 shim 真实模型/工具边界 E2E 均已完成，P2-D 验收项全 pass（见 §0.1、§5.8）。
> 范围：只回答 P2-D 的宿主可行性；不改生产代码，不 commit/push（§0.1 为实现/验收阶段的增补）。
> 环境：Windows；DSH `0.2.2-rc.1`；DSH 内置 Node `v24.21.0`。

## 0. 结论

1. **“裸 Node 进程”不可行。** DSH 的 `Context`、Session/Agent、持久化、工具、权限、Workspace、凭据解析都由 DSH 启动器（`dsh` CLI + profile 装载器）提供；脱离 DSH 宿主无法创建真实 DSH Session。`lib/node.js` 目前只是 `FakeNode` 入口（`src/node/main.ts`），不能作为真实节点。
2. **“独立 DSH profile 进程”可行，且已实测。** 用 `dsh --profile <name>` 启动一个只含 `@deepseek-ai/dsh-base` 的 profile，加一个只做节点服务的插件，就能在**没有 Web app、没有面板、没有 superagent 控制面 Runtime** 的独立进程中创建、恢复并驱动真实 DSH Session。
3. **控制面必须与 DSH 节点分进程。** 已验证：独立控制面进程通过 `SUPERAGENT_NODE_URL` 连到独立 DSH 节点，`node.register`、`pm.ensure`、`worker.create`、`session.message` 全部走真实 HTTP 协议；节点侧不再需要 Store/Engine/Sources/面板。
4. **不能复用 `src/index.ts` 作为节点入口。** 它的 `inject` 静态依赖 `webServer`，`apply()` 无条件构造完整 `Runtime`（Store/Engine/Sources/Setup/面板/主 Session），`startNodeServer` 又排在 `runtime.ready` 之后并受 `runtime.configured()` 门控；没有任何 env 能单独跳过这些耦合。节点入口必须是另一个插件入口。
5. **两个实现前必须处理的硬约束：**
   - 无头节点不能挂 `@deepseek-ai/dsh-api-session-controller`：它注入 `fileUploads`，而 `fileUploads` 来自 `@deepseek-ai/dsh-client-file-upload`，后者又依赖 Web 侧的 `connection`。节点侧应直接用 `ctx.agents.create/resume` + `ctx.sessionQuery`。
   - `dsh-superagent` 的 `engines.dsh`/peer 范围是 `^0.2.1-alpha.2`，而本机 DSH 是 `0.2.2-rc.1`，semver 不满足；DSH 在加载 profile bundle/行时会把它判为不兼容并跳过。上线前必须放宽范围或使用精确版本豁免（见 §6）。

## 0.1 实现状态（第一阶段 node-only 入口 + P2-D2 恢复 + P2-D3 模型/工具边界）

> 状态：**代码已实现并通过类型检查/构建/目标单测；P2-D2 恢复 E2E 与 P2-D3 无 shim 模型/工具边界 E2E 已跑（2026-11-14，未 commit）**。P2-D 验收项全 pass；Phase 2 其余项（P2-A2/B2/C/E/F）也已完成；D2 中 blocked 的真实模型链已由 D3 的 v2 run 补齐（`p2d-model-v2-f35fac`，无 shim）。

已落地：

| 项 | 位置 | 说明 |
| --- | --- | --- |
| node-only Sessions | `src/node/node-sessions.ts` | `createNodeSessions(ctx)` 实现 `DshPortSessions`：live → `sessionQuery.observeSession` → `agents.resume` / `agents.create`；按角色挂 `dsh-superagent-pm` / `dsh-superagent-worker` preset（`agentPresets.resolve` + setup 里 `mount`），create 时写 `meta.agentPreset`；`sessionTitle.rename(session, title)` 改名（同标题不重复写）；`RoleProfile.model` 作为 `agentOptions.model` 传给 create/resume，未给定时在 create/resume/复用的 live 三条路径调用 `initializeRoleModel` 消费 `agentDefaultModel.currentSelection()`；`prompt` 复用 `AgentDelivery`（`ctx.sessionPersistence`）做跨重启幂等。不挂 `sessionController`/`fileUploads`/`webServer`。 |
| 节点插件入口 | `src/node/plugin.ts` | `name = 'dsh-superagent-node'`、spike §1.2 的 12 项 `inject`；`readNodeEnvironment()` 读 `SUPERAGENT_NODE_TOKEN/PORT/HOST/ID/ROOT`、`SUPERAGENT_CONTROL_URL` 并校验；`apply` 构造 `DshNodePort` + `createDshPortHost` + `startNodeHttpServer`，`ctx.effect(() => () => server.close())`，启动日志只有监听 URL。不构造 Runtime/Store/Engine/Sources/面板。 |
| profile 过界 | `src/node/dsh-port.ts`、`dsh-port-host.ts` | `DshPortHost.ensureSession` 新增完整 `profile: RoleProfile`；`pm.ensure` / `worker.create` 传完整 profile；host 在首轮前用 `permissionPresetFor` 把 tier 映射到本节点可用的 preset 并 `permissionPresets.set`，无法表达则让 ensure 失败（不是静默放宽）。 |
| 发布形态 | `package.json`、`tsdown.config.ts` | `exports["./node"]` → `lib/node-plugin.{js,d.ts}`；tsdown 入口 `node-plugin: 'src/node/plugin.ts'`。 |
| 兼容范围 | `package.json` | `engines.dsh` 与所有 `@deepseek-ai/dsh-*` peer 放宽为 `^0.2.1-alpha.2 \|\| ^0.2.2-rc.1`（精确列出 0.2.2 预发布，不是 `*`；0.2.2-rc.1 与 0.2.2 正式版满足，0.2.3 预发布仍需再放宽）。devDependencies 仍锁 0.2.1-alpha.2，`pnpm typecheck` 跑在该类型面上。 |
| 测试 | `tests/node-plugin.spec.ts` | 25 个纯单测：ensure create/resume/live、preset、title 去重、`RoleProfile.model`、`agentDefaultModel` 在 create/resume/live 的 seed 与不重复 seed、默认路由不可解析时 ensure 失败、prompt 幂等 key、未加载 Session 拒绝；host 应用 permission（含不可表达 tier 失败）与 `profile:<sessionId>` 角色 prompt 只投一次；env 缺失/端口非法/root 相对/control URL 非 http 的 fail-fast；`apply` 缺环境、端口占用失败，以及监听/健康检查/effect 关闭。 |
| 投递幂等（D2） | `src/app/delivery.ts` | `AgentDelivery` 同时识别 DSH 0.2.2 的 `agent/inbox/spliced`（`inserted` 非空才算投递）与旧的 `user/message`；live 流与持久化历史走同一读取路径，profile prompt 跨 resume 只投一次（E2E 每个 Session inserted 恒 1）。 |
| 持久化探测（D2） | `src/node/dsh-port-host.ts` | 无 live Agent 时 `inspectSession` 回退 `sessionQuery.observeSession`：持久化存在 → `found:true` + `backendSessionId`，**无 `status`**（“已持久化但未挂载”，控制面据此 re-ensure）；不存在 → `found:false`；其他读错误抛出；observation lease 随即释放。 |
| 控制面存活/重连（D2） | `src/control/control-plane.ts`、`http-node.ts`、`start.ts` | `registerNode` 每次用唯一幂等键；周期 heartbeat 默认 10s（可注入，`close` 清理）；心跳失败本地记 `node.status online:false`，离线命令 502；SSE 断线从 250ms 起逐次翻倍、上限 5s 重连；`onReconnect` 先 `nodeReconnected()` 轮换 generation 再 heartbeat。 |
| 代次与 re-ensure（D2） | `src/shared/protocol.ts`、`src/control/control-plane.ts` | `SessionRecord.nodeGeneration` 在控制面启动、offline→online、SSE 重连时轮换；确认 ensure 时写入。代次过期时 `openProject`/`createWorkerSession` 以及 `sendMessage` 先 re-ensure（Worker 用 assignment→ticket id 回退）；`stopped`/`archived` 不因代次复活。创建响应 `backendSessionId` 采用节点真实 id，节点报不出时保留占位。 |
| 默认模型（D3） | `src/node/node-sessions.ts` | ensure 在 create/resume/复用的 live Agent 三条路径上调用 `applyDefaultModel` → `initializeRoleModel`，把 profile 的 `agent-default-model` 的 `currentSelection()` 写成 Agent 的 `model/selection`；`RoleProfile.model` 仍优先，已有 selection/header 不重复写。profile 只需 `agent-default-model`（provider/model/reasoningEffort）与 `llm-pi-ai`（apiKeyEnv）两行，不再需要 `p2d-model-default` shim。 |
| 工具边界（D3） | `src/node/dsh-port-host.ts` | ensure 首轮前按 `RoleProfile.tools` 应用 `tools.restrict`：PM 把全部继承工具 deny、Worker 只保留 allow 命中的继承工具；`control_*` 在边界后注册，留在 own layer。`tools.guard` 作为 scope-local/越界调用的兜底；v2 中 PM 请求表没有 scope-local 残留，guard 的实际拒绝由 `tests/node-tool-boundary.spec.ts` 单测覆盖。`RoleProfile.deny` 未单独消费（现有 deny 名字都在各自 tools 外，行为仍正确）。 |
| E2E（D2） | `.artifacts/p2d-e2e-fixed-3a6c/evidence/` | 隔离 `DSH_HOME`/`DSH_AGENTS_HOME`/profile，真实 `dsh --profile superagent-node` + 独立 `node lib/control.js`；覆盖慢/快节点重启、控制面重启、离线 502、inspect 无 status、prompt 1/1；当时 18 项中 17 pass、1 blocked（模型项）。 |
| E2E（D3 v2） | `.artifacts/p2d-model-v2-f35fac/evidence/model-v2/` | 无 shim（`p2d-model-default` 0 行/0 目录），凭据从上一轮 run 的 artifact 复制、系统 `~/.dsh` 未读写；PM 用 `control_create_tickets` 建 Ticket，NodeExecutor 自动建 Worker，Worker `control_report` 写回 `ready` + `17 + 25 = 42`，Ticket `completed`；PM 实际工具表 2 个、Worker 20 个。 |
| 本轮回归 | `tests/` | D3 收口时 28 files / 223 tests；最终 Phase 2 回归 37 files / 299 tests 通过。其中 `tests/node-plugin.spec.ts` 25、`tests/dsh-port.spec.ts` 22、`tests/node-tool-boundary.spec.ts` 6、`tests/control-plane-recovery.spec.ts` 14；P2-A2/B2/C/E/F 的定向测试见 `docs/012`。 |

E2E 摘要（D2：`.artifacts/p2d-e2e-fixed-3a6c/evidence/`）：隔离 DSH home/profile，节点是真实 `dsh --profile superagent-node`（DSH `0.2.2-rc.1`），控制面是独立 `node lib/control.js`。慢重启后心跳在 1.8s 内记 `online:false`，离线窗口 PM/消息 502；同一 profile 重启后自动 online，PM 的 `sessionId`/`createdAt` 不变，worker message 先 re-ensure 再 200；`session.inspect` 在 ensure 前返回 `found:true` + `backendSessionId` 且无 `status`；快重启落在心跳间隙内，由 SSE 重连轮换 generation；控制面重启后自动 online，prompt 仍为 1/1。D2 当时唯一 blocked 是真实模型链，已由 D3 v2 补齐。

E2E 摘要（D3 v2：`.artifacts/p2d-model-v2-f35fac/evidence/model-v2/`）：profile 已删除 evidence-only 的 `p2d-model-default`（0 行/0 目录），只保留 `agent-default-model` + `llm-pi-ai` 两行模型配置和凭据；凭据从上一轮 run 的 artifact 只读复制，系统 `~/.dsh` 未读写。PM `model/selection` 与 Worker 都由产品代码在 turn 1 前写入 `opencode-go/deepseek-v4.1-flash/high`；PM 用 `control_create_tickets` 建 Ticket `b5289e02…`，NodeExecutor 自动建 `worker-b7f520…`，Worker 用 `control_report` 写回同一 Ticket/Assignment（`state=ready`、`17 + 25 = 42`），Ticket `ended completed`。PM 实际工具表只有 2 个名字，Worker 20 个（shell 是 `pwsh`，`bash` 在 Windows 被 preset 禁用）。上一轮 shim run（`.artifacts/p2d-e2e-fixed-3a6c/evidence/model/`）只作为历史对照，不是最终验收。D2 修复与验收表的独立记录见 `docs/014`（本文保留 spike 视角，不把第一阶段写成全部完成）。

与 spike 的差异（按真实 API 调整，未猜）：

1. `sessionTitle` 的真实接口是 `rename(session, title)` / `get(session)`，参数是 **Session 对象**，不是 sessionId；实现按此调用，并在标题已一致时跳过，保证 `pm.ensure` 重发不重复 append。
2. `sessionQuery.observeSession(id, { projectionMode })` 返回 **caller-owned observation lease**（`[Symbol.dispose]`）。实现里只判断存在性，随即释放，否则该 prepared-Session 缓存条目会被永久 pin 住。
3. `agents.create` / `agents.resume` 返回 `AgentHandle`（`.agent` 持有）。实现解包后只保留 Agent：生命周期仍归 DSH 的 profile 树，节点不额外 dispose。
4. `agentPresets` 的 `resolve(id)`、`mount(agentCtx, id)`、`preselect` 语义与 spike 一致；`mount` 在 setup 回调里执行，Agent 发布前就带上 preset 的工具/提示段。
5. host 应用 `permission` 对**同进程路径**也生效：`src/app/sessions.ts` 的 `Sessions.ensure` 仍先按角色选 preset，随后 host 用 `RoleProfile.permission` 的映射结果覆盖。`src/index.ts` 的代码与启动行为未改，但 PM/Worker 的最终权限会更贴近控制面 profile；若要保留旧行为，控制面应把 `RoleProfile.permission` 设成对应角色的 `auto` / `danger-full-access`。

仍未完成（不假装）：

- `RoleProfile.tools` 已在节点应用（D3：`tools.restrict` 按继承集合收窄 + `tools.guard` 兜底）；`RoleProfile.deny` 没有被单独消费。当前行为由 tools allowlist + guard 覆盖，现有 PM/Worker 的 deny 名字都不在各自 tools 内，所以行为正确；但“deny 独立语义”仍是未实现项（§6.3）。
- `RoleProfile.permission` 已由 host 应用，但 `permission.set` 命令仍把 tier 原样传给 `permissionPresets.set`；控制面若改发 tier 而非 preset 名，需要同样映射（留到后续）。
- `RoleProfile.model` 仍优先；未给定时节点在 create/resume/live 路径消费 profile 的 `agentDefaultModel`（`initializeRoleModel`），控制面 `PM_PROFILE`/`WORKER_PROFILE` 仍未填 `model`，角色路由由节点 profile 的默认值决定。
- PM 的 `pmToolBoundary` 守卫、Worker 的 `workOnly` 白名单、skill scope 未移植：它们依赖 Store/Settings/Prompts（控制面领域），节点-only 进程没有这些；节点侧的继承工具边界和 guard 已按 `RoleProfile.tools` 生效，但完整 decorate 仍不能算已移植。
- PM 的 role prompt 投递会自行开始 turn 1；D3 v2 中 PM 在验收消息前自行建了 3 个 Ticket 并起了 Worker（已取消）。这是“ensure 的 role prompt 是否应静默投递”的产品决策，不是已修复缺陷（§6.11）。
- 示例 profile 已整理到 `examples/profile.node/`（README、`package.json`、`cordis.patch.yml`），部署说明见 `docs/015-node-deployment.zh-CN.md`；剩余边界是仓库副本只做静态校验，没有在写文档时重新启动（E2E 用的是 run 内副本）。

## 1. DSH 能否启动“只有节点插件”的独立进程

### 1.1 结论：能，但入口是 DSH profile，不是裸 Node

`dsh` CLI 的启动链（安装目录 `<DSH>/resources/runtime/cli/bin/dsh`，Windows 为 `dsh.cmd`）本质上是：

```text
Electron 二进制 + ELECTRON_RUN_AS_NODE=1
  -> @deepseek-ai/dsh-desktop-host/lib/cli.js
  -> @deepseek-ai/dsh/lib/bin.js
  -> profile-boot：按 profile 的 bundle 列表叠加 patch，挂载 Cordis 树
  -> “进程生命周期交给已挂载插件”
```

它的帮助里明确说明 `dsh <name>` 启动的是 `$DSH_HOME/profiles/<name>`；`dsh web`、`dsh headless` 只是不同的 app bundle。**不需要 Web 窗口**。

关键点：`profile-boot` 并不要求必须有 `dsh-web-app` 或 `dsh-headless`。只要树里有插件持有事件循环（HTTP server），进程就会常驻；SIGINT/SIGTERM 时由启动器统一 dispose。

### 1.2 已验证的最小 profile

`.artifacts/p2d-spike/home/profiles/p2d-node/`（临时 DSH_HOME 内）：

```text
profiles/p2d-node/
  package.json              # dsh.profile.bundles = ["@deepseek-ai/dsh-base"]
  cordis.yml                # []
  cordis.patch.yml          # 插入 workspace、preset registry、preset、节点插件
  node_modules/p2d-node-http/  # spike 用的节点插件（生产改为 dsh-superagent/node）
```

实测的完整组合。`$DSH_HOME/profiles/superagent-node/package.json`：

```json
{
  "name": "dsh-profile-superagent-node",
  "private": true,
  "dependencies": { "dsh-superagent": "file:<repo>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
```

```yaml
# 同目录 cordis.patch.yml（骨架；preset.plugins 复用仓库根 cordis.patch.yml 的 PM/Worker 定义）
- insert:
    - id: node-workspace
      name: '@deepseek-ai/dsh-workspace'
    - id: node-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: dsh-superagent-worker
    - id: dsh-superagent-worker-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: dsh-superagent-worker
        plugins: []          # 实现时从 cordis.patch.yml:20-120 原样复制
    - id: dsh-superagent-pm-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: dsh-superagent-pm
        plugins: []          # 实现时从 cordis.patch.yml:198-224 原样复制
    - id: dsh-superagent-node
      name: 'dsh-superagent/node'
      inject: [agents, sessionQuery, sessionPersistence, workspaceRegistry, permissionPresets,
        tools, systemPrompt, skills, subprocess, llm, agentDefaultModel, agentPresets]
```

**不需要**：`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-client-file-upload`。
`@deepseek-ai/dsh-headless` 是**一次性**任务模式（`dsh headless "<task>"`，用完即退出），不适合常驻节点。

节点插件的最小 `inject`（与 spike 实测一致）：

```ts
export const inject = ['agents', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry',
  'permissionPresets', 'tools', 'systemPrompt', 'skills', 'subprocess', 'llm',
  'agentDefaultModel', 'agentPresets']
```

实测 `ctx.get()` 结果（节点进程内）：

```json
{"agents":true,"sessionQuery":true,"sessionPersistence":true,"workspaceRegistry":true,
 "permissionPresets":true,"tools":true,"systemPrompt":true,"skills":true,"subprocess":true,
 "llm":true,"agentDefaultModel":true,"agentPresets":true,
 "sessionController":false,"fileUploads":false,"webServer":false,"settings":true,"storageDomain":true}
```

### 1.3 真实 DSH Session 的创建与恢复（已实测）

节点插件不必挂 `sessionController`，直接使用 `ctx.agents`：

```ts
// 已有 live Agent
const live = ctx.agents.get(sessionId)

// 已持久化：先观察是否存在
let observed
try { observed = await ctx.sessionQuery.observeSession(sessionId) }
catch (e) { if (e?.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw e }

// 恢复
await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })

// 新建
await ctx.agents.create({ sessionId, agentOptions, meta: { cwd, agentPreset }, setup })
```

`setup` 对应 preset 的挂载：

```ts
const presets = ctx.get('agentPresets')
const resolved = await presets.resolve('dsh-superagent-worker')
const setup = async agentCtx => { await presets.mount(agentCtx, resolved.id) }
```

实测结果：

- 首次创建：`mode: "created"`，`header.agentPreset` 为 profile 中定义的 preset。
- 杀掉进程、重启同一 profile 后再次 ensure：`mode: "resumed"`，`createdAt` 不变，`workspaceId` 复用。
- 持久化文件：`$DSH_HOME/sessions/<编码后的 workspace>/p2d-probe-session/session.v4.jsonl.zstd`。
- Workspace 注册表：`$DSH_HOME/storages/workspace.json`。

> 注意：spike 的节点适配器**故意不真正投递 prompt**（不触发模型调用），因此只证明了“Session 创建/恢复/工具挂载/HTTP 协议”，没有证明一次真实模型 turn 和 Worker `control_report`。后者属于实现后的验收（§5）。

### 1.4 启动命令与环境变量

```bash
# 独立 DSH_HOME：绝不使用 ~/.dsh
export DSH_HOME=/srv/superagent/node/dsh-home
export DSH_AGENTS_HOME=/srv/superagent/node/agents   # 隔离 skills/AGENTS.md（建议）
export DSH_TELEMETRY_DISABLED=1

# 节点服务
export SUPERAGENT_NODE_TOKEN=<随机 32+ 字节，不等于控制面 token>
export SUPERAGENT_NODE_PORT=47101
export SUPERAGENT_NODE_HOST=127.0.0.1
export SUPERAGENT_NODE_ID=node-1
export SUPERAGENT_NODE_ROOT=/srv/superagent/node             # 绝对路径
export SUPERAGENT_CONTROL_URL=http://127.0.0.1:47100         # 可选：注册 PM/Worker 代理工具

# 首次安装插件（profile 目录内 pnpm）
dsh plugin --profile superagent-node add file:<repo>

# 先干跑组合，再启动
dsh --profile superagent-node --dump-config
dsh --profile superagent-node
```

Windows 下 `dsh` 由安装器放进 PATH（或直接用 `<DSH 安装目录>/resources/runtime/cli/bin/dsh.cmd`）；`$DSH_HOME` 用普通目录即可，但必须是**专用目录**，不要指向用户默认 profile 所在目录。

启动日志应只有节点自己的监听行，例如：

```text
[p2d-node] p2d-node listening on http://127.0.0.1:48232
```

没有 Web app、没有浏览器、没有面板 HTTP。

## 2. 最小可行替代：独立 DSH profile，而不是同进程

| 方案 | 是否可行 | 说明 |
| --- | --- | --- |
| 裸 Node 进程 `node lib/node.js` 创建 DSH Session | **否** | 没有 DSH Context/服务/持久化；只能 FakeNode |
| 独立 DSH profile 启动节点插件 | **是（推荐）** | 本文实测；控制面独立进程 |
| 控制面与 DSH 插件同进程 | 可行但不符合 P2-D | 即当前 `src/index.ts` 形态；无法做到“节点失联/重启”独立语义 |

“独立 DSH profile”不是“另一个 DSH 桌面应用”：它不加载 `dsh-web-app`，不启动 Electron 窗口，只是一个由 `dsh` CLI 启动的插件宿主进程。控制面仍然是 `pnpm control`（`lib/control.js`）独立进程。

## 3. `src/index.ts` 的耦合与可跳过项

### 3.1 当前启动链

```text
src/index.ts:16  apply(ctx, config)
  :29  new Runtime(runtimePlatform(ctx), machine, restart)
  :30  new OrchestratorService(ctx, runtime)
  :32  await runtime.ready
  :34  startNodeServer(ctx, runtime, machine.stateDir)
         :45-47 只有 SUPERAGENT_NODE_TOKEN + SUPERAGENT_NODE_PORT 同时存在才启动
         :51-54 runtime.configured() 为 false 时拒绝启动
         :61-63 DshNodePort + createDshPortHost
         :65    startNodeHttpServer
         :70-73 端口错误只记日志，不让插件失败
```

### 3.2 各组件耦合

| 组件 | 位置 | 节点-only 是否必需 | 现有 env 能否跳过 |
| --- | --- | --- | --- |
| `Runtime` 整体 | `src/app/runtime.ts:93-238` | 否 | **不能** |
| Store / SQLite / 目录锁 | `runtime.ts:99-110` | 否 | 不能 |
| Setup（部署检查、worker CLI probe） | `runtime.ts:113-115`, `:303-309` | 否 | 不能；且 `configured()` 反过来门控节点启动 |
| Prompts / Settings / Assessor / Outbox / Passes | `runtime.ts:119-217` | 否 | 不能 |
| Engine（控制面领域） | `runtime.ts:179-212` | 否 | 不能 |
| Sources（GitHub/Feishu） | `runtime.ts:125-132` | 否 | 不能 |
| 主 Session（master） | `runtime.ts:311` | 否 | 不能 |
| 面板 HTTP 路由 | `runtime.ts:299`, `:321-329` | 否 | 不能；`initialize()` 总会注册，因此 `inject: ['webServer']` 是硬依赖 |
| DSH 节点 runtime（Sessions + DshExecutor） | `runtime.ts:156-166`, `dsh-node.ts:27-35` | 部分：Sessions 需要；Executor 不需要 | 不能单独选择 |
| NodePort HTTP | `index.ts:44-74` | 是 | 只受 `SUPERAGENT_NODE_*` 控制 |

### 3.3 节点侧真正需要的 DSH 边界

`src/node/dsh-port-host.ts` 已经足够窄：

- 输入只有 `context` + `nodeRuntime.sessions.ensure/prompt`（`:44-63`，`:29-32`）。
- 它用 `context.agents`、`context.workspaceRegistry`、`context.permissionPresets` 和 `context.on(...)`（`:130-231`）。
- 不依赖 Store、Engine、Sources、面板。
- `createDshPortHost` 在 `controlUrl` 存在时给 Agent 注册 `control_project` / `control_create_tickets` / `control_report`（`:113-127`）。
- `DshNodePort` 只做协议映射、幂等、事件序号（`dsh-port.ts:142-169`），也不依赖控制面。

因此，一个 node-only 入口可以复用 `DshNodePort` + `DshPortHost` + `startNodeHttpServer`，只替换“`Sessions` 子集”的实现。**spike 已用真实 `DshNodePort` 验证这一点**（`p2d-node-http` 直接 import 仓库 TS）。

### 3.4 不能按 env 跳过的具体证据

- `src/index.ts:14` 的 `inject` 含 `webServer`；没有 `webServer` 的 profile 里该插件永远不会 activate，即使 env 设了节点 token/port。
- `src/index.ts:32-34` 必须先 `await runtime.ready`；`runtime.ready` 内部会 `setup.run()`，未配置部署时节点端口不启动（`:51-54` 的 warning）。
- `src/app/runtime.ts:299` 在 setup 之前就注册面板路由；`runtime.httpHost()`（`:321-329`）需要 `settings/store/sources/engine/executor`。
- `src/index.ts:70-73` 对端口冲突只 log；P2-D 的“启动失败 fail-fast”要求节点入口不能沿用这段。

## 4. 方案对比与实现步骤

### 4.1 方案 A（推荐）：独立 profile + 新 node-only 入口

> 第一阶段已按本节 1–3 实现，见 §0.1；第 4 项（示例 profile 文件）仍未入库，真实 profile 已在 D2/D3 E2E 中启动，D3 v2 的无 shim 模型链已通过。

**改动文件（实现阶段）：**

1. `src/node/plugin.ts`（新）
   - 导出 `name = 'dsh-superagent-node'`、`inject = [...]`（§1.2 列表）、`apply(ctx)`。
   - `apply` 中构造 `DshNodePort` + `createDshPortHost` + `startNodeHttpServer`。
   - 参数全部来自 env：`SUPERAGENT_NODE_TOKEN/PORT/HOST/ID/ROOT`、`SUPERAGENT_CONTROL_URL`。
   - 缺 token/port/root、端口非法、端口占用：**直接 throw**，让 DSH 启动失败（P2-F fail-fast）。
   - `ctx.effect(() => () => server.close())`；DSH 的 SIGTERM 会 dispose 整棵树。
2. `src/node/node-sessions.ts`（新）
   - 实现 `DshPortSessions.ensure/prompt`：
     - `ensure`：live → `observeSession` → `agents.resume` / `agents.create`；按 `role` 选 `dsh-superagent-pm` / `dsh-superagent-worker` preset；设置 `permissionPresets`；用 `sessionTitle` 改名（base 已有）；未给 `RoleProfile.model` 时在三条路径消费 `agentDefaultModel` 并调用 `initializeRoleModel`。
     - `prompt`：复用 `src/app/delivery.ts` 的 `AgentDelivery`（只依赖 Context 和 `sessionPersistence`，不强依赖 Store），做跨重启幂等投递；注意它运行期还 import `freezeMessage`/`MessageId` from `@deepseek-ai/dsh-llm`，需确认 profile 运行期能解析该 peer（spike 未覆盖这条路径）。
   - **实现时补上的缺口（已接线）**：`DshPortHost.ensureSession` 现在接收完整 `RoleProfile`；host 在首轮前应用 `permission`、`tools.restrict`（按继承集合）和 `tools.guard`，`model` 经 create/resume/默认模型路径传入。`tools/deny/permission/model` 不再在 `dsh-port.ts` 被丢弃。`RoleProfile.deny` 仍未独立消费（§6.3）。
   - 角色装饰（PM 工具边界、Worker 工具白名单、skill scope）需要从 `src/app/sessions.ts:192-218`、`:92-103`、`:433-460` 移植最小子集；本轮已按 `RoleProfile.tools` 做继承工具边界，但 Store/Settings/Prompts 相关的装饰仍未移植。
3. `package.json` 增加导出：

   ```json
   "./node": { "types": "./lib/node-plugin.d.ts", "default": "./lib/node-plugin.js" }
   ```

   `tsdown.config.ts` 增加 `'node-plugin': 'src/node/plugin.ts'` 入口。节点 profile 只加载构建产物，不直接跑 `.ts`（见 §6 的 strip-only 限制）。
4. `examples/profile.node/`（目录：`README.md`、`package.json`、`cordis.patch.yml`）
   - 只放 base + workspace + preset registry + PM/Worker preset 行 + `dsh-superagent/node`（以及 `agent-default-model` / `llm-pi-ai` 两行模型配置；不要 evidence-only 行）。
   - PM/Worker preset 直接复用现有 `cordis.patch.yml:20-224` 的定义；**不要**把 `dsh-superagent` 顶层 bundle（`cordis.patch.yml:4-12`）整包加载，否则仍会挂 Runtime/GitHub/Feishu。
5. `docs/` 增加部署说明：profile 安装、隔离 DSH_HOME、token/端口、workspace root 对齐、`lib/node.js` 的去向（保留为测试/兼容入口，真实节点走 `dsh --profile`）。

### 4.2 方案 B（备选）：runtime-lite

不新增 adapter，而是在节点进程内只实例化 `Store`/`Prompts`/`Effects`/`Sessions` 的最小子集，复用现有 `Sessions.ensure/decorate`。问题：

- `Sessions` 构造与装饰强依赖 Store/Settings/Prompts/Effects（`src/app/sessions.ts:137-190`、`:192-218`）。
- 仍要打开 SQLite 和目录锁，节点进程会拥有控制面领域的写路径，违背 P2-D “节点侧不运行控制面 Engine 写路径”。
- `Sessions.ensure` 走 `sessionController`，而无头 profile 挂不了它（§0）。

结论：仅当方案 A 的装饰移植成本不可接受时考虑；不建议。

### 4.3 方案 C（拒绝）：控制面与 DSH 插件同进程

即现状 `src/index.ts`。它满足“真实 DSH Session”，但不满足 P2-D 的“独立节点进程、节点重启对账、控制面不假成功”。不作为 P2-D 交付形态。

## 5. 验收命令

以下以“控制面 `127.0.0.1:47100`、节点 `127.0.0.1:47101`”为例；路径均为占位符。

### 5.1 启动节点

```bash
export DSH_HOME=/srv/superagent/node/dsh-home
export DSH_AGENTS_HOME=/srv/superagent/node/agents
export DSH_TELEMETRY_DISABLED=1

export SUPERAGENT_NODE_TOKEN='<random-node-token>'
export SUPERAGENT_NODE_PORT=47101
export SUPERAGENT_NODE_ID=node-1
export SUPERAGENT_NODE_ROOT=/srv/superagent/node
export SUPERAGENT_CONTROL_URL=http://127.0.0.1:47100

dsh --profile superagent-node --dump-config | grep -E 'dsh-superagent/node|dsh-workspace|agent-preset'
dsh --profile superagent-node
```

另一终端：

```bash
curl -fsS http://127.0.0.1:47101/health
# {"ok":true,"service":"superagent-node"}

# 认证必须是节点 token
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Authorization: Bearer wrong' -H 'content-type: application/json' \
  http://127.0.0.1:47101/commands -d '{}'
# 401
```

### 5.2 启动控制面并连接节点

```bash
export SUPERAGENT_CONTROL_TOKEN='<operator-token>'
export SUPERAGENT_CONTROL_PORT=47100
export SUPERAGENT_CONTROL_DB=/srv/superagent/control/control.sqlite
export SUPERAGENT_WORKSPACE_ROOT=/srv/superagent/node/workspaces   # 必须在 NODE_ROOT 之下
export SUPERAGENT_NODE_URL=http://127.0.0.1:47101
export SUPERAGENT_NODE_TOKEN='<random-node-token>'
export SUPERAGENT_NODE_ID=node-1

pnpm control
```

```bash
curl -fsS http://127.0.0.1:47100/health
curl -fsS -H "Authorization: Bearer $SUPERAGENT_CONTROL_TOKEN" \
  http://127.0.0.1:47100/v1/state
# nodes.node-1.online 应为 true，events 至少 1（node.status）
```

> `SUPERAGENT_WORKSPACE_ROOT` 必须在 `SUPERAGENT_NODE_ROOT` 之内。控制面把绝对 workspace 路径发给节点，节点用 `nodeWorkspace` 做词法越界检查（`dsh-port.ts:86-94`）；两个 root 不对齐会报 “Workspace escapes the node root”。spike 已验证对齐后可创建 PM/Worker。

### 5.3 准备一个 Project

最小 HTTP API 没有“创建 Project”端点；Project 由 Engine 的 Trigger 产生（`Engine.createProject` 要求 Trigger 已存在）。验收时二选一：

- 使用真实 Source（GitHub/Feishu）产生 Trigger；或
- 用测试专用脚本在控制面 DB 中先写一条 Trigger 再 `createProject`。spike 的 `.artifacts/p2d-spike/seed-project.mjs` 是可用样例（`ControlPlane` + `FakeNode`，只用于临时库），**实现阶段应把它整理成 `scripts/` 下明确标注 test-only 的工具**，不要进产品路径。

### 5.4 创建 PM

```bash
export PROJECT_ID='<project-id>'
curl -fsS -X POST \
  -H "Authorization: Bearer $SUPERAGENT_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  "http://127.0.0.1:47100/v1/projects/$PROJECT_ID/pm" -d '{}'
```

验收点：

- 返回 `session.status === "idle"`；
- 节点侧 `curl http://127.0.0.1:47101/health` 正常；
- `$DSH_HOME/sessions/.../pm-$PROJECT_ID/session.v4.jsonl.zstd` 出现；
- 控制面 `GET /v1/sessions` 能看到 PM；
- 节点日志出现 `control_project` 工具注册（`SUPERAGENT_CONTROL_URL` 已设置时）。

### 5.5 创建 Worker

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SUPERAGENT_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  "http://127.0.0.1:47100/v1/projects/$PROJECT_ID/workers" \
  -d '{"assignmentId":"a1","ticketId":"t1"}'

curl -fsS -X POST \
  -H "Authorization: Bearer $SUPERAGENT_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  "http://127.0.0.1:47100/v1/sessions/worker-a1/message" \
  -d '{"text":"start the assignment"}'
```

验收点：Worker `idle`；消息 `{"sent":true}`；节点日志出现对应 prompt。

### 5.6 Report

Report 是 Worker 的 `control_report` 工具调用，必须有一次真实 Worker turn：

1. 节点 profile 配好模型凭据（`$DSH_HOME/.credentials.yaml`，或专用 `DEEPSEEK_API_KEY` 等）。
2. PM 通过 `control_create_tickets` 创建 Ticket，Worker 启动后调用 `control_report`。
3. 验证：

```bash
curl -fsS -H "Authorization: Bearer $SUPERAGENT_CONTROL_TOKEN" \
  http://127.0.0.1:47100/v1/tickets
curl -fsS -H "Authorization: Bearer $SUPERAGENT_CONTROL_TOKEN" \
  "http://127.0.0.1:47100/v1/events?after=0"
```

若没有真实模型，只能用测试工具按控制面 secret 签一个 Worker session token，直接 `POST /v1/tools/worker/report`，这只能验证控制面/Engine 的 Report 路径，**不能**替代“节点 proxy tool 真的被模型调用”的验收。

### 5.7 重启对账

```bash
# 杀掉节点进程，保留 DSH_HOME / NODE_ROOT
# 重启
dsh --profile superagent-node
# 重启控制面
pnpm control
curl -fsS -H "Authorization: Bearer $SUPERAGENT_CONTROL_TOKEN" \
  "http://127.0.0.1:47100/v1/state"
```

验收点：同一 `sessionId` 的 Session 被 resume（`createdAt` 不变），控制面重新注册节点，已记录 Session 不重复创建，`session.inspect` 返回真实状态。

2026-11-14 的 E2E 已按本节跑过：慢重启的离线窗口由 10s 周期心跳发现（1.8s），PM 与 worker message 都在离线时返回 502；同 profile 重启后无需手动 heartbeat 自动 online，PM 同 id/`createdAt`，worker message 先 re-ensure 后 200；`session.inspect` 在 ensure 前返回 `found:true` + `backendSessionId` 且无 `status`。证据：`.artifacts/p2d-e2e-fixed-3a6c/evidence/`。

### 5.8 验收标准（P2-D）

> 结果基于 D2 run `p2d-e2e-fixed-3a6c`（`.artifacts/p2d-e2e-fixed-3a6c/evidence/`）与 D3 v2 run `p2d-model-v2-f35fac`（`.artifacts/p2d-model-v2-f35fac/evidence/model-v2/`）。D2 的 18 行表在原时点为 17 pass / 1 blocked（模型项）；该 blocked 已由 D3 v2 补齐，P2-D 验收项全 pass。

- [x] 控制面进程与 DSH 节点进程是两个 PID，节点进程没有 Web/面板（E2E 1、2：`processes-boot1.json`、`processes-boot2.json`）。
- [x] `GET /health`、`node.register` 正常；错误 token 401（E2E 3；周期注册/心跳见 E2E 4）。
- [x] PM Session 在真实 DSH 中创建，状态 `idle`；重启后 resume（E2E 5、8–11；`sessionId`/`createdAt` 不变）。
- [x] Worker Session 创建并收到 `session.message`；turn 事实回写（D3 v2：PM 建 Ticket，NodeExecutor 自动创建 `worker-b7f520…` 并投递 task prompt，Worker 的 `control_report` 写回同一 Ticket/Assignment）。
- [x] 真实模型下 Worker `control_report` 成功，Ticket/Assignment 状态与 Report 一致（D3 v2：`p2d-model-v2-f35fac`；Ticket `b5289e02…`、Assignment `b7f520f5…`，report `state=ready` + `17 + 25 = 42`，Ticket `ended completed`）。
- [x] 节点失联时控制面命令失败而非“假成功”；节点恢复后可对账（E2E 8–11：离线 502、恢复 200、同 id）。
- [x] 全程只写专用 `$DSH_HOME`、专用 `$DSH_AGENTS_HOME`、专用 state/DB/workspace；系统默认 profile 无改动（E2E 隔离表、`git-status-final.txt`；v2 凭据只从上一轮 run 的 artifact 复制，系统 `~/.dsh` 未读写）。

## 6. 阻塞点与风险

1. **`engines.dsh` 版本不匹配（已解决，见 §0.1）**
   本机 DSH 为 `0.2.2-rc.1`；原 `dsh-superagent` 的 `engines.dsh` / peer 依赖是 `^0.2.1-alpha.2`。DSH 的兼容性预检会抛出不兼容并**跳过 bundle 或禁用行**。实现采用“放宽范围”而不是版本豁免：`engines.dsh` 与所有 `@deepseek-ai/dsh-*` peer 改为 `^0.2.1-alpha.2 || ^0.2.2-rc.1`。semver 对预发布版本的匹配要求范围里出现同一 `[major, minor, patch]` 的预发布比较器，所以只写 `<0.3.0` 并不足以让 `0.2.2-rc.1` 满足；该写法覆盖 0.2.1 全系、0.2.2 预发布与 0.2.2 正式版，未来 0.2.3 预发布仍需再放宽（这是有意的，不是 `*`）。
2. **`session-controller` 在无头 profile 不可用**
   `dsh-api-session-controller` 注入 `fileUploads`；`fileUploads` 由 `dsh-client-file-upload` 提供，后者注入 Web 侧 `connection`。节点侧不要挂它，使用 `ctx.agents` + `ctx.sessionQuery`。
3. **`RoleProfile.tools` 已应用，`deny` 未单独消费**
   `dsh-port.ts` 把完整 `RoleProfile` 传给 `DshPortHost.ensureSession`，host 在首轮前把 `permission` 映射成本节点可用的 preset 并 `permissionPresets.set`（不可表达时 ensure 失败）；`tools` 用 `tools.restrict` 按**继承工具集合**收窄：PM 把全部继承工具 deny，Worker 只保留 `profile.tools` 命中的继承工具；`control_*` 在边界之后注册，仍留在 own layer。`tools.guard` 作为 scope-local/越界调用的兜底，但 D3 v2 的 PM `request/header.tools` 实际只有 `control_project`/`control_create_tickets`，没有 scope-local 工具残留，所以本轮 guard 没有实际拒绝对象；guard 的拒绝行为由 `tests/node-tool-boundary.spec.ts` 单测覆盖。**`RoleProfile.deny` 没有被单独消费**：当前由 tools allowlist + guard 覆盖，现有 PM/Worker 的 deny 名字都不在各自 tools 内，因此行为正确；但“deny 独立语义”仍是未实现项。
4. **角色装饰只移植了 preset + 工具边界部分**
   `Sessions.decorate` 里的 PM 工具守卫、Worker `workOnly` 白名单、skill scope 和 prompt section 依赖 Store/Settings/Prompts（控制面领域），节点-only 进程不再持有它们；节点侧的继承工具边界和 guard 已按 `RoleProfile.tools` 生效，工具提示段仍由 profile 里的 preset 定义。不要把完整 decorate 当作已移植。
5. **模型选择：节点消费 `agentDefaultModel`，profile 需两行 + 凭据**
   `RoleProfile.model` 仍优先；未给定时 `NodeSessions.ensure` 在 create/resume/复用的 live 路径上调用 `initializeRoleModel` 消费 `agentDefaultModel.currentSelection()`，在 turn 1 前写入 `model/selection`，已有 selection/header 不重复写。P2-D3 profile 只需 `agent-default-model`（provider/model/reasoningEffort）和 `llm-pi-ai`（`apiKeyEnv`）两行，加上模型凭据；`p2d-model-default` shim 已移除（profile 0 行/0 目录）。D3 v2 的凭据从上一轮 run 的 artifact 只读复制到隔离 home，系统 `~/.dsh` 未读写。控制面 `PM_PROFILE`/`WORKER_PROFILE` 仍未填 `model`，角色路由由节点 profile 的默认值决定。
6. **TypeScript 运行限制**
   DSH 内置 Node 24 默认是 strip-only，遇到 `constructor(readonly x)` 这类参数属性会直接 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（spike 首次启动即遇到）。生产必须走 `pnpm build` 产物；不要要求 DSH 直接加载 `src/*.ts`。spike 为省构建用了 `NODE_OPTIONS=--experimental-transform-types`，这是证据手段，不是部署方案。
7. **DSH 版本/包路径变化**
   `dsh` CLI、`dsh-base`、`dsh-workspace`、`dsh-agent-preset` 的导出与行 id 可能随版本变化；profile 与 `dsh-superagent` 的兼容范围要一起锁版本。`pnpm typecheck` 通过不代表运行期行名兼容。
8. **Windows 服务化**
   `dsh.cmd` 依赖 Electron 可执行文件与 asar；作为 Windows 服务运行时需要固定工作目录/用户、`DSH_HOME`、PATH，并确认 `ELECTRON_RUN_AS_NODE` 环境不被服务包装器污染（可参考本会话的 `app_env_audit` 思路）。
9. **强杀控制面后的锁文件 stale（运维注意，未修复）**
   控制面用 `proper-lockfile` 的 `stale: 30_000` 保护单写者。强杀进程（E2E 用 `taskkill /F`）会留下仍年轻的锁，立即重启会失败：`superagent control plane failed: Lock file is already being held`；E2E 等锁龄 87.9s 后重启成功。正常 SIGTERM/优雅停机不应触发。若要支持 kill 后立即重启，需要优雅关闭或让启动等待锁过期（归 P2-F/运维），**当前没有修复**。
10. **节点重启后事件 `seq` 从 1 重新计数**
    E2E 观察到节点重启后 `seq` 回到 1。本轮控制面恢复验收不依赖跨重启游标，但 `/v1/events?after=N` 在节点重启后的语义需要 P2-C/P2-F 明确；不要把它当作已解决。
11. **PM 的 ensure role prompt 会自行开始 turn 1（产品观察，不是 bug）**
    控制面 `openProject` 把 role prompt 作为首条消息投递，模型可用时这会直接开始 PM 的 turn 1。D3 v2 中 PM 在操作员消息前自行把 Project goal 拆成 3 个 Ticket，并让 NodeExecutor 起了 3 个 Worker；这些 Worker 随后被取消，避免在隔离工作区/仓库继续动作（Tickets 留在一次性 DB）。这是“ensure 的 role prompt 是否应静默投递”的产品决策，不是已修复缺陷；若后续要求“干净的一问一答”验收，需要产品侧先决定。

## 7. 证据（保留在 `.artifacts/p2d-spike/`）

| 证据 | 内容 |
| --- | --- |
| `dump.yml` | `dsh --profile p2d-node --dump-config` 的 386 行组合树；包含 base + node 行 |
| `node5.stdout.log` / `node5.stderr.log` | 真实 `DshNodePort` 启动：`p2d-node listening on http://127.0.0.1:48232` |
| `node6.stdout.log` | PM/Worker profile prompt 记录：`profile prompt recorded for pm-...`、`worker-p2d-a1` |
| `node7.stdout.log` + `control4.stdout.log` | 带 `SUPERAGENT_CONTROL_URL` 启动，控制面创建 `worker-p2d-a2` 成功（说明 `control_report` 代理工具注册未抛错） |
| `control3.stdout.log` / `control4.stdout.log` | 控制面独立进程启动并连接节点 |
| `home/profiles/p2d-node/` | 临时 profile（package.json、cordis.patch.yml、node_modules probe） |
| `home/sessions/` | 真实 DSH Session JSONL（zstd）持久化 |
| `home/storages/workspace.json` | Workspace 注册表 |
| `state/control2/control.sqlite` | 临时控制面 DB（含 seeded Project/Sessions） |
| `seed-project.mjs` | 测试专用 Project 种子脚本 |

实测关键输出：

```text
# 控制面 /v1/state
{"nodeId":"p2d-node","nodes":{"p2d-node":{"online":true,...}},"projects":[...],"events":1}

# PM 创建
{"session":{"sessionId":"pm-...","role":"pm","status":"idle","toolProfile":"pm.v1"}}

# Worker 创建
{"session":{"sessionId":"worker-p2d-a1","role":"worker","status":"idle","toolProfile":"worker.v1"}}

# Worker 消息
{"sent":true}
```

## 8. Go / No-Go

**GO（有条件）。**

条件：

1. 采用方案 A：独立 DSH profile + 新 node-only 入口；不把完整 `Runtime` 带进节点。
2. 节点 profile 只挂 `dsh-base` + workspace + preset registry + PM/Worker preset + `dsh-superagent/node`；不挂 web/session-controller。
3. 解决 `engines.dsh` 兼容性（放宽或精确豁免），否则 profile 会跳过插件。
4. 移植 PM/Worker 工具边界与 `RoleProfile` 的 tools/permission/model 传递（已应用；`deny` 仍未独立消费，见 §6.3）。
5. 真实模型下跑通 PM→Worker→Report（D3 v2 无 shim 已通过；重启/失联对账已在 P2-D2 E2E 通过）。

任一条件不满足则 **No-Go**，退回方案 B（runtime-lite）或保持现状；不建议为了 P2-D 把控制面重新塞回 DSH 插件进程。

## 9. 建议下一步

1. ~~兼容性 decision~~ **已做**：`engines.dsh`/DSH peer 放宽为 `^0.2.1-alpha.2 || ^0.2.2-rc.1`（§6.1）。
2. ~~实现 `src/node/plugin.ts` + `src/node/node-sessions.ts` + `./node` 导出~~ **已做**（§0.1）。
3. **已完成**：示例 profile 已入库到 `examples/profile.node/`（`README.md`、`package.json`、`cordis.patch.yml`，已删除 evidence-only 行），部署说明为 `docs/015-node-deployment.zh-CN.md`；仓库副本只做静态校验，没有在写文档时重新启动服务。profile 启动要点：
   - profile 目录 `$DSH_HOME/profiles/superagent-node/`：`package.json`（`dependencies.dsh-superagent = file:<repo>`，`dsh.profile.bundles = ["@deepseek-ai/dsh-base"]`）与 `cordis.patch.yml`（`@deepseek-ai/dsh-workspace`、`@deepseek-ai/dsh-agent-preset-registry`、从仓库根 `cordis.patch.yml:20-224` 原样复制的 PM/Worker preset 行、`dsh-superagent/node`）。
   - 模型两行：`agent-default-model`（provider/model/reasoningEffort）与 `llm-pi-ai`（`apiKeyEnv`）；不需要 `p2d-model-default` shim。
   - profile 内必须能解析 `@deepseek-ai/dsh-llm`（`AgentDelivery` 的 `freezeMessage`/`MessageId` 是运行期 import）和 `@deepseek-ai/dsh-session-persistence`；先跑 `dsh plugin --profile superagent-node add file:<repo>`，再用 `dsh --profile superagent-node --dump-config` 校验组合。
   - 专用 `$DSH_HOME`/`$DSH_AGENTS_HOME`（绝不指向 `~/.dsh`），以及 `SUPERAGENT_WORKSPACE_ROOT` 在 `SUPERAGENT_NODE_ROOT` 之下，外加模型凭据（D3 v2 从上一轮 run 的 artifact 只读复制，系统 `~/.dsh` 未读写）。
4. 测试三层现状：纯单测（`tests/node-plugin.spec.ts` 25、`tests/node-tool-boundary.spec.ts` 6、`tests/node-stop-cleanup.spec.ts` 8 等）与最终 Phase 2 回归 37 files / 299 tests 通过；**协议集成 + 真实 DSH 节点 E2E（不调模型）** 已在 `p2d-e2e-fixed-3a6c` 跑通；**真实 DSH + 真实模型 E2E（无 shim）** 由 `p2d-model-v2-f35fac` 补齐（PM→Ticket→NodeExecutor Worker→`control_report`，PM 工具表 2 个/Worker 20 个）。P2-A2/B2/C/E/F 的定向测试见 `docs/012`；剩余不是模型阻塞，而是 `RoleProfile.deny` 独立语义、PM role prompt 自动 turn 1 的产品决策等。
5. `lib/node.js` 的去向已明确：保留为 FakeNode 测试/兼容入口；生产节点由 `dsh --profile` + `dsh-superagent/node` 启动，文档不再把 `pnpm node` 当真实节点。
6. **Phase 2 收口后的下一步**：本地 review / commit（尚未做）；技术性剩余风险为 `RoleProfile.deny` 独立语义、PM role prompt 是否静默投递、控制面强杀 lock stale、节点事件 `seq` 重启归零；TLS/反向代理/控制面前端见 `docs/016-control-plane-tls.zh-CN.md`（文档，不是已实现代码）。
