# Superagent 项目交接

更新于 2026-11-19。交付分支为 `next`，单节点 P5-Gate 已签收，受测代码为 `2f9ee4a`。本轮文档整理基于该版本。 [P5-Gate 验收与证据](docs/roadmap/PHASE3_5_EXECUTION_LOG.md#p5-gate)

## 1. 当前状态

- Router 可以派独立工单或把项目任务交给 PM。PM 分派 Worker，查看成果并决定验收或返工。控制台提供会话停止、回合中断、定时消息、报告恢复和权限拒绝审查。 [控制台手册](docs/017-console.zh-CN.md) · [协作与投递](docs/022-phase4-coordination-architecture.zh-CN.md)
- 控制台的 `/console#/memory` 提供实时状态、持久事件历史和长期记忆。操作员可审核候选、按作用域检索、查看来源、编辑、置顶或永久删除；只读密钥用于查看。Router、PM 与 Worker 在授权范围内使用记忆，控制面在相关工单完成或审核通过后核对实际采用证据。 [三域记忆契约](docs/023-phase5-memory-contract.zh-CN.md) · [上下文与治理](docs/025-phase5-context-and-governance.zh-CN.md)
- 永久删除清除运行库里的正文、同作用域同内容的关联副本和索引，不留指纹。原有工单、会话和旧备份遵循各自保留规则。从原始来源重新提取时，系统分配新记忆 ID。 [已批准的 Phase 5 规范](docs/roadmap/NEXT_PHASE5_MEMORY_SUPPLEMENT_v1.0.md)
- 外部订阅的群聊与短信关键词验收使用合成事件。双 Windows/Tailscale、后端适配与多节点执行由 `feat/multi-node` 负责。 [外部订阅记录](docs/roadmap/PHASE3_5_EXECUTION_LOG.md#p4-4) · [跨设备计划](docs/roadmap/MULTI_NODE_PLAN_v1.1.md)

## 2. 启动与复验

1. 在仓库根目录执行 `git status -sb`、`git log -5 --oneline` 核对分支和工作区。运行 `pnpm install` 与 `pnpm build`。
2. 按部署手册为 DSH 节点配置专用 profile，加装 `dsh-superagent/node`。先启动节点，再运行 `pnpm control`，从启动日志给出的 `/console` 地址登录。 [节点部署](docs/015-node-deployment.zh-CN.md) · [专用 profile 示例](examples/profile.node/README.md)
3. 排障先查两进程的 `/health`，再查控制面的 `/v1/overview` 和 `/v1/sessions`，确认节点、工单及当前派工。测试传输或协议时可运行 `pnpm node` 启动 FakeNode。 [运维与回滚](docs/015-node-deployment.zh-CN.md#5-故障手册) · [TLS 与 SSE](docs/016-control-plane-tls.zh-CN.md)

P5-Gate 使用 Windows、Node.js 26.12.1、DSH Desktop 0.2.2.0 的隔离 `phase3-live` profile 和 Edge，分别验证跨工单记忆、持久投递、重启恢复以及 390px 治理页面。脚本模型驱动真实 DSH 协作链路，本机 Gemma 4 12B 另完成从记忆取值、写文件与上报。

`pnpm typecheck`、构建及 961 项定向用例通过。Windows 全量 2,350 项通过、45 项失败，失败集合与基线一致。旧 jsdom 面板的 React 渲染失败也与对照一致。原始报告和屏幕截图位于验收机上 Git 忽略的 `.artifacts/`，路径见执行日志。 [完整验收结果](docs/roadmap/PHASE3_5_EXECUTION_LOG.md#p5-gate)

## 3. 入口与数据归属

| 位置 | 维护范围 |
| --- | --- |
| `src/control/`、`src/console/` | 控制面、Router、派工、HTTP/SSE 与独立控制台 |
| `src/node/`、`src/shared/protocol.ts` | 节点适配、角色工具与控制面协议 |
| `src/core/`、`src/memory/` | 工单领域、事件历史和记忆服务 |
| `src/index.ts`、`src/app/`、`src/client/` | 原有 DSH 插件及其 `/orchestrator/api` 面板，使用自身运行时数据 |

`SUPERAGENT_CONTROL_DB` 保存工单、派工、持久事件历史和长期记忆。同一业务库快照用于备份和回滚。`SUPERAGENT_CONSOLE_DB` 保存短期控制台事件、操作日志、手工项目备忘及定时计划。DSH 节点的专用 `DSH_HOME` 持有会话日志，项目源文件位于执行端工作区。 [控制面内核](docs/010-control-plane-kernel.zh-CN.md) · [模块与测试索引](docs/007-architecture.md)

## 4. 下一步

跨设备负责人准备好候选后，从 `next` 建临时集成工作树。核对 `NodeResolver` 寻址、Assignment 的节点和后端归属、回执代际校验、工作区隔离，再复跑双 Windows 独立工单、单节点回滚和 P3 至 P5 联合回归。当前同项目 Worker 共用工作区，真实 DSH 的逐派工 Git worktree 策略仍待决策。 [合流检查单](docs/roadmap/NEXT_MAINLINE_PLAN_v1.1.md#5-后续与-featmulti-node-的集成合流检查单) · [工作区实验](docs/roadmap/PHASE3_WORKSPACE_SPIKE.md)

## 文档入口

- [执行日志](docs/roadmap/PHASE3_5_EXECUTION_LOG.md)记录各阶段的签收提交、验收范围和证据。
- [主线计划](docs/roadmap/NEXT_MAINLINE_PLAN_v1.1.md)、[Phase 4 协作补充规范](docs/roadmap/NEXT_PHASE4_SUPPLEMENT_v1.0.md)及[节点协议](docs/009-node-protocol.zh-CN.md)用于继续开发。
- [历史文档索引](docs/archive/README.md)收录旧插件阶段的方案与验收。需要上一版交接细节时，运行 `git show cc642f9:project_handoff.md`。
