import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToOhMyPiModels } from "./mapper.ts";

test("OMP resolves dynamic Plexus pricing windows", async () => {
	const dir = mkdtempSync(join(tmpdir(), "plexus-windows-"));
	const auth = await AuthStorage.create(":memory:");
	try {
		const models = convertToOhMyPiModels(
			[
				{
					id: "break-500",
					context_length: 1_050_000,
					pricing: {
						prompt: "0.000001",
						tiers: [{ input_tokens_above: 500_000, prompt: "0.000002" }],
					},
				},
				{
					id: "break-272",
					context_length: 1_050_000,
					pricing: { tiers: [{ input_tokens_above: 272_000 }] },
				},
				{
					id: "small",
					context_length: 100_000,
					pricing: { tiers: [{ input_tokens_above: 272_000 }] },
				},
				{ id: "plain", context_length: 1_050_000 },
			],
			"https://example.invalid/v1",
		);
		for (const extendedContext of [false, true]) {
			const settings = Settings.isolated({ extendedContext });
			const registry = new ModelRegistry(
				auth,
				join(dir, `models-${extendedContext}.yml`),
				{ settings },
			);
			registry.registerProvider("plexus", {
				api: "openai-completions",
				baseUrl: "https://example.invalid/v1",
				fetchDynamicModels: async () => models,
			});
			await registry.refreshRuntimeProviders();
			const windows = models.map(
				(m) => registry.find("plexus", m.id)?.contextWindow,
			);
			console.log(
				`extendedContext=${extendedContext}: ${models.map((m, i) => `${m.id}=${windows[i]}`).join(", ")}`,
			);
			expect(windows).toEqual([
				extendedContext ? 1_050_000 : 500_000,
				extendedContext ? 1_050_000 : 272_000,
				100_000,
				1_050_000,
			]);
			expect(
				registry.find("plexus", "break-500")?.cost.longContext?.input,
			).toBe(2);
		}
		const settings = Settings.isolated({
			extendedContext: false,
			"compaction.modelThresholds": { "plexus/break-500": 600_000 },
		});
		const registry = new ModelRegistry(auth, join(dir, "compaction.yml"), {
			settings,
		});
		registry.registerProvider("plexus", {
			api: "openai-completions",
			baseUrl: "https://example.invalid/v1",
			fetchDynamicModels: async () => models,
		});
		await registry.refreshRuntimeProviders();
		expect(registry.find("plexus", "break-500")?.contextWindow).toBe(1_050_000);
		expect(registry.find("plexus", "break-272")?.contextWindow).toBe(272_000);
		const overridePath = join(dir, "override.json");
		writeFileSync(
			overridePath,
			JSON.stringify({
				providers: {
					plexus: {
						modelOverrides: { "break-500": { contextWindow: 350_000 } },
					},
				},
			}),
		);
		const overridden = new ModelRegistry(auth, overridePath, {
			settings: Settings.isolated({ extendedContext: true }),
		});
		overridden.registerProvider("plexus", {
			api: "openai-completions",
			baseUrl: "https://example.invalid/v1",
			fetchDynamicModels: async () => models,
		});
		await overridden.refreshRuntimeProviders();
		expect(overridden.find("plexus", "break-500")?.contextWindow).toBe(350_000);
	} finally {
		auth.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
