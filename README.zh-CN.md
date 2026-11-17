# Super personal assistant

测试环境为 Windows、Node.js 26.12.1、DSH Desktop 0.2.2.0 和 Microsoft Edge。 [English](README.md)

独立控制台连接一个 DSH 执行节点。你可以和 Router 对话、派独立工单、建项目或查看进度。项目 PM 负责派工和验收，Worker 在项目工作区执行并回报。控制台还提供会话管理、近期动向、定时消息和部署设置。 [当前交接](project_handoff.md)

项目源自 [dsh-superagent 研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)。原有 DSH 插件是另一套入口，保留其 GitHub、可选飞书来源和 DSH 面板。 [来源与版权](NOTICE)

## 启动与使用

- [独立控制面与 DSH 节点部署](docs/015-node-deployment.zh-CN.md)
- [控制台操作](docs/017-console.zh-CN.md)
- [反向代理与 TLS](docs/016-control-plane-tls.zh-CN.md)
- [原有 DSH 插件安装](SETUP.md)

## 开发

运行 `pnpm install` 安装依赖并生成 `lib/`。修改代码后可用 `pnpm typecheck`、`pnpm test` 和 `pnpm build` 分别做类型检查、测试与构建。当前功能范围和已有验收记录见[项目交接](project_handoff.md)。

本项目使用 [GPL-3.0-or-later](LICENSE)。上游原型的 MIT 许可保留在 [LICENSE-MIT](LICENSE-MIT)。
