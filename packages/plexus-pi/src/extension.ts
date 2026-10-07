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

// Type-only — erased at runtime, never resolved by the module loader
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ModelRegistry,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type {
	Api,
	Credential,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	Provider,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
	adjustBaseUrl,
	convertDescriptors,
	fetchPlexusModels,
	isModelSuppressed,
	type PlexusApiModel,
} from "../../plexus-models/src/index.ts";
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
import { readStoredModelsSync } from "./cache.ts";
import { log } from "./log.ts";
import { descriptorToPiModel, MINIMUM_OUTPUT_TOKENS } from "./mapper.ts";
import { normalizeMalformedFunctionCall } from "./gemini-malformed-retry.ts";
import { ContextPolicyPublisher, CONTEXT_POLICY_METADATA_UNAVAILABLE_REASON, type ContextPolicy } from "./context-policy.ts";
import {
	ServiceTiersPublisher,
	SERVICE_TIERS_METADATA_UNAVAILABLE_REASON,
	ServiceTierPolicySchema,
	type ServiceTierPolicy,
} from "./service-tiers.ts";
import {
	injectServiceTier,
	PolicyController,
	type PolicyAdvertisement,
	type PolicyHost,
} from "./policy.ts";
import { ModelsControl } from "./models-control.ts";

const PROVIDER_NAME = "plexus";
const PLEXUS_CREDENTIAL_EXPIRES_AT = 253_402_300_799_000;
const PLACEHOLDER_BASE_URL = "http://localhost/v1";

type PlexusCredentials = OAuthCredentials & { plexusBaseUrl?: string };

let currentModels: ProviderModelConfig[] = [];
let activeContextPolicies: ContextPolicyPublisher | undefined;
let activeServiceTiers: ServiceTiersPublisher | undefined;
let activePolicy: PolicyController | undefined;
let activePolicyModel: Model<any> | undefined;
let policyModelRegistry: ModelRegistry | undefined;
let refreshSequence = 0;
type StoredContextPolicyMetadata = { policy: ContextPolicy; fetchedAt: number };
type ContextPolicyBearingModel = ProviderModelConfig & { plexusContextPolicy?: StoredContextPolicyMetadata };
type StoredServiceTiersMetadata = { policy?: ServiceTierPolicy; fetchedAt: number };
type ServiceTierBearingModel = ProviderModelConfig & { plexusServiceTiers?: StoredServiceTiersMetadata };
let catalogSource: "host store" | "live refresh" | "none" = "none";

export function enforceMinimumOutputTokens(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

	const next = { ...(payload as Record<string, unknown>) };
	let changed = false;
	for (const field of ["max_completion_tokens", "max_tokens", "max_output_tokens"] as const) {
		const value = next[field];
		if (typeof value === "number" && Number.isFinite(value) && value < MINIMUM_OUTPUT_TOKENS) {
			next[field] = MINIMUM_OUTPUT_TOKENS;
			changed = true;
		}
	}

	const generationConfig = next["generationConfig"];
	if (generationConfig && typeof generationConfig === "object" && !Array.isArray(generationConfig)) {
		const maxOutputTokens = (generationConfig as Record<string, unknown>)["maxOutputTokens"];
		if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens < MINIMUM_OUTPUT_TOKENS) {
			next["generationConfig"] = {
				...(generationConfig as Record<string, unknown>),
				maxOutputTokens: MINIMUM_OUTPUT_TOKENS,
			};
			changed = true;
		}
	}

	return changed ? next : payload;
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
	getHeaderModels: () => ReadonlyArray<HeaderBearingModel> = () => currentModels,
): Provider {
	const apiKey = provider.auth.apiKey;
	if (!apiKey) return provider;

	const withModelHeaders = <TModel extends HeaderBearingModel>(models: readonly TModel[]): TModel[] => {
		const headersById = new Map<string, Record<string, string>>();
		for (const model of getHeaderModels()) {
			if (model.headers) headersById.set(model.id, model.headers);
		}
		if (headersById.size === 0) return [...models];
		return models.map((model) => {
			const headers = headersById.get(model.id);
			return headers ? { ...model, headers: { ...model.headers, ...headers } } : model;
		});
	};

	return {
		...provider,
		auth: {
			...provider.auth,
			apiKey: {
				...apiKey,
				resolve: async (input) => {
					const explicit = await resolveExplicitApiKeyFromEnv((name) => input.ctx.env(name));
					if (explicit === undefined) return apiKey.resolve(input);
					const result = await apiKey.resolve({
						...input,
						credential: {
							type: "api_key",
							key: explicit,
							...(input.credential?.env ? { env: input.credential.env } : {}),
						},
					});
					return result ? { ...result, source: `${envName} (apiKeyEnv)` } : result;
				},
			},
		},
		getModels: () => withModelHeaders(provider.getModels()),
		getAllModels: () => withModelHeaders(provider.getAllModels?.() ?? provider.getModels()),
	};
}

/**
 * Host adapter for the session-scoped policy controller. The controller is
 * driven from the event bus, so the active model is cached from event handlers
 * and the catalog advertisement is read from the committed model metadata.
 */
export function createPolicyHost(deps: {
	getActiveModel: () => Model<any> | undefined;
	getModels: () => readonly ProviderModelConfig[];
	getRegistry: () => ModelRegistry | undefined;
	setModel: (model: Model<any>) => Promise<boolean>;
	setActiveModel: (model: Model<any>) => void;
}): PolicyHost {
	return {
		getActiveModel() {
			const model = deps.getActiveModel();
			if (!model || model.provider !== PROVIDER_NAME) return undefined;
			return { provider: model.provider, id: model.id };
		},
		getAdvertisement(model) {
			const entry = deps.getModels().find((candidate) => candidate.id === model.id);
			if (!entry) return undefined;
			const context = (entry as ContextPolicyBearingModel).plexusContextPolicy?.policy;
			const serviceTier = (entry as ServiceTierBearingModel).plexusServiceTiers?.policy;
			if (!context && !serviceTier) return undefined;
			return {
				...(context ? { context } : {}),
				...(serviceTier ? { serviceTier } : {}),
			} satisfies PolicyAdvertisement;
		},
		getEffectiveContextWindow() {
			return deps.getActiveModel()?.contextWindow;
		},
		async applyContextWindow(model, contextWindow) {
			const registry = deps.getRegistry();
			if (!registry) return undefined;
			const canonical = registry.find(model.provider, model.id);
			if (!canonical) return undefined;
			const target = (contextWindow === undefined ? canonical : { ...canonical, contextWindow }) as Model<any>;
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
	const contextPolicies = new ContextPolicyPublisher(pi.events);
	activeContextPolicies = contextPolicies;
	const serviceTiers = new ServiceTiersPublisher(pi.events);
	activeServiceTiers = serviceTiers;
	const policy = new PolicyController(
		pi.events,
		createPolicyHost({
			getActiveModel: () => activePolicyModel,
			getModels: () => currentModels,
			getRegistry: () => policyModelRegistry,
			setModel: (model) => pi.setModel(model),
			setActiveModel: (model) => {
				activePolicyModel = model;
			},
		}),
	);
	activePolicy = policy;
	const modelsControl = new ModelsControl(pi.events, {
		refresh: async () => {
			const registry = policyModelRegistry;
			if (!registry) throw new Error("Plexus model registry is unavailable before the session starts.");
			const result = await registry.refresh({ providers: [PROVIDER_NAME], force: true });
			if (result.aborted) throw new Error("Plexus model refresh was cancelled.");
			const refreshError = result.errors.get(PROVIDER_NAME);
			if (refreshError) throw refreshError;
			return { modelCount: currentModels.length };
		},
	});
	pi.on("session_shutdown", () => {
		contextPolicies.dispose();
		serviceTiers.dispose();
		policy.dispose();
		modelsControl.dispose();
		if (activeContextPolicies === contextPolicies) activeContextPolicies = undefined;
		if (activeServiceTiers === serviceTiers) activeServiceTiers = undefined;
		if (activePolicy === policy) activePolicy = undefined;
	});

	// An explicit apiKeyEnv is authoritative and throws when its variable is
	// missing or empty; the default PLEXUS_API_KEY remains an optional fallback.
	const apiKeyEnvExplicit = isApiKeyEnvExplicit();
	const explicitApiKey = apiKeyEnvExplicit ? resolveExplicitApiKey() : undefined;
	const apiKeyEnvName = getApiKeyEnvName();
	const envApiKey = explicitApiKey ?? getEnvApiKey();
	const startupBaseUrl = getBaseUrl();
	const suppressPatterns = getSuppressedModels();

	const storedCatalog = readStoredModelsSync();
	const startupModels = (storedCatalog?.models ?? []).filter(
		(model) => !isModelSuppressed({ id: model.id, name: model.name }, suppressPatterns),
	);

	currentModels = startupModels;
	catalogSource = startupModels.length > 0 ? "host store" : "none";
	const startupPolicies = collectStoredContextPolicies(startupModels);
	contextPolicies.setCatalog(
		startupPolicies.length > 0 ? "ready" : "unavailable",
		startupPolicies.map((entry) => entry.policy),
		startupPolicies.length > 0
			? { cached: true, fetchedAt: startupPolicies[0]!.fetchedAt }
			: { cached: true, reason: CONTEXT_POLICY_METADATA_UNAVAILABLE_REASON },
	);
	if (storedCatalog) {
		const cachedTiers = collectStoredServiceTiers(startupModels);
		serviceTiers.setCatalog(
			cachedTiers.complete ? "ready" : "unavailable",
			cachedTiers.policies,
			cachedTiers.complete
				? { cached: true, ...(cachedTiers.fetchedAt === undefined ? {} : { fetchedAt: cachedTiers.fetchedAt }) }
				: { cached: true, reason: SERVICE_TIERS_METADATA_UNAVAILABLE_REASON },
		);
	}
	void policy.reconcile();

	// Track the active model so the event-bus policy controller can resolve the
	// advertisement and apply a session-scoped context window without an
	// ExtensionContext.
	pi.on("session_start", (_event, ctx) => {
		policyModelRegistry = ctx.modelRegistry;
		activePolicyModel = ctx.model;
		void activePolicy?.reconcile();
	});
	pi.on("model_select", (event, ctx) => {
		policyModelRegistry = ctx.modelRegistry;
		activePolicyModel = event.model;
		void activePolicy?.reconcile();
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_NAME) return undefined;
		activePolicyModel = ctx.model;
		const withTier = injectServiceTier(event.payload, activePolicy?.serviceTierFor(ctx.model));
		const next = enforceMinimumOutputTokens(withTier);
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
	pi.on("message_end", (event) => normalizeMalformedFunctionCall(event.message, PROVIDER_NAME));

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
		refreshModels: refreshPlexusModels,
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
				throw new Error("Plexus apiKeyEnv override failed: provider API-key auth is unavailable");
			}
			pi.registerProvider(withAuthoritativeApiKeyEnv(composed, apiKeyEnvName));
			authOverrideApplied = true;
			log("auth: applied authoritative apiKeyEnv override", { apiKeyEnv: apiKeyEnvName });
		});
	}

	// -------------------------------------------------------------------------
	// /plexus command
	// -------------------------------------------------------------------------
	pi.registerCommand("plexus", {
		description: "Plexus provider commands: refresh, status (setup: /login plexus)",
		getArgumentCompletions: (prefix) => {
			const subcommands = [
				{ value: "refresh", label: "refresh", description: "Refresh Plexus models from the API" },
				{ value: "status", label: "status", description: "Show Plexus configuration and catalog status" },
			];
			return prefix.includes(" ") ? null : subcommands.filter((command) => command.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "refresh" || sub === "") return handleRefresh(ctx);
			if (sub === "status") return handleStatus(ctx);
			ctx.ui.notify(`Unknown sub-command: "${args}". Use /login plexus, /plexus refresh, or /plexus status.`, "warning");
		},
	});

}

// ---------------------------------------------------------------------------
// Catalog refresh (driven by pi's ModelRuntime)
// ---------------------------------------------------------------------------
async function refreshPlexusModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
	const refreshId = ++refreshSequence;
	const baseUrl = getBaseUrl();
	const modelsUrl = getModelsUrl();
	const apiKey = resolveApiKey(credentialApiKey(context.credential));
	const suppress = getSuppressedModels();

	if (!context.allowNetwork || !apiKey || !modelsUrl || !baseUrl) {
		// Prefer models fetched earlier this session; they are always at least
		// as fresh as the store. Persist them for future offline sessions.
		if (currentModels.length > 0) {
			const filteredCurrent = currentModels.filter(
				(m) => !isModelSuppressed({ id: m.id, name: m.name }, suppress),
			);
			await context.publish({
				persist: { models: filteredCurrent as unknown as Model<Api>[], checkedAt: Date.now() },
				update: () => {
					currentModels = filteredCurrent;
					const cachedTiers = collectStoredServiceTiers(filteredCurrent);
					activeServiceTiers?.setCatalog(
						cachedTiers.complete ? "ready" : "unavailable",
						cachedTiers.policies,
						cachedTiers.complete
							? { cached: true, ...(cachedTiers.fetchedAt === undefined ? {} : { fetchedAt: cachedTiers.fetchedAt }) }
							: { cached: true, reason: SERVICE_TIERS_METADATA_UNAVAILABLE_REASON },
					);
					const cachedPolicies = collectStoredContextPolicies(filteredCurrent);
					activeContextPolicies?.setCatalog(
						cachedPolicies.length > 0 ? "ready" : "unavailable",
						cachedPolicies.map((entry) => entry.policy),
						cachedPolicies.length > 0
							? { cached: true, fetchedAt: cachedPolicies[0]!.fetchedAt }
							: { cached: true, reason: CONTEXT_POLICY_METADATA_UNAVAILABLE_REASON },
					);
					void activePolicy?.reconcile();
				},
			});
			return filteredCurrent;
		}
		const restored = await restoreStoredModels(context);
		if (restored) return restored;
		if (refreshId === refreshSequence && activeServiceTiers?.getSnapshot().status === "loading") {
			activeServiceTiers.setCatalog("unavailable", [], { reason: "Plexus model metadata is not configured." });
		}
		throw new Error(
			!modelsUrl || !baseUrl
				? "Plexus base URL not configured. Run /login plexus first."
				: "No Plexus API key configured. Run /login plexus first.",
		);
	}

	try {
		const { models: apiModels } = await fetchPlexusModels(apiKey, modelsUrl, undefined, undefined, context.signal);
		const fetchedAt = Date.now();

		const descriptors = convertDescriptors(apiModels, baseUrl, suppress);
		const piModels = descriptors.map(descriptorToPiModel) as Array<ContextPolicyBearingModel & ServiceTierBearingModel>;
		const eligibleIds = new Set(piModels.map((model) => model.id));
		for (const model of apiModels) {
			if (!eligibleIds.has(model.id)) continue;
			const piModel = piModels.find((candidate) => candidate.id === model.id);
			if (!piModel) continue;
			const policy = contextPolicyFromApiModel(model);
			if (policy) piModel.plexusContextPolicy = { policy, fetchedAt };
			piModel.plexusServiceTiers = { policy: serviceTierPolicyFromApiModel(model), fetchedAt };
		}
		const committedPolicies = collectStoredContextPolicies(piModels);
		const committedServiceTiers = collectStoredServiceTiers(piModels).policies;

		// pi publishes the returned list in memory but does not persist it —
		// persistence is provider-owned via generation-checked publish().
		const published = await context.publish({
			persist: { models: piModels as unknown as Model<Api>[], checkedAt: Date.now() },
			update: () => {
				currentModels = piModels;
				catalogSource = "live refresh";
				activeServiceTiers?.setCatalog("ready", committedServiceTiers, { fetchedAt });
				activeContextPolicies?.setCatalog(
					committedPolicies.length > 0 ? "ready" : "unavailable",
					committedPolicies.map((entry) => entry.policy),
					committedPolicies.length > 0
						? { fetchedAt }
						: { fetchedAt, reason: CONTEXT_POLICY_METADATA_UNAVAILABLE_REASON },
				);
				void activePolicy?.reconcile();
			},
		});
		if (!published) {
			log("refreshModels: publication superseded by a newer refresh", {});
		}

		log("refreshModels: fetched", { count: piModels.length });
		return piModels;
	} catch (error) {
		if (refreshId === refreshSequence && activeContextPolicies?.getSnapshot().status === "loading") {
			activeContextPolicies.setCatalog("unavailable", [], { reason: "Plexus model metadata could not be loaded." });
		}
		if (refreshId === refreshSequence && activeServiceTiers?.getSnapshot().status === "loading") {
			activeServiceTiers.setCatalog("unavailable", [], { reason: "Plexus model metadata could not be loaded." });
		}
		log("refreshModels: fetch failed", { error: String(error) });
		throw error;
	}
}

async function restoreStoredModels(
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
			currentModels = models;
			catalogSource = "host store";
			const cachedTiers = collectStoredServiceTiers(models);
			activeServiceTiers?.setCatalog(
				cachedTiers.complete ? "ready" : "unavailable",
				cachedTiers.policies,
				cachedTiers.complete
					? { cached: true, ...(cachedTiers.fetchedAt === undefined ? {} : { fetchedAt: cachedTiers.fetchedAt }) }
					: { cached: true, reason: SERVICE_TIERS_METADATA_UNAVAILABLE_REASON },
			);
			const cachedPolicies = collectStoredContextPolicies(models);
			activeContextPolicies?.setCatalog(
				cachedPolicies.length > 0 ? "ready" : "unavailable",
				cachedPolicies.map((entry) => entry.policy),
				cachedPolicies.length > 0
					? { cached: true, fetchedAt: cachedPolicies[0]!.fetchedAt }
					: { cached: true, reason: CONTEXT_POLICY_METADATA_UNAVAILABLE_REASON },
			);
			void activePolicy?.reconcile();
		},
	});
	log("refreshModels: restored from store", { count: models.length });
	return models;
}

export function contextPolicyFromApiModel(model: PlexusApiModel): ContextPolicy | undefined {
	const maxContextTokens = model.context_length;
	const pricingThresholdInputTokens = model.pricing?.tiers?.[0]?.input_tokens_above;
	if (
		!Number.isSafeInteger(maxContextTokens) || maxContextTokens! <= 0 ||
		!Number.isSafeInteger(pricingThresholdInputTokens) || pricingThresholdInputTokens! <= 0 ||
		pricingThresholdInputTokens! > maxContextTokens!
	) return undefined;
	return {
		provider: PROVIDER_NAME,
		modelId: model.id,
		maxContextTokens: maxContextTokens!,
		shortContextBudgetTokens: pricingThresholdInputTokens!,
		pricingThresholdInputTokens: pricingThresholdInputTokens!,
	};
}

function collectStoredContextPolicies(models: readonly ProviderModelConfig[]): StoredContextPolicyMetadata[] {
	return models.flatMap((model) => {
		const metadata = (model as ContextPolicyBearingModel).plexusContextPolicy;
		return metadata ? [metadata] : [];
	});
}

export function serviceTierPolicyFromApiModel(model: PlexusApiModel): ServiceTierPolicy | undefined {
	const serviceTiers = (model as PlexusApiModel & { service_tiers?: unknown }).service_tiers;
	if (!Array.isArray(serviceTiers) || serviceTiers.length === 0) return undefined;
	const candidate = { provider: PROVIDER_NAME, modelId: model.id, serviceTiers };
	const parsed = ServiceTierPolicySchema.safeParse(candidate);
	return parsed.success ? parsed.data : undefined;
}

function collectStoredServiceTiers(models: readonly ProviderModelConfig[]): {
	policies: ServiceTierPolicy[];
	complete: boolean;
	fetchedAt?: number;
} {
	const metadata = models.map((model) => (model as ServiceTierBearingModel).plexusServiceTiers);
	const complete = models.length === 0 || metadata.every((entry) => entry !== undefined);
	const stored = metadata.filter((entry): entry is StoredServiceTiersMetadata => entry !== undefined);
	return {
		policies: stored.flatMap((entry) => entry.policy ? [entry.policy] : []),
		complete,
		...(stored[0] ? { fetchedAt: stored[0].fetchedAt } : {}),
	};
}

function credentialApiKey(credential: Credential | undefined): string | undefined {
	if (!credential) return undefined;
	if (credential.type === "api_key") return credential.key || undefined;
	return String(credential.access || credential.refresh || "") || undefined;
}

function createPlexusLoginProvider(): NonNullable<ProviderConfig["oauth"]> {
	return {
		name: "Plexus",
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const baseUrl = (await callbacks.onPrompt({
				message: "Plexus base URL",
				placeholder: "https://plexus.example.com",
			})).trim();
			if (!baseUrl) throw new Error("Plexus base URL is required.");

			const apiKey = (await callbacks.onPrompt({ message: "Plexus API key" })).trim();
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
		async refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
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
			return models.map((model) => (
				model.provider === PROVIDER_NAME
					? { ...model, baseUrl: adjustBaseUrl(apiBase, model.api) }
					: model
			));
		},
	};
}

// ---------------------------------------------------------------------------
// Refresh command handler
// ---------------------------------------------------------------------------
async function handleRefresh(ctx: ExtensionCommandContext): Promise<void> {
	let apiKey: string | undefined;
	try {
		apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
	} catch (error) {
		ctx.ui.notify(`Plexus API key resolution failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	if (!apiKey) {
		ctx.ui.notify("No Plexus API key configured. Run /login plexus first.", "error");
		return;
	}
	ctx.ui.notify("Refreshing Plexus models…", "info");
	// Scope the refresh to Plexus and bypass pi's freshness checks; the result
	// surfaces per-provider errors and cancellation that a bare refresh() drops.
	const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_NAME], force: true });
	if (result.aborted) {
		ctx.ui.notify("Plexus model refresh was cancelled.", "warning");
		return;
	}
	const refreshError = result.errors.get(PROVIDER_NAME);
	if (refreshError) {
		ctx.ui.notify(`Plexus model refresh failed: ${refreshError.message}`, "error");
		return;
	}
	ctx.ui.notify(
		currentModels.length > 0
			? `Refreshed ${currentModels.length} Plexus models`
			: "Refresh finished but no Plexus models are available. Check the Plexus server and /login plexus.",
		currentModels.length > 0 ? "info" : "warning",
	);
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
	const baseUrl = getBaseUrlResolution();
	const apiKeyEnvName = getApiKeyEnvName();
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME).catch(() => undefined);
	const explicitApiKey = apiKey ? resolveExplicitApiKey() : undefined;
	ctx.ui.notify([
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
		`Catalog: ${currentModels.length} models (${catalogSource})`,
		"Default model: managed by Pi. Use /model and save the selection there.",
	].join("\n"), "info");
}
