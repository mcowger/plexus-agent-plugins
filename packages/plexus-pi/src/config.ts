import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
	getEnvSuppressedModels,
	parseSuppressionPatterns,
} from "../../plexus-models/src/index.ts";

const getConfigDir = (): string => join(getAgentDir(), "extensions", "plexus");
const getConfigPath = (): string => join(getConfigDir(), "config.json");

const ENV_BASE_URL = "PLEXUS_BASE_URL";
const ENV_API_URL = "PLEXUS_API_URL";
const ENV_API_KEY = "PLEXUS_API_KEY";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

interface PlexusConfig {
	baseUrl?: string;
	apiKeyEnv?: string;
	suppressModels?: string | string[];
	suppress?: string | string[];
}

const normalizeRoot = (raw: string): string => raw.trim().replace(/\/+$/, "");

export function resolveConfigTemplate(value: string): string | undefined {
	let result = "";
	let index = 0;

	while (index < value.length) {
		const dollarIndex = value.indexOf("$", index);
		if (dollarIndex < 0) {
			result += value.slice(index);
			break;
		}

		result += value.slice(index, dollarIndex);
		const nextChar = value[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			result += nextChar;
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = value.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				result += "$";
				index = dollarIndex + 1;
				continue;
			}

			const name = value.slice(dollarIndex + 2, endIndex);
			if (!ENV_VAR_NAME_RE.test(name)) {
				result += value.slice(dollarIndex, endIndex + 1);
				index = endIndex + 1;
				continue;
			}

			const envValue = process.env[name];
			if (envValue === undefined) return undefined;
			result += envValue;
			index = endIndex + 1;
			continue;
		}

		const match = value.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			const envValue = process.env[match[0]];
			if (envValue === undefined) return undefined;
			result += envValue;
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		result += "$";
		index = dollarIndex + 1;
	}

	return result;
}

function resolveStringOption(
	value: string | undefined | null,
): string | undefined {
	if (!value) return undefined;
	const resolved = resolveConfigTemplate(value)?.trim();
	return resolved || undefined;
}

const normalizeConfigBaseUrl = (raw: string): string => {
	const root = normalizeRoot(raw);
	return root.endsWith("/v1") ? root.slice(0, -3) : root;
};

export const toPlexusApiBase = (raw: string): string => {
	const root = normalizeConfigBaseUrl(raw);
	return root ? `${root}/v1` : "";
};

/** Cached parsed config, resolved once per process and invalidated on write.
 *  Avoids re-issuing a sync file read on every getBaseUrl/getModelsUrl/
 *  getBaseUrl call. */
let cachedConfig: PlexusConfig | null = null;

/** Clears the in-process config cache so the next read re-parses config.json. */
export function resetConfigCache(): void {
	cachedConfig = null;
}

export function getConfigSync(): PlexusConfig {
	if (cachedConfig) return cachedConfig;
	try {
		if (existsSync(getConfigPath())) {
			cachedConfig = JSON.parse(
				readFileSync(getConfigPath(), "utf8"),
			) as PlexusConfig;
			return cachedConfig;
		}
	} catch {}
	cachedConfig = {};
	return cachedConfig;
}

export async function saveBaseUrl(baseUrl: string): Promise<void> {
	await mkdir(getConfigDir(), { recursive: true });
	const { defaultModel: _defaultModel, ...existing } =
		getConfigSync() as PlexusConfig & { defaultModel?: unknown };
	const config: PlexusConfig = {
		...existing,
		baseUrl: normalizeConfigBaseUrl(baseUrl),
	};
	await writeFile(
		getConfigPath(),
		`${JSON.stringify(config, null, 2)}\n`,
		"utf8",
	);
	cachedConfig = config;
}

export type BaseUrlSource =
	| "PLEXUS_API_URL"
	| "PLEXUS_BASE_URL"
	| "saved"
	| "none";

export function getBaseUrlResolution(): {
	baseUrl: string | null;
	source: BaseUrlSource;
} {
	const config = getConfigSync();
	const apiUrl = resolveStringOption(process.env[ENV_API_URL]);
	if (apiUrl) return { baseUrl: apiUrl, source: ENV_API_URL };
	const baseUrl = resolveStringOption(process.env[ENV_BASE_URL]);
	if (baseUrl) return { baseUrl, source: ENV_BASE_URL };
	const saved = resolveStringOption(config.baseUrl);
	return { baseUrl: saved ?? null, source: saved ? "saved" : "none" };
}

/**
 * Resolve the API-key environment variable name from config.
 *
 * `apiKeyEnv` omitted preserves the default `PLEXUS_API_KEY` behavior. An
 * explicit value must be a valid environment variable name; anything else
 * throws a generic error that never echoes the configured value.
 */
function resolveApiKeyEnvSetting(): { name: string; explicit: boolean } {
	const raw = getConfigSync().apiKeyEnv;
	if (raw === undefined || raw === null)
		return { name: ENV_API_KEY, explicit: false };

	const name = typeof raw === "string" ? raw.trim() : "";
	if (!ENV_VAR_NAME_RE.test(name)) {
		throw new Error("Invalid apiKeyEnv: expected an environment variable name");
	}
	return { name, explicit: true };
}

/** Environment variable name Pi resolves for the provider API key template. */
export function getApiKeyEnvName(): string {
	return resolveApiKeyEnvSetting().name;
}

/** Whether `config.json` explicitly selects an API-key environment variable. */
export function isApiKeyEnvExplicit(): boolean {
	return resolveApiKeyEnvSetting().explicit;
}

function requireApiKeyEnvValue(name: string, raw: string | undefined): string {
	const value = raw?.trim();
	if (!value) {
		throw new Error(
			`apiKeyEnv environment variable "${name}" is missing or empty`,
		);
	}
	return value;
}

/**
 * Resolve the API key named by an explicit `apiKeyEnv` from a host-provided
 * environment reader.
 *
 * Returns undefined when the setting is omitted (the default `PLEXUS_API_KEY`
 * precedence still applies). When set it is authoritative: the named variable
 * must exist and be non-empty, otherwise this throws instead of falling back
 * to a stored credential or `PLEXUS_API_KEY`. Error messages name the variable
 * but never include its value.
 */
export async function resolveExplicitApiKeyFromEnv(
	readEnv: (name: string) => Promise<string | undefined>,
): Promise<string | undefined> {
	const { name, explicit } = resolveApiKeyEnvSetting();
	if (!explicit) return undefined;
	return requireApiKeyEnvValue(name, await readEnv(name));
}

/**
 * Synchronous `process.env` variant of {@link resolveExplicitApiKeyFromEnv}.
 *
 * Returns undefined when the setting is omitted. When set it is authoritative
 * and throws for a missing or empty variable rather than falling back.
 */
export function resolveExplicitApiKey(): string | undefined {
	const { name, explicit } = resolveApiKeyEnvSetting();
	if (!explicit) return undefined;
	return requireApiKeyEnvValue(name, process.env[name]);
}

/**
 * Resolve the effective API key for a Plexus request.
 *
 * Explicit `apiKeyEnv` is authoritative and ignores the stored credential. The
 * default chain keeps a stored credential ahead of the `PLEXUS_API_KEY`
 * process fallback.
 */
export function resolveApiKey(
	storedKey: string | undefined,
): string | undefined {
	const explicit = resolveExplicitApiKey();
	if (explicit) return explicit;
	return storedKey || getEnvApiKey() || undefined;
}

/** The default `PLEXUS_API_KEY` fallback; null when unset or empty. */
export function getEnvApiKey(): string | null {
	return resolveStringOption(process.env[ENV_API_KEY]) ?? null;
}

/** Returns <baseUrl>/v1/models, or null. */
export function getModelsUrl(): string | null {
	const { baseUrl } = getBaseUrlResolution();
	return baseUrl ? `${toPlexusApiBase(baseUrl)}/models` : null;
}

/** Returns the Plexus OpenAI API base, or null. Per-model dialects are adjusted later. */
export function getBaseUrl(): string | null {
	const { baseUrl } = getBaseUrlResolution();
	return baseUrl ? toPlexusApiBase(baseUrl) : null;
}

export function getSuppressedModels(): string[] {
	const config = getConfigSync();
	const envSuppressed = getEnvSuppressedModels();
	const configSuppressed = parseSuppressionPatterns(
		config.suppressModels ?? config.suppress,
	);
	return [...envSuppressed, ...configSuppressed];
}
