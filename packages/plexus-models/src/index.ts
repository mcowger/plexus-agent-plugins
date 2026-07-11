// Types
export type {
	ModelCache,
	PlexusApiModel,
	PlexusApiResponse,
	PlexusModelArchitecture,
	PlexusModelDescriptor,
	PlexusModelPricing,
	PlexusModelPricingTier,
	PlexusTopProvider,
} from "./types.ts";

export type { OpenAICompletionsThinkingFormat } from "./convert.ts";

// Model fetching and conversion
export {
	adjustBaseUrl,
	convertDescriptors,
	convertToDescriptor,
	DEFAULT_MODELS_FETCH_TIMEOUT_MS,
	detectOpenAICompletionsCompat,
	fetchPlexusModels,
	inferReasoning,
	isChatModel,
	mapInputModalities,
	mapPreferredApi,
} from "./convert.ts";
