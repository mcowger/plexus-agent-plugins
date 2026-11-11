import { describe, expect, test } from "bun:test";
import {
	convertToPiModels,
	descriptorToPiModel,
	MINIMUM_OUTPUT_TOKENS,
} from "./mapper.ts";

describe("descriptorToPiModel", () => {
	test("retains provider so Pi can select Plexus defaults", () => {
		const model = descriptorToPiModel({
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			preferredApi: "openai-completions",
			provider: "plexus",
			baseUrl: "https://plexus.example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 272_000,
			maxTokens: 32_000,
		});

		expect(model.provider).toBe("plexus");
	});

	test("enforces the minimum output token limit", () => {
		const model = descriptorToPiModel({
			id: "low-output-model",
			name: "Low Output Model",
			preferredApi: "openai-completions",
			provider: "plexus",
			baseUrl: "https://plexus.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 1,
		});

		expect(model.maxTokens).toBe(MINIMUM_OUTPUT_TOKENS);
	});

	test("maps server effort values to an identity thinkingLevelMap", () => {
		const model = descriptorToPiModel({
			id: "muse-ember-1.0",
			name: "Muse Ember",
			preferredApi: "openai-responses",
			provider: "plexus",
			baseUrl: "https://plexus.example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 524_288,
			effortValues: ["minimal", "low", "medium", "high", "xhigh", "max"],
		});

		expect(model.thinkingLevelMap).toEqual({
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	test("server effort values win over the built-in catalog entry", () => {
		// Built-in gpt-5.2 maps max to null; the server advertises max
		// and wins.
		const model = descriptorToPiModel({
			id: "gpt-6-luna",
			name: "GPT-6 Luna",
			preferredApi: "openai-responses",
			provider: "plexus",
			baseUrl: "https://plexus.example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 524_288,
			piProvider: "openai",
			piModel: "gpt-5.2",
			effortValues: ["low", "medium", "high", "xhigh", "max"],
		});

		expect(model.thinkingLevelMap).toEqual({
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	test("omits thinkingLevelMap without server effort values or off-dialect", () => {
		const base = {
			name: "Muse Ember",
			provider: "plexus" as const,
			baseUrl: "https://plexus.example.com/v1",
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 524_288,
		};
		expect(
			descriptorToPiModel({
				...base,
				id: "no-effort",
				preferredApi: "openai-responses",
			}),
		).not.toHaveProperty("thinkingLevelMap");
		expect(
			descriptorToPiModel({
				...base,
				id: "messages",
				preferredApi: "anthropic-messages",
				effortValues: ["low", "max"],
			}),
		).not.toHaveProperty("thinkingLevelMap");
	});

	test("maps each API dialect to the base expected by pi", () => {
		const models = convertToPiModels(
			[
				{ id: "chat", preferred_api: "chat_completions" },
				{ id: "responses", preferred_api: "responses" },
				{ id: "messages", preferred_api: "messages" },
				{ id: "gemini", preferred_api: "gemini" },
			],
			"https://plexus.example.com/v1",
		);

		expect(
			Object.fromEntries(models.map((model) => [model.id, model.baseUrl])),
		).toEqual({
			chat: "https://plexus.example.com/v1",
			responses: "https://plexus.example.com/v1",
			messages: "https://plexus.example.com",
			gemini: "https://plexus.example.com/v1beta",
		});
	});

	test("converts descriptor tiers to pi per-million rates", () => {
		const model = descriptorToPiModel({
			id: "claude-alias",
			name: "Claude Alias",
			preferredApi: "anthropic-messages",
			provider: "plexus",
			baseUrl: "https://plexus.example.com",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0.000005,
				output: 0.00003,
				cacheRead: 0.0000005,
				cacheWrite: 0.00000625,
				tiers: [
					{
						inputTokensAbove: 272_000,
						input: 0.00001,
						output: 0.000045,
						cacheRead: 0.000001,
						cacheWrite: 0.0000125,
					},
				],
			},
			contextWindow: 400_000,
			maxTokens: 32_000,
		});

		expect(model.cost).toEqual({
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
			tiers: [
				{
					inputTokensAbove: 272_000,
					input: 10,
					output: 45,
					cacheRead: 1,
					cacheWrite: 12.5,
				},
			],
		});
	});

	test("carries descriptor shortName as plexusShortName", () => {
		const model = descriptorToPiModel({
			id: "claude-alias",
			name: "Claude Alias",
			shortName: "Claude",
			preferredApi: "anthropic-messages",
			provider: "plexus",
			baseUrl: "https://plexus.example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		});

		expect(model).toMatchObject({ plexusShortName: "Claude" });
	});

	test("omits plexusShortName when the descriptor has no shortName", () => {
		const model = descriptorToPiModel({
			id: "claude-alias",
			name: "Claude Alias",
			preferredApi: "anthropic-messages",
			provider: "plexus",
			baseUrl: "https://plexus.example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		});

		expect("plexusShortName" in model).toBe(false);
	});

	test("convertToPiModels carries short_name from the wire", () => {
		const models = convertToPiModels(
			[{ id: "m", name: "Model", short_name: "M" }],
			"https://plexus.example.com/v1",
		);

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ plexusShortName: "M" });
	});
});
