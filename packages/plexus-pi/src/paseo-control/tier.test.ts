import { describe, expect, test } from "bun:test";
import type { ServiceTierPolicy } from "../service-tiers.ts";
import { NO_TIER } from "./protocol.ts";
import { isTierApplicable, resolveSavedTier } from "./tier.ts";

const policy: ServiceTierPolicy = {
	provider: "plexus",
	modelId: "gpt-5.6",
	serviceTiers: ["auto", "flex"],
};

describe("resolveSavedTier", () => {
	test("keeps a tier that is advertised", () => {
		expect(resolveSavedTier("flex", ["flex", "auto"])).toBe("flex");
	});

	test("migrates legacy fast to priority and legacy default to auto", () => {
		expect(resolveSavedTier("fast", ["standard", "priority"])).toBe("priority");
		expect(resolveSavedTier("default", ["auto", "standard"])).toBe("auto");
	});

	test("falls back to auto, then standard, when the saved tier is not advertised", () => {
		expect(resolveSavedTier("ultrafast", ["auto", "standard"])).toBe("auto");
		expect(resolveSavedTier("ultrafast", ["standard", "flex"])).toBe(
			"standard",
		);
	});

	test("starts unselected for premium-only lists", () => {
		expect(resolveSavedTier(NO_TIER, ["priority", "flex"])).toBe(NO_TIER);
		expect(resolveSavedTier("ultrafast", ["priority", "flex"])).toBe(NO_TIER);
	});

	test("returns no tier when nothing is advertised", () => {
		expect(resolveSavedTier("flex", [])).toBe(NO_TIER);
	});
});

describe("isTierApplicable", () => {
	const plexusModel = { provider: "plexus", id: "gpt-5.6" };

	test("applies only to the advertised Plexus model and tier", () => {
		expect(isTierApplicable(plexusModel, "flex", policy)).toBe(true);
		expect(isTierApplicable(plexusModel, "priority", policy)).toBe(false);
	});

	test("does not apply to other providers, other models, or missing policies", () => {
		expect(
			isTierApplicable({ provider: "other", id: "gpt-5.6" }, "flex", policy),
		).toBe(false);
		expect(
			isTierApplicable({ provider: "plexus", id: "claude" }, "flex", policy),
		).toBe(false);
		expect(isTierApplicable(undefined, "flex", policy)).toBe(false);
		expect(isTierApplicable(plexusModel, "flex", undefined)).toBe(false);
		expect(isTierApplicable(plexusModel, NO_TIER, policy)).toBe(false);
	});
});
