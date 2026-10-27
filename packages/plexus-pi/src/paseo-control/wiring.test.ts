import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import plexusExtension from "../extension.ts";
import { createFakeContext, KEY, readReply } from "./harness.ts";
import { COMMAND_NAME, encodeRequest, SESSION_KEY_ENV } from "./protocol.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const model = {
	provider: "plexus",
	id: "gpt-5.6",
	api: "openai-completions",
	contextWindow: 200_000,
};

/** A minimal Pi surface that records what the extension registers. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: unknown) => unknown }
	>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	let provider:
		{ refreshModels: (context: unknown) => Promise<unknown> } | undefined;
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: unknown) => unknown },
		) => {
			commands.set(name, options);
		},
		registerProvider: (
			_name: string,
			config: { refreshModels: (context: unknown) => Promise<unknown> },
		) => {
			provider = config;
		},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ customType, data });
		},
		events: { on: () => () => undefined, emit: () => undefined },
		getCommands: () => [],
		getThinkingLevel: () => "off",
		setModel: async () => true,
	};
	return {
		api: api as unknown as ExtensionAPI,
		entries,
		providerConfig: () => provider,
		providerCount: () => (provider ? 1 : 0),
		injectorCount: () => handlers.get("before_provider_request")?.length ?? 0,
		async fire(event: string, payload: unknown, ctx: unknown) {
			for (const handler of handlers.get(event) ?? [])
				await handler(payload, ctx);
		},
		requestTierInjection(payload: unknown, ctx: unknown) {
			const [injector] = handlers.get("before_provider_request") ?? [];
			return injector?.({ type: "before_provider_request", payload }, ctx);
		},
		command(args: string, ctx: unknown) {
			return commands.get(COMMAND_NAME)?.handler(args, ctx);
		},
	};
}

function encode(
	operation: string,
	data?: unknown,
	requestId = `${operation}-1`,
): string {
	return encodeRequest({
		version: 1,
		sessionKey: KEY,
		requestId,
		operation,
		...(data === undefined ? {} : { data }),
	} as never);
}

describe("plexusExtension wiring for plexuspi-control", () => {
	let savedKey: string | undefined;
	let savedAgentDir: string | undefined;
	let agentDir: string;

	beforeEach(() => {
		savedKey = process.env[SESSION_KEY_ENV];
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		agentDir = mkdtempSync(join(tmpdir(), "plexuspi-wiring-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env[SESSION_KEY_ENV] = KEY;
	});

	afterEach(() => {
		restore(SESSION_KEY_ENV, savedKey);
		restore("PI_CODING_AGENT_DIR", savedAgentDir);
		rmSync(agentDir, { recursive: true, force: true });
	});

	function restore(name: string, value: string | undefined) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	/** Load a catalog through the provider's own restore path, with a Plexus tier advertisement. */
	async function loadCatalog(pi: ReturnType<typeof fakePi>) {
		const config = pi.providerConfig();
		if (!config) throw new Error("provider was not registered");
		await config.refreshModels({
			allowNetwork: false,
			stored: {
				models: [
					{
						...model,
						name: "GPT 5.6",
						baseUrl: "http://localhost/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						maxTokens: 8_000,
						plexusServiceTiers: {
							policy: {
								provider: "plexus",
								modelId: "gpt-5.6",
								serviceTiers: ["auto", "flex", "priority"],
							},
							fetchedAt: 1,
						},
					},
				],
				checkedAt: 1,
			},
			publish: async (input: { update?: () => void }) => {
				input.update?.();
				return true;
			},
		});
	}

	test("returns an empty catalog during an offline restore without stored models", async () => {
		const pi = fakePi();
		plexusExtension(pi.api);
		const config = pi.providerConfig();
		if (!config) throw new Error("provider was not registered");
		expect(await config.refreshModels({ allowNetwork: false })).toEqual([]);
	});

	test("registers exactly one before_provider_request injector, before and after activation", async () => {
		const pi = fakePi();
		plexusExtension(pi.api);
		expect(pi.providerCount()).toBe(1);
		expect(pi.injectorCount()).toBe(1);

		await loadCatalog(pi);
		const ctx = createFakeContext({ model }).ctx;
		await pi.fire(
			"session_start",
			{},
			{ ...ctx, model, modelRegistry: undefined },
		);
		await pi.command(encode("hello"), ctx);
		expect(pi.injectorCount()).toBe(1);
	});

	test("injects the selected tier once, and only after an authenticated request", async () => {
		const pi = fakePi();
		plexusExtension(pi.api);
		await loadCatalog(pi);
		const ctx = createFakeContext({ model }).ctx;
		await pi.fire(
			"session_start",
			{},
			{ ...ctx, model, modelRegistry: undefined },
		);

		const payload = { model: "gpt-5.6", messages: [] };
		const beforeActivation = await pi.requestTierInjection(payload, { model });
		expect(beforeActivation).toBeUndefined();

		const { ctx: commandCtx, notifies } = createFakeContext({ model });
		await pi.command(encode("configure", { tier: "flex" }), commandCtx);
		expect(readReply(notifies)).toMatchObject({
			ok: true,
			operation: "configure",
		});

		const injected = await pi.requestTierInjection(payload, { model });
		expect(injected).toEqual({ ...payload, service_tier: "flex" });
		const twice = await pi.requestTierInjection(injected, { model });
		expect(twice).toEqual({ ...payload, service_tier: "flex" });
		expect(pi.injectorCount()).toBe(1);
	});

	test("with the env key set but no request, the control module adds no state or entries", async () => {
		const pi = fakePi();
		plexusExtension(pi.api);
		await loadCatalog(pi);
		const ctx = createFakeContext({ model }).ctx;
		await pi.fire(
			"session_start",
			{},
			{ ...ctx, model, modelRegistry: undefined },
		);
		await pi.fire(
			"model_select",
			{ model },
			{ ...ctx, model, modelRegistry: undefined },
		);

		expect(pi.entries).toEqual([]);
		expect(
			await pi.requestTierInjection({ model: "gpt-5.6" }, { model }),
		).toBeUndefined();
	});
});
