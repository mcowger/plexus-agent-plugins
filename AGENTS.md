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
      extension.ts / plugin.ts  # entry point: commands, session refresh, auth flow
      mapper.ts         # Plexus model types → host model config shape
      config.ts / config-store.ts  # base URL / credential config I/O
      cache.ts          # model cache I/O
      log.ts            # logging (host-specific mechanism)
      constants.ts      # provider ID, env var names, timeouts (if needed)
      url.ts            # URL helpers (if needed)
    build.ts            # bundles src/ + plexus-models into dist artifact
    package.json        # declares the host manifest entry point
```

Current host packages:

| Package | Agent | Published as |
|---|---|---|
| `plexus-pi` | [pi](https://github.com/earendil-works/pi) | `@mcowger/pi-plexus` |
| `plexus-opencode` | [OpenCode](https://opencode.ai) | `@mcowger/opencode-plexus` |

## Key invariants

- `plexus-models` has **zero** imports from any host framework. It is plain TypeScript.
- Each host package imports `plexus-models` via a relative path (`../../plexus-models/src/index.ts`), not a package specifier. No build step or workspace resolution required during development.
- Host-framework imports should be `import type` unless runtime metadata/functions are required. Runtime host imports must be listed as `external` in the package `build.ts` so the end user's agent runtime resolves them.
- `dist/` artifacts are committed to the repo and are what the host agent loads. They are rebuilt automatically by the lefthook pre-commit hook whenever source files change.
- The API key is stored in the host agent's own credential store. It is never written to a separate file or read from an env var at runtime (env vars are supported as an override, but not the primary storage).
- Both adapters recognize `PLEXUS_API_URL` and `PLEXUS_BASE_URL` for the Plexus URL; `PLEXUS_API_URL` wins when both are set. Both recognize `PLEXUS_API_KEY` for the API key.
- Configured string values may use pi-style `$VAR` or `${VAR}` interpolation. Missing referenced env vars make that config value unavailable rather than treating the template literally.

## Build

```sh
bun run build
```

This bundles both host packages. Each `build.ts` produces a single output file that inlines `plexus-models` and keeps the host framework and `node:*` external.

`dist/` artifacts are committed. A lefthook pre-commit hook runs the build automatically whenever source files under any `packages/*/src/` are staged. Run `bun install` once after cloning to install the hook.

## Release and publishing

Publishing is automated by `.github/workflows/publish.yaml` and is triggered by pushing a `v*` Git tag. **Never run `npm publish` manually.**

To release, use the release script with the desired semantic version:

```sh
bun scripts/release.ts 1.2.3
```

The script requires a clean `main` branch, pulls the latest `origin/main`, synchronizes package versions, creates the release commit and annotated `v1.2.3` tag, and pushes both. The pushed tag triggers GitHub Actions, which builds and publishes all plugin packages to npm using trusted publishing.

## How compat works (plexus-pi)

`detectOpenAICompletionsCompat(providerName, baseUrl)` in `convert.ts` heuristically detects the upstream provider from the provider name and base URL hostname, and returns a full `OpenAICompletionsCompat`-shaped object.

The pi mapper resolves compat in this order:

1. Heuristic detection using `pi_provider` when present, otherwise `plexus` plus the model base URL.
2. Built-in pi metadata from `pi_provider` / `pi_model` when present.
3. Plexus server overrides from `pi_options`.

`pi_options` are stored on `PlexusModelDescriptor.piOptions` and merged last, so the server's explicit values always win. When `pi_provider` / `pi_model` resolve to a built-in pi model, the mapper also copies `thinkingLevelMap` and `headers` from that built-in model.

## How model refresh works (plexus-opencode)

The OpenCode plugin seeds `cfg.provider.plexus.models` from the on-disk cache or a placeholder model so the provider survives startup and appears in `/connect` before the user has configured it.

Live discovery runs through OpenCode's `provider.models` hook. The hook reads the Plexus base URL from native auth metadata (falling back to env/config), fetches Plexus models with a short inline budget, falls back to cache if Plexus is slow or unavailable, and lets an in-flight refresh finish in the background. The mapper emits model-level provider overrides so each Plexus model can use the API package implied by `preferred_api`.

## Auth flow

The auth flow is the responsibility of each host adapter, but the pattern is consistent:

1. User triggers the login flow (e.g. `/login plexus` in pi, `/connect` in OpenCode).
2. Extension/plugin prompts for base URL and API key.
3. Base URL is accepted as either the Plexus root or `/v1` API base, then stored as the canonical root URL in the agent's native config/auth metadata store.
4. API key is stored in the host agent's own credential store.
5. On every session start or provider-model hook invocation, the key is retrieved and used to refresh the model list.

The pi adapter registers a native pi login provider so `/login plexus` prompts for the Plexus URL and API key through pi's standard login UI.

## Adding a new host

1. Create `packages/plexus-{host}/`.
2. Write `src/mapper.ts` — translate `PlexusApiModel` (from `plexus-models`) to the host's model config shape. Import host types as `import type` only.
3. Write `src/plugin.ts` (or `extension.ts`) — wire up the host's plugin/extension API. Use `fetchPlexusModels` from `plexus-models` for the HTTP call; call your mapper to produce host-compatible model objects.
4. Write `src/cache.ts`, `src/log.ts`, and any config helpers — use the host's own APIs for file paths and credential storage. Copy from an existing host adapter and replace host-specific helpers.
5. Write `package.json` — set the host's manifest field and `files`. Add `@opencode-ai/plugin` / `@earendil-works/*` etc. as `dependencies` or `peerDependencies` as required by the host.
6. Write `build.ts` — copy from an existing host adapter, adjusting the externals list for the new host's packages.
7. Import `plexus-models` via relative path: `"../../plexus-models/src/index.ts"`.
8. Update `scripts/sync-versions.ts` (`PACKAGES` array) to include the new package.
9. Update `scripts/release.ts` to stage the new `package.json` in the release commit.
10. Update `.github/workflows/publish.yaml` to add a publish step for the new package.
11. The lefthook `glob` (`packages/*/src/*.ts`) already covers the new package automatically.

## Plexus API shape

The `/v1/models` endpoint returns an OpenRouter-style list. Key fields that drive behavior:

| Field | Effect |
|---|---|
| `preferred_api` | String or array. First recognized value maps to the canonical API dialect (`openai-completions`, `anthropic-messages`, `google-generative-ai`, `openai-responses`) |
| `supported_parameters` | Presence of `reasoning`, `include_reasoning`, or `reasoning_effort` sets `reasoning: true` |
| `pricing.tiers` | Alternate per-token rates above `input_tokens_above`; mapped to pi `cost.tiers` and OpenCode runtime context tiers |
| `pi_provider` / `pi_model` | Stored as `piProvider` / `piModel`; pi uses them for built-in model metadata lookup and better compat heuristics |
| `pi_options` | Compat overrides that take precedence over heuristic and built-in detection (pi adapter only) |

Models with a falsy `id` are silently skipped. Missing `architecture` or `pricing` fields fall back to safe defaults.
