# Project Handoff

本文是 superagent 的交接入口，给接手的人一份整体地图。具体设计、字段和验收细节不在这里重复，按文末“文档地图”去对应文档看。

## 这是什么

一个独立的 superagent 开发基线，派生自 MIT 许可的 dsh-superagent research prototype；当前仓库使用 GPL-3.0-or-later，上游 MIT 许可保留在 `LICENSE-MIT`，归属说明见 `NOTICE`。

- 仓库：`https://github.com/imx123/super-personal-assistant`
- 分支：`main`
- 上游参考：`prototype/`，保持原样，不在其中修改
- 冻结的 V2 工具基线：`windows-v2/source`，同样不修改

## 核心模型

```text
Source → Trigger → Thread → Eval → Decision → Ticket → Mandate → Assignment → Worker Session
```

- `Engine` 是唯一写入方；SQLite `Store` 持久化；`Effects` 负责可重试的对外动作。
- 主窗口是 Router：普通聊天不建单，明确派工才走 Trigger/Decision/Ticket。
- Project 是 Router 之下的一层：Project Profile + PM Mandate + PM Session `pm-<projectId>`。
- PM 是一个项目范围内的小号 Router：只读自己的 Project、创建项目内 Ticket、向 Router 汇报，不自己实现工作。
- 项目内 Ticket 用内部 Trigger + record-only Eval + `delegated` Decision 创建；1 Decision ↔ 1 Ticket，不自动订阅 Project 源 Thread。

## 当前能力

### 主入口

- `main-session` Source、allowed operator、`orchestrator_user_trigger_create` + `orchestrator_route`。
- 主窗口派工走 gate-only `directEval`，不额外造 Eval 路径。
- 权限：主窗口用户会话走 Policy；PM/Worker 走 DSH 权限 preset。

### Project / PM

- Project Profile、PM Mandate、Project 状态：`active / paused / ended / archived`。
- PM Session `pm-<projectId>`：`orchestrator_read`、`orchestrator_project_ticket_create`、`orchestrator_project_ticket_message`、`orchestrator_project_report`。
- PM 只能读自己的 `project/<id>`、`project/<id>/tickets` 和项目内 `ticket/<id>`。
- PM 默认权限 `auto`；PM 默认模型 `eval.pmModel ?? eval.model`。

### Project Ticket

- PM 一次可建 1–5 张 Ticket；内部 Trigger、record-only Eval、`delegated` Decision、真实 `evalId`。
- Ticket 可显式订阅外部 Thread（`contextOnly` 可选）；不自动订阅 Project 源 Thread。
- 可选 `allow_tools` 白名单：只能从 `WORK_TOOLS` 收窄；subagent 继承；不是文件系统沙箱。
- 可选 `wake` 的 PM→Worker coordination note：落为 Ticket Input，进入历史，不授予权限；`wake=true` 仅在 Ticket 可 retry 时启动新 Assignment。

### 报告与可见性

- Router-owned Ticket 报告回主 Session。
- Project Ticket 报告/attention 回所属 PM，不回主 Session。
- PM 的 `orchestrator_project_report` 写 `latestReport`，并向主 Session relay 一条结构化 `project_report`。
- PM 下一次 prompt 会读取 `pendingNotes`（worker 归档/恢复、hard pause 恢复同步），然后清除；不主动唤醒 PM。

### 状态与归档

- `pause` 分 soft/hard：
  - soft：阻止新 Ticket/Assignment，已有 Assignment 继续，通知 PM 完成本轮 report 后停止；
  - hard：结束 Project 内 pending/running Assignment，取消 loaded PM/child Session 当前 turn，不 archive。
- `stop`：Project 置 ended，级联停止 open child Ticket。
- `archive`：Project + 所有 child Ticket 置 archived；结束 Assignment、archive PM/child Session；不删除记录。
- `unarchive`：恢复 `archivedFrom`、清 Ticket archived、unarchive Session；不自动 retry。
- DSH 原生 archive/unarchive 会通过 `ArchiveReconciler` 与 Project 状态对齐；30 秒 unref 定时器兜底 unarchive（DSH 没有 unarchive 事件）。
- `delete` 暂缓：DSH 没有 session delete，硬删应用记录会留下 Session 日志，当前不做。

### 事件

- `project.created` 以及 `project.paused / resumed / ended / archived / unarchived` domain events。
- 目前只供审计/测试，不自动 relay/notice，也不改 UI。

## 目录速查

```text
src/core/       领域模型、Engine、决策、Ticket、Project
src/app/        Runtime、Sessions、Store、HTTP、工具、读模型、归档 reconcile
src/executor/   DSH Executor：worker Session、报告、恢复
src/sources/    main-session、internal、Feishu、GitHub Source
src/client/     Web 面板
prompts/        主窗口、dispatch、PM、worker 提示词
docs/           设计、授权、面板、架构、基线与验收
tests/          Vitest 测试
cordis.patch.yml  预设（router / worker / PM）
```

## 运行与验证

在仓库根目录：

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/tsdown/dist/run.mjs
node node_modules/vitest/vitest.mjs run --pool=threads
```

本机 Windows 环境的已知问题：

- Vitest 默认 forks 池可能 `spawn EPERM`，用 `--pool=threads`；
- sandbox 下 `pnpm`/corepack 可能无法建临时目录；
- 全量约 1251 项中，约 48 项既有失败，均为 Windows 路径分隔符、权限位、`spawn EPERM`、绝对路径读取等环境问题，不是新增逻辑失败；
- `docs.spec` 的 3 项路径分隔符失败属于同一类。

模型可见文本预算：orchestrator 61,500 字符（`model-surface` 覆盖）。

## 已知边界 / 下一步

- Project/Ticket 删除、Project 归档后的物理清理未做。
- soft pause 的“报告后停止”是提示词/消息约束；hard pause 才强制取消 loaded Session。
- hard pause 只取消当前进程里 loaded 的 Session；未加载的 Session 没有 turn 可取消，恢复后读 paused 状态。
- `eval.pmModel` 只影响新建 PM Session；已有 PM Session 不自动切换。
- PM domain events 没有独立消费方。
- 真实 DSH 宿主重启后的 PM Session 加载/唤醒仍需真机验证；单测 fixture 没有完整模拟。
- 未做：Project Memory/RAG、Fast Router 拆分、父 Ticket/Dispatch/TaskSpec、capability 档/`denyTools`。
- 后续方向：任务交接、意外中断与恢复、Project 删除/归档清理、真实宿主重启验收。

## 文档地图

细节按原位置查：

- [BASELINE.zh-CN.md](docs/BASELINE.zh-CN.md)：当前基线、完成项、验证记录、已知问题。
- [P2_ACCEPTANCE.zh-CN.md](docs/P2_ACCEPTANCE.zh-CN.md)：P2 场景与验收边界。
- [P3_HANDOFF.zh-CN.md](docs/P3_HANDOFF.zh-CN.md)：P3 任务交接设计讨论稿（同 Project 换执行者、跨 Project 新 Ticket、人工暂停边界）。
- [001-domain.md](docs/001-domain.md)：领域对象、状态与事件。
- [002-authorization.md](docs/002-authorization.md)：Source、Policy、Mandate、Project/PM 权限。
- [005-panel.md](docs/005-panel.md)：面板页面、API 与 Project Tab 控件。
- [007-architecture.md](docs/007-architecture.md)：模块表、文件职责、测试表。
- `docs/000`–`docs/008`：上游文档；与当前基线冲突处以 BASELINE 和新增说明为准。

## 许可与归属

- 本仓库：GPL-3.0-or-later，见 `LICENSE`。
- 上游 MIT 许可保留：`LICENSE-MIT`。
- 来源与归属：`NOTICE`；不是 DeepSeek 官方产品。
