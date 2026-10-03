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

## Notes

- Model discovery uses pi's `refreshModels` hook. `/plexus refresh` forces a live fetch without changing the model selected for the session.
- `PLEXUS_API_URL` / `PLEXUS_BASE_URL` override the stored base URL, and `PLEXUS_SUPPRESS_MODELS` / `PLEXUS_EXCLUDE_MODELS` suppress models. See the repository README for details.
