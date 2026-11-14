# Node-only DSH profile example

This directory is a starting point for the execution node of a two-process deployment: a control plane started with
`node lib/control.js`, and a separate DSH process started with `dsh --profile superagent-node`. The DSH process hosts
real Sessions for PMs and Workers and serves the node protocol on one loopback port. It is not a Web app.

It differs from [`../profile.cordis.patch.yml`](../profile.cordis.patch.yml), which is an overlay for a normal Web
profile: that file configures the `dsh-superagent` bundle (panel port and `stateDir`) and still loads the control
plane's Runtime, Store, Sources and panel in the same process. The node profile here is a complete profile: it loads
only `@deepseek-ai/dsh-base`, the workspace and agent-preset services, the PM and Worker presets, and the repository's
node plugin (`dsh-superagent/node`). It mounts no `dsh-web-app`, no `dsh-headless`, no session controller, no file
upload, and no `dsh-superagent` top-level bundle. The control plane is a different process with its own database.

Keep the node profile in its own DSH home: the Web profile and the node profile must not share sessions, state, or
credentials, and must never load in one process.

## Files

| File | Purpose |
| --- | --- |
| `package.json` | Profile manifest: the base bundle and this repository as a dependency |
| `cordis.patch.yml` | The profile's patch: workspace, preset registry, PM/Worker presets, the node plugin, and optional model rows |

Do not copy a `.credentials.yaml` or any token into this directory. Credentials belong to the DSH home the node runs
with, and tokens belong to the process environment.

## Install

The repository must be built first, because the profile loads `lib/node-plugin.js` and never `src/*.ts` (DSH's Node
runtime is strip-only and rejects constructs such as parameter properties).

```sh
# In the repository checkout
pnpm install          # `prepare` builds lib/; run `pnpm build` after later source edits

# Create the profile directory in a dedicated DSH home (never the user's default profile)
export DSH_HOME=/srv/superagent/node/dsh-home
mkdir -p "$DSH_HOME/profiles/superagent-node"

# Copy the two files from this directory, then replace <absolute path to this repository>
# in package.json with that path, for example "file:/srv/superagent/dsh-superagent".
cp examples/profile.node/package.json examples/profile.node/cordis.patch.yml \
  "$DSH_HOME/profiles/superagent-node/"
```

If the profile directory has no `cordis.yml` yet, create one containing an empty list. DSH composes the tree from the
bundles and this patch; the root file stays empty:

```yaml
[]
```

Install the bundle into the profile, then validate the composed tree before starting anything:

```sh
dsh plugin --profile superagent-node add "link:<absolute path to this repository>"
dsh --profile superagent-node --dump-config > /dev/null
dsh --profile superagent-node --dump-config | grep -E 'dsh-superagent/node|dsh-workspace|agent-preset'
```

`link:` keeps the profile following the checkout, so a rebuild is enough after a source change. Use `file:` for a
pinned copy of the package instead. If the profile name does not exist, `dsh plugin ... add` creates it; it also
writes the profile's `node_modules`.

`--dump-config` must exit 0, name `dsh-superagent/node`, `@deepseek-ai/dsh-workspace`, the preset registry and both
presets, and report no unknown plugin. A bundle that DSH skips for incompatibility is listed in the launcher output;
fix the version range in the repository's `package.json` rather than editing the profile.

## Model configuration

The two model entries at the top of `cordis.patch.yml` are optional rows that make model turns possible:

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: <provider id from your DSH model configuration>
    model: <model id>
    reasoningEffort: high

- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      '<provider id from your DSH model configuration>':
        apiKeyEnv: <ENVIRONMENT VARIABLE HOLDING THE API KEY>
```

A node-only profile mounts `agent-default-model` for its configuration but none of the plugins that consume it. The
node's Session adapter therefore reads the profile's current selection and writes it as the Agent's `model/selection`
before the first turn. Without these rows the first turn fails with `agent ... has no provider/model`; there is no
model shim in this example and none is needed.

The key lives in the dedicated `$DSH_HOME/.credentials.yaml` (under `refs.<the environment variable named above>`) or
in the environment variable itself. Keep the file out of the profile directory, out of the repository, and out of
logs. Only the node process needs the key; the control plane never reads it.

If this node will never run a model turn, remove both rows. The node then starts and serves Sessions, but every
prompt that reaches a model fails.

## Start and stop

Start the node first: the control plane registers with it during startup and refuses to start if registration fails.

```sh
# Node process
export DSH_HOME=/srv/superagent/node/dsh-home
export DSH_AGENTS_HOME=/srv/superagent/node/agents
export DSH_TELEMETRY_DISABLED=1
export SUPERAGENT_NODE_TOKEN='<random node token>'
export SUPERAGENT_NODE_PORT=47101
export SUPERAGENT_NODE_HOST=127.0.0.1
export SUPERAGENT_NODE_ID=node-1
export SUPERAGENT_NODE_ROOT=/srv/superagent/node
export SUPERAGENT_CONTROL_URL=http://127.0.0.1:47100   # optional: register the control_* proxy tools
dsh --profile superagent-node
# dsh-superagent node listening on http://127.0.0.1:47101
```

```sh
# Control-plane process, another terminal
export SUPERAGENT_CONTROL_TOKEN='<operator token, different from the node token>'
export SUPERAGENT_CONTROL_PORT=47100
export SUPERAGENT_CONTROL_DB=/srv/superagent/control/control.sqlite
export SUPERAGENT_WORKSPACE_ROOT=/srv/superagent/node/workspaces   # must be inside SUPERAGENT_NODE_ROOT
export SUPERAGENT_NODE_URL=http://127.0.0.1:47101
export SUPERAGENT_NODE_TOKEN='<the same node token>'
export SUPERAGENT_NODE_ID=node-1
node lib/control.js        # or: pnpm control
# superagent control plane listening on http://127.0.0.1:47100
```

`SUPERAGENT_WORKSPACE_ROOT` must resolve inside `SUPERAGENT_NODE_ROOT`; the node refuses a workspace outside its root.
The control plane uses a built-in fake node when `SUPERAGENT_NODE_URL` is unset, so set it for any real deployment.

Health and authentication:

| Check | Expected |
| --- | --- |
| `curl -fsS http://127.0.0.1:47101/health` | `{"ok":true,"service":"superagent-node"}` |
| `curl -fsS http://127.0.0.1:47100/health` | `{"ok":true,"service":"superagent-control-plane"}` |
| `curl -fsS -H "Authorization: Bearer $SUPERAGENT_CONTROL_TOKEN" http://127.0.0.1:47100/v1/state` | `nodes["node-1"].online` is `true`; at least one event |
| A command with a wrong node token | `401` from `/commands` |
| `curl -fsS http://127.0.0.1:47101/` | `404`: the node has no panel or Web route |

Stop the control plane first, then the node. Both handle SIGTERM and SIGINT: the control plane stops its heartbeat,
ends open event streams and releases the database lock; the node's DSH launcher disposes the plugin tree, which
aborts deliveries in flight and closes the node listener. Do not use a forced kill (`taskkill /F`, `kill -9`) when a
graceful stop is possible: a killed control plane leaves a lock that the next start refuses until it becomes stale,
and a killed node can lose a turn that was still running.

See [docs/015-node-deployment.zh-CN.md](../../docs/015-node-deployment.zh-CN.md) for the environment-variable table,
the failure manual (stale lock, offline 502, re-ensure, event `seq`), upgrades, log redaction and Windows service
notes. `lib/node.js` (`pnpm node`) still hosts `FakeNode` and is for tests and compatibility only; a production node
is always `dsh --profile superagent-node` with this profile.
