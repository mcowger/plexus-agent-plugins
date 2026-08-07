import { describe, expect, test } from "bun:test";
import { cachedDescriptorsToPiModels, enforceMinimumOutputTokens } from "./extension.ts";
import { MINIMUM_OUTPUT_TOKENS } from "./mapper.ts";

describe("cachedDescriptorsToPiModels", () => {
	test("preserves cached descriptor token limits", () => {
		const [model] = cachedDescriptorsToPiModels([
			{
				id: "deepseek-v4-flash-0731",
				name: "DeepSeek V4 Flash",
				preferredApi: "openai-completions",
				provider: "plexus",
				baseUrl: "https://plexus.example.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 384_000,
			},
		]);

		expect(model).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});
	});

	test("preserves cached dialect and metadata without reparsing descriptors", () => {
		const [responses, gemini] = cachedDescriptorsToPiModels([
			{
				id: "gpt-5.6-terra",
				name: "GPT-5.6 Terra",
				preferredApi: "openai-responses",
				provider: "plexus",
				baseUrl: "https://plexus.example.com/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.000002, output: 0.000012, cacheRead: 0.0000002, cacheWrite: 0.0000025 },
				contextWindow: 1_050_000,
				maxTokens: 128_000,
			},
			{
				id: "gemini-3.6-flash",
				name: "Gemini 3.6 Flash",
				preferredApi: "google-generative-ai",
				provider: "plexus",
				baseUrl: "https://plexus.example.com/v1beta",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.0000015, output: 0.0000075, cacheRead: 0.00000015, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 65_536,
			},
		]);

		expect(responses).toMatchObject({
			api: "openai-responses",
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			cost: { input: 2, output: 12, cacheRead: 0.19999999999999998, cacheWrite: 2.5 },
		});
		expect(gemini).toMatchObject({
			api: "google-generative-ai",
			baseUrl: "https://plexus.example.com/v1beta",
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		});
	});
});

describe("enforceMinimumOutputTokens", () => {
	test("raises a context-clamped OpenAI completion limit", () => {
		expect(enforceMinimumOutputTokens({ max_completion_tokens: 1 })).toEqual({
			max_completion_tokens: MINIMUM_OUTPUT_TOKENS,
		});
	});

	test("raises output limits for each supported payload shape", () => {
		expect(enforceMinimumOutputTokens({ max_tokens: 1 })).toEqual({
			max_tokens: MINIMUM_OUTPUT_TOKENS,
		});
		expect(enforceMinimumOutputTokens({ max_output_tokens: 1 })).toEqual({
			max_output_tokens: MINIMUM_OUTPUT_TOKENS,
		});
		expect(enforceMinimumOutputTokens({ generationConfig: { maxOutputTokens: 1 } })).toEqual({
			generationConfig: { maxOutputTokens: MINIMUM_OUTPUT_TOKENS },
		});
	});
});
