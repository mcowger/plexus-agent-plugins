import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { AssistantMessageEvent, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { resetConfigCache } from "./config.ts";
import plexusExtension, { getProviderApiKeyConfig } from "./extension.ts";

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
				api: "openai-completions",
				...getProviderApiKeyConfig(),
			}, sourceId);
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
			let requestUrl: string | undefined;
			let requestHeaders: Headers | undefined;
			const fetch: FetchImpl = async (url, init) => {
				requestUrl = String(url);
				requestHeaders = new Headers(init?.headers);
				const chunk = {
					candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
				};
				return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			};

			await drain(streamGoogle(model! as Model<"google-generative-ai">, {
				messages: [{ role: "user", content: "Reply with OK only.", timestamp: 1 }],
			}, { apiKey, fetch }));
			expect(requestUrl).toBe("https://plexus.example.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
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

describe("Oh My Pi Plexus provider registration (apiKeyEnv)", () => {
	const originalAgentDir = getAgentDir();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plexus-omp-reg-"));
	const configDir = path.join(tempDir, "extensions", "plexus");
	const configPath = path.join(configDir, "config.json");

	beforeAll(() => {
		setAgentDir(tempDir);
	});

	afterAll(() => {
		setAgentDir(originalAgentDir);
		resetConfigCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("registers the configured apiKeyEnv name when resolvable", () => {
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ apiKeyEnv: "AIHOME_OMP_API_KEY" }));
		resetConfigCache();
		Bun.env["AIHOME_OMP_API_KEY"] = RESOLVED_API_KEY;

		expect(getProviderApiKeyConfig()).toEqual({ apiKey: "AIHOME_OMP_API_KEY", authHeader: true });

		delete Bun.env["AIHOME_OMP_API_KEY"];
	});

	test("aborts registration when an explicit apiKeyEnv is missing", () => {
		fs.writeFileSync(configPath, JSON.stringify({ apiKeyEnv: "AIHOME_OMP_API_KEY" }));
		resetConfigCache();
		delete Bun.env["AIHOME_OMP_API_KEY"];
		Bun.env[ENV_API_KEY] = RESOLVED_API_KEY;

		expect(() => getProviderApiKeyConfig()).toThrow(/is missing or empty/);
	});

	test("defaults to PLEXUS_API_KEY when apiKeyEnv is omitted", () => {
		fs.rmSync(configPath, { force: true });
		resetConfigCache();
		Bun.env[ENV_API_KEY] = RESOLVED_API_KEY;

		expect(getProviderApiKeyConfig()).toEqual({ apiKey: ENV_API_KEY, authHeader: true });
	});

	test("explicit apiKeyEnv overrides saved credentials in native request authentication", async () => {
		fs.writeFileSync(configPath, JSON.stringify({ apiKeyEnv: "AIHOME_OMP_API_KEY" }));
		resetConfigCache();
		Bun.env.AIHOME_OMP_API_KEY = RESOLVED_API_KEY;
		const authStorage = await AuthStorage.create(path.join(tempDir, "request-auth.db"));
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		const sourceId = "ext://plexus-custom-env-test";
		const originalUrls = [Bun.env.PLEXUS_API_URL, Bun.env.PLEXUS_BASE_URL];
		delete Bun.env.PLEXUS_API_URL;
		delete Bun.env.PLEXUS_BASE_URL;
		try {
			await authStorage.credentials.set("plexus", { type: "api_key", key: "saved-key" });
			const pi = {
				on() {},
				registerProvider(name: string, config: Parameters<typeof registry.registerProvider>[1]) {
					registry.registerProvider(name, config, sourceId);
				},
				registerCommand() {},
			} as unknown as ExtensionAPI;
			plexusExtension(pi);
			expect(await authStorage.keys.get("plexus")).toBe(RESOLVED_API_KEY);
			expect(authStorage.credentials.get("plexus")).toMatchObject({ key: "saved-key" });
			registry.clearSourceRegistrations(sourceId);
			expect(await authStorage.keys.get("plexus")).toBe("saved-key");
		} finally {
			registry.clearSourceRegistrations(sourceId);
			authStorage.close();
			delete Bun.env.AIHOME_OMP_API_KEY;
			for (const [index, name] of ["PLEXUS_API_URL", "PLEXUS_BASE_URL"].entries()) {
				const value = originalUrls[index];
				if (value === undefined) delete Bun.env[name];
				else Bun.env[name] = value;
			}
		}
	});

	test("omitted apiKeyEnv preserves OMP's registered env override above saved credentials", async () => {
		fs.rmSync(configPath, { force: true });
		resetConfigCache();
		Bun.env[ENV_API_KEY] = RESOLVED_API_KEY;
		const authStorage = await AuthStorage.create(path.join(tempDir, "default-request-auth.db"));
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		const sourceId = "ext://plexus-default-env-test";
		try {
			await authStorage.credentials.set("plexus", { type: "api_key", key: "saved-key" });
			registry.registerProvider("plexus", {
				api: "openai-completions",
				...getProviderApiKeyConfig(),
			}, sourceId);
			expect(await authStorage.keys.get("plexus")).toBe(RESOLVED_API_KEY);
			registry.clearSourceRegistrations(sourceId);
			expect(await authStorage.keys.get("plexus")).toBe("saved-key");
		} finally {
			registry.clearSourceRegistrations(sourceId);
			authStorage.close();
		}
	});

	test("status describes the default environment key as an override without showing keys", async () => {
		fs.rmSync(configPath, { force: true });
		resetConfigCache();
		Bun.env[ENV_API_KEY] = RESOLVED_API_KEY;
		let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
		let message = "";
		plexusExtension({
			on() {},
			registerProvider() {},
			registerCommand(_name: string, config: typeof command) { command = config; },
		} as unknown as ExtensionAPI);
		if (!command) throw new Error("plexus command not registered");
		await command.handler("status", {
			modelRegistry: { authStorage: { getApiKey: async () => RESOLVED_API_KEY } },
			ui: { notify(text: string) { message = text; } },
		} as unknown as ExtensionCommandContext);
		expect(message).toContain("PLEXUS_API_KEY (overrides host credential)");
		expect(message).not.toContain(RESOLVED_API_KEY);
	});
});
