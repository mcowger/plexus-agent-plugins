import * as fs from "node:fs";
import * as path from "node:path";

const PLEXUS_DIR = "extensions/plexus";
const CONFIG_FILE = "config.json";

function getConfigPath(agentDir: string): string {
	return path.join(agentDir, PLEXUS_DIR, CONFIG_FILE);
}

interface PlexusConfig {
	baseUrl?: string;
	defaultModel?: string;
	[key: string]: unknown;
}

/**
 * Synchronously reads the Plexus config file.
 * Returns {} on any error (file absent, unreadable, malformed JSON). Never throws.
 */
export function getConfigSync(agentDir: string): PlexusConfig {
	try {
		const raw = fs.readFileSync(getConfigPath(agentDir), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as PlexusConfig;
		}
		return {};
	} catch {
		return {};
	}
}

/**
 * Asynchronously writes baseUrl (and optionally defaultModel) to the config file.
 * Creates the directory tree if it does not exist.
 * Merges with any existing config fields (preserving unknown fields).
 * Trailing slashes are stripped from baseUrl before storage.
 */
export async function saveBaseUrl(
	agentDir: string,
	baseUrl: string,
	defaultModel?: string,
): Promise<void> {
	const configPath = getConfigPath(agentDir);
	const dir = path.dirname(configPath);
	await fs.promises.mkdir(dir, { recursive: true });

	const existing = getConfigSync(agentDir);
	const updated: PlexusConfig = {
		...existing,
		baseUrl: baseUrl.replace(/\/+$/, ""),
	};
	if (defaultModel !== undefined) {
		updated.defaultModel = defaultModel;
	}

	await fs.promises.writeFile(configPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
}

/**
 * Returns the raw stored base URL (no suffix appended), or the PLEXUS_BASE_URL
 * env var, or null. Trailing slashes are stripped.
 */
export function getRawBaseUrl(agentDir: string): string | null {
	const cfg = getConfigSync(agentDir);
	const raw = cfg.baseUrl ?? process.env["PLEXUS_BASE_URL"] ?? null;
	if (!raw) return null;
	return raw.replace(/\/+$/, "");
}

/** Returns the base URL with /v1 appended, or null. */
export function getBaseUrl(agentDir: string): string | null {
	const raw = getRawBaseUrl(agentDir);
	return raw ? `${raw}/v1` : null;
}

/** Returns the models endpoint URL (/v1/models), or null. */
export function getModelsUrl(agentDir: string): string | null {
	const raw = getRawBaseUrl(agentDir);
	return raw ? `${raw}/v1/models` : null;
}

/** Returns the configured default model, or null. */
export function getDefaultModel(agentDir: string): string | null {
	const cfg = getConfigSync(agentDir);
	return cfg.defaultModel ?? null;
}
