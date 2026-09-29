import { describe, expect, test } from "bun:test";
import { apiBase, modelsUrl, rootURL, trimURL } from "./url.ts";

describe("url helpers", () => {
	test("rootURL strips /v1 idempotently", () => {
		expect(rootURL("https://plexus.example.com/v1")).toBe("https://plexus.example.com");
		expect(rootURL("https://plexus.example.com")).toBe("https://plexus.example.com");
		expect(rootURL("https://plexus.example.com/v1/")).toBe("https://plexus.example.com");
		expect(rootURL("")).toBe("");
	});

	test("apiBase and modelsUrl build the discovery URL", () => {
		expect(apiBase("https://plexus.example.com")).toBe("https://plexus.example.com/v1");
		expect(apiBase("https://plexus.example.com/v1")).toBe("https://plexus.example.com/v1");
		expect(modelsUrl("https://plexus.example.com")).toBe("https://plexus.example.com/v1/models");
	});

	test("trimURL strips whitespace and trailing slashes", () => {
		expect(trimURL("  https://plexus.example.com// ")).toBe("https://plexus.example.com");
		expect(trimURL("")).toBe("");
	});
});
