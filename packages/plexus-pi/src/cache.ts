import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { PlexusApiResponse, PlexusModelDescriptor } from "../../plexus-models/src/index.ts";

const getCacheDir = (): string => join(getAgentDir(), "extensions", "plexus");
const getModelsCachePath = (): string => join(getCacheDir(), "plexus-models-cache.json");
const getRawResponsePath = (): string => join(getCacheDir(), "plexus-models-response.json");
const getEtagPath = (): string => join(getCacheDir(), "plexus-models-etag.txt");
const getModelsStorePath = (): string => join(getAgentDir(), "models-store.json");

export interface ModelCache {
	models?: PlexusModelDescriptor[];
	piModels?: ProviderModelConfig[];
	timestamp: number;
	etag?: string;
}

function isPlexusModelDescriptor(value: unknown): value is PlexusModelDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const model = value as Record<string, unknown>;
	const cost = model["cost"];
	return (
		typeof model["id"] === "string" &&
		typeof model["name"] === "string" &&
		typeof model["preferredApi"] === "string" &&
		model["provider"] === "plexus" &&
		typeof model["baseUrl"] === "string" &&
		typeof model["reasoning"] === "boolean" &&
		Array.isArray(model["input"]) &&
		typeof model["contextWindow"] === "number" &&
		typeof model["maxTokens"] === "number" &&
		!!cost &&
		typeof cost === "object" &&
		!Array.isArray(cost) &&
		typeof (cost as Record<string, unknown>)["input"] === "number" &&
		typeof (cost as Record<string, unknown>)["output"] === "number" &&
		typeof (cost as Record<string, unknown>)["cacheRead"] === "number" &&
		typeof (cost as Record<string, unknown>)["cacheWrite"] === "number"
	);
}

function parseCacheData(raw: string): ModelCache | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		if (!Array.isArray(obj["models"]) || !obj["models"].every(isPlexusModelDescriptor)) return null;
		return {
			models: obj["models"],
			timestamp: typeof obj["timestamp"] === "number" ? obj["timestamp"] : 0,
			etag: typeof obj["etag"] === "string" ? obj["etag"] : undefined,
		};
	} catch {
		return null;
	}
}

function parseModelsStoreData(raw: string): ModelCache | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		const plexusObj = obj["plexus"];
		if (!plexusObj) return null;

		let modelsList: ProviderModelConfig[] | null = null;
		let checkedAt = 0;

		if (Array.isArray(plexusObj)) {
			modelsList = plexusObj as ProviderModelConfig[];
		} else if (typeof plexusObj === "object" && plexusObj !== null) {
			const pObj = plexusObj as Record<string, unknown>;
			if (Array.isArray(pObj["models"])) {
				modelsList = pObj["models"] as ProviderModelConfig[];
			}
			if (typeof pObj["checkedAt"] === "number") {
				checkedAt = pObj["checkedAt"];
			}
		}

		if (!modelsList) return null;
		return {
			piModels: modelsList,
			timestamp: checkedAt,
		};
	} catch {
		return null;
	}
}

/**
 * Synchronously reads the cached model list.
 * First checks extension-specific cache (`plexus-models-cache.json`),
 * then falls back to Pi's native store (`models-store.json`).
 * Returns null if absent, unreadable, or malformed. Never throws.
 */
export function readCachedModelsSync(): ModelCache | null {
	try {
		const cachePath = getModelsCachePath();
		if (existsSync(cachePath)) {
			const cache = parseCacheData(readFileSync(cachePath, "utf8"));
			if (cache) return cache;
		}

		const storePath = getModelsStorePath();
		if (existsSync(storePath)) {
			const storeCache = parseModelsStoreData(readFileSync(storePath, "utf8"));
			if (storeCache) return storeCache;
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Writes the model list to the extension cache file. Creates directory if absent.
 */
export async function writeCachedModels(models: PlexusModelDescriptor[], etag?: string): Promise<void> {
	await mkdir(getCacheDir(), { recursive: true });
	const payload = { models, timestamp: Date.now(), etag };
	await writeFile(getModelsCachePath(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Writes the raw API response to a diagnostics file. Creates directory if absent.
 */
export async function writeRawResponse(data: PlexusApiResponse): Promise<void> {
	await mkdir(getCacheDir(), { recursive: true });
	await writeFile(getRawResponsePath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function readCachedEtag(): Promise<string | undefined> {
	try {
		const cache = readCachedModelsSync();
		if (cache?.etag) return cache.etag;
		const p = getEtagPath();
		if (!existsSync(p)) return undefined;
		return (await readFile(p, "utf8")).trim();
	} catch {
		return undefined;
	}
}

export async function writeCachedEtag(etag: string | undefined): Promise<void> {
	if (!etag) return;
	try {
		await mkdir(getCacheDir(), { recursive: true });
		await writeFile(getEtagPath(), etag, "utf8");
	} catch {
		// Ignore
	}
}
