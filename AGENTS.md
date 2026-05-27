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
- All host-framework imports in host packages are `import type` — erased at bundle time, never resolved from disk by the end user.
- `dist/` artifacts are committed to the repo and are what the host agent loads. They are rebuilt automatically by the lefthook pre-commit hook whenever source files change.
- The API key is stored in the host agent's own credential store. It is never written to a separate file or read from an env var at runtime (env vars are supported as an override, but not the primary storage).

## Build

```sh
bun run build
```

This bundles both host packages. Each `build.ts` produces a single output file that inlines `plexus-models` and keeps the host framework and `node:*` external.

`dist/` artifacts are committed. A lefthook pre-commit hook runs the build automatically whenever source files under any `packages/*/src/` are staged. Run `bun install` once after cloning to install the hook.

## How compat works (plexus-pi)

`detectOpenAICompletionsCompat(providerName, baseUrl)` in `convert.ts` heuristically detects the upstream provider from the provider name and base URL hostname, and returns a full `OpenAICompletionsCompat`-shaped object.

The Plexus server can also annotate models with `pi_options: { ... }` — a `Record<string, unknown>` of compat overrides. These are stored on `PlexusModelDescriptor.piOptions` and merged in the host mapper **after** the heuristic result, so the server's explicit values always win.

## Auth flow

The auth flow is the responsibility of each host adapter, but the pattern is consistent:

1. User triggers the login flow (e.g. `/plexus login` in pi, `/connect` in OpenCode).
2. Extension/plugin prompts for base URL and API key.
3. Base URL is stored in the agent's config store.
4. API key is stored in the host agent's own credential store.
5. On every session start (or config hook invocation), the key is retrieved from the credential store and used to refresh the model list.

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
| `preferred_api` | Maps to the canonical API dialect (`openai-completions`, `anthropic-messages`, `google-generative-ai`, `openai-responses`) |
| `supported_parameters` | Presence of `reasoning`, `include_reasoning`, or `reasoning_effort` sets `reasoning: true` |
| `pi_provider` / `pi_model` | Stored as `piProvider` / `piModel` on the descriptor for optional registry lookup by the host |
| `pi_options` | Compat overrides that take precedence over heuristic detection (pi adapter only) |

Models with a falsy `id` are silently skipped. Missing `architecture` or `pricing` fields fall back to safe defaults.
