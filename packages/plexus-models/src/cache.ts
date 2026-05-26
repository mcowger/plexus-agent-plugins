import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelCache, PlexusApiResponse, PlexusModelDescriptor } from "./types.ts";

const PLEXUS_DIR = "extensions/plexus";
const CACHE_FILE = "plexus-models-cache.json";
const RAW_RESPONSE_FILE = "plexus-models-response.json";

function getCachePath(agentDir: string): string {
	return path.join(agentDir, PLEXUS_DIR, CACHE_FILE);
}

function getRawResponsePath(agentDir: string): string {
	return path.join(agentDir, PLEXUS_DIR, RAW_RESPONSE_FILE);
}

function parseCacheData(raw: string): ModelCache | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		if (!Array.isArray(obj["models"])) return null;
		return {
			models: obj["models"] as PlexusModelDescriptor[],
			timestamp: typeof obj["timestamp"] === "number" ? obj["timestamp"] : 0,
		};
	} catch {
		return null;
	}
}

/**
 * Asynchronously reads the cached model list.
 * Returns null if the file is absent, unreadable, or malformed. Never throws.
 */
export async function readCachedModels(agentDir: string): Promise<ModelCache | null> {
	try {
		const raw = await fs.promises.readFile(getCachePath(agentDir), "utf8");
		return parseCacheData(raw);
	} catch {
		return null;
	}
}

/**
 * Synchronously reads the cached model list.
 * Returns null if the file is absent, unreadable, or malformed. Never throws.
 * Used during extension startup where the module loading context is synchronous.
 */
export function readCachedModelsSync(agentDir: string): ModelCache | null {
	try {
		const raw = fs.readFileSync(getCachePath(agentDir), "utf8");
		return parseCacheData(raw);
	} catch {
		return null;
	}
}

/**
 * Asynchronously writes the model list to the cache file.
 * Creates the directory if absent.
 */
export async function writeCachedModels(
	agentDir: string,
	models: PlexusModelDescriptor[],
): Promise<void> {
	const cachePath = getCachePath(agentDir);
	await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
	const payload: ModelCache = { models, timestamp: Date.now() };
	await fs.promises.writeFile(cachePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

/**
 * Asynchronously writes the full raw API response to a separate diagnostics file.
 * Creates the directory if absent.
 * This file is not read back by any code in this package.
 */
export async function writeRawResponse(
	agentDir: string,
	data: PlexusApiResponse,
): Promise<void> {
	const rawPath = getRawResponsePath(agentDir);
	await fs.promises.mkdir(path.dirname(rawPath), { recursive: true });
	await fs.promises.writeFile(rawPath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
