import { describe, expect, test } from "bun:test";
import type { PlexusApiModel } from "../../plexus-models/src/index.ts";
import {
	buildModels,
	orderModelsByApiBase,
	placeholderModel,
} from "./mapper.ts";

const API_BASE = "https://plexus.example.com/v1";

function apiModel(
	overrides: Partial<PlexusApiModel> & { id: string },
): PlexusApiModel {
	return { ...overrides };
}

const LIVE_SHAPES: PlexusApiModel[] = [
	apiModel({
		id: "gpt-6.1-sol",
		name: "GPT 6.1 Sol",
		preferred_api: ["responses"],
		context_length: 1050000,
		architecture: {
			input_modalities: ["text", "image", "pdf"],
			output_modalities: ["text"],
		},
		pricing: { prompt: "0.000002", completion: "0.00001" },
		supported_parameters: ["tools", "tool_choice", "reasoning", "image"],
		top_provider: { context_length: 1050000, max_completion_tokens: 128000 },
		created: 1790711221,
	}),
	apiModel({
		id: "claude-haiku-4-5",
		preferred_api: ["messages"],
		context_length: 200000,
		architecture: {
			input_modalities: ["text", "image", "pdf"],
			output_modalities: ["text"],
		},
		pricing: { prompt: "0.000001", completion: "0.000005" },
		supported_parameters: [
			"tools",
			"tool_choice",
			"temperature",
			"reasoning",
			"image",
		],
		reasoning_options: [
			{ type: "effort", values: ["off", "minimal", "low", "medium", "high"] },
		],
		top_provider: { context_length: 200000, max_completion_tokens: 64000 },
		created: 1790711221,
	}),
	apiModel({
		id: "gemini-3.5-flash-lite",
		preferred_api: ["gemini"],
		context_length: 1048576,
		architecture: {
			input_modalities: ["text", "image", "video", "audio", "pdf"],
			output_modalities: ["text"],
		},
		pricing: { prompt: "3e-7", completion: "0.0000025" },
		supported_parameters: [
			"tools",
			"tool_choice",
			"temperature",
			"reasoning",
			"image",
		],
		reasoning_options: [
			{ type: "effort", values: ["minimal", "low", "medium", "high"] },
		],
		top_provider: { context_length: 1048576, max_completion_tokens: 65536 },
	}),
	apiModel({
		id: "deepseek-v4.1-flash",
		preferred_api: ["chat_completions"],
		context_length: 1048576,
		architecture: {
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
		},
		pricing: { prompt: "3e-7", completion: "0.0000012" },
		supported_parameters: [
			"tools",
			"tool_choice",
			"temperature",
			"reasoning",
			"image",
		],
		top_provider: { context_length: 1048576, max_completion_tokens: 943718 },
	}),
	// Non-chat models must be filtered
	apiModel({
		id: "text-embedding-3-small",
		context_length: 8191,
		architecture: {
			input_modalities: ["text"],
			output_modalities: ["embeddings"],
		},
	}),
	apiModel({
		id: "gpt-4o-mini-transcribe",
		architecture: { input_modalities: ["audio"], output_modalities: ["text"] },
	}),
	apiModel({
		id: "gpt-4o-mini-tts",
		context_length: 128000,
		architecture: { input_modalities: ["text"], output_modalities: ["audio"] },
	}),
	apiModel({
		id: "gemini-3.1-flash-image",
		context_length: 131072,
		architecture: {
			input_modalities: ["text", "image", "video", "pdf"],
			output_modalities: ["text", "image"],
		},
	}),
];

describe("buildModels (V2 Model.Info)", () => {
	const models = buildModels(LIVE_SHAPES, API_BASE);
	const byId = new Map(models.map((m) => [m.id, m]));

	test("publishes exactly the chat set: gpt-6.1-sol once, no fast/pro, no duplicates", () => {
		const ids = models.map((m) => m.id);
		expect(ids.filter((id) => id === "gpt-6.1-sol")).toHaveLength(1);
		expect(ids).not.toContain("gpt-6.1-sol-fast");
		expect(ids).not.toContain("gpt-6.1-sol-pro");
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([
			"gpt-6.1-sol",
			"claude-haiku-4-5",
			"deepseek-v4.1-flash",
			"gemini-3.5-flash-lite",
		]);
	});

	test("wire names are bare slugs with no slash", () => {
		for (const m of models) {
			expect(m.id).not.toContain("/");
			expect(m.modelID).toBe(m.id);
			expect(m.providerID).toBe("plexus");
		}
	});

	test("responses model selects the Responses runtime on /v1", () => {
		const m = byId.get("gpt-6.1-sol");
		expect(m?.package).toBe("aisdk:@ai-sdk/openai");
		expect(m?.settings?.baseURL).toBe("https://plexus.example.com/v1");
		expect(m?.capabilities).toEqual({
			tools: true,
			input: ["text", "image", "pdf"],
			output: ["text"],
		});
		expect(m?.limit).toEqual({ context: 1050000, output: 128000 });
		expect(m?.cost).toEqual([
			{ input: 2, output: 10, cache: { read: 0, write: 0 } },
		]);
		expect(m?.time.released).toBe(1790711221000);
		expect(m?.status).toBe("active");
		expect(m?.enabled).toBe(true);
	});

	test("anthropic model uses the anthropic SDK runtime with effort variants", () => {
		const m = byId.get("claude-haiku-4-5");
		expect(m?.package).toBe("aisdk:@ai-sdk/anthropic");
		expect(m?.settings?.baseURL).toBe("https://plexus.example.com/v1");
		const variantIds = (m?.variants ?? []).map((v) => v.id);
		expect(variantIds).toEqual(["none", "minimal", "low", "medium", "high"]);
		expect(m?.variants[0]?.settings).toEqual({ effort: "none" });
	});

	test("gemini model uses the google SDK runtime on /v1beta", () => {
		const m = byId.get("gemini-3.5-flash-lite");
		expect(m?.package).toBe("aisdk:@ai-sdk/google");
		expect(m?.settings?.baseURL).toBe("https://plexus.example.com/v1beta");
	});

	test("deepseek chat model keeps openai-completions defaults with reasoning compat", () => {
		const m = byId.get("deepseek-v4.1-flash");
		expect(m?.package).toBeUndefined();
		expect(m?.compatibility).toEqual({ reasoningField: "reasoning_content" });
	});

	test("context/output fallbacks apply when top_provider is absent", () => {
		const [only] = buildModels(
			[
				apiModel({
					id: "bare",
					architecture: {
						input_modalities: ["text"],
						output_modalities: ["text"],
					},
				}),
			],
			API_BASE,
		);
		expect(only?.limit).toEqual({ context: 250000, output: 50000 });
		expect(only?.cost).toEqual([]);
	});

	test("suppression patterns drop matching models", () => {
		const models = buildModels(LIVE_SHAPES, API_BASE, "gemini-*, deepseek-*");
		expect(models.map((m) => m.id)).toEqual([
			"gpt-6.1-sol",
			"claude-haiku-4-5",
		]);
	});

	test("/v1 models order before /v1beta models", () => {
		const ordered = orderModelsByApiBase(buildModels(LIVE_SHAPES, API_BASE));
		const lastV1 = Math.max(
			...ordered
				.map((m, i) => ((m.settings?.baseURL ?? "").endsWith("/v1") ? i : -1))
				.filter((i) => i >= 0),
		);
		const firstBeta = ordered.findIndex((m) =>
			(m.settings?.baseURL ?? "").endsWith("/v1beta"),
		);
		expect(lastV1).toBeLessThan(firstBeta);
	});
});

describe("placeholderModel", () => {
	test("keeps the provider alive before connect", () => {
		const p = placeholderModel();
		expect(p.id).toBe("plexus-unconfigured");
		expect(p.modelID).toBe("plexus-unconfigured");
		expect(p.providerID).toBe("plexus");
		expect(p.enabled).toBe(true);
	});
});
