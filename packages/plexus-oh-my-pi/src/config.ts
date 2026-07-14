import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

const getConfigDir = (): string => join(getAgentDir(), "extensions", "plexus");
const getConfigPath = (): string => join(getConfigDir(), "config.json");

const ENV_BASE_URL = "PLEXUS_BASE_URL";
const ENV_API_URL = "PLEXUS_API_URL";
const ENV_API_KEY = "PLEXUS_API_KEY";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

interface PlexusConfig {
	baseUrl?: string;
	defaultModel?: string;
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

function resolveStringOption(value: string | undefined | null): string | undefined {
	if (!value) return undefined;
	const resolved = resolveConfigTemplate(value)?.trim();
	return resolved || undefined;
}

const normalizeConfigBaseUrl = (raw: string): string => {
	const root = normalizeRoot(raw);
	return root.endsWith("/v1") ? root.slice(0, -3) : root;
};

const normalizeApiBase = (raw: string): string => {
	const root = normalizeConfigBaseUrl(raw);
	return root ? `${root}/v1` : "";
};

/** Cached parsed config, resolved once per process and invalidated on write.
 *  Avoids re-issuing a sync file read on every getBaseUrl/getModelsUrl/
 *  getDefaultModel call. */
let cachedConfig: PlexusConfig | null = null;

export function getConfigSync(): PlexusConfig {
	if (cachedConfig) return cachedConfig;
	try {
		if (existsSync(getConfigPath())) {
			cachedConfig = JSON.parse(readFileSync(getConfigPath(), "utf8")) as PlexusConfig;
			return cachedConfig;
		}
	} catch {}
	cachedConfig = {};
	return cachedConfig;
}

export async function saveBaseUrl(baseUrl: string, defaultModel?: string): Promise<void> {
	await mkdir(getConfigDir(), { recursive: true });
	const existing = getConfigSync();
	const config: PlexusConfig = {
		...existing,
		baseUrl: normalizeConfigBaseUrl(baseUrl),
		...(defaultModel !== undefined && { defaultModel }),
	};
	await writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
	cachedConfig = config;
}

export async function saveDefaultModel(defaultModel: string): Promise<void> {
	await mkdir(getConfigDir(), { recursive: true });
	const config: PlexusConfig = { ...getConfigSync(), defaultModel };
	await writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
	cachedConfig = config;
}

export function getRawBaseUrl(): string | null {
	const config = getConfigSync();
	return (
		resolveStringOption(process.env[ENV_API_URL]) ??
		resolveStringOption(process.env[ENV_BASE_URL]) ??
		resolveStringOption(config.baseUrl) ??
		null
	);
}

export function getEnvApiKey(): string | null {
	return resolveStringOption(process.env[ENV_API_KEY]) ?? null;
}

/** Returns <baseUrl>/v1/models, or null. */
export function getModelsUrl(): string | null {
	const raw = getRawBaseUrl();
	return raw ? `${normalizeApiBase(raw)}/models` : null;
}

/** Returns <baseUrl>/v1, or null. */
export function getBaseUrl(): string | null {
	const raw = getRawBaseUrl();
	return raw ? normalizeApiBase(raw) : null;
}

export function getDefaultModel(): string | null {
	return getConfigSync().defaultModel ?? null;
}
