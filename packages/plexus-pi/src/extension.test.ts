import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { contextPolicyFromApiModel, createPolicyHost, enforceMinimumOutputTokens } from "./extension.ts";
import { MINIMUM_OUTPUT_TOKENS } from "./mapper.ts";

describe("contextPolicyFromApiModel", () => {
	test("uses context_length as total route capacity and the first tier boundary as short budget", () => {
		expect(contextPolicyFromApiModel({
			id: "exact-id", context_length: 1_048_576,
			pricing: { tiers: [{ input_tokens_above: 200_000 }] },
		})).toEqual({
			provider: "plexus", modelId: "exact-id", maxContextTokens: 1_048_576,
			shortContextBudgetTokens: 200_000, pricingThresholdInputTokens: 200_000,
		});
	});

	test("omits policies when either limit is unknown or inconsistent", () => {
		expect(contextPolicyFromApiModel({ id: "no-tier", context_length: 100 })).toBeUndefined();
		expect(contextPolicyFromApiModel({ id: "no-context", pricing: { tiers: [{ input_tokens_above: 50 }] } })).toBeUndefined();
		expect(contextPolicyFromApiModel({ id: "too-large-tier", context_length: 100, pricing: { tiers: [{ input_tokens_above: 101 }] } })).toBeUndefined();
	});
});

describe("enforceMinimumOutputTokens", () => {
	test("raises a context-clamped OpenAI completion limit", () => {
		expect(enforceMinimumOutputTokens({ max_completion_tokens: 1 })).toEqual({
			max_completion_tokens: MINIMUM_OUTPUT_TOKENS,
		});
	});

	test("raises output limits for each supported payload shape", () => {
		expect(enforceMinimumOutputTokens({ max_tokens: 1 })).toEqual({
			max_tokens: MINIMUM_OUTPUT_TOKENS,
		});
		expect(enforceMinimumOutputTokens({ max_output_tokens: 1 })).toEqual({
			max_output_tokens: MINIMUM_OUTPUT_TOKENS,
		});
		expect(enforceMinimumOutputTokens({ generationConfig: { maxOutputTokens: 1 } })).toEqual({
			generationConfig: { maxOutputTokens: MINIMUM_OUTPUT_TOKENS },
		});
	});
});

function policyModel(id: string, contextWindow: number): Model<any> {
	return { provider: "plexus", id, contextWindow } as unknown as Model<any>;
}

function policyEntry(id: string): ProviderModelConfig {
	return {
		id,
		name: id,
		provider: "plexus",
		plexusContextPolicy: {
			policy: { provider: "plexus", modelId: id, maxContextTokens: 1_000, shortContextBudgetTokens: 200 },
			fetchedAt: 1,
		},
		plexusServiceTiers: {
			policy: { provider: "plexus", modelId: id, serviceTiers: ["standard", "priority"] },
			fetchedAt: 1,
		},
	} as unknown as ProviderModelConfig;
}

describe("createPolicyHost", () => {
	test("resolves the committed advertisement and ignores non-plexus models", () => {
		const host = createPolicyHost({
			getActiveModel: () => policyModel("m1", 1_000),
			getModels: () => [policyEntry("m1")],
			getRegistry: () => undefined,
			setModel: async () => false,
			setActiveModel: () => {},
		});
		expect(host.getActiveModel()).toEqual({ provider: "plexus", id: "m1" });
		expect(host.getAdvertisement({ provider: "plexus", id: "m1" })).toMatchObject({
			context: { maxContextTokens: 1_000, shortContextBudgetTokens: 200 },
			serviceTier: { serviceTiers: ["standard", "priority"] },
		});
		expect(host.getAdvertisement({ provider: "plexus", id: "missing" })).toBeUndefined();

		const nonPlexus = createPolicyHost({
			getActiveModel: () => ({ provider: "openai", id: "gpt", contextWindow: 1 } as unknown as Model<any>),
			getModels: () => [policyEntry("m1")],
			getRegistry: () => undefined,
			setModel: async () => false,
			setActiveModel: () => {},
		});
		expect(nonPlexus.getActiveModel()).toBeUndefined();
	});

	test("applies a session-scoped context window and restores the catalog model", async () => {
		const applied: Array<Record<string, unknown>> = [];
		let active: Model<any> | undefined = policyModel("m1", 1_000);
		let canonical = policyModel("m1", 1_000);
		const registry = {
			find: () => canonical,
		} as unknown as ModelRegistry;
		const host = createPolicyHost({
			getActiveModel: () => active,
			getModels: () => [policyEntry("m1")],
			getRegistry: () => registry,
			setModel: async (model) => {
				applied.push(model as unknown as Record<string, unknown>);
				return true;
			},
			setActiveModel: (model) => {
				active = model;
			},
		});
		expect(await host.applyContextWindow({ provider: "plexus", id: "m1" }, 200)).toBe(200);
		expect(applied).toHaveLength(1);
		expect(applied[0]!.contextWindow).toBe(200);
		expect(active?.contextWindow).toBe(200);
		expect(await host.applyContextWindow({ provider: "plexus", id: "m1" }, undefined)).toBe(1_000);
		expect(applied).toHaveLength(2);

		canonical = policyModel("m1", 1_000);
		active = policyModel("m1", 1_000);
		expect(await host.applyContextWindow({ provider: "plexus", id: "m1" }, 1_000)).toBe(1_000);
		expect(applied).toHaveLength(2);
	});

	test("returns undefined when no registry or catalog model exists", async () => {
		const host = createPolicyHost({
			getActiveModel: () => policyModel("m1", 1_000),
			getModels: () => [policyEntry("m1")],
			getRegistry: () => undefined,
			setModel: async () => true,
			setActiveModel: () => {},
		});
		expect(await host.applyContextWindow({ provider: "plexus", id: "m1" }, 200)).toBeUndefined();
	});
});
