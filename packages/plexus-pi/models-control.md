# Models-refresh event API

`plexus-pi` owns the committed Plexus catalog, so it accepts a versioned event-bus command that forces a live `/v1/models` refresh. This is the programmatic equivalent of `/plexus refresh`.

The API is versioned in its channel names and payloads, and follows the same request/reply and broadcast rules as the provider's other channels.

## Channels and payloads

Send a refresh command on `plexus:models:refresh:v1`:

```ts
interface ModelsRefresh {
  version: 1;
  requestId: string;
}
```

Listen for a reply or broadcast on `plexus:models:state:v1`:

```ts
interface ModelsState {
  version: 1;
  publisherId: string;
  revision: number;
  requestId?: string;
  status: "idle" | "refreshing" | "ready" | "error";
  modelCount?: number;
  reason?: string;
}
```

Incoming commands and outgoing states are validated with Zod. Malformed commands are ignored without a reply. Unknown keys are rejected.

## Behavior

- A valid command forces a live refresh through Pi's `ModelRegistry` (`{ providers: ["plexus"], force: true }`), reusing the extension's existing catalog fetch, persistence, and publication path. The refresh re-evaluates the context and service-tier policy for the active model (see [policy-control.md](./policy-control.md)).
- The publisher moves through `refreshing` while the fetch runs, then `ready` with the committed `modelCount`, or `error` with a safe `reason`.
- Concurrent commands are coalesced: while a refresh is in flight, additional commands share it and each still receives a correlated reply. A command that arrives after the refresh completed starts a new one.
- A valid command always receives a correlated reply that echoes `requestId`. A reply does not advance `revision`; only a state change does.
- State changes are also broadcast without `requestId`. States are complete immutable replacements, never deltas, and are capped at 1 MiB. Invalid or oversized state becomes a small `error` state with no fabricated values.
- The `publisherId` is a UUID stable for the extension load; `revision` starts at `1` and increases monotonically.
- The command listener is installed during extension initialization and removed on `session_shutdown`.

## Failure and availability

- If no publisher is loaded (an older `plexus-pi` or none at all), the command receives no reply. Hosts must treat silence as unavailable rather than assuming a refresh happened.
- A refresh that cannot start — for example before the session has started, when no registry is bound — fails through the same `error` state with a safe `reason`. Credentials, URLs, request headers, and raw backend errors are never published.

## Manual refresh

`/plexus refresh` remains the interactive path and reports its result through the command UI. The event-bus command is intended for hosts that need to trigger a refresh programmatically.
