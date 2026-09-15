import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export interface StoredModelCatalog {
	models: ProviderModelConfig[];
	checkedAt: number;
}

/** Pi owns persisted provider catalogs. This only restores its native store. */
export function readStoredModelsSync(): StoredModelCatalog | null {
	try {
		const path = join(getAgentDir(), "models-store.json");
		if (!existsSync(path)) return null;
		const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const plexus = data["plexus"];
		if (!plexus || typeof plexus !== "object" || Array.isArray(plexus)) return null;
		const catalog = plexus as Record<string, unknown>;
		if (!Array.isArray(catalog["models"])) return null;
		return {
			models: catalog["models"] as ProviderModelConfig[],
			checkedAt: typeof catalog["checkedAt"] === "number" ? catalog["checkedAt"] : 0,
		};
	} catch {
		return null;
	}
}
