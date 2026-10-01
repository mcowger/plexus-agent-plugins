# plexus-agent-plugins

Exposes models from a self-hosted [Plexus](https://github.com/mcowger/plexus) AI proxy as a first-class provider inside AI coding agents. Models appear in the agent's model picker with correct wire-protocol behavior, as if they were natively supported providers.

## Supported agents

| Package | Agent | npm |
|---|---|---|
| `plexus-pi` | [pi](https://github.com/earendil-works/pi) | `@mcowger/pi-plexus` |
| `plexus-oh-my-pi` | [Oh My Pi](https://github.com/can1357/oh-my-pi) | `@mcowger/oh-my-pi-plexus` |
| `plexus-opencode-v2` | [OpenCode](https://github.com/anomalyco/opencode) V2 | `@mcowger/opencode-plexus` |

## Prerequisites

- A running Plexus instance
- pi 0.85.1 or later (for `plexus-pi`)
- OpenCode V2 (for `plexus-opencode-v2`)

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

### OpenCode (V2)

Add the plugin to `~/.config/opencode/opencode.jsonc`, either from npm or from a local clone (local plugins must point at the package directory, not a file):

```jsonc
{
  "plugins": ["@mcowger/opencode-plexus"]
  // or: ["file:///home/you/code/plexus-agent-plugins/packages/plexus-opencode-v2"]
}
```

If you use `experimental.policies` to restrict providers, policies are last-match-wins — put the `plexus` allow **after** any `"*"` deny:

```jsonc
"policies": [
  { "action": "provider.use", "resource": "*", "effect": "deny" },
  { "action": "provider.use", "resource": "plexus", "effect": "allow" }
]
```

Restart the service (`opencode service stop && opencode service start`) after changing plugins.

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

Inspect the effective URL, authentication availability, and catalog source without exposing a credential:

```
/plexus status
```

Choose the per-session OpenAI service tier:

```
/service-tier fast
```

Tiers are `default` (aliases `off`, `none`), `fast` (alias `priority`), `flex`, and `ultrafast`; `/service-tier status` reports the active tier and whether the current model supports it. Eligibility follows OpenAI's per-tier model support: `priority` covers the Fast-mode set (GPT-5 and newer, GPT-4.1+, GPT-4o, and o3/o4-mini), while `flex` and `ultrafast` are limited to their documented models. The tier is injected as `service_tier` only for eligible Plexus models and resets to `default` on every session start. `/plexus-service-tier` is an alias for the same command.

Select a Plexus model in `/model`. Save its startup default with the host's normal model-picker action; Plexus does not maintain a separate default-model setting.

Use `/login plexus` for setup and `/logout plexus` to remove stored credentials.

### Oh My Pi

Run inside Oh My Pi using the native login flow:

```
/login plexus
```

Same prompts and `/plexus refresh` / `/plexus status` commands as pi (see above). Save the selected startup model through OMP's normal `/model` or `/models` flow.

### OpenCode (V2)

Run `/connect` and pick **Plexus**. You will be prompted for the Plexus base URL and API key; models load immediately — no restart needed. Disconnecting, reconnecting, or rotating the key also reloads the model list.

To force a model refresh:

```
/plexus-refresh
```

`PLEXUS_API_URL` / `PLEXUS_BASE_URL` / `PLEXUS_API_KEY` env vars and plugin options (`plexusBaseURL`, `suppressModels`) are also honored. Until a URL is configured, the provider shows a single `plexus-unconfigured` placeholder. Plugin logs are written to `~/.local/share/opencode/plugins/plexus/plugin.log` (the OpenCode service discards plugin stdout).

## Configuration files

### Connection state

Each adapter stores only non-secret Plexus settings in its own `config.json`:

```text
<agent-dir>/extensions/plexus/config.json  # base URL and optional model suppression
```

Credentials stay in the host credential store (`auth.json` for Pi, `agent.db` for OMP). Model catalogs stay in the host model registry/store. The extension no longer writes a second model cache, ETag file, raw API response, or default-model preference.

At runtime, configuration resolves as follows:

```text
base URL: PLEXUS_API_URL → PLEXUS_BASE_URL → saved Plexus base URL
API key: host credential store → PLEXUS_API_KEY process fallback
catalog: host model store → live Plexus refresh
startup model: host model-picker preference
```

`PLEXUS_API_URL` and `PLEXUS_BASE_URL` are process-only URL overrides; `PLEXUS_API_KEY` is a process-only credential fallback. None are persisted. `/plexus status` reports the effective URL source, whether auth is available, and catalog state without exposing credentials.

Plexus accepts a root URL or a `/v1` API URL. The adapter normalizes that only for the Plexus discovery request. Each model then receives its own API-specific base URL: OpenAI stays on `/v1`, Anthropic uses the root, and Google uses `/v1beta`.

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
      config.ts         # base URL / suppression config I/O
      cache.ts          # Pi native model-store restore
      log.ts            # append-only log
    package.json        # declares pi.extensions entry point
  plexus-oh-my-pi/      # Oh My Pi host adapter (fork of pi; own runtime packages + catalog)
    src/
      extension.ts      # entry point: commands, session refresh, auth flow
      mapper.ts         # PlexusModelDescriptor → Oh My Pi ProviderModelConfig
      config.ts         # base URL / suppression config I/O
      log.ts            # append-only log
    package.json        # declares omp.extensions entry point
  plexus-opencode-v2/   # OpenCode V2 provider plugin
    src/
      plugin.ts         # entry point: provider/integration transforms, /plexus-refresh, credential watcher
      mapper.ts         # PlexusModelDescriptor → OpenCode Model.Info
      config-store.ts   # base URL / API key / suppression resolution
      cache.ts          # model cache I/O
      log.ts            # console + file log
    server.js           # root entrypoint required by OpenCode for directory plugins
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

`packages/deprecated/plexus-opencode` (the OpenCode V1 adapter) is preserved for reference but is archived. It is private and excluded from builds, tests, hooks, version sync, and publishing. It is superseded by `plexus-opencode-v2`.

To add support for a new host agent, see [AGENTS.md](AGENTS.md).
