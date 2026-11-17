# 控制台

控制台由独立控制面同源提供，接入真实的运行状态和管理接口。浏览器通过连接密钥访问。

设计沿用已批准的原型（浅色淡紫、左侧六项菜单、首页 Router → 运行概览 → 近期动向），实现是 React 18 + TypeScript，由 `tsdown` 打成**一个**浏览器包 `lib/console.js`。首页的 Router 读起来像一段对话：人自己的话在右边一个泡里，Router 的回答在左边按 Markdown 排版，输入框一直留在面板里够得着。

## 1. 启动与访问

```bash
export SUPERAGENT_CONTROL_TOKEN='<operator token>'
export SUPERAGENT_CONTROL_PORT=47100
node lib/control.js
# superagent control plane listening on http://127.0.0.1:47100
# superagent console at http://127.0.0.1:47100/console
```

浏览器打开 `/console`，输入 `SUPERAGENT_CONTROL_TOKEN`。只读路由也可以用 viewer token，但写操作仍然需要 operator token——控制台不提供角色切换，凭据是什么就是什么。

环境变量：

| 变量 | 说明 |
| --- | --- |
| `SUPERAGENT_CONSOLE_DIR` | 构建产物所在目录，默认包自己的 `lib`（其中应有 `console.js`） |
| `SUPERAGENT_CONSOLE_DB` | 保存事件日志、操作日志、项目备忘、会话检查和定时任务。默认在业务数据库旁创建 `console.sqlite` |
| `SUPERAGENT_RECONCILE_INTERVAL_MS` | 自动清理残留会话的间隔（毫秒）。默认 `0`，可在「节点部署」页手动检查 |
| `SUPERAGENT_SCHEDULER_OFFSET_MINUTES` | 定时任务使用的 UTC 偏移（分钟，向东为正）。默认 `0`（UTC）。 |
| `SUPERAGENT_SCHEDULER_TICK_MS` | 调度器查看「到点计划」的周期（毫秒）。默认 5 秒；`0` = 只存计划，不自己到点跑 |

## 2. 凭据模型

- **页面公开，页面里没有凭据**：`GET /console` 返回的 HTML 只有挂载点和一个脚本引用，不含 token、不含 key、不含任何秘密。被复制、被缓存、被截图的页面都不构成泄露。
- **同一标签页刷新后自动连接**：密钥经 `GET /v1/overview` 验证后保存在该标签页的 `sessionStorage`。用户主动断开或控制面拒绝密钥时，页面清除已保存的密钥。
- 浏览器用 `Authorization: Bearer` 发送密钥。控制台的认证使用请求头，页面没有认证 cookie。
- **同源、无外链**：页面带 CSP（`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'`），只加载 `/console/console.js` 这一个文件，不连 CDN、不连字体服务、不发统计。
- **工具 token 隔离**：`/v1/tools/*` 永远只认控制面签发的 Session token；控制台用的是操作员 token，两者互不通用。viewer token 换不出任何 Session 权限。

## 3. 页面与数据来源

| 页面 | 真实数据 | 接口 |
| --- | --- | --- |
| 首页 · Router | **真的 Router**：控制台发出去的话进节点上一个真实的 DSH Agent，回答是节点报回来的消息事件。页面显示人自己写的那段、**按 Markdown 排版的**模型回答、节点在不在线、Router 在不在忙；有待确认的转发提议时，页面在对话下面显示那段**原文**与两个按钮 | `GET /v1/console/router`、`POST /v1/console/router/message`、`POST /v1/console/router/proposal/:id/confirm`、`POST /v1/console/router/proposal/:id/cancel` |
| 首页 · 运行概览 | 工作进行中（最新 Assignment 在跑的 Ticket）、Worker 正在执行（Session 状态为 `running`，**空闲不算**）、待 PM 验收（有 pending review 的 Ticket）、定时任务失败 | `GET /v1/overview` |
| 首页 · 近期动向 | 控制面审计记录：项目创建、PM 分派、Assignment 启动、Worker 报告、PM 验收/返工、节点上下线、操作员的会话动作，以及**定时任务的写入与每一次运行的结果**。列表读 24 条、显示 8 条；如果最新的 8 条里没有 PM/Worker 自己的事实（工单、Assignment、报告、验收、会话），就补上最近的一条——定时任务跑得再勤，也不会把工作本身的记录挤下去 | `GET /v1/audit?limit=24` |
| 项目 | 真实 Project；每个 Ticket 的状态由**内核**推导（`pmTicketStatus`），前端不自己算 | `GET /v1/console/projects` |
| 会话 | 真实 PM/Worker Session（状态、Project、Assignment、工作区、DSH 会话 ID、会话令牌版本、权限状态）与节点上报的真实消息事件 | `GET /v1/sessions`、`GET /v1/console/sessions/:id/messages` |
| 定时任务 | 查看定时任务的运行规则、任务时区、下次运行时间和历史记录。发送失败时可查看原因 | `GET /v1/console/schedules`、`POST /v1/console/schedules`、`PUT/DELETE /v1/console/schedules/:id`、`POST /v1/console/schedules/:id/pause|resume|run`、`GET /v1/console/schedules/:id/runs` |
| 节点部署 | 查看节点连接信息，检查并清理残留会话 | `GET /v1/overview`、`GET /v1/console/reconcile/latest` |
| 设置 | 保存起始页、Enter 发送和 Router 首选模型。在线调整定时任务检查间隔、自动清理残留会话的间隔和会话令牌过期宽限。编辑下次启动的控制面和节点配置 | `GET /v1/overview`、`GET/PUT/DELETE /v1/console/settings`、`GET/PUT /v1/console/deployment/{control,node}` |

桌面主导航固定在左侧，右侧页面独立滚动。导航可收成图标栏，浏览器记住选择。窄屏通过顶部菜单打开抽屉。

### 部署与凭据

在「设置 → 部署与凭据」展开「控制面配置」或「执行节点配置」。填写要改的字段，再点击该组的保存按钮。配置文件独立于 SQLite，保存后旧进程继续使用原值。控制面配置包含监听地址、端口、连接密钥、只读密钥、数据库和构建路径、日志保留和定时任务时区。节点配置包含双向地址、监听参数、节点标识、根目录、节点密钥和新会话默认模型。

- 控制面默认从启动时业务数据库旁的 `.superagent-private/control.json` 读取配置。如果该位置在节点根目录内，默认放到节点根目录同级的 `<节点目录名>.superagent-private`。可用 `SUPERAGENT_CONTROL_DEPLOYMENT_FILE` 指定其它位置。更改数据库路径时，配置文件仍从原启动位置读取。
- 节点配置默认存到同目录的 `node.json`。让 DSH 节点启动器的 `SUPERAGENT_NODE_DEPLOYMENT_FILE` 指向设置页显示的路径。两端在不同机器时，用双方可访问的私有共享文件，分别在启动器中指定挂载后的绝对路径。
- 涉及两端的改动先重启节点，再重启控制面。临时停机前结束正在运行的工作。控制台密钥轮换后旧密钥失效，已有会话在下一次重新确认时取得新工具令牌。
- 密钥输入框只显示设定状态。配置文件含有本服务使用的凭据，应放在工作区和节点根目录之外，并只授权对应服务账号访问。Unix 新文件权限为 `0600`，Windows 使用配置目录的 ACL。恢复环境变量启动值时，先停相关服务、备份并移出对应配置文件，再重启。
- 切换数据库路径只会打开目标库，迁移和备份需单独完成。DSH 数据目录、Agent 配置目录和供应商 API 密钥仍使用 DSH 的启动及凭据配置。

首页第四格「定时任务失败」显示的是**真实数字**：调度器里**最后一次运行没有送达**的计划数。点它会跳到定时任务页，并只显示失败的那些（页面上有「显示全部」可以回到全部）。这一格在调度器接入前显示 `—`，而不是 0——0 会被读成「跑过、没失败」。

## 3.0 首页的 Router

- **真对话，不是关键词规则**：控制面用新的节点命令 `router.ensure` 在节点上起一个属于控制面自己的 Session（固定 id、独立工作区、`router.v1` 角色 profile），节点侧复用既有的 `NodeSessions`（ensure / prompt / 持久化 / profile / model）。回答来自那个 Agent 自己的模型。
- **第一条消息就会启动它**：不需要先去别的页面点一次「启动 Router」。并发请求共用同一个 ensure，节点重连后按同一个 Session id 重新 ensure。
- **页面上看到什么**：输入框可用；发送后按钮禁用直到这次请求结束（请求不会在按钮禁用之前偷偷发出去）；下面一行说明当前状态——节点离线、Router 尚未启动、Router 正在回答、或 Router 已就绪。对话里右边是**人自己写的那段**（原样显示，不排版），左边是模型的回答，**按 Markdown 排版**；这段话**只在节点报回来的事件里出现一次**，页面不在别处再回显一遍。
- **回答按 Markdown 排版**：标题、强调、有序与无序列表、任务清单、围栏代码块、行内代码、引用、表格和链接都按 Markdown 读出来。控制台自己解析并用 React 的元素渲染，页面上没有 `dangerouslySetInnerHTML`：回答里的 HTML 一律当作文本显示，图片不会被加载（控制台不向任何别的源要东西）。只有 `http`、`https`、`mailto` 的地址可以点，`javascript:`、`data:` 之类的地址只显示文字（地址先解实体再判协议，伪装成安全的地址同样被拒）。代码按原样保留，宽的代码块和表格在各自的盒子里横向滚动，不把页面撑宽。
- **输入的方式**：Enter 发送，Shift+Enter 换行，中文输入法正在组字时按 Enter 可继续选词。离线时仍可编辑草稿，发送失败时也保留原文。浏览历史时保持滚动位置，停在底部时跟随最新回复。
- **附件、模型与用量**：「＋」添加 UTF-8 文本文件，每条消息最多 4 个，合计最多 48 KiB。选择的模型来自 DSH 节点的目录，切换在下一条消息生效。上下文入口显示最近一次模型请求的实际 token 数和模型窗口大小，有数据时计算比例。
- **SSE 与刷新同语义**：页面每次事件之后重新读 `GET /v1/console/router`，刷新页面读的是同一份数据。
- **从首页创建项目**：在对话里要求创建项目并说出名称和目标，Router 通过 `control_router_create_project` 创建项目并启动待命的 PM。创建时还没有工单。项目出现在项目列表和近期动向。同一条消息重试只创建一次。如果项目已创建而 PM 启动未获确认，可到项目页重试启动 PM。
- **从首页直接派 Worker**：对 Router 交代一件明确的独立任务。Router 创建独立 Ticket 和 Assignment，节点启动真实 Worker。Worker 汇报后 Router 在对话里转述，会话页可核对该工单和回报。也可在对话中指明工单，要求追加指令、停止或重试。
- **项目进度**：项目 PM 可回报项目里程碑、阻塞或待人决定的事项，最新报告可从 Router 和项目页查看。
- **它能做什么**：读运行概要（项目、工单、Assignment、会话、计数），以及**在人的明确要求下**提交一条转发提议。
- **转达给 PM**：Router 把目标项目和待转达原文作为提议放在对话下方。可点「发给 <项目>」确认投递，或点「取消」撤回。
  - 「发给 <项目>」→ `POST /v1/console/router/proposal/:id/confirm`：这时才真的把原文送到那个项目的 PM。
  - 「取消」→ `POST /v1/console/router/proposal/:id/cancel`：一条都不发。
  - 确认只认控制台的 bearer；Router 的 Session token 开不了这两个端点，所以它没法自己把提议变成一条消息。
  - 确认时，系统会检查项目是否仍可接收消息，以及 PM 会话是否有效。发送失败时会显示原因。
  - 同一时刻只有一个提议在发：并发确认只有一个成功，另一个被拒。已经发出去的不能再发一次。
  - 重启控制面后旧的提议一律失效（提议的账本在进程内），但真实对话历史照常从事件日志恢复。刷新页面也不会发任何东西——`GET` 是纯读。
- **普通聊天就是模型回答**：Router 不许出于自己的判断去转发；只有人明确说「告诉某个项目的 PM …」时它才提一条提议，而且必须照抄人的话。

## 3.1 项目页：真实动作

| 操作 | 走哪条路 | 说明 |
| --- | --- | --- |
| 新建项目 | `POST /v1/console/projects` | 可选填 `workspace`。项目和工作区路径一起保存，创建时暂不启动 PM |
| 启动 PM | `POST /v1/console/projects/:id/pm` | 节点真的 ensure 一个 PM Session；项目已结束或归档时拒绝（409） |
| 暂停 / 恢复 | `POST /v1/console/projects/:id/pause` | 硬暂停后列出节点未确认停止的工单。软暂停期间新增的待验收结果会在恢复后通知 PM，前提是结果仍待验收 |
| 结束项目 | `POST /v1/console/projects/:id/stop` | 项目与其工单一起结束；回答里区分「已停」与「未确认停止」 |
| 归档 / 取消归档 | `POST /v1/console/projects/:id/archive`、`/unarchive` | 归档先落领域（项目与工单归档、Assignment 结束、Worker 由领域那一条路径去停），再等已记录的清理；PM Session 保留，项目还能回来 |
| 记一笔 | `POST /v1/console/projects/:id/memory` | 写进这个项目的备忘；只有这个项目的 PM 读得到（`control_project` 的 `memory` 段） |
| 给 PM 发消息 | `POST /v1/console/sessions/:id/message` | 消息真的送到 PM 会话，页面能看到 PM 的回复事件 |

工作区填写执行节点上的绝对路径，需位于表单显示的工作区根目录内。可填写已有目录，留空时按项目 ID 分配目录。项目详情显示该路径，PM 和 Worker 启动时使用它。

页面同时显示项目状态、PM 会话状态、最近报告与每张工单的状态/报告/验收轮次。

**浏览器不代替 PM 验收**：页面没有「接受/拒绝」按钮，结果由这个项目的 PM 自己决定。

## 3.2 会话页：按角色的动作

| 操作 | PM 会话 | Worker 会话 |
| --- | --- | --- |
| 发送消息 | 直接送达 PM | 给当前执行会话对应的工单追加指令，支持项目工单和独立工单。页面分别显示「已送达」「已排队」和发送失败 |
| 停止 | **本轮后端已支持，前端待 P3-1B**：只停这个 Session，项目状态、项目工单和同一项目的其他 Worker 都不动（不是「结束项目」） | Assignment 在领域里结束，节点确认后才算停；没确认时页面照实说没确认 |
| 归档 | 项目不再 active 时才允许 | Assignment 已结束时才允许 |
| 权限 | `PUT /v1/console/sessions/:id/permission` | 同左 |
| 撤销权限 | **二次确认**后才执行 | 同左 |

点「撤销权限」后，页面会先说明影响，再请你确认。确认后，这个会话的令牌立即失效，系统也会尝试停止会话。该会话的工具权限无法恢复。

Worker 被替换后，请打开新会话再发消息。向旧会话发送会返回 409。向运行中的 Worker 发送时，页面等节点确认后才显示「已送达」。节点拒收或投递未确认时会显示错误，并保留输入框中的草稿。连续两次主动发送相同的文字会生成两条指令。

条件不满足的动作（例如给还在跑活的 Worker 归档）会显示控制面返回的 409 原因，不是一个没有解释的失败。

P3-1A 在后端补齐了控制台停止所需的动作，页面本身留给 P3-1B：

| 动作 | 路由 | 说明 |
| --- | --- | --- |
| 停 PM / Router 会话 | `POST /v1/console/sessions/:id/cancel` | 只停那个会话；项目状态、项目工单、同一项目的其他 Worker 和 PM Mandate 都不动 |
| 停一个 Assignment | `POST /v1/console/assignments/:id/stop` | 工单保持开着；只有人能批准恢复 |
| 取消一个工单 | `POST /v1/console/tickets/:id/cancel` | 工单结束，Mandate 撤回 |
| 恢复 | `POST /v1/console/sessions/:id/resume`、`POST /v1/console/tickets/:id/resume` | 显式的操作员动作；恢复后停止期间流通的令牌一律无效；节点没确认过的停止不能恢复 |
| 停止通知 | `GET /v1/console/stops` | 目标、作用域、影响、未受影响的子任务、操作人和时间 |

回答里的 `stopped` 与 `confirmed` 是两件事：前者是这次请求的结果，后者是节点确认过。节点拒收或回执丢失时，页面必须照实说没有确认。

## 3.3 底层路由与控制台路由的关系

控制台的所有写操作都走 `/v1/console/*`；Phase 2 起就有的底层路由保持原语义，老客户端不受影响：

| 底层路由 | 与控制台路由的差别 |
| --- | --- |
| `POST /v1/projects/:id/pm` | 底层只为任意项目 ensure PM；控制台那一条在项目已结束/归档时拒绝（409） |
| `POST /v1/sessions/:id/message` | 底层把消息直接送到那个 Session；控制台那一条按角色：PM 直达，Worker 走它那张工单 |
| `POST /v1/sessions/:id/cancel` | 底层只在节点上停掉那个 Session，**不终结整个项目**；控制台那一条按角色做领域内的停止：Worker 走它那张工单，PM 只停它自己（不终结项目、不连带其他 Worker） |
| `POST /v1/sessions/:id/archive` | 底层照旧归档那个 Session（项目还在 active 也一样）；控制台那一条在活还在跑时拒绝（409） |
| `POST /v1/projects/:id/workers` | 底层低层入口：为已有 Assignment 拉起 Worker Session。**浏览器不暴露**它 |


## 3.4 定时任务页：只发消息的到点任务

一个定时任务 = **一个时刻 + 一句话**。到点时它只给那个项目**已经有的** PM 发一条消息：不建单、不派工、不启动会话、不执行任何 shell 或脚本。正文以系统事实的形式送出（写明这不是人的指令、不授予权限），操作员写的那段被围栏围住当作数据附在里面；PM 之后做什么由 PM 自己决定。

| 操作 | 走哪条路 | 说明 |
| --- | --- | --- |
| 新建 | `POST /v1/console/schedules` | 要选一个**真实存在**的项目；项目不存在时接口 400 并说明「Unknown Project」 |
| 编辑 | `PUT /v1/console/schedules/:id` | 可改名称、规则、正文或目标项目。尚未开始执行的计划读取保存后的版本，已开始执行的这一轮使用开始时的版本 |
| 暂停 / 恢复 | `POST /v1/console/schedules/:id/pause`、`/resume` | 暂停期间错过的时刻**不补发**；恢复后从下一个时刻开始 |
| 立即运行 | `POST /v1/console/schedules/:id/run` | 手动跑一次，**不改变**时刻表。没有送达时接口答 502 并带上原因，页面照实显示失败，不说成功 |
| 删除 | `DELETE /v1/console/schedules/:id` | 页面先要一次确认；删掉后不再到点运行，历史仍留在控制面里 |
| 运行历史 | `GET /v1/console/schedules/:id/runs` | 每一次运行：到点/手动、是否被节点确认、跳过了几次、失败原因 |

- **规则只有三种**：`every:<n>m|h|d`、`daily:<HH:MM>`、`weekly:<1-7,...>@<HH:MM>`（ISO 星期，1 是周一）。读不懂的规则在创建时就被拒（400），不会等到该开火的时候才出错。
- 任务时区使用固定 UTC 偏移，默认 UTC。更改偏移并重启控制面后，重新保存已有的日或周计划，即使规则文本相同，也会按新时区计算下次运行。按间隔运行的计划保留原节奏。页面用浏览器本地时间和任务时区分别显示下次运行的时间。
- 发送失败时，页面显示具体原因，例如项目已结束、PM 会话的权限已撤销、节点离线，或节点尚未确认 PM 会话可用。
- **空态**是真的空态：还没有任务时页面说明到点会发生什么（只发一条消息，不建单不派工不跑命令），不展示任何示例任务，也不展示假的运行结果。
- **审计里没有正文**：定时任务的审计只写事实（规则、时刻、结果、失败原因），任务正文和任何凭据都不进审计。

## 4. 实时与断线

- 页面用 `fetch` 读 SSE（`EventSource` 不能带 bearer 头），断线后从**最后收到的序号**继续拉，间隔按 250ms→5s 退避。
- 事件序号是**控制面自己的**，跨控制面重启单调；节点自己的计数以 `nodeSeq` 保留。
- 日志有界，被裁掉的那一段由服务端用 `gap` 明确告知，页面顶栏显示「部分历史事件已过期」。
- **动作成功后会自己重读一次**：不是每个动作都会留下事件（给项目「记一笔」就只写进了控制面自己的备忘表），所以每个写操作成功后页面会立刻重读本页的事实，而不是等下一个事件。事件流仍然负责别人造成的变化。
- **后台触发的定时任务也走这条流**：一次运行结束时控制面发一条 `schedule.run` 事件（进控制面自己的事件日志），所以页面在定时任务到点时也会自己更新，不必轮询、不必刷新。
- 停止 Worker 或撤销会话权限后，页面会显示节点是否确认会话已停止。

## 5. 持久事件与审计

- 事件日志与审计在 `SUPERAGENT_CONSOLE_DB`（默认 `console.sqlite`），与领域库分开：领域 schema 版本不动，旧插件二进制不会打开它。同一个文件里还有**项目备忘**和**会话检查记录**。
- 审计写的是**事实**，不是请求副本：一行短说明 + 目标 id。已脱敏，不含 token、原始 diff 或请求体。`tool.call` 事件在记录与广播时都不带 `args`（工具入参是模型自己的输入，可能含人粘贴进去的密钥）；`review.diff` 事件照旧不进事件历史。
- 审计写失败只记 stderr，不影响业务。Worker 报告的**调用级账本**不在这个文件里：它在领域库自己的 KV 区（`control/report-call:`），这样「写报告」和「记账」能在一个事务里完成，领域 schema 版本仍然不动。

## 6. 排障

| 现象 | 原因与处置 |
| --- | --- |
| 页面显示「控制台前端尚未构建」 | 包里没有 `console.js`。执行 `pnpm build` 后重启控制面，或用 `SUPERAGENT_CONSOLE_DIR` 指向已构建目录 |
| 页面一直「重连中」 | 检查控制面是否在线。网络恢复后控制台会重连；密钥失效时会回到连接页面 |
| 输入密钥后立刻 401 | 密钥与 `SUPERAGENT_CONTROL_TOKEN` 不一致；控制台不会替你换 token |
| 页面空白、控制台无报错 | 打开浏览器的网络面板看 `/console/console.js` 是否 200；它是 503 说明没构建，是 404 说明 `SUPERAGENT_CONSOLE_DIR` 指错了 |
| 「部分历史事件已过期」 | 要读取的旧事件已超过日志保留期限或条数上限 |
| 消息列表是空的 | 该 Session 还没有消息事件上报（节点未上报 `session.event{message}`），或者它刚创建 |

## 7. 端到端验收

2026-11-16，在隔离工作区用 Edge、独立控制面与真实 DSH 模型验证了从首页对话创建项目、启动 PM、在项目页看到新项目，以及只问进度时项目数保持不变。此前同一环境也验证了转发提议确认、项目页建项目和启动 PM、Worker 修改测试文件、PM 查看 diff 并验收。定时任务经浏览器创建并投递到真实 PM 会话。未启动 PM 的项目留下失败记录，首页可见失败动向。退出进程后从 SQLite 复核了同一工单的审阅和两次定时运行的结果。

补充复验覆盖首页派独立工单、真实 Worker 执行和最终回报、近期动向的 Router 归属、会话详情、新建项目后 PM 待命且工单数为零，以及真实 PM 的项目报告回到首页。原有项目内派工、审批与定时任务随后通过独立浏览器回归。

最终构建的本机证据位于 `.artifacts/claude-phase5-20261115/real-console-P9I9Tp/verified-evidence.json`。管理操作、窄屏与调度编辑删除的独立浏览器验证位于 `.artifacts/claude-phase5-20261115/operations-live-t7UjwC/evidence.json`。

## 8. 当前边界

- 快速派工与复杂请求共用同一个首页 Router 会话。独立的快路由小模型、外部来源接入、订阅直唤醒和三域记忆尚未接入独立控制面。
- 定时任务只到「给已有 PM 发一条消息」这一步：它不建单、不派工、不跑命令，**不会**替 PM 决定项目要做什么，停机期间积压的时刻只计数不补发。
- 验收：浏览器不代替 PM 接受或拒绝 Worker 的结果。
- 手工派工：没有「按 Assignment id 手工创建 Worker」的入口，Worker 只能因为一个 Assignment 而存在（底层路由 `POST /v1/projects/:id/workers` 仍在，但控制台不暴露它）。
- 在「节点部署」页点「检查并清理」可手动检查。需要定期检查时，在「运行与调度」设置自动清理间隔，也可以用 `SUPERAGENT_RECONCILE_INTERVAL_MS` 配置启动值。
- 检查范围是这个控制面创建的会话。系统会请节点确认会话状态，然后停止并归档任务或项目已结束、仍在运行的会话。

相关文档：[009 节点协议](009-node-protocol.zh-CN.md)、[010 控制面内核](010-control-plane-kernel.zh-CN.md)、[015 节点部署](015-node-deployment.zh-CN.md)、[016 控制面 TLS](016-control-plane-tls.zh-CN.md)、[007 架构](007-architecture.md)。
