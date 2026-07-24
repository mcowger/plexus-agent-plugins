/**
 * Restores tool-call correlation IDs for Gemini 3.x requests.
 *
 * Pi's bundled google-generative-ai serializer gates id emission on
 * requiresToolCallId(modelId), which only matches `claude-`/`gpt-oss-` prefixes.
 * Gemini 3.x therefore loses the `id` on every functionCall/functionResponse
 * part during replay. Google's Gemini 3 API requires the id returned on each
 * functionCall to be echoed back in the matching functionResponse; without it
 * the model eventually emits a malformed textual pseudo-call.
 *
 * We restore the IDs at the plugin's serialization boundary using two hooks:
 *   - context: fires with internal messages that still carry intact IDs.
 *   - before_provider_request: fires with the serialized Google payload, after
 *     the IDs were stripped, and lets us return a replacement payload.
 *
 * Both hooks fire sequentially within the same single-threaded stream call
 * (context -> serialize -> before_provider_request), and serialization preserves
 * message order 1:1 into parts, so order-based correlation is exact.
 */
import { log } from "./log.ts";

// Gemini 3.x model ids (e.g. gemini-3-flash, gemini-3.6-flash, gemini-live-3-pro)
// plus the floating "latest" aliases pi itself treats as Gemini 3 flash.
const GEMINI_3_PATTERN = /gemini-(?:live-)?3(?:\.\d+)?[-.]/i;
const GEMINI_3_ALIASES = new Set(["gemini-flash-latest", "gemini-flash-lite-latest"]);

interface FunctionCallPart {
	functionCall?: { id?: string; name?: string; args?: unknown };
	functionResponse?: { id?: string; name?: string; response?: unknown };
}

interface GoogleContent {
	role?: string;
	parts?: FunctionCallPart[];
}

interface GooglePayload {
	model?: string;
	contents?: GoogleContent[];
}

interface ToolCallBlock {
	type: string;
	id?: string;
}

interface AgentMessageLike {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
}

function isGemini3Model(modelId: string): boolean {
	return GEMINI_3_ALIASES.has(modelId) || GEMINI_3_PATTERN.test(modelId);
}

export function createGeminiToolCallIdFixer() {
	// Ordered queues captured from the internal messages on each `context` event.
	let functionCallIds: string[] = [];
	let functionResponseIds: { id: string; name: string }[] = [];

	function onContext(messages: readonly AgentMessageLike[]): void {
		const calls: string[] = [];
		const responses: { id: string; name: string }[] = [];

		for (const msg of messages) {
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content as ToolCallBlock[]) {
					if (block?.type === "toolCall" && typeof block.id === "string") {
						calls.push(block.id);
					}
				}
			} else if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
				responses.push({ id: msg.toolCallId, name: msg.toolName ?? "" });
			}
		}

		functionCallIds = calls;
		functionResponseIds = responses;
	}

	function onBeforeProviderRequest(payload: unknown): unknown {
		const google = payload as GooglePayload | null;
		if (!google || typeof google !== "object" || !Array.isArray(google.contents)) {
			return payload;
		}
		if (typeof google.model !== "string" || !isGemini3Model(google.model)) {
			return payload;
		}

		let callCursor = 0;
		let responseCursor = 0;
		let missing = 0;

		for (const content of google.contents) {
			if (!Array.isArray(content?.parts)) continue;
			for (const part of content.parts) {
				if (part.functionCall && part.functionCall.id === undefined) {
					const id = functionCallIds[callCursor++];
					if (id !== undefined) {
						part.functionCall.id = id;
					} else {
						missing++;
					}
				} else if (part.functionResponse && part.functionResponse.id === undefined) {
					const entry = functionResponseIds[responseCursor++];
					if (entry !== undefined) {
						part.functionResponse.id = entry.id;
						if (part.functionResponse.name === undefined && entry.name) {
							part.functionResponse.name = entry.name;
						}
					} else {
						missing++;
					}
				}
			}
		}

		if (missing > 0) {
			log("gemini-toolcall-id: fewer captured ids than parts", {
				model: google.model,
				missing,
				capturedCalls: functionCallIds.length,
				capturedResponses: functionResponseIds.length,
			});
		}

		return payload;
	}

	return { onContext, onBeforeProviderRequest };
}
