/**
 * Normalizes Gemini `MALFORMED_FUNCTION_CALL` terminal failures so pi's native
 * agent-turn retry recognizes them as transient and retries them.
 *
 * Background: Gemini 3.x occasionally emits its internal tool-call syntax as
 * plain text (e.g. `call:default_api:bash{...}`) instead of a structured
 * functionCall. Google terminates that candidate with
 * `finishReason: MALFORMED_FUNCTION_CALL`. Pi's bundled google-generative-ai
 * provider maps that to `stopReason: "error"` but then throws a generic
 * "An unknown error occurred", discarding the diagnostic — so pi's retry
 * classifier (`isRetryableAssistantError`) never matches and the turn dies.
 *
 * Pi 0.81 already ships a native agent-turn retry (`_prepareRetry`): it fires
 * when the finalized assistant message's `errorMessage` matches its retryable
 * pattern, and — crucially — it removes the failed assistant message from
 * context before re-running, so the visible text-leak content is never
 * duplicated on the retry. We only need the finalized error to be (a)
 * recognizable as `MALFORMED_FUNCTION_CALL` and (b) classified transient. We do
 * that in a `message_end` handler, which pi applies (via a returned replacement)
 * before it evaluates the retry gate.
 *
 * Detection is content-based because pi discards the finishReason: we match the
 * text-leak signature in the finalized message content (the generic
 * `errorMessage` carries no signal). Scope is strict — only error-stopReason
 * assistant messages from the Plexus provider that carry the leak and have no
 * structured tool call — so ordinary successes, non-Plexus providers, tool-call
 * turns, and unrelated Plexus errors are left untouched.
 *
 * Retries are bounded by pi's native `retry.maxRetries` budget (default 3). On
 * the final failure the message retains the `MALFORMED_FUNCTION_CALL` diagnostic.
 */
import { log } from "./log.ts";

// Text-leak signatures Gemini 3.x produces when a function call malforms, e.g.
// `call:default_api:bash{...}` or `default_api.bash(...)` (optionally wrapped in
// `print(...)`). The leak is glued onto preceding text with no separator, so we
// anchor on the `default_api` marker rather than a line start.
const MALFORMED_LEAK_PATTERN = /(?:print\()?call:\s*default_api[.:]|default_api\.\w+\s*\(/;

// Defensive: a diagnostic that already names the failure, in case a future pi
// version preserves the finishReason text on the error message.
const MALFORMED_DIAGNOSTIC_PATTERN = /\bmalformed[\s_-]?function[\s_-]?call\b/i;

// Sentinel prefix: retains the diagnostic AND doubles as the idempotency marker.
const NORMALIZED_PREFIX = "MALFORMED_FUNCTION_CALL:";

// "please retry your request" matches pi's RETRYABLE_PROVIDER_ERROR_PATTERN, so
// the native retry gate (`isRetryableAssistantError`) classifies this transient.
// It matches none of pi's NON-retryable (quota/billing) patterns.
const NORMALIZED_MESSAGE =
	`${NORMALIZED_PREFIX} Gemini emitted a malformed tool call (its internal ` +
	`function-call syntax leaked as text). This is a transient model failure — ` +
	`please retry your request.`;

interface ContentBlock {
	type?: string;
	text?: string;
}

interface AssistantMessageLike {
	role?: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

function hasLeakedFunctionCall(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	for (const block of content as ContentBlock[]) {
		if (
			block?.type === "text" &&
			typeof block.text === "string" &&
			MALFORMED_LEAK_PATTERN.test(block.text)
		) {
			return true;
		}
	}
	return false;
}

function hasToolCall(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		(content as ContentBlock[]).some((block) => block?.type === "toolCall")
	);
}

/**
 * When `message` is a Plexus `MALFORMED_FUNCTION_CALL` failure that should be
 * retried, return a `message_end` replacement whose `errorMessage` retains the
 * diagnostic and is classified transient by pi's native retry. Otherwise return
 * `undefined` (no replacement).
 */
export function normalizeMalformedFunctionCall<T extends AssistantMessageLike>(
	message: T,
	providerName: string,
): { message: T } | undefined {
	if (
		!message ||
		message.role !== "assistant" ||
		message.provider !== providerName ||
		message.stopReason !== "error"
	) {
		return undefined;
	}

	// Idempotent: this message was already normalized on a prior pass.
	if (
		typeof message.errorMessage === "string" &&
		message.errorMessage.startsWith(NORMALIZED_PREFIX)
	) {
		return undefined;
	}

	// Safety: never touch a turn that produced a structured tool call — those are
	// not the malformed-text-leak condition and must not be reclassified/retried.
	if (hasToolCall(message.content)) return undefined;

	const via = hasLeakedFunctionCall(message.content)
		? "leak"
		: typeof message.errorMessage === "string" &&
				MALFORMED_DIAGNOSTIC_PATTERN.test(message.errorMessage)
			? "diagnostic"
			: undefined;
	if (!via) return undefined;

	log("gemini-malformed-retry: retagged MALFORMED_FUNCTION_CALL for retry", {
		model: message.model,
		via,
	});

	return { message: { ...message, errorMessage: NORMALIZED_MESSAGE } };
}
