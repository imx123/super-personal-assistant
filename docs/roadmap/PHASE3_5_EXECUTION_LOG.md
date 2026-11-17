# Phase 3–5 执行日志

2026-11-17。基线 `6875ef9`，开发分支 `next`。Claude Code 逐任务实施，Codex 核对代码及独立验收。每个任务独立提交。上一阶段的必验项目全部通过后进入下一阶段。

| Task | 依赖 | 交付 | 状态 |
| --- | --- | --- | --- |
| P3-0 | — | 基线、权限和停止矩阵 | DONE |
| P3-1 | P3-0 | 全角色会话干预，真实 DSH | DONE |
| P3-2 | P3-1 | 快路由、自动派工及回执，真实 DSH | NOT_STARTED |
| P3-3 | P3-2 | 高层路由、四条件门禁及 PM 自动交接，真实 DSH | NOT_STARTED |
| P3-4 | P3-0 | 工作区隔离实验与 ADR | NOT_STARTED |
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

Claude Code（MiniMax-M3.1-Flash）完成基线调查。Codex 对照源码、任务书和本机测试复核，补充随机端口失败记录，并区分纯回合中断和节点全会话停止。[基线](PHASE3_BASELINE.md)包含当前能力、状态变化、权限和停止作用域、自动交接迁移及 P3-1 计划。

本轮 12 个文件 198 项通过、1 项跳过。类型检查和直接运行 tsdown 通过。全量与真实模型未重跑。旧审计仍为本地未跟踪文件。本次提交只包含这两份文档。

## P3-1A

Claude Code（MiniMax-M3.1-Flash）实施，Codex 独立验收。操作员可分开停止 PM 或 Router 会话、停止单个 Worker 派工以及取消工单。停止 PM 保留项目、工单、Mandate 和其他 Worker。恢复须由操作员明确发起，节点未确认停下时拒绝恢复。持久停止标记和领域事实同时保护重启后的消息、ensure 与恢复入口。操作范围及 API 见 [P3-1A 规范](../018-phase3-session-stop.zh-CN.md)。

复核补齐了并发停止与恢复、停止前尚无会话的 Worker，以及低层入口绑定 Ticket 和 Project 的校验。旧 Assignment 的停止诊断保留在原派工上。类型检查、构建与 47 文件定向回归通过，605 通过、1 跳过（Windows 目录联接）。定向回归之间有一次随机临时端口导致 fetch 报 `bad port`，完整定向重跑通过。本轮未跑全量。

真实 DSH Desktop 0.2.2.0、隔离 `phase3-live` profile 和 `dsh-superagent/node` 使用本机 llama-server 的 Gemma 4 12B。停下 PM 后项目仍 active，两组 Worker 与 Assignment 保持原身份，消息和 ensure 拒绝隐式恢复，Router 可读停止通知。经显式恢复，原 PM 接收下一条消息并执行第 2 轮，该轮因模型达到输出上限结束。故障注入由 FakeNode 测试覆盖。验收脚本和脱敏证据保存在本地忽略目录 `.artifacts/phase3-5-20261117/`，证据文件为 `live-edI3Mg/evidence.json`。

P3-1A 已验收。P3-1B 接回合中断、Router 顺序插话和前端，完成后再验收 P3-1。

## P3-1B

Claude Code 使用 MiniMax M3.1 Flash、`--effort max` 实施，Codex 独立验收。Router 忙时仍可提交，普通插话先持久排队，当前回合结束后按顺序进入后续回合。刷新可查看排队状态，节点入箱与回合读取分别显示。重复请求按 ID 去重，明确拒收保留原因，缺回执标记未确认。重启后只对尚未投递的排队消息恢复原有请求窗口。

打断请求绑定当前回合编号，由节点确认该回合以 `aborted` 结束。控制台会话页可查看 Router、PM、Worker，操作员可单独停止和恢复 PM 或 Router，停止未确认时可重试，取消整个工单须确认。

类型检查、构建及 51 文件定向回归通过，653 项通过、1 项因 Windows 目录联接限制跳过。覆盖节点拒收、丢回执、持久队列重启、过时回合、旧派工和权限边界。全量测试未重跑。

Edge、DSH Desktop 0.2.2.0、隔离 `phase3-live`、`dsh-superagent/node` 和本机 Gemma 4 12B 复验通过。两条插话在第一轮生成时提交，刷新后仍列在队列中，随后分别进入第二、第三轮。点击中断并插话后，第四轮以 `aborted` 结束，第五轮收到新消息，项目状态不变。会话页点击停止 PM 后，项目仍 active，两个 Worker 派工保持原身份，显式恢复后原 PM 收到了新消息。证据位于本地忽略目录 `.artifacts/phase3-5-20261117/` 的 `live-09FYhL/evidence.json`、`live-N7c91D/evidence.json`。

P3-1 已验收，下一项为 P3-2。快路由首版用确定性规则，OpenSquilla 与小模型接入可选。
