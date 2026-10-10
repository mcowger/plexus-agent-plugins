import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { CONTEXT_BUDGET_OPTION } from "./session-policy.ts";

// ---------------------------------------------------------------------------
// Module mocks: no real network, no user data dir. Registered before the
// plugin module is imported.
// ---------------------------------------------------------------------------

mock.module("./log.ts", () => ({
	createLogger: () => ({
		info: () => {},
		warn: () => {},
		error: () => {},
	}),
}));

mock.module("./cache.ts", () => ({
	getDir: () => "/tmp/plexus-opencode-v2-policy-test",
	filterCachedModels: (models: unknown[]) => models,
	readCachedModels: async () => null,
	writeCache: async () => {},
}));

// ---------------------------------------------------------------------------
// Fetch stub
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let fetchImpl: () => Promise<Response> = async () => {
	throw new Error("unexpected fetch");
};

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function catalogModel(
	id: string,
	opts: {
		serviceTiers?: string[];
		short?: number;
		context?: number;
	} = {},
): Record<string, unknown> {
	const {
		serviceTiers = ["standard", "flex"],
		short = 200_000,
		context = 1_000_000,
	} = opts;
	return {
		id,
		name: id,
		preferred_api: ["chat_completions"],
		architecture: {
			input_modalities: ["text"],
			output_modalities: ["text"],
		},
		context_length: context,
		pricing: {
			prompt: "0.000001",
			completion: "0.000002",
			tiers: [{ input_tokens_above: short }],
		},
		...(serviceTiers.length > 0 ? { service_tiers: serviceTiers } : {}),
	};
}

const catalog = (models: Record<string, unknown>[]) =>
	jsonResponse({ object: "list", data: models });

// ---------------------------------------------------------------------------
// Harness with hook capture + controllable session models
// ---------------------------------------------------------------------------

interface HookRegistration {
	name: string;
	options: unknown;
	callback: (event: Record<string, unknown>) => unknown;
}

interface CommandDefinition {
	name: string;
	description?: string;
	execute: (input: Record<string, unknown>) => Promise<void>;
}

const syntheticCalls: Array<Record<string, unknown>> = [];
let providerReloadCount = 0;

function createHarness(opts: {
	sessionModels?: Map<string, { providerID: string; id: string } | null>;
	withSessionGet?: boolean;
}): {
	ctx: Plugin.Context;
	commands: CommandDefinition[];
	hooks: HookRegistration[];
	registeredModels: Array<Record<string, unknown>>;
} {
	const commands: CommandDefinition[] = [];
	const hooks: HookRegistration[] = [];
	const registeredModels: Array<Record<string, unknown>> = [];
	const sessionModels = opts.sessionModels ?? new Map();

	const editor = {
		list: () => [],
		get: () => undefined,
		add: (input: {
			info: Record<string, unknown>;
			models: readonly Record<string, unknown>[];
		}) => {
			registeredModels.push(...input.models);
		},
		update: (_id: string, fn: (provider: Record<string, unknown>) => void) => {
			fn({});
		},
		remove: () => {},
		models: { set: () => {}, update: () => {}, remove: () => {} },
	};

	const session: Record<string, unknown> = {
		synthetic: async (input: Record<string, unknown>) => {
			syntheticCalls.push(input);
		},
		hook: async (
			name: string,
			callback: (event: Record<string, unknown>) => unknown,
			options?: unknown,
		) => {
			hooks.push({ name, options, callback });
			return { dispose: async () => {} };
		},
	};
	if (opts.withSessionGet !== false) {
		session.get = async ({ sessionID }: { sessionID: string }) => ({
			data: { id: sessionID, model: sessionModels.get(sessionID) ?? null },
		});
	}

	return {
		ctx: {
			options: {
				apiKeyEnv: "POLICY_TEST_KEY",
				plexusBaseURL: "https://plexus.example.com",
			},
			provider: {
				transform: async (cb: (e: typeof editor) => void) => {
					cb(editor);
					return { dispose: async () => {} };
				},
				reload: async () => {
					providerReloadCount++;
				},
			},
			integration: {
				transform: async (
					cb: (e: {
						update: (id: string, fn: (ref: never) => void) => void;
						method: { update: () => void };
					}) => void,
				) => {
					cb({ update: () => {}, method: { update: () => {} } });
					return { dispose: async () => {} };
				},
				connection: {
					active: async () => undefined,
					resolve: async () => undefined,
				},
			},
			command: {
				transform: async (
					cb: (editor: { add: (def: CommandDefinition) => void }) => void,
				) => {
					cb({ add: (def) => commands.push(def) });
					return { dispose: async () => {} };
				},
				list: async () => [],
				reload: async () => {},
			},
			session,
			event: {
				subscribe: () => ({
					[Symbol.asyncIterator]() {
						return {
							next: async () => ({ done: true as const, value: undefined }),
						};
					},
				}),
			},
		} as unknown as Plugin.Context,
		commands,
		hooks,
		registeredModels,
	};
}

/** Fresh plugin module per test: isolates module-level refresh state. */
let importCounter = 0;
async function loadPlugin(): Promise<typeof import("./plugin.ts")["default"]> {
	importCounter++;
	return (await import(`./plugin.ts?policy-test=${importCounter}`)).default;
}

function lastSyntheticText(): string {
	return String(syntheticCalls.at(-1)?.text ?? "");
}

const MANAGED_ENV = [
	"POLICY_TEST_KEY",
	"PLEXUS_API_KEY",
	"PLEXUS_API_URL",
	"PLEXUS_BASE_URL",
];

beforeAll(() => {
	globalThis.fetch = (() => fetchImpl()) as unknown as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

beforeEach(() => {
	syntheticCalls.length = 0;
	providerReloadCount = 0;
	process.env.POLICY_TEST_KEY = "policy-test-key";
	for (const key of ["PLEXUS_API_KEY", "PLEXUS_API_URL", "PLEXUS_BASE_URL"])
		delete process.env[key];
	fetchImpl = async () => catalog([catalogModel("m1")]);
});

afterEach(() => {
	for (const key of MANAGED_ENV) delete process.env[key];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("policy wiring", () => {
	test("setup registers tier/context commands and scoped session hooks", async () => {
		const plugin = await loadPlugin();
		const { ctx, commands, hooks } = createHarness({});
		await plugin.setup(ctx);

		expect(commands.map((c) => c.name).sort()).toEqual([
			"plexus-context",
			"plexus-refresh",
			"plexus-tier",
		]);
		const scoped = hooks.filter((h) =>
			["context", "compaction", "http.request"].includes(h.name),
		);
		expect(scoped).toHaveLength(3);
		for (const hook of scoped) {
			expect(hook.options).toEqual({ providerID: "plexus" });
		}
	});
});

describe("/plexus-tier command", () => {
	test("select, status, unknown-tier rejection, and clear", async () => {
		const plugin = await loadPlugin();
		const sessionModels = new Map([["s1", { providerID: "plexus", id: "m1" }]]);
		const { ctx, commands } = createHarness({ sessionModels });
		await plugin.setup(ctx);
		const tier = commands.find((c) => c.name === "plexus-tier");
		expect(tier).toBeDefined();

		await tier?.execute({ sessionID: "s1", prompt: { text: "flex" } });
		expect(lastSyntheticText()).toContain("this session): flex.");

		await tier?.execute({ sessionID: "s1", prompt: { text: "" } });
		expect(lastSyntheticText()).toContain("this session): flex.");
		expect(lastSyntheticText()).toContain("standard, flex");

		await tier?.execute({ sessionID: "s1", prompt: { text: "ultra" } });
		expect(lastSyntheticText()).toContain("not changed");
		expect(lastSyntheticText()).toContain("not advertised");
		// Rejected atomically: still flex.
		await tier?.execute({ sessionID: "s1", prompt: { text: "status" } });
		expect(lastSyntheticText()).toContain("this session): flex.");

		await tier?.execute({ sessionID: "s1", prompt: { text: "default" } });
		expect(lastSyntheticText()).toContain("default (provider default)");
	});

	test("non-plexus and unknown sessions get guidance, not a crash", async () => {
		const plugin = await loadPlugin();
		const sessionModels = new Map([
			["s-other", { providerID: "other", id: "m9" }],
		]);
		const { ctx, commands } = createHarness({ sessionModels });
		await plugin.setup(ctx);
		const tier = commands.find((c) => c.name === "plexus-tier");

		await tier?.execute({ sessionID: "s-other", prompt: { text: "flex" } });
		expect(lastSyntheticText()).toContain("applies to Plexus models");

		await tier?.execute({ sessionID: "s-new", prompt: { text: "status" } });
		expect(lastSyntheticText()).toContain("No active Plexus model");
	});
});

describe("/plexus-context command", () => {
	test("short/max/status flows with the effective window", async () => {
		const plugin = await loadPlugin();
		const sessionModels = new Map([["s1", { providerID: "plexus", id: "m1" }]]);
		const { ctx, commands } = createHarness({ sessionModels });
		await plugin.setup(ctx);
		const context = commands.find((c) => c.name === "plexus-context");
		expect(context).toBeDefined();

		await context?.execute({ sessionID: "s1", prompt: { text: "" } });
		expect(lastSyntheticText()).toContain("max (1000000 tokens)");

		await context?.execute({ sessionID: "s1", prompt: { text: "short" } });
		expect(lastSyntheticText()).toContain("short (200000 tokens)");

		await context?.execute({ sessionID: "s1", prompt: { text: "max" } });
		expect(lastSyntheticText()).toContain("max (1000000 tokens)");

		await context?.execute({ sessionID: "s1", prompt: { text: "flex" } });
		expect(lastSyntheticText()).toContain("Unknown context selection");
	});

	test("short is rejected when the model has no distinct budget", async () => {
		fetchImpl = async () =>
			catalog([catalogModel("m1", { short: 200_000, context: 200_000 })]);
		const plugin = await loadPlugin();
		const sessionModels = new Map([["s1", { providerID: "plexus", id: "m1" }]]);
		const { ctx, commands } = createHarness({ sessionModels });
		await plugin.setup(ctx);
		const context = commands.find((c) => c.name === "plexus-context");

		await context?.execute({ sessionID: "s1", prompt: { text: "short" } });
		expect(lastSyntheticText()).toContain("not changed");
		expect(lastSyntheticText()).toContain("no distinct");
	});
});

describe("session hooks", () => {
	test("tier injects service_tier per session without leaking", async () => {
		const plugin = await loadPlugin();
		const sessionModels = new Map([
			["s1", { providerID: "plexus", id: "m1" }],
			["s2", { providerID: "plexus", id: "m1" }],
		]);
		const { ctx, commands, hooks } = createHarness({ sessionModels });
		await plugin.setup(ctx);

		const tier = commands.find((c) => c.name === "plexus-tier");
		await tier?.execute({ sessionID: "s1", prompt: { text: "flex" } });

		const httpHook = hooks.find((h) => h.name === "http.request");
		expect(httpHook).toBeDefined();
		const body = () =>
			new Request("https://plexus.example.com/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "m1" }),
			});
		const ref = { providerID: "plexus", id: "m1" };

		const s1Event: Record<string, unknown> = {
			sessionID: "s1",
			model: ref,
			request: body(),
		};
		await httpHook?.callback(s1Event);
		expect(await (s1Event.request as Request).json()).toEqual({
			model: "m1",
			service_tier: "flex",
		});

		// s2 never selected a tier: body untouched (same object).
		const s2Request = body();
		const s2Event: Record<string, unknown> = {
			sessionID: "s2",
			model: ref,
			request: s2Request,
		};
		await httpHook?.callback(s2Event);
		expect(s2Event.request).toBe(s2Request);
		expect(await s2Request.json()).toEqual({ model: "m1" });
	});

	test("context budget rides options per session without leaking", async () => {
		const plugin = await loadPlugin();
		const sessionModels = new Map([
			["s1", { providerID: "plexus", id: "m1" }],
			["s2", { providerID: "plexus", id: "m1" }],
		]);
		const { ctx, commands, hooks } = createHarness({ sessionModels });
		await plugin.setup(ctx);

		const context = commands.find((c) => c.name === "plexus-context");
		await context?.execute({ sessionID: "s1", prompt: { text: "short" } });

		const contextHook = hooks.find((h) => h.name === "context");
		expect(contextHook).toBeDefined();
		const ref = { providerID: "plexus", id: "m1" };

		const s1Options: Record<string, unknown> = {};
		await contextHook?.callback({
			sessionID: "s1",
			model: ref,
			options: s1Options,
		});
		expect(s1Options[CONTEXT_BUDGET_OPTION]).toBe(200_000);

		const s2Options: Record<string, unknown> = {};
		await contextHook?.callback({
			sessionID: "s2",
			model: ref,
			options: s2Options,
		});
		expect(s2Options[CONTEXT_BUDGET_OPTION]).toBe(1_000_000);
	});

	test("model change observed on a hook resets the session", async () => {
		const plugin = await loadPlugin();
		fetchImpl = async () => catalog([catalogModel("m1"), catalogModel("m2")]);
		const sessionModels = new Map([["s1", { providerID: "plexus", id: "m1" }]]);
		const { ctx, commands, hooks } = createHarness({ sessionModels });
		await plugin.setup(ctx);

		const tier = commands.find((c) => c.name === "plexus-tier");
		await tier?.execute({ sessionID: "s1", prompt: { text: "flex" } });
		expect(lastSyntheticText()).toContain("this session): flex.");

		// Session moves to m2: the next hook resets to defaults.
		const contextHook = hooks.find((h) => h.name === "context");
		const options: Record<string, unknown> = {};
		await contextHook?.callback({
			sessionID: "s1",
			model: { providerID: "plexus", id: "m2" },
			options,
		});
		expect(options[CONTEXT_BUDGET_OPTION]).toBe(1_000_000);

		sessionModels.set("s1", { providerID: "plexus", id: "m2" });
		await tier?.execute({ sessionID: "s1", prompt: { text: "status" } });
		expect(lastSyntheticText()).toContain("default (provider default)");
	});

	test("shared model definitions are never mutated for per-session state", async () => {
		const plugin = await loadPlugin();
		const sessionModels = new Map([["s1", { providerID: "plexus", id: "m1" }]]);
		const { ctx, commands, hooks, registeredModels } = createHarness({
			sessionModels,
		});
		await plugin.setup(ctx);
		const snapshot = JSON.parse(JSON.stringify(registeredModels));

		const tier = commands.find((c) => c.name === "plexus-tier");
		const context = commands.find((c) => c.name === "plexus-context");
		await tier?.execute({ sessionID: "s1", prompt: { text: "flex" } });
		await context?.execute({ sessionID: "s1", prompt: { text: "short" } });

		const ref = { providerID: "plexus", id: "m1" };
		const contextHook = hooks.find((h) => h.name === "context");
		const httpHook = hooks.find((h) => h.name === "http.request");
		await contextHook?.callback({
			sessionID: "s1",
			model: ref,
			options: {},
		});
		const event: Record<string, unknown> = {
			sessionID: "s1",
			model: ref,
			request: new Request("https://plexus.example.com/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "m1" }),
			}),
		};
		await httpHook?.callback(event);

		expect(registeredModels).toEqual(snapshot);
		expect(JSON.stringify(registeredModels)).not.toContain("service_tier");
		expect(JSON.stringify(registeredModels)).not.toContain(
			CONTEXT_BUDGET_OPTION,
		);
		for (const model of registeredModels) {
			expect((model as { limit?: { context?: number } }).limit?.context).toBe(
				1_000_000,
			);
		}
	});
});

describe("refresh reconciliation", () => {
	test("/plexus-refresh clears selections the new catalog drops", async () => {
		const plugin = await loadPlugin();
		const sessionModels = new Map([["s1", { providerID: "plexus", id: "m1" }]]);
		const { ctx, commands } = createHarness({ sessionModels });
		await plugin.setup(ctx);

		const tier = commands.find((c) => c.name === "plexus-tier");
		const context = commands.find((c) => c.name === "plexus-context");
		const refresh = commands.find((c) => c.name === "plexus-refresh");
		await tier?.execute({ sessionID: "s1", prompt: { text: "flex" } });
		await context?.execute({ sessionID: "s1", prompt: { text: "short" } });
		expect(lastSyntheticText()).toContain("short (200000 tokens)");

		// New catalog drops "flex" and equalizes the budgets.
		fetchImpl = async () =>
			catalog([
				catalogModel("m1", {
					serviceTiers: ["standard"],
					short: 1_000_000,
					context: 1_000_000,
				}),
			]);
		await refresh?.execute({ sessionID: "s1", delivery: "async" });
		expect(providerReloadCount).toBe(1);
		expect(lastSyntheticText()).toContain("1 models");

		await tier?.execute({ sessionID: "s1", prompt: { text: "status" } });
		expect(lastSyntheticText()).toContain("default (provider default)");
		expect(lastSyntheticText()).toContain("standard");
		expect(lastSyntheticText()).not.toContain("flex");

		await context?.execute({ sessionID: "s1", prompt: { text: "status" } });
		expect(lastSyntheticText()).toContain("max (1000000 tokens)");
	});
});

describe("command model fallback", () => {
	test("commands use the hook-observed model when session.get is absent", async () => {
		const plugin = await loadPlugin();
		const { ctx, commands, hooks } = createHarness({ withSessionGet: false });
		await plugin.setup(ctx);

		// Bind s9 to m1 through a hook observation (no session.get available).
		const contextHook = hooks.find((h) => h.name === "context");
		await contextHook?.callback({
			sessionID: "s9",
			model: { providerID: "plexus", id: "m1" },
			options: {},
		});

		const tier = commands.find((c) => c.name === "plexus-tier");
		await tier?.execute({ sessionID: "s9", prompt: { text: "flex" } });
		expect(lastSyntheticText()).toContain("this session): flex.");
	});
});
