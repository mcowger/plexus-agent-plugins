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

// ---------------------------------------------------------------------------
// Module mocks: keep setup/command tests off the real network and out of the
// user's ~/.local/share/opencode data directory. Registered before plugin.ts
// is dynamically imported below.
// ---------------------------------------------------------------------------

const logCalls: Array<{ level: "info" | "warn" | "error"; message: string }> =
	[];

mock.module("./log.ts", () => ({
	createLogger: () => ({
		info: (message: string) => logCalls.push({ level: "info", message }),
		warn: (message: string) => logCalls.push({ level: "warn", message }),
		error: (message: string) => logCalls.push({ level: "error", message }),
	}),
}));

mock.module("./cache.ts", () => ({
	getDir: () => "/tmp/plexus-opencode-v2-test",
	filterCachedModels: (models: unknown[]) => models,
	readCachedModels: async () => null,
	writeCache: async () => {},
}));

// ---------------------------------------------------------------------------
// Fetch stub (fetchPlexusModels calls global fetch)
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchImpl: (input: string, init?: RequestInit) => Promise<Response> =
	async () => {
		throw new Error("unexpected fetch");
	};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

function chatModel(id: string): Record<string, unknown> {
	return {
		id,
		name: id,
		preferred_api: ["chat_completions"],
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		context_length: 1000,
		pricing: { prompt: "0.000001", completion: "0.000002" },
	};
}

// ---------------------------------------------------------------------------
// Minimal in-memory stand-ins for the opencode plugin context domains
// ---------------------------------------------------------------------------

const syntheticCalls: Array<Record<string, unknown>> = [];
let providerReloadCount = 0;

interface ProviderRecordLike {
	provider: {
		id: string;
		name: string;
		package: string;
		settings?: Record<string, unknown>;
	};
	models: Map<string, unknown>;
}

function createProviderDomain(): {
	domain: Record<string, unknown>;
	records: Map<string, ProviderRecordLike>;
} {
	const records = new Map<string, ProviderRecordLike>();
	const editor = {
		list: () => [...records.values()],
		get: (id: string) => records.get(id),
		add: (input: {
			info: ProviderRecordLike["provider"];
			models: readonly { id: string }[];
		}) => {
			records.set(input.info.id, {
				provider: input.info,
				models: new Map(input.models.map((m) => [m.id, m])),
			});
		},
		update: (
			id: string,
			fn: (provider: ProviderRecordLike["provider"]) => void,
		) => {
			const record = records.get(id);
			if (record) fn(record.provider);
		},
		remove: (id: string) => {
			records.delete(id);
		},
		models: { set: () => {}, update: () => {}, remove: () => {} },
	};
	return {
		domain: {
			transform: async (cb: (e: typeof editor) => void) => {
				cb(editor);
				return { dispose: async () => {} };
			},
			reload: async () => {
				providerReloadCount++;
			},
		},
		records,
	};
}

function createIntegrationDomain(): Record<string, unknown> {
	const refs = new Map<string, { id: string; name: string }>();
	const editor = {
		list: () => [...refs.values()],
		get: (id: string) => refs.get(id),
		update: (id: string, fn: (ref: { id: string; name: string }) => void) => {
			const ref = refs.get(id) ?? { id, name: id };
			refs.set(id, ref);
			fn(ref);
		},
		remove: (id: string) => {
			refs.delete(id);
		},
		method: { list: () => [], update: () => {}, remove: () => {} },
	};
	return {
		transform: async (cb: (e: typeof editor) => void) => {
			cb(editor);
			return { dispose: async () => {} };
		},
		reload: async () => {},
		connection: {
			active: async () => undefined,
			resolve: async () => undefined,
		},
	};
}

interface CommandDefinitionLike {
	name: string;
	execute: (input: { sessionID: string; delivery: string }) => Promise<void>;
}

function createHarness(options: Record<string, unknown>): {
	ctx: Plugin.Context;
	commands: CommandDefinitionLike[];
	records: Map<string, ProviderRecordLike>;
} {
	const commands: CommandDefinitionLike[] = [];
	const provider = createProviderDomain();
	return {
		ctx: {
			options,
			provider: provider.domain,
			integration: createIntegrationDomain(),
			command: {
				transform: async (
					cb: (editor: { add: (def: CommandDefinitionLike) => void }) => void,
				) => {
					cb({ add: (def) => commands.push(def) });
					return { dispose: async () => {} };
				},
				list: async () => [],
				reload: async () => {},
			},
			session: {
				synthetic: async (input: Record<string, unknown>) => {
					syntheticCalls.push(input);
				},
				hook: async () => ({ dispose: async () => {} }),
			},
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
		records: provider.records,
	};
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let plugin: typeof import("./plugin.ts")["default"];

const MANAGED_ENV = [
	"PLUGIN_V2_TEST_KEY",
	"PLUGIN_V2_TEST_MISSING",
	"PLEXUS_API_KEY",
	"PLEXUS_API_URL",
	"PLEXUS_BASE_URL",
];

beforeAll(async () => {
	globalThis.fetch = ((input: string, init?: RequestInit) => {
		fetchCalls.push({ url: String(input), init });
		return fetchImpl(input, init);
	}) as typeof fetch;
	plugin = (await import("./plugin.ts")).default;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

beforeEach(() => {
	logCalls.length = 0;
	syntheticCalls.length = 0;
	fetchCalls.length = 0;
	providerReloadCount = 0;
	fetchImpl = async () => {
		throw new Error("unexpected fetch");
	};
	for (const key of MANAGED_ENV) delete process.env[key];
});

afterEach(() => {
	for (const key of MANAGED_ENV) delete process.env[key];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plugin setup", () => {
	test("registers the plexus provider with resolved settings and live models", async () => {
		process.env.PLUGIN_V2_TEST_KEY = "secret-key-value";
		fetchImpl = async () =>
			jsonResponse({ object: "list", data: [chatModel("m1")] });

		const { ctx, records } = createHarness({
			apiKeyEnv: "PLUGIN_V2_TEST_KEY",
			plexusBaseURL: "https://plexus.example.com",
		});
		await plugin.setup(ctx);

		const record = records.get("plexus");
		expect(record).toBeDefined();
		expect(record?.provider.name).toBe("Plexus");
		expect(record?.provider.package).toBe("aisdk:@ai-sdk/openai-compatible");
		expect(record?.provider.settings?.apiKey).toBe("secret-key-value");
		expect(record?.provider.settings?.baseURL).toBe(
			"https://plexus.example.com/v1",
		);
		expect(record?.models.has("m1")).toBe(true);

		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("https://plexus.example.com/v1/models");
		expect(
			(fetchCalls[0]?.init?.headers as Record<string, string>)?.Authorization,
		).toBe("Bearer secret-key-value");
	});

	test("logs and rethrows when apiKeyEnv names a missing variable", async () => {
		const { ctx } = createHarness({ apiKeyEnv: "PLUGIN_V2_TEST_MISSING" });

		await expect(plugin.setup(ctx)).rejects.toThrow(/missing or empty/);
		expect(fetchCalls).toHaveLength(0);

		const errorLog = logCalls.find(
			(entry) =>
				entry.level === "error" && entry.message.includes("setup failed"),
		);
		expect(errorLog).toBeDefined();
		expect(errorLog?.message).toContain("PLUGIN_V2_TEST_MISSING");
		expect(errorLog?.message).not.toContain("secret-key-value");
	});
});

describe("/plexus-refresh command", () => {
	test("reloads providers and posts a synthetic status when the refresh succeeds", async () => {
		process.env.PLUGIN_V2_TEST_KEY = "secret-key-value";
		fetchImpl = async () =>
			jsonResponse({ object: "list", data: [chatModel("m1")] });

		const { ctx, commands } = createHarness({
			apiKeyEnv: "PLUGIN_V2_TEST_KEY",
			plexusBaseURL: "https://plexus.example.com",
		});
		await plugin.setup(ctx);

		const command = commands.find((c) => c.name === "plexus-refresh");
		expect(command).toBeDefined();
		await command?.execute({ sessionID: "s1", delivery: "async" });

		expect(providerReloadCount).toBe(1);
		const status = syntheticCalls.at(-1);
		expect(status?.resume).toBe(false);
		expect(String(status?.text)).toContain("1 models");
	});

	test("logs and posts a synthetic error (not rejecting) when apiKeyEnv resolves unavailable later", async () => {
		process.env.PLUGIN_V2_TEST_KEY = "secret-key-value";
		fetchImpl = async () =>
			jsonResponse({ object: "list", data: [chatModel("m1")] });

		const { ctx, commands } = createHarness({
			apiKeyEnv: "PLUGIN_V2_TEST_KEY",
			plexusBaseURL: "https://plexus.example.com",
		});
		await plugin.setup(ctx);

		const command = commands.find((c) => c.name === "plexus-refresh");
		expect(command).toBeDefined();

		// Simulate key rotation removing the env var after setup.
		const fetchCountAfterSetup = fetchCalls.length;
		providerReloadCount = 0;
		delete process.env.PLUGIN_V2_TEST_KEY;

		await command?.execute({ sessionID: "s2", delivery: "async" });

		// No silent fallback: provider.reload must not run and no live fetch occurs.
		expect(providerReloadCount).toBe(0);
		expect(fetchCalls.length).toBe(fetchCountAfterSetup);

		const status = syntheticCalls.at(-1);
		expect(status?.resume).toBe(false);
		expect(String(status?.text)).toContain("PLUGIN_V2_TEST_KEY");
		expect(String(status?.text)).toContain("Existing state left untouched");
		expect(String(status?.text)).not.toContain("secret-key-value");

		const errorLog = logCalls.find(
			(entry) =>
				entry.level === "error" && entry.message.includes("refresh failed"),
		);
		expect(errorLog).toBeDefined();
		expect(errorLog?.message).not.toContain("secret-key-value");
	});
});
