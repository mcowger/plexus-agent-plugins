import { describe, expect, test } from "bun:test";
import { createGeminiToolCallIdFixer } from "./gemini-toolcall-id.ts";

function assistantWithCalls(...ids: string[]) {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })),
	};
}

function toolResult(toolCallId: string, toolName = "bash") {
	return { role: "toolResult", toolCallId, toolName, content: [] };
}

function callPart(name = "bash") {
	return { functionCall: { name, args: {} } };
}

function responsePart(name = "bash") {
	return { functionResponse: { name, response: { output: "ok" } } };
}

describe("createGeminiToolCallIdFixer", () => {
	test("injects ids in order across model/user contents", () => {
		const fixer = createGeminiToolCallIdFixer();
		fixer.onContext([
			assistantWithCalls("call-a"),
			toolResult("call-a"),
			assistantWithCalls("call-b"),
			toolResult("call-b"),
		]);

		const payload = {
			model: "gemini-3.6-flash",
			contents: [
				{ role: "model", parts: [callPart()] },
				{ role: "user", parts: [responsePart()] },
				{ role: "model", parts: [callPart()] },
				{ role: "user", parts: [responsePart()] },
			],
		};

		fixer.onBeforeProviderRequest(payload);

		expect(payload.contents[0].parts[0].functionCall.id).toBe("call-a");
		expect(payload.contents[1].parts[0].functionResponse.id).toBe("call-a");
		expect(payload.contents[2].parts[0].functionCall.id).toBe("call-b");
		expect(payload.contents[3].parts[0].functionResponse.id).toBe("call-b");
	});

	test("no-op for non-Gemini-3 model id", () => {
		const fixer = createGeminiToolCallIdFixer();
		fixer.onContext([assistantWithCalls("call-a"), toolResult("call-a")]);

		const payload = {
			model: "gemini-2.5-flash",
			contents: [
				{ role: "model", parts: [callPart()] },
				{ role: "user", parts: [responsePart()] },
			],
		};

		fixer.onBeforeProviderRequest(payload);

		expect(payload.contents[0].parts[0].functionCall.id).toBeUndefined();
		expect(payload.contents[1].parts[0].functionResponse.id).toBeUndefined();
	});

	test("no-op for a non-Google payload (no contents array)", () => {
		const fixer = createGeminiToolCallIdFixer();
		fixer.onContext([assistantWithCalls("call-a")]);

		const payload = { messages: [{ role: "user", content: "hi" }] };
		const result = fixer.onBeforeProviderRequest(payload);

		expect(result).toBe(payload);
	});

	test("leaves parts that already have ids unchanged (idempotent)", () => {
		const fixer = createGeminiToolCallIdFixer();
		fixer.onContext([assistantWithCalls("call-new"), toolResult("call-new")]);

		const payload = {
			model: "gemini-3-pro",
			contents: [
				{ role: "model", parts: [{ functionCall: { id: "existing", name: "bash", args: {} } }] },
				{ role: "user", parts: [{ functionResponse: { id: "existing", name: "bash", response: {} } }] },
			],
		};

		fixer.onBeforeProviderRequest(payload);

		expect(payload.contents[0].parts[0].functionCall.id).toBe("existing");
		expect(payload.contents[1].parts[0].functionResponse.id).toBe("existing");
	});

	test("links parallel calls/results by independent order", () => {
		const fixer = createGeminiToolCallIdFixer();
		fixer.onContext([
			assistantWithCalls("call-1", "call-2"),
			toolResult("call-1"),
			toolResult("call-2"),
		]);

		const payload = {
			model: "gemini-3-flash",
			contents: [
				{ role: "model", parts: [callPart(), callPart()] },
				{ role: "user", parts: [responsePart(), responsePart()] },
			],
		};

		fixer.onBeforeProviderRequest(payload);

		expect(payload.contents[0].parts[0].functionCall.id).toBe("call-1");
		expect(payload.contents[0].parts[1].functionCall.id).toBe("call-2");
		expect(payload.contents[1].parts[0].functionResponse.id).toBe("call-1");
		expect(payload.contents[1].parts[1].functionResponse.id).toBe("call-2");
	});

	test("short queue does not throw and applies available ids", () => {
		const fixer = createGeminiToolCallIdFixer();
		fixer.onContext([assistantWithCalls("call-only")]);

		const payload = {
			model: "gemini-3.6-flash",
			contents: [{ role: "model", parts: [callPart(), callPart()] }],
		};

		expect(() => fixer.onBeforeProviderRequest(payload)).not.toThrow();
		expect(payload.contents[0].parts[0].functionCall.id).toBe("call-only");
		expect(payload.contents[0].parts[1].functionCall.id).toBeUndefined();
	});

	test("matches gemini-flash-latest alias", () => {
		const fixer = createGeminiToolCallIdFixer();
		fixer.onContext([assistantWithCalls("call-a")]);

		const payload = {
			model: "gemini-flash-latest",
			contents: [{ role: "model", parts: [callPart()] }],
		};

		fixer.onBeforeProviderRequest(payload);

		expect(payload.contents[0].parts[0].functionCall.id).toBe("call-a");
	});
});
