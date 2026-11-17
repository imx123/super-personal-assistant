# Phase 3–5 执行日志

2026-11-17。基线 `6875ef9`，开发分支 `next`。Claude Code 逐任务实施，Codex 核对代码及独立验收。每个任务独立提交。上一阶段的必验项目全部通过后进入下一阶段。

| Task | 依赖 | 交付 | 状态 |
| --- | --- | --- | --- |
| P3-0 | — | 基线、权限和停止矩阵 | DONE |
| P3-1 | P3-0 | 全角色会话干预，真实 DSH | DONE |
| P3-2 | P3-1 | 快路由、自动派工及回执，真实 DSH | DONE |
| P3-3 | P3-2 | 高层路由、四条件门禁及 PM 自动交接，真实 DSH | DONE |
| P3-4 | P3-0 | 工作区隔离实验与 ADR | DONE |
| P3-Gate | P3-1–P3-4 | 两条真实 DSH 业务闭环、干预及兼容 | NOT_STARTED |
| P4-0 | P3-Gate | 协作事件边界 | NOT_STARTED |
| P4-1 | P4-0 | 可靠报告协调，真实 DSH | NOT_STARTED |
| P4-2 | P4-1 | 信息流订阅，真实 DSH | NOT_STARTED |
| P4-3 | P4-1 | 拒绝检测与上级审查，真实权限守卫 | NOT_STARTED |
| P4-4 | P4-0、P4-3 | 外部观察订阅与直接唤醒，合成事件 E2E | NOT_STARTED |
| P4-5 | P4-1、P4-4 | 持久协作投递、幂等和恢复 | NOT_STARTED |
| P4-Gate | P4-0–P4-5 | 报告、订阅、审查与恢复验收 | NOT_STARTED |
| P5-0 | P4-Gate | 三域数据契约与设计 | NOT_STARTED |
| P5-1 | P5-0 | Live State | NOT_STARTED |
| P5-2 | P5-0 | 持久 Event History | NOT_STARTED |
| P5-3 | P5-0 | Memory Service 与候选队列 | NOT_STARTED |
| P5-4 | P5-3、P4-1 | Manager 审核及维护，真实模型 | NOT_STARTED |
| P5-5 | P5-1、P5-2、P5-3 | 按需检索与排序，验证检索进入模型 | NOT_STARTED |
| P5-6 | P3、P4、P5 主功能 | 三域与路由协作闭环，真实模型 | NOT_STARTED |
| P5-Gate | P5-0–P5-6 | 三域、权限、恢复与全链路回归 | NOT_STARTED |

## P3-0

基线文档提交为 2419bb6。

Claude Code（MiniMax-M3.1-Flash）完成基线调查。Codex 对照源码、任务书和本机测试复核，补充随机端口失败记录，并区分纯回合中断和节点全会话停止。[基线](PHASE3_BASELINE.md)包含当前能力、状态变化、权限和停止作用域、自动交接迁移及 P3-1 计划。

本轮 12 个文件 198 项通过、1 项跳过。类型检查和直接运行 tsdown 通过。全量与真实模型未重跑。旧审计仍为本地未跟踪文件。本次提交只包含这两份文档。

## P3-1A

实现提交为 9f62bd5。

Claude Code（MiniMax-M3.1-Flash）实施，Codex 独立验收。操作员可分开停止 PM 或 Router 会话、停止单个 Worker 派工以及取消工单。停止 PM 保留项目、工单、Mandate 和其他 Worker。恢复须由操作员明确发起，节点未确认停下时拒绝恢复。持久停止标记和领域事实同时保护重启后的消息、ensure 与恢复入口。操作范围及 API 见 [P3-1A 规范](../018-phase3-session-stop.zh-CN.md)。

复核补齐了并发停止与恢复、停止前尚无会话的 Worker，以及低层入口绑定 Ticket 和 Project 的校验。旧 Assignment 的停止诊断保留在原派工上。类型检查、构建与 47 文件定向回归通过，605 通过、1 跳过（Windows 目录联接）。定向回归之间有一次随机临时端口导致 fetch 报 `bad port`，完整定向重跑通过。本轮未跑全量。

真实 DSH Desktop 0.2.2.0、隔离 `phase3-live` profile 和 `dsh-superagent/node` 使用本机 llama-server 的 Gemma 4 12B。停下 PM 后项目仍 active，两组 Worker 与 Assignment 保持原身份，消息和 ensure 拒绝隐式恢复，Router 可读停止通知。经显式恢复，原 PM 接收下一条消息并执行第 2 轮，该轮因模型达到输出上限结束。故障注入由 FakeNode 测试覆盖。验收脚本和脱敏证据保存在本地忽略目录 `.artifacts/phase3-5-20261117/`，证据文件为 `live-edI3Mg/evidence.json`。

P3-1A 已验收。P3-1B 接回合中断、Router 顺序插话和前端，完成后再验收 P3-1。

## P3-1B

实现提交为 9f1265d。

Claude Code 使用 MiniMax M3.1 Flash、`--effort max` 实施，Codex 独立验收。Router 忙时仍可提交，普通插话先持久排队，当前回合结束后按顺序进入后续回合。刷新可查看排队状态，节点入箱与回合读取分别显示。重复请求按 ID 去重，明确拒收保留原因，缺回执标记未确认。重启后只对尚未投递的排队消息恢复原有请求窗口。

打断请求绑定当前回合编号，由节点确认该回合以 `aborted` 结束。控制台会话页可查看 Router、PM、Worker，操作员可单独停止和恢复 PM 或 Router，停止未确认时可重试，取消整个工单须确认。

类型检查、构建及 51 文件定向回归通过，653 项通过、1 项因 Windows 目录联接限制跳过。覆盖节点拒收、丢回执、持久队列重启、过时回合、旧派工和权限边界。全量测试未重跑。

Edge、DSH Desktop 0.2.2.0、隔离 `phase3-live`、`dsh-superagent/node` 和本机 Gemma 4 12B 复验通过。两条插话在第一轮生成时提交，刷新后仍列在队列中，随后分别进入第二、第三轮。点击中断并插话后，第四轮以 `aborted` 结束，第五轮收到新消息，项目状态不变。会话页点击停止 PM 后，项目仍 active，两个 Worker 派工保持原身份，显式恢复后原 PM 收到了新消息。证据位于本地忽略目录 `.artifacts/phase3-5-20261117/` 的 `live-09FYhL/evidence.json`、`live-N7c91D/evidence.json`。

P3-1 已验收，下一项为 P3-2。快路由首版用确定性规则，OpenSquilla 与小模型接入可选。

## P3-2

Claude Code 使用 MiniMax M3.1 Flash、`--effort max` 实施，Codex 独立验收。规则可派明确的独立工单、续接开放工单、向唯一的现有项目 PM 交接，以及按完整 ID 查状态。控制面在 Router 的消息队列内按顺序执行快动作。项目和工单匹配要求完整标识，引用、歧义及权限边界留给高层处理。投递拒绝或缺回执时保留回执，原请求不进入模型再次执行。[快路由操作](../019-phase3-fast-router.zh-CN.md)

定向测试覆盖同 ID 重试、Router 忙或停止、拒收、回执丢失、跨重启、精确目标与相似名称。复核补齐了 PM 会话 ID 的回执，以及队列与路由记录的事务更新。类型检查与构建通过，52 文件定向回归通过，681 项通过、1 项跳过（Windows 目录联接）。一次重跑遇到旧有的临时端口 `bad port`，完整定向重跑后通过。全量测试未重跑。

真实 Edge、DSH Desktop 0.2.2.0、隔离 `phase3-live`、`dsh-superagent/node` 和 Gemma 4 12B 本机模型通过。使用同一条示例文件指令和相同 16K 模型上下文，P3-1 基线走了一轮 Router 模型；P3-2 在 Worker 开始之前的 Router 模型回合为 0。真实 Worker 写入 `hello.txt` 并向原独立 Ticket 报告，首页显示工单和会话 ID。明确交给已存在项目的另一条指令，无需点击确认，真实 PM 收到一次，首页显示正确项目、PM 会话和已确认状态。证据位于本机忽略目录 `.artifacts/phase3-5-20261117/` 的 `live-HxyojW/evidence.json` 与 `live-32OY0o/evidence.json`。

P3-3 处理复杂项目任务的高层分派、四条件门禁和高层 PM 自动交接。确定性快路由已经可用，小模型接入保持可选。

## P3-3A

实现提交为 1b38219。

Claude Code 使用 MiniMax M3.1 Flash、`--effort max` 实施，Codex 独立验收。高层继续使用现有 `router.v1` 会话，页面能追踪快路由与模型路径。自动创建项目由控制面核对四项结构化判断、用户工作意图和原话引用。已存在的项目或同名拟建项目由高层继续澄清。用户明确创建的入口保留。

同一 Router 请求绑定一个领域项目。并发请求合并，重启后的重复调用读取持久回执，已完成的动作无需重新发送节点命令。没有完成记录的未知请求仍被拒绝。先前未完整确认的创建仅从领域记录核对项目。四条件、拒绝无副作用、重放、已有项目和原接口兼容用例见 [自动创建项目](../020-phase3-project-gate.zh-CN.md)。

类型检查、构建通过。54 文件定向中，711 项通过、1 项因 Windows 目录联接跳过，另有 2 项临时端口 `bad port`；快路由、四条件门禁与文档三个文件复跑 59 项全过。全量测试未重跑。

真实 Edge、DSH Desktop 0.2.2.0、隔离 `phase3-live` 和 `dsh-superagent/node` 以本机 Gemma 4 12B 验收。串行样例走高层模型且没有创建 Project。可并行的三模块样例由真实 Router 交付四项判断和原话引用，控制面创建一个 Project 并启动真实 PM，首页显示项目和 PM 会话 ID。证据在本机忽略目录 `.artifacts/phase3-5-20261117/live-gtD3dH/evidence.json`。P3-3B 补齐常规高层交接与真实工单闭环。

## P3-3B

P3-3B 实现与验收提交为 `b66ca88`。按用户要求，完成本项验收后暂停。P3-Gate、Phase 4 和 Phase 5 尚未开始。

Claude Code 使用 MiniMax M3.1 Flash、`--effort max` 实施，Codex 独立验收。高层 Router 新增 `control_router_pm_handoff`：模型只决定「哪个项目、说什么」，控制面按本人原话复核后自己把工作交给该项目的 PM，不需要「转告 PM」，也不需要点击确认。复核包括工作意图、唯一目标（或本请求自己建的项目）、逐字来自本人原话的内容边界，以及不越到别的项目、不要新授权、不可逆范围不自动做；歧义、多候选、越权、敏感跨域一律退回复核或走已有授权限制。

旧的 `control_router_pm_proposal` API 与「显式提议 + 人工确认」能力保留不变；普通授权任务走自动交接，与提议互斥，一条请求最多一个主要路由结果。四条件门禁放行并创建项目后，同一请求只为这个新项目发布一次受限任务 brief（本人原话，无历史、附件或其他项目材料），Router 不建工单，PM 自行建单派工；本人明确「仅创建 / 待命」时不发布 brief，保留创建后空闲语义。

持久记录 `router_handoff` 表按请求 ID 唯一：重复、并发、重启后的调用返回既有回执或未确认，不加发，也不凭旧记录恢复已失效授权。目标已暂停 / 结束、PM 被停 / 撤权、节点拒收都给出准确状态，不隐式复活。首页新增「高层 Router 交给项目 PM 的工作」一栏，沿用快路由与门禁的记录样式，显示项目、PM 会话 ID、实际确认与排队 / 未确认 / 失败的原因。快路由投递继续使用原有提示词。高层普通工作和新项目的工作说明提醒 PM 自行决定如何建单和派工。

新增 `src/control/router-handoff.ts`（纯判断，无 store / node / model）与 `tests/control-plane-router-handoff.spec.ts`，覆盖成功、同 ID 去重、过期与重启重放、未知 / 多目标不发、角色与被停边界、节点拒收与缺回执、原话与附件边界、门禁后只发给新项目、「仅创建 / 待命」保持空闲。规范见 [高层自动交接](../021-phase3-router-handoff.zh-CN.md)。

验收修复了模糊引用接受改写后指令、门禁只转发证据短句而遗漏执行要求、相似名称分别出现时漏判歧义、同一请求交给 PM 后还能派独立工单，以及首页不显示拒绝原因的问题。交接使用连续原文，门禁后的工作说明保留整条请求的模块和限制。

类型检查和构建通过。完整定向回归 55 文件，737 项通过、1 项因 Windows 目录联接限制跳过。此前一次随机端口被 fetch 拒绝，原测试文件单跑和整组重跑均通过。全量测试未重跑。

Edge、真实 DSH Desktop 0.2.2.0、隔离 `phase3-live`、`dsh-superagent/node` 和本机 Gemma 4 12B 验收通过。既有项目收到一次自然语言任务，Worker 写入 `handoff.txt` 并报告，PM 验收同一工单。门禁为三模块任务只创建一个项目，工作说明送达一次，真实 PM 派工，三个文件内容正确，三个工单均验收通过。追加样例核对了三份最终报告和 PM 项目报告进入 Router 收件箱。首页核对了项目、PM 会话和确认状态。证据见本机忽略目录 `.artifacts/phase3-5-20261117/` 的 `live-FKJYKt/evidence.json`、`live-uvwzcl/evidence.json` 与 `live-eO4MtR/evidence.json`。

## P3-4

Claude Code 使用 MiniMax M3.1 Flash、`--effort max` 编写隔离实验，Codex 在本机修正脚本并实际运行。Git 层 19 项通过，覆盖不同文件、同一文件、合并冲突、失败清理边界和单派工 diff。项目页新增共享目录并行写入提示。生产工作区与审阅实现保持现状。候选方案、未验证的真实 DSH 部分及用户决策范围见 [工作区实验与设计记录](PHASE3_WORKSPACE_SPIKE.md)。
