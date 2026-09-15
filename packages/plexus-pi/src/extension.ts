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
 *   /login plexus   — set base URL and API key using pi's native login UI
 *   /plexus refresh — re-fetch models from the Plexus endpoint
 *   /plexus status  — show effective configuration and catalog state
 */

// Type-only — erased at runtime, never resolved by the module loader
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type {
	Api,
	Credential,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
	adjustBaseUrl,
	convertDescriptors,
	fetchPlexusModels,
	isModelSuppressed,
} from "../../plexus-models/src/index.ts";
import {
	getBaseUrl,
	getBaseUrlResolution,
	getEnvApiKey,
	getModelsUrl,
	getSuppressedModels,
	saveBaseUrl,
} from "./config.ts";
import { readStoredModelsSync } from "./cache.ts";
import { log } from "./log.ts";
import { descriptorToPiModel, MINIMUM_OUTPUT_TOKENS } from "./mapper.ts";
import { normalizeMalformedFunctionCall } from "./gemini-malformed-retry.ts";

const PROVIDER_NAME = "plexus";
const PROVIDER_API_KEY_TEMPLATE = "${PLEXUS_API_KEY}";
const PLEXUS_CREDENTIAL_EXPIRES_AT = 253_402_300_799_000;
const PLACEHOLDER_BASE_URL = "http://localhost/v1";

type PlexusCredentials = OAuthCredentials & { plexusBaseUrl?: string };

let currentModels: ProviderModelConfig[] = [];
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

export default function plexusExtension(pi: ExtensionAPI): void {
	const envApiKey = getEnvApiKey();
	const startupBaseUrl = getBaseUrl();
	const suppressPatterns = getSuppressedModels();

	const storedCatalog = readStoredModelsSync();
	const startupModels = (storedCatalog?.models ?? []).filter(
		(model) => !isModelSuppressed({ id: model.id, name: model.name }, suppressPatterns),
	);

	currentModels = startupModels;
	catalogSource = startupModels.length > 0 ? "host store" : "none";

	pi.on("before_provider_request", (event, ctx) => (
		ctx.model?.provider === PROVIDER_NAME ? enforceMinimumOutputTokens(event.payload) : undefined
	));

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
		// Register the env-var template only when the variable is set: pi's
		// credential resolution throws on unresolvable templates during catalog
		// refresh, whereas providers without an apiKey auth are skipped silently.
		...(envApiKey ? { apiKey: PROVIDER_API_KEY_TEMPLATE } : {}),
		authHeader: true,
		baseUrl: startupBaseUrl ?? PLACEHOLDER_BASE_URL,
		models: startupModels,
		refreshModels: refreshPlexusModels,
		oauth: createPlexusLoginProvider(),
	});

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
	const baseUrl = getBaseUrl();
	const modelsUrl = getModelsUrl();
	const apiKey = credentialApiKey(context.credential) ?? getEnvApiKey() ?? undefined;
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
				},
			});
			return filteredCurrent;
		}
		const restored = await restoreStoredModels(context);
		if (restored) return restored;
		throw new Error(
			!modelsUrl || !baseUrl
				? "Plexus base URL not configured. Run /login plexus first."
				: "No Plexus API key configured. Run /login plexus first.",
		);
	}

	try {
		const { models: apiModels } = await fetchPlexusModels(apiKey, modelsUrl, undefined, undefined, context.signal);

		const descriptors = convertDescriptors(apiModels, baseUrl, suppress);
		const piModels = descriptors.map(descriptorToPiModel);

		// pi publishes the returned list in memory but does not persist it —
		// persistence is provider-owned via generation-checked publish().
		const published = await context.publish({
			persist: { models: piModels as unknown as Model<Api>[], checkedAt: Date.now() },
			update: () => {
				currentModels = piModels;
				catalogSource = "live refresh";
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
		},
	});
	log("refreshModels: restored from store", { count: models.length });
	return models;
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
			return String(credentials.access || credentials.refresh || "");
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
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
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
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
	ctx.ui.notify([
		`Plexus base URL: ${baseUrl.baseUrl ?? "not configured"} (${baseUrl.source})`,
		`API key: ${apiKey ? (getEnvApiKey() ? "host credential or PLEXUS_API_KEY fallback" : "host credential") : "not configured"}`,
		`Catalog: ${currentModels.length} models (${catalogSource})`,
		"Default model: managed by Pi. Use /model and save the selection there.",
	].join("\n"), "info");
}
