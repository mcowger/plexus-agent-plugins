# Agent Guide

## Repo structure

```
packages/
  plexus-models/        # host-agnostic data layer
    src/
      types.ts          # wire types (PlexusApiModel, PlexusModelDescriptor, etc.)
      convert.ts        # model conversion and compat detection
      config.ts         # config file I/O (base URL, default model)
      cache.ts          # model cache I/O
      log.ts            # append-only log
      index.ts          # barrel export
  plexus-pi/            # host adapter for pi / oh-my-pi
    src/
      extension.ts      # extension entry point, commands, session refresh
      mapper.ts         # PlexusModelDescriptor → pi ProviderModelConfig
    build.ts            # Bun bundler script
    dist/
      extension.js      # built artifact (what the agent actually loads)
```

## Key invariants

- `plexus-models` has **zero** imports from `@earendil-works/*` or `@oh-my-pi/*`. All host-framework imports in `plexus-pi` are `import type` — erased at build time.
- `dist/extension.js` is the deployed artifact. It is produced by `build.ts` which bundles `plexus-models` inline and externalises only `node:*` and host packages. **Never edit `dist/` directly.**
- The API key comes exclusively from `process.env["PLEXUS_API_KEY"]`. It is never written to disk.
- `getAgentDir()` resolves `PI_CODING_AGENT_DIR` (explicit override) → `~/${PI_CONFIG_DIR || ".pi"}/agent`. OMP sets `PI_CONFIG_DIR=.omp` so the same code works on both hosts.

## Build

```sh
bun run --cwd packages/plexus-pi build.ts
```

Run this after any source change. The agent reads `dist/extension.js`.

## How compat works

`detectOpenAICompletionsCompat(providerName, baseUrl)` in `convert.ts` heuristically detects the upstream provider from the provider name string and base URL hostname and returns a full `OpenAICompletionsCompat`-shaped object.

The Plexus server can also annotate models with `pi_options: { ... }` — a `Record<string, unknown>` of compat overrides. These are stored on `PlexusModelDescriptor.piOptions` and merged in the host mapper **after** the heuristic result, so the server's explicit values always win.

## Adding a new host

1. Create `packages/plexus-{host}/`.
2. Write `src/mapper.ts` — translate `PlexusModelDescriptor` to the host's `ProviderModelConfig` shape. Import host types as `import type` only.
3. Write `src/extension.ts` — copy `plexus-pi/src/extension.ts`, swap the mapper import and any host-specific API differences.
4. Write `build.ts` — copy `plexus-pi/build.ts`, add any additional externals for the new host's packages.
5. Build and link.

The only parts that vary per host are the mapper (type shapes differ) and the `"extensions"` manifest field name in `package.json` (`"pi"` works for both pi and OMP; add `"omp"` if needed).

## Plexus API shape

The `/v1/models` endpoint returns an OpenRouter-style list. Key fields that drive behavior:

| Field | Effect |
|---|---|
| `preferred_api` | Maps to the canonical API dialect (`openai-completions`, `anthropic-messages`, `google-generative-ai`, `openai-responses`) |
| `supported_parameters` | Presence of `reasoning`, `include_reasoning`, or `reasoning_effort` sets `reasoning: true` |
| `pi_provider` / `pi_model` | Stored as `piProvider` / `piModel` on the descriptor for optional registry lookup by the host |
| `pi_options` | Compat overrides that take precedence over heuristic detection |

Models with a falsy `id` or no `architecture`/`pricing` are silently converted with safe defaults and included — they may not work but they won't crash.
