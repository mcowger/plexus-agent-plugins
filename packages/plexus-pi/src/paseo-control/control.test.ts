import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ContextPolicy } from "../context-policy.ts";
import { PolicyController } from "../policy.ts";
import type { ServiceTierPolicy } from "../service-tiers.ts";
import { CAPABILITIES, createPlexuspiControl } from "./control.ts";
import {
	createFakeContext,
	createFakePi,
	type FakeModel,
	type FakeNotify,
	KEY,
	notifiesWith,
	readReply,
	setupControl,
} from "./harness.ts";
import {
	CHILD_NOTIFY_PREFIX,
	CUSTOM_ENTRY_TYPE,
	encodeRequest,
	type PlexuspiRequest,
	PlexuspiStateSchema,
	REWIND_ENTRY_TYPE,
	ROOT_SIGNAL_CHANNEL,
	SESSION_KEY_ENV,
	STATE_NOTIFY_PREFIX,
	SUBAGENT_BRIDGE_CHANNEL,
} from "./protocol.ts";

const model: FakeModel = {
	provider: "plexus",
	id: "gpt-5.6",
	api: "openai-responses",
	contextWindow: 200_000,
};
const budget: ContextPolicy = {
	provider: "plexus",
	modelId: "gpt-5.6",
	maxContextTokens: 1_000_000,
	shortContextBudgetTokens: 200_000,
};
const tierFor = (
	modelId: string,
	serviceTiers: string[],
): ServiceTierPolicy => ({
	provider: "plexus",
	modelId,
	serviceTiers,
});
const ALL_TIERS = ["auto", "standard", "flex", "priority", "ultrafast"];

function encode(
	operation: PlexuspiRequest["operation"],
	data?: unknown,
	requestId = `${operation}-1`,
) {
	return encodeRequest({
		version: 1,
		sessionKey: KEY,
		requestId,
		operation,
		...(data === undefined ? {} : { data }),
	});
}

// State fields are asserted one by one; `any` keeps those nested reads readable.
// test accessor for loosely typed reply data
type StateData = Record<string, any>;

function stateOf(notifies: FakeNotify[]): StateData {
	return readReply(notifies).data as StateData;
}

/** The most recent live state publish, for checks made after a reconcile with no reply. */
function liveState(notifies: FakeNotify[]): StateData {
	const latest = notifiesWith(notifies, STATE_NOTIFY_PREFIX).at(-1);
	if (!latest) throw new Error("no live state was published");
	return latest.state as StateData;
}

function controlEntry(data: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "custom",
		customType: CUSTOM_ENTRY_TYPE,
		data: { version: 1, timestamp: 1, ...data },
	};
}

async function activate(
	control: {
		handleArgs: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	},
	ctx: ExtensionCommandContext,
) {
	await control.handleArgs(encode("hello"), ctx as never);
}

function bridgeRecord(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		runId: "run-1",
		sequence: 1,
		type: "created",
		childSessionId: "child-1",
		...overrides,
	};
}

function childNotifies(notifies: FakeNotify[]) {
	return notifiesWith(notifies, CHILD_NOTIFY_PREFIX);
}

afterEach(() => {
	delete process.env[SESSION_KEY_ENV];
});

describe("lazy activation", () => {
	test("stays fully inert with the env key set and no valid request", async () => {
		process.env[SESSION_KEY_ENV] = KEY;
		const { pi, policy, control, ctx, notifies } = setupControl(
			{
				registry: [model],
				policies: [budget],
				branch: [controlEntry({ tier: "flex", longContext: true })],
			},
			{ sessionKey: undefined },
		);
		const signals: unknown[] = [];
		pi.api.events.on(ROOT_SIGNAL_CHANNEL, (data) => signals.push(data));

		await pi.fire("session_start", { type: "session_start" }, ctx);
		await pi.fire("model_select", { model }, ctx);
		await pi.fire("before_agent_start", { type: "before_agent_start" }, ctx);
		pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord());
		await pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);

		expect(control.active).toBe(false);
		// No state publish, no reply, no persisted entry, no root signal.
		expect(notifies).toHaveLength(0);
		expect(pi.entries).toHaveLength(0);
		expect(signals).toHaveLength(0);
		// No bridge subscription.
		expect(pi.channels.get(SUBAGENT_BRIDGE_CHANNEL)?.size ?? 0).toBe(0);
		// No policy application: the saved intent was never restored or reconciled.
		expect(policy.getView().model).toBeUndefined();
		expect(pi.setModelCalls).toHaveLength(0);
		expect(pi.sessionModel?.contextWindow).toBe(200_000);
	});

	test("activates on a valid hello: restores settings, subscribes to children, signals root", async () => {
		const { pi, control, ctx, notifies } = setupControl({
			registry: [model],
			policies: [budget],
			branch: [controlEntry({ tier: "flex", longContext: true })],
			sessionId: "root-session-1",
		});
		const signals: unknown[] = [];
		pi.api.events.on(ROOT_SIGNAL_CHANNEL, (data) => signals.push(data));

		await control.handleArgs(encode("hello"), ctx);

		expect(readReply(notifies)).toMatchObject({ ok: true, operation: "hello" });
		expect(control.active).toBe(true);
		expect(stateOf(notifies).settings).toEqual({
			tier: "flex",
			longContext: true,
		});
		expect(pi.sessionModel?.contextWindow).toBe(1_000_000);
		expect(pi.channels.get(SUBAGENT_BRIDGE_CHANNEL)?.size).toBe(1);
		expect(signals).toEqual([{ version: 1, sessionId: "root-session-1" }]);
	});

	test("a wrong session key is refused and does not activate or touch the session", async () => {
		const { pi, policy, control, ctx, notifies } = setupControl({
			registry: [model],
			policies: [budget],
			branch: [controlEntry({ tier: "flex", longContext: true })],
		});
		for (const operation of ["hello", "configure", "rewind"] as const) {
			await control.handleArgs(
				encodeRequest({
					version: 1,
					sessionKey: "other",
					requestId: `${operation}-x`,
					operation,
					data: operation === "configure" ? { longContext: true } : undefined,
				}),
				ctx,
			);
			expect(readReply(notifies)).toMatchObject({
				ok: false,
				requestId: `${operation}-x`,
			});
			expect(readReply(notifies).error).toContain("mismatch");
		}
		expect(control.active).toBe(false);
		expect(notifiesWith(notifies, STATE_NOTIFY_PREFIX)).toHaveLength(0);
		expect(pi.channels.get(SUBAGENT_BRIDGE_CHANNEL)?.size ?? 0).toBe(0);
		expect(pi.entries).toHaveLength(0);
		expect(policy.getView().model).toBeUndefined();
		expect(pi.setModelCalls).toHaveLength(0);
	});

	test("refuses every request when PLEXUSPI_SESSION_KEY is unset", async () => {
		delete process.env[SESSION_KEY_ENV];
		const pi = createFakePi({ registry: [model] });
		const policy = new PolicyController(pi.host);
		const control = createPlexuspiControl(pi.api, { policy, host: pi.host });
		const fake = createFakeContext({ pi });
		await control.handleArgs(encode("hello"), fake.ctx);
		expect(readReply(fake.notifies)).toMatchObject({ ok: false });
		expect(readReply(fake.notifies).error).toContain(SESSION_KEY_ENV);
		expect(control.active).toBe(false);
	});

	test("replies correlated errors for malformed and unknown requests without activating", async () => {
		const { control, ctx, notifies } = setupControl({ registry: [model] });
		await control.handleArgs("!!!not-base64!!!", ctx);
		expect(readReply(notifies)).toMatchObject({
			ok: false,
			operation: "hello",
		});
		expect(readReply(notifies).error).toMatch(/base64url|JSON/);

		await control.handleArgs(
			encodeRequest({
				version: 1,
				sessionKey: KEY,
				requestId: "c1",
				operation: "compact",
			} as never),
			ctx,
		);
		expect(readReply(notifies)).toMatchObject({
			ok: false,
			requestId: "c1",
			operation: "hello",
		});
		expect(control.active).toBe(false);
	});

	test("does not expose a compact operation", () => {
		expect(CAPABILITIES).not.toContain("compact");
	});
});

describe("hello and state", () => {
	test("reports the state shape with defaults", async () => {
		const { control, ctx, notifies } = setupControl({
			model,
			sessionId: "sess-42",
		});
		await control.handleArgs(encode("hello"), ctx);
		const reply = readReply(notifies);
		expect(reply).toMatchObject({
			ok: true,
			operation: "hello",
			requestId: "hello-1",
		});
		const data = stateOf(notifies);
		expect(data.capabilities).toEqual([...CAPABILITIES]);
		expect(data.settings).toEqual({ tier: "default", longContext: false });
		expect(data.origin).toBe("root");
		expect(data.tiers).toEqual([]);
		expect(data.tierApplicable).toBe(false);
		expect(data.conflicts).toEqual([]);
		expect(data.longContextTarget).toBeUndefined();
		expect(data.longContextAvailable).toBe(false);
		expect(data.contextWindow).toBe(200_000);
		expect(data.sessionId).toBe("sess-42");
		expect(data.activeChildren).toBe(0);
		expect(() => PlexuspiStateSchema.parse(data)).not.toThrow();
	});

	test("get-state returns the same state", async () => {
		const { control, ctx, notifies } = setupControl({ registry: [model] });
		await activate(control, ctx);
		await control.handleArgs(encode("get-state"), ctx);
		expect(readReply(notifies)).toMatchObject({
			ok: true,
			operation: "get-state",
		});
		expect(stateOf(notifies).origin).toBe("root");
	});

	test("reports a pi-microgpt conflict with its resolution and fails hello", async () => {
		const { control, ctx, notifies } = setupControl({
			registry: [model],
			commands: [{ name: "fast", source: "extension" }],
		});
		await control.handleArgs(encode("hello"), ctx);
		const reply = readReply(notifies);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("pi-microgpt");
		expect(reply.error).toContain("Disable");
		expect(stateOf(notifies).conflicts).toHaveLength(1);
	});

	test("does not treat plexus-pi or unrelated extension commands as conflicts", async () => {
		const { control, ctx, notifies } = setupControl({
			registry: [model],
			commands: [
				{ name: "service-tier", source: "extension" },
				{ name: "plexus-catalog", source: "extension" },
			],
		});
		await control.handleArgs(encode("hello"), ctx);
		expect(readReply(notifies).ok).toBe(true);
		expect(stateOf(notifies).conflicts).toEqual([]);
	});
});

describe("configure", () => {
	test("applies a tier and persists a branch-local custom entry", async () => {
		const { pi, control, ctx, notifies } = setupControl({
			registry: [model],
			policies: [budget],
			tierPolicies: [tierFor("gpt-5.6", ["auto", "priority", "flex"])],
		});
		await activate(control, ctx);
		await control.handleArgs(encode("configure", { tier: "fast" }), ctx);
		const reply = readReply(notifies);
		expect(reply.ok).toBe(true);
		expect(stateOf(notifies)).toMatchObject({
			settings: { tier: "priority" },
			tierApplicable: true,
		});
		expect(pi.entries.at(-1)).toMatchObject({
			customType: CUSTOM_ENTRY_TYPE,
			data: {
				version: 1,
				tier: "priority",
				longContext: false,
				timestamp: 1234,
			},
		});
	});

	test("rejects unknown configure fields", async () => {
		const { control, ctx, notifies } = setupControl({ registry: [model] });
		await activate(control, ctx);
		await control.handleArgs(encode("configure", { turbo: true }), ctx);
		expect(readReply(notifies)).toMatchObject({ ok: false });
		expect(readReply(notifies).error).toContain("invalid configure data");
	});

	test("expands a session-local clone without mutating the catalog and restores the short budget", async () => {
		const { pi, control, ctx, notifies } = setupControl({
			registry: [model],
			policies: [budget],
		});
		await activate(control, ctx);
		expect(pi.sessionModel?.contextWindow).toBe(200_000);

		await control.handleArgs(encode("configure", { longContext: true }), ctx);
		let reply = readReply(notifies);
		expect(reply.ok).toBe(true);
		expect(stateOf(notifies)).toMatchObject({
			settings: { longContext: true },
			contextWindow: 1_000_000,
			modelBaselineContextWindow: 200_000,
		});
		expect(pi.sessionModel?.contextWindow).toBe(1_000_000);
		expect(model.contextWindow).toBe(200_000);
		expect(pi.findModel("plexus", "gpt-5.6")?.contextWindow).toBe(200_000);

		await control.handleArgs(
			encode("configure", { longContext: false }, "configure-2"),
			ctx,
		);
		reply = readReply(notifies);
		expect(reply.ok).toBe(true);
		expect(stateOf(notifies)).toMatchObject({
			settings: { longContext: false },
			contextWindow: 200_000,
		});
		expect(pi.sessionModel?.contextWindow).toBe(200_000);
		expect(model.contextWindow).toBe(200_000);
	});

	test("derives the expanded budget from the catalog across repeated toggles", async () => {
		const { pi, control, ctx, notifies } = setupControl({
			registry: [model],
			policies: [budget],
		});
		await activate(control, ctx);
		await control.handleArgs(encode("configure", { longContext: true }), ctx);
		await control.handleArgs(
			encode("configure", { longContext: false }, "c2"),
			ctx,
		);
		await control.handleArgs(
			encode("configure", { longContext: true }, "c3"),
			ctx,
		);
		expect(readReply(notifies).ok).toBe(true);
		expect(stateOf(notifies).contextWindow).toBe(1_000_000);
		expect(pi.setModelCalls.map((call) => call.contextWindow)).toEqual([
			1_000_000, 200_000, 1_000_000,
		]);
	});

	test("fails honestly when the model has no distinct budgets", async () => {
		const { control, ctx, notifies } = setupControl({ registry: [model] });
		await activate(control, ctx);
		await control.handleArgs(encode("configure", { longContext: true }), ctx);
		expect(readReply(notifies)).toMatchObject({ ok: false });
		expect(readReply(notifies).error).toContain("no distinct");
		expect(stateOf(notifies).settings.longContext).toBe(false);
	});

	test("keeps the previous tier and writes no entry when long context cannot be applied", async () => {
		const { pi, control, ctx, notifies } = setupControl({
			registry: [model],
			policies: [budget],
		});
		await activate(control, ctx);
		pi.setModelRefuses = true;
		await control.handleArgs(
			encode("configure", { tier: "fast", longContext: true }),
			ctx,
		);
		const reply = readReply(notifies);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("could not apply");
		expect(stateOf(notifies)).toMatchObject({
			settings: { tier: "auto", longContext: false },
			contextPolicyError: expect.any(String),
		});
		expect(pi.entries).toHaveLength(0);
		expect(pi.sessionModel?.contextWindow).toBe(200_000);
	});

	test("keeps the toggle available after an apply refusal so the user can retry", async () => {
		const { pi, control, ctx, notifies } = setupControl({
			registry: [model],
			policies: [budget],
		});
		await activate(control, ctx);
		await control.handleArgs(encode("configure", { longContext: true }), ctx);
		pi.setModelRefuses = true;
		await control.handleArgs(
			encode("configure", { longContext: false }, "c2"),
			ctx,
		);
		expect(readReply(notifies).ok).toBe(false);
		expect(stateOf(notifies)).toMatchObject({
			longContextAvailable: true,
			settings: { longContext: true },
			contextPolicyError: expect.any(String),
		});
		pi.setModelRefuses = false;
		await control.handleArgs(
			encode("configure", { longContext: false }, "c3"),
			ctx,
		);
		expect(pi.sessionModel?.contextWindow).toBe(200_000);
		expect(stateOf(notifies).contextPolicyError).toBeUndefined();
	});

	test("accepts only advertised spellings and maps legacy fast when advertised", async () => {
		const { control, ctx, notifies } = setupControl({
			registry: [model],
			tierPolicies: [tierFor("gpt-5.6", ["flex", "priority"])],
		});
		await activate(control, ctx);
		await control.handleArgs(encode("configure", { tier: "turbo" }), ctx);
		expect(readReply(notifies).ok).toBe(false);
		await control.handleArgs(
			encode("configure", { tier: "ultrafast" }, "u"),
			ctx,
		);
		expect(readReply(notifies).error).toContain("not advertised");
		await control.handleArgs(encode("configure", { tier: "fast" }, "f"), ctx);
		expect(readReply(notifies).ok).toBe(true);
		expect(stateOf(notifies).settings.tier).toBe("priority");
	});

	test("premium-only lists start unselected and inject nothing", async () => {
		const { policy, control, ctx, notifies } = setupControl({
			registry: [model],
			tierPolicies: [tierFor("gpt-5.6", ["priority", "flex"])],
		});
		await activate(control, ctx);
		expect(stateOf(notifies)).toMatchObject({
			settings: { tier: "default" },
			tierApplicable: false,
		});
		expect(
			policy.serviceTierFor({ provider: "plexus", id: "gpt-5.6" }),
		).toBeNull();
	});
});

describe("model switches and metadata", () => {
	test("re-applies expansion to a catalog model selected while long context is on", async () => {
		const next: FakeModel = {
			provider: "plexus",
			id: "claude",
			api: "anthropic-messages",
			contextWindow: 300_000,
		};
		const nextBudget: ContextPolicy = {
			provider: "plexus",
			modelId: "claude",
			maxContextTokens: 1_000_000,
			shortContextBudgetTokens: 300_000,
		};
		const { pi, policy, control, ctx, notifies } = setupControl({
			registry: [model, next],
			policies: [budget, nextBudget],
		});
		await activate(control, ctx);
		await control.handleArgs(encode("configure", { longContext: true }), ctx);
		pi.sessionModel = next;
		await policy.reconcile();
		expect(pi.sessionModel?.contextWindow).toBe(1_000_000);
		expect(next.contextWindow).toBe(300_000);
		expect(readReply(notifies).ok).toBe(true);
	});

	test("does not reapply when the active window already matches", async () => {
		const { pi, policy, control, ctx } = setupControl({
			registry: [model],
			policies: [budget],
		});
		await activate(control, ctx);
		await control.handleArgs(encode("configure", { longContext: true }), ctx);
		const calls = pi.setModelCalls.length;
		await policy.reconcile();
		await policy.reconcile();
		expect(pi.setModelCalls).toHaveLength(calls);
	});

	test("clears On intent when the catalog is ready but the model has no policy", async () => {
		const other: FakeModel = {
			provider: "plexus",
			id: "other",
			api: "openai-completions",
			contextWindow: 128_000,
		};
		const { pi, policy, control, ctx, notifies } = setupControl({
			registry: [model, other],
			policies: [budget],
		});
		await activate(control, ctx);
		await control.handleArgs(encode("configure", { longContext: true }), ctx);
		pi.sessionModel = other;
		await policy.reconcile();
		expect(pi.sessionModel?.contextWindow).toBe(128_000);
		expect(liveState(notifies).settings.longContext).toBe(false);

		pi.sessionModel = model;
		await policy.reconcile();
		expect(pi.sessionModel?.contextWindow).toBe(200_000);
	});

	test("keeps saved On intent while metadata is missing and applies it when a policy arrives", async () => {
		const policies: ContextPolicy[] = [];
		const { pi, policy, control, ctx, notifies } = setupControl({
			registry: [model],
			policies,
			branch: [controlEntry({ tier: "default", longContext: true })],
		});
		await activate(control, ctx);
		expect(liveState(notifies).settings.longContext).toBe(false);
		expect(pi.sessionModel?.contextWindow).toBe(200_000);

		policies.push(budget);
		await policy.reconcile();
		expect(liveState(notifies).settings.longContext).toBe(true);
		expect(pi.sessionModel?.contextWindow).toBe(1_000_000);
	});

	test("retains a chosen tier across unsupported models and reapplies it when supported again", async () => {
		const next: FakeModel = {
			provider: "plexus",
			id: "next",
			api: "openai-completions",
			contextWindow: 100_000,
		};
		const tiers: ServiceTierPolicy[] = [tierFor("gpt-5.6", ALL_TIERS)];
		const { pi, policy, control, ctx, notifies } = setupControl({
			registry: [model, next],
			tierPolicies: tiers,
		});
		await activate(control, ctx);
		await control.handleArgs(encode("configure", { tier: "flex" }), ctx);
		pi.sessionModel = next;
		await policy.reconcile();
		expect(liveState(notifies).settings.tier).toBe("default");
		expect(pi.entries.at(-1)?.data).toMatchObject({ tier: "flex" });

		pi.sessionModel = model;
		await policy.reconcile();
		expect(policy.serviceTierFor({ provider: "plexus", id: "gpt-5.6" })).toBe(
			"flex",
		);
	});

	test("keeps tier intent while tier metadata is absent and applies it on a later snapshot", async () => {
		const tiers: ServiceTierPolicy[] = [];
		const { policy, control, ctx, notifies } = setupControl({
			registry: [model],
			tierPolicies: tiers,
			branch: [controlEntry({ tier: "flex", longContext: false })],
		});
		await activate(control, ctx);
		expect(liveState(notifies)).toMatchObject({
			tiers: [],
			settings: { tier: "default" },
		});
		tiers.push(tierFor("gpt-5.6", ALL_TIERS));
		await policy.reconcile();
		expect(liveState(notifies).settings.tier).toBe("flex");
	});

	test("migrates a saved legacy fast tier to priority on restore", async () => {
		const { control, ctx, notifies } = setupControl({
			registry: [model],
			tierPolicies: [tierFor("gpt-5.6", ["standard", "priority"])],
			branch: [controlEntry({ tier: "fast", longContext: false })],
		});
		await activate(control, ctx);
		expect(stateOf(notifies)).toMatchObject({
			settings: { tier: "priority" },
			tierApplicable: true,
		});
	});

	test("repairs a session model silently replaced before a turn starts", async () => {
		const catalog: FakeModel = { ...model, contextWindow: 1_000_000 };
		const { pi, control, ctx } = setupControl({
			registry: [catalog],
			policies: [{ ...budget, shortContextBudgetTokens: 100_000 }],
		});
		await activate(control, ctx);
		expect(pi.sessionModel?.contextWindow).toBe(100_000);
		pi.sessionModel = catalog;
		await pi.fire("before_agent_start", { type: "before_agent_start" }, ctx);
		expect(pi.sessionModel?.contextWindow).toBe(100_000);
	});
});

describe("owned child bridge and shutdown", () => {
	test("forwards accepted child records after activation and drops invalid ones", async () => {
		const { pi, control, ctx, notifies } = setupControl({ registry: [model] });
		pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord());
		expect(childNotifies(notifies)).toHaveLength(0);

		await activate(control, ctx);
		pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord());
		pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord({ version: 2 }));
		pi.emitEvent(
			SUBAGENT_BRIDGE_CHANNEL,
			bridgeRecord({ runId: "run-2", sequence: 5, surprise: true }),
		);

		const forwarded = childNotifies(notifies);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0]).toMatchObject({ version: 1, sessionKey: KEY });
		expect(forwarded[0]?.record).toMatchObject({ runId: "run-1" });
	});

	test("tracks active children and clears them on terminal records", async () => {
		const { pi, control, ctx, notifies } = setupControl({ registry: [model] });
		await activate(control, ctx);
		pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord({ runId: "run-a" }));
		pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord({ runId: "run-b" }));
		expect(control.activeChildren()).toBe(2);
		pi.emitEvent(
			SUBAGENT_BRIDGE_CHANNEL,
			bridgeRecord({ runId: "run-a", sequence: 2, type: "terminal" }),
		);
		expect(control.activeChildren()).toBe(1);
		await control.handleArgs(encode("get-state"), ctx);
		expect(stateOf(notifies).activeChildren).toBe(1);
	});

	test("stops forwarding after session shutdown", async () => {
		const { pi, control, ctx, notifies } = setupControl({ registry: [model] });
		await activate(control, ctx);
		pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord());
		expect(childNotifies(notifies)).toHaveLength(1);
		await pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);
		pi.emitEvent(
			SUBAGENT_BRIDGE_CHANNEL,
			bridgeRecord({ sequence: 2, type: "terminal" }),
		);
		expect(childNotifies(notifies)).toHaveLength(1);
		expect(pi.channels.get(SUBAGENT_BRIDGE_CHANNEL)?.size ?? 0).toBe(0);
	});

	test("publishes live state notifications, separate from replies", async () => {
		const { pi, control, ctx, notifies } = setupControl({
			registry: [model],
			policies: [budget],
		});
		await activate(control, ctx);
		const states = notifiesWith(notifies, STATE_NOTIFY_PREFIX);
		expect(states.length).toBeGreaterThan(0);
		expect(states.at(-1)).toMatchObject({ version: 1, sessionKey: KEY });
		expect(pi.sessionModel?.contextWindow).toBe(200_000);
	});
});

describe("rewind", () => {
	const userEntry = (id: string, parentId: string | null = null) => ({
		id,
		parentId,
		type: "message",
		message: { role: "user", content: "hello" },
	});
	const assistantEntry = (id: string, parentId: string | null) => ({
		id,
		parentId,
		type: "message",
		message: { role: "assistant", content: "hi" },
	});
	const rewind = (targetEntryId: string, requestId = "rewind-1") =>
		encode("rewind", { targetEntryId }, requestId);

	async function setupRewind(seed: Parameters<typeof setupControl>[0] = {}) {
		const fixture = setupControl({ registry: [model], ...seed });
		await activate(fixture.control, fixture.ctx);
		fixture.notifies.length = 0;
		return fixture;
	}

	test("rejects while the agent is busy", async () => {
		const { control, ctx, notifies, navigations } = await setupRewind({
			idle: false,
			branch: [userEntry("u1")],
		});
		await control.handleArgs(rewind("u1"), ctx);
		expect(readReply(notifies).ok).toBe(false);
		expect(readReply(notifies).error).toContain("idle");
		expect(navigations).toHaveLength(0);
	});

	test("rejects while a compaction is in progress", async () => {
		const { pi, control, ctx, notifies, navigations } = await setupRewind({
			branch: [userEntry("u1")],
		});
		await pi.fire(
			"session_before_compact",
			{ type: "session_before_compact" },
			ctx,
		);
		await control.handleArgs(rewind("u1"), ctx);
		expect(readReply(notifies).error).toContain("compaction");
		expect(navigations).toHaveLength(0);
	});

	test("rejects while owned children are active", async () => {
		const { pi, control, ctx, notifies, navigations } = await setupRewind({
			branch: [userEntry("u1")],
		});
		pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord());
		await control.handleArgs(rewind("u1"), ctx);
		expect(readReply(notifies).error).toContain("owned child");
		expect(navigations).toHaveLength(0);
	});

	test("rejects targets off the active branch and non-user targets", async () => {
		const { control, ctx, notifies, navigations } = await setupRewind({
			branch: [userEntry("u1"), assistantEntry("a1", "u1")],
		});
		await control.handleArgs(rewind("missing"), ctx);
		expect(readReply(notifies).error).toContain("active branch");
		await control.handleArgs(rewind("a1", "r2"), ctx);
		expect(readReply(notifies).error).toContain("user message");
		expect(navigations).toHaveLength(0);
	});

	test("rejects unknown rewind data", async () => {
		const { control, ctx, notifies } = await setupRewind({
			branch: [userEntry("u1")],
		});
		await control.handleArgs(
			encode("rewind", { targetEntryId: "u1", surprise: true }, "bad"),
			ctx,
		);
		expect(readReply(notifies).error).toContain("invalid rewind data");
	});

	test("navigates without summarization, pins the branch, and reports the result", async () => {
		const { pi, control, ctx, notifies, navigations } = await setupRewind({
			branch: [
				userEntry("u1"),
				assistantEntry("a1", "u1"),
				userEntry("u2", "a1"),
			],
			navigateLeafId: "a1",
		});
		await control.handleArgs(rewind("u2"), ctx);
		const reply = readReply(notifies);
		expect(reply.ok).toBe(true);
		expect(navigations).toEqual([
			{ targetId: "u2", options: { summarize: false } },
		]);
		expect(stateOf(notifies)).toMatchObject({
			cancelled: false,
			targetEntryId: "u2",
			leafId: "a1",
			settings: { tier: "auto", longContext: false },
			activeChildren: 0,
		});
		expect(pi.entries.at(-1)).toMatchObject({
			customType: REWIND_ENTRY_TYPE,
			data: { version: 1, targetEntryId: "u2", leafId: "a1", timestamp: 1234 },
		});
	});

	test("restores controls from the rewound branch", async () => {
		const { control, ctx, notifies } = await setupRewind({
			branch: [
				userEntry("u1"),
				assistantEntry("a1", "u1"),
				userEntry("u2", "a1"),
				{
					id: "control-1",
					parentId: "u2",
					...controlEntry({ tier: "ultrafast", longContext: false }),
				},
			],
			navigateLeafId: "a1",
		});
		await control.handleArgs(rewind("u2"), ctx);
		expect(readReply(notifies).ok).toBe(true);
		expect(stateOf(notifies).settings.tier).toBe("ultrafast");
	});

	test("reports a cancelled navigation without pinning the branch", async () => {
		const { pi, control, ctx, notifies } = await setupRewind({
			branch: [
				userEntry("u1"),
				assistantEntry("a1", "u1"),
				userEntry("u2", "a1"),
			],
			navigateCancelled: true,
		});
		await control.handleArgs(rewind("u2"), ctx);
		const reply = readReply(notifies);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("cancelled");
		expect(stateOf(notifies).cancelled).toBe(true);
		expect(pi.entries).toHaveLength(0);
	});

	test("reports a navigation error without pinning the branch", async () => {
		const { pi, control, ctx, notifies } = await setupRewind({
			branch: [
				userEntry("u1"),
				assistantEntry("a1", "u1"),
				userEntry("u2", "a1"),
			],
			navigateThrows:
				"Wait for the current compaction or tree navigation to finish",
		});
		await control.handleArgs(rewind("u2"), ctx);
		expect(readReply(notifies).error).toContain("navigation failed");
		expect(pi.entries).toHaveLength(0);
	});
});

describe("reload", () => {
	const reload = (requestId = "reload-1") =>
		encode("reload", undefined, requestId);

	async function setupReload(seed: Parameters<typeof setupControl>[0] = {}) {
		const fixture = setupControl({ registry: [model], ...seed });
		await activate(fixture.control, fixture.ctx);
		fixture.notifies.length = 0;
		return fixture;
	}

	test("replies ok before reloading when idle", async () => {
		const { control, ctx, notifies, reloads } = await setupReload();
		await control.handleArgs(reload(), ctx);
		expect(readReply(notifies)).toMatchObject({
			ok: true,
			operation: "reload",
		});
		expect(reloads).toHaveLength(1);
		expect(reloads[0]?.notifies).toBe(1);
	});

	test("rejects while busy, compacting, or with active children", async () => {
		const busy = await setupReload({ idle: false });
		await busy.control.handleArgs(reload(), busy.ctx);
		expect(readReply(busy.notifies).error).toContain("busy");
		expect(busy.reloads).toHaveLength(0);

		const compacting = await setupReload();
		await compacting.pi.fire(
			"session_before_compact",
			{ type: "session_before_compact" },
			compacting.ctx,
		);
		await compacting.control.handleArgs(reload(), compacting.ctx);
		expect(readReply(compacting.notifies).error).toContain("compaction");
		expect(compacting.reloads).toHaveLength(0);

		const children = await setupReload();
		children.pi.emitEvent(SUBAGENT_BRIDGE_CHANNEL, bridgeRecord());
		await children.control.handleArgs(reload(), children.ctx);
		expect(readReply(children.notifies).error).toContain("owned child");
		expect(children.reloads).toHaveLength(0);
	});
});

describe("single request-injection path", () => {
	test("the control module registers no before_provider_request handler", async () => {
		const { pi, control, ctx } = setupControl({
			registry: [model],
			policies: [budget],
		});
		await activate(control, ctx);
		expect(pi.handlers.get("before_provider_request")).toBeUndefined();
	});
});
