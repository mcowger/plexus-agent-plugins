import { describe, expect, test } from "bun:test";
import {
	resolveApiKeyEnvSetting,
	resolveApiKeyEnvValue,
	resolvePlexusApiKey,
} from "./auth.ts";

describe("resolveApiKeyEnvSetting", () => {
	test("uses the default environment variable when setting is nullish", () => {
		expect(resolveApiKeyEnvSetting(undefined)).toEqual({
			name: "PLEXUS_API_KEY",
			explicit: false,
		});
		expect(resolveApiKeyEnvSetting(null)).toEqual({
			name: "PLEXUS_API_KEY",
			explicit: false,
		});
	});

	test("trims and validates explicit names without echoing invalid input", () => {
		expect(resolveApiKeyEnvSetting("  CUSTOM_KEY ")).toEqual({
			name: "CUSTOM_KEY",
			explicit: true,
		});
		const secret = "not a var!private";
		try {
			resolveApiKeyEnvSetting(secret);
			throw new Error("Expected invalid setting to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(
				"Invalid apiKeyEnv: expected an environment variable name",
			);
			expect((error as Error).message).not.toContain(secret);
		}
	});
});

describe("resolveApiKeyEnvValue", () => {
	test("trims values and requires explicit variables", () => {
		expect(
			resolveApiKeyEnvValue({ name: "CUSTOM_KEY", explicit: true }, " key "),
		).toBe("key");
		expect(() =>
			resolveApiKeyEnvValue({ name: "CUSTOM_KEY", explicit: true }, "  "),
		).toThrow(
			'apiKeyEnv environment variable "CUSTOM_KEY" is missing or empty',
		);
	});

	test("returns undefined for a missing optional default value", () => {
		expect(
			resolveApiKeyEnvValue(
				{ name: "PLEXUS_API_KEY", explicit: false },
				undefined,
			),
		).toBeUndefined();
	});
});

describe("resolvePlexusApiKey", () => {
	const explicit = { name: "CUSTOM_KEY", explicit: true };
	const defaultSetting = { name: "PLEXUS_API_KEY", explicit: false };

	test("explicit environment value wins over stored credentials", () => {
		expect(resolvePlexusApiKey(explicit, " env-key ", "stored-key")).toBe(
			"env-key",
		);
	});

	test("missing explicit value throws instead of falling back", () => {
		expect(() => resolvePlexusApiKey(explicit, "", "stored-key")).toThrow(
			'apiKeyEnv environment variable "CUSTOM_KEY" is missing or empty',
		);
	});

	test("default environment value wins, then stored value is preserved", () => {
		expect(resolvePlexusApiKey(defaultSetting, " env-key ", "stored-key")).toBe(
			"env-key",
		);
		expect(resolvePlexusApiKey(defaultSetting, undefined, " stored-key ")).toBe(
			" stored-key ",
		);
	});
});
