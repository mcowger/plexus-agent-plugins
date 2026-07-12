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

Run inside pi using the native login flow:

```
/login plexus
```

You will be prompted for:

- **Plexus base URL** — e.g. `https://plexus.example.com`
- **Plexus API key**
- **Default model** (optional)

To force a model refresh:

```
/plexus refresh
```

Use `/login plexus` for setup and `/logout plexus` to remove stored credentials.

### OpenCode

Run inside OpenCode:

```
/connect
```

Select **Plexus** and enter your base URL and API key. OpenCode has no live model-discovery hook for custom providers, so the model list is seeded from the on-disk cache at startup. Run `/plexus-refresh` to force a live fetch from Plexus and rewrite the cache, then restart OpenCode to pick up the refreshed list:

```
/plexus-refresh
```

You may enter either the Plexus root URL or the `/v1` API base URL:

```text
https://plexus.example.com
https://plexus.example.com/v1
```

The plugins normalize either form to the Plexus root URL for storage and derive `/v1` paths when calling the API.

OpenCode stores the API key in its native auth store and stores the Plexus base URL as auth metadata on that connection. Existing `provider.plexus.options.plexusBaseURL` config is still honored as a fallback.

The OpenCode plugin respects each model's `preferred_api` value and routes models through the matching SDK/API shape:

- `chat_completions` / `openai-completions` → OpenAI-compatible chat completions
- `responses` / `openai-responses` → OpenAI Responses API
- `messages` / `anthropic-messages` → Anthropic Messages API
- `gemini` / `google-generative-ai` → Google Gemini API

You can also pre-configure via environment variables:

```sh
export PLEXUS_API_URL=https://plexus.example.com
export PLEXUS_API_KEY=your-api-key
```

`PLEXUS_BASE_URL` is also accepted for compatibility; `PLEXUS_API_URL` wins when both are set.

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

The API key is stored through pi's own auth storage. `PLEXUS_API_URL` or `PLEXUS_BASE_URL` can be used as an environment override.

### OpenCode

```
~/.local/share/opencode/plugins/plexus/
  models-cache.json            # last-fetched model list (startup cache)
  models-raw.json              # raw API response (diagnostics)
```

The API key is stored through OpenCode's auth flow, and the Plexus base URL is stored as auth metadata. `PLEXUS_API_URL`, `PLEXUS_BASE_URL`, and `PLEXUS_API_KEY` can be used as environment overrides.

Both adapters also accept pi-style environment interpolation in configured strings, such as `${PLEXUS_API_URL}` or `$PLEXUS_API_KEY`. This is useful when checking non-secret config into an agent config file while keeping the actual values in the environment.

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
      plugin.ts         # Plugin export: config hook, provider hook, auth handler
      mapper.ts         # PlexusApiModel → OpenCode ConfigModel
      cache.ts          # model cache I/O
      config-store.ts   # resolveConfig, readStoredAuth
      log.ts            # logger via OpenCode SDK
      constants.ts      # provider ID, env var names, timeouts
      url.ts            # URL helpers (trimURL, apiBase, modelsUrl)
      index.ts          # barrel export
    package.json        # npm package manifest
```

`plexus-models` has zero imports from any agent framework. Each host adapter imports it via a relative path.

## Plexus model metadata

The `/v1/models` endpoint returns an OpenRouter-style list. These fields drive host behavior:

| Field | Effect |
|---|---|
| `preferred_api` | String or array. First recognized value selects the host API dialect. |
| `supported_parameters` | `reasoning`, `include_reasoning`, or `reasoning_effort` enables reasoning support. |
| `architecture.input_modalities` | Enables text/image/audio/video/pdf support where the host supports it. |
| `architecture.output_modalities` | Non-text-only output models are filtered from OpenCode chat providers. |
| `pricing` | Converted into host per-million-token cost metadata. Plexus returns per-token prices. |
| `pricing.tiers` | Alternate rates above `input_tokens_above`; mapped to native pi and OpenCode context pricing tiers. |
| `top_provider` | Supplies context and output token limits when present. |
| `pi_provider` / `pi_model` | Lets the pi adapter reuse built-in pi compat, headers, and thinking-level metadata. |
| `pi_options` | pi compat overrides. These win over heuristic and built-in metadata. |

Models with a falsy `id` are skipped. Missing metadata falls back to safe defaults.

## Adapter behavior

- **pi** refreshes on session start and through `/plexus refresh`. It accepts either root URLs or URLs ending in `/v1` and normalizes them before calling Plexus.
- **OpenCode** seeds the provider from the on-disk cache (or a placeholder model) once, during config loading — OpenCode's `provider.models` hook never fires for custom providers, so there is no live discovery at startup. Run `/plexus-refresh` to force a live fetch and rewrite the cache; because OpenCode has no way to hot-reload a custom provider's model list mid-session, a restart is required afterward to see the refreshed models in the picker.
- OpenCode models retain their upstream model ID, SDK dialect, release date, and reasoning metadata so OpenCode can generate its native GPT, Claude, Gemini, and OpenAI-compatible variants and apply its current request transforms. DeepSeek models also preserve `reasoning_content` across tool-call turns.
- OpenCode uses a 250K-token context window when Plexus supplies no context metadata; its output fallback remains 20% of that window.
- Both adapters convert Plexus's per-token base and tier rates to the per-million-token units expected by their host.

## Development

After cloning, install dependencies to set up the pre-commit hook:

```sh
bun install
```

The pre-commit hook (via lefthook) rebuilds both dist artifacts automatically whenever source files change. After committing, reload/restart your agent.

To add support for a new host agent, see [AGENTS.md](AGENTS.md).
