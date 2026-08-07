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
