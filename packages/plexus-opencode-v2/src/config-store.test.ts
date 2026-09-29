import { describe, expect, test } from "bun:test";
import { getSuppressedModels, resolveConfig, resolveConfigTemplate } from "./config-store.ts";

describe("resolveConfigTemplate", () => {
	test("expands $VAR and ${VAR}, missing vars void the value", () => {
		process.env.PLEXUS_V2_TEST_URL = "https://plexus.example.com";
		expect(resolveConfigTemplate("$PLEXUS_V2_TEST_URL/v1")).toBe("https://plexus.example.com/v1");
		expect(resolveConfigTemplate("${PLEXUS_V2_TEST_URL}")).toBe("https://plexus.example.com");
		expect(resolveConfigTemplate("$PLEXUS_V2_TEST_MISSING")).toBeUndefined();
		delete process.env.PLEXUS_V2_TEST_URL;
	});
});

describe("resolveConfig", () => {
	test("env URL wins over connection metadata and options", () => {
		process.env.PLEXUS_API_URL = "https://env.example.com/v1";
		const resolved = resolveConfig(
			{ plexusBaseURL: "https://options.example.com" },
			{ key: "meta-key", metadata: { plexusBaseURL: "https://meta.example.com" } },
		);
		expect(resolved).toEqual({ baseURL: "https://env.example.com", apiKey: expect.any(String) });
		delete process.env.PLEXUS_API_URL;
	});

	test("connection credential fills key when env key is absent", () => {
		delete process.env.PLEXUS_API_KEY;
		const resolved = resolveConfig(
			{ plexusBaseURL: "https://options.example.com" },
			{ key: "conn-key", metadata: { plexusBaseURL: "https://meta.example.com" } },
		);
		expect(resolved).toEqual({ baseURL: "https://meta.example.com", apiKey: "conn-key" });
	});

	test("configuration-sourced baseURL works when metadata is absent", () => {
		delete process.env.PLEXUS_API_KEY;
		const resolved = resolveConfig(undefined, {
			key: "conn-key",
			configuration: { plexusBaseURL: "https://conf.example.com/v1" },
		});
		expect(resolved).toEqual({ baseURL: "https://conf.example.com", apiKey: "conn-key" });
	});
});

describe("getSuppressedModels", () => {
	test("merges env and option patterns", () => {
		process.env.PLEXUS_SUPPRESS_MODELS = "env-*";
		expect(getSuppressedModels({ suppressModels: ["opt-*"] })).toEqual(["env-*", "opt-*"]);
		delete process.env.PLEXUS_SUPPRESS_MODELS;
	});
});
