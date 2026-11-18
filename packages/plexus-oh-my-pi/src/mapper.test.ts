import { describe, expect, test } from "bun:test";
import { convertToOhMyPiModels, descriptorToOhMyPiModel } from "./mapper.ts";

describe("descriptorToOhMyPiModel", () => {
	test("retains provider so Oh My Pi can select Plexus defaults", () => {
		const model = descriptorToOhMyPiModel({
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

	test("maps each API dialect to the base expected by Oh My Pi", () => {
		const models = convertToOhMyPiModels(
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
		expect(
			Object.fromEntries(models.map((model) => [model.id, model.api])),
		).toEqual({
			chat: "openai-completions",
			responses: "openai-responses",
			messages: "anthropic-messages",
			gemini: "google-generative-ai",
		});
	});

	test("converts descriptor tiers to per-million rates", () => {
		const model = descriptorToOhMyPiModel({
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
			longContext: {
				inputThreshold: 272_000,
				input: 10,
				output: 45,
				cacheRead: 1,
				cacheWrite: 12.5,
			},
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

	test("maps the lowest positive breakpoint without losing the full window or tiers", () => {
		const [model] = convertToOhMyPiModels(
			[
				{
					id: "multi",
					context_length: 1_050_000,
					pricing: {
						prompt: "0.000001",
						completion: "0.000002",
						tiers: [
							{ input_tokens_above: 700_000, prompt: "0.000004" },
							{ input_tokens_above: 500_000, prompt: "0.000003" },
						],
					},
				},
			],
			"https://plexus.example/v1",
		);
		expect(model.contextWindow).toBe(1_050_000);
		expect(model.cost.longContext).toEqual({
			inputThreshold: 500_000,
			input: 3,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(model.cost.tiers?.map((t) => t.inputTokensAbove)).toEqual([
			700_000, 500_000,
		]);
	});

	test("does not add a long context tier without a valid positive breakpoint", () => {
		const models = convertToOhMyPiModels(
			[
				{ id: "none", context_length: 100_000 },
				{ id: "zero", pricing: { tiers: [{ input_tokens_above: 0 }] } },
				{
					id: "small",
					context_length: 100_000,
					pricing: { tiers: [{ input_tokens_above: 272_000 }] },
				},
			],
			"https://plexus.example/v1",
		);
		expect(models[0].cost.longContext).toBeUndefined();
		expect(models[1].cost.longContext).toBeUndefined();
		expect(models[2].contextWindow).toBe(100_000);
		expect(models[2].cost.longContext?.inputThreshold).toBe(272_000);
	});

	test("surfaces server effort values as explicit thinking", () => {
		const model = descriptorToOhMyPiModel({
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

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
		});
	});

	test.each(["responses", "chat_completions"])(
		"maps advertised %s off without adding an effort tier",
		(preferred_api) => {
			const alias = {
				id: "responses-alias",
				preferred_api,
				pi_options: { supportsStrictMode: true },
			};
			const [off, withoutOff] = convertToOhMyPiModels(
				[
					{
						...alias,
						reasoning_options: [
							{ type: "effort", values: ["off", "low", "high"] },
						],
					},
					{
						...alias,
						id: "responses-without-off",
						reasoning_options: [{ type: "effort", values: ["low", "high"] }],
					},
				],
				"https://plexus.example/v1",
			);
			expect(off.reasoning).toBe(true);
			expect(off.thinking).toEqual({
				mode: "effort",
				efforts: ["low", "high"],
			});
			expect(off.compat).toMatchObject({
				supportsStrictMode: true,
				reasoningDisableMode: "none-effort",
			});
			expect(withoutOff.compat?.reasoningDisableMode).toBeUndefined();
		},
	);

	test("drops off and unknown efforts from the server dial", () => {
		const model = descriptorToOhMyPiModel({
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			preferredApi: "openai-completions",
			provider: "plexus",
			baseUrl: "https://plexus.example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
			effortValues: ["off", "low", "high", "max"],
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: ["low", "high", "max"],
		});
	});

	test("server effort values win over the bundled catalog entry", () => {
		// The bundled catalog offers max for this id; the server caps
		// at xhigh, and the server wins.
		const model = descriptorToOhMyPiModel({
			id: "muse-spark-1.3",
			name: "Muse Spark 1.3",
			preferredApi: "openai-responses",
			provider: "plexus",
			baseUrl: "https://plexus.example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			piProvider: "meta",
			piModel: "muse-spark-1.3-contributor",
			effortValues: ["minimal", "low", "medium", "high", "xhigh"],
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: ["minimal", "low", "medium", "high", "xhigh"],
		});
	});

	test("omits thinking without server effort values or off-dialect", () => {
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
			descriptorToOhMyPiModel({
				...base,
				id: "no-effort",
				preferredApi: "openai-responses",
			}),
		).not.toHaveProperty("thinking");
		expect(
			descriptorToOhMyPiModel({
				...base,
				id: "messages",
				preferredApi: "anthropic-messages",
				effortValues: ["low", "max"],
			}),
		).not.toHaveProperty("thinking");
		expect(
			descriptorToOhMyPiModel({
				...base,
				id: "non-reasoning",
				preferredApi: "openai-responses",
				reasoning: false,
				effortValues: ["unknown"],
			}),
		).not.toHaveProperty("thinking");
	});
});
