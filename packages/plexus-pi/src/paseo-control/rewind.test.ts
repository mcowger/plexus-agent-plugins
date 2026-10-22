import { describe, expect, test } from "bun:test";
import {
	type BranchEntryLike,
	buildRewindEntry,
	findActiveBranchUserEntry,
	navigationCancelled,
} from "./rewind.ts";

const branch: BranchEntryLike[] = [
	{ id: "u1", parentId: null, type: "message", message: { role: "user" } },
	{ id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } },
	{ id: "c1", parentId: "a1", type: "custom" },
];

describe("rewind target validation", () => {
	test("accepts an active-branch user message and returns it unchanged", () => {
		const result = findActiveBranchUserEntry(branch, "u1");
		expect(result).toEqual({ ok: true, entry: branch[0] as BranchEntryLike });
	});

	test("rejects an entry that is not on the active branch", () => {
		expect(findActiveBranchUserEntry(branch, "elsewhere")).toEqual({
			ok: false,
			error: "rewind target is not on the active branch",
		});
	});

	test("rejects assistant messages and non-message entries", () => {
		expect(findActiveBranchUserEntry(branch, "a1")).toEqual({
			ok: false,
			error: "rewind target must be an active-branch user message",
		});
		expect(findActiveBranchUserEntry(branch, "c1")).toMatchObject({
			ok: false,
		});
	});
});

describe("rewind branch pin", () => {
	test("records the target and leaf with the protocol version", () => {
		expect(buildRewindEntry("u1", "a1", 5)).toEqual({
			version: 1,
			targetEntryId: "u1",
			leafId: "a1",
			timestamp: 5,
		});
	});

	test("omits the leaf when navigation reset to the root", () => {
		const entry = buildRewindEntry("u1", null, 5);
		expect(entry).toEqual({ version: 1, targetEntryId: "u1", timestamp: 5 });
		expect("leafId" in entry).toBe(false);
	});
});

describe("navigation cancellation", () => {
	test("reads only an explicit cancelled: true", () => {
		expect(navigationCancelled({ cancelled: true })).toBe(true);
		expect(navigationCancelled({ cancelled: false })).toBe(false);
		expect(navigationCancelled({})).toBe(false);
		expect(navigationCancelled({ cancelled: "true" })).toBe(false);
		expect(navigationCancelled(undefined)).toBe(false);
		expect(navigationCancelled("cancelled")).toBe(false);
	});
});
