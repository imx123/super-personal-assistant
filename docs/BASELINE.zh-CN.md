# 基线说明

## 这是什么

本仓库是 superagent 的独立开发基线。上游官方原型保留在 `../prototype`，只作参考，不在这里修改。本仓库从 `windows-v2/source` 的 2026-11-09 19:38 工具版导入。

- 上游来源提交：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`
- 基线导入提交：`chore: import V2 tool baseline (2026-11-09 19:38)`
- 本仓库不附带 V2 验收记录；V2 验收属于上一轮实验，和这里的开发基线分开。

## 当前状态

主入口（在原生主 Session 里注入 Trigger）已停用。停用的是入口本身，不是通用的执行控制：

- 已移除：`orchestrator_user_trigger_create` 工具及其提示词、`Engine.recordTriggerForRouting`、`Intake.receive` 的跳过评估参数、`USER_SESSION_ACTOR` 在 `allowedSender` 里的硬编码放行，以及对应的入口测试。
- 已保留：`stopAssignment`、`interruptedAt` / `turnBegan`、`executionStatus` 回执、面板的“停止本次派工”接口与按钮、Worker 权限预设选择、Windows 的 `pwsh` 与路径适配。
- 暂不定义：主入口的 thread 语义。DSH 主 Session 是连续聊天；领域里的 `Trigger.threads` 目前仍是每条消息一个独立 Thread（这是 V1 本地面板、V2 工具沿用的写法，不是上游原有设计）。等主入口权限和分派一起设计时再定。
- 仍在但不会触发：`src/executor/dsh.ts` 和 `src/app/runtime.ts` 里按 `source === 'main-session'` 走的回执分支。入口停用期间没有这种 Ticket；后续重做入口时再决定复用还是删除。

## 验证

2026-11-09 在本机验证：

- `tsc --noEmit` 通过，`tsdown` 打包通过。
- 定向 6 个测试文件共 626 项：625 通过，1 项失败，原因是 Windows 下 Git 配置路径转义与断言不一致（与上游已知失败同类）。
- `tests/docs.spec.ts` 3 项失败，都是 Windows 路径分隔符导致的既有问题；新增的基线文档链接检查通过。

## 为什么停用

主入口原来的 actor 是合成的 `main-session/dsh-user`，在 `allowedSender` 里直接放行，没有可审计的 policy 条目。权限模型还没定，所以先撤销这个特权；后续用显式的 policy 配置或一个真正的本地 Source 重新引入。停用期间主入口不能派工，GitHub / 飞书入口和面板控制不受影响。

## 后续顺序

1. 权限控制
2. 任务分派
3. 任务交接
4. 意外中断与恢复
5. 再扩展新功能

## 文档说明

`docs/000` 到 `docs/008` 是上游文档，仍描述上游行为；与本基线不一致的地方，以本文件为准。`docs/PHASE1_MODIFICATION_PLAN_V2.zh-CN.md` 是历史计划，不是当前验收依据。

本次停用涉及的文件：

| 文件 | 变更 |
| --- | --- |
| `src/app/tools/main.ts` | 删除主入口工具、工具注册和路由描述里的入口引用 |
| `src/core/engine.ts` | 删除 `recordTriggerForRouting`，从主 Session 的 Engine 接口移除 |
| `src/core/intake.ts` | 删除跳过评估的参数，恢复每次接收都按规则排队 |
| `src/policy.ts` | 删除 `USER_SESSION_ACTOR` 及 `allowedSender` 的硬编码放行 |
| `prompts/dispatch.md` | 删除主入口工具的使用说明 |
| `tests/runtime.spec.ts` | 删除主入口派工测试，改为断言入口工具不存在、原生消息不进入 Trigger |
