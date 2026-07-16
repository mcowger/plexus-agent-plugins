/**
 * plexus-pi — pi (earendil-works/pi-coding-agent) adapter for Plexus model proxy.
 *
 * Auth: API key is stored by pi's credential store (persisted in auth.json).
 *       It may also be pre-seeded via the PLEXUS_API_KEY env var.
 *
 * Model discovery: pi's ModelRuntime drives catalog refreshes through the
 *       provider's refreshModels hook (startup, /login, /model, pi update --models)
 *       and persists catalogs in its own per-provider models-store.json.
 *
 * Commands:
 *   /login plexus   — set base URL and API key using pi's native login UI
 *   /plexus refresh — re-fetch models from the Plexus endpoint
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
	OAuthCredentials,
	OAuthLoginCallbacks,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { adjustBaseUrl, convertDescriptors, fetchPlexusModels } from "../../plexus-models/src/index.ts";
import {
	getBaseUrl,
	getEnvApiKey,
	getModelsUrl,
	saveBaseUrl,
	saveDefaultModel,
} from "./config.ts";
import { writeRawResponse } from "./cache.ts";
import { log } from "./log.ts";
import { descriptorToPiModel } from "./mapper.ts";

const PROVIDER_NAME = "plexus";
const PROVIDER_API_KEY_TEMPLATE = "${PLEXUS_API_KEY}";
const PLEXUS_CREDENTIAL_EXPIRES_AT = 253_402_300_799_000;
const PLACEHOLDER_BASE_URL = "http://localhost/v1";

type PlexusCredentials = OAuthCredentials & { plexusBaseUrl?: string };

// Keep the current model list in module scope so setDefaultModel can reference it.
let currentModels: ProviderModelConfig[] = [];

export default function plexusExtension(pi: ExtensionAPI): void {
	const envApiKey = getEnvApiKey();

	log("startup", { baseUrl: getBaseUrl(), hasEnvApiKey: !!envApiKey });

	pi.registerProvider(PROVIDER_NAME, {
		api: "openai-completions" as Api,
		// Register the env-var template only when the variable is set: pi's
		// credential resolution throws on unresolvable templates during catalog
		// refresh, whereas providers without an apiKey auth are skipped silently.
		...(envApiKey ? { apiKey: PROVIDER_API_KEY_TEMPLATE } : {}),
		authHeader: true,
		baseUrl: getBaseUrl() ?? PLACEHOLDER_BASE_URL,
		refreshModels: refreshPlexusModels,
		oauth: createPlexusLoginProvider(),
	});

	// -------------------------------------------------------------------------
	// /plexus command
	// -------------------------------------------------------------------------
	pi.registerCommand("plexus", {
		description: "Plexus provider commands: refresh, set-default-model (setup: /login plexus)",
		getArgumentCompletions: (prefix) => {
			const subcommands = [
				{ value: "refresh", label: "refresh", description: "Refresh Plexus models from the API" },
				{ value: "set-default-model", label: "set-default-model", description: "Choose the model Pi should use by default" },
			];

			if (!prefix.includes(" ")) {
				return subcommands.filter((command) => command.value.startsWith(prefix));
			}

			const [subcommand, ...rest] = prefix.split(/\s+/);
			if (subcommand !== "set-default-model") return null;

			const modelPrefix = rest.join(" ");
			const choices = currentModels.map((model) => ({
				value: model.id,
				label: model.name === model.id ? model.id : `${model.name} (${model.id})`,
			}));
			const filtered = choices.filter((choice) =>
				choice.value.toLowerCase().startsWith(modelPrefix.toLowerCase()),
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const sub = trimmed.toLowerCase();

			if (sub === "refresh" || sub === "") {
				await handleRefresh(ctx);
				return;
			}

			if (sub === "set-default-model" || sub.startsWith("set-default-model ")) {
				await handleSetDefaultModel(pi, ctx, trimmed.slice("set-default-model".length).trim());
				return;
			}

			ctx.ui.notify(
				`Unknown sub-command: "${args}". Use /login plexus, /plexus refresh, or /plexus set-default-model.`,
				"warning",
			);
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

	if (!context.allowNetwork || !apiKey || !modelsUrl || !baseUrl) {
		const restored = await restoreStoredModels(context);
		if (restored) return restored;
		throw new Error(
			!modelsUrl || !baseUrl
				? "Plexus base URL not configured. Run /login plexus first."
				: "No Plexus API key configured. Run /login plexus first.",
		);
	}

	const { models: apiModels, raw } = await fetchPlexusModels(apiKey, modelsUrl);
	const piModels = convertDescriptors(apiModels, baseUrl).map(descriptorToPiModel);

	await Promise.all([
		context.store.write({ models: piModels, checkedAt: Date.now() }),
		writeRawResponse(raw),
	]);

	currentModels = piModels;
	log("refreshModels: fetched", { count: piModels.length });
	return piModels;
}

async function restoreStoredModels(
	context: RefreshModelsContext,
): Promise<ProviderModelConfig[] | undefined> {
	const stored = await context.store.read();
	if (!stored || stored.models.length === 0) return undefined;
	const models = stored.models as unknown as ProviderModelConfig[];
	currentModels = models;
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
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
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
	// ModelRegistry.refresh() reloads models.json and re-runs every provider's
	// refreshModels hook, including ours.
	await ctx.modelRegistry.refresh();
	ctx.ui.notify(
		currentModels.length > 0
			? `Refreshed ${currentModels.length} Plexus models`
			: "Refresh finished but no Plexus models are available. Check the Plexus server and /login plexus.",
		currentModels.length > 0 ? "info" : "warning",
	);
}

async function handleSetDefaultModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedModelId: string,
): Promise<void> {
	let modelId = requestedModelId;

	if (!modelId) {
		if (currentModels.length === 0) {
			ctx.ui.notify("No Plexus models are available. Run /plexus refresh first.", "warning");
			return;
		}

		const choices = currentModels.map((model) =>
			model.name === model.id ? model.id : `${model.name} (${model.id})`,
		);
		const selected = await ctx.ui.select("Select the Plexus default model:", choices);
		if (!selected) return;

		const selectedIndex = choices.indexOf(selected);
		modelId = currentModels[selectedIndex]?.id ?? "";
	}

	const model = currentModels.find((candidate) => candidate.id === modelId);
	if (!model) {
		ctx.ui.notify(
			`Plexus model not found: "${modelId}". Run /plexus refresh and choose a model from the available list.`,
			"error",
		);
		return;
	}

	await saveDefaultModel(model.id);
	// Apply explicit choices immediately. Session startup never applies this
	// saved value, so it cannot override the model selected for a new session.
	const registryModel = ctx.modelRegistry.find(PROVIDER_NAME, model.id) ?? model;
	// biome-ignore lint/suspicious/noExplicitAny: pi.setModel generic constraint
	const active = await pi.setModel(registryModel as any);
	ctx.ui.notify(
		active
			? `Plexus model selected: ${model.id}.`
			: `Plexus model ${model.id} was saved but could not be selected in this session.`,
		active ? "info" : "warning",
	);
}
