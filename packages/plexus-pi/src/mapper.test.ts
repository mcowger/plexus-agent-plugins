import { describe, expect, test } from "bun:test";
import { descriptorToPiModel } from "./mapper.ts";

describe("pi pricing mapping", () => {
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
