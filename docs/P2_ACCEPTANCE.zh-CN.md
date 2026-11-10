# P2 验收说明

本文记录 P2（Project Profile + PM 小号 Router）的验收范围、场景和已知边界；P2.1–P2.5 的代码细节见 [BASELINE](BASELINE.zh-CN.md)。

## 范围

```text
用户主窗口
  → Router / 主 Session
      ├─ 独立任务 → Router-owned Ticket → Worker
      └─ Project（四条件）→ Project Profile + PM Mandate + PM Session
                              → PM-owned Ticket → Worker
```

P2 完成：

- Project Profile、PM Mandate、`project` Decision（record-only Eval，真实 `evalId`）。
- PM Session `pm-<projectId>`：小号 Router；只读自己的 Project，创建项目内 Ticket，向 Router 汇报。
- PM 建 Ticket：每张一条内部 Trigger + record-only Eval + `delegated` Decision；1 Decision ↔ 1 Ticket；不自动订阅 Project 源 Thread。
- child 可显式订阅外部 Thread（`contextOnly` 可选）。
- 可选 `allow_tools` 白名单：省略/空 = 继承 PM Mandate 或全量；只能从 `WORK_TOOLS` 收窄；subagent 继承。
- child report/attention 回所属 PM；PM 项目汇报回 Router。
- Project 状态：`active / paused / ended / archived`；暂停阻止新 Ticket，结束级联停止 open child Ticket，归档级联 archive Project/Ticket/Session。
- Project Tab：列表、详情、child Ticket/Thread、打开 PM Session、Pause/Resume/Stop/Archive/Unarchive。
- DSH 原生 archive/unarchive 联动：PM 归档→整个 Project 归档；worker 归档→Assignment 结束、Ticket 保留、Project pendingNotes；不自动 retry，不主动唤醒 PM。

## 验收场景

| 场景 | 预期 | 覆盖 |
| --- | --- | --- |
| 创建 Project | 主 Session 工具建 Project Profile、PM Mandate、`project` Decision、PM Session；不建 Ticket | `tests/projects.spec.ts` |
| PM 建两张 Ticket | 每张有内部 Trigger、`delegated` Decision、真实 evalId、projectId、ticketId；两个 Worker Assignment 启动 | `tests/project-tickets.spec.ts` |
| child 订阅 thread | 显式 thread 进入 `Thread.subscriptions`；`contextOnly` 进入 `Thread.context`；不自动订阅 Project 源 Thread | `tests/project-tickets.spec.ts` |
| 幂等/回滚 | 同 projectId + task index 不重复建；一个 task 非法则整批回滚 | `tests/project-tickets.spec.ts` |
| allow_tools | 指定后 Worker/subagent 实际 restrict 只保留该列表；未指定全量；未知/重复/超 32/扩大 PM Mandate 被拒 | `tests/project-tickets.spec.ts`、`tests/runtime.spec.ts` |
| child report/attention | 只到 PM；主 Session 不收；Router-owned Ticket 仍回主 Session | `tests/project-tickets.spec.ts` |
| PM 项目汇报 | 写 latestReport，并向主 Session relay 一条 `project_report`；重复同文本只投一次 | `tests/project-tickets.spec.ts` |
| Project 暂停 | paused 阻止新 Ticket；已有 child 继续运行并继续回 PM；resume 后可建 | `tests/project-tickets.spec.ts` |
| Project 结束 | ended；所有 open child Ticket 停止；重复 stop 幂等；ended 不能建单 | `tests/project-tickets.spec.ts` |
| Project 归档 | Project + 所有 child Ticket archived；Assignment 结束 `projectArchived`；PM/child Session archive；archived 不能建单 | `tests/project-tickets.spec.ts` |
| Project 取消归档 | 恢复 archivedFrom；清 Ticket archived；Session unarchive；不自动 retry | `tests/project-tickets.spec.ts` |
| DSH 原生归档 | PM archive→Project archive、PM unarchive→Project unarchive；worker archive→Assignment `sessionArchived`、Ticket open、pendingNote；重复 reconcile 不重复 | `tests/archive-reconcile.spec.ts` |
| 拒绝/权限 | PM 只能是自己的 Project 的 PM；PM 不能 pause/stop/archive；API 非同源或缺 header 403 | `tests/projects.spec.ts`、`tests/http.spec.ts` |
| Project Tab | 列表/详情/child Ticket/Thread/Open PM Session/Pause/Stop/Archive/Unarchive | `tests/panel-project.spec.tsx` |

## 验证记录

2026-11-10 本机：

- `tsc --noEmit` 通过；`tsdown` 通过。
- `tests/project-tickets.spec.ts` 18 项、`tests/archive-reconcile.spec.ts` 3 项、`tests/panel-project.spec.tsx` 3 项、`tests/http.spec.ts` 5 项通过。
- 定向 `runtime`、`projects`、`tools`、`outbox`、`passes`、`queue`、`model-surface` 通过；`runtime` 唯一失败是既有 Windows Git 配置路径转义。
- 全量 63 个测试文件、1239 项：1191 通过，48 失败；失败均为既有 Windows/sandbox 环境问题（`spawn EPERM`、路径分隔符、权限位、绝对路径读取），没有新增逻辑失败。
- `docs.spec` 的 3 项失败仍为 Windows 路径分隔符既有问题。

## 已知边界

- 删除暂缓；DSH 没有 session delete，Project/Ticket 归档已完成，归档不删除记录，取消归档恢复 `archivedFrom`。
- 外部 DSH unarchive 没有事件，由 30 秒 unref 定时 reconcile 兜底；归档事件与下一次 pass 确认。
- 当前 `paused` 只阻止新建 Ticket/继续创建；soft/hard pause 尚未实现（soft 收尾、hard 停止 Project 内所有 Session 是后续项）。
- 未做 PM 直接回答 child attention；child 的 blocker 由 PM 汇总到 `project_report`。
- 未新增 Project 状态变更的 domain event；状态持久化和级联 `ticket.ended` 已覆盖。
- PM 复用 `settings.eval.model`，没有独立 PM 模型设置；`eval.pmModel` 是后续项。
- 未做 Project Memory、RAG、Fast Router 拆分、父 Ticket/Dispatch/TaskSpec、capability 档/`denyTools`。
- 真实 DSH 宿主重启后 PM Session 的加载/唤醒未在 fixture 中完整复现；relay 目标已按 Project 状态选择，PM Session 由 DSH 解析。该点仍需在真实宿主重启场景单独验证。
