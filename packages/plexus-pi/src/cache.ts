import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PlexusApiResponse } from "../../plexus-models/src/index.ts";

const getCacheDir = (): string => join(getAgentDir(), "extensions", "plexus");
const getRawResponsePath = (): string => join(getCacheDir(), "plexus-models-response.json");

/**
 * Writes the raw API response to a diagnostics file. Creates directory if absent.
 */
export async function writeRawResponse(data: PlexusApiResponse): Promise<void> {
	await mkdir(getCacheDir(), { recursive: true });
	await writeFile(getRawResponsePath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
