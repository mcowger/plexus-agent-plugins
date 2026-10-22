import { describe, expect, test } from "bun:test";
import { ContextPolicySchema } from "./context-policy.ts";

const sample = {
	provider: "plexus",
	modelId: "exact-model-id",
	maxContextTokens: 100,
	shortContextBudgetTokens: 50,
};

describe("ContextPolicySchema", () => {
	test("accepts a short budget no larger than the maximum", () => {
		expect(ContextPolicySchema.safeParse(sample).success).toBe(true);
		expect(
			ContextPolicySchema.safeParse({
				...sample,
				shortContextBudgetTokens: 100,
			}).success,
		).toBe(true);
	});

	test("rejects a short budget above the maximum, unsafe, or non-positive values", () => {
		expect(
			ContextPolicySchema.safeParse({
				...sample,
				shortContextBudgetTokens: 101,
			}).success,
		).toBe(false);
		expect(
			ContextPolicySchema.safeParse({ ...sample, maxContextTokens: 0 }).success,
		).toBe(false);
		expect(
			ContextPolicySchema.safeParse({
				...sample,
				maxContextTokens: Number.MAX_SAFE_INTEGER + 1,
			}).success,
		).toBe(false);
	});
});
