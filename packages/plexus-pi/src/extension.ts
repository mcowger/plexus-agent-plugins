/**
 * plexus-pi — pi (earendil-works/pi-coding-agent) adapter for Plexus model proxy.
 *
 * Auth: API key is stored by pi's credential store (persisted in auth.json).
 *       It may also be pre-seeded via the PLEXUS_API_KEY env var.
 *
 * Model discovery: Pi 0.85.1+ runs the provider's refreshModels hook in two
 *       phases — a cache-restore phase (allowNetwork: false, read-only
 *       context.stored snapshot) followed by a network phase with the resolved
 *       credential — at startup, after /login, when /model opens, and from
 *       /plexus refresh. Catalog persistence goes through the generation-checked
 *       context.publish() transaction into pi's models-store.json.
 *
 * Commands:
 *   /login plexus       — set base URL and API key using pi's native login UI
 *   /plexus refresh     — re-fetch models from the Plexus endpoint
 *   /plexus status      — show effective configuration and catalog state
 */

import type {
	Api,
	Credential,
	GoogleApiThinkingLevel,
	Model,
	ModelThinkingLevel,
	OAuthCredentials,
	OAuthLoginCallbacks,
	Provider,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
// Type-only — erased at runtime, never resolved by the module loader
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ModelRegistry,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
	adjustBaseUrl,
	convertDescriptors,
	fetchPlexusModels,
	isModelSuppressed,
	type PlexusApiModel,
} from "../../plexus-models/src/index.ts";
import { readStoredModelsSync } from "./cache.ts";
import {
	getApiKeyEnvName,
	getBaseUrl,
	getBaseUrlResolution,
	getEnvApiKey,
	getModelsUrl,
	getSuppressedModels,
	isApiKeyEnvExplicit,
	resolveApiKey,
	resolveExplicitApiKey,
	resolveExplicitApiKeyFromEnv,
	saveBaseUrl,
} from "./config.ts";
import type { ContextPolicy } from "./context-policy.ts";
import { normalizeMalformedFunctionCall } from "./gemini-malformed-retry.ts";
import { log } from "./log.ts";
import { descriptorToPiModel, MINIMUM_OUTPUT_TOKENS } from "./mapper.ts";
import { createPlexuspiControl } from "./paseo-control/control.ts";
import {
	injectServiceTier,
	type PolicyAdvertisement,
	PolicyController,
	type PolicyHost,
} from "./policy.ts";
import {
	type ServiceTierPolicy,
	ServiceTierPolicySchema,
} from "./service-tiers.ts";
import { type ShortNameEntry, ShortNameEntrySchema } from "./short-names.ts";

const PROVIDER_NAME = "plexus";
const PLEXUS_CREDENTIAL_EXPIRES_AT = 253_402_300_799_000;
const PLACEHOLDER_BASE_URL = "http://localhost/v1";

type PlexusCredentials = OAuthCredentials & { plexusBaseUrl?: string };

type StoredContextPolicyMetadata = { policy: ContextPolicy; fetchedAt: number };
type ContextPolicyBearingModel = ProviderModelConfig & {
	plexusContextPolicy?: StoredContextPolicyMetadata;
};
type StoredServiceTiersMetadata = {
	policy?: ServiceTierPolicy;
	fetchedAt: number;
};
type ServiceTierBearingModel = ProviderModelConfig & {
	plexusServiceTiers?: StoredServiceTiersMetadata;
};
type ShortNameBearingModel = ProviderModelConfig & {
	plexusShortName?: string;
};

/**
 * Mutable state of one extension instance (one pi session). Created inside
 * plexusExtension() and passed explicitly, so parent and child sessions in the
 * same process never observe each other's models, controllers, or catalog.
 */
interface PlexusInstanceState {
	models: ProviderModelConfig[];
	catalogSource: "host store" | "live refresh" | "none";
	policy: PolicyController | undefined;
	/** This session's active model, from its own session/model events only. */
	activeModel: Model<Api> | undefined;
	registry: ModelRegistry | undefined;
}

export function enforceMinimumOutputTokens(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return payload;

	const next = { ...(payload as Record<string, unknown>) };
	let changed = false;
	for (const field of [
		"max_completion_tokens",
		"max_tokens",
		"max_output_tokens",
	] as const) {
		const value = next[field];
		if (
			typeof value === "number" &&
			Number.isFinite(value) &&
			value < MINIMUM_OUTPUT_TOKENS
		) {
			next[field] = MINIMUM_OUTPUT_TOKENS;
			changed = true;
		}
	}

	for (const configKey of ["generationConfig", "config"] as const) {
		const generationConfig = next[configKey];
		if (
			generationConfig &&
			typeof generationConfig === "object" &&
			!Array.isArray(generationConfig)
		) {
			const maxOutputTokens = (generationConfig as Record<string, unknown>)
				.maxOutputTokens;
			if (
				typeof maxOutputTokens === "number" &&
				Number.isFinite(maxOutputTokens) &&
				maxOutputTokens < MINIMUM_OUTPUT_TOKENS
			) {
				next[configKey] = {
					...(generationConfig as Record<string, unknown>),
					maxOutputTokens: MINIMUM_OUTPUT_TOKENS,
				};
				changed = true;
			}
		}
	}

	return changed ? next : payload;
}

const EXTENDED_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const GOOGLE_THINKING_LEVELS: Record<string, GoogleApiThinkingLevel> = {
	minimal: "MINIMAL",
	low: "LOW",
	medium: "MEDIUM",
	high: "HIGH",
};

type GoogleThinkingModel = Pick<
	Model<Api>,
	"id" | "api" | "reasoning" | "thinkingLevelMap"
>;

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match?.[1]) return undefined;
	return Number.parseInt(match[1], 10);
}

/**
 * Returns whether a Google model uses discrete `thinkingLevel` controls rather
 * than token-based `thinkingBudget`.
 *
 * Pi's built-in `usesGoogleThinkingLevel` only matches `/gemini-3(?:\.\d+)?-(?:pro|flash)/`
 * and `/gemma-?4/`, which misses Gemini 4+ models (e.g. `gemini-4-argon`) and
 * custom model aliases that declare `thinkingLevelMap` overrides.
 */
export function usesGoogleThinkingLevel(model: GoogleThinkingModel): boolean {
	if (
		model.thinkingLevelMap &&
		EXTENDED_THINKING_LEVELS.some(
			(level) =>
				level !== "off" && typeof model.thinkingLevelMap?.[level] === "string",
		)
	) {
		return true;
	}

	const id = model.id.toLowerCase();
	const majorVersion = getGeminiMajorVersion(id);
	return (
		(majorVersion !== undefined && majorVersion >= 3) ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest" ||
		/gemma-?4/.test(id)
	);
}

function getSupportedThinkingLevelsForModel(
	model: GoogleThinkingModel,
): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function clampModelThinkingLevel(
	model: GoogleThinkingModel,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevelsForModel(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (candidate && availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (candidate && availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

function toGoogleThinkingLevel(
	model: GoogleThinkingModel,
	level: ModelThinkingLevel,
): GoogleApiThinkingLevel | undefined {
	const clamped = clampModelThinkingLevel(model, level);
	if (clamped === "off") return undefined;
	const mapped = model.thinkingLevelMap?.[clamped];
	const resolved = (typeof mapped === "string" ? mapped : clamped)
		.trim()
		.toLowerCase();
	return GOOGLE_THINKING_LEVELS[resolved];
}

function normalizeThinkingConfigObject(
	thinkingConfig: Record<string, unknown>,
	model: GoogleThinkingModel,
	thinkingLevel: ModelThinkingLevel | undefined,
): Record<string, unknown> {
	if (thinkingConfig.thinkingLevel !== undefined) return thinkingConfig;

	if (thinkingConfig.thinkingBudget === -1) {
		const effectiveLevel =
			thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : "high";
		const googleLevel = toGoogleThinkingLevel(model, effectiveLevel);
		if (!googleLevel) return thinkingConfig;
		const { thinkingBudget: _thinkingBudget, ...rest } = thinkingConfig;
		return {
			...rest,
			thinkingLevel: googleLevel,
		};
	}

	if (thinkingConfig.thinkingBudget === 0) {
		const googleLevel = toGoogleThinkingLevel(model, "off");
		if (!googleLevel) return thinkingConfig;
		const { thinkingBudget: _thinkingBudget, ...rest } = thinkingConfig;
		return {
			...rest,
			thinkingLevel: googleLevel,
		};
	}

	return thinkingConfig;
}

/**
 * Rewrites fallback `thinkingBudget` values (`-1` when enabled, `0` when
 * disabled on models that cannot disable thinking) to discrete `thinkingLevel`
 * values for level-based Google models.
 *
 * Handles both the `@google/genai` SDK `GenerateContentParameters` shape
 * (`payload.config.thinkingConfig`) passed to `before_provider_request` and the
 * raw wire shape (`payload.generationConfig.thinkingConfig`).
 */
export function normalizeGoogleThinkingConfig(
	payload: unknown,
	model: GoogleThinkingModel | undefined,
	thinkingLevel: ModelThinkingLevel | undefined,
): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return payload;
	if (!model?.reasoning) return payload;
	if (model.api !== "google-generative-ai" && model.api !== "google-vertex")
		return payload;
	if (!usesGoogleThinkingLevel(model)) return payload;

	const next = { ...(payload as Record<string, unknown>) };
	let changed = false;

	for (const configKey of ["config", "generationConfig"] as const) {
		const container = next[configKey];
		if (!container || typeof container !== "object" || Array.isArray(container))
			continue;
		const containerRecord = container as Record<string, unknown>;
		const thinkingConfig = containerRecord.thinkingConfig;
		if (
			!thinkingConfig ||
			typeof thinkingConfig !== "object" ||
			Array.isArray(thinkingConfig)
		) {
			continue;
		}
		const normalized = normalizeThinkingConfigObject(
			thinkingConfig as Record<string, unknown>,
			model,
			thinkingLevel,
		);
		if (normalized !== thinkingConfig) {
			next[configKey] = {
				...containerRecord,
				thinkingConfig: normalized,
			};
			changed = true;
		}
	}

	return changed ? next : payload;
}

function getSessionThinkingLevel(
	pi: ExtensionAPI,
): ModelThinkingLevel | undefined {
	try {
		return pi.getThinkingLevel?.();
	} catch {
		return undefined;
	}
}

/** A model carrying optional static request headers. */
interface HeaderBearingModel {
	id: string;
	headers?: Record<string, string>;
}

/**
 * Override stored API keys across all dialects, preserving native headers.
 *
 * Registering this as a native provider makes pi delete the extension provider
 * config, so per-model headers copied from the built-in mapper would otherwise
 * vanish from request auth. Pi only merges headers carried on model objects, so
 * re-attach them here. The header source is read live, so models that arrive
 * from a refresh after the swap keep their headers too.
 */
export function withAuthoritativeApiKeyEnv(
	provider: Provider,
	envName: string,
	getHeaderModels: () => ReadonlyArray<HeaderBearingModel> = () => [],
): Provider {
	const apiKey = provider.auth.apiKey;
	if (!apiKey) return provider;

	const withModelHeaders = <TModel extends HeaderBearingModel>(
		models: readonly TModel[],
	): TModel[] => {
		const headersById = new Map<string, Record<string, string>>();
		for (const model of getHeaderModels()) {
			if (model.headers) headersById.set(model.id, model.headers);
		}
		if (headersById.size === 0) return [...models];
		return models.map((model) => {
			const headers = headersById.get(model.id);
			return headers
				? { ...model, headers: { ...model.headers, ...headers } }
				: model;
		});
	};

	return {
		...provider,
		auth: {
			...provider.auth,
			apiKey: {
				...apiKey,
				resolve: async (input) => {
					const explicit = await resolveExplicitApiKeyFromEnv((name) =>
						input.ctx.env(name),
					);
					if (explicit === undefined) return apiKey.resolve(input);
					const result = await apiKey.resolve({
						...input,
						credential: {
							type: "api_key",
							key: explicit,
							...(input.credential?.env ? { env: input.credential.env } : {}),
						},
					});
					return result
						? { ...result, source: `${envName} (apiKeyEnv)` }
						: result;
				},
			},
		},
		getModels: () => withModelHeaders(provider.getModels()),
		getAllModels: () =>
			withModelHeaders(provider.getAllModels?.() ?? provider.getModels()),
	};
}

/**
 * Host adapter for the session-scoped policy controller. The active model is
 * cached from this session's own event handlers, and the advertisement is read
 * from the committed catalog metadata.
 */
export function createPolicyHost(deps: {
	getActiveModel: () => Model<Api> | undefined;
	getModels: () => readonly ProviderModelConfig[];
	getRegistry: () => ModelRegistry | undefined;
	setModel: (model: Model<Api>) => Promise<boolean>;
	setActiveModel: (model: Model<Api>) => void;
}): PolicyHost {
	return {
		getActiveModel() {
			const model = deps.getActiveModel();
			if (!model || model.provider !== PROVIDER_NAME) return undefined;
			return { provider: model.provider, id: model.id };
		},
		getAdvertisement(model) {
			const entry = deps
				.getModels()
				.find((candidate) => candidate.id === model.id);
			if (!entry) return undefined;
			const context = (entry as ContextPolicyBearingModel).plexusContextPolicy
				?.policy;
			const serviceTier = (entry as ServiceTierBearingModel).plexusServiceTiers
				?.policy;
			if (!context && !serviceTier) return undefined;
			return {
				...(context ? { context } : {}),
				...(serviceTier ? { serviceTier } : {}),
			} satisfies PolicyAdvertisement;
		},
		getCatalogContextWindow(model) {
			return deps.getRegistry()?.find(model.provider, model.id)?.contextWindow;
		},
		hasCatalogContextPolicy() {
			return deps
				.getModels()
				.some(
					(entry) =>
						(entry as ContextPolicyBearingModel).plexusContextPolicy !==
						undefined,
				);
		},
		async applyContextWindow(model, contextWindow) {
			const registry = deps.getRegistry();
			if (!registry) return undefined;
			const canonical = registry.find(model.provider, model.id);
			if (!canonical) return undefined;
			const target = (
				contextWindow === undefined
					? canonical
					: { ...canonical, contextWindow }
			) as Model<Api>;
			const active = deps.getActiveModel();
			if (
				active?.provider === target.provider &&
				active.id === target.id &&
				active.contextWindow === target.contextWindow
			) {
				return target.contextWindow;
			}
			const applied = await deps.setModel(target);
			if (!applied) return undefined;
			deps.setActiveModel(target);
			return target.contextWindow;
		},
	};
}

export default function plexusExtension(pi: ExtensionAPI): void {
	const state: PlexusInstanceState = {
		models: [],
		catalogSource: "none",
		policy: undefined,
		activeModel: undefined,
		registry: undefined,
	};
	const host = createPolicyHost({
		getActiveModel: () => state.activeModel,
		getModels: () => state.models,
		getRegistry: () => state.registry,
		setModel: (model) => pi.setModel(model),
		setActiveModel: (model) => {
			state.activeModel = model;
		},
	});
	const policy = new PolicyController(host);
	state.policy = policy;
	// Inert until an authenticated Plexus root request activates it.
	createPlexuspiControl(pi, { policy, host });
	pi.on("session_shutdown", () => {
		if (state.policy === policy) state.policy = undefined;
	});

	// An explicit apiKeyEnv is authoritative and throws when its variable is
	// missing or empty; the default PLEXUS_API_KEY remains an optional fallback.
	const apiKeyEnvExplicit = isApiKeyEnvExplicit();
	const explicitApiKey = apiKeyEnvExplicit
		? resolveExplicitApiKey()
		: undefined;
	const apiKeyEnvName = getApiKeyEnvName();
	const envApiKey = explicitApiKey ?? getEnvApiKey();
	const startupBaseUrl = getBaseUrl();
	const suppressPatterns = getSuppressedModels();

	const storedCatalog = readStoredModelsSync();
	const startupModels = (storedCatalog?.models ?? []).filter(
		(model) =>
			!isModelSuppressed({ id: model.id, name: model.name }, suppressPatterns),
	);

	state.models = startupModels;
	state.catalogSource = startupModels.length > 0 ? "host store" : "none";
	void policy.reconcile();

	// Track the active model so the policy controller resolves the advertisement
	// and applies the session-scoped context window without an ExtensionContext.
	pi.on("session_start", (_event, ctx) => {
		state.registry = ctx.modelRegistry;
		state.activeModel = ctx.model;
		void state.policy?.reconcile();
	});
	pi.on("model_select", (event, ctx) => {
		state.registry = ctx.modelRegistry;
		state.activeModel = event.model;
		void state.policy?.reconcile();
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_NAME) return undefined;
		state.activeModel = ctx.model;
		const withTier = injectServiceTier(
			event.payload,
			state.policy?.serviceTierFor(ctx.model),
		);
		const withThinking = normalizeGoogleThinkingConfig(
			withTier,
			ctx.model,
			ctx.thinkingLevel ?? getSessionThinkingLevel(pi),
		);
		const next = enforceMinimumOutputTokens(withThinking);
		return next === event.payload ? undefined : next;
	});

	log("startup", {
		baseUrl: startupBaseUrl,
		hasEnvApiKey: !!envApiKey,
		hostStoredModelCount: startupModels.length,
	});

	// Retag known transient upstream failures so pi's native agent-turn retry
	// recognizes them. Scoped to this provider's own error turns; pi drops the
	// failed message before retrying, so no visible partial output is duplicated.
	pi.on("message_end", (event) =>
		normalizeMalformedFunctionCall(event.message, PROVIDER_NAME),
	);

	pi.registerProvider(PROVIDER_NAME, {
		api: "openai-completions" as Api,
		// Register the env-var template with the configured variable name. It is
		// only registered when the variable is present: pi's credential
		// resolution throws on unresolvable templates during catalog refresh,
		// whereas providers without an apiKey auth are skipped silently.
		...(envApiKey ? { apiKey: `\${${apiKeyEnvName}}` } : {}),
		authHeader: true,
		baseUrl: startupBaseUrl ?? PLACEHOLDER_BASE_URL,
		models: startupModels,
		refreshModels: (context) => refreshPlexusModels(state, context),
		oauth: createPlexusLoginProvider(),
	});

	// Templates are fallbacks behind stored plain keys. Wrap the composed
	// provider's native auth once it exists so explicit apiKeyEnv wins instead.
	if (apiKeyEnvExplicit) {
		let authOverrideApplied = false;
		pi.on("session_start", (_event, ctx) => {
			if (authOverrideApplied) return;
			const composed = ctx.modelRegistry.getProvider(PROVIDER_NAME);
			if (!composed?.auth.apiKey) {
				throw new Error(
					"Plexus apiKeyEnv override failed: provider API-key auth is unavailable",
				);
			}
			pi.registerProvider(
				withAuthoritativeApiKeyEnv(composed, apiKeyEnvName, () => state.models),
			);
			authOverrideApplied = true;
			log("auth: applied authoritative apiKeyEnv override", {
				apiKeyEnv: apiKeyEnvName,
			});
		});
	}

	// -------------------------------------------------------------------------
	// /plexus command
	// -------------------------------------------------------------------------
	pi.registerCommand("plexus", {
		description:
			"Plexus provider commands: refresh, status (setup: /login plexus)",
		getArgumentCompletions: (prefix) => {
			const subcommands = [
				{
					value: "refresh",
					label: "refresh",
					description: "Refresh Plexus models from the API",
				},
				{
					value: "status",
					label: "status",
					description: "Show Plexus configuration and catalog status",
				},
			];
			return prefix.includes(" ")
				? null
				: subcommands.filter((command) => command.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "refresh" || sub === "") return handleRefresh(state, ctx);
			if (sub === "status") return handleStatus(state, ctx);
			ctx.ui.notify(
				`Unknown sub-command: "${args}". Use /login plexus, /plexus refresh, or /plexus status.`,
				"warning",
			);
		},
	});
}

// ---------------------------------------------------------------------------
// Catalog refresh (driven by pi's ModelRuntime)
// ---------------------------------------------------------------------------
async function refreshPlexusModels(
	state: PlexusInstanceState,
	context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
	const baseUrl = getBaseUrl();
	const modelsUrl = getModelsUrl();
	const apiKey = resolveApiKey(credentialApiKey(context.credential));
	const suppress = getSuppressedModels();

	if (!context.allowNetwork || !apiKey || !modelsUrl || !baseUrl) {
		// Prefer models fetched earlier this session; they are always at least
		// as fresh as the store. Persist them for future offline sessions.
		if (state.models.length > 0) {
			const filteredCurrent = state.models.filter(
				(m) => !isModelSuppressed({ id: m.id, name: m.name }, suppress),
			);
			await context.publish({
				persist: {
					models: filteredCurrent as unknown as Model<Api>[],
					checkedAt: Date.now(),
				},
				update: () => {
					state.models = filteredCurrent;
					void state.policy?.reconcile();
				},
			});
			return filteredCurrent;
		}
		const restored = await restoreStoredModels(state, context);
		if (restored) return restored;
		if (!context.allowNetwork) return [];
		throw new Error(
			!modelsUrl || !baseUrl
				? "Plexus base URL not configured. Run /login plexus first."
				: "No Plexus API key configured. Run /login plexus first.",
		);
	}

	try {
		const { models: apiModels } = await fetchPlexusModels(
			apiKey,
			modelsUrl,
			undefined,
			undefined,
			context.signal,
		);
		const fetchedAt = Date.now();

		const descriptors = convertDescriptors(apiModels, baseUrl, suppress);
		const piModels = descriptors.map(descriptorToPiModel) as Array<
			ContextPolicyBearingModel &
				ServiceTierBearingModel &
				ShortNameBearingModel
		>;
		const eligibleIds = new Set(piModels.map((model) => model.id));
		for (const model of apiModels) {
			if (!eligibleIds.has(model.id)) continue;
			const piModel = piModels.find((candidate) => candidate.id === model.id);
			if (!piModel) continue;
			const policy = contextPolicyFromApiModel(model);
			if (policy) piModel.plexusContextPolicy = { policy, fetchedAt };
			piModel.plexusServiceTiers = {
				policy: serviceTierPolicyFromApiModel(model),
				fetchedAt,
			};
			// Reconcile against the raw wire value so the persisted prop is
			// always schema-valid, even if the descriptor path carried something
			// the snapshot schema rejects.
			const shortName = shortNameEntryFromApiModel(model);
			if (shortName) piModel.plexusShortName = shortName.shortName;
			else delete piModel.plexusShortName;
		}

		// pi publishes the returned list in memory but does not persist it —
		// persistence is provider-owned via generation-checked publish().
		const published = await context.publish({
			persist: {
				models: piModels as unknown as Model<Api>[],
				checkedAt: Date.now(),
			},
			update: () => {
				state.models = piModels;
				state.catalogSource = "live refresh";
				void state.policy?.reconcile();
			},
		});
		if (!published) {
			log("refreshModels: publication superseded by a newer refresh", {});
		}

		log("refreshModels: fetched", { count: piModels.length });
		return piModels;
	} catch (error) {
		log("refreshModels: fetch failed", { error: String(error) });
		throw error;
	}
}

async function restoreStoredModels(
	state: PlexusInstanceState,
	context: RefreshModelsContext,
): Promise<ProviderModelConfig[] | undefined> {
	const stored = context.stored;
	if (!stored || stored.models.length === 0) return undefined;
	const suppress = getSuppressedModels();
	const models = (stored.models as unknown as ProviderModelConfig[]).filter(
		(m) => !isModelSuppressed({ id: m.id, name: m.name }, suppress),
	);
	// Nothing new to persist (the snapshot came from the store); only adopt it
	// as our in-memory list, generation-checked so a newer refresh wins.
	await context.publish({
		update: () => {
			state.models = models;
			state.catalogSource = "host store";
			void state.policy?.reconcile();
		},
	});
	log("refreshModels: restored from store", { count: models.length });
	return models;
}

export function contextPolicyFromApiModel(
	model: PlexusApiModel,
): ContextPolicy | undefined {
	const maxContextTokens = model.context_length;
	const pricingThresholdInputTokens =
		model.pricing?.tiers?.[0]?.input_tokens_above;
	if (
		typeof maxContextTokens !== "number" ||
		!Number.isSafeInteger(maxContextTokens) ||
		maxContextTokens <= 0 ||
		typeof pricingThresholdInputTokens !== "number" ||
		!Number.isSafeInteger(pricingThresholdInputTokens) ||
		pricingThresholdInputTokens <= 0 ||
		pricingThresholdInputTokens > maxContextTokens
	)
		return undefined;
	return {
		provider: PROVIDER_NAME,
		modelId: model.id,
		maxContextTokens,
		shortContextBudgetTokens: pricingThresholdInputTokens,
		pricingThresholdInputTokens,
	};
}

export function serviceTierPolicyFromApiModel(
	model: PlexusApiModel,
): ServiceTierPolicy | undefined {
	const serviceTiers = (model as PlexusApiModel & { service_tiers?: unknown })
		.service_tiers;
	if (!Array.isArray(serviceTiers) || serviceTiers.length === 0)
		return undefined;
	const candidate = {
		provider: PROVIDER_NAME,
		modelId: model.id,
		serviceTiers,
	};
	const parsed = ServiceTierPolicySchema.safeParse(candidate);
	return parsed.success ? parsed.data : undefined;
}

export function shortNameEntryFromApiModel(
	model: PlexusApiModel,
): ShortNameEntry | undefined {
	const shortName =
		typeof model.short_name === "string" ? model.short_name.trim() : "";
	if (!shortName) return undefined;
	const parsed = ShortNameEntrySchema.safeParse({
		provider: PROVIDER_NAME,
		modelId: model.id,
		shortName,
	});
	return parsed.success ? parsed.data : undefined;
}

function credentialApiKey(
	credential: Credential | undefined,
): string | undefined {
	if (!credential) return undefined;
	if (credential.type === "api_key") return credential.key || undefined;
	return String(credential.access || credential.refresh || "") || undefined;
}

function createPlexusLoginProvider(): NonNullable<ProviderConfig["oauth"]> {
	return {
		name: "Plexus",
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const baseUrl = (
				await callbacks.onPrompt({
					message: "Plexus base URL",
					placeholder: "https://plexus.example.com",
				})
			).trim();
			if (!baseUrl) throw new Error("Plexus base URL is required.");

			const apiKey = (
				await callbacks.onPrompt({ message: "Plexus API key" })
			).trim();
			if (!apiKey) throw new Error("Plexus API key is required.");

			// Saved before returning so the runtime's automatic post-login catalog
			// refresh can resolve the base URL.
			await saveBaseUrl(baseUrl);

			return {
				access: apiKey,
				refresh: apiKey,
				expires: PLEXUS_CREDENTIAL_EXPIRES_AT,
				plexusBaseUrl: baseUrl,
			} satisfies PlexusCredentials;
		},
		async refreshToken(
			credentials: OAuthCredentials,
			signal: AbortSignal,
		): Promise<OAuthCredentials> {
			signal.throwIfAborted();
			return { ...credentials, expires: PLEXUS_CREDENTIAL_EXPIRES_AT };
		},
		getApiKey(credentials: OAuthCredentials): string {
			// Explicit apiKeyEnv outranks the stored OAuth credential; missing or
			// empty values throw instead of silently falling back.
			const stored = String(credentials.access || credentials.refresh || "");
			return resolveExplicitApiKey() ?? stored;
		},
		modifyModels(models, credentials) {
			const baseUrl = (credentials as PlexusCredentials).plexusBaseUrl;
			if (!baseUrl) return models;
			const apiBase = baseUrl.trim().replace(/\/+$/, "").endsWith("/v1")
				? baseUrl.trim().replace(/\/+$/, "")
				: `${baseUrl.trim().replace(/\/+$/, "")}/v1`;
			return models.map((model) =>
				model.provider === PROVIDER_NAME
					? { ...model, baseUrl: adjustBaseUrl(apiBase, model.api) }
					: model,
			);
		},
	};
}

// ---------------------------------------------------------------------------
// Refresh command handler
// ---------------------------------------------------------------------------
async function handleRefresh(
	state: PlexusInstanceState,
	ctx: ExtensionCommandContext,
): Promise<void> {
	let apiKey: string | undefined;
	try {
		apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
	} catch (error) {
		ctx.ui.notify(
			`Plexus API key resolution failed: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	if (!apiKey) {
		ctx.ui.notify(
			"No Plexus API key configured. Run /login plexus first.",
			"error",
		);
		return;
	}
	ctx.ui.notify("Refreshing Plexus models…", "info");
	// Scope the refresh to Plexus and bypass pi's freshness checks; the result
	// surfaces per-provider errors and cancellation that a bare refresh() drops.
	const result = await ctx.modelRegistry.refresh({
		providers: [PROVIDER_NAME],
		force: true,
	});
	if (result.aborted) {
		ctx.ui.notify("Plexus model refresh was cancelled.", "warning");
		return;
	}
	const refreshError = result.errors.get(PROVIDER_NAME);
	if (refreshError) {
		ctx.ui.notify(
			`Plexus model refresh failed: ${refreshError.message}`,
			"error",
		);
		return;
	}
	ctx.ui.notify(
		state.models.length > 0
			? `Refreshed ${state.models.length} Plexus models`
			: "Refresh finished but no Plexus models are available. Check the Plexus server and /login plexus.",
		state.models.length > 0 ? "info" : "warning",
	);
}

async function handleStatus(
	state: PlexusInstanceState,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const baseUrl = getBaseUrlResolution();
	const apiKeyEnvName = getApiKeyEnvName();
	const apiKey = await ctx.modelRegistry
		.getApiKeyForProvider(PROVIDER_NAME)
		.catch(() => undefined);
	const explicitApiKey = apiKey ? resolveExplicitApiKey() : undefined;
	ctx.ui.notify(
		[
			`Plexus base URL: ${baseUrl.baseUrl ?? "not configured"} (${baseUrl.source})`,
			`API key: ${
				apiKey
					? explicitApiKey !== undefined
						? `${apiKeyEnvName} (apiKeyEnv)`
						: getEnvApiKey()
							? `host credential or ${apiKeyEnvName} fallback`
							: "host credential"
					: "not configured"
			}`,
			`Catalog: ${state.models.length} models (${state.catalogSource})`,
			"Default model: managed by Pi. Use /model and save the selection there.",
		].join("\n"),
		"info",
	);
}
