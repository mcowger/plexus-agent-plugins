import { describe, expect, test } from "bun:test";
import type { PlexusApiModel } from "../../plexus-models/src/index.ts";
import type { PlexusModelInfo } from "./mapper.ts";
import {
	CONTEXT_BUDGET_OPTION,
	effectiveContextWindow,
	formatContextStatus,
	formatTierStatus,
	injectServiceTier,
	injectServiceTierIntoBody,
	parseContextCommand,
	parseTierCommand,
	policyAdvertisementFromApiModel,
	policyAvailability,
	SessionPolicyStore,
	withServiceTier,
} from "./session-policy.ts";

function apiModel(
	overrides: Partial<PlexusApiModel> & { id: string },
): PlexusApiModel {
	return { ...overrides };
}

function tieredModel(
	id: string,
	extra?: Partial<PlexusApiModel>,
): PlexusApiModel {
	return apiModel({
		id,
		context_length: 1_000_000,
		pricing: {
			prompt: "0.000001",
			completion: "0.000002",
			tiers: [{ input_tokens_above: 200_000 }],
		},
		service_tiers: ["standard", "flex", "priority"],
		...extra,
	});
}

const REF = { providerID: "plexus", id: "m1" };

function infosFrom(models: PlexusApiModel[]): PlexusModelInfo[] {
	return models.map((m) => ({
		id: m.id,
		modelID: m.id,
		providerID: "plexus",
		name: m.id,
		capabilities: { tools: false, input: ["text"], output: ["text"] },
		variants: [],
		time: { released: 0 },
		cost: [],
		status: "active" as const,
		enabled: true,
		limit: { context: 1_000_000, output: 32_000 },
		...(policyAdvertisementFromApiModel(m)
			? { policy: policyAdvertisementFromApiModel(m) }
			: {}),
	}));
}

function storeWith(models: PlexusApiModel[]): SessionPolicyStore {
	const store = new SessionPolicyStore();
	store.setCatalog(infosFrom(models));
	return store;
}

describe("policy advertisement from fixture catalogs", () => {
	test("advertises tiers verbatim with short/max budgets", () => {
		const policy = policyAdvertisementFromApiModel(tieredModel("m1"));
		expect(policy).toEqual({
			serviceTiers: ["standard", "flex", "priority"],
			shortContextBudgetTokens: 200_000,
			maxContextTokens: 1_000_000,
		});
		expect(policyAvailability(policy)).toEqual({
			longContext: true,
			serviceTier: true,
		});
		expect(
			effectiveContextWindow(policy, {
				longContext: false,
				serviceTier: null,
			}),
		).toBe(200_000);
		expect(
			effectiveContextWindow(policy, { longContext: true, serviceTier: null }),
		).toBe(1_000_000);
	});

	test("uses only the first pricing tier as the short budget", () => {
		const policy = policyAdvertisementFromApiModel(
			tieredModel("m1", {
				pricing: {
					prompt: "0.000001",
					tiers: [
						{ input_tokens_above: 100_000 },
						{ input_tokens_above: 500_000 },
					],
				},
			}),
		);
		expect(policy?.shortContextBudgetTokens).toBe(100_000);
	});

	test("tiers without a context budget still advertise tiers", () => {
		const policy = policyAdvertisementFromApiModel(
			apiModel({ id: "m1", service_tiers: ["flex"] }),
		);
		expect(policy).toEqual({ serviceTiers: ["flex"] });
		expect(policyAvailability(policy)).toEqual({
			longContext: false,
			serviceTier: true,
		});
		expect(
			effectiveContextWindow(policy, {
				longContext: false,
				serviceTier: null,
			}),
		).toBeUndefined();
	});

	test("context budget without tiers still advertises the budget", () => {
		const policy = policyAdvertisementFromApiModel(
			tieredModel("m1", { service_tiers: undefined }),
		);
		expect(policy).toEqual({
			serviceTiers: [],
			shortContextBudgetTokens: 200_000,
			maxContextTokens: 1_000_000,
		});
		expect(policyAvailability(policy)).toEqual({
			longContext: true,
			serviceTier: false,
		});
	});

	test("equal short/max is retained but not a distinct choice", () => {
		const policy = policyAdvertisementFromApiModel(
			tieredModel("m1", {
				context_length: 200_000,
				service_tiers: ["flex"],
			}),
		);
		expect(policy?.shortContextBudgetTokens).toBe(200_000);
		expect(policy?.maxContextTokens).toBe(200_000);
		expect(policyAvailability(policy).longContext).toBe(false);
	});

	test("short above max drops the context budget", () => {
		const policy = policyAdvertisementFromApiModel(
			tieredModel("m1", {
				context_length: 100_000,
				service_tiers: ["flex"],
			}),
		);
		expect(policy).toEqual({ serviceTiers: ["flex"] });
	});

	test("models with no tiers and no pricing advertise nothing", () => {
		expect(
			policyAdvertisementFromApiModel(apiModel({ id: "m1" })),
		).toBeUndefined();
		expect(
			policyAdvertisementFromApiModel(
				apiModel({ id: "m1", context_length: 1_000_000 }),
			),
		).toBeUndefined();
	});

	test("malformed service_tiers are never advertised", () => {
		const bad: unknown[] = [
			[],
			["a", "a"],
			[""],
			[42],
			["ok", ""],
			"flex",
			{},
			new Array(65).fill("t"),
			["x".repeat(101)],
		];
		for (const service_tiers of bad) {
			const policy = policyAdvertisementFromApiModel(
				apiModel({ id: "m1", service_tiers: service_tiers as string[] }),
			);
			expect(
				policy,
				JSON.stringify(service_tiers)?.slice(0, 40),
			).toBeUndefined();
		}
	});

	test("non-positive or non-integer budgets drop the context policy", () => {
		for (const context_length of [0, -5, 1.5, Number.NaN, "big" as never]) {
			const policy = policyAdvertisementFromApiModel(
				tieredModel("m1", {
					context_length: context_length as number,
					service_tiers: ["flex"],
				}),
			);
			expect(policy).toEqual({ serviceTiers: ["flex"] });
		}
		for (const input_tokens_above of [0, -1, 2.5, Number.NaN]) {
			const policy = policyAdvertisementFromApiModel(
				tieredModel("m1", {
					pricing: { prompt: "1", tiers: [{ input_tokens_above }] },
					service_tiers: ["flex"],
				}),
			);
			expect(policy).toEqual({ serviceTiers: ["flex"] });
		}
	});
});

describe("selection validation", () => {
	test("unknown tiers are rejected atomically", () => {
		const store = storeWith([tieredModel("m1")]);
		const before = store.status("s1", REF);
		expect(before.selection).toEqual({ longContext: true, serviceTier: null });

		const result = store.select("s1", REF, { serviceTier: "ultra" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("not advertised");
			expect(result.selection).toEqual({
				longContext: true,
				serviceTier: null,
			});
		}
		// Stored state untouched.
		expect(store.status("s1", REF).selection).toEqual({
			longContext: true,
			serviceTier: null,
		});
	});

	test("tier matching is verbatim (case-sensitive)", () => {
		const store = storeWith([tieredModel("m1")]);
		expect(store.select("s1", REF, { serviceTier: "Flex" }).ok).toBe(false);
		expect(store.select("s1", REF, { serviceTier: "flex" }).ok).toBe(true);
	});

	test("short selection without a distinct budget is rejected", () => {
		const store = storeWith([tieredModel("m1", { context_length: 200_000 })]);
		const result = store.select("s1", REF, { longContext: false });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("no distinct");
		expect(store.status("s1", REF).selection.longContext).toBe(true);
	});

	test("short selection without any budget is rejected", () => {
		const store = storeWith([apiModel({ id: "m1", service_tiers: ["flex"] })]);
		const result = store.select("s1", REF, { longContext: false });
		expect(result.ok).toBe(false);
	});

	test("partial apply is impossible: one bad field rejects the whole patch", () => {
		// Valid tier + invalid short on an equalized-budget model.
		const store = storeWith([tieredModel("m1", { context_length: 200_000 })]);
		const result = store.select("s1", REF, {
			longContext: false,
			serviceTier: "flex",
		});
		expect(result.ok).toBe(false);
		expect(store.status("s1", REF).selection).toEqual({
			longContext: true,
			serviceTier: null,
		});

		// Valid short + invalid tier.
		const store2 = storeWith([tieredModel("m2")]);
		const ref2 = { providerID: "plexus", id: "m2" };
		const result2 = store2.select("s2", ref2, {
			longContext: false,
			serviceTier: "nope",
		});
		expect(result2.ok).toBe(false);
		expect(store2.status("s2", ref2).selection).toEqual({
			longContext: true,
			serviceTier: null,
		});
	});

	test("clearing the tier always succeeds", () => {
		const store = storeWith([tieredModel("m1")]);
		expect(store.select("s1", REF, { serviceTier: "flex" }).ok).toBe(true);
		const cleared = store.select("s1", REF, { serviceTier: null });
		expect(cleared.ok).toBe(true);
		expect(cleared.ok && cleared.selection.serviceTier).toBeNull();
	});
});

describe("session isolation", () => {
	test("two sessions on the same model keep different selections", () => {
		const store = storeWith([tieredModel("m1")]);
		expect(
			store.select("s1", REF, {
				longContext: false,
				serviceTier: "flex",
			}).ok,
		).toBe(true);
		expect(store.select("s2", REF, { serviceTier: "priority" }).ok).toBe(true);

		expect(store.tierForRequest("s1", REF)).toBe("flex");
		expect(store.tierForRequest("s2", REF)).toBe("priority");
		expect(store.contextBudgetForRequest("s1", REF)).toBe(200_000);
		expect(store.contextBudgetForRequest("s2", REF)).toBe(1_000_000);

		const o1: Record<string, unknown> = {};
		const o2: Record<string, unknown> = {};
		store.applyToOptions(o1, "s1", REF);
		store.applyToOptions(o2, "s2", REF);
		expect(o1[CONTEXT_BUDGET_OPTION]).toBe(200_000);
		expect(o2[CONTEXT_BUDGET_OPTION]).toBe(1_000_000);

		// Clearing s1 leaves s2 untouched.
		store.select("s1", REF, { serviceTier: null, longContext: true });
		expect(store.tierForRequest("s2", REF)).toBe("priority");
		expect(store.contextBudgetForRequest("s2", REF)).toBe(1_000_000);
	});

	test("unselected sessions see defaults and no tier", () => {
		const store = storeWith([tieredModel("m1")]);
		expect(store.tierForRequest("fresh", REF)).toBeNull();
		expect(store.contextBudgetForRequest("fresh", REF)).toBe(1_000_000);
		const options: Record<string, unknown> = {};
		store.applyToOptions(options, "fresh", REF);
		expect(options[CONTEXT_BUDGET_OPTION]).toBe(1_000_000);
	});

	test("options key is removed when the model has no context policy", () => {
		const store = storeWith([apiModel({ id: "m1", service_tiers: ["flex"] })]);
		const options: Record<string, unknown> = {
			[CONTEXT_BUDGET_OPTION]: 999,
		};
		store.applyToOptions(options, "s1", REF);
		expect(CONTEXT_BUDGET_OPTION in options).toBe(false);
		expect(store.contextBudgetForRequest("s1", REF)).toBeUndefined();
	});
});

describe("model-change reset", () => {
	test("switching models resets to defaults", () => {
		const store = storeWith([tieredModel("m1"), tieredModel("m2")]);
		expect(
			store.select("s1", REF, {
				longContext: false,
				serviceTier: "flex",
			}).ok,
		).toBe(true);

		const ref2 = { providerID: "plexus", id: "m2" };
		const state = store.status("s1", ref2);
		expect(state.reset).toBe(true);
		expect(state.selection).toEqual({ longContext: true, serviceTier: null });
		expect(store.tierForRequest("s1", ref2)).toBeNull();

		// The old model's selection is gone too.
		expect(store.status("s1", REF).reset).toBe(true);
	});

	test("same model does not reset", () => {
		const store = storeWith([tieredModel("m1")]);
		store.select("s1", REF, { serviceTier: "flex" });
		expect(store.status("s1", REF).reset).toBe(false);
		expect(store.status("s1", REF).selection.serviceTier).toBe("flex");
	});
});

describe("refresh reconciliation", () => {
	test("removed tier clears the selection", () => {
		const store = storeWith([tieredModel("m1")]);
		store.select("s1", REF, { serviceTier: "flex" });

		const changes = store.setCatalog([
			{
				id: "m1",
				modelID: "m1",
				providerID: "plexus",
				name: "m1",
				capabilities: { tools: false, input: ["text"], output: ["text"] },
				variants: [],
				time: { released: 0 },
				cost: [],
				status: "active" as const,
				enabled: true,
				limit: { context: 1_000_000, output: 32_000 },
				policy: {
					serviceTiers: ["standard"],
					shortContextBudgetTokens: 200_000,
					maxContextTokens: 1_000_000,
				},
			},
		]);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.kind).toBe("tier-cleared");
		expect(store.tierForRequest("s1", REF)).toBeNull();
		// Context selection (max default) survives a tier-only change.
		expect(store.status("s1", REF).selection.longContext).toBe(true);
	});

	test("equalized budgets reset a short selection to max", () => {
		const store = storeWith([tieredModel("m1")]);
		store.select("s1", REF, { longContext: false });

		const changes = store.setCatalog(
			infosFrom([tieredModel("m1", { context_length: 200_000 })]),
		);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.kind).toBe("context-reset-max");
		expect(store.status("s1", REF).selection.longContext).toBe(true);
		expect(store.contextBudgetForRequest("s1", REF)).toBe(200_000);
	});

	test("removed context policy resets a short selection to max", () => {
		const store = storeWith([tieredModel("m1")]);
		store.select("s1", REF, { longContext: false, serviceTier: "flex" });

		const noBudget = apiModel({ id: "m1", service_tiers: ["flex"] });
		const changes = store.setCatalog(infosFrom([noBudget]));
		expect(changes.map((c) => c.kind)).toEqual(["context-reset-max"]);
		const state = store.status("s1", REF);
		expect(state.selection.longContext).toBe(true);
		// Tier survives: still advertised.
		expect(state.selection.serviceTier).toBe("flex");
	});

	test("lowered short budget is re-applied while short is selected", () => {
		const store = storeWith([tieredModel("m1")]);
		store.select("s1", REF, { longContext: false });
		expect(store.contextBudgetForRequest("s1", REF)).toBe(200_000);

		const changes = store.setCatalog(
			infosFrom([
				tieredModel("m1", {
					pricing: { prompt: "1", tiers: [{ input_tokens_above: 100_000 }] },
				}),
			]),
		);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.kind).toBe("short-lowered");
		expect(store.contextBudgetForRequest("s1", REF)).toBe(100_000);
	});

	test("unchanged catalog reconciles silently", () => {
		const store = storeWith([tieredModel("m1")]);
		store.select("s1", REF, { longContext: false, serviceTier: "flex" });
		const changes = store.setCatalog(infosFrom([tieredModel("m1")]));
		expect(changes).toHaveLength(0);
		expect(store.status("s1", REF).selection).toEqual({
			longContext: false,
			serviceTier: "flex",
		});
	});

	test("removed model resets the session to defaults", () => {
		const store = storeWith([tieredModel("m1")]);
		store.select("s1", REF, { longContext: false, serviceTier: "flex" });
		const changes = store.setCatalog([]);
		expect(changes.map((c) => c.kind).sort()).toEqual([
			"context-reset-max",
			"tier-cleared",
		]);
		expect(store.status("s1", REF).selection).toEqual({
			longContext: true,
			serviceTier: null,
		});
	});
});

describe("service_tier injection", () => {
	test("injects into object payloads, leaves the original alone", () => {
		const payload = { model: "m1" };
		const out = injectServiceTier(payload, "flex");
		expect(out).toEqual({ model: "m1", service_tier: "flex" });
		expect(payload).toEqual({ model: "m1" });
		expect(injectServiceTier({ service_tier: "old" }, "flex")).toEqual({
			service_tier: "flex",
		});
	});

	test("null clears to a passthrough; non-objects untouched", () => {
		const payload = { model: "m1" };
		expect(injectServiceTier(payload, null)).toBe(payload);
		expect(injectServiceTier(payload, undefined)).toBe(payload);
		expect(injectServiceTier([1], "flex")).toEqual([1]);
		expect(injectServiceTier("x", "flex")).toBe("x");
		expect(injectServiceTier(null, "flex")).toBeNull();
	});

	test("body-string injection round-trips JSON", () => {
		const body = JSON.stringify({ model: "m1", stream: true });
		const out = injectServiceTierIntoBody(body, "flex");
		expect(out && JSON.parse(out)).toEqual({
			model: "m1",
			stream: true,
			service_tier: "flex",
		});
		// Already carrying the tier: no rewrite.
		expect(injectServiceTierIntoBody(out as string, "flex")).toBeUndefined();
		// Garbage in: untouched.
		expect(injectServiceTierIntoBody("not json", "flex")).toBeUndefined();
		expect(injectServiceTierIntoBody("[1,2]", "flex")).toBeUndefined();
		expect(injectServiceTierIntoBody('"s"', "flex")).toBeUndefined();
	});
});

describe("withServiceTier request rewrite", () => {
	const jsonRequest = (body: string, method = "POST") =>
		new Request("https://plexus.example.com/v1/chat/completions", {
			method,
			headers: {
				"content-type": "application/json",
				authorization: "Bearer k",
			},
			body: method === "GET" ? undefined : body,
		});

	test("rewrites JSON bodies and preserves everything else", async () => {
		const original = jsonRequest(JSON.stringify({ model: "m1" }));
		const replacement = await withServiceTier(original, "flex");
		expect(replacement).toBeDefined();
		expect(await replacement?.json()).toEqual({
			model: "m1",
			service_tier: "flex",
		});
		expect(replacement?.url).toBe(original.url);
		expect(replacement?.method).toBe("POST");
		expect(replacement?.headers.get("authorization")).toBe("Bearer k");
		expect(replacement?.headers.get("content-type")).toContain(
			"application/json",
		);
		// The original is never consumed: still readable.
		expect(await original.json()).toEqual({ model: "m1" });
	});

	test("leaves non-JSON, empty, GET, and unselected requests alone", async () => {
		expect(await withServiceTier(jsonRequest("{}"), null)).toBeUndefined();
		expect(
			await withServiceTier(
				new Request("https://x.example/", {
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: "hi",
				}),
				"flex",
			),
		).toBeUndefined();
		expect(
			await withServiceTier(
				new Request("https://x.example/models", { method: "GET" }),
				"flex",
			),
		).toBeUndefined();
		expect(await withServiceTier(jsonRequest("oops"), "flex")).toBeUndefined();
		expect(await withServiceTier(jsonRequest("[1]"), "flex")).toBeUndefined();
	});
});

describe("command parsing", () => {
	test("tier: bare/status/default/select", () => {
		expect(parseTierCommand(undefined)).toEqual({ kind: "status" });
		expect(parseTierCommand("")).toEqual({ kind: "status" });
		expect(parseTierCommand("status")).toEqual({ kind: "status" });
		expect(parseTierCommand("STATUS extra")).toEqual({ kind: "status" });
		expect(parseTierCommand("default")).toEqual({ kind: "clear" });
		expect(parseTierCommand("DEFAULT")).toEqual({ kind: "clear" });
		expect(parseTierCommand("flex")).toEqual({ kind: "select", tier: "flex" });
		expect(parseTierCommand("Flex")).toEqual({ kind: "select", tier: "Flex" });
		expect(parseTierCommand("  flex   extra ")).toEqual({
			kind: "select",
			tier: "flex",
		});
	});

	test("context: bare/status/short/max/invalid", () => {
		expect(parseContextCommand(undefined)).toEqual({ kind: "status" });
		expect(parseContextCommand("")).toEqual({ kind: "status" });
		expect(parseContextCommand("status")).toEqual({ kind: "status" });
		expect(parseContextCommand("short")).toEqual({ kind: "short" });
		expect(parseContextCommand("SHORT")).toEqual({ kind: "short" });
		expect(parseContextCommand("max")).toEqual({ kind: "max" });
		expect(parseContextCommand("Max x")).toEqual({ kind: "max" });
		expect(parseContextCommand("flex")).toEqual({
			kind: "invalid",
			value: "flex",
		});
	});
});

describe("status text", () => {
	test("tier status reports selection plus advertisement", () => {
		const policy = policyAdvertisementFromApiModel(tieredModel("m1"));
		expect(
			formatTierStatus("m1", { longContext: true, serviceTier: null }, policy),
		).toContain("default (provider default)");
		expect(
			formatTierStatus(
				"m1",
				{ longContext: true, serviceTier: "flex" },
				policy,
			),
		).toContain("flex");
		expect(
			formatTierStatus("m1", { longContext: true, serviceTier: null }, policy),
		).toContain("standard, flex, priority");
		expect(
			formatTierStatus(
				"m1",
				{ longContext: true, serviceTier: null },
				undefined,
			),
		).toContain("no service tiers");
	});

	test("context status reports mode, window, and budget", () => {
		const policy = policyAdvertisementFromApiModel(tieredModel("m1"));
		const text = formatContextStatus(
			"m1",
			{ longContext: false, serviceTier: null },
			policy,
			200_000,
		);
		expect(text).toContain("short");
		expect(text).toContain("200000");
		expect(text).toContain("short 200000 / max 1000000");
		const missing = formatContextStatus(
			"m1",
			{ longContext: true, serviceTier: null },
			undefined,
			undefined,
		);
		expect(missing).toContain("no context budget");
		expect(missing).toContain("unknown");
	});
});
