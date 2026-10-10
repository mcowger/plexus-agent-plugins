import {
	adjustBaseUrl,
	isChatModel,
	isModelSuppressed,
	mapPreferredApi,
	type PlexusApiModel,
	type PlexusReasoningOption,
} from "../../plexus-models/src/index.ts";
import {
	ANTHROPIC_PKG,
	GOOGLE_PKG,
	OPENAI_RESPONSES_PKG,
} from "./constants.ts";
import {
	type PlexusModelPolicy,
	policyAdvertisementFromApiModel,
} from "./session-policy.ts";

export type Modality = "text" | "audio" | "image" | "video" | "pdf";

/**
 * Plain-JSON mirror of OpenCode V2 `Model.Info` for the plexus provider.
 * Branded IDs are plain strings here; plugin.ts passes these through to the
 * provider editor (structurally identical at runtime).
 */
export interface PlexusModelInfo {
	id: string;
	/** Upstream wire ID sent to the gateway — always the bare Plexus slug. */
	modelID: string;
	providerID: string;
	name: string;
	compatibility?: {
		reasoningField?: string;
	};
	/** Per-model runtime package override (undefined = provider default). */
	package?: string;
	settings?: {
		baseURL?: string;
		[key: string]: unknown;
	};
	capabilities: {
		tools: boolean;
		input: Modality[];
		output: Modality[];
	};
	variants: Array<{
		id: string;
		settings?: Record<string, unknown>;
	}>;
	time: {
		/** Release date as a Unix timestamp in milliseconds, 0 when unknown. */
		released: number;
	};
	cost: Array<{
		tier?: { type: "context"; size: number };
		input: number;
		output: number;
		cache: { read: number; write: number };
	}>;
	status: "active";
	enabled: boolean;
	/**
	 * Per-model policy advertisement retained from the raw Plexus catalog
	 * entry (service tiers + short/max context budgets). Shared catalog
	 * data — safe on the shared definition; per-session *selection* lives
	 * in `SessionPolicyStore` and never mutates this. Absent when the model
	 * advertises neither.
	 */
	policy?: PlexusModelPolicy;
	limit: {
		context: number;
		output: number;
	};
}

/** Cache round-trips the exact shape published to the provider editor. */
export type CachedModel = PlexusModelInfo;

export interface ModelPricingTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const REASONING_PARAMS = new Set([
	"reasoning",
	"include_reasoning",
	"reasoning_effort",
]);
const OPEN_CODE_NONE = "none";
const DEFAULT_CONTEXT = 250_000;
const PER_TOKEN_TO_PER_MILLION = 1_000_000;

function normalizeReasoningEffort(value: string | null): string {
	return value === null || value === "off" ? OPEN_CODE_NONE : value;
}

function reasoningVariantSettings(
	preferredApi: string,
	effort: string,
): Record<string, unknown> {
	switch (preferredApi) {
		case "anthropic-messages":
			return { effort };
		case "google-generative-ai":
			return {
				thinkingConfig: { includeThoughts: true, thinkingLevel: effort },
			};
		default:
			return { reasoningEffort: effort };
	}
}

function buildReasoningVariants(
	model: PlexusApiModel,
	preferredApi: string,
	hasReasoning: boolean,
): PlexusModelInfo["variants"] | undefined {
	if (!hasReasoning) return undefined;

	const effortOption = model.reasoning_options?.find(
		(option): option is Extract<PlexusReasoningOption, { type: "effort" }> =>
			option.type === "effort",
	);
	if (!effortOption) return undefined;

	return effortOption.values.map((value) => {
		const effort = normalizeReasoningEffort(value);
		return {
			id: effort,
			settings: reasoningVariantSettings(preferredApi, effort),
		};
	});
}

/**
 * Per-model runtime package override. anthropic and google dialects need their
 * own SDK runtimes; openai-responses needs the OpenAI Responses runtime
 * (`/responses`), and openai-completions falls through to the provider-level
 * openai-compatible runtime (`/chat/completions`).
 */
function resolveModelPackage(preferredApi: string): string | undefined {
	switch (preferredApi) {
		case "anthropic-messages":
			return ANTHROPIC_PKG;
		case "google-generative-ai":
			return GOOGLE_PKG;
		case "openai-responses":
			return OPENAI_RESPONSES_PKG;
		default:
			return undefined;
	}
}

function resolveModelBaseURL(preferredApi: string, apiBaseURL: string): string {
	return adjustBaseUrl(apiBaseURL, preferredApi, "versioned");
}

function parsePrice(value: string | undefined): number {
	if (!value) return 0;
	const n = parseFloat(value);
	return Number.isFinite(n) && n >= 0 ? n * PER_TOKEN_TO_PER_MILLION : 0;
}

function buildPricingTiers(
	model: PlexusApiModel,
): ModelPricingTier[] | undefined {
	const pricing = model.pricing;
	if (!pricing?.tiers) return undefined;

	const tiers = pricing.tiers.flatMap((tier) => {
		if (
			!Number.isFinite(tier.input_tokens_above) ||
			tier.input_tokens_above < 0
		)
			return [];
		return [
			{
				inputTokensAbove: tier.input_tokens_above,
				input: parsePrice(tier.prompt ?? pricing.prompt),
				output: parsePrice(tier.completion ?? pricing.completion),
				cacheRead: parsePrice(
					tier.input_cache_read ?? pricing.input_cache_read,
				),
				cacheWrite: parsePrice(
					tier.input_cache_write ?? pricing.input_cache_write,
				),
			},
		];
	});

	return tiers.length > 0 ? tiers : undefined;
}

/**
 * Map a single Plexus modality string to an OpenCode modality string.
 * "file" → "pdf"; unknown strings are dropped.
 */
function mapModality(m: string): Modality | null {
	switch (m) {
		case "text":
			return "text";
		case "image":
			return "image";
		case "audio":
			return "audio";
		case "video":
			return "video";
		case "file":
		case "pdf":
			return "pdf";
		default:
			return null;
	}
}

function releaseTime(created: number | undefined): number {
	if (typeof created !== "number" || !Number.isFinite(created) || created <= 0)
		return 0;
	return Math.floor(created * 1000);
}

function reasoningCompatibility(
	model: PlexusApiModel,
	preferredApi: string,
): PlexusModelInfo["compatibility"] | undefined {
	// DeepSeek streams reasoning in `reasoning_content`; the runtime must
	// preserve that field across tool-call turns.
	if (
		preferredApi === "openai-completions" &&
		model.id.toLowerCase().includes("deepseek")
	) {
		return { reasoningField: "reasoning_content" };
	}
	return undefined;
}

function buildInputModalities(model: PlexusApiModel): Modality[] {
	const raw = model.architecture?.input_modalities ?? [];
	const mapped = raw.map(mapModality).filter((m): m is Modality => m !== null);
	return mapped.length > 0 ? [...new Set(mapped)] : ["text"];
}

function buildOutputModalities(model: PlexusApiModel): Modality[] | null {
	const raw = model.architecture?.output_modalities;

	if (raw !== undefined) {
		// Architecture is present — require text output.
		if (!raw.includes("text")) return null;
		const mapped = raw
			.map(mapModality)
			.filter((m): m is Modality => m !== null);
		return mapped.length > 0 ? [...new Set(mapped)] : ["text"];
	}

	return ["text"];
}

/**
 * Return models with /v1 endpoints before /v1beta endpoints, preserving
 * relative order within each group. Some clients derive a provider-wide
 * endpoint from the first model; publishing a /v1 model first keeps those
 * clients on /v1/chat/completions for Plexus. Order only — no ID, package,
 * endpoint, or routing changes.
 */
export function orderModelsByApiBase(
	models: PlexusModelInfo[],
): PlexusModelInfo[] {
	const current: PlexusModelInfo[] = [];
	const beta: PlexusModelInfo[] = [];

	for (const model of models) {
		const api = (model.settings?.baseURL ?? "").trim().replace(/\/+$/, "");
		if (api.endsWith("/v1beta")) beta.push(model);
		else current.push(model);
	}

	return [...current, ...beta];
}

/**
 * Transform PlexusApiModel[] → OpenCode V2 Model.Info[] for provider plexus.
 *
 * - `id` and `modelID` are always the bare Plexus slug exactly as published
 *   (no author prefix, no fast/pro suffixes beyond what Plexus publishes;
 *   reasoning efforts live in `variants`, never as extra models).
 * - Non-chat models (embeddings, transcription, TTS, image-output) and
 *   suppressed models are skipped.
 */
export function buildModels(
	models: PlexusApiModel[],
	apiBaseURL: string,
	suppress?: string | string[] | null,
): PlexusModelInfo[] {
	const result: PlexusModelInfo[] = [];

	for (const m of models) {
		if (!m.id || typeof m.id !== "string") continue;
		if (m.id.includes("/")) continue;
		if (!isChatModel(m)) continue;
		if (isModelSuppressed(m, suppress)) continue;

		const outputModalities = buildOutputModalities(m);
		if (outputModalities === null) continue;

		const inputModalities = buildInputModalities(m);
		const params = m.supported_parameters ?? [];

		const contextLength =
			(typeof m.context_length === "number" && m.context_length > 0
				? m.context_length
				: undefined) ??
			(typeof m.top_provider?.context_length === "number" &&
			m.top_provider.context_length > 0
				? m.top_provider.context_length
				: undefined) ??
			DEFAULT_CONTEXT;

		const maxOutput =
			(typeof m.top_provider?.max_completion_tokens === "number" &&
			m.top_provider.max_completion_tokens > 0
				? m.top_provider.max_completion_tokens
				: undefined) ?? Math.ceil(contextLength * 0.2);

		const promptPrice = parsePrice(m.pricing?.prompt);
		const completionPrice = parsePrice(m.pricing?.completion);
		const cacheReadPrice = parsePrice(m.pricing?.input_cache_read);
		const cacheWritePrice = parsePrice(m.pricing?.input_cache_write);
		const pricingTiers = buildPricingTiers(m);

		const preferredApi = mapPreferredApi(m.preferred_api);
		const pkg = resolveModelPackage(preferredApi);
		const compatibility = reasoningCompatibility(m, preferredApi);
		const policy = policyAdvertisementFromApiModel(m);
		const hasReasoning = params.some((p) => REASONING_PARAMS.has(p));
		const variants = buildReasoningVariants(m, preferredApi, hasReasoning);

		const cost: PlexusModelInfo["cost"] = [];
		if (promptPrice > 0 || completionPrice > 0) {
			cost.push({
				input: promptPrice,
				output: completionPrice,
				cache: { read: cacheReadPrice, write: cacheWritePrice },
			});
		}
		for (const tier of pricingTiers ?? []) {
			cost.push({
				tier: { type: "context", size: tier.inputTokensAbove },
				input: tier.input,
				output: tier.output,
				cache: { read: tier.cacheRead, write: tier.cacheWrite },
			});
		}

		result.push({
			id: m.id,
			modelID: m.id,
			providerID: "plexus",
			name: m.name ?? m.id,
			...(compatibility ? { compatibility } : {}),
			...(pkg ? { package: pkg } : {}),
			...(policy ? { policy } : {}),
			settings: { baseURL: resolveModelBaseURL(preferredApi, apiBaseURL) },
			capabilities: {
				tools: params.includes("tools"),
				input: inputModalities,
				output: outputModalities,
			},
			variants: variants ?? [],
			time: { released: releaseTime(m.created) },
			cost,
			status: "active",
			enabled: true,
			limit: {
				context: contextLength,
				output: maxOutput,
			},
		});
	}

	return orderModelsByApiBase(result);
}

/** Placeholder published before connect so the provider is not pruned. */
export function placeholderModel(): PlexusModelInfo {
	return {
		id: "plexus-unconfigured",
		modelID: "plexus-unconfigured",
		providerID: "plexus",
		name: "Plexus (run /connect to configure)",
		settings: {},
		capabilities: { tools: false, input: ["text"], output: ["text"] },
		variants: [],
		time: { released: 0 },
		cost: [],
		status: "active",
		enabled: true,
		limit: { context: 1024, output: 1024 },
	};
}
