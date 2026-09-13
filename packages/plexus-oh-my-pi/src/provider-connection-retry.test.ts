import { describe, expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { normalizeProviderConnectionClosed } from "./provider-connection-retry.ts";

const PROVIDER = "plexus";

function errorMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		provider: PROVIDER,
		model: "test-model",
		stopReason: "error",
		errorMessage: "Provider connection closed",
		...overrides,
	};
}

describe("normalizeProviderConnectionClosed", () => {
	test("retags a Plexus closed connection as retryable", () => {
		const message = errorMessage();
		normalizeProviderConnectionClosed(message, PROVIDER);
		expect(message.errorMessage).toContain("PROVIDER_CONNECTION_CLOSED");
		expect(message.errorMessage).toContain("please retry your request");
	});

	test("makes the error transient for OMP's native retry classifier", () => {
		const message = errorMessage();
		normalizeProviderConnectionClosed(message, PROVIDER);
		expect(AIError.retriable(AIError.classifyMessage(message))).toBe(true);
	});

	test("does not retry a closed connection after a structured tool call", () => {
		const message = errorMessage({
			content: [{ type: "toolCall", id: "abc", name: "bash", arguments: {} }],
		});
		normalizeProviderConnectionClosed(message, PROVIDER);
		expect(message.errorMessage).toBe("Provider connection closed");
	});

	test("does not modify a different provider's error", () => {
		const message = errorMessage({ provider: "openai" });
		normalizeProviderConnectionClosed(message, PROVIDER);
		expect(message.errorMessage).toBe("Provider connection closed");
	});

	test("does not modify a non-connection error", () => {
		const message = errorMessage({ errorMessage: "Invalid API key" });
		normalizeProviderConnectionClosed(message, PROVIDER);
		expect(message.errorMessage).toBe("Invalid API key");
	});
});
