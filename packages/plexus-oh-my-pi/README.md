# @mcowger/oh-my-pi-plexus

Oh My Pi extension that exposes models from a self-hosted [Plexus](https://github.com/mcowger/plexus) AI proxy as a first-class `plexus` provider.

## Install

```sh
cd ~/.omp/agent/extensions
npm install @mcowger/oh-my-pi-plexus
```

Restart Oh My Pi after installing or changing extension configuration.

## Setup

1. Run `/login plexus` and enter the Plexus base URL (root URL or a URL ending in `/v1`) and API key.
2. Run `/plexus refresh` to fetch the model list, or let Oh My Pi refresh it automatically.
3. Pick a model with `/model` or `/models`.

`/plexus status` reports the effective base URL, whether auth is available, and the catalog state without exposing credentials.

## Configuration

Non-secret settings live in Oh My Pi's agent directory:

```text
~/.omp/agent/extensions/plexus/config.json
# or <agent-dir>/extensions/plexus/config.json when PI_CODING_AGENT_DIR is set
# or the active profile's agent directory when using OMP_PROFILE / PI_PROFILE
```

Credentials stay in Oh My Pi's credential store (`agent.db`).

### `apiKeyEnv`

By default the extension registers `PLEXUS_API_KEY` as a native config-key override when it is set. OMP resolves that override before saved credentials; when the variable isn't set, it uses the host credential resolver. Set `apiKeyEnv` to the **name** of a different environment variable to use a client-specific key. The value is the variable name, not the key and not a `$VAR` template.

```json
{
	"baseUrl": "https://plexus.example.com",
	"apiKeyEnv": "AIHOME_OMP_API_KEY"
}
```

Then export the named variable in the environment that launches Oh My Pi:

```sh
export AIHOME_OMP_API_KEY=...
omp
```

### API key precedence

| `apiKeyEnv` omitted (default)                               | `apiKeyEnv` set                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| registered `PLEXUS_API_KEY` env override → host credentials | only the named environment variable; authoritative over the stored credential and `PLEXUS_API_KEY` |

An explicit `apiKeyEnv` is authoritative even when it names `PLEXUS_API_KEY`. Saved credentials remain stored; remove `apiKeyEnv` to restore the default precedence.

### Native login

`/login plexus` is available when no environment key override is active. While `apiKeyEnv` or `PLEXUS_API_KEY` supplies a key, the extension omits the login provider so OMP treats that key as authoritative for Messages, Responses, and Chat Completions. Registering both would let saved login credentials replace the environment key on Messages requests. Configure the base URL in `config.json` or through `PLEXUS_API_URL` / `PLEXUS_BASE_URL` while using an environment key.

If the named variable is missing or empty at startup, the extension fails to load. Set the variable in the environment that launches OMP or remove `apiKeyEnv`, then restart; native login cannot repair the environment setting.

### Missing / empty / invalid

When `apiKeyEnv` is set:

- If the named variable is missing, empty, or whitespace-only, the extension reports an error naming the variable (never its value) and does not fall back to a stored credential or `PLEXUS_API_KEY`.
- If the value is not a valid environment-variable name (must match `[A-Za-z_][A-Za-z0-9_]*`), the extension reports a generic invalid-`apiKeyEnv` error without echoing the input.

Environment variables and config are read when Oh My Pi starts. Editing `config.json` or the named variable requires a restart; reloading the extension does not re-read the process environment.

## Decisions judge models

Plexus aliases advertised with `type: decisions` are discovered as OMP judge
models, not chat models. Configure `modelRoles.judge` as `plexus/<alias>` and
use `omp models --kind judge` to list them. Judgments use the Plexus
`/v1/systemone` endpoint and the same credential as chat requests.

After upgrading the extension, restart OMP and run `/plexus refresh` to replace
the cached catalog. The Plexus server must expose the Decisions alias in
`/v1/models` and support `/v1/systemone`.

## Extended context and pricing

After upgrading the extension, restart OMP and run `/plexus refresh` to refresh
the dynamic model catalog. For a model with a Plexus pricing breakpoint below
its advertised context window, OMP normally uses that breakpoint as the window
when extended context is off. Use `/extended-context on`, `/extended-context
off`, or `/extended-context status` to select or inspect the setting. Models
without a breakpoint, or with a smaller provider window, keep their window.
Explicit model window overrides still take precedence. An OMP per-model
compaction threshold beyond the standard window can also opt that model into
its extended window, even when the global toggle is off. Idle compaction is
independent of the extended-context toggle.

This is not a strict billing ceiling: an individual request can jump past the
maintenance threshold, and provider token accounting can differ. OMP supports
one long-context price tier in its cost estimator; if Plexus advertises multiple
tiers, OMP estimates using the first breakpoint and cannot accurately estimate
requests in later tiers. Missing Plexus rates use the existing zero/default
conversion and should not be treated as authoritative prices.

## Notes

- Model discovery runs through the provider's dynamic-model hook. `/plexus refresh` updates the in-memory catalog and rebinds the selected Plexus model to its refreshed metadata without changing the selection; OMP retains its configured thinking selection, including `auto`. If the selected model is no longer advertised, it remains selected until you choose another model.
- `PLEXUS_API_URL` / `PLEXUS_BASE_URL` override the stored base URL, and `PLEXUS_SUPPRESS_MODELS` / `PLEXUS_EXCLUDE_MODELS` suppress models. See the repository README for details.
