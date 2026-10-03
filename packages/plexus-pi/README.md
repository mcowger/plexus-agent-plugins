# @mcowger/pi-plexus

pi extension that exposes models from a self-hosted [Plexus](https://github.com/mcowger/plexus) AI proxy as a first-class `plexus` provider.

## Install

```sh
cd ~/.pi/agent/extensions
npm install @mcowger/pi-plexus
```

Restart pi after installing or changing extension configuration.

## Setup

1. Run `/login plexus` and enter the Plexus base URL (root URL or a URL ending in `/v1`) and API key.
2. Run `/plexus refresh` to fetch the model list, or let pi refresh it automatically.
3. Pick a model with `/model`.

`/plexus status` reports the effective base URL, whether auth is available, and the catalog state without exposing credentials.

## Configuration

Non-secret settings live in pi's agent directory:

```text
~/.pi/agent/extensions/plexus/config.json
# or <agent-dir>/extensions/plexus/config.json when PI_CODING_AGENT_DIR is set
```

Credentials stay in pi's credential store (`auth.json`).

### `apiKeyEnv`

By default the extension reads the Plexus key from `PLEXUS_API_KEY` after checking pi's stored credential. Set `apiKeyEnv` to the **name** of a different environment variable to use a client-specific key. The value is the variable name, not the key and not a `$VAR` template.

```json
{
  "baseUrl": "https://plexus.example.com",
  "apiKeyEnv": "AIHOME_PI_API_KEY"
}
```

Then export the named variable in the environment that launches pi:

```sh
export AIHOME_PI_API_KEY=...
pi
```

### API key precedence

| `apiKeyEnv` omitted (default) | `apiKeyEnv` set |
|---|---|
| stored pi credential → `PLEXUS_API_KEY` process fallback | only the named environment variable; authoritative over the stored credential and `PLEXUS_API_KEY` |

An explicit `apiKeyEnv` is authoritative even when it names `PLEXUS_API_KEY`. Saved credentials remain stored; remove `apiKeyEnv` to restore the default precedence.

### Native login

`/login plexus` still prompts for the base URL and API key and saves them normally. With `apiKeyEnv` explicitly set, discovery and model requests use the named environment variable instead of the saved key. Login can still configure the base URL, but entering a different key won't override `apiKeyEnv`.

If the named variable is missing or empty at startup, the extension fails to load. Set the variable in the environment that launches pi or remove `apiKeyEnv`, then restart; native login cannot repair the environment setting.

### Missing / empty / invalid

When `apiKeyEnv` is set:

- If the named variable is missing, empty, or whitespace-only, the extension reports an error naming the variable (never its value) and does not fall back to a stored credential or `PLEXUS_API_KEY`.
- If the value is not a valid environment-variable name (must match `[A-Za-z_][A-Za-z0-9_]*`), the extension reports a generic invalid-`apiKeyEnv` error without echoing the input.

Environment variables and config are read when pi starts. Editing `config.json` or the named variable requires a restart; `/reload` reloads the extension but the process environment is unchanged.

## Cross-extension context-policy API

Full channel, payload, mapping, and lifecycle details are in [context-policy.md](./context-policy.md) and [service-tiers.md](./service-tiers.md).

The extension publishes complete context-policy snapshots on Pi's public cross-extension event bus:

- Request: `plexus:context-policy:request:v1` — `{ version: 1, requestId: string }`
- Reply/broadcast: `plexus:context-policy:snapshot:v1` — `{ version: 1, publisherId, revision, requestId?, status, policies, fetchedAt?, cached?, reason? }`

A request listener is installed at extension initialization. Valid requests receive the current in-memory snapshot synchronously during the event emission; requests never initiate or wait for a network fetch. Replies echo `requestId` and do not advance `revision`. Initial state is `loading`; catalog state changes advance the revision (publisher UUID is stable for the extension load). Listeners are removed on `session_shutdown`.

`status` is `ready`, `loading`, or `unavailable`. Non-ready snapshots have no policies; a successfully loaded catalog with no eligible models can use `ready` and an empty list. Each policy has exact registered `provider` and `modelId` identifiers, total route-usable `maxContextTokens`, smaller-or-equal `shortContextBudgetTokens`, and optional input-pricing boundary `pricingThresholdInputTokens`. All token counts are positive safe integers. For models with a valid pricing tier, the extension uses `context_length` as total context capacity and the first `pricing.tiers[].input_tokens_above` boundary as both the intended short-context budget and `pricingThresholdInputTokens`, per the configured Plexus tiering semantics. Models without both known limits, or whose tier boundary exceeds context capacity, are omitted. Snapshots replace the complete prior set, are validated, and are limited to 1 MiB; oversized/invalid data is replaced with an `unavailable` response rather than truncated. `fetchedAt` is the successful backend-fetch time; cached metadata is marked `cached: true`.

Policy metadata is derived from the raw `/v1/models` response only for models in the committed Pi catalog, then stored alongside those model entries so cached catalogs retain the same policy and original fetch timestamp. Suppressed or removed models disappear on the next committed publication.

The parallel service-tier API publishes the model's `service_tiers` array on `plexus:service-tiers:snapshot:v1`. Models without that field have no tier policy. See [service-tiers.md](./service-tiers.md) for the contract.

## Notes

- Model discovery uses pi's `refreshModels` hook. `/plexus refresh` forces a live fetch without changing the model selected for the session.
- `PLEXUS_API_URL` / `PLEXUS_BASE_URL` override the stored base URL, and `PLEXUS_SUPPRESS_MODELS` / `PLEXUS_EXCLUDE_MODELS` suppress models. See the repository README for details.
