// pi exposes only its compatibility entrypoint to extensions. Do not import
// `providers/all`: the extension loader aliases the package root to compat,
// which makes that subpath resolve relative to compat.js.
import type { Api } from "@earendil-works/pi-ai";
import { getModel, type OpenAICompletionsCompat } from "@earendil-works/pi-ai/compat";
import {
	convertDescriptors,
	detectOpenAICompletionsCompat,
	type PlexusApiModel,
	type PlexusModelDescriptor,
} from "../../plexus-models/src/index.ts";

/**
 * Maps a PlexusModelDescriptor to a pi ProviderModelConfig entry suitable for
 * use in pi.registerProvider({ models: [...] }).
 *
 * Cost scaling: Plexus API returns cost per-token; pi uses $/million tokens.
 *
 * Compat resolution (openai-completions only):
 *   1. Start with heuristically-detected flags from detectOpenAICompletionsCompat
 *   2. Merge in compat from pi_provider/pi_model when present
 *   3. Merge in pi_options from the Plexus server (server wins on any overlap)
 * Other API dialects leave compat undefined so the host auto-detects.
 *
 * thinkingLevelMap and headers are copied from pi_provider/pi_model when present.
 */
export function descriptorToPiModel(descriptor: PlexusModelDescriptor) {
	let builtinModel: ReturnType<typeof getModel> | undefined;
	if (descriptor.piProvider && descriptor.piModel) {
		try {
			builtinModel = getModel(descriptor.piProvider as never, descriptor.piModel as never);
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
	let compat: OpenAICompletionsCompat | undefined;
	if (descriptor.preferredApi === "openai-completions") {
		const heuristic = detectOpenAICompletionsCompat(
			descriptor.piProvider ?? descriptor.provider,
			descriptor.baseUrl,
		);
		// pi_options override heuristics — the Plexus server knows best
		const builtinCompat = builtinModel?.compat as Record<string, unknown> | undefined;
		const merged = { ...heuristic, ...(builtinCompat ?? {}), ...(descriptor.piOptions ?? {}) };
		compat = merged as OpenAICompletionsCompat;
	} else if (descriptor.piOptions) {
		// For non-openai-completions dialects that still carry pi_options, pass them through
		compat = descriptor.piOptions as OpenAICompletionsCompat;
	} else if (builtinModel?.compat) {
		compat = builtinModel.compat as OpenAICompletionsCompat;
	}

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
		...(builtinModel?.thinkingLevelMap !== undefined
			? { thinkingLevelMap: builtinModel.thinkingLevelMap }
			: {}),
		...(builtinModel?.headers !== undefined ? { headers: builtinModel.headers } : {}),
		...(compat !== undefined ? { compat } : {}),
	} as const;
}

/**
 * Converts a raw Plexus API model array into pi-compatible model entries.
 * Convenience wrapper over convertDescriptors + descriptorToPiModel.
 */
export function convertToPiModels(
	rawModels: PlexusApiModel[],
	baseUrl: string,
): ReturnType<typeof descriptorToPiModel>[] {
	const descriptors = convertDescriptors(rawModels, baseUrl);
	return descriptors.map(descriptorToPiModel);
}
