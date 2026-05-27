# Agent Guide

## Repo structure

```
packages/
  plexus-models/        # host-agnostic data layer
    src/
      types.ts          # wire types (PlexusApiModel, PlexusModelDescriptor, etc.)
      convert.ts        # model fetching, conversion, compat detection
      index.ts          # barrel export
  plexus-pi/            # host adapter for pi (earendil-works/pi)
    src/
      extension.ts      # extension entry point, commands, session refresh, auth flow
      mapper.ts         # PlexusModelDescriptor → pi ProviderModelConfig
      config.ts         # base URL / default model config I/O
      cache.ts          # model cache I/O
      log.ts            # append-only log
    package.json        # declares pi.extensions → src/extension.ts
```

## Key invariants

- `plexus-models` has **zero** imports from `@earendil-works/*` or any host framework. It is plain TypeScript.
- `plexus-pi` imports `plexus-models` via a relative path (`../../plexus-models/src/index.ts`), not a package specifier. No build step or workspace resolution required.
- All host-framework imports in `plexus-pi` are `import type` — erased at load time by jiti, never resolved from disk.
- **There is no build step.** pi loads `src/extension.ts` directly via its jiti-based extension loader.
- The API key is stored in pi's `auth.json` via `ctx.modelRegistry.authStorage`. It is never written to a separate file or read from an env var at runtime.
- `getAgentDir()` (from `@earendil-works/pi-coding-agent`) resolves `PI_CODING_AGENT_DIR` (explicit override) → `~/${PI_CONFIG_DIR || ".pi"}/agent`.

## Build

```sh
bun run build
```

This bundles `src/extension.ts` and the `plexus-models` sources into a single `dist/extension.js`. The `@earendil-works/*` packages and `node:*` are kept external — pi's virtual module shim remaps them to its bundled copies at load time.

`dist/extension.js` is committed to the repo. A lefthook pre-commit hook runs the build automatically whenever source files under `packages/plexus-pi/src/` or `packages/plexus-models/src/` are staged, so the artifact stays in sync without any manual steps. Run `bun install` once after cloning to install the hook.

## How install works

pi discovers extensions by scanning:

1. `<cwd>/.pi/extensions/` — project-local
2. `~/.pi/agent/extensions/` — global
3. Explicit paths listed in `settings.json` under `"extensions"`

For each candidate directory, pi reads `package.json` and looks for a `"pi": { "extensions": [...] }` field, or falls back to `index.ts` / `index.js`. The declared paths are loaded via jiti.

See README.md for the three install methods (npm, git clone into extensions dir, git clone + settings.json path).

## How compat works

`detectOpenAICompletionsCompat(providerName, baseUrl)` in `convert.ts` heuristically detects the upstream provider from the provider name and base URL hostname, and returns a full `OpenAICompletionsCompat`-shaped object.

The Plexus server can also annotate models with `pi_options: { ... }` — a `Record<string, unknown>` of compat overrides. These are stored on `PlexusModelDescriptor.piOptions` and merged in the host mapper **after** the heuristic result, so the server's explicit values always win.

## Auth flow

1. User runs `/plexus login` inside pi.
2. Extension prompts for base URL, API key, and optional default model via `ctx.ui.input`.
3. Base URL is written to `~/.pi/agent/extensions/plexus/config.json`.
4. API key is stored via `ctx.modelRegistry.authStorage.set(PROVIDER_NAME, { type: "api_key", key })` — this writes to pi's `~/.pi/agent/auth.json`.
5. On every `session_start`, the key is retrieved via `ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME)` and used to refresh the model list.

## Adding a new host

1. Create `packages/plexus-{host}/`.
2. Write `src/mapper.ts` — translate `PlexusModelDescriptor` to the host's `ProviderModelConfig` shape. Import host types as `import type` only.
3. Write `src/extension.ts` — copy `plexus-pi/src/extension.ts`, swap the mapper import and any host-specific API differences (event names, context types, auth API, etc.).
4. Write `src/config.ts`, `src/cache.ts`, `src/log.ts` — copy from `plexus-pi/src/`, replacing `getAgentDir()` with the equivalent from the new host's framework.
5. Write `package.json` — set `"<host>": { "extensions": ["src/extension.ts"] }` for the host's manifest field.
6. Write `build.ts` — copy `plexus-pi/build.ts`, adjusting externals for the new host's packages.
7. Import `plexus-models` via relative path: `"../../plexus-models/src/index.ts"`.

## Plexus API shape

The `/v1/models` endpoint returns an OpenRouter-style list. Key fields that drive behavior:

| Field | Effect |
|---|---|
| `preferred_api` | Maps to the canonical API dialect (`openai-completions`, `anthropic-messages`, `google-generative-ai`, `openai-responses`) |
| `supported_parameters` | Presence of `reasoning`, `include_reasoning`, or `reasoning_effort` sets `reasoning: true` |
| `pi_provider` / `pi_model` | Stored as `piProvider` / `piModel` on the descriptor for optional registry lookup by the host |
| `pi_options` | Compat overrides that take precedence over heuristic detection |

Models with a falsy `id` are silently skipped. Missing `architecture` or `pricing` fields fall back to safe defaults.
