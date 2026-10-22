import { z } from "zod";

/** Context budgets for one Plexus model, derived from its pricing tiers and context length. */
export const ContextPolicySchema = z
	.object({
		provider: z.string().min(1),
		modelId: z.string().min(1),
		maxContextTokens: z.number().int().positive().safe(),
		shortContextBudgetTokens: z.number().int().positive().safe(),
		pricingThresholdInputTokens: z.number().int().positive().safe().optional(),
	})
	.refine(
		(policy) => policy.shortContextBudgetTokens <= policy.maxContextTokens,
	);

export type ContextPolicy = z.infer<typeof ContextPolicySchema>;
