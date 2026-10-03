# Service-tier event API

`plexus-pi` publishes the advertised service tiers for models in the committed Plexus catalog over Pi's cross-extension event bus.

## Channels and payloads

Request a snapshot on `plexus:service-tiers:request:v1`:

```ts
{ version: 1, requestId: string }
```

Listen for a reply or broadcast on `plexus:service-tiers:snapshot:v1`:

```ts
interface ServiceTierPolicy {
  provider: string;
  modelId: string;
  serviceTiers: string[];
}

interface ServiceTiersSnapshot {
  version: 1;
  publisherId: string;
  revision: number;
  requestId?: string;
  status: "ready" | "loading" | "unavailable";
  policies: ServiceTierPolicy[];
  fetchedAt?: number;
  cached?: boolean;
  reason?: string;
}
```

Incoming requests and outgoing snapshots are validated with Zod. Invalid requests are ignored without logging their payload. A valid request receives the current in-memory snapshot synchronously during `pi.events.emit()` and echoes `requestId`; it never starts or waits for a network request. Replies do not advance the revision. Broadcasts omit `requestId` and replace the full previous snapshot.

## Policy semantics

- `provider` and `modelId` are the IDs registered with Pi. For Plexus, the provider is `plexus` and `modelId` is the raw model ID, not its display name.
- `serviceTiers` is copied from the model's `service_tiers` array. Names are preserved as advertised. Empty, duplicate, malformed, or missing tier lists are not advertised.
- If the raw model has no `service_tiers` field, Plexus says that model does not support service tiers, so it gets no policy. A successful catalog with no models advertising tiers has `status: "ready"` and `policies: []`.
- Policies are emitted only for models included in the committed Pi catalog. Suppressed or removed models disappear from the next snapshot.
- Service-tier metadata is stored with each committed model, including an explicit marker for models with no advertised tiers. This lets a cached catalog distinguish known lack of support from an older cache that never stored service-tier metadata.

## Lifecycle

- Each extension load creates a UUID `publisherId` and starts at revision `1`.
- `loading` is used while no usable catalog state is available. `unavailable` has no policies and includes a safe reason when metadata cannot be supplied. Both states have empty policy arrays.
- The revision advances only when the published state changes. Request/reply alone does not increment it.
- `fetchedAt` is the successful `/v1/models` fetch time, in Unix milliseconds. Cached snapshots set `cached: true` and preserve the original timestamp.
- A failed refresh retains the last committed snapshot. Catalog state changes are applied only inside Pi's generation-checked `context.publish()` transaction, so stale refreshes cannot replace a newer committed catalog.
- Snapshots are immutable complete replacements, validated before emission, and capped at 1 MiB. Oversized or invalid state becomes a small `unavailable` snapshot; policies are never truncated.
- The request listener is installed during extension initialization and removed on `session_shutdown` with the unsubscribe function from `pi.events.on()`.

Snapshots contain tier metadata only. They never include credentials, URLs, request headers, or raw backend errors.
