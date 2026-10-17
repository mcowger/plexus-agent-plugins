import { describe, expect, test } from "bun:test";
import { shortNameEntryFromApiModel } from "./extension.ts";
import {
	SHORT_NAMES_REQUEST_CHANNEL,
	SHORT_NAMES_SNAPSHOT_CHANNEL,
	ShortNameEntrySchema,
	ShortNamesPublisher,
	ShortNamesRequestSchema,
	ShortNamesSnapshotSchema,
} from "./short-names.ts";

function bus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: Record<string, unknown> }> = [];
	return {
		emitted,
		listenerCount: () => listeners.get(SHORT_NAMES_REQUEST_CHANNEL)?.size ?? 0,
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

const entry = {
	provider: "plexus",
	modelId: "registered-model-id",
	shortName: "Haiku",
};

describe("short-name entry mapping", () => {
	test("uses exact model identity and the trimmed short_name", () => {
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

describe("short-name snapshot publication", () => {
	test("answers valid requests immediately with correlation and no revision change", () => {
		const events = bus();
		const publisher = new ShortNamesPublisher(events);
		publisher.setCatalog("ready", [entry], { fetchedAt: 123 });
		const revision = publisher.getSnapshot().revision;
		events.emit(SHORT_NAMES_REQUEST_CHANNEL, {
			version: 1,
			requestId: "request-1",
		});
		expect(events.emitted.at(-1)).toMatchObject({
			channel: SHORT_NAMES_SNAPSHOT_CHANNEL,
			data: {
				version: 1,
				requestId: "request-1",
				status: "ready",
				names: [entry],
				revision,
			},
		});
		expect(publisher.getSnapshot().revision).toBe(revision);
		const names = events.emitted.at(-1)?.data?.names as
			| Array<Record<string, unknown>>
			| undefined;
		expect(Object.isFrozen(names?.[0])).toBe(true);
		publisher.dispose();
	});

	test("ignores invalid requests and validates entry IDs, names, and duplicates", () => {
		const events = bus();
		const publisher = new ShortNamesPublisher(events);
		events.emit(SHORT_NAMES_REQUEST_CHANNEL, { version: 1, requestId: "" });
		expect(events.emitted).toHaveLength(1);
		expect(
			ShortNamesRequestSchema.safeParse({ version: 2, requestId: "x" }).success,
		).toBe(false);
		expect(
			ShortNameEntrySchema.safeParse({ ...entry, shortName: "" }).success,
		).toBe(false);
		expect(
			ShortNameEntrySchema.safeParse({ ...entry, short_extra: true }).success,
		).toBe(false);
		expect(
			ShortNamesSnapshotSchema.safeParse({
				...publisher.getSnapshot(),
				status: "ready",
				names: [entry, entry],
			}).success,
		).toBe(false);
		publisher.dispose();
	});

	test("publishes full replacements and increments revision only on state changes", () => {
		const events = bus();
		const publisher = new ShortNamesPublisher(events);
		publisher.setCatalog("ready", [entry], { fetchedAt: 100 });
		const revision = publisher.getSnapshot().revision;
		publisher.setCatalog("ready", [], { fetchedAt: 101 });
		expect(publisher.getSnapshot()).toMatchObject({
			status: "ready",
			names: [],
			revision: revision + 1,
		});
		expect(publisher.setCatalog("ready", [], { fetchedAt: 101 })).toBe(false);
		expect(Object.isFrozen(publisher.getSnapshot().names)).toBe(true);
		publisher.dispose();
	});

	test("replaces oversized snapshots with unavailable and unsubscribes on dispose", () => {
		const events = bus();
		const publisher = new ShortNamesPublisher(events);
		publisher.setCatalog(
			"ready",
			Array.from({ length: 6000 }, (_, i): typeof entry => ({
				provider: "plexus",
				modelId: `model-${i}`,
				shortName: "x".repeat(200),
			})),
		);
		expect(publisher.getSnapshot()).toMatchObject({
			status: "unavailable",
			names: [],
		});
		publisher.dispose();
		expect(events.listenerCount()).toBe(0);
	});
});
