import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const getConfigDir = (): string => join(getAgentDir(), "extensions", "plexus");
const getConfigPath = (): string => join(getConfigDir(), "config.json");

interface PlexusConfig {
	baseUrl?: string;
	defaultModel?: string;
}

const normalizeRoot = (raw: string): string => raw.replace(/\/+$/, "");

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
		baseUrl: normalizeRoot(baseUrl),
		...(defaultModel !== undefined && { defaultModel }),
	};
	await writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
	cachedConfig = config;
}

export function getRawBaseUrl(): string | null {
	const config = getConfigSync();
	if (config.baseUrl) return config.baseUrl;
	return process.env["PLEXUS_BASE_URL"] ?? null;
}

/** Returns <baseUrl>/v1/models, or null. */
export function getModelsUrl(): string | null {
	const raw = getRawBaseUrl();
	return raw ? `${normalizeRoot(raw)}/v1/models` : null;
}

/** Returns <baseUrl>/v1, or null. */
export function getBaseUrl(): string | null {
	const raw = getRawBaseUrl();
	return raw ? `${normalizeRoot(raw)}/v1` : null;
}

export function getDefaultModel(): string | null {
	return getConfigSync().defaultModel ?? null;
}
