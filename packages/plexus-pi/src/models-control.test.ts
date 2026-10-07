import { describe, expect, test } from "bun:test";
import {
	ModelsControl,
	MODELS_REFRESH_CHANNEL,
	MODELS_REFRESH_FAILED_REASON,
	MODELS_STATE_CHANNEL,
	ModelsRefreshSchema,
	ModelsStateSchema,
	type ModelsControlHost,
} from "./models-control.ts";

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

function makeHost() {
	let calls = 0;
	let mode: "ok" | "error" | "manual" = "ok";
	let release: (() => void) | undefined;
	const host: ModelsControlHost = {
		async refresh() {
			calls++;
			if (mode === "error") throw new Error("boom");
			if (mode === "manual") {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return { modelCount: 42 };
		},
	};
	return {
		host,
		calls: () => calls,
		setMode: (next: "ok" | "error" | "manual") => {
			mode = next;
		},
		release: () => release?.(),
	};
}

describe("models refresh control", () => {
	test("refreshes once, broadcasts refreshing then ready, and correlates the reply", async () => {
		const events = bus();
		const state = makeHost();
		const control = new ModelsControl(events, state.host);
		await events.dispatch(MODELS_REFRESH_CHANNEL, { version: 1, requestId: "r1" });

		expect(state.calls()).toBe(1);
		expect(control.getState()).toMatchObject({ status: "ready", modelCount: 42, revision: 3 });
		expect(events.emitted.map((entry) => entry.data.status)).toEqual(["refreshing", "ready", "ready"]);
		expect(events.emitted[0]!.data.requestId).toBeUndefined();
		expect(events.emitted[1]!.data.requestId).toBeUndefined();
		const reply = events.emitted.at(-1)!;
		expect(reply.channel).toBe(MODELS_STATE_CHANNEL);
		expect(reply.data).toMatchObject({ requestId: "r1", status: "ready", modelCount: 42, revision: 3 });
		expect(Object.isFrozen(control.getState())).toBe(true);
		control.dispose();
	});

	test("coalesces concurrent commands into a single refresh", async () => {
		const events = bus();
		const state = makeHost();
		state.setMode("manual");
		const control = new ModelsControl(events, state.host);
		const first = events.dispatch(MODELS_REFRESH_CHANNEL, { version: 1, requestId: "a" });
		const second = events.dispatch(MODELS_REFRESH_CHANNEL, { version: 1, requestId: "b" });
		state.release();
		await Promise.all([first, second]);
		expect(state.calls()).toBe(1);
		expect(events.emitted.filter((entry) => entry.data.status === "refreshing")).toHaveLength(1);
		expect(events.emitted.filter((entry) => entry.data.requestId === "a")).toHaveLength(1);
		expect(events.emitted.filter((entry) => entry.data.requestId === "b")).toHaveLength(1);
		control.dispose();
	});

	test("reports a failed refresh with a safe reason and an unchanged correlated reply", async () => {
		const events = bus();
		const state = makeHost();
		state.setMode("error");
		const control = new ModelsControl(events, state.host);
		await events.dispatch(MODELS_REFRESH_CHANNEL, { version: 1, requestId: "bad" });
		expect(control.getState()).toMatchObject({ status: "error", reason: MODELS_REFRESH_FAILED_REASON });
		expect(control.getState().modelCount).toBeUndefined();
		expect(events.emitted.at(-1)!.data).toMatchObject({
			requestId: "bad",
			status: "error",
			reason: MODELS_REFRESH_FAILED_REASON,
		});
		control.dispose();
	});

	test("ignores malformed commands and unsubscribes on dispose", async () => {
		const events = bus();
		const state = makeHost();
		const control = new ModelsControl(events, state.host);
		await events.dispatch(MODELS_REFRESH_CHANNEL, { version: 2, requestId: "bad" });
		await events.dispatch(MODELS_REFRESH_CHANNEL, { version: 1, requestId: "" });
		await events.dispatch(MODELS_REFRESH_CHANNEL, { version: 1, requestId: "x", force: true });
		expect(events.emitted).toHaveLength(0);
		expect(state.calls()).toBe(0);
		control.dispose();
		expect(events.listenerCount(MODELS_REFRESH_CHANNEL)).toBe(0);
	});

	test("validates the command and state contracts", () => {
		expect(ModelsRefreshSchema.safeParse({ version: 1, requestId: "x" }).success).toBe(true);
		expect(ModelsRefreshSchema.safeParse({ version: 1 }).success).toBe(false);
		expect(ModelsRefreshSchema.safeParse({ version: 1, requestId: "x", force: true }).success).toBe(false);
		expect(
			ModelsStateSchema.safeParse({
				version: 1,
				publisherId: "00000000-0000-4000-8000-000000000000",
				revision: 1,
				status: "idle",
			}).success,
		).toBe(true);
		expect(
			ModelsStateSchema.safeParse({
				version: 1,
				publisherId: "00000000-0000-4000-8000-000000000000",
				revision: 1,
				status: "unknown",
			}).success,
		).toBe(false);
	});
});
