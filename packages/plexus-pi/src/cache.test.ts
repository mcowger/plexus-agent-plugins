import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCachedModelsSync, writeCachedModels } from "./cache.ts";
import type { PlexusModelDescriptor } from "../../plexus-models/src/index.ts";

const TEST_DIR = join(process.cwd(), "tmp-test-cache");
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	process.env["PI_CODING_AGENT_DIR"] = TEST_DIR;
	process.env["PI_AGENT_DIR"] = TEST_DIR;
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	process.env = { ...ORIGINAL_ENV };
});

describe("pi cache read / write sync", () => {
	test("returns null when cache and store files do not exist", () => {
		expect(readCachedModelsSync()).toBeNull();
	});

	test("writes and reads extension cache file", async () => {
		const sampleModels: PlexusModelDescriptor[] = [
			{
				id: "model-1",
				name: "Model 1",
				preferredApi: "openai-completions",
				provider: "plexus",
				baseUrl: "http://localhost/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 2048,
			},
		];

		await writeCachedModels(sampleModels, "etag-123");

		const cached = readCachedModelsSync();
		expect(cached).not.toBeNull();
		expect(cached?.etag).toBe("etag-123");
		expect(cached?.models).toHaveLength(1);
		expect(cached?.models?.[0]?.id).toBe("model-1");
	});

	test("falls back to reading models-store.json if extension cache is missing", () => {
		const storeContent = {
			plexus: {
				models: [
					{
						id: "store-model-1",
						name: "Store Model 1",
						provider: "plexus",
						api: "openai-completions",
						baseUrl: "http://localhost/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 4096,
						maxTokens: 2048,
					},
				],
				checkedAt: 1000000,
			},
		};

		writeFileSync(join(TEST_DIR, "models-store.json"), JSON.stringify(storeContent));

		const cached = readCachedModelsSync();
		expect(cached).not.toBeNull();
		expect(cached?.piModels).toHaveLength(1);
		expect(cached?.piModels?.[0]?.id).toBe("store-model-1");
		expect(cached?.timestamp).toBe(1000000);
	});
});
