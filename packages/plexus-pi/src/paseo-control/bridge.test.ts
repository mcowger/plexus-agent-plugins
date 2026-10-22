import { describe, expect, test } from "bun:test";
import { createSubagentBridgeTracker, formatChildForward } from "./bridge.ts";
import { CHILD_NOTIFY_PREFIX, type SubagentBridgeRecord } from "./protocol.ts";

function record(overrides: Record<string, unknown> = {}): SubagentBridgeRecord {
	return {
		version: 1,
		runId: "run-1",
		sequence: 1,
		type: "created",
		...overrides,
	} as SubagentBridgeRecord;
}

describe("subagent bridge tracker", () => {
	test("accepts a created record and wraps it in the session-keyed envelope", () => {
		const tracker = createSubagentBridgeTracker("key-1");
		const forward = tracker.accept(record());
		expect(forward).toEqual({
			version: 1,
			sessionKey: "key-1",
			record: record(),
		});
		expect(tracker.activeChildren()).toBe(1);
	});

	test("drops a run whose first record is not created", () => {
		const tracker = createSubagentBridgeTracker("key-1");
		expect(
			tracker.accept(record({ type: "activity", sequence: 2 })),
		).toBeUndefined();
		expect(
			tracker.accept(record({ type: "terminal", sequence: 3 })),
		).toBeUndefined();
		expect(tracker.activeChildren()).toBe(0);
	});

	test("drops duplicate and out-of-order sequences", () => {
		const tracker = createSubagentBridgeTracker("key-1");
		tracker.accept(record({ sequence: 1 }));
		tracker.accept(record({ type: "activity", sequence: 4 }));
		expect(
			tracker.accept(record({ type: "activity", sequence: 4 })),
		).toBeUndefined();
		expect(
			tracker.accept(record({ type: "activity", sequence: 2 })),
		).toBeUndefined();
		expect(
			tracker.accept(record({ type: "activity", sequence: 5 })),
		).toBeDefined();
	});

	test("keeps the terminal record sticky so a late record cannot reopen a child", () => {
		const tracker = createSubagentBridgeTracker("key-1");
		tracker.accept(record());
		expect(
			tracker.accept(
				record({ type: "terminal", sequence: 2, outcome: "completed" }),
			),
		).toBeDefined();
		expect(tracker.activeChildren()).toBe(0);
		expect(
			tracker.accept(record({ type: "activity", sequence: 3 })),
		).toBeUndefined();
		expect(
			tracker.accept(
				record({ type: "terminal", sequence: 4, outcome: "failed" }),
			),
		).toBeUndefined();
		expect(tracker.activeChildren()).toBe(0);
	});

	test("counts each unfinished run once and ignores repeated created records", () => {
		const tracker = createSubagentBridgeTracker("key-1");
		tracker.accept(record({ runId: "a" }));
		tracker.accept(record({ runId: "b" }));
		expect(tracker.accept(record({ runId: "a", sequence: 1 }))).toBeUndefined();
		expect(tracker.activeChildren()).toBe(2);
		tracker.accept(
			record({
				runId: "a",
				sequence: 2,
				type: "terminal",
				outcome: "canceled",
			}),
		);
		expect(tracker.activeChildren()).toBe(1);
	});

	test("formats forwards with the child prefix and a parseable envelope", () => {
		const forward = {
			version: 1 as const,
			sessionKey: "key-1",
			record: record(),
		};
		const message = formatChildForward(forward);
		expect(message.startsWith(CHILD_NOTIFY_PREFIX)).toBe(true);
		expect(JSON.parse(message.slice(CHILD_NOTIFY_PREFIX.length))).toEqual(
			forward,
		);
	});
});
