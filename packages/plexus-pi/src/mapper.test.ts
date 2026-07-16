import { describe, expect, test } from "bun:test";
import { convertToPiModels, descriptorToPiModel } from "./mapper.ts";

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

		expect(Object.fromEntries(models.map((model) => [model.id, model.baseUrl]))).toEqual({
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
});
