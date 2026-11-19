# super personal assistant

Tested on Windows with Node.js 26.12.1, DSH Desktop 0.2.2.0 and Microsoft Edge. [简体中文](README.zh-CN.md)

> **Independent development baseline derived from the [dsh-superagent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)** (upstream commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`). This repository is not an official DeepSeek product and is not endorsed by DeepSeek. The upstream MIT license and copyright are retained in [LICENSE-MIT](LICENSE-MIT); see [NOTICE](NOTICE) for attribution.

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

The standalone console uses one DSH execution node. Its Router can dispatch standalone work or create a project. A project PM can assign work to Workers and review their results. The browser also shows activity, sessions and scheduled PM messages. [Current handoff](project_handoff.md)

The original [DeepSeek Harness](https://www.deepseek.com/en/harness/) bundle is a separate entry point. Its GitHub and optional Feishu sources let it open a work item and answer in the original conversation, for example with a pull request.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

For the standalone console, follow the [node deployment guide](docs/015-node-deployment.zh-CN.md). For the original DSH bundle, ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Start with the [handoff](project_handoff.md), [console guide](docs/017-console.zh-CN.md) or [node deployment guide](docs/015-node-deployment.zh-CN.md). The numbered documents below cover the implementation and its history.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Node protocol](docs/009-node-protocol.zh-CN.md): the control-plane/node command and event contract, SessionRecord/SessionInspection and session tokens (Chinese)
- [010 Control-plane kernel](docs/010-control-plane-kernel.zh-CN.md): the standalone kernel, its API and run modes (Chinese)
- [015 Node deployment](docs/015-node-deployment.zh-CN.md): control-plane plus independent DSH node deployment and operations (Chinese)
- [016 Control-plane TLS](docs/016-control-plane-tls.zh-CN.md): viewer authentication, SSE and reverse-proxy TLS guidance (Chinese)
- [017 Console](docs/017-console.zh-CN.md): Router, projects, sessions, schedules and settings (Chinese)

See the [execution log](docs/roadmap/PHASE3_5_EXECUTION_LOG.md) for acceptance results and the [archive](docs/archive/README.md) for earlier plugin documentation.

## Development

`pnpm install` installs the dependencies and builds `lib/` through the `prepare` script, so a clean clone is loadable. `pnpm check` runs the typecheck, the tests and the build; run `pnpm build` on its own after editing the source.

`pnpm test` runs Vitest with the `threads` pool set in `vitest.config.ts`, which avoids the Windows forks-pool `spawn EPERM`. Tests that start real processes may still fail where the sandbox forbids them.

`pnpm pack` runs `prepack` first and ships the fresh `lib/`, the deployment `scripts/` and `examples/`. To check a tarball without installing it:

```sh
pnpm pack --pack-destination .artifacts
tar -tf .artifacts/dsh-superagent-0.1.0.tgz
```

## License

This project is distributed under [GPL-3.0-or-later](LICENSE). The upstream dsh-superagent prototype remains MIT-licensed; its notice is in [LICENSE-MIT](LICENSE-MIT).
