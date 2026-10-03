import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import {
	getApiKeyEnvName,
	getEnvApiKey,
	getSuppressedModels,
	resetConfigCache,
	resolveApiKey,
	resolveConfigTemplate,
	resolveExplicitApiKey,
	toPlexusApiBase,
} from "./config.ts";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_AGENT_DIR = getAgentDir();
const CONFIG_TEMP_DIR = mkdtempSync(join(tmpdir(), "plexus-omp-config-"));
const CONFIG_DIR = join(CONFIG_TEMP_DIR, "extensions", "plexus");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const CUSTOM_ENV = "AIHOME_OMP_API_KEY";

beforeAll(() => {
	setAgentDir(CONFIG_TEMP_DIR);
});

afterAll(() => {
	setAgentDir(ORIGINAL_AGENT_DIR);
	rmSync(CONFIG_TEMP_DIR, { recursive: true, force: true });
});

function writeConfig(config: unknown): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(config), "utf8");
	resetConfigCache();
}

function clearConfig(): void {
	rmSync(CONFIG_PATH, { force: true });
	resetConfigCache();
}

beforeEach(() => {
	clearConfig();
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

test("builds Plexus endpoints once before model dialect adjustment", () => {
	expect(toPlexusApiBase("https://plexus.example.com")).toBe("https://plexus.example.com/v1");
	expect(toPlexusApiBase("https://plexus.example.com/v1/")).toBe("https://plexus.example.com/v1");
});

describe("oh-my-pi config template resolution", () => {
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

	test("resolves suppressed models from environment variable", () => {
		process.env["PLEXUS_SUPPRESS_MODELS"] = "claude-2*, gpt-3.5*";
		expect(getSuppressedModels()).toEqual(["claude-2*", "gpt-3.5*"]);
	});
});

describe("apiKeyEnv default behavior", () => {
	test("omitted apiKeyEnv uses PLEXUS_API_KEY", () => {
		process.env["PLEXUS_API_KEY"] = "default-key";

		expect(getApiKeyEnvName()).toBe("PLEXUS_API_KEY");
		expect(resolveExplicitApiKey()).toBeUndefined();
		expect(getEnvApiKey()).toBe("default-key");
	});

	test("omitted apiKeyEnv leaves PLEXUS_API_KEY optional", () => {
		delete process.env["PLEXUS_API_KEY"];

		expect(getEnvApiKey()).toBeNull();
		expect(resolveApiKey("stored-key")).toBe("stored-key");
		expect(resolveApiKey(undefined)).toBeNull();
	});
});

describe("apiKeyEnv custom variable", () => {
	test("selects the named environment variable", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env[CUSTOM_ENV] = "custom-key";

		expect(getApiKeyEnvName()).toBe(CUSTOM_ENV);
		expect(resolveExplicitApiKey()).toBe("custom-key");
		expect(resolveApiKey("stored-key")).toBe("custom-key");
	});

	test("trims whitespace from the named variable", () => {
		writeConfig({ apiKeyEnv: `  ${CUSTOM_ENV}  ` });
		process.env[CUSTOM_ENV] = "  custom-key  ";

		expect(getApiKeyEnvName()).toBe(CUSTOM_ENV);
		expect(resolveExplicitApiKey()).toBe("custom-key");
	});
});

describe("apiKeyEnv missing and empty", () => {
	test("missing variable throws without falling back", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env["PLEXUS_API_KEY"] = "default-key";

		expect(() => resolveExplicitApiKey()).toThrow(/is missing or empty/);
		expect(() => resolveApiKey("stored-key")).toThrow(/is missing or empty/);
	});

	test("empty variable throws without falling back", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env["PLEXUS_API_KEY"] = "default-key";

		for (const value of ["", "   "]) {
			process.env[CUSTOM_ENV] = value;
			expect(() => resolveExplicitApiKey()).toThrow(/is missing or empty/);
			expect(() => resolveApiKey("stored-key")).toThrow(/is missing or empty/);
		}
	});

	test("error names the variable without including a value", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });

		try {
			resolveExplicitApiKey();
			throw new Error("expected resolveExplicitApiKey to throw");
		} catch (error) {
			expect(String(error)).toContain(CUSTOM_ENV);
		}
	});
});

describe("apiKeyEnv validation", () => {
	test("invalid name throws a generic error that does not echo the input", () => {
		const invalid = "not a var!";
		writeConfig({ apiKeyEnv: invalid });

		expect(() => getApiKeyEnvName()).toThrow(/Invalid apiKeyEnv/);
		try {
			getApiKeyEnvName();
		} catch (error) {
			expect(String(error)).not.toContain(invalid);
		}
	});

	test("empty and non-string names are invalid", () => {
		writeConfig({ apiKeyEnv: "" });
		expect(() => getApiKeyEnvName()).toThrow(/Invalid apiKeyEnv/);

		writeConfig({ apiKeyEnv: 42 });
		expect(() => getApiKeyEnvName()).toThrow(/Invalid apiKeyEnv/);
	});
});

describe("apiKeyEnv precedence", () => {
	test("default keeps the host-resolved key ahead of the process fallback", () => {
		process.env["PLEXUS_API_KEY"] = "env-key";
		expect(resolveApiKey("stored-key")).toBe("stored-key");
	});

	test("default falls back to PLEXUS_API_KEY when no stored credential exists", () => {
		process.env["PLEXUS_API_KEY"] = "env-key";
		expect(resolveApiKey(undefined)).toBe("env-key");
	});

	test("explicit apiKeyEnv outranks the stored credential", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env[CUSTOM_ENV] = "custom-key";
		process.env["PLEXUS_API_KEY"] = "env-key";
		expect(resolveApiKey("stored-key")).toBe("custom-key");
	});

	test("explicit apiKeyEnv is authoritative even when it names PLEXUS_API_KEY", () => {
		writeConfig({ apiKeyEnv: "PLEXUS_API_KEY" });
		process.env["PLEXUS_API_KEY"] = "explicit-key";
		expect(resolveApiKey("stored-key")).toBe("explicit-key");
	});
});
