# plexus-agent-plugins

Exposes models from a self-hosted [Plexus](https://github.com/mcowger/plexus) AI proxy as a first-class provider inside AI coding agents. Models appear in the agent's model picker with correct wire-protocol behavior, as if they were natively supported providers.

## Prerequisites

- A running Plexus instance

## Installation

The built `dist/extension.js` is committed to the repo, so no build step is needed for any install method.

### Option 1 — npm (recommended)

```sh
cd ~/.pi/agent/extensions
npm install @mcowger/pi-plexus
```

pi auto-discovers packages under `~/.pi/agent/extensions/` that have a `pi.extensions` field in their `package.json`.

### Option 2 — git clone into the extensions directory

```sh
git clone https://github.com/mcowger/plexus-agent-plugins ~/.pi/agent/extensions/plexus-agent-plugins
```

pi will find `packages/plexus-pi/` inside that directory and load `dist/extension.js`.

### Option 3 — git clone anywhere + settings.json

```sh
git clone https://github.com/mcowger/plexus-agent-plugins ~/code/plexus-agent-plugins
```

Then register the path in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "~/code/plexus-agent-plugins/packages/plexus-pi"
  ]
}
```

## First-time setup

On first use, run the login command inside pi:

```
/plexus login
```

You will be prompted for:

- **Plexus base URL** — e.g. `https://plexus.example.com`
- **Plexus API key**
- **Default model** (optional)

Credentials are stored in pi's standard `auth.json` (API key) and a small `config.json` (base URL). Models are fetched immediately and cached for fast startup.

After login, models appear in the model picker and refresh automatically on every new session.

To force a refresh at any time:

```
/plexus refresh
```

## Configuration files

All files live under the agent's data directory:

```
~/.pi/agent/extensions/plexus/
  config.json                  # base URL and optional default model
  plexus-models-cache.json     # last-fetched model list (startup cache)
  plexus-models-response.json  # raw API response (diagnostics)
  plexus.log                   # extension activity log
```

The API key is stored in pi's own `~/.pi/agent/auth.json` alongside all other provider credentials — it is never written to a separate file.

## Package layout

```
packages/
  plexus-models/        # host-agnostic data layer
    src/
      types.ts          # wire types (PlexusApiModel, PlexusModelDescriptor, etc.)
      convert.ts        # model fetching, conversion, compat detection
      index.ts          # barrel export
  plexus-pi/            # pi host adapter
    src/
      extension.ts      # entry point: commands, session refresh, auth flow
      mapper.ts         # PlexusModelDescriptor → pi ProviderModelConfig
      config.ts         # base URL / default model config I/O
      cache.ts          # model cache I/O
      log.ts            # append-only log
    package.json        # declares pi.extensions entry point
```

`plexus-models` has zero imports from any agent framework. `plexus-pi` imports it via a relative path.

## Development

After cloning, install dependencies to set up the pre-commit hook:

```sh
bun install
```

The pre-commit hook (via lefthook) rebuilds `dist/extension.js` automatically whenever source files change, so the committed artifact stays in sync. After committing, reload the extension in pi with `/reload` or restart the agent.

To add support for a new host agent, see [AGENTS.md](AGENTS.md).
