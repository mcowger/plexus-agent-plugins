import type { PlexusApiModel, PlexusModelDescriptor } from "./types.ts";

const REASONING_PARAMS = new Set(["reasoning", "include_reasoning", "reasoning_effort"]);

export type OpenAICompletionsThinkingFormat =
	| "openai"
	| "openrouter"
	| "deepseek"
	| "together"
	| "zai"
	| "qwen"
	| "chat-template"
	| "qwen-chat-template"
	| "string-thinking"
	| "ant-ling";

const API_DIALECT_MAP: Record<string, string> = {
	chat_completions: "openai-completions",
	"openai-completions": "openai-completions",
	messages: "anthropic-messages",
	"anthropic-messages": "anthropic-messages",
	gemini: "google-generative-ai",
	"google-generative-ai": "google-generative-ai",
	responses: "openai-responses",
	"openai-responses": "openai-responses",
};

/**
 * Maps the raw preferred_api value (string or string[]) to one of four
 * canonical dialect strings. Unknown values fall back to "openai-completions".
 */
export function mapPreferredApi(raw: string | string[] | undefined): string {
	if (raw === undefined) return "openai-completions";
	const candidates = Array.isArray(raw) ? raw : [raw];
	for (const candidate of candidates) {
		const mapped = API_DIALECT_MAP[candidate];
		if (mapped !== undefined) return mapped;
	}
	return "openai-completions";
}

/**
 * Adjusts the Plexus base URL (which normally ends in /v1) for the selected
 * API dialect:
 * - anthropic-messages: strip the trailing /v1 because Anthropic clients add /v1/messages
 * - google-generative-ai: replace /v1 with /v1beta
 * - all others: pass through unchanged
 */
export function adjustBaseUrl(baseUrl: string, preferredApi: string): string {
	const stripped = baseUrl.replace(/\/+$/, "");
	switch (preferredApi) {
		case "anthropic-messages":
			return stripped.endsWith("/v1") ? stripped.slice(0, -3) : stripped;
		case "google-generative-ai":
			return stripped.endsWith("/v1") ? `${stripped.slice(0, -3)}/v1beta` : stripped;
		default:
			return stripped;
	}
}

/**
 * Normalizes the input_modalities array to only "text" and "image".
 * Defaults to ["text"] when the field is absent or the result would be empty.
 */
export function mapInputModalities(model: PlexusApiModel): ("text" | "image")[] {
	const raw = model.architecture?.input_modalities;
	if (!raw || raw.length === 0) return ["text"];
	const result: ("text" | "image")[] = [];
	for (const m of raw) {
		if (m === "text" || m === "image") result.push(m);
	}
	return result.length > 0 ? result : ["text"];
}

/**
 * Returns true when supported_parameters contains any known reasoning parameter.
 */
export function inferReasoning(model: PlexusApiModel): boolean {
	const params = model.supported_parameters;
	if (!params) return false;
	return params.some((p) => REASONING_PARAMS.has(p));
}

function parsePrice(raw: string | undefined): number {
	if (raw === undefined) return 0;
	const n = parseFloat(raw);
	return isFinite(n) && n >= 0 ? n : 0;
}

function resolveContextWindow(model: PlexusApiModel): number {
	const v = model.context_length ?? model.top_provider?.context_length ?? null;
	return v != null && v > 0 ? v : 8192;
}

function resolveMaxTokens(model: PlexusApiModel, contextWindow: number): number {
	const v = model.top_provider?.max_completion_tokens ?? null;
	return v != null && v > 0 ? v : contextWindow;
}

function resolvePricingTiers(model: PlexusApiModel): PlexusModelDescriptor["cost"]["tiers"] {
	const pricing = model.pricing;
	if (!pricing?.tiers) return undefined;

	const tiers = pricing.tiers.flatMap((tier) => {
		if (!Number.isFinite(tier.input_tokens_above) || tier.input_tokens_above < 0) return [];
		return [{
			inputTokensAbove: tier.input_tokens_above,
			input: parsePrice(tier.prompt ?? pricing.prompt),
			output: parsePrice(tier.completion ?? pricing.completion),
			cacheRead: parsePrice(tier.input_cache_read ?? pricing.input_cache_read),
			cacheWrite: parsePrice(tier.input_cache_write ?? pricing.input_cache_write),
		}];
	});

	return tiers.length > 0 ? tiers : undefined;
}

/**
 * Converts a single PlexusApiModel into a PlexusModelDescriptor.
 * Does NOT populate compat or thinkingLevelMap — those are reserved for host packages.
 */
export function convertToDescriptor(raw: PlexusApiModel, baseUrl: string): PlexusModelDescriptor {
	const preferredApi = mapPreferredApi(raw.preferred_api);
	const adjustedBaseUrl = adjustBaseUrl(baseUrl, preferredApi);
	const contextWindow = resolveContextWindow(raw);
	const maxTokens = resolveMaxTokens(raw, contextWindow);
	const tiers = resolvePricingTiers(raw);

	const descriptor: PlexusModelDescriptor = {
		id: raw.id,
		name: raw.name ?? raw.id,
		preferredApi,
		provider: "plexus",
		baseUrl: adjustedBaseUrl,
		reasoning: inferReasoning(raw),
		input: mapInputModalities(raw),
		cost: {
			input: parsePrice(raw.pricing?.prompt),
			output: parsePrice(raw.pricing?.completion),
			cacheRead: parsePrice(raw.pricing?.input_cache_read),
			cacheWrite: parsePrice(raw.pricing?.input_cache_write),
			...(tiers !== undefined ? { tiers } : {}),
		},
		contextWindow,
		maxTokens,
	};

	if (raw.pi_provider) descriptor.piProvider = raw.pi_provider;
	if (raw.pi_model) descriptor.piModel = raw.pi_model;
	if (raw.pi_options && Object.keys(raw.pi_options).length > 0) descriptor.piOptions = raw.pi_options;

	return descriptor;
}

/**
 * Batch-converts an array of PlexusApiModel, silently skipping entries with falsy ids.
 * Output order matches input order minus skipped entries.
 */
export function convertDescriptors(models: PlexusApiModel[], baseUrl: string): PlexusModelDescriptor[] {
	const result: PlexusModelDescriptor[] = [];
	for (const m of models) {
		if (!m.id) continue;
		result.push(convertToDescriptor(m, baseUrl));
	}
	return result;
}

// ---------------------------------------------------------------------------
// Compat detection
// ---------------------------------------------------------------------------

/**
 * Detects the upstream provider from a provider-name string and base URL, then
 * returns the full set of OpenAI Completions compatibility flags needed to
 * correctly format requests.
 *
 * This function exists because all Plexus-proxied models present "plexus" as
 * their provider, so the host agent cannot auto-detect settings from provider
 * identity alone. Call this from host packages, NOT from convertToDescriptor.
 */
export function detectOpenAICompletionsCompat(
	providerName: string,
	baseUrl: string,
): Record<string, unknown> {
	const name = providerName.toLowerCase();
	let host = "";
	try {
		host = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		// ignore malformed URLs
	}

	// Detect known non-standard providers
	const isCerebras = name === "cerebras" || host.includes("cerebras");
	const isChutes = name === "chutes.ai" || host.includes("chutes.ai");
	const isXai = name === "xai" || host === "api.x.ai";
	const isZai = name === "zai" || host === "api.zai.com" || host.includes("z.ai");
	const isMoonshot =
		name === "moonshotai" || name === "moonshotai-cn" || host.includes("moonshot") || host.includes("kimi");
	const isOpencode = name === "opencode" || host.includes("opencode");
	const isCloudflareWorkers =
		host.includes("workers.cloudflare.com") || host.includes("ai.cloudflare.com");
	const isCloudflareGateway =
		host.includes("gateway.ai.cloudflare.com");
	const isCloudflare = isCloudflareWorkers || isCloudflareGateway;
	const isDeepSeek = name === "deepseek" || host.includes("deepseek");
	const isOpenRouter = name === "openrouter" || host.includes("openrouter.ai");

	const isNonStandard =
		isCerebras ||
		isChutes ||
		isXai ||
		isZai ||
		isMoonshot ||
		isOpencode ||
		isCloudflare ||
		isDeepSeek;

	const supportsStore = !isNonStandard;
	const supportsDeveloperRole = !isNonStandard;
	const supportsReasoningEffort =
		!isXai && !isZai && !isMoonshot && !isCloudflareGateway;

	let maxTokensField: "max_tokens" | "max_completion_tokens" = "max_completion_tokens";
	if (isChutes || isMoonshot || isCloudflareGateway) {
		maxTokensField = "max_tokens";
	}

	let thinkingFormat: OpenAICompletionsThinkingFormat = "openai";
	if (isDeepSeek) thinkingFormat = "deepseek";
	else if (isZai) thinkingFormat = "zai";
	else if (isOpenRouter) thinkingFormat = "openrouter";

	const requiresReasoningContentOnAssistantMessages = isDeepSeek;

	const cacheControlFormat: "anthropic" | undefined = isOpenRouter ? "anthropic" : undefined;

	const supportsStrictMode = !isMoonshot && !isCloudflareGateway;

	const supportsLongCacheRetention = !isCloudflare;

	const compat: Record<string, unknown> = {
		supportsStore,
		supportsDeveloperRole,
		supportsReasoningEffort,
		supportsUsageInStreaming: true,
		maxTokensField,
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages,
		thinkingFormat,
		openRouterRouting: {},
		vercelGatewayRouting: {},
		zaiToolStream: false,
		supportsStrictMode,
		sendSessionAffinityHeaders: false,
		supportsLongCacheRetention,
	};

	if (cacheControlFormat !== undefined) {
		compat.cacheControlFormat = cacheControlFormat;
	}

	return compat;
}

/** Default request timeout for fetchPlexusModels, in milliseconds. */
export const DEFAULT_MODELS_FETCH_TIMEOUT_MS = 10_000;

/**
 * Issues a GET to the Plexus /v1/models endpoint and returns the parsed model list
 * plus the raw response envelope.
 *
 * Bounded by an AbortController-based timeout (default 10s) so a slow or
 * unreachable server cannot hang the caller indefinitely — plugin startup
 * paths depend on this call resolving (or rejecting) promptly.
 */
export async function fetchPlexusModels(
	apiKey: string,
	modelsUrl: string,
	timeoutMs: number = DEFAULT_MODELS_FETCH_TIMEOUT_MS,
): Promise<{ models: PlexusApiModel[]; raw: import("./types.ts").PlexusApiResponse }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

		const res = await fetch(modelsUrl, {
			headers,
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`Plexus models fetch failed: ${res.status} ${res.statusText}`);
		}
		const raw = (await res.json()) as import("./types.ts").PlexusApiResponse;
		return { models: raw.data ?? [], raw };
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(`Plexus models fetch timed out after ${timeoutMs}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
