import { describe, expect, test } from "bun:test";
import { detectControlConflicts } from "./conflicts.ts";

describe("control conflict detection", () => {
	test("reports no conflict for an empty or unrelated command list", () => {
		expect(detectControlConflicts([])).toEqual([]);
		expect(
			detectControlConflicts([
				{ name: "service-tier", source: "extension" },
				{ name: "plexus-catalog", source: "extension" },
				{ name: "plexuspi-control", source: "extension" },
			]),
		).toEqual([]);
	});

	test("reports pi-microgpt with its resolution when its control commands are declared", () => {
		const conflicts = detectControlConflicts([
			{ name: "fast", source: "extension" },
		]);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({
			owner: "pi-microgpt",
			command: "fast",
		});
		expect(conflicts[0]?.resolution).toContain(
			"plexus-pi owns tier and context selection",
		);
	});

	test("lists every matched command in one conflict", () => {
		const [conflict] = detectControlConflicts([
			{ name: "long-context", source: "extension" },
			{ name: "flex", source: "extension" },
		]);
		expect(conflict?.command).toBe("flex, long-context");
	});

	test("treats commands without a source as extension commands", () => {
		expect(detectControlConflicts([{ name: "flex" }])).toHaveLength(1);
	});

	test("ignores control names that come from non-extension sources", () => {
		expect(
			detectControlConflicts([{ name: "fast", source: "prompt" }]),
		).toEqual([]);
		expect(detectControlConflicts([{ name: "fast", source: "skill" }])).toEqual(
			[],
		);
	});
});
