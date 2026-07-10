import { afterEach, describe, expect, test } from "bun:test";
import {
	adjustBaseUrl,
	convertDescriptors,
	convertToDescriptor,
	fetchPlexusModels,
	inferReasoning,
	mapPreferredApi,
} from "./convert.ts";
import type { PlexusApiModel } from "./types.ts";

describe("adjustBaseUrl", () => {
	test("strips trailing /v1 for anthropic messages models", () => {
		expect(adjustBaseUrl("https://plexus.example.com/v1", "anthropic-messages")).toBe(
			"https://plexus.example.com",
		);
	});

	test("preserves /v1 for openai-compatible models", () => {
		expect(adjustBaseUrl("https://plexus.example.com/v1", "openai-completions")).toBe(
			"https://plexus.example.com/v1",
		);
	});

	test("switches /v1 to /v1beta for google models", () => {
		expect(adjustBaseUrl("https://plexus.example.com/v1", "google-generative-ai")).toBe(
			"https://plexus.example.com/v1beta",
		);
	});

	test("remains stable when the anthropic base URL is already a root URL", () => {
		expect(adjustBaseUrl("https://plexus.example.com", "anthropic-messages")).toBe(
			"https://plexus.example.com",
		);
	});
});

describe("mapPreferredApi", () => {
	test("uses the first recognized preferred_api entry", () => {
		expect(mapPreferredApi(["unknown", "messages", "chat_completions"])).toBe("anthropic-messages");
	});

	test("falls back to openai-compatible completions", () => {
		expect(mapPreferredApi(["unknown"])).toBe("openai-completions");
	});
});

describe("convertToDescriptor", () => {
	const baseModel: PlexusApiModel = {
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		preferred_api: ["messages"],
		context_length: 200_000,
		architecture: {
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
		},
		pricing: {
			prompt: "0.0000008",
			completion: "0.000004",
			input_cache_read: "0.00000008",
			input_cache_write: "0.000001",
			tiers: [
				{
					input_tokens_above: 272_000,
					prompt: "0.0000016",
					completion: "0.000006",
					input_cache_read: "0.00000016",
					input_cache_write: "0.000002",
				},
			],
		},
		supported_parameters: ["tools", "reasoning_effort"],
		top_provider: {
			max_completion_tokens: 16_384,
		},
		pi_provider: "anthropic",
		pi_model: "claude-haiku-4-5",
		pi_options: { supportsTemperature: false },
	};

	test("maps new Plexus metadata into the host-neutral descriptor", () => {
		const descriptor = convertToDescriptor(baseModel, "https://plexus.example.com/v1");

		expect(descriptor).toMatchObject({
			id: "claude-haiku-4-5",
			name: "Claude Haiku 4.5",
			preferredApi: "anthropic-messages",
			provider: "plexus",
			baseUrl: "https://plexus.example.com",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.0000008,
				output: 0.000004,
				cacheRead: 0.00000008,
				cacheWrite: 0.000001,
				tiers: [
					{
						inputTokensAbove: 272_000,
						input: 0.0000016,
						output: 0.000006,
						cacheRead: 0.00000016,
						cacheWrite: 0.000002,
					},
				],
			},
			contextWindow: 200_000,
			maxTokens: 16_384,
			piProvider: "anthropic",
			piModel: "claude-haiku-4-5",
			piOptions: { supportsTemperature: false },
		});
	});

	test("skips models with falsy ids during batch conversion", () => {
		const descriptors = convertDescriptors(
			[baseModel, { ...baseModel, id: "" }],
			"https://plexus.example.com/v1",
		);

		expect(descriptors.map((model) => model.id)).toEqual(["claude-haiku-4-5"]);
	});
});

describe("inferReasoning", () => {
	test("detects any supported reasoning parameter", () => {
		expect(inferReasoning({ id: "reasoner", supported_parameters: ["include_reasoning"] })).toBe(true);
	});
});

describe("fetchPlexusModels", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("omits Authorization when no API key is provided", async () => {
		let headers: unknown;
		globalThis.fetch = (async (_url, init) => {
			headers = init?.headers;
			return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
		}) as typeof fetch;

		await fetchPlexusModels("", "https://plexus.example.com/v1/models");

		expect(headers).toEqual({ Accept: "application/json" });
	});

	test("sends Authorization when an API key is provided", async () => {
		let headers: unknown;
		globalThis.fetch = (async (_url, init) => {
			headers = init?.headers;
			return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
		}) as typeof fetch;

		await fetchPlexusModels("secret", "https://plexus.example.com/v1/models");

		expect(headers).toEqual({
			Accept: "application/json",
			Authorization: "Bearer secret",
		});
	});
});
