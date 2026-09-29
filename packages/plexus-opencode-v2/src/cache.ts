import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	isChatModel,
	isModelSuppressed,
	type PlexusApiResponse,
} from "../../plexus-models/src/index.ts";
import type { CachedModel } from "./mapper.ts";

const PLUGIN_SUBDIR = join("plugins", "plexus");
const CACHE_FILE = "models-cache-v2.json";
const RAW_FILE = "models-raw.json";

/** ~/.local/share/opencode/plugins/plexus — never route through the server. */
export function getDir(): string {
	const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(dataHome, "opencode", PLUGIN_SUBDIR);
}

export interface ModelCacheFile {
	models: CachedModel[];
	timestamp: number;
	etag?: string;
}

/**
 * Re-filter cached entries so caches written by older plugin versions cannot
 * reintroduce endpoint-specific (non-chat) models into the picker. Applies
 * isModelSuppressed + isChatModel over the stored modality metadata.
 */
export function filterCachedModels(
	models: CachedModel[],
	suppress?: string | string[] | null,
): CachedModel[] {
	return models.filter((model) => {
		if (isModelSuppressed({ id: model.id, name: model.name }, suppress)) return false;
		return isChatModel({
			id: model.id,
			name: model.name,
			architecture: {
				input_modalities: model.capabilities.input,
				output_modalities: model.capabilities.output,
			},
		});
	});
}

/** Read cached models. Returns filtered models + etag, or null on any error. */
export async function readCachedModels(
	suppress?: string | string[] | null,
): Promise<{ models: CachedModel[]; etag?: string } | null> {
	try {
		const content = await readFile(join(getDir(), CACHE_FILE), "utf8");
		const parsed = JSON.parse(content) as ModelCacheFile;
		if (parsed && Array.isArray(parsed.models)) {
			return {
				models: filterCachedModels(parsed.models, suppress),
				etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
			};
		}
		return null;
	} catch {
		return null;
	}
}

/** Write the model cache and (optionally) raw API response. Never throws. */
export async function writeCache(
	models: CachedModel[],
	raw?: PlexusApiResponse,
	etag?: string,
): Promise<void> {
	try {
		const dir = getDir();
		await mkdir(dir, { recursive: true });

		const cache: ModelCacheFile = { models, timestamp: Date.now(), etag };
		await writeFile(join(dir, CACHE_FILE), JSON.stringify(cache, null, 2) + "\n", "utf8");

		if (raw !== undefined) {
			await writeFile(join(dir, RAW_FILE), JSON.stringify(raw, null, 2) + "\n", "utf8");
		}
	} catch {
		// Never block plugin init on cache write failures
	}
}
