# Gemini tool-call reliability (function IDs & malformed calls)

Reference for two related-but-distinct Gemini 3.x failure modes that surface
through the Plexus adapters, why they happen, how each host fork behaves, and
what we implemented. Written so we don't re-derive this from scratch.

> TL;DR
> - **Function-call ID retention** and **`MALFORMED_FUNCTION_CALL`** are *separate*
>   problems. One is not caused by the other (verified: malformed calls still
>   occur with IDs correctly present).
> - **Oh My Pi (`@oh-my-pi/*`) already handles both natively** — no plugin code.
> - **pi (`@earendil-works/*`, 0.81.x) needs both worked around in the plugin**,
>   because its fork lacks the fixes OMP's fork has.

---

## 1. Topology (how a Gemini request flows)

```
pi / Oh My Pi  --(google-generative-ai wire format)-->  Plexus proxy  --->  Google
   (+ plugin)                                            (our server)
```

- Each plugin registers a **`plexus` provider**. The provider's declared `api`
  is `openai-completions`, but **every model carries its own `api`** (set by
  `plexus-models` `convertDescriptors` from `preferred_api`). Gemini models get
  `api: "google-generative-ai"`, so they serialize/parse through the host's
  Google provider, not the OpenAI one.
- The client (pi/OMP) speaks the Google generateContent wire format to Plexus;
  Plexus forwards to Google and streams the response back.
- Relevant wire shapes:
  - Request `contents[].parts[]` may contain `functionCall {name,args,id?}` and
    `functionResponse {name,response,id?}`.
  - Response terminal chunk: `candidates[0].finishReason` (+ `finishMessage`),
    and `candidates[0].content.parts[]`.

**Fork packages:**
| | pi | Oh My Pi |
|---|---|---|
| runtime | `@earendil-works/pi-ai` + `pi-coding-agent` (0.81.1) | `@oh-my-pi/pi-ai` + `pi-coding-agent` |
| plugin pkg | `packages/plexus-pi` (`@mcowger/pi-plexus`) | `packages/plexus-oh-my-pi` (`@mcowger/oh-my-pi-plexus`) |
| host imports | `import type` (runtime `external` in build) | `import type` only; runtime helpers via `@oh-my-pi/pi-utils` (see its AGENTS.md — never bare-import `@oh-my-pi/pi-catalog`/`pi-ai` at runtime) |

---

## 2. Problem A — function-call correlation ID retention

### Symptom
Gemini 3.x requires that the `id` returned on each `functionCall` be echoed back
on the matching `functionResponse`. When it isn't, the model degrades over a long
tool history and eventually emits a malformed textual pseudo-call.

### Root cause (pi fork only)
`@earendil-works/pi-ai` `providers/google-shared.ts`:
```ts
export function requiresToolCallId(modelId: string): boolean {
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}
```
`id` is only serialized onto `functionCall`/`functionResponse` when this returns
true — so **Gemini 3.x loses the id on every replay**.

### Fix (pi plugin) — `packages/plexus-pi/src/gemini-toolcall-id.ts`
Re-inject IDs at the serialization boundary using two extension hooks that fire
sequentially in the same single-threaded stream call:
- `context` — capture ordered `functionCallIds` / `functionResponseIds` from the
  internal messages (which still carry intact IDs).
- `before_provider_request` — the serialized Google payload has the IDs stripped;
  walk `contents[].parts[]` and re-inject IDs by order (independent queues for
  calls vs responses preserve identity under parallel tool calls).

Gated to Gemini 3.x (`/gemini-(?:live-)?3(?:\.\d+)?[-.]/i` + aliases
`gemini-flash-latest` / `gemini-flash-lite-latest`). Idempotent (skips parts that
already have an `id`), never throws.

### Oh My Pi — already native, no plugin code
`@oh-my-pi/pi-ai` `providers/google-shared.ts`:
```ts
function supportsFunctionPartId(model) {
  if (model.api === "google-vertex") return false;
  return model.id.startsWith("claude-")
      || (model.api === "google-generative-ai" && isGemini3Model(model.id)); // includes("gemini-3")
}
```
Emits `id` on both `functionCall` and `functionResponse` for Gemini 3.x.
**Gap:** OMP's `isGemini3Model` is literally `includes("gemini-3")`, so a Gemini-3
model exposed under an alias *without* `gemini-3` in its id (e.g.
`gemini-flash-latest`) would not get IDs. Only relevant if the Plexus catalog
exposes such aliases; not currently worked around.

### Suggested upstream fix (pi)
Extend `requiresToolCallId` to also return true when
`getGeminiMajorVersion(modelId) >= 3` (that helper already exists in the file).

---

## 3. Problem B — `MALFORMED_FUNCTION_CALL`

### Symptom
Gemini 3.x occasionally emits its **internal tool-call representation as plain
text** instead of a structured `functionCall`, e.g.:
```
Format repository files with biome formatcall:default_api:bash{command:bun run format}
```
Google rejects its own candidate and terminates with:
```
candidates[0].finishReason  = "MALFORMED_FUNCTION_CALL"
candidates[0].finishMessage = "Malformed function call: Failed to parse function call: ..."
```

### Properties (verified from a live trace)
- **Transient** — a fresh generation almost always succeeds.
- Triggered by long, tool-heavy multi-turn history; **independent of context
  size** (observed at ~119K tokens, far under the limit).
- **Not** caused by dropped IDs — occurred with every `functionCall`/
  `functionResponse` `id` and every `thoughtSignature` correctly present.
- The leaked text is streamed as **visible content before** the terminal error.
  (This is why an in-stream retry wrapper cannot safely retry it — see §3.4.)

### Detection signatures
- **Primary / authoritative** (raw upstream Gemini):
  `candidates[0].finishReason === "MALFORMED_FUNCTION_CALL"`.
- **Content / secondary** (needed client-side once the finishReason is discarded):
  the leaked call syntax in a text part. Tolerant matcher:
  ```
  /(?:print\()?call:\s*default_api[.:]|default_api\.\w+\s*\(/
  ```
  Anchor on the `default_api` marker — the leak is glued onto preceding text with
  no separator (`…formatcall:default_api:…`).
- **Diagnostic** (defensive, if a host preserves the finishReason text):
  `/\bmalformed[\s_-]?function[\s_-]?call\b/i`.

### 3.1 Recovery techniques (design menu)
1. **Retry** (best). The failure is transient.
   - *Internal retry* (server/host, before any bytes are flushed) — transparent.
   - *Signal a retryable error* to the client so its own retry fires.
2. **Response recovery** (opportunistic, fragile). Parse the leaked
   `call:default_api:<name>{<args>}` into a structured `functionCall` and set
   `finishReason: STOP`. **Only safe for a single call with flat, strictly-
   parseable args** — the args blob is unquoted Python-ish repr, not JSON; a
   wrong parse yields a plausible-but-wrong tool execution (worse than a retry).
   Gate strictly or don't bother.

### 3.2 Plexus proxy side (server) — implemented separately
Plexus detects `MALFORMED_FUNCTION_CALL` and presents it to the client as a
**retryable error** rather than passing the terminal finishReason through verbatim
(which most clients treat as a dead, non-retryable turn).
- **Buffered / not-yet-flushed:** fail with **HTTP 503** + a body message
  containing a retryable token (e.g. `please retry your request`).
- **Already-streaming (200 sent):** terminate the SSE as an *error* (so the
  client's stream reader throws `terminated`/`ended without`/`fetch failed`),
  not a clean stop.
- Client retryable tokens to include / avoid — see §4.
- Best when possible: **retry upstream inside Plexus** before flushing bytes.

### 3.3 pi plugin side — normalize + native retry
`packages/plexus-pi/src/gemini-malformed-retry.ts` (+ `.test.ts`), wired in
`extension.ts` via `pi.on("message_end", …)`.

**Why normalization, not a `streamSimple` retry wrapper:**
- pi flattens `MALFORMED_FUNCTION_CALL` → `stopReason: "error"` + generic
  `errorMessage: "An unknown error occurred"` (diagnostic lost), and pi's
  `RETRYABLE_PROVIDER_ERROR_PATTERN` does **not** include malformed → the turn is
  terminal.
- **pi 0.81.1 *does* have a native agent-turn retry** (`_prepareRetry` /
  `_isRetryableError`, enabled by default, `maxRetries` default 3) that
  **removes the failed assistant message from context before re-running** — so no
  duplicate visible content. (The task brief assumed pi had no such retry; it
  does in 0.81.1.)
- The leaked text is streamed as visible content *before* the error, so a
  provider `streamSimple` wrapper couldn't retry it without duplicating content;
  it would fall back to normalization anyway. Normalization + native retry is
  therefore both simpler and the only safe path for the real case.

**Mechanism:**
1. `message_end` handler inspects the finalized assistant message.
2. **Detect** (content-based, since the diagnostic is gone): `role === assistant`
   && `provider === plexus` && `stopReason === error` && content has a text block
   matching the leak regex (defensive fallback: `errorMessage` matches the
   diagnostic regex).
3. **Normalize** by returning a `message_end` **replacement** (same role) whose
   `errorMessage` is:
   ```
   MALFORMED_FUNCTION_CALL: Gemini emitted a malformed tool call (its internal
   function-call syntax leaked as text). This is a transient model failure —
   please retry your request.
   ```
   This **retains the `MALFORMED_FUNCTION_CALL` diagnostic** and contains
   `please retry your request`, which matches pi's retryable pattern.
4. pi's native retry fires, drops the failed message, backs off, re-runs.
5. On final exhaustion the diagnostic is retained.

**Why `message_end` can influence the retry:** `agent-session.js`
`_emitExtensionEvent` calls `extensionRunner.emitMessageEnd`, which uses the
handler's returned `{ message }` (must keep the same role) and applies it via
`_replaceMessageInPlace` (in-place mutation) **before** `_lastAssistantMessage`
is set and **before** `_handlePostAgentRun` evaluates `_isRetryableError`.

**Safety / scope:** provider-scoped; only `stopReason === error`; skips any
message containing a structured `toolCall` block (an error turn never executed
tools, so this is belt-and-suspenders); idempotent (skips messages whose
`errorMessage` already starts with the `MALFORMED_FUNCTION_CALL:` sentinel);
handler exceptions are swallowed by pi's runner.

**Debug log** (fire-and-forget → `<agentDir>/extensions/plexus/plexus.log`):
```
gemini-malformed-retry: retagged MALFORMED_FUNCTION_CALL for retry {"model":"…","via":"leak"|"diagnostic"}
```

**Known limitation:** detection is content-based, so a *truly empty* malformed
call (finishReason set but no leaked text) is not caught client-side. Not
observed in practice. Retries follow pi's `retry.maxRetries` (default 3), not a
hard one-shot.

### 3.4 Oh My Pi — already native, no plugin code
`@oh-my-pi/pi-ai` handles this end-to-end:
- `providers/google-shared.ts` sets, for the MALFORMED finishReason:
  `errorMessage = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL"`
  (diagnostic retained through `AIError.finalize` → `formatMessage`).
- `error/flags.ts` has a **dedicated `Flag.MalformedFunctionCall`**
  (`isMalformedFunctionCallText`, `/\bmalformed.?function.?call\b/i`), and
  `TRANSIENT_TRANSPORT_PATTERN` also lists `malformed.?function.?call`.
- `retriable(id, opts)` returns **`true` unconditionally** for that flag — it even
  overrides `replayUnsafe`, so OMP retries it *even when tool calls are present*.
- Native auto-retry `retry.maxRetries` default = **10**.

So OMP already: retains the diagnostic, classifies transient, and retries. Adding
a hook would be redundant and could interfere with OMP's `#retryAttempt`
accounting. **Do nothing for OMP.**

---

## 4. Host retry-classification reference

### pi (`@earendil-works/pi-ai` `utils/retry.js`)
`isRetryableAssistantError(msg)` = `stopReason === "error"` && `errorMessage`
matches `RETRYABLE_PROVIDER_ERROR_PATTERN` && NOT `NON_RETRYABLE…`.
- **Retryable tokens** (embed one when re-tagging): `overloaded`, `rate limit`,
  `429`, `500/502/503/504/524`, `service unavailable`, `server error`,
  `internal error`, `provider returned error`, `network/connection error`,
  `fetch failed`, `timed out`/`timeout`, `terminated`, `ended without`,
  `you can retry your request`, `try your request again`,
  `please retry your request`, `ResourceExhausted`.
- **Non-retryable (avoid):** `insufficient_quota`, `quota exceeded`, `billing`,
  `out of budget`, `GoUsageLimitError`, `FreeUsageLimitError`.
- Malformed is **absent** from both — that's the gap the pi plugin fills.

Native retry: `agent-session.js` `_handlePostAgentRun` → `_isRetryableError` &&
`_prepareRetry` (settings `enabled` default true, `maxRetries` default 3,
exponential backoff, drops the last assistant message before re-run).

### Oh My Pi (`@oh-my-pi/pi-ai` `error/flags.ts`)
Structured flags via `classify`/`classifyMessage`; `retriable(id, {replayUnsafe})`
special-cases `Flag.MalformedFunctionCall` (unconditional true) and
`Flag.ContentBlocked` (false). `TRANSIENT_TRANSPORT_PATTERN` covers transport
phrasings including malformed. `retry.maxRetries` default **10**.

---

## 5. File map

| File | Purpose |
|---|---|
| `packages/plexus-models/src/convert.ts` | shared model conversion; sets per-model `api` from `preferred_api` |
| `packages/plexus-pi/src/gemini-toolcall-id.ts` (+`.test.ts`) | pi: re-inject Gemini 3.x function-call IDs (Problem A) |
| `packages/plexus-pi/src/gemini-malformed-retry.ts` (+`.test.ts`) | pi: normalize `MALFORMED_FUNCTION_CALL` so native retry fires (Problem B) |
| `packages/plexus-pi/src/extension.ts` | registers `context`, `before_provider_request`, `message_end` hooks |
| `packages/plexus-oh-my-pi/*` | no tool-call-reliability code — OMP fork handles both natively |

---

## 6. Decision log

- **OMP, both problems → do nothing.** The fork already fixed them upstream
  (`supportsFunctionPartId` for IDs; `Flag.MalformedFunctionCall` + default-10
  retry for malformed). Redundant code would risk interfering.
- **pi, IDs → re-inject.** Host `requiresToolCallId` omits Gemini 3.
- **pi, malformed → normalize + native retry, NOT a `streamSimple` wrapper.**
  Native retry exists in 0.81.1 and is safer (drops the failed message); the
  visible-content-before-error property makes a wrapper retry unsafe anyway.
- **Retry count = host `maxRetries` (pi 3 / OMP 10), not hard one-shot.** Bounded,
  configurable, and retains the diagnostic on final failure.

---

## 7. Maintenance / re-verify on host upgrades

Both pi workarounds probe host internals; re-check these when bumping the host:
- **pi IDs:** whether `requiresToolCallId` (or its replacement) now covers Gemini
  3 — if so, our re-injection becomes a harmless idempotent no-op and can be
  retired.
- **pi malformed:**
  - `message_end` still returns a same-role `{ message }` replacement applied
    before the retry gate (`emitMessageEnd` → `_replaceMessageInPlace`).
  - `_prepareRetry` still removes the failed assistant message before re-run.
  - `RETRYABLE_PROVIDER_ERROR_PATTERN` still matches `please retry your request`
    (and doesn't newly add `malformed …`, which would make normalization a no-op —
    fine).
  - Assistant message still carries `provider`/`stopReason`/`content` and text
    blocks as `{type:"text", text}`.
- **OMP:** `Flag.MalformedFunctionCall` + `retriable` unconditional-true still
  present; `retry.maxRetries` default unchanged. `isGemini3Model` still
  `includes("gemini-3")` (alias gap noted in §2).

## 8. Upstream reports worth filing / tracking
- pi: extend `requiresToolCallId` to Gemini major ≥ 3.
- pi: preserve the Gemini finishReason in the error message (so its own retry
  classifier could recognize malformed without a plugin).
- Google: Gemini 3.x should not serialize `call:default_api:…` as text.
