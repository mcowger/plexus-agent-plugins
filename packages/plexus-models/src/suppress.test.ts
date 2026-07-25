import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	getEnvSuppressedModels,
	isModelSuppressed,
	parseSuppressionPatterns,
} from "./suppress.ts";

describe("parseSuppressionPatterns", () => {
	test("returns empty array for empty inputs", () => {
		expect(parseSuppressionPatterns(undefined)).toEqual([]);
		expect(parseSuppressionPatterns(null)).toEqual([]);
		expect(parseSuppressionPatterns("")).toEqual([]);
		expect(parseSuppressionPatterns([])).toEqual([]);
	});

	test("parses comma, semicolon, and newline separated strings", () => {
		expect(parseSuppressionPatterns("gpt-3.5*, claude-2*, whisper")).toEqual([
			"gpt-3.5*",
			"claude-2*",
			"whisper",
		]);
		expect(parseSuppressionPatterns("gpt-3.5*;\nclaude-2*; whisper")).toEqual([
			"gpt-3.5*",
			"claude-2*",
			"whisper",
		]);
	});

	test("trims whitespace from array inputs", () => {
		expect(parseSuppressionPatterns([" gpt-3.5* ", " claude-2* "])).toEqual([
			"gpt-3.5*",
			"claude-2*",
		]);
	});
});

describe("isModelSuppressed", () => {
	const origEnv = process.env.PLEXUS_SUPPRESS_MODELS;
	const origExclEnv = process.env.PLEXUS_EXCLUDE_MODELS;

	beforeEach(() => {
		delete process.env.PLEXUS_SUPPRESS_MODELS;
		delete process.env.PLEXUS_EXCLUDE_MODELS;
	});

	afterEach(() => {
		if (origEnv !== undefined) process.env.PLEXUS_SUPPRESS_MODELS = origEnv;
		else delete process.env.PLEXUS_SUPPRESS_MODELS;
		if (origExclEnv !== undefined) process.env.PLEXUS_EXCLUDE_MODELS = origExclEnv;
		else delete process.env.PLEXUS_EXCLUDE_MODELS;
	});

	test("returns false when no rules are configured", () => {
		expect(isModelSuppressed({ id: "gpt-4o", name: "GPT-4o" })).toBe(false);
	});

	test("matches exact ID case-insensitively", () => {
		expect(isModelSuppressed({ id: "gpt-4o" }, "GPT-4o")).toBe(true);
		expect(isModelSuppressed({ id: "gpt-4o" }, "gpt-4")).toBe(false);
	});

	test("matches exact Name case-insensitively", () => {
		expect(isModelSuppressed({ id: "custom-id-1", name: "Claude 3.5 Sonnet" }, "claude 3.5 sonnet")).toBe(true);
	});

	test("matches short ID prefix/suffix", () => {
		expect(isModelSuppressed({ id: "openai/gpt-3.5-turbo" }, "gpt-3.5-turbo")).toBe(true);
		expect(isModelSuppressed({ id: "provider:claude-2.0" }, "claude-2.0")).toBe(true);
	});

	test("matches glob patterns with wildcards", () => {
		expect(isModelSuppressed({ id: "openai/gpt-3.5-turbo" }, "gpt-3.5*")).toBe(true);
		expect(isModelSuppressed({ id: "deprecated-model-v1" }, "*deprecated*")).toBe(true);
		expect(isModelSuppressed({ id: "anthropic/claude-3-haiku" }, "anthropic/*")).toBe(true);
		expect(isModelSuppressed({ id: "gpt-4o" }, "gpt-4?")).toBe(true);
		expect(isModelSuppressed({ id: "gpt-4o-mini" }, "gpt-4?")).toBe(false);
	});

	test("matches regex patterns", () => {
		expect(isModelSuppressed({ id: "gpt-3.5-turbo" }, "regex:^gpt-[34]")).toBe(true);
		expect(isModelSuppressed({ id: "gpt-5-preview" }, "regex:^gpt-[34]")).toBe(false);
	});

	test("honors PLEXUS_SUPPRESS_MODELS environment variable", () => {
		process.env.PLEXUS_SUPPRESS_MODELS = "gpt-3.5*, *deprecated*";
		expect(isModelSuppressed({ id: "gpt-3.5-turbo" })).toBe(true);
		expect(isModelSuppressed({ id: "my-deprecated-model" })).toBe(true);
		expect(isModelSuppressed({ id: "gpt-4o" })).toBe(false);
	});

	test("honors PLEXUS_EXCLUDE_MODELS environment variable as fallback", () => {
		process.env.PLEXUS_EXCLUDE_MODELS = "claude-2*";
		expect(isModelSuppressed({ id: "claude-2.1" })).toBe(true);
		expect(isModelSuppressed({ id: "claude-3-opus" })).toBe(false);
	});
});
