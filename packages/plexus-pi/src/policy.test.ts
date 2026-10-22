import { describe, expect, test } from "bun:test";
import {
	effectiveContextWindow,
	injectServiceTier,
	type PolicyAdvertisement,
	PolicyController,
	type PolicyHost,
	type PolicyModel,
	policyAvailability,
} from "./policy.ts";

function makeHost(
	options: {
		model?: PolicyModel;
		advertisement?: PolicyAdvertisement;
		catalogWindow?: number;
		applies?: boolean;
	} = {},
) {
	let model = options.model;
	let advertisement = options.advertisement;
	let applies = options.applies ?? true;
	let window = options.catalogWindow;
	const calls: Array<{
		model: PolicyModel;
		contextWindow: number | undefined;
	}> = [];
	const host: PolicyHost = {
		getActiveModel: () => model,
		getAdvertisement: () => advertisement,
		getCatalogContextWindow: () => options.catalogWindow,
		hasCatalogContextPolicy: () => advertisement?.context !== undefined,
		async applyContextWindow(requested, contextWindow) {
			calls.push({ model: requested, contextWindow });
			if (!applies) return undefined;
			window = contextWindow ?? options.catalogWindow;
			return window;
		},
	};
	return {
		host,
		calls,
		setModel: (next: PolicyModel | undefined) => {
			model = next;
		},
		setAdvertisement: (next: PolicyAdvertisement | undefined) => {
			advertisement = next;
		},
		setApplies: (next: boolean) => {
			applies = next;
		},
	};
}

const context = { maxContextTokens: 1_000, shortContextBudgetTokens: 200 };
const advertisement: PolicyAdvertisement = {
	context: { provider: "plexus", modelId: "m1", ...context },
	serviceTier: {
		provider: "plexus",
		modelId: "m1",
		serviceTiers: ["standard", "priority"],
	},
};
const m1 = { provider: "plexus", id: "m1" };

describe("policy helpers", () => {
	test("derives availability and effective windows from the advertisement", () => {
		expect(policyAvailability(undefined)).toEqual({
			longContext: false,
			serviceTier: false,
		});
		expect(policyAvailability(advertisement)).toEqual({
			longContext: true,
			serviceTier: true,
		});
		expect(
			policyAvailability({
				context: {
					provider: "plexus",
					modelId: "m",
					maxContextTokens: 10,
					shortContextBudgetTokens: 10,
				},
			}),
		).toEqual({ longContext: false, serviceTier: false });

		expect(
			effectiveContextWindow(advertisement, {
				longContext: false,
				serviceTier: null,
			}),
		).toBe(200);
		expect(
			effectiveContextWindow(advertisement, {
				longContext: true,
				serviceTier: null,
			}),
		).toBe(1_000);
		expect(
			effectiveContextWindow(undefined, {
				longContext: true,
				serviceTier: null,
			}),
		).toBe(undefined);
	});

	test("injects service_tier without mutating or fabricating payloads", () => {
		const payload = { model: "m1" };
		expect(injectServiceTier(payload, "priority")).toEqual({
			model: "m1",
			service_tier: "priority",
		});
		expect(payload).toEqual({ model: "m1" });
		expect(injectServiceTier(payload, null)).toBe(payload);
		expect(injectServiceTier([], "priority")).toEqual([]);
	});
});

describe("terminal default", () => {
	test("applies the maximum budget and injects no tier without a resolver", async () => {
		const state = makeHost({ model: m1, advertisement });
		const controller = new PolicyController(state.host);
		await controller.reconcile();
		expect(state.calls.at(-1)?.contextWindow).toBe(1_000);
		expect(controller.getView().selection).toEqual({
			longContext: true,
			serviceTier: null,
		});
		expect(controller.serviceTierFor(m1)).toBeNull();
	});
});

describe("resolver-driven selection", () => {
	test("applies the short budget and an advertised tier, and notifies subscribers", async () => {
		const state = makeHost({ model: m1, advertisement });
		const controller = new PolicyController(state.host);
		let notified = 0;
		controller.subscribe(() => {
			notified += 1;
		});
		controller.setResolver(() => ({
			longContext: false,
			serviceTier: "priority",
		}));
		await controller.reconcile();
		expect(state.calls.at(-1)?.contextWindow).toBe(200);
		expect(controller.getView()).toMatchObject({
			contextWindow: 200,
			applyFailed: false,
			selection: { longContext: false, serviceTier: "priority" },
		});
		expect(controller.serviceTierFor(m1)).toBe("priority");
		expect(
			controller.serviceTierFor({ provider: "plexus", id: "other" }),
		).toBeNull();
		expect(notified).toBe(1);
	});

	test("drops a tier that is not advertised for the model", async () => {
		const state = makeHost({ model: m1, advertisement });
		const controller = new PolicyController(state.host);
		controller.setResolver(() => ({ longContext: true, serviceTier: "flex" }));
		await controller.reconcile();
		expect(controller.getView().selection.serviceTier).toBeNull();
		expect(controller.serviceTierFor(m1)).toBeNull();
	});

	test("never applies a short budget for a model without a distinct budget", async () => {
		const equal = {
			context: {
				...context,
				shortContextBudgetTokens: 1_000,
				provider: "plexus",
				modelId: "m1",
			},
		};
		const state = makeHost({ model: m1, advertisement: equal });
		const controller = new PolicyController(state.host);
		controller.setResolver(() => ({ longContext: false, serviceTier: null }));
		await controller.reconcile();
		expect(controller.getView()).toMatchObject({
			contextWindow: 1_000,
			selection: { longContext: false },
		});
	});

	test("keeps the previous budget and reports a failed application", async () => {
		const state = makeHost({ model: m1, advertisement });
		const controller = new PolicyController(state.host);
		controller.setResolver(() => ({ longContext: true, serviceTier: null }));
		await controller.reconcile();
		expect(controller.getView().selection.longContext).toBe(true);

		state.setApplies(false);
		controller.setResolver(() => ({ longContext: false, serviceTier: null }));
		await controller.reconcile();
		expect(controller.getView()).toMatchObject({
			applyFailed: true,
			contextWindow: 1_000,
			selection: { longContext: true },
		});

		state.setApplies(true);
		await controller.reconcile();
		expect(controller.getView()).toMatchObject({
			applyFailed: false,
			contextWindow: 200,
		});
	});

	test("restores the catalog window when the advertisement disappears", async () => {
		const state = makeHost({ model: m1, advertisement, catalogWindow: 5_000 });
		const controller = new PolicyController(state.host);
		controller.setResolver(() => ({
			longContext: false,
			serviceTier: "priority",
		}));
		await controller.reconcile();
		state.setAdvertisement(undefined);
		await controller.reconcile();
		expect(state.calls.at(-1)).toEqual({ model: m1, contextWindow: undefined });
		expect(controller.getView().contextWindow).toBeUndefined();
		expect(controller.serviceTierFor(m1)).toBeNull();
	});

	test("returns to the terminal default when the resolver is removed", async () => {
		const state = makeHost({ model: m1, advertisement });
		const controller = new PolicyController(state.host);
		controller.setResolver(() => ({
			longContext: false,
			serviceTier: "priority",
		}));
		await controller.reconcile();
		controller.setResolver(undefined);
		await controller.reconcile();
		expect(state.calls.at(-1)?.contextWindow).toBe(1_000);
		expect(controller.serviceTierFor(m1)).toBeNull();
	});

	test("unsubscribed listeners are not notified", async () => {
		const state = makeHost({ model: m1, advertisement });
		const controller = new PolicyController(state.host);
		let notified = 0;
		const unsubscribe = controller.subscribe(() => {
			notified += 1;
		});
		unsubscribe();
		await controller.reconcile();
		expect(notified).toBe(0);
	});
});
