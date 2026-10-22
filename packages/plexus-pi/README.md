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

| `apiKeyEnv` omitted (default)                            | `apiKeyEnv` set                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
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

## plexuspi-control

The Plexus root session exposes a gated control command, `plexuspi-control`, that the Plexus integration uses to read and change the session's service tier and context budget. It is inert until a request carries the integration session key.

- Environment: `PLEXUSPI_SESSION_KEY`, read when Pi starts. Unset means every request is refused.
- No launch flag. Activation is lazy: the module does nothing until the first request whose `sessionKey` matches `PLEXUSPI_SESSION_KEY`. Control requests arrive only through the root session's RPC prompt dispatch. Child sessions inherit the environment but never receive them, so they never activate. A wrong key is refused and changes nothing.
- Request: `/plexuspi-control <base64url>`, where the decoded JSON is `{ "version": 1, "sessionKey", "requestId", "operation", "data"? }`.

| Operation   | `data`                    | Behavior                                                                                                                                                                             |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hello`     | none                      | Activates the module, returns state. Fails when a known control owner (pi-microgpt's `/fast`, `/flex`, `/long-context`) is declared.                                                 |
| `get-state` | none                      | Returns the current state.                                                                                                                                                           |
| `configure` | `{ tier?, longContext? }` | Applies an advertised tier for the current model (`fast` maps to `priority` when advertised) or a short/max context budget. A failed budget application keeps the previous settings. |
| `rewind`    | `{ targetEntryId }`       | Moves to an active-branch user message without summarizing. Requires an idle agent, no compaction, and no active owned children. Appends a `plexuspi-rewind` branch pin.             |
| `reload`    | none                      | Idle only. Replies `ok` before reloading, so `ok` means started, not finished.                                                                                                       |

Replies are `ctx.ui.notify` messages prefixed `plexuspi:v1:` with JSON `{ version, sessionKey, requestId, operation, ok, data?, error? }`. Live state publishes use `plexuspi:state:v1:` and forwarded owned-subagent records use `plexuspi:child:v1:`.

Bus channels:

- Consumes `plexuspi:subagent:v1` (owned-subagent bridge records, version 1) for active-child counts and forwarding.
- Emits `plexuspi:root:v1` `{ version: 1, sessionId }` once activated.

Branch-local session entries:

- `plexuspi-controls`: `{ version, tier, longContext, contextWindow?, timestamp }`, restored on session start, tree change, and rewind.
- `plexuspi-rewind`: `{ version, targetEntryId, leafId?, timestamp }`.

State fields: `capabilities`, `settings` (`{ tier, longContext }`), `origin` (`"root"`), `tiers`, `tierApplicable`, `longContextAvailable`, `longContextTarget?`, `shortContextBudgetTokens?`, `pricingThresholdInputTokens?`, `modelBaselineContextWindow?`, `contextWindow?`, `activeChildren?`, `sessionId?`, `contextPolicyError?`, `conflicts`, `limitations`. Optional fields are omitted when they cannot be observed.

## Notes

- Model discovery uses pi's `refreshModels` hook. `/plexus refresh` forces a live fetch without changing the model selected for the session.
- `PLEXUS_API_URL` / `PLEXUS_BASE_URL` override the stored base URL, and `PLEXUS_SUPPRESS_MODELS` / `PLEXUS_EXCLUDE_MODELS` suppress models. See the repository README for details.
