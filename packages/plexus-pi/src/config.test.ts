import { afterEach, describe, expect, test } from "bun:test";
import { resolveConfigTemplate } from "./config.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe("pi config template resolution", () => {
	test("matches pi-style $VAR and ${VAR} interpolation", () => {
		process.env["PLEXUS_TEST_HOST"] = "https://plexus.example.com";
		process.env["PLEXUS_TEST_KEY"] = "secret";

		expect(resolveConfigTemplate("${PLEXUS_TEST_HOST}/v1")).toBe("https://plexus.example.com/v1");
		expect(resolveConfigTemplate("$PLEXUS_TEST_KEY")).toBe("secret");
		expect(resolveConfigTemplate("cost-$$5")).toBe("cost-$5");
	});

	test("returns undefined when a referenced env var is missing", () => {
		delete process.env["PLEXUS_MISSING_VAR"];

		expect(resolveConfigTemplate("${PLEXUS_MISSING_VAR}")).toBeUndefined();
	});
});
