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
): { mode: "effort"; efforts: Effort[] } | undefined {
	if (!descriptor.reasoning) return undefined;
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
	return { mode: "effort", efforts };
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

	const cost = {
		input: descriptor.cost.input * 1_000_000,
		output: descriptor.cost.output * 1_000_000,
		cacheRead: descriptor.cost.cacheRead * 1_000_000,
		cacheWrite: descriptor.cost.cacheWrite * 1_000_000,
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

	// Compat applies only to openai-completions; other dialects auto-detect from URL
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
	// Explicit thinking from the server effort dial. Wins over the
	// bundled catalog entry when both exist.
	const serverThinking = serverEffortThinking(descriptor);
	return {
		id: descriptor.id,
		name: descriptor.name,
		api: descriptor.preferredApi as Api,
		provider: descriptor.provider,
		baseUrl: descriptor.baseUrl,
		reasoning: descriptor.reasoning,
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
