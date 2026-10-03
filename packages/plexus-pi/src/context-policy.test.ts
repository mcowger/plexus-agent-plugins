import { describe, expect, test } from "bun:test";
import {
	CONTEXT_POLICY_REQUEST_CHANNEL, CONTEXT_POLICY_SNAPSHOT_CHANNEL,
	ContextPolicyPublisher, ContextPolicyRequestSchema, ContextPolicySnapshotSchema,
} from "./context-policy.ts";

function bus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: any }> = [];
	return {
		emitted,
		listenerCount: () => listeners.get(CONTEXT_POLICY_REQUEST_CHANNEL)?.size ?? 0,
		on(channel: string, handler: (data: unknown) => void) {
			const set = listeners.get(channel) ?? new Set(); set.add(handler); listeners.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			for (const fn of [...(listeners.get(channel) ?? [])]) fn(data);
		},
	};
}

const sample = { provider: "plexus", modelId: "exact-model-id", maxContextTokens: 100, shortContextBudgetTokens: 50 };

describe("context policy publication", () => {
	test("correlates a valid immediate request and does not fetch", () => {
		const events = bus(); const publisher = new ContextPolicyPublisher(events);
		events.emit(CONTEXT_POLICY_REQUEST_CHANNEL, { version: 1, requestId: "abc" });
		const reply = events.emitted.at(-1)!;
		expect(reply.channel).toBe(CONTEXT_POLICY_SNAPSHOT_CHANNEL);
		expect(reply.data).toMatchObject({ version: 1, requestId: "abc", status: "loading", policies: [], revision: 1 });
		expect(events.emitted).toHaveLength(2);
		publisher.dispose();
	});
	test("ignores invalid requests and validates contracts and unique identities", () => {
		const events = bus(); const publisher = new ContextPolicyPublisher(events);
		events.emit(CONTEXT_POLICY_REQUEST_CHANNEL, { version: 2, requestId: "bad", secret: "do not echo" });
		expect(events.emitted).toHaveLength(1);
		expect(ContextPolicyRequestSchema.safeParse({ version: 1, requestId: "" }).success).toBe(false);
		expect(ContextPolicySnapshotSchema.safeParse({ ...publisher.getSnapshot(), status: "ready", policies: [sample, sample] }).success).toBe(false);
		expect(ContextPolicySnapshotSchema.safeParse({ ...publisher.getSnapshot(), status: "ready", policies: [{ ...sample, maxContextTokens: 0 }] }).success).toBe(false);
		expect(ContextPolicySnapshotSchema.safeParse({ ...publisher.getSnapshot(), status: "ready", policies: [{ ...sample, shortContextBudgetTokens: 101 }] }).success).toBe(false);
		publisher.dispose();
	});
	test("revision only changes when state changes; requests do not increment it", () => {
		const events = bus(); const publisher = new ContextPolicyPublisher(events);
		publisher.setCatalog("ready", [sample], { fetchedAt: 123 });
		const revision = publisher.getSnapshot().revision;
		events.emit(CONTEXT_POLICY_REQUEST_CHANNEL, { version: 1, requestId: "r" });
		expect(events.emitted.at(-1)!.data.revision).toBe(revision);
		expect(publisher.setCatalog("ready", [sample], { fetchedAt: 123 })).toBe(false);
		expect(publisher.getSnapshot().revision).toBe(revision);
		publisher.setCatalog("ready", [], { fetchedAt: 124 });
		expect(publisher.getSnapshot()).toMatchObject({ status: "ready", policies: [], revision: revision + 1 });
		expect(Object.isFrozen(publisher.getSnapshot())).toBe(true);
		publisher.dispose();
	});
	test("unavailable state is safe, size overflow is replaced, and listener is removed", () => {
		const events = bus(); const publisher = new ContextPolicyPublisher(events);
		publisher.setCatalog("unavailable", [], { reason: "limits unknown" });
		expect(publisher.getSnapshot()).toMatchObject({ status: "unavailable", policies: [] });
		const large = { ...sample, modelId: "x".repeat(1_100_000) };
		publisher.setCatalog("ready", [large]);
		expect(events.emitted.at(-1)!.data).toMatchObject({ status: "unavailable", policies: [] });
		expect(publisher.getSnapshot()).toMatchObject({ status: "unavailable", policies: [] });
		publisher.dispose();
		expect(events.listenerCount()).toBe(0);
	});
});
