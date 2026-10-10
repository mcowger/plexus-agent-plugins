# @mcowger/opencode-plexus

OpenCode V2 plugin that exposes models from a self-hosted [Plexus](https://github.com/mcowger/plexus) AI proxy as a first-class `plexus` provider.

## Install

Add the plugin to `~/.config/opencode/opencode.jsonc` (or a project-level `opencode.jsonc`), either from npm or from a local clone. OpenCode resolves directory plugins via `server.*` / `index.*`, so a local path must point at the package directory, not a file.

```jsonc
{
  "plugins": ["@mcowger/opencode-plexus"]
  // or: ["file:///home/you/code/plexus-agent-plugins/packages/plexus-opencode-v2"]
}
```

Restart the service after changing the plugin or its options, since plugin options are read once at setup:

```sh
opencode service stop && opencode service start
```

Credentials saved through `/connect` and catalog refreshes do not need a restart.

## Configuration

Run `/connect` and pick **Plexus** to store the base URL and API key. The plugin also honors `PLEXUS_API_URL` / `PLEXUS_BASE_URL` and `PLEXUS_API_KEY`, plus per-plugin `options`.

### `apiKeyEnv`

Set `apiKeyEnv` in the plugin's `options` block to select a differently named environment variable for the Plexus API key. The value is the **name** of the variable, not the key and not a `$VAR` template.

```jsonc
{
  "plugins": [
    {
      "package": "@mcowger/opencode-plexus",
      "options": {
        "plexusBaseURL": "https://plexus.example.com",
        "apiKeyEnv": "AIHOME_OPENCODE_API_KEY"
      }
    }
  ]
}
```

Set the named variable in the environment that launches OpenCode:

```sh
export AIHOME_OPENCODE_API_KEY=...
```

### API key precedence

| `apiKeyEnv` omitted (default) | `apiKeyEnv` set |
|---|---|
| `PLEXUS_API_KEY` → saved `/connect` credential → plugin `apiKey` option | only the named environment variable; authoritative over `PLEXUS_API_KEY`, the saved `/connect` credential, and the `apiKey` option |

An explicit `apiKeyEnv` is authoritative even if it names `PLEXUS_API_KEY`. To restore the default chain, remove the option.

### Native login

`/connect` still stores the Plexus base URL and API key normally. With `apiKeyEnv` explicitly set, discovery and model requests use the named environment variable instead of the saved connection key or plugin `apiKey` option. Connecting can still configure the base URL, but entering a different key won't override `apiKeyEnv`. Removing the option restores the default precedence without deleting the saved connection.

If the named variable is missing or empty at startup, the plugin fails to load. Set the variable in the service's environment or remove `apiKeyEnv`, then restart the service; `/connect` cannot repair the environment setting.

### Missing / empty / invalid

When `apiKeyEnv` is set:

- If the named variable is missing, empty, or whitespace-only, the plugin reports an error naming the variable (never its value) and does not fall back to a saved key, `PLEXUS_API_KEY`, or `apiKey`.
- If the value is not a valid environment-variable name (must match `[A-Za-z_][A-Za-z0-9_]*`), the plugin reports a generic invalid-`apiKeyEnv` error without echoing the input.

## Notes

- Until a base URL is configured, the provider shows a single `plexus-unconfigured` placeholder so it stays selectable in `/connect`.
- `/plexus-refresh` forces a live fetch and reloads the provider.
- Plugin logs are written to `~/.local/share/opencode/plugins/plexus/plugin.log` (the OpenCode service discards plugin stdout).

## Session service-tier and context-budget selection

Two slash commands select, per session, which advertised Plexus
`service_tier` is sent on that session's requests and whether the session
budgets against the model's short or maximum context window:

- `/plexus-tier [tier|default|status]` — tier names match the model's
  advertised `service_tiers` verbatim (case-sensitive). `default` clears to
  the provider default; bare or `status` reports the session selection plus
  what the model advertises. Unknown tiers are rejected without changing
  anything.
- `/plexus-context [short|max|status]` — `short` selects the first
  `pricing.tiers[].input_tokens_above` budget, `max` the `context_length`.
  Rejected when the model advertises no distinct short/max pair; bare or
  `status` reports the session selection plus the advertised budget.

Selections are session-scoped: two sessions on the same model can hold
different tier/budget selections without leaking into each other, and
switching a session's model resets its selection. The shared model
definitions are never mutated — the tier is injected as `service_tier` into
the session's outgoing request bodies, and the budget rides the request in
`SessionRequestOptions.plexusContextBudget`. `/plexus-refresh` (and
credential rotation) reconciles selections against the new catalog: a
removed tier clears, an equalized or removed short budget resets to max,
and a lowered short budget is re-applied.
