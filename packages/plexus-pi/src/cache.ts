import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PlexusApiResponse } from "../../plexus-models/src/index.ts";

const getCacheDir = (): string => join(getAgentDir(), "extensions", "plexus");
const getRawResponsePath = (): string => join(getCacheDir(), "plexus-models-response.json");
const getEtagPath = (): string => join(getCacheDir(), "plexus-models-etag.txt");

/**
 * Writes the raw API response to a diagnostics file. Creates directory if absent.
 */
export async function writeRawResponse(data: PlexusApiResponse): Promise<void> {
	await mkdir(getCacheDir(), { recursive: true });
	await writeFile(getRawResponsePath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function readCachedEtag(): Promise<string | undefined> {
	try {
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
