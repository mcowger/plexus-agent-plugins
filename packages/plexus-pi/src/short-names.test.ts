import { describe, expect, test } from "bun:test";
import { shortNameEntryFromApiModel } from "./extension.ts";
import { ShortNameEntrySchema } from "./short-names.ts";

const entry = {
	provider: "plexus",
	modelId: "registered-model-id",
	shortName: "Haiku",
};

describe("short-name mapping", () => {
	test("trims the advertised short name onto the exact model identity", () => {
		expect(
			shortNameEntryFromApiModel({
				id: "registered-model-id",
				name: "Claude Haiku 4.5",
				short_name: "  Haiku  ",
			}),
		).toEqual(entry);
	});

	test("does not advertise missing, blank, or invalid short names", () => {
		expect(shortNameEntryFromApiModel({ id: "no-support" })).toBeUndefined();
		expect(
			shortNameEntryFromApiModel({ id: "blank", short_name: "   " }),
		).toBeUndefined();
		expect(
			shortNameEntryFromApiModel({
				id: "too-long",
				short_name: "x".repeat(201),
			}),
		).toBeUndefined();
	});
});

describe("ShortNameEntrySchema", () => {
	test("is strict about keys and bounds the name", () => {
		expect(ShortNameEntrySchema.safeParse(entry).success).toBe(true);
		expect(
			ShortNameEntrySchema.safeParse({ ...entry, shortName: "" }).success,
		).toBe(false);
		expect(ShortNameEntrySchema.safeParse({ ...entry, extra: 1 }).success).toBe(
			false,
		);
	});
});
