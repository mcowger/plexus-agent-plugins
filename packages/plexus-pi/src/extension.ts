/**
 * plexus-pi — pi (earendil-works/pi-coding-agent) adapter for Plexus model proxy.
 *
 * Auth: API key is stored by pi's authStorage (persisted in auth.json).
 *       It may also be pre-seeded via the PLEXUS_API_KEY env var.
 *
 * Commands:
 *   /login plexus   — set base URL and API key using pi's native login UI
 *   /plexus refresh — re-fetch models from the Plexus endpoint
 */

// Type-only — erased at runtime, never resolved by the module loader
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Api, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { adjustBaseUrl, convertDescriptors, fetchPlexusModels } from "../../plexus-models/src/index.ts";
import {
	getBaseUrl,
	getDefaultModel,
	getEnvApiKey,
	getModelsUrl,
	saveBaseUrl,
	saveDefaultModel,
} from "./config.ts";
import { readCachedModelsSync, writeCachedModels, writeRawResponse } from "./cache.ts";
import { log } from "./log.ts";
import { descriptorToPiModel } from "./mapper.ts";

const PROVIDER_NAME = "plexus";
const PROVIDER_API_KEY_TEMPLATE = "${PLEXUS_API_KEY}";
const PLEXUS_CREDENTIAL_EXPIRES_AT = 253_402_300_799_000;

type PlexusCredentials = OAuthCredentials & { plexusBaseUrl?: string };

// Keep the current model list in module scope so setDefaultModel can reference it.
let currentModels: ReturnType<typeof descriptorToPiModel>[] = [];

export default function plexusExtension(pi: ExtensionAPI): void {
	// -------------------------------------------------------------------------
	// Startup: register from cache so the provider is available immediately.
	// We don't have the API key yet (async), so we skip refresh here.
	// -------------------------------------------------------------------------
	const cached = readCachedModelsSync();
	const startupBaseUrl = getBaseUrl() ?? "http://localhost/v1";
	const startupModels = cached?.models.map(descriptorToPiModel) ?? [];

	log("startup", {
		cachedModelCount: startupModels.length,
		startupBaseUrl,
	});

	pi.registerProvider(PROVIDER_NAME, {
		api: "openai-completions" as Api,
		apiKey: PROVIDER_API_KEY_TEMPLATE,
		authHeader: true,
		baseUrl: startupBaseUrl,
		models: startupModels,
		oauth: createPlexusLoginProvider(pi),
	});
	currentModels = startupModels;

	// -------------------------------------------------------------------------
	// session_start: live-refresh models using the stored API key.
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const apiKey = (await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME)) ?? getEnvApiKey();
		const baseUrl = getBaseUrl();

		log("session_start", { hasApiKey: !!apiKey, baseUrl });

		if (!apiKey || !baseUrl) {
			log("session_start: no auth configured, skipping refresh");
			await trySetDefaultModel(pi, startupModels, ctx);
			return;
		}

		await doRefresh(pi, apiKey, ctx, true);
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
				await handleRefresh(pi, ctx);
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

function createPlexusLoginProvider(pi: ExtensionAPI): NonNullable<ProviderConfig["oauth"]> {
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

			await saveBaseUrl(baseUrl);
			callbacks.onProgress?.("Refreshing Plexus models...");
			await doRefresh(pi, apiKey, null, true);

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
async function handleRefresh(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const apiKey = (await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME)) ?? getEnvApiKey();
	if (!apiKey) {
		ctx.ui.notify("No Plexus API key configured. Run /login plexus first.", "error");
		return;
	}
	ctx.ui.notify("Refreshing Plexus models…", "info");
	await doRefresh(pi, apiKey, ctx, true);
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
	// Apply the choice immediately as well as persisting it for future sessions.
	const registryModel = ctx.modelRegistry.find(PROVIDER_NAME, model.id) ?? model;
	// biome-ignore lint/suspicious/noExplicitAny: pi.setModel generic constraint
	const active = await pi.setModel(registryModel as any);
	ctx.ui.notify(
		active
			? `Default Plexus model set to ${model.id}.`
			: `Default Plexus model set to ${model.id}; it will be selected when Plexus authentication is available.`,
		active ? "info" : "warning",
	);
}

// ---------------------------------------------------------------------------
// Core refresh logic
// ---------------------------------------------------------------------------
async function doRefresh(
	pi: ExtensionAPI,
	apiKey: string,
	ctx: ExtensionContext | null,
	setDefault: boolean,
): Promise<void> {
	const modelsUrl = getModelsUrl();
	const baseUrl = getBaseUrl();

	if (!modelsUrl || !baseUrl) {
		if (ctx) ctx.ui.notify("Plexus base URL not configured. Run /login plexus first.", "warning");
		log("doRefresh: no base URL configured");
		return;
	}

	try {
		const { models: apiModels, raw } = await fetchPlexusModels(apiKey, modelsUrl);
		const descriptors = convertDescriptors(apiModels, baseUrl);
		const piModels = descriptors.map(descriptorToPiModel);

		await Promise.all([writeCachedModels(descriptors), writeRawResponse(raw)]);

		currentModels = piModels;
		pi.registerProvider(PROVIDER_NAME, {
			api: "openai-completions" as Api,
			apiKey: PROVIDER_API_KEY_TEMPLATE,
			authHeader: true,
			baseUrl,
			models: piModels,
			oauth: createPlexusLoginProvider(pi),
		});

		log("doRefresh: registered", { count: piModels.length });
		if (ctx) ctx.ui.notify(`Refreshed ${piModels.length} Plexus models`, "info");

		if (setDefault) await trySetDefaultModel(pi, piModels, ctx);
	} catch (error) {
		log("doRefresh: failed", { error: String(error) });
		if (ctx) {
			ctx.ui.notify(
				`Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Set default model
// ---------------------------------------------------------------------------
async function trySetDefaultModel(
	pi: ExtensionAPI,
	models: ReturnType<typeof descriptorToPiModel>[],
	ctx?: ExtensionContext | ExtensionCommandContext | null,
): Promise<void> {
	const defaultModelId = getDefaultModel();
	if (!defaultModelId) return;

	const model = models.find((m) => m.id === defaultModelId);
	if (!model) {
		log("trySetDefaultModel: model not found", { defaultModelId });
		return;
	}

	const registryModel = ctx?.modelRegistry.find(PROVIDER_NAME, defaultModelId) ?? model;
	// biome-ignore lint/suspicious/noExplicitAny: pi.setModel generic constraint
	const ok = await pi.setModel(registryModel as any);
	log("trySetDefaultModel", { defaultModelId, ok });
}
