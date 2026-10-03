import { afterEach, describe, expect, test } from "bun:test";
import { resolveConfig } from "./config-store.ts";
import { providerInfo } from "./plugin.ts";

afterEach(() => {
	delete process.env.AIHOME_OPENCODE_API_KEY;
	delete process.env.PLEXUS_API_KEY;
});

describe("provider registration", () => {
	test("apiKeyEnv-resolved key reaches the registered provider settings", () => {
		process.env.AIHOME_OPENCODE_API_KEY = "registered-env-key";
		const { baseURL, apiKey } = resolveConfig({
			apiKeyEnv: "AIHOME_OPENCODE_API_KEY",
			plexusBaseURL: "https://plexus.example.com",
		});
		const info = providerInfo({ models: [], baseURL, apiKey, connection: undefined });
		expect(info.settings?.apiKey).toBe("registered-env-key");
		expect(info.settings?.baseURL).toBe("https://plexus.example.com/v1");
	});

	test("default PLEXUS_API_KEY still registers when apiKeyEnv is omitted", () => {
		process.env.PLEXUS_API_KEY = "default-key";
		const { apiKey } = resolveConfig();
		const info = providerInfo({ models: [], apiKey, connection: undefined });
		expect(info.settings?.apiKey).toBe("default-key");
	});
});
