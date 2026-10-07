import { describe, expect, test } from "bun:test";
import {
	effectiveContextWindow,
	injectServiceTier,
	PolicyController,
	POLICY_SET_CHANNEL,
	POLICY_STATE_CHANNEL,
	PolicySetSchema,
	PolicyStateSchema,
	policyAvailability,
	type PolicyAdvertisement,
	type PolicyHost,
} from "./policy.ts";

function bus() {
	const listeners = new Map<string, Set<(data: unknown) => unknown>>();
	const emitted: Array<{ channel: string; data: any }> = [];
	return {
		emitted,
		listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
		on(channel: string, handler: (data: unknown) => unknown) {
			const set = listeners.get(channel) ?? new Set();
			set.add(handler);
			listeners.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
		},
		async dispatch(channel: string, data: unknown) {
			for (const handler of [...(listeners.get(channel) ?? [])]) await handler(data);
		},
	};
}

function makeHost(options: {
	model?: { provider: string; id: string };
	advertisement?: PolicyAdvertisement;
	catalogWindow?: number;
	applies?: boolean;
} = {}) {
	let model = options.model;
	let advertisement = options.advertisement;
	let effectiveWindow = options.catalogWindow;
	let applies = options.applies ?? true;
	const calls: Array<{ model: { provider: string; id: string }; contextWindow: number | undefined }> = [];
	const host: PolicyHost = {
		getActiveModel: () => model,
		getAdvertisement: () => advertisement,
		getEffectiveContextWindow: () => effectiveWindow,
		async applyContextWindow(requested, contextWindow) {
			calls.push({ model: requested, contextWindow });
			if (!applies) return undefined;
			effectiveWindow = contextWindow ?? options.catalogWindow;
			return effectiveWindow;
		},
	};
	return {
		host,
		calls,
		setModel: (next: { provider: string; id: string } | undefined) => {
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
	serviceTier: { provider: "plexus", modelId: "m1", serviceTiers: ["standard", "priority"] },
};

async function setup(options?: Parameters<typeof makeHost>[0]) {
	const events = bus();
	const state = makeHost(options);
	const controller = new PolicyController(events, state.host);
	await controller.reconcile();
	return { events, state, controller };
}

describe("policy helpers", () => {
	test("derives availability and effective windows from the advertisement", () => {
		expect(policyAvailability(undefined)).toEqual({ longContext: false, serviceTier: false });
		expect(policyAvailability(advertisement)).toEqual({ longContext: true, serviceTier: true });
		expect(policyAvailability({ context: { provider: "plexus", modelId: "m", maxContextTokens: 10, shortContextBudgetTokens: 10 } }))
			.toEqual({ longContext: false, serviceTier: false });
		expect(effectiveContextWindow(advertisement, { longContext: true, serviceTier: null })).toBe(1_000);
		expect(effectiveContextWindow(advertisement, { longContext: false, serviceTier: null })).toBe(200);
		expect(effectiveContextWindow(undefined, { longContext: false, serviceTier: null })).toBeUndefined();
	});

	test("injects service_tier without mutating or fabricating payloads", () => {
		const payload = { model: "x" };
		expect(injectServiceTier(payload, "priority")).toEqual({ model: "x", service_tier: "priority" });
		expect(payload).toEqual({ model: "x" });
		expect(injectServiceTier(payload, null)).toBe(payload);
		expect(injectServiceTier(payload, undefined)).toBe(payload);
		expect(injectServiceTier("nope", "priority")).toBe("nope");
	});
});

describe("policy state publication", () => {
	test("reconciles the active model, applies the default maximum, and broadcasts", async () => {
		const { events, controller } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		expect(controller.getState()).toMatchObject({
			available: { longContext: true, serviceTier: true },
			applied: { longContext: true, serviceTier: null, contextWindow: 1_000 },
		});
		expect(events.emitted.at(-1)).toMatchObject({ channel: POLICY_STATE_CHANNEL });
		expect(events.emitted.at(-1)!.data.requestId).toBeUndefined();
		expect(Object.isFrozen(controller.getState())).toBe(true);
		expect(Object.isFrozen(controller.getState().applied)).toBe(true);
		controller.dispose();
	});

	test("applies an advertised tier and short budget, correlating the reply and broadcasting the change", async () => {
		const { events, controller, state } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		const revision = controller.getState().revision;
		await events.dispatch(POLICY_SET_CHANNEL, {
			version: 1,
			requestId: "r1",
			longContext: false,
			serviceTier: "priority",
		});
		expect(controller.getState()).toMatchObject({
			revision: revision + 1,
			applied: { longContext: false, serviceTier: "priority", contextWindow: 200 },
		});
		expect(controller.serviceTierFor({ provider: "plexus", id: "m1" })).toBe("priority");
		expect(controller.serviceTierFor({ provider: "plexus", id: "other" })).toBeNull();
		expect(controller.serviceTierFor(undefined)).toBeNull();
		expect(state.calls.at(-1)).toEqual({ model: { provider: "plexus", id: "m1" }, contextWindow: 200 });
		const reply = events.emitted.at(-1)!;
		const broadcast = events.emitted.at(-2)!;
		expect(reply.channel).toBe(POLICY_STATE_CHANNEL);
		expect(reply.data).toMatchObject({
			requestId: "r1",
			revision: revision + 1,
			applied: { longContext: false, serviceTier: "priority", contextWindow: 200 },
		});
		expect(broadcast.data.requestId).toBeUndefined();
		controller.dispose();
	});

	test("a correlated reply for an unchanged selection does not advance the revision", async () => {
		const { events, controller } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "a", longContext: false });
		const revision = controller.getState().revision;
		const emits = events.emitted.length;
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "b", longContext: false });
		expect(controller.getState().revision).toBe(revision);
		expect(events.emitted.length).toBe(emits + 1);
		expect(events.emitted.at(-1)!.data).toMatchObject({ requestId: "b", revision });
		controller.dispose();
	});

	test("rejects unadvertised selections with no partial application", async () => {
		const { events, controller } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "setup", longContext: false, serviceTier: "priority" });
		const revision = controller.getState().revision;
		await events.dispatch(POLICY_SET_CHANNEL, {
			version: 1,
			requestId: "bad",
			longContext: true,
			serviceTier: "unadvertised",
		});
		expect(controller.getState()).toMatchObject({
			revision,
			applied: { longContext: false, serviceTier: "priority", contextWindow: 200 },
		});
		expect(events.emitted.at(-1)!.data).toMatchObject({ requestId: "bad", revision });
		expect(typeof events.emitted.at(-1)!.data.reason).toBe("string");
		controller.dispose();
	});

	test("rejects a context mode when the short and maximum budgets are not distinct", async () => {
		const { events, controller, state } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		state.setAdvertisement({
			context: { provider: "plexus", modelId: "m1", maxContextTokens: 1_000, shortContextBudgetTokens: 1_000 },
			serviceTier: advertisement.serviceTier,
		});
		await controller.reconcile();
		expect(controller.getState().available.longContext).toBe(false);
		const revision = controller.getState().revision;
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "flat", longContext: false });
		expect(controller.getState().revision).toBe(revision);
		expect(typeof events.emitted.at(-1)!.data.reason).toBe("string");
		controller.dispose();
	});

	test("reports unavailable, with a reason and no revision change, when no qualifying policy exists", async () => {
		const { events, controller } = await setup({
			model: { provider: "plexus", id: "m1" },
			catalogWindow: 1_000,
		});
		expect(controller.getState()).toMatchObject({
			available: { longContext: false, serviceTier: false },
		});
		expect(typeof controller.getState().reason).toBe("string");
		const revision = controller.getState().revision;
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "none", serviceTier: "priority" });
		expect(controller.getState().revision).toBe(revision);
		expect(events.emitted.at(-1)!.data).toMatchObject({
			requestId: "none",
			revision,
			available: { longContext: false, serviceTier: false },
		});
		expect(typeof events.emitted.at(-1)!.data.reason).toBe("string");
		controller.dispose();
	});

	test("rejects without changing state when the context window cannot be applied", async () => {
		const { events, controller, state } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		state.setApplies(false);
		const revision = controller.getState().revision;
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "fail", longContext: false });
		expect(controller.getState().revision).toBe(revision);
		expect(controller.getState().applied.longContext).toBe(true);
		expect(typeof events.emitted.at(-1)!.data.reason).toBe("string");
		controller.dispose();
	});
});

describe("policy reconciliation on refresh", () => {
	test("re-applies a lowered short budget and clears a removed service tier", async () => {
		const { events, controller, state } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "on", longContext: false, serviceTier: "priority" });
		expect(controller.getState().applied).toMatchObject({ longContext: false, serviceTier: "priority", contextWindow: 200 });
		const revision = controller.getState().revision;

		state.setAdvertisement({
			context: { provider: "plexus", modelId: "m1", maxContextTokens: 1_000, shortContextBudgetTokens: 150 },
			serviceTier: { provider: "plexus", modelId: "m1", serviceTiers: ["standard"] },
		});
		await controller.reconcile();
		expect(controller.getState()).toMatchObject({
			revision: revision + 1,
			applied: { longContext: false, serviceTier: null, contextWindow: 150 },
			available: { longContext: true, serviceTier: true },
		});
		expect(typeof controller.getState().reason).toBe("string");
		expect(state.calls.at(-1)).toEqual({ model: { provider: "plexus", id: "m1" }, contextWindow: 150 });
		expect(controller.serviceTierFor({ provider: "plexus", id: "m1" })).toBeNull();
		controller.dispose();
	});

	test("restores the catalog window and resets selection when the context policy disappears", async () => {
		const { events, controller, state } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "on", longContext: false });
		expect(controller.getState().applied.contextWindow).toBe(200);
		state.setAdvertisement({ serviceTier: advertisement.serviceTier });
		await controller.reconcile();
		expect(controller.getState()).toMatchObject({
			available: { longContext: false, serviceTier: true },
			applied: { longContext: true, serviceTier: null },
		});
		expect(controller.getState().applied.contextWindow).toBeUndefined();
		expect(state.calls.at(-1)).toEqual({ model: { provider: "plexus", id: "m1" }, contextWindow: undefined });
		controller.dispose();
	});

	test("resets selection when the active model changes", async () => {
		const { events, controller, state } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "on", longContext: false, serviceTier: "priority" });
		state.setModel({ provider: "plexus", id: "m2" });
		state.setAdvertisement(undefined);
		await controller.reconcile();
		expect(controller.getState()).toMatchObject({
			available: { longContext: false, serviceTier: false },
			applied: { longContext: true, serviceTier: null },
		});
		expect(controller.serviceTierFor({ provider: "plexus", id: "m2" })).toBeNull();
		controller.dispose();
	});
});

describe("policy command validation", () => {
	test("ignores malformed commands without replying", async () => {
		const { events, controller } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		const emits = events.emitted.length;
		await events.dispatch(POLICY_SET_CHANNEL, { version: 2, requestId: "bad" });
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "" });
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "empty" });
		await events.dispatch(POLICY_SET_CHANNEL, { version: 1, requestId: "extra", longContext: true, secret: "no" });
		expect(events.emitted.length).toBe(emits);
		controller.dispose();
	});

	test("validates the request and state contracts", () => {
		expect(PolicySetSchema.safeParse({ version: 1, requestId: "x" }).success).toBe(false);
		expect(PolicySetSchema.safeParse({ version: 1, requestId: "x", serviceTier: null }).success).toBe(true);
		expect(PolicySetSchema.safeParse({ version: 1, requestId: "x", longContext: false }).success).toBe(true);
		expect(PolicySetSchema.safeParse({ version: 1, requestId: "x", serviceTier: "" }).success).toBe(false);
		expect(
			PolicyStateSchema.safeParse({
				version: 1,
				publisherId: "00000000-0000-4000-8000-000000000000",
				revision: 1,
				applied: { longContext: true, serviceTier: null },
				available: { longContext: false, serviceTier: false },
			}).success,
		).toBe(true);
	});

	test("unsubscribes on dispose", async () => {
		const { events, controller } = await setup({
			model: { provider: "plexus", id: "m1" },
			advertisement,
			catalogWindow: 1_000,
		});
		expect(events.listenerCount(POLICY_SET_CHANNEL)).toBe(1);
		controller.dispose();
		expect(events.listenerCount(POLICY_SET_CHANNEL)).toBe(0);
	});
});
