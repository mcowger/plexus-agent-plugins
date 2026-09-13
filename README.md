# plexus-agent-plugins

Exposes models from a self-hosted [Plexus](https://github.com/mcowger/plexus) AI proxy as a first-class provider inside AI coding agents. Models appear in the agent's model picker with correct wire-protocol behavior, as if they were natively supported providers.

## Supported agents

| Package | Agent | npm |
|---|---|---|
| `plexus-pi` | [pi](https://github.com/earendil-works/pi) | `@mcowger/pi-plexus` |
| `plexus-oh-my-pi` | [Oh My Pi](https://github.com/can1357/oh-my-pi) | `@mcowger/oh-my-pi-plexus` |

## Prerequisites

- A running Plexus instance
- pi 0.81.0 or later (for `plexus-pi`)

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

### Oh My Pi

Oh My Pi is a fork of pi and is **not** wire-compatible with `plexus-pi` in every respect (different runtime packages, extension manifest field, and built-in model registry — see [AGENTS.md](AGENTS.md)), so it has its own adapter package.

#### Option 1 — npm (recommended)

```sh
cd ~/.omp/agent/extensions
npm install @mcowger/oh-my-pi-plexus
```

#### Option 2 — git clone into the extensions directory

```sh
git clone https://github.com/mcowger/plexus-agent-plugins ~/.omp/agent/extensions/plexus-agent-plugins
```

#### Option 3 — git clone anywhere + settings.json

```sh
git clone https://github.com/mcowger/plexus-agent-plugins ~/code/plexus-agent-plugins
```

Then register the path in `~/.omp/agent/settings.json`:

```json
{
  "extensions": [
    "~/code/plexus-agent-plugins/packages/plexus-oh-my-pi"
  ]
}
```

---

## First-time setup

### pi

Run inside pi using the native login flow:

```
/login plexus
```

You will be prompted for:

- **Plexus base URL** — e.g. `https://plexus.example.com`
- **Plexus API key**

To force a model refresh:

```
/plexus refresh
```

Select a Plexus model explicitly for the current session. With no model ID, Pi opens a selector; you can also pass the exact Plexus model ID directly. This explicit choice is not applied automatically when starting a new session:

```
/plexus set-default-model
/plexus set-default-model claude-sonnet-4-5
```

Use `/login plexus` for setup and `/logout plexus` to remove stored credentials.

### Oh My Pi

Run inside Oh My Pi using the native login flow:

```
/login plexus
```

Same prompts and `/plexus refresh` / `/plexus set-default-model` commands as pi (see above) — `plexus-oh-my-pi` mirrors the pi adapter's behavior, adjusted for Oh My Pi's own runtime packages and built-in model registry.

## Configuration files

### pi

```
~/.pi/agent/extensions/plexus/
  config.json                  # base URL and model preference metadata
  plexus-models-cache.json     # last-fetched model list (startup cache)
  plexus-models-response.json  # raw API response (diagnostics)
  plexus.log                   # extension activity log
```

The API key is stored through pi's own auth storage. `PLEXUS_API_URL` or `PLEXUS_BASE_URL` can be used as an environment override.

### Oh My Pi

```
~/.omp/agent/extensions/plexus/
  config.json                  # base URL and model preference metadata
  plexus-models-cache.json     # last-fetched model list (startup cache)
  plexus-models-response.json  # raw API response (diagnostics)
  plexus.log                   # extension activity log
```

Same layout as pi, rooted under `~/.omp/agent` instead of `~/.pi/agent` since Oh My Pi resolves its own agent directory.

Both adapters also accept pi-style environment interpolation in configured strings, such as `${PLEXUS_API_URL}` or `$PLEXUS_API_KEY`. This is useful when checking non-secret config into an agent config file while keeping the actual values in the environment.

---

## Model suppression

All plugin packages support suppressing models by name or pattern so undesired models do not appear in model selectors or cache restored lists.

### Pattern matching syntax

- **Exact match** (case-insensitive): Matches model `id`, `name`, or short ID (suffix after `/` or `:`). Example: `"gpt-4o"`, `"Claude 3.5 Sonnet"`.
- **Glob wildcards**: Supports `*` (0+ characters) and `?` (1 character). Example: `"gpt-3.5*"`, `"*deprecated*"`, `"anthropic/*"`.
- **Regex patterns**: Prefix with `regex:`. Example: `"regex:^gpt-[34]"`.

### Configuration methods

- **Environment variables**:
  ```sh
  export PLEXUS_SUPPRESS_MODELS="gpt-3.5*, *deprecated*, whisper"
  ```
  `PLEXUS_EXCLUDE_MODELS` is also accepted. Values can be comma-, semicolon-, or newline-separated.

- **pi / Oh My Pi config**: Add `suppressModels` (or `suppress`) to `config.json`:
  ```json
  {
    "baseUrl": "https://plexus.example.com",
    "suppressModels": ["gpt-3.5*", "*deprecated*"]
  }
  ```

---

## Package layout

```
packages/
  plexus-models/        # host-agnostic data layer
    src/
      types.ts          # wire types (PlexusApiModel, PlexusModelDescriptor, etc.)
      convert.ts        # model fetching, conversion, compat detection
      suppress.ts       # model pattern suppression / exclusion matching
      index.ts          # barrel export
  plexus-pi/            # pi host adapter
    src/
      extension.ts      # entry point: commands, session refresh, auth flow
      mapper.ts         # PlexusModelDescriptor → pi ProviderModelConfig
      config.ts         # base URL / default model config I/O
      cache.ts          # model cache I/O
      log.ts            # append-only log
    package.json        # declares pi.extensions entry point
  plexus-oh-my-pi/      # Oh My Pi host adapter (fork of pi; own runtime packages + catalog)
    src/
      extension.ts      # entry point: commands, session refresh, auth flow
      mapper.ts         # PlexusModelDescriptor → Oh My Pi ProviderModelConfig
      config.ts         # base URL / default model config I/O
      cache.ts          # model cache I/O
      log.ts            # append-only log
    package.json        # declares omp.extensions entry point
```

`plexus-models` has zero imports from any agent framework. Each host adapter imports it via a relative path.

## Plexus model metadata

The `/v1/models` endpoint returns an OpenRouter-style list. These fields drive host behavior:

| Field | Effect |
|---|---|
| `preferred_api` | String or array. First recognized value selects the host API dialect. |
| `supported_parameters` | `reasoning`, `include_reasoning`, or `reasoning_effort` enables reasoning support. |
| `architecture.input_modalities` | Enables text/image/audio/video/pdf support where the host supports it. |
| `pricing` | Converted into host per-million-token cost metadata. Plexus returns per-token prices. |
| `pricing.tiers` | Alternate rates above `input_tokens_above`; mapped to native pi context pricing tiers. |
| `top_provider` | Supplies context and output token limits when present. |
| `pi_provider` / `pi_model` | Lets the pi adapter reuse built-in pi compat, headers, and thinking-level metadata. |
| `pi_options` | pi compat overrides. These win over heuristic and built-in metadata. |

Models with a falsy `id` are skipped. Missing metadata falls back to safe defaults.

## Adapter behavior

- **pi** refreshes on session start and through `/plexus refresh`, without changing the model selected for the session. It accepts either root URLs or URLs ending in `/v1` and normalizes them before calling Plexus.
- The active adapters convert Plexus's per-token base and tier rates to the per-million-token units expected by their host.

## Development

After cloning, install dependencies to set up the pre-commit hook:

```sh
bun install
```

The pre-commit hook (via lefthook) rebuilds the active dist artifacts automatically whenever source files change. After committing, reload/restart your agent.

## Archived adapters

`packages/deprecated/plexus-opencode` is preserved for reference but is archived. It is private and excluded from builds, tests, hooks, version sync, and publishing. In my testing, OpenCode was notably slower and less token-efficient than pi and Oh My Pi.

To add support for a new host agent, see [AGENTS.md](AGENTS.md).
