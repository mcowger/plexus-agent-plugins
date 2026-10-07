# Policy-control event API

`plexus-pi` publishes the context and service-tier advertisement for the committed Plexus catalog (see [context-policy.md](./context-policy.md) and [service-tiers.md](./service-tiers.md)). It also accepts a control command that selects, for the active session and model, which advertised context budget applies and which advertised service tier is active.

The API is versioned in its channel names and payloads.

## Channels and payloads

Send a control command on `plexus:policy:set:v1`:

```ts
interface PolicySet {
  version: 1;
  requestId: string;
  longContext?: boolean;          // at least one of longContext/serviceTier is required
  serviceTier?: string | null;    // null clears the tier
}
```

Listen for a reply or broadcast on `plexus:policy:state:v1`:

```ts
interface PolicyState {
  version: 1;
  publisherId: string;
  revision: number;
  requestId?: string;
  applied: {
    longContext: boolean;
    serviceTier: string | null;
    contextWindow?: number;
  };
  available: {
    longContext: boolean;
    serviceTier: boolean;
  };
  reason?: string;
}
```

The extension validates incoming commands and outgoing state with Zod. Malformed commands are ignored without a reply. Strict objects: unknown keys are rejected.

## Semantics

- The command always applies to the **active session and model** as observed by `plexus-pi`; it carries no model identifier.
- `longContext: true` selects the model's advertised maximum context budget (`maxContextTokens`). `longContext: false` selects the advertised short budget (`shortContextBudgetTokens`).
- `serviceTier` selects one of the model's advertised `serviceTiers`. `serviceTier: null` clears the selection back to the provider default. Omitting the field leaves it unchanged.
- A command must contain at least one of `longContext` or `serviceTier`.
- Defaults for the active model are `longContext: true` (the catalog behavior) and `serviceTier: null`. Nothing changes until a command selects otherwise.
- Selection is in-memory and session-scoped. It never writes the committed catalog or persisted defaults, and it resets on extension reload or when the active model changes.

## Availability

`available` describes what the active model's committed advertisement supports:

- `available.longContext` is `true` only when the model advertises both limits and `shortContextBudgetTokens < maxContextTokens`, so there is a distinct short/max choice.
- `available.serviceTier` is `true` only when the model advertises at least one service tier.

The publisher never fabricates limits or tiers. When the active model has no qualifying advertisement — or the extension version has no policy publisher at all — the host observes `available: { longContext: false, serviceTier: false }` and a safe `reason`, or receives no reply, rather than a defaulted or invented value.

## Validation and rejection

A command is validated against the current advertisement before anything is applied:

- A `longContext` selection is rejected when the model has no context policy, or when the short and maximum budgets are not distinct.
- A non-null `serviceTier` is rejected when the model has no service-tier policy or does not advertise that tier.
- Rejection is atomic: when any field fails validation, no field is applied. No partial application occurs.
- A rejection produces a correlated reply carrying the current state, an unchanged `revision`, and a safe `reason`. It does not broadcast.

## Reply and broadcast rules

The rules match the existing snapshot channels:

- A valid command receives a correlated reply that echoes `requestId`, within the event handler's `emit()` call chain.
- A correlated reply never advances `revision`; only a state change does.
- The `publisherId` is a UUID that is stable for the extension load, and `revision` starts at `1` and increases monotonically.
- When a command changes the published state, the publisher also broadcasts the new state without `requestId`.
- Snapshots are complete immutable replacements, never deltas. Serialized state is capped at 1 MiB; invalid or oversized state becomes a small `unavailable` state with no fabricated values.
- The command listener is installed during extension initialization and removed on `session_shutdown`.

## Visible effect

The selected state takes effect for the active model:

- The selected advertised tier is sent as `service_tier` on requests to the `plexus` provider for that model.
- The selected context mode changes the session's **effective context window** to the short budget or the maximum. This is a session-scoped model override: the committed catalog model and persisted defaults are unchanged, and the override is not persisted.

## Reconciliation

The committed advertisement can change under a running session. On every catalog update (startup, cached restore, live refresh), `plexus-pi` re-evaluates the active model:

- If a refresh removes the context policy or makes the short and maximum budgets identical while the short budget was selected, the selection resets to the maximum and the override is cleared.
- If a refresh lowers the short budget, the new value is re-applied to the effective context window.
- If a refresh removes the selected service tier from the advertisement, the tier selection clears.
- Any resulting change advances `revision` and is broadcast with a safe `reason`.

A refresh that leaves the active model's advertisement unchanged produces no broadcast.
