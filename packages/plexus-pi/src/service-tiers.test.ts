import { describe, expect, test } from "bun:test";
import { serviceTierPolicyFromApiModel } from "./extension.ts";
import { ServiceTierPolicySchema } from "./service-tiers.ts";

const policy = {
	provider: "plexus",
	modelId: "registered-model-id",
	serviceTiers: ["standard", "flex", "priority", "ultrafast"],
};

describe("service-tier policy mapping", () => {
	test("uses exact model identity and advertised service tiers", () => {
		expect(
			serviceTierPolicyFromApiModel({
				id: "registered-model-id",
				name: "Display name",
				service_tiers: ["standard", "flex", "priority", "ultrafast"],
			}),
		).toEqual(policy);
	});

	test("does not advertise missing, empty, or invalid service-tier lists", () => {
		expect(serviceTierPolicyFromApiModel({ id: "no-support" })).toBeUndefined();
		expect(
			serviceTierPolicyFromApiModel({ id: "empty", service_tiers: [] }),
		).toBeUndefined();
		expect(
			serviceTierPolicyFromApiModel({
				id: "bad",
				service_tiers: ["standard", ""],
			}),
		).toBeUndefined();
		expect(
			serviceTierPolicyFromApiModel({
				id: "duplicate",
				service_tiers: ["flex", "flex"],
			}),
		).toBeUndefined();
	});
});

describe("ServiceTierPolicySchema", () => {
	test("requires unique, non-empty tier names and exact keys", () => {
		expect(ServiceTierPolicySchema.safeParse(policy).success).toBe(true);
		expect(
			ServiceTierPolicySchema.safeParse({
				...policy,
				serviceTiers: ["flex", "flex"],
			}).success,
		).toBe(false);
		expect(
			ServiceTierPolicySchema.safeParse({ ...policy, serviceTiers: [""] })
				.success,
		).toBe(false);
		expect(
			ServiceTierPolicySchema.safeParse({ ...policy, extra: true }).success,
		).toBe(false);
	});
});
