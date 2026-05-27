# Agent Guide

## Repo structure

```
packages/
  plexus-models/        # host-agnostic data layer
    src/
      types.ts          # wire types (PlexusApiModel, PlexusModelDescriptor, etc.)
      convert.ts        # model fetching, conversion, compat detection
      index.ts          # barrel export
  plexus-{host}/        # one package per supported agent host
    src/
      extension.ts      # entry point: commands, session refresh, auth flow
      mapper.ts         # PlexusModelDescriptor → host ProviderModelConfig
      config.ts         # base URL / default model config I/O
      cache.ts          # model cache I/O
      log.ts            # append-only log
    build.ts            # bundles src/ + plexus-models into dist/extension.js
    package.json        # declares the host manifest entry point
```

Current host packages:

| Package | Agent |
|---|---|
| `plexus-pi` | [pi](https://github.com/earendil-works/pi) |

## Key invariants

- `plexus-models` has **zero** imports from any host framework. It is plain TypeScript.
- Each host package imports `plexus-models` via a relative path (`../../plexus-models/src/index.ts`), not a package specifier. No build step or workspace resolution required during development.
- All host-framework imports in host packages are `import type` — erased at bundle time, never resolved from disk by the end user.
- `dist/extension.js` is committed to the repo and is what the host agent loads. It is rebuilt automatically by the lefthook pre-commit hook whenever source files change.
- The API key is stored in the host agent's own credential store. It is never written to a separate file or read from an env var at runtime.

## Build

```sh
bun run build
```

This bundles `src/extension.ts` and the `plexus-models` sources into a single `dist/extension.js` for the default host package (`plexus-pi`). Host-framework packages and `node:*` are kept external — the host agent remaps them to its own bundled copies at load time.

`dist/extension.js` is committed to the repo. A lefthook pre-commit hook runs the build automatically whenever source files under any `packages/*/src/` are staged. Run `bun install` once after cloning to install the hook.

## How compat works

`detectOpenAICompletionsCompat(providerName, baseUrl)` in `convert.ts` heuristically detects the upstream provider from the provider name and base URL hostname, and returns a full `OpenAICompletionsCompat`-shaped object.

The Plexus server can also annotate models with `pi_options: { ... }` — a `Record<string, unknown>` of compat overrides. These are stored on `PlexusModelDescriptor.piOptions` and merged in the host mapper **after** the heuristic result, so the server's explicit values always win.

## Auth flow

The auth flow is the responsibility of each host adapter, but the pattern is consistent:

1. User runs `/plexus login` inside the agent.
2. Extension prompts for base URL, API key, and optional default model.
3. Base URL and default model are written to a `config.json` in the agent's data directory.
4. API key is stored in the host agent's own credential store.
5. On every session start, the key is retrieved from the credential store and used to refresh the model list.

## Adding a new host

1. Create `packages/plexus-{host}/`.
2. Write `src/mapper.ts` — translate `PlexusModelDescriptor` to the host's provider model config shape. Import host types as `import type` only.
3. Write `src/extension.ts` — copy `plexus-pi/src/extension.ts`, swap the mapper import and any host-specific API differences (event names, context types, auth API, etc.).
4. Write `src/config.ts`, `src/cache.ts`, `src/log.ts` — copy from `plexus-pi/src/`, replacing the agent directory helper with the equivalent from the new host's framework.
5. Write `package.json` — set the host's manifest field (e.g. `"pi": { "extensions": ["dist/extension.js"] }`) and `files: ["dist/extension.js"]`.
6. Write `build.ts` — copy `plexus-pi/build.ts`, adjusting the externals list for the new host's packages.
7. Import `plexus-models` via relative path: `"../../plexus-models/src/index.ts"`.
8. Update the lefthook `glob` in `lefthook.yml` to include the new package's source files.

## Plexus API shape

The `/v1/models` endpoint returns an OpenRouter-style list. Key fields that drive behavior:

| Field | Effect |
|---|---|
| `preferred_api` | Maps to the canonical API dialect (`openai-completions`, `anthropic-messages`, `google-generative-ai`, `openai-responses`) |
| `supported_parameters` | Presence of `reasoning`, `include_reasoning`, or `reasoning_effort` sets `reasoning: true` |
| `pi_provider` / `pi_model` | Stored as `piProvider` / `piModel` on the descriptor for optional registry lookup by the host |
| `pi_options` | Compat overrides that take precedence over heuristic detection |

Models with a falsy `id` are silently skipped. Missing `architecture` or `pricing` fields fall back to safe defaults.
