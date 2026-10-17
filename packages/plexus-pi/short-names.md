# Short-name event API

`plexus-pi` publishes the server-advertised abbreviated display names for models in the committed Plexus catalog over Pi's cross-extension event bus.

## Channels and payloads

Request a snapshot on `plexus:short-names:request:v1`:

```ts
{ version: 1, requestId: string }
```

Listen for a reply or broadcast on `plexus:short-names:snapshot:v1`:

```ts
interface ShortNameEntry {
  provider: string;
  modelId: string;
  shortName: string;
}

interface ShortNamesSnapshot {
  version: 1;
  publisherId: string;
  revision: number;
  requestId?: string;
  status: "ready" | "loading" | "unavailable";
  names: ShortNameEntry[];
  fetchedAt?: number;
  cached?: boolean;
  reason?: string;
}
```

Incoming requests and outgoing snapshots are validated with Zod. Invalid requests are ignored without logging their payload. A valid request receives the current in-memory snapshot synchronously during `pi.events.emit()` and echoes `requestId`; it never starts or waits for a network request. Replies do not advance the revision. Broadcasts omit `requestId` and replace the full previous snapshot.

## Name semantics

- `provider` and `modelId` are the IDs registered with Pi. For Plexus, the provider is `plexus` and `modelId` is the raw model ID, not its display name.
- `shortName` is copied from the model's `short_name` field, trimmed. Missing, blank, or overlong (>200 character) values are not advertised.
- Entries are emitted only for models included in the committed Pi catalog. Suppressed or removed models disappear from the next snapshot.
- A successful catalog where no model advertises a short name has `status: "ready"` and `names: []`. Absence of short names is catalog data, not a failure.
- Each committed model carries its short name as the `plexusShortName` extra prop, alongside `plexusContextPolicy` and `plexusServiceTiers`. It persists in Pi's `models-store.json` with the rest of the catalog.

## Why a separate channel

Short names are not part of the context-policy snapshot on purpose. Every snapshot schema here and there is strict on both ends, so adding a field to the context-policy snapshot in a one-sided rollout would fail validation and kill the whole snapshot for mismatched peers. A dedicated channel lets consumers adopt short names independently.

## Lifecycle

- Each extension load creates a UUID `publisherId` and starts at revision `1`.
- `loading` is used while no usable catalog state is available. `unavailable` has no names and includes a safe reason when metadata cannot be supplied. Both states have empty name arrays.
- The revision advances only when the published state changes. Request/reply alone does not increment it.
- `fetchedAt` is the successful `/v1/models` fetch time, in Unix milliseconds. Cached snapshots set `cached: true` and preserve the original timestamp when known.
- A failed refresh retains the last committed snapshot. Catalog state changes are applied only inside Pi's generation-checked `context.publish()` transaction, so stale refreshes cannot replace a newer committed catalog.
- Snapshots are immutable complete replacements, validated before emission, and capped at 1 MiB. Oversized or invalid state becomes a small `unavailable` snapshot; names are never truncated.
- The request listener is installed during extension initialization and removed on `session_shutdown` with the unsubscribe function from `pi.events.on()`.

Snapshots contain display-name metadata only. They never include credentials, URLs, request headers, or raw backend errors.
