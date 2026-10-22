import type { ServiceTierPolicy } from "../service-tiers.ts";
import { NO_TIER } from "./protocol.ts";

/**
 * Resolve a saved tier against the advertised choices. Legacy `fast` maps to
 * `priority` and legacy `default` to `auto`. Otherwise the fallback is `auto`,
 * then `standard`; with neither advertised the result is `NO_TIER`, so a
 * premium-only list starts unselected instead of at its first tier.
 */
export function resolveSavedTier(
	tier: string,
	choices: readonly string[],
): string {
	if (choices.includes(tier)) return tier;
	const migrated =
		tier === "fast" ? "priority" : tier === "default" ? "auto" : tier;
	if (choices.includes(migrated)) return migrated;
	if (choices.includes("auto")) return "auto";
	if (choices.includes("standard")) return "standard";
	return NO_TIER;
}

/** Whether `tier` is advertised by the Plexus model's service-tier policy. */
export function isTierApplicable(
	model: { provider?: string; id?: string } | undefined,
	tier: string,
	policy: ServiceTierPolicy | undefined,
): boolean {
	return (
		model?.provider === "plexus" &&
		policy?.provider === model.provider &&
		policy.modelId === model.id &&
		policy.serviceTiers.includes(tier)
	);
}
