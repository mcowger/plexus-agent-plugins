import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { AssistantMessageEvent, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getProviderApiKeyConfig } from "./extension.ts";

const ENV_API_KEY = "PLEXUS_API_KEY";
const RESOLVED_API_KEY = "resolved-plexus-key";

const originalApiKey = Bun.env[ENV_API_KEY];

afterEach(() => {
	if (originalApiKey === undefined) delete Bun.env[ENV_API_KEY];
	else Bun.env[ENV_API_KEY] = originalApiKey;
});

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<void> {
	for await (const _event of stream) {}
}

describe("Oh My Pi Plexus authentication", () => {
	test("Gemini requests resolve the environment key before sending", async () => {
		Bun.env[ENV_API_KEY] = RESOLVED_API_KEY;
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-omp-auth-"));
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		const sourceId = "ext://plexus-auth-test";

		try {
			registry.registerProvider("plexus", {
				api: "google-generative-ai",
				baseUrl: "https://plexus.example.com/v1beta",
				...getProviderApiKeyConfig(),
				models: [{
					id: "gemini-test",
					name: "Gemini Test",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				}],
			}, sourceId);

			const model = registry.find("plexus", "gemini-test");
			expect(model).toBeDefined();
			const apiKey = await registry.getApiKey(model!);
			let requestHeaders: Headers | undefined;
			const fetch: FetchImpl = async (_url, init) => {
				requestHeaders = new Headers(init?.headers);
				const chunk = {
					candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
				};
				return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			};

			await drain(streamGoogle(model!, {
				messages: [{ role: "user", content: "Reply with OK only.", timestamp: 1 }],
			}, { apiKey, fetch }));

			expect(requestHeaders?.get("x-goog-api-key")).toBe(RESOLVED_API_KEY);
			expect([...requestHeaders!.values()]).not.toContain(ENV_API_KEY);
		} finally {
			registry.clearSourceRegistrations(sourceId);
			authStorage.close();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("registers the env-var name only when it is resolvable", () => {
		Bun.env[ENV_API_KEY] = RESOLVED_API_KEY;
		expect(getProviderApiKeyConfig()).toEqual({ apiKey: ENV_API_KEY, authHeader: true });

		delete Bun.env[ENV_API_KEY];
		expect(getProviderApiKeyConfig()).toEqual({});
	});
});
