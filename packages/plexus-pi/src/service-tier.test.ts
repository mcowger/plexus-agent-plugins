import { describe, expect, test } from "bun:test";
import {
	applyServiceTier,
	buildServiceTierNotification,
	isPriorityEligible,
	isTierSupportedByModel,
	parseServiceTierArg,
	type ServiceTierDialect,
	type ServiceTierModel,
} from "./service-tier.ts";

const model = (overrides: Partial<ServiceTierModel> = {}): ServiceTierModel => ({
	provider: "plexus",
	api: "openai-responses",
	id: "gpt-6-luna",
	...overrides,
});

describe("parseServiceTierArg", () => {
	test("maps aliases to canonical tiers", () => {
		expect(parseServiceTierArg("default")).toBe("default");
		expect(parseServiceTierArg("off")).toBe("default");
		expect(parseServiceTierArg("none")).toBe("default");
		expect(parseServiceTierArg("fast")).toBe("priority");
		expect(parseServiceTierArg("priority")).toBe("priority");
		expect(parseServiceTierArg("flex")).toBe("flex");
		expect(parseServiceTierArg("ultrafast")).toBe("ultrafast");
	});

	test("is case- and whitespace-insensitive", () => {
		expect(parseServiceTierArg("  FAST  ")).toBe("priority");
	});

	test("rejects unknown values", () => {
		expect(parseServiceTierArg("turbo")).toBeUndefined();
		expect(parseServiceTierArg("")).toBeUndefined();
	});
});

describe("isPriorityEligible", () => {
	test("accepts GPT 5+ and GPT 4.1+ families", () => {
		for (const id of [
			"gpt-5.5",
			"gpt-5.6-sol",
			"gpt-5.6-luna",
			"gpt-6",
			"gpt-6.1-preview",
			"gpt-6-astra",
			"gpt-5.10",
			"gpt-5",
			"gpt-5.4",
			"gpt-5.1-codex",
			"gpt-4.1",
			"gpt-4.1-nano",
		]) {
			expect(isPriorityEligible(id)).toBe(true);
		}
	});

	test("accepts the GPT-4o and o3/o4-mini families", () => {
		for (const id of ["gpt-4o", "gpt-4o-mini", "gpt-4o-2024-11-20", "o3", "o3-mini", "o4-mini"]) {
			expect(isPriorityEligible(id)).toBe(true);
		}
	});

	test("rejects unlisted families", () => {
		for (const id of ["gpt-4", "gpt-4-turbo", "o1", "claude-sonnet-4"]) {
			expect(isPriorityEligible(id)).toBe(false);
		}
	});
});

describe("applyServiceTier", () => {
	test("injects the canonical tier for an eligible Responses model", () => {
		const payload = { model: "gpt-5.6-luna" };
		expect(applyServiceTier(payload, model({ id: "gpt-5.6-luna" }), "flex", { provider: "plexus" })).toEqual({
			model: "gpt-5.6-luna",
			service_tier: "flex",
		});
	});

	test("does not mutate the original payload", () => {
		const payload = { model: "gpt-6-astra" };
		applyServiceTier(payload, model({ id: "gpt-6-astra" }), "ultrafast", { provider: "plexus" });
		expect(payload).toEqual({ model: "gpt-6-astra" });
	});

	test("leaves the payload alone for the default tier", () => {
		const payload = { model: "gpt-6-luna" };
		expect(applyServiceTier(payload, model(), "default", { provider: "plexus" })).toBe(payload);
	});

	test("ignores other providers", () => {
		const payload = { model: "gpt-6-luna" };
		expect(applyServiceTier(payload, model({ provider: "openai" }), "flex", { provider: "plexus" })).toBe(payload);
	});

	test("ignores non-Responses API dialects", () => {
		const payload = { model: "gpt-6-luna" };
		expect(applyServiceTier(payload, model({ api: "openai-completions" }), "flex", { provider: "plexus" })).toBe(payload);
	});

	test("ignores unlisted families", () => {
		const payload = { model: "gpt-4" };
		expect(applyServiceTier(payload, model({ id: "gpt-4" }), "priority", { provider: "plexus" })).toBe(payload);
	});

	test("allows priority for older Fast-mode families", () => {
		for (const id of ["gpt-5.4", "gpt-4.1-mini", "gpt-4o", "o3", "o4-mini"]) {
			expect(applyServiceTier({}, model({ id }), "priority", { provider: "plexus" })).toEqual({
				service_tier: "priority",
			});
		}
	});

	test("enforces per-tier model eligibility", () => {
		const missed = { model: "x" };
		expect(applyServiceTier(missed, model({ id: "gpt-5.5" }), "flex", { provider: "plexus" })).toBe(missed);
		expect(applyServiceTier(missed, model({ id: "gpt-5.6-luna" }), "ultrafast", { provider: "plexus" })).toBe(missed);
		expect(applyServiceTier(missed, model({ id: "gpt-5.6-terra" }), "flex", { provider: "plexus" })).toEqual({
			model: "x",
			service_tier: "flex",
		});
		expect(applyServiceTier(missed, model({ id: "gpt-5.6-sol-2025-08-01" }), "ultrafast", { provider: "plexus" })).toEqual({
			model: "x",
			service_tier: "ultrafast",
		});
	});

	test("accepts codex Responses models", () => {
		expect(applyServiceTier({}, model({ api: "openai-codex-responses", id: "gpt-6.1-codex" }), "priority", { provider: "plexus" })).toEqual({
			service_tier: "priority",
		});
	});

	test("leaves non-object payloads alone", () => {
		for (const payload of [undefined, null, "text", 7, []]) {
			expect(applyServiceTier(payload, model(), "flex", { provider: "plexus" })).toBe(payload);
		}
	});

	test("honors a custom dialect for a future API", () => {
		const dialect: ServiceTierDialect = {
			id: "future-api",
			apis: ["future-responses"],
			parameter: "tier",
			tiers: ["priority"],
			supportsModel: () => true,
			supportsTier: (_id, tier) => tier === "priority",
		};
		const payload = { model: "future-1" };
		expect(
			applyServiceTier(payload, model({ api: "future-responses", id: "future-1" }), "priority", {
				provider: "plexus",
				dialects: [dialect],
			}),
		).toEqual({ model: "future-1", tier: "priority" });
		expect(
			applyServiceTier(payload, model({ api: "future-responses", id: "future-1" }), "flex", {
				provider: "plexus",
				dialects: [dialect],
			}),
		).toBe(payload);
	});
});

describe("isTierSupportedByModel", () => {
	test("default is always supported", () => {
		expect(isTierSupportedByModel(undefined, "default")).toBe(true);
	});

	test("reports support for a matching model", () => {
		expect(isTierSupportedByModel(model({ id: "gpt-6-astra" }), "ultrafast")).toBe(true);
		expect(isTierSupportedByModel(model({ id: "gpt-5.6-terra" }), "flex")).toBe(true);
	});

	test("reports unsupported for mismatched model or API", () => {
		expect(isTierSupportedByModel(model({ id: "gpt-4" }), "priority")).toBe(false);
		expect(isTierSupportedByModel(model({ api: "anthropic-messages" }), "priority")).toBe(false);
		expect(isTierSupportedByModel(undefined, "flex")).toBe(false);
	});
});

describe("buildServiceTierNotification", () => {
	test("emits the stable Paseo notification shape", () => {
		const json = buildServiceTierNotification({
			tier: "priority",
			success: true,
			supported: true,
			provider: "plexus",
			model: "gpt-6-luna",
		});
		expect(JSON.parse(json)).toEqual({
			type: "plexus.serviceTier",
			command: "service-tier",
			success: true,
			tier: "priority",
			supported: true,
			provider: "plexus",
			model: "gpt-6-luna",
		});
	});
});
