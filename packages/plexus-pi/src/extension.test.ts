import { describe, expect, test } from "bun:test";
import { enforceMinimumOutputTokens } from "./extension.ts";
import { MINIMUM_OUTPUT_TOKENS } from "./mapper.ts";

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
