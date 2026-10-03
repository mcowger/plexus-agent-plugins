import { describe, expect, test } from "bun:test";
import { contextPolicyFromApiModel, enforceMinimumOutputTokens } from "./extension.ts";
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
