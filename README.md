# plexus-agent-plugins

Exposes models from a self-hosted [Plexus](https://github.com/mcowger/plexus) AI proxy as a first-class provider inside AI coding agents. Models appear in the agent's model picker with correct wire-protocol behavior, as if they were natively supported providers.

Supported hosts:

- **oh-my-pi** (`can1357/oh-my-pi`) — via `plexus-pi` (the legacy-pi shim handles scope remapping automatically)
- **pi** (`earendil-works/pi`) — via `plexus-pi`

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- A running Plexus instance
- `PLEXUS_API_KEY` set in your environment

```sh
export PLEXUS_API_KEY=your-key-here
```

Add this to your shell profile (`~/.zshrc`, `~/.zprofile`, etc.) so it persists across restarts.

## Installation

### oh-my-pi

```sh
git clone https://github.com/mcowger/plexus-agent-plugins
cd plexus-agent-plugins
bun install
bun run --cwd packages/plexus-pi build.ts
omp plugin link packages/plexus-pi
```

### pi (earendil-works)

```sh
git clone https://github.com/mcowger/plexus-agent-plugins
cd plexus-agent-plugins
bun install
bun run --cwd packages/plexus-pi build.ts
```

Then add the extension path to your pi config, or symlink the package into `~/.pi/extensions/`.

## Usage

On the first run, configure the Plexus base URL:

```
/plexus login
```

You will be prompted for:
- **Plexus base URL** — e.g. `https://plexus.example.com`
- **Default model** (optional)

After login, models appear immediately in the model picker. They also refresh automatically on every new session.

To force a refresh:

```
/plexus refresh
```

## Configuration

| What | How |
|---|---|
| API key | `PLEXUS_API_KEY` environment variable (required) |
| Base URL | Set via `/plexus login`, stored at `~/.{omp,pi}/agent/extensions/plexus/config.json` |
| Default model | Optionally set during `/plexus login` |

Config, cache, and logs are written under the agent's data directory:

```
~/.omp/agent/extensions/plexus/
  config.json                  # base URL and default model
  plexus-models-cache.json     # last-fetched model list
  plexus-models-response.json  # raw API response (diagnostics)
  plexus.log                   # extension activity log
```

## Development

After editing source files, rebuild before changes take effect:

```sh
bun run --cwd packages/plexus-pi build.ts
```

The build bundles `plexus-models` into a single `dist/extension.js`. The `dist/` file is what the agent loads; source files are the single source of truth.

## Package layout

```
packages/
  plexus-models/   # host-agnostic data layer (fetch, parse, cache, config)
  plexus-pi/       # host adapter + extension entry point
```

`plexus-models` has zero imports from any agent framework and can be tested in isolation.
