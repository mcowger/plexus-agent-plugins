// Oh My Pi's built-in model registry lives in @oh-my-pi/pi-catalog rather than
// @earendil-works/pi-ai/compat (upstream pi). The lookup function was also
// renamed getModel -> getBundledModel, and the per-model metadata shape
// dropped `thinkingLevelMap` in favor of a structured `thinking` config.

import type { Api } from "@oh-my-pi/pi-ai";
import {
	type Effort,
	type GeneratedProvider,
	getBundledModel,
	THINKING_EFFORTS,
} from "@oh-my-pi/pi-catalog";
import {
	convertDescriptors,
	detectOpenAICompletionsCompat,
	type PlexusApiModel,
	type PlexusModelDescriptor,
} from "../../plexus-models/src/index.ts";

/**
 * Maps a PlexusModelDescriptor to an Oh My Pi ProviderModelConfig entry
 * suitable for use in pi.registerProvider({ models: [...] }).
 *
 * Cost scaling: Plexus API returns cost per-token; Oh My Pi uses $/million tokens.
 *
 * Compat resolution (openai-completions only):
 *   1. Start with heuristically-detected flags from detectOpenAICompletionsCompat
 *   2. Merge in compat from pi_provider/pi_model when present (looked up in
 *      Oh My Pi's bundled catalog, which is a superset of upstream pi's)
 *   3. Merge in pi_options from the Plexus server (server wins on any overlap)
 * Other API dialects leave compat undefined so the host auto-detects.
 * Thinking resolution:
 *   1. Server-advertised effort dial (`descriptor.effortValues`) as an
 *      explicit thinking config for the OpenAI dialects (see
 *      serverEffortThinking). Wins over the catalog: the server is
 *      authoritative for the plexus deployment.
 *   2. Bundled catalog entry for pi_provider/pi_model, when present.
 * Otherwise OMP derives a generic ladder (minimal..xhigh for
 * openai-responses) that can cap below the server tier.
 * Headers are copied from the catalog entry when present.
 */

/**
 * Explicit thinking config from the server-advertised effort dial.
 * Wins over the bundled catalog entry when both exist: the server is
 * authoritative for the plexus deployment (e.g. muse-spark-1.3 caps at
 * xhigh on the server while the catalog offers max). Effort mode is
 * the host default transport for the OpenAI dialects, so only those
 * dialects map here; other dialects keep the host derivation.
 */
function serverEffortThinking(
	descriptor: PlexusModelDescriptor,
	builtinThinking?: { effortMap?: Partial<Record<Effort, string>> },
):
	| {
			mode: "effort";
			efforts: Effort[];
			effortMap?: Partial<Record<Effort, string>>;
	  }
	| undefined {
	if (
		descriptor.preferredApi !== "openai-completions" &&
		descriptor.preferredApi !== "openai-responses"
	) {
		return undefined;
	}
	const values = descriptor.effortValues;
	if (values === undefined) return undefined;
	const efforts = THINKING_EFFORTS.filter((effort) => values.includes(effort));
	if (efforts.length === 0) return undefined;
	const effortMapEntries = builtinThinking?.effortMap
		? Object.entries(builtinThinking.effortMap).filter(
				([key, value]) =>
					value !== undefined && efforts.includes(key as Effort),
			)
		: [];
	return {
		mode: "effort",
		efforts,
		...(effortMapEntries.length > 0
			? {
					effortMap: Object.fromEntries(effortMapEntries) as Partial<
						Record<Effort, string>
					>,
				}
			: {}),
	};
}
export function descriptorToOhMyPiModel(descriptor: PlexusModelDescriptor) {
	let builtinModel: ReturnType<typeof getBundledModel> | undefined;
	if (descriptor.piProvider && descriptor.piModel) {
		try {
			builtinModel = getBundledModel(
				descriptor.piProvider as GeneratedProvider,
				descriptor.piModel,
			);
		} catch {
			builtinModel = undefined;
		}
	}

	// OMP's window policy and cost estimator consume longContext, not tiers.
	// Keep all tiers as supplied; OMP currently estimates only the first one.
	const firstTier = descriptor.cost.tiers?.reduce<
		NonNullable<typeof descriptor.cost.tiers>[number] | undefined
	>(
		(first, tier) =>
			tier.inputTokensAbove > 0 &&
			(!first || tier.inputTokensAbove < first.inputTokensAbove)
				? tier
				: first,
		undefined,
	);
	const cost = {
		input: descriptor.cost.input * 1_000_000,
		output: descriptor.cost.output * 1_000_000,
		cacheRead: descriptor.cost.cacheRead * 1_000_000,
		cacheWrite: descriptor.cost.cacheWrite * 1_000_000,
		...(firstTier
			? {
					longContext: {
						inputThreshold: firstTier.inputTokensAbove,
						input: firstTier.input * 1_000_000,
						output: firstTier.output * 1_000_000,
						cacheRead: firstTier.cacheRead * 1_000_000,
						cacheWrite: firstTier.cacheWrite * 1_000_000,
					},
				}
			: {}),
		...(descriptor.cost.tiers
			? {
					tiers: descriptor.cost.tiers.map((tier) => ({
						inputTokensAbove: tier.inputTokensAbove,
						input: tier.input * 1_000_000,
						output: tier.output * 1_000_000,
						cacheRead: tier.cacheRead * 1_000_000,
						cacheWrite: tier.cacheWrite * 1_000_000,
					})),
				}
			: {}),
	};

	// Derive Chat Completions defaults from the upstream, not the Plexus URL.
	let compat: Record<string, unknown> | undefined;
	if (descriptor.preferredApi === "openai-completions") {
		const heuristic = detectOpenAICompletionsCompat(
			descriptor.piProvider ?? descriptor.provider,
			descriptor.baseUrl,
		);
		// pi_options override heuristics — the Plexus server knows best
		const builtinCompat = builtinModel?.compat as
			Record<string, unknown> | undefined;
		compat = {
			...heuristic,
			...(builtinCompat ?? {}),
			...(descriptor.piOptions ?? {}),
		};
	} else if (descriptor.piOptions) {
		// For non-openai-completions dialects that still carry pi_options, pass them through
		compat = descriptor.piOptions;
	} else if (builtinModel?.compat) {
		compat = builtinModel.compat as Record<string, unknown>;
	}
	const serverThinking = serverEffortThinking(
		descriptor,
		builtinModel?.thinking,
	);
	// Plexus can advertise effort levels without supported_parameters.
	const reasoning =
		descriptor.reasoning ||
		serverThinking !== undefined ||
		THINKING_EFFORTS.some((effort) =>
			descriptor.effortValues?.includes(effort),
		);
	// Off is a separate control, not an effort. Use the explicit OpenAI
	// sentinel instead of OMP's generic lowest-effort fallback. Keep native
	// dialects (e.g. OpenRouter and Qwen) and their own disable controls.
	const advertisedOff = reasoning && descriptor.effortValues?.includes("off");
	const chatFormat = compat?.thinkingFormat;
	if (
		advertisedOff &&
		descriptor.piOptions?.reasoningDisableMode === undefined &&
		(descriptor.preferredApi === "openai-responses" ||
			(descriptor.preferredApi === "openai-completions" &&
				(chatFormat === undefined ||
					chatFormat === "openai" ||
					chatFormat === "deepseek") &&
				(compat?.reasoningDisableMode === undefined ||
					compat.reasoningDisableMode === "lowest-effort") &&
				compat?.supportsReasoningEffort !== false))
	) {
		compat = { ...compat, reasoningDisableMode: "none-effort" };
	}
	return {
		id: descriptor.id,
		name: descriptor.name,
		api: descriptor.preferredApi as Api,
		provider: descriptor.provider,
		baseUrl: descriptor.baseUrl,
		reasoning,
		input: descriptor.input,
		cost,
		contextWindow: descriptor.contextWindow,
		maxTokens: descriptor.maxTokens,
		...(serverThinking !== undefined
			? { thinking: serverThinking }
			: builtinModel?.thinking !== undefined
				? { thinking: builtinModel.thinking }
				: {}),
		...(builtinModel?.headers !== undefined
			? { headers: builtinModel.headers }
			: {}),
		...(compat !== undefined ? { compat } : {}),
	} as const;
}

/**
 * Converts a raw Plexus API model array into Oh My Pi-compatible model entries.
 * Convenience wrapper over convertDescriptors + descriptorToOhMyPiModel.
 */
export function convertToOhMyPiModels(
	rawModels: PlexusApiModel[],
	baseUrl: string,
): ReturnType<typeof descriptorToOhMyPiModel>[] {
	const descriptors = convertDescriptors(rawModels, baseUrl);
	return descriptors.map(descriptorToOhMyPiModel);
}
