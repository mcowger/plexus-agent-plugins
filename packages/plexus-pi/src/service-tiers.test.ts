import { describe, expect, test } from "bun:test";
import { serviceTierPolicyFromApiModel } from "./extension.ts";
import {
	SERVICE_TIERS_REQUEST_CHANNEL,
	SERVICE_TIERS_SNAPSHOT_CHANNEL,
	ServiceTierPolicySchema,
	ServiceTiersPublisher,
	ServiceTiersRequestSchema,
	ServiceTiersSnapshotSchema,
} from "./service-tiers.ts";

function bus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: Record<string, unknown> }> = [];
	return {
		emitted,
		listenerCount: () =>
			listeners.get(SERVICE_TIERS_REQUEST_CHANNEL)?.size ?? 0,
		on(channel: string, handler: (data: unknown) => void) {
			const set = listeners.get(channel) ?? new Set();
			set.add(handler);
			listeners.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data: data as Record<string, unknown> });
			for (const fn of [...(listeners.get(channel) ?? [])]) fn(data);
		},
	};
}

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

describe("service-tier snapshot publication", () => {
	test("answers valid requests immediately with correlation and no revision change", () => {
		const events = bus();
		const publisher = new ServiceTiersPublisher(events);
		publisher.setCatalog("ready", [policy], { fetchedAt: 123 });
		const revision = publisher.getSnapshot().revision;
		events.emit(SERVICE_TIERS_REQUEST_CHANNEL, {
			version: 1,
			requestId: "request-1",
		});
		expect(events.emitted.at(-1)).toMatchObject({
			channel: SERVICE_TIERS_SNAPSHOT_CHANNEL,
			data: {
				version: 1,
				requestId: "request-1",
				status: "ready",
				policies: [policy],
				revision,
			},
		});
		expect(publisher.getSnapshot().revision).toBe(revision);
		const policies = events.emitted.at(-1)?.data?.policies as
			| Array<{ serviceTiers: unknown }>
			| undefined;
		expect(Object.isFrozen(policies?.[0]?.serviceTiers)).toBe(true);
		publisher.dispose();
	});

	test("ignores invalid requests and validates policy IDs, lists, and duplicates", () => {
		const events = bus();
		const publisher = new ServiceTiersPublisher(events);
		events.emit(SERVICE_TIERS_REQUEST_CHANNEL, { version: 1, requestId: "" });
		expect(events.emitted).toHaveLength(1);
		expect(
			ServiceTiersRequestSchema.safeParse({ version: 2, requestId: "x" })
				.success,
		).toBe(false);
		expect(
			ServiceTierPolicySchema.safeParse({ ...policy, serviceTiers: [] })
				.success,
		).toBe(false);
		expect(
			ServiceTierPolicySchema.safeParse({
				...policy,
				serviceTiers: ["flex", "flex"],
			}).success,
		).toBe(false);
		expect(
			ServiceTiersSnapshotSchema.safeParse({
				...publisher.getSnapshot(),
				status: "ready",
				policies: [policy, policy],
			}).success,
		).toBe(false);
		publisher.dispose();
	});

	test("publishes full replacements and increments revision only on state changes", () => {
		const events = bus();
		const publisher = new ServiceTiersPublisher(events);
		publisher.setCatalog("ready", [policy], { fetchedAt: 100 });
		const revision = publisher.getSnapshot().revision;
		publisher.setCatalog("ready", [], { fetchedAt: 101 });
		expect(publisher.getSnapshot()).toMatchObject({
			status: "ready",
			policies: [],
			revision: revision + 1,
		});
		expect(publisher.setCatalog("ready", [], { fetchedAt: 101 })).toBe(false);
		expect(Object.isFrozen(publisher.getSnapshot().policies)).toBe(true);
		publisher.dispose();
	});

	test("replaces oversized snapshots with unavailable and unsubscribes on dispose", () => {
		const events = bus();
		const publisher = new ServiceTiersPublisher(events);
		publisher.setCatalog("ready", [
			{ ...policy, modelId: "x".repeat(1_100_000) },
		]);
		expect(publisher.getSnapshot()).toMatchObject({
			status: "unavailable",
			policies: [],
		});
		publisher.dispose();
		expect(events.listenerCount()).toBe(0);
	});
});
