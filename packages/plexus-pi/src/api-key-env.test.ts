import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	ModelRegistry,
	ModelRuntime,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
	createModels,
	createProvider,
	InMemoryCredentialStore,
	type Api,
	type ApiKeyAuth,
	type Credential,
	type Model,
	type OAuthAuth,
	type Provider,
	type ProviderAuth,
} from "@earendil-works/pi-ai";
import {
	getApiKeyEnvName,
	getEnvApiKey,
	isApiKeyEnvExplicit,
	resetConfigCache,
	resolveApiKey,
	resolveExplicitApiKey,
} from "./config.ts";
import plexusExtension, { withAuthoritativeApiKeyEnv } from "./extension.ts";

const CUSTOM_ENV = "AIHOME_PI_API_KEY";
const MANAGED_ENV = [CUSTOM_ENV, "PLEXUS_API_KEY"];

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "plexus-pi-apikey-"));
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	resetConfigCache();
});

afterEach(() => {
	for (const key of MANAGED_ENV) delete process.env[key];
	delete process.env["PI_CODING_AGENT_DIR"];
	resetConfigCache();
	rmSync(agentDir, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>): void {
	const dir = join(agentDir, "extensions", "plexus");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
	resetConfigCache();
}

interface CapturedProvider {
	name: string;
	config?: ProviderConfig;
	native?: Provider;
}

function fakePi(): {
	pi: ExtensionAPI;
	providers: CapturedProvider[];
	sessionStart: Array<(event: unknown, ctx: ExtensionContext) => unknown>;
} {
	const providers: CapturedProvider[] = [];
	const sessionStart: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
	const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		on: (channel: string, handler: (data: unknown) => void) => {
			const handlers = eventHandlers.get(channel) ?? new Set(); handlers.add(handler); eventHandlers.set(channel, handlers);
			return () => handlers.delete(handler);
		},
		emit: (channel: string, data: unknown) => { for (const handler of eventHandlers.get(channel) ?? []) handler(data); },
	};
	const noop = () => {};
	const pi = {
		events,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			if (event === "session_start") sessionStart.push(handler);
		},
		registerCommand: noop,
		registerProvider: (nameOrProvider: string | Provider, config?: ProviderConfig) => {
			if (typeof nameOrProvider === "string") {
				providers.push({ name: nameOrProvider, config });
			} else {
				providers.push({ name: nameOrProvider.id, native: nameOrProvider });
			}
		},
	};
	return { pi: pi as unknown as ExtensionAPI, providers, sessionStart };
}

function captureProvider(): ProviderConfig {
	const { pi, providers } = fakePi();
	plexusExtension(pi);
	const provider = providers.find((entry) => entry.name === "plexus" && entry.config);
	if (!provider?.config) throw new Error("plexus provider was not registered");
	return provider.config;
}

describe("apiKeyEnv default behavior", () => {
	test("omitted apiKeyEnv uses PLEXUS_API_KEY", () => {
		process.env["PLEXUS_API_KEY"] = "default-key";
		expect(getApiKeyEnvName()).toBe("PLEXUS_API_KEY");
		expect(resolveExplicitApiKey()).toBeUndefined();
		expect(getEnvApiKey()).toBe("default-key");
	});

	test("omitted apiKeyEnv leaves PLEXUS_API_KEY optional", () => {
		delete process.env["PLEXUS_API_KEY"];
		expect(getEnvApiKey()).toBeNull();
		expect(resolveApiKey("stored-key")).toBe("stored-key");
		expect(resolveApiKey(undefined)).toBeUndefined();
	});
});

describe("apiKeyEnv custom variable", () => {
	test("selects the named environment variable", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env[CUSTOM_ENV] = "custom-key";

		expect(getApiKeyEnvName()).toBe(CUSTOM_ENV);
		expect(resolveExplicitApiKey()).toBe("custom-key");
		expect(resolveApiKey("stored-key")).toBe("custom-key");
	});

	test("trims whitespace from the named variable", () => {
		writeConfig({ apiKeyEnv: `  ${CUSTOM_ENV}  ` });
		process.env[CUSTOM_ENV] = "  custom-key  ";
		expect(resolveExplicitApiKey()).toBe("custom-key");
	});
});

describe("apiKeyEnv missing and empty", () => {
	test("missing variable throws without falling back", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env["PLEXUS_API_KEY"] = "default-key";

		expect(() => resolveExplicitApiKey()).toThrow(/is missing or empty/);
		expect(() => resolveApiKey("stored-key")).toThrow(/is missing or empty/);
	});

	test("empty and whitespace-only variable throw without falling back", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env["PLEXUS_API_KEY"] = "default-key";

		for (const value of ["", "   "]) {
			process.env[CUSTOM_ENV] = value;
			expect(() => resolveExplicitApiKey()).toThrow(/is missing or empty/);
			expect(() => resolveApiKey("stored-key")).toThrow(/is missing or empty/);
		}
	});

	test("error names the variable without including a value", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		try {
			resolveExplicitApiKey();
			throw new Error("expected resolveExplicitApiKey to throw");
		} catch (error) {
			expect(String(error)).toContain(CUSTOM_ENV);
		}
	});
});

describe("apiKeyEnv validation", () => {
	test("invalid name throws a generic error that does not echo the input", () => {
		const invalid = "not a var!";
		writeConfig({ apiKeyEnv: invalid });

		expect(() => getApiKeyEnvName()).toThrow(/Invalid apiKeyEnv/);
		expect(() => resolveExplicitApiKey()).toThrow(/Invalid apiKeyEnv/);
		try {
			getApiKeyEnvName();
		} catch (error) {
			expect(String(error)).not.toContain(invalid);
		}
	});

	test("empty and non-string names are invalid", () => {
		writeConfig({ apiKeyEnv: "" });
		expect(() => getApiKeyEnvName()).toThrow(/Invalid apiKeyEnv/);

		writeConfig({ apiKeyEnv: 42 });
		expect(() => getApiKeyEnvName()).toThrow(/Invalid apiKeyEnv/);
	});
});

describe("apiKeyEnv precedence", () => {
	test("default keeps the stored credential ahead of PLEXUS_API_KEY", () => {
		process.env["PLEXUS_API_KEY"] = "default-key";
		expect(resolveApiKey("stored-key")).toBe("stored-key");
	});

	test("explicit apiKeyEnv outranks the stored credential", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env[CUSTOM_ENV] = "custom-key";
		process.env["PLEXUS_API_KEY"] = "default-key";
		expect(resolveApiKey("stored-key")).toBe("custom-key");
	});

	test("explicit apiKeyEnv is authoritative even when it names PLEXUS_API_KEY", () => {
		writeConfig({ apiKeyEnv: "PLEXUS_API_KEY" });
		process.env["PLEXUS_API_KEY"] = "explicit-key";
		expect(resolveApiKey("stored-key")).toBe("explicit-key");
	});
});

describe("apiKeyEnv provider registration", () => {
	test("registers the default PLEXUS_API_KEY template when omitted", () => {
		process.env["PLEXUS_API_KEY"] = "default-key";
		expect(captureProvider().apiKey).toBe("${PLEXUS_API_KEY}");
	});

	test("registers the configured variable name as the apiKey template", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env[CUSTOM_ENV] = "custom-key";
		expect(captureProvider().apiKey).toBe(`\${${CUSTOM_ENV}}`);
	});

	test("omits the apiKey template when no default key is configured", () => {
		expect(captureProvider().apiKey).toBeUndefined();
	});

	test("aborts registration when an explicit apiKeyEnv is missing", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env["PLEXUS_API_KEY"] = "default-key";
		expect(() => plexusExtension(fakePi().pi)).toThrow(/is missing or empty/);
	});

	test("stored OAuth credential is ignored when apiKeyEnv is explicit", () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env[CUSTOM_ENV] = "custom-key";
		const oauth = captureProvider().oauth;
		if (!oauth) throw new Error("expected an oauth login provider");
		expect(oauth.getApiKey({ access: "stored-key", refresh: "stored-key" } as never)).toBe("custom-key");
	});

	test("stored OAuth credential is used when apiKeyEnv is omitted", () => {
		const oauth = captureProvider().oauth;
		if (!oauth) throw new Error("expected an oauth login provider");
		expect(oauth.getApiKey({ access: "stored-key", refresh: "stored-key" } as never)).toBe("stored-key");
	});
});

// ---------------------------------------------------------------------------
// Real host auth resolution (pi-ai `Models`), which resolves provider auth once
// per request before any model API dialect is selected.
// ---------------------------------------------------------------------------

const STUB_API = {
	stream: () => {
		throw new Error("stream not used by auth tests");
	},
	streamSimple: () => {
		throw new Error("streamSimple not used by auth tests");
	},
};

function chatModel(id: string, api: string): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider: "plexus",
		baseUrl: "https://plexus.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as unknown as Model<Api>;
}

/** Mirrors the legacy composer: a stored key wins, otherwise the env template. */
function legacyApiKeyAuth(): ApiKeyAuth {
	return {
		name: "API key",
		resolve: async (input) => {
			if (input.credential?.key) {
				return { auth: { apiKey: input.credential.key }, source: "stored credential" };
			}
			const value = await input.ctx.env("PLEXUS_API_KEY");
			return value ? { auth: { apiKey: value }, source: "PLEXUS_API_KEY" } : undefined;
		},
	};
}

/** Mirrors the extension OAuth projection: explicit apiKeyEnv, else the token. */
function extensionOAuth(): OAuthAuth {
	return {
		name: "Plexus",
		login: async () => {
			throw new Error("login not used by auth tests");
		},
		refresh: async (credential) => credential,
		toAuth: async (credential) => ({
			apiKey: resolveExplicitApiKey() ?? String(credential.access || credential.refresh || ""),
		}),
	};
}

function composedProvider(options: { oauth?: boolean } = {}): Provider {
	const auth: ProviderAuth = {
		apiKey: legacyApiKeyAuth(),
		...(options.oauth ? { oauth: extensionOAuth() } : {}),
	};
	return createProvider({
		id: "plexus",
		name: "Plexus",
		auth,
		models: [chatModel("gpt", "openai-completions"), chatModel("claude", "anthropic-messages"), chatModel("gemini", "google-generative-ai")],
		api: STUB_API as never,
	});
}

async function resolveEffectiveApiKey(input: { provider: Provider; stored?: Credential }): Promise<string | undefined> {
	const credentials = new InMemoryCredentialStore();
	if (input.stored) {
		await credentials.modify("plexus", async () => input.stored);
	}
	const models = createModels({ credentials });
	models.setProvider(input.provider);
	return (await models.getAuth("plexus"))?.auth.apiKey;
}

describe("apiKeyEnv real host auth resolution", () => {
	test("explicit apiKeyEnv overrides a saved plain api_key", async () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env[CUSTOM_ENV] = "custom-key";
		process.env["PLEXUS_API_KEY"] = "default-key";

		const provider = withAuthoritativeApiKeyEnv(composedProvider(), CUSTOM_ENV);
		const key = await resolveEffectiveApiKey({ provider, stored: { type: "api_key", key: "stored-key" } });
		expect(key).toBe("custom-key");
	});

	test("explicit apiKeyEnv overrides a saved OAuth credential", async () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env[CUSTOM_ENV] = "custom-key";

		const provider = withAuthoritativeApiKeyEnv(composedProvider({ oauth: true }), CUSTOM_ENV);
		const key = await resolveEffectiveApiKey({
			provider,
			stored: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 3_600_000 },
		});
		expect(key).toBe("custom-key");
	});

	test("explicit apiKeyEnv applies across every model API dialect", async () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env[CUSTOM_ENV] = "custom-key";

		const credentials = new InMemoryCredentialStore();
		await credentials.modify("plexus", async () => ({ type: "api_key", key: "stored-key" }));
		const models = createModels({ credentials });
		models.setProvider(withAuthoritativeApiKeyEnv(composedProvider(), CUSTOM_ENV));

		for (const id of ["gpt", "claude", "gemini"]) {
			const model = models.getModel("plexus", id);
			if (!model) throw new Error(`expected model ${id}`);
			expect((await models.getAuth(model))?.auth.apiKey).toBe("custom-key");
		}
	});

	test("missing explicit apiKeyEnv rejects instead of falling back", async () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		delete process.env[CUSTOM_ENV];
		process.env["PLEXUS_API_KEY"] = "default-key";

		const provider = withAuthoritativeApiKeyEnv(composedProvider(), CUSTOM_ENV);
		await expect(
			resolveEffectiveApiKey({ provider, stored: { type: "api_key", key: "stored-key" } }),
		).rejects.toThrow(/is missing or empty/);
	});

	test("omitted apiKeyEnv preserves the stored-credential default", async () => {
		writeConfig({});
		process.env["PLEXUS_API_KEY"] = "default-key";

		expect(isApiKeyEnvExplicit()).toBe(false);
		const key = await resolveEffectiveApiKey({
			provider: composedProvider(),
			stored: { type: "api_key", key: "stored-key" },
		});
		expect(key).toBe("stored-key");
	});
});

describe("apiKeyEnv native auth override registration", () => {
	test("session_start upgrades to a native provider with authoritative auth", async () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV });
		process.env[CUSTOM_ENV] = "custom-key";

		const { pi, providers, sessionStart } = fakePi();
		plexusExtension(pi);
		expect(providers.filter((entry) => entry.config)).toHaveLength(1);
		expect(providers.some((entry) => entry.native)).toBe(false);

		const ctx = { modelRegistry: { getProvider: () => composedProvider() } } as unknown as ExtensionContext;
		for (const handler of sessionStart) handler({ type: "session_start", reason: "new" }, ctx);

		const native = providers.find((entry) => entry.native)?.native;
		if (!native) throw new Error("expected a native provider registration");
		const key = await resolveEffectiveApiKey({ provider: native, stored: { type: "api_key", key: "stored-key" } });
		expect(key).toBe("custom-key");
	});

	test("omitted apiKeyEnv does not upgrade the provider", () => {
		writeConfig({});
		const { pi, providers, sessionStart } = fakePi();
		plexusExtension(pi);

		const ctx = { modelRegistry: { getProvider: () => composedProvider() } } as unknown as ExtensionContext;
		for (const handler of sessionStart) handler({ type: "session_start", reason: "new" }, ctx);

		expect(providers.some((entry) => entry.native)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Per-model headers (copied from built-in pi metadata by the mapper) must
// survive the native apiKeyEnv auth swap. A real ModelRuntime is required
// because the loss happens in its extension-provider bookkeeping.
// ---------------------------------------------------------------------------

const MODEL_HEADERS = { "X-Plexus-Model-Header": "gpt-headers" };

function storedModel(id: string, headers?: Record<string, string>): ProviderModelConfig {
	return {
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://plexus.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...(headers ? { headers } : {}),
	};
}

function writeStoredCatalog(models: ProviderModelConfig[]): void {
	writeFileSync(
		join(agentDir, "models-store.json"),
		JSON.stringify({ plexus: { models, checkedAt: 0 } }),
		"utf8",
	);
}

/** Wires the extension into a real ModelRuntime, as pi does at session start. */
function runtimeExtension(runtime: ModelRuntime): {
	pi: ExtensionAPI;
	startSession: () => void;
} {
	const sessionStart: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const pi = {
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				const handlers = listeners.get(channel) ?? new Set(); handlers.add(handler); listeners.set(channel, handlers);
				return () => handlers.delete(handler);
			},
			emit: (channel: string, data: unknown) => { for (const handler of listeners.get(channel) ?? []) handler(data); },
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			if (event === "session_start") sessionStart.push(handler);
		},
		registerCommand: () => {},
		registerProvider: (nameOrProvider: string | Provider, config?: ProviderConfig) => {
			if (typeof nameOrProvider === "string") {
				runtime.registerProvider(nameOrProvider, config as never);
			} else {
				runtime.registerNativeProvider(nameOrProvider);
			}
		},
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		startSession: () => {
			const ctx = { modelRegistry: new ModelRegistry(runtime) } as unknown as ExtensionContext;
			for (const handler of sessionStart) handler({ type: "session_start", reason: "new" }, ctx);
		},
	};
}

describe("apiKeyEnv auth swap on a real runtime", () => {
	test("per-model headers survive the native provider swap", async () => {
		writeConfig({ apiKeyEnv: CUSTOM_ENV, baseUrl: "https://plexus.example.com" });
		process.env[CUSTOM_ENV] = "custom-key";
		writeStoredCatalog([storedModel("gpt-headers", MODEL_HEADERS)]);

		const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		const { pi, startSession } = runtimeExtension(runtime);
		plexusExtension(pi);

		const before = await runtime.getAuth(runtime.getModel("plexus", "gpt-headers")!);
		expect(before?.auth.headers?.["X-Plexus-Model-Header"]).toBe("gpt-headers");

		startSession();

		const model = runtime.getModel("plexus", "gpt-headers");
		if (!model) throw new Error("expected the plexus model after the swap");
		expect(model.headers?.["X-Plexus-Model-Header"]).toBe("gpt-headers");

		const after = await runtime.getAuth(model);
		expect(after?.auth.apiKey).toBe("custom-key");
		expect(after?.auth.headers?.["X-Plexus-Model-Header"]).toBe("gpt-headers");
		expect(after?.auth.headers?.["Authorization"]).toBe("Bearer custom-key");
	});

	test("the wrapper re-reads the header source so post-swap models keep headers", () => {
		const headerModels: Array<{ id: string; headers?: Record<string, string> }> = [
			{ id: "gpt", headers: { "X-Model": "gpt" } },
		];
		const wrapped = withAuthoritativeApiKeyEnv(composedProvider(), CUSTOM_ENV, () => headerModels);

		expect(wrapped.getModels().find((model) => model.id === "gpt")?.headers).toEqual({ "X-Model": "gpt" });

		headerModels.push({ id: "claude", headers: { "X-Model": "claude" } });
		expect(wrapped.getModels().find((model) => model.id === "claude")?.headers).toEqual({ "X-Model": "claude" });
	});
});
