import { z } from "zod";

/** Advertised service tiers for one Plexus model, exactly as the server names them. */
export const ServiceTierPolicySchema = z
	.object({
		provider: z.string().min(1),
		modelId: z.string().min(1),
		serviceTiers: z.array(z.string().min(1).max(100)).min(1).max(64),
	})
	.strict()
	.refine(
		(policy) =>
			new Set(policy.serviceTiers).size === policy.serviceTiers.length,
	);

export type ServiceTierPolicy = z.infer<typeof ServiceTierPolicySchema>;
