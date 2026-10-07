# Context-policy event API

`plexus-pi` publishes the model context limits available through the configured Plexus route on Pi's cross-extension event bus. The API is versioned in its channel names and payloads.

## Channels

Request a snapshot on `plexus:context-policy:request:v1`:

```ts
{ version: 1, requestId: string }
```

Listen for snapshots on `plexus:context-policy:snapshot:v1`:

```ts
interface ContextPolicy {
  provider: string;
  modelId: string;
  maxContextTokens: number;
  shortContextBudgetTokens: number;
  pricingThresholdInputTokens?: number;
}

interface ContextPolicySnapshot {
  version: 1;
  publisherId: string;
  revision: number;
  requestId?: string;
  status: "ready" | "loading" | "unavailable";
  policies: ContextPolicy[];
  fetchedAt?: number;
  cached?: boolean;
  reason?: string;
}
```

The extension validates incoming requests and outgoing snapshots with Zod. Invalid requests are ignored. A valid request gets the current in-memory snapshot immediately, within the request event's `emit()` call. That reply echoes `requestId`; it does not increment the revision or fetch models. Broadcasts have no `requestId`.

## Policy values

- `provider` and `modelId` are the exact identifiers registered with Pi. For this adapter, the provider is `plexus` and the model ID is the Plexus model ID, not its display name.
- `maxContextTokens` comes from the raw model's `context_length`, the total context capacity advertised for that Plexus route. The adapter does not calculate it by adding input and output limits.
- `shortContextBudgetTokens` comes from the first `pricing.tiers[].input_tokens_above` value. Plexus tiering uses that boundary as the intended smaller context budget as well as the pricing transition point.
- `pricingThresholdInputTokens`, when present, reports that same input-pricing boundary. It remains a pricing threshold in its own right; it is not used as the maximum context capacity.
- A model is omitted unless both values are present, positive safe integers, and the tier boundary is no greater than the context capacity. Models without pricing tiers have no known short-context budget and are omitted. A boundary equal to the maximum is valid.
- A pair of policies cannot repeat the same `(provider, modelId)`.

Only raw API models represented in the committed Pi catalog are eligible. Suppressed models and models removed by a refresh disappear from the next complete snapshot. The extension stores the policy metadata and original fetch timestamp with the committed catalog entry so cached catalogs can publish the same values.

## Snapshot status and lifecycle

- At extension initialization, the publisher creates a UUID `publisherId` and starts at revision `1`.
- `loading` has no policies and is used before the catalog state is known.
- `ready` means the catalog loaded successfully. It can contain policies or an empty list if no catalog models qualify.
- `unavailable` has no policies and includes a safe explanation when policy metadata cannot be supplied.
- The publisher increments `revision` when the published state changes. A request/reply alone does not change it.
- `fetchedAt` is the Unix-millisecond time of the last successful `/v1/models` fetch, not publication time. A cached snapshot sets `cached: true` and preserves the original fetch timestamp.
- A failed refresh keeps the last committed snapshot. A stale refresh cannot replace a newer catalog because publication uses Pi's generation-checked `context.publish()` transaction.
- Snapshots are immutable complete replacements, never deltas. Serialized snapshots are capped at 1 MiB. Invalid or oversized state is replaced with a small `unavailable` snapshot, not truncated.
- The request listener is registered during extension initialization and removed on `session_shutdown` using the unsubscribe function returned by `pi.events.on()`.

Snapshots contain policy metadata only. They do not include credentials, URLs, request headers, or raw backend errors.

A control command can select which advertised budget applies for the active session and model; see [policy-control.md](./policy-control.md).
