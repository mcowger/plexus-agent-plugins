import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getSuppressedModels,
	resetConfigCache,
	resolveConfigTemplate,
	toPlexusApiBase,
} from "./config.ts";

const ORIGINAL_ENV = { ...process.env };
let agentDir: string;

beforeEach(() => {
	// Isolate from the developer's real ~/.pi config, which may set suppressModels.
	agentDir = mkdtempSync(join(tmpdir(), "plexus-pi-config-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetConfigCache();
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	resetConfigCache();
	rmSync(agentDir, { recursive: true, force: true });
});

test("builds Plexus endpoints once before model dialect adjustment", () => {
	expect(toPlexusApiBase("https://plexus.example.com")).toBe(
		"https://plexus.example.com/v1",
	);
	expect(toPlexusApiBase("https://plexus.example.com/v1/")).toBe(
		"https://plexus.example.com/v1",
	);
});

describe("pi config template resolution", () => {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR} template literal under test
	test("matches pi-style $VAR and ${VAR} interpolation", () => {
		process.env.PLEXUS_TEST_HOST = "https://plexus.example.com";
		process.env.PLEXUS_TEST_KEY = "secret";

		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR} template literal under test
		expect(resolveConfigTemplate("${PLEXUS_TEST_HOST}/v1")).toBe(
			"https://plexus.example.com/v1",
		);
		expect(resolveConfigTemplate("$PLEXUS_TEST_KEY")).toBe("secret");
		expect(resolveConfigTemplate("cost-$$5")).toBe("cost-$5");
	});

	test("returns undefined when a referenced env var is missing", () => {
		delete process.env.PLEXUS_MISSING_VAR;

		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${VAR} template literal under test
		expect(resolveConfigTemplate("${PLEXUS_MISSING_VAR}")).toBeUndefined();
	});

	test("resolves suppressed models from environment variable", () => {
		process.env.PLEXUS_SUPPRESS_MODELS = "gpt-3.5*, whisper";
		expect(getSuppressedModels()).toEqual(["gpt-3.5*", "whisper"]);
	});
});
