# plexus-agent-plugins

Exposes models from a self-hosted [Plexus](https://github.com/mcowger/plexus) AI proxy as a first-class provider inside AI coding agents. Models appear in the agent's model picker with correct wire-protocol behavior, as if they were natively supported providers.

## Supported agents

| Package | Agent | npm |
|---|---|---|
| `plexus-pi` | [pi](https://github.com/earendil-works/pi) | `@mcowger/pi-plexus` |
| `plexus-opencode` | [OpenCode](https://opencode.ai) | `@mcowger/opencode-plexus` |

## Prerequisites

- A running Plexus instance

## Installation

The built dist artifact is committed to the repo, so no build step is needed for any install method.

---

### pi

#### Option 1 — npm (recommended)

```sh
cd ~/.pi/agent/extensions
npm install @mcowger/pi-plexus
```

#### Option 2 — git clone into the extensions directory

```sh
git clone https://github.com/mcowger/plexus-agent-plugins ~/.pi/agent/extensions/plexus-agent-plugins
```

#### Option 3 — git clone anywhere + settings.json

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

---

### OpenCode

#### Option 1 — npm (recommended)

```sh
npm install -g @mcowger/opencode-plexus
```

Then add the plugin to your `opencode.json`:

```json
{
  "plugins": ["@mcowger/opencode-plexus"]
}
```

#### Option 2 — path reference

```sh
git clone https://github.com/mcowger/plexus-agent-plugins ~/code/plexus-agent-plugins
```

Then reference the built artifact in `opencode.json`:

```json
{
  "plugins": ["~/code/plexus-agent-plugins/packages/plexus-opencode/dist/index.js"]
}
```

---

## First-time setup

### pi

Run inside pi:

```
/plexus login
```

You will be prompted for:

- **Plexus base URL** — e.g. `https://plexus.example.com`
- **Plexus API key**
- **Default model** (optional)

To force a model refresh:

```
/plexus refresh
```

### OpenCode

Run inside OpenCode:

```
/connect
```

Select **Plexus** and enter your base URL and API key. Models are loaded immediately and cached for fast startup on subsequent sessions.

You can also pre-configure via environment variables:

```sh
export PLEXUS_BASE_URL=https://plexus.example.com
export PLEXUS_API_KEY=your-api-key
```

---

## Configuration files

### pi

```
~/.pi/agent/extensions/plexus/
  config.json                  # base URL and optional default model
  plexus-models-cache.json     # last-fetched model list (startup cache)
  plexus-models-response.json  # raw API response (diagnostics)
  plexus.log                   # extension activity log
```

The API key is stored in pi's own credential store (`auth.json`) — never in a separate file.

### OpenCode

```
~/.local/share/opencode/plugins/plexus/
  models-cache.json            # last-fetched model list (startup cache)
  models-raw.json              # raw API response (diagnostics)
```

The API key is stored in OpenCode's own credential store — never in a separate file.

---

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
  plexus-opencode/      # OpenCode plugin adapter
    src/
      plugin.ts         # Plugin export: config hook, auth handler
      mapper.ts         # PlexusApiModel → OpenCode ConfigModel
      cache.ts          # model cache I/O
      config-store.ts   # resolveConfig, persistToGlobalConfig
      log.ts            # logger via OpenCode SDK
      constants.ts      # provider ID, env var names, timeouts
      url.ts            # URL helpers (trimURL, apiBase, modelsUrl)
      index.ts          # barrel export
    package.json        # npm package manifest
```

`plexus-models` has zero imports from any agent framework. Each host adapter imports it via a relative path.

## Development

After cloning, install dependencies to set up the pre-commit hook:

```sh
bun install
```

The pre-commit hook (via lefthook) rebuilds both dist artifacts automatically whenever source files change. After committing, reload/restart your agent.

To add support for a new host agent, see [AGENTS.md](AGENTS.md).
