import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { PlexusApiResponse, PlexusModelDescriptor } from "../../plexus-models/src/index.ts";

const getCacheDir = (): string => join(getAgentDir(), "extensions", "plexus");
const getModelsCachePath = (): string => join(getCacheDir(), "plexus-models-cache.json");
const getRawResponsePath = (): string => join(getCacheDir(), "plexus-models-response.json");

interface ModelCache {
	models: PlexusModelDescriptor[];
	timestamp: number;
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
 * Synchronously reads the cached model list.
 * Returns null if absent, unreadable, or malformed. Never throws.
 */
export function readCachedModelsSync(): ModelCache | null {
	try {
		const p = getModelsCachePath();
		if (!existsSync(p)) return null;
		return parseCacheData(readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Writes the model list to the cache file. Creates directory if absent.
 */
export async function writeCachedModels(models: PlexusModelDescriptor[]): Promise<void> {
	await mkdir(getCacheDir(), { recursive: true });
	const payload: ModelCache = { models, timestamp: Date.now() };
	await writeFile(getModelsCachePath(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Writes the raw API response to a diagnostics file. Creates directory if absent.
 */
export async function writeRawResponse(data: PlexusApiResponse): Promise<void> {
	await mkdir(getCacheDir(), { recursive: true });
	await writeFile(getRawResponsePath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
