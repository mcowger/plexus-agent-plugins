import { describe, expect, test } from "bun:test";
import { normalizeMalformedFunctionCall } from "./gemini-malformed-retry.ts";

const PROVIDER = "plexus";

function malformedMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		provider: PROVIDER,
		stopReason: "error",
		errorMessage: "An unknown error occurred",
		content: [
			{ type: "thinking", thinking: "..." },
			{ type: "text", text: "Format repository filescall:default_api:bash{command:bun run format}" },
		],
		...overrides,
	};
}

describe("normalizeMalformedFunctionCall", () => {
	describe("detection", () => {
		test("normalizes an error turn carrying the call:default_api leak", () => {
			const result = normalizeMalformedFunctionCall(malformedMessage(), PROVIDER);
			expect(result).toBeDefined();
			expect(result?.message.errorMessage).toContain("MALFORMED_FUNCTION_CALL");
		});

		test("normalizes the default_api.<name>( leak variant", () => {
			const msg = malformedMessage({
				content: [{ type: "text", text: "print(default_api.read(path='x'))" }],
			});
			expect(normalizeMalformedFunctionCall(msg, PROVIDER)).toBeDefined();
		});

		test("detects via a diagnostic errorMessage even without a leaked text block", () => {
			const msg = malformedMessage({
				errorMessage: "Generation failed: MALFORMED_FUNCTION_CALL",
				content: [{ type: "text", text: "no leak here" }],
			});
			// The idempotency prefix is "MALFORMED_FUNCTION_CALL:" (with colon); this
			// diagnostic has no trailing colon, so it is detected, not skipped.
			expect(normalizeMalformedFunctionCall(msg, PROVIDER)).toBeDefined();
		});

		test("ignores a plain error turn with no malformed signal", () => {
			const msg = malformedMessage({
				content: [{ type: "text", text: "ordinary partial output" }],
			});
			expect(normalizeMalformedFunctionCall(msg, PROVIDER)).toBeUndefined();
		});
	});

	describe("normalization payload", () => {
		test("retains the MALFORMED_FUNCTION_CALL diagnostic and a retryable token", () => {
			const result = normalizeMalformedFunctionCall(malformedMessage(), PROVIDER);
			const errorMessage = result?.message.errorMessage ?? "";
			expect(errorMessage.startsWith("MALFORMED_FUNCTION_CALL:")).toBe(true);
			// Matches pi's RETRYABLE_PROVIDER_ERROR_PATTERN → native retry classifies transient.
			expect(errorMessage).toContain("please retry your request");
		});

		test("preserves the original message role and other fields", () => {
			const result = normalizeMalformedFunctionCall(malformedMessage(), PROVIDER);
			expect(result?.message.role).toBe("assistant");
			expect(result?.message.provider).toBe(PROVIDER);
			expect(result?.message.stopReason).toBe("error");
		});
	});

	describe("idempotency", () => {
		test("does not re-normalize an already-normalized message", () => {
			const first = normalizeMalformedFunctionCall(malformedMessage(), PROVIDER);
			expect(first).toBeDefined();
			const second = normalizeMalformedFunctionCall(
				malformedMessage({ errorMessage: first?.message.errorMessage }),
				PROVIDER,
			);
			expect(second).toBeUndefined();
		});
	});

	describe("provider scoping", () => {
		test("ignores messages from other providers", () => {
			const msg = malformedMessage({ provider: "openai" });
			expect(normalizeMalformedFunctionCall(msg, PROVIDER)).toBeUndefined();
		});

		test("honors a custom provider name", () => {
			const msg = malformedMessage({ provider: "custom-plexus" });
			expect(normalizeMalformedFunctionCall(msg, "custom-plexus")).toBeDefined();
		});
	});

	describe("safety scoping", () => {
		test("never touches a turn that produced a structured tool call", () => {
			const msg = malformedMessage({
				content: [
					{ type: "text", text: "call:default_api:bash{command:ls}" },
					{ type: "toolCall", id: "abc", name: "bash", arguments: {} },
				],
			});
			expect(normalizeMalformedFunctionCall(msg, PROVIDER)).toBeUndefined();
		});

		test("ignores non-error stop reasons", () => {
			const msg = malformedMessage({ stopReason: "stop" });
			expect(normalizeMalformedFunctionCall(msg, PROVIDER)).toBeUndefined();
		});

		test("ignores non-assistant roles", () => {
			const msg = malformedMessage({ role: "toolResult" });
			expect(normalizeMalformedFunctionCall(msg, PROVIDER)).toBeUndefined();
		});
	});
});
