import { describe, expect, test } from "bun:test";
import { getPlexusModelBaseUrl } from "./extension.ts";

describe("Plexus model base URLs", () => {
	test("preserves the root URL for Anthropic messages", () => {
		expect(getPlexusModelBaseUrl("https://plexus.example.com/v1", "anthropic-messages")).toBe(
			"https://plexus.example.com",
		);
	});

	test("uses each API dialect's expected base URL", () => {
		expect(getPlexusModelBaseUrl("https://plexus.example.com", "openai-completions")).toBe(
			"https://plexus.example.com/v1",
		);
		expect(getPlexusModelBaseUrl("https://plexus.example.com", "google-generative-ai")).toBe(
			"https://plexus.example.com/v1beta",
		);
	});
});
