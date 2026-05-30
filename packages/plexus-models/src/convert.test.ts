import { describe, expect, test } from "bun:test";
import { adjustBaseUrl } from "./convert.ts";

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
