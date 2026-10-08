import { afterEach, describe, expect, test } from "bun:test";
import {
	getSuppressedModels,
	resolveConfig,
	resolveConfigTemplate,
} from "./config-store.ts";

const MANAGED_ENV = [
	"PLEXUS_API_KEY",
	"PLEXUS_API_URL",
	"PLEXUS_BASE_URL",
	"AIHOME_OPENCODE_API_KEY",
];

afterEach(() => {
	for (const key of MANAGED_ENV) delete process.env[key];
});

describe("resolveConfigTemplate", () => {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR} template literal under test
	test("expands $VAR and ${VAR}, missing vars void the value", () => {
		process.env.PLEXUS_V2_TEST_URL = "https://plexus.example.com";
		expect(resolveConfigTemplate("$PLEXUS_V2_TEST_URL/v1")).toBe(
			"https://plexus.example.com/v1",
		);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR} template literal under test
		expect(resolveConfigTemplate("${PLEXUS_V2_TEST_URL}")).toBe(
			"https://plexus.example.com",
		);
		expect(resolveConfigTemplate("$PLEXUS_V2_TEST_MISSING")).toBeUndefined();
		delete process.env.PLEXUS_V2_TEST_URL;
	});
});

describe("resolveConfig", () => {
	test("env URL wins over connection metadata and options", () => {
		process.env.PLEXUS_API_URL = "https://env.example.com/v1";
		const resolved = resolveConfig(
			{ plexusBaseURL: "https://options.example.com" },
			{
				key: "meta-key",
				metadata: { plexusBaseURL: "https://meta.example.com" },
			},
		);
		expect(resolved).toEqual({
			baseURL: "https://env.example.com",
			apiKey: expect.any(String),
		});
		delete process.env.PLEXUS_API_URL;
	});

	test("connection credential fills key when env key is absent", () => {
		delete process.env.PLEXUS_API_KEY;
		const resolved = resolveConfig(
			{ plexusBaseURL: "https://options.example.com" },
			{
				key: "conn-key",
				metadata: { plexusBaseURL: "https://meta.example.com" },
			},
		);
		expect(resolved).toEqual({
			baseURL: "https://meta.example.com",
			apiKey: "conn-key",
		});
	});

	test("configuration-sourced baseURL works when metadata is absent", () => {
		delete process.env.PLEXUS_API_KEY;
		const resolved = resolveConfig(undefined, {
			key: "conn-key",
			configuration: { plexusBaseURL: "https://conf.example.com/v1" },
		});
		expect(resolved).toEqual({
			baseURL: "https://conf.example.com",
			apiKey: "conn-key",
		});
	});
});

describe("resolveConfig apiKeyEnv", () => {
	test("omitted apiKeyEnv preserves the default PLEXUS_API_KEY behavior", () => {
		process.env.PLEXUS_API_KEY = "default-env-key";
		expect(resolveConfig()).toEqual({ apiKey: "default-env-key" });
	});

	test("omitted apiKeyEnv falls back to credential then apiKey option", () => {
		expect(
			resolveConfig({ apiKey: "option-key" }, { key: "conn-key" }).apiKey,
		).toBe("conn-key");
		expect(resolveConfig({ apiKey: "option-key" }).apiKey).toBe("option-key");
	});

	test("custom apiKeyEnv selects the named variable", () => {
		process.env.AIHOME_OPENCODE_API_KEY = "custom-env-key";
		expect(resolveConfig({ apiKeyEnv: "AIHOME_OPENCODE_API_KEY" }).apiKey).toBe(
			"custom-env-key",
		);
	});

	test("explicit apiKeyEnv outranks PLEXUS_API_KEY, saved credential, and apiKey option", () => {
		process.env.PLEXUS_API_KEY = "default-env-key";
		process.env.AIHOME_OPENCODE_API_KEY = "custom-env-key";
		const resolved = resolveConfig(
			{ apiKeyEnv: "AIHOME_OPENCODE_API_KEY", apiKey: "option-key" },
			{
				key: "conn-key",
				metadata: { plexusBaseURL: "https://meta.example.com" },
			},
		);
		expect(resolved.apiKey).toBe("custom-env-key");
	});

	test("missing named variable throws without falling back", () => {
		process.env.PLEXUS_API_KEY = "default-env-key";
		expect(() =>
			resolveConfig({
				apiKeyEnv: "AIHOME_OPENCODE_API_KEY",
				apiKey: "option-key",
			}),
		).toThrow(/is missing or empty/);
		expect(() =>
			resolveConfig(
				{ apiKeyEnv: "AIHOME_OPENCODE_API_KEY" },
				{ key: "conn-key" },
			),
		).toThrow(/is missing or empty/);
	});

	test("empty or whitespace-only named variable throws without falling back to credential or apiKey option", () => {
		process.env.PLEXUS_API_KEY = "default-env-key";

		process.env.AIHOME_OPENCODE_API_KEY = "";
		expect(() =>
			resolveConfig(
				{ apiKeyEnv: "AIHOME_OPENCODE_API_KEY", apiKey: "option-key" },
				{ key: "conn-key" },
			),
		).toThrow(/is missing or empty/);

		process.env.AIHOME_OPENCODE_API_KEY = "   ";
		expect(() =>
			resolveConfig(
				{ apiKeyEnv: "AIHOME_OPENCODE_API_KEY", apiKey: "option-key" },
				{ key: "conn-key" },
			),
		).toThrow(/is missing or empty/);
	});

	test("invalid apiKeyEnv name throws a generic error that does not echo the input", () => {
		const bad = "not a var!";
		expect(() => resolveConfig({ apiKeyEnv: bad })).toThrow(
			/Invalid apiKeyEnv/,
		);
		try {
			resolveConfig({ apiKeyEnv: bad });
		} catch (e) {
			expect(String(e)).not.toContain(bad);
		}
		expect(() => resolveConfig({ apiKeyEnv: "" })).toThrow(/Invalid apiKeyEnv/);
		expect(() => resolveConfig({ apiKeyEnv: 42 })).toThrow(/Invalid apiKeyEnv/);
	});
});

describe("getSuppressedModels", () => {
	test("merges env and option patterns", () => {
		process.env.PLEXUS_SUPPRESS_MODELS = "env-*";
		expect(getSuppressedModels({ suppressModels: ["opt-*"] })).toEqual([
			"env-*",
			"opt-*",
		]);
		delete process.env.PLEXUS_SUPPRESS_MODELS;
	});
});
