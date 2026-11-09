# 基线说明

## 这是什么

本仓库是 superagent 的独立开发基线。上游官方原型保留在 `../prototype`，只作参考，不在这里修改。本仓库从 `windows-v2/source` 的 2026-11-09 19:38 工具版导入。

- 上游来源提交：`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`
- 基线导入提交：`chore: import V2 tool baseline (2026-11-09 19:38)`
- 本仓库不附带 V2 验收记录；V2 验收属于上一轮实验，和这里的开发基线分开。

## 主入口的权限模型

主入口现在是正式 Source：`main-session`（`src/sources/main-session.ts`）。

- 它在 Settings → Sources 里是一张“用户会话”卡片，只有一个 `operator` 字段，默认 `dsh-user`。
- Policy 的“On each Source”里增加“用户会话”的 allowed list。只有名单里的 operator 能从主 Session 发起工作。
- 新库首次启动会写入一条默认 Policy：`main-session` 允许 `dsh-user`。保存 Source 卡片时，allowed list 会自动同步成当前 operator（只保留它，已有显示名会保留）；启动时也会校正一次。它不是 `allowedSender` 的硬编码放行。
- 手改 allowed list 会被下一次保存或启动校正；要停用主入口，用 Source 卡片的启用开关，不要用删名单的方式。
- 入口工具是 `orchestrator_user_trigger_create`：主 Session 明确派工时登记当前原生消息为一条 Trigger，再由 `orchestrator_route` 建单。普通聊天不建单。
- 工具在 Source 关闭或 operator 不在 allowed list 时直接拒绝，并说明要改哪里；它不绕过 gate，accept 仍会正常创建 Mandate。
- 主入口派出的 Ticket 使用现有 Worker preset，保留全工具；只读限制不施加给 Ticket。

### 只读约束

主 Session 是唯一的，默认允许派单。它自己的工作方式是“提示词级只读”：

- 可以读、查、路由和回复；不修改共享工作区，也不改其他 Worker 或 PM 的目录。
- 人明确要求主 Session 自己写文件或执行写命令时，它先说明需要什么写操作并征求确认；确认后可以由它自己做，或者按情况派一张全工具 Ticket。
- 这不是工具或沙箱限制：Router preset 仍保留 shell，主 Session 的权限仍是 `danger-full-access`。约束在 `prompts/orchestrator.md`，靠模型遵守。

### Thread

DSH 主 Session 是一条连续聊天会话。领域里的 `Trigger.threads` 目前仍是每条消息一个独立 Thread（`main-session:<triggerId>`，V1 本地面板、V2 工具沿用的写法，不是上游原有设计）。这样多个任务不会通过同一个 Thread 互相 fan-out；thread 语义等后续任务分派/交接设计时再定。

## 已保留的通用执行控制

`stopAssignment`、`interruptedAt` / `turnBegan`、`executionStatus` 回执、面板的“停止本次派工”接口与按钮、Worker 权限预设选择、Windows 的 `pwsh` 与路径适配都保留。

`src/executor/dsh.ts` 和 `src/app/runtime.ts` 里按 `source === 'main-session'` 走的回执分支仍在；主入口重新启用后会用到它们。

## 验证

2026-11-09 在本机验证：

- `tsc --noEmit` 通过，`tsdown` 打包通过。
- 定向 6 个测试文件（`runtime`、`policy`、`core-engine`、`model-surface`、`tools`、`runtime-concurrency`）共 630 项：629 通过；1 项失败，是 Windows 下 Git 配置路径转义断言，与上游已知问题同类。
- 设置、面板、registry 和 views 相关的 5 个测试文件共 50 项全部通过；`index`、`http` 7 项全部通过。
- `tests/docs.spec.ts` 3 项失败，都是 Windows 路径分隔符导致的既有问题；新增的基线文档和链接检查通过。
- 模型可见文本预算（`model-surface`）已重新压到 59000 字符以内。

## 后续顺序

1. 权限控制（当前）
2. 任务分派
3. 任务交接
4. 意外中断与恢复
5. 再扩展新功能

## 文档说明

`docs/000` 到 `docs/008` 是上游文档；与本基线不一致的地方，以本文件和新增的 `docs/002` 主入口小节为准。`docs/PHASE1_MODIFICATION_PLAN_V2.zh-CN.md` 是历史计划，不是当前验收依据。

本次改动涉及的文件：

| 文件 | 变更 |
| --- | --- |
| `src/sources/main-session.ts` | 新增内置 User Session Source：operator 配置、Policy part、scope |
| `src/app/tools/main.ts` | 恢复 `orchestrator_user_trigger_create`，增加 Source 开关与 allowed list 检查 |
| `src/core/engine.ts` | 恢复 `recordTriggerForRouting` |
| `src/core/intake.ts` | 恢复跳过评估的参数 |
| `src/policy.ts` | 不再有 `USER_SESSION_ACTOR` 特判；权限走正常 `allowedSender` |
| `src/app/runtime.ts` | 注册 User Session Source，首启写入默认 Policy，给工具提供 operator |
| `src/kv.ts` | 记录默认 Policy 是否已播种 |
| `prompts/orchestrator.md` | 主 Session 提示词级只读，写操作先确认 |
| `prompts/dispatch.md` | 恢复主入口工具的使用说明 |
| `tests/runtime.spec.ts`、`tests/policy.spec.ts` | 覆盖默认允许、operator 配置、拒绝和关闭状态 |
| `docs/002`、`docs/004`、`docs/005`、`docs/007` | 记录主入口权限、只读约束、Source 卡片和工具 |
