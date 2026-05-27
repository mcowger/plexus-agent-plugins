/**
 * plexus-pi — pi (earendil-works/pi-coding-agent) adapter for Plexus model proxy.
 *
 * Auth: API key is stored by pi's authStorage (persisted in auth.json).
 *       It may also be pre-seeded via the PLEXUS_API_KEY env var.
 *
 * Commands:
 *   /plexus login   — set base URL, API key, and optional default model
 *   /plexus refresh — re-fetch models from the Plexus endpoint
 */

// Type-only — erased at runtime, never resolved by the module loader
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";
import { convertDescriptors, fetchPlexusModels } from "../../plexus-models/src/index.ts";
import { getBaseUrl, getDefaultModel, getModelsUrl, saveBaseUrl } from "./config.ts";
import { readCachedModelsSync, writeCachedModels, writeRawResponse } from "./cache.ts";
import { log } from "./log.ts";
import { descriptorToPiModel } from "./mapper.ts";

const PROVIDER_NAME = "plexus";

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
		apiKey: PROVIDER_NAME,
		authHeader: true,
		baseUrl: startupBaseUrl,
		models: startupModels,
	});
	currentModels = startupModels;

	// -------------------------------------------------------------------------
	// session_start: live-refresh models using the stored API key.
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const apiKey = await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME);
		const baseUrl = getBaseUrl();

		log("session_start", { hasApiKey: !!apiKey, baseUrl });

		if (!apiKey || !baseUrl) {
			log("session_start: no auth configured, skipping refresh");
			await trySetDefaultModel(pi, startupModels);
			return;
		}

		await doRefresh(pi, apiKey, ctx, true);
	});

	// -------------------------------------------------------------------------
	// /plexus command
	// -------------------------------------------------------------------------
	pi.registerCommand("plexus", {
		description: "Plexus provider commands: login, refresh",
		getArgumentCompletions: () => [
			{ value: "login", label: "login", description: "Configure Plexus base URL and API key" },
			{ value: "refresh", label: "refresh", description: "Refresh Plexus models from the API" },
		],
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();

			if (sub === "login" || sub === "") {
				await handleLogin(pi, ctx);
				return;
			}
			if (sub === "refresh") {
				await handleRefresh(pi, ctx);
				return;
			}

			ctx.ui.notify(`Unknown sub-command: "${args}". Use: /plexus login | /plexus refresh`, "warning");
		},
	});
}

// ---------------------------------------------------------------------------
// Login flow — mirrors the original pi-plexus pattern exactly.
// ---------------------------------------------------------------------------
async function handleLogin(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const baseUrlInput = await ctx.ui.input("Plexus base URL", "https://plexus.example.com");
	if (!baseUrlInput) { ctx.ui.notify("Login cancelled.", "info"); return; }

	const apiKeyInput = await ctx.ui.input("Plexus API key");
	if (!apiKeyInput) { ctx.ui.notify("Login cancelled.", "info"); return; }

	const defaultModelInput = await ctx.ui.input("Default model (optional — Enter to skip)", "");
	const defaultModel = defaultModelInput?.trim() || undefined;

	await saveBaseUrl(baseUrlInput.trim(), defaultModel);
	ctx.modelRegistry.authStorage.set(PROVIDER_NAME, { type: "api_key", key: apiKeyInput.trim() });

	log("login: saved", { baseUrl: baseUrlInput.trim(), defaultModel });
	ctx.ui.notify("Plexus credentials saved. Refreshing models…", "info");

	await doRefresh(pi, apiKeyInput.trim(), ctx, false);
}

// ---------------------------------------------------------------------------
// Refresh command handler
// ---------------------------------------------------------------------------
async function handleRefresh(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const apiKey = await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME);
	if (!apiKey) {
		ctx.ui.notify("No Plexus API key configured. Run /plexus login first.", "error");
		return;
	}
	ctx.ui.notify("Refreshing Plexus models…", "info");
	await doRefresh(pi, apiKey, ctx, true);
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
		if (ctx) ctx.ui.notify("Plexus base URL not configured. Run /plexus login first.", "warning");
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
			apiKey: PROVIDER_NAME,
			authHeader: true,
			baseUrl,
			models: piModels,
		});

		log("doRefresh: registered", { count: piModels.length });
		if (ctx) ctx.ui.notify(`Refreshed ${piModels.length} Plexus models`, "info");

		if (setDefault) await trySetDefaultModel(pi, piModels);
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
): Promise<void> {
	const defaultModelId = getDefaultModel();
	if (!defaultModelId) return;

	const model = models.find((m) => m.id === defaultModelId);
	if (!model) {
		log("trySetDefaultModel: model not found", { defaultModelId });
		return;
	}

	// pi.setModel expects a full Model<Api> but descriptorToPiModel returns a
	// plain object with the same shape — cast is safe here.
	// biome-ignore lint/suspicious/noExplicitAny: pi.setModel generic constraint
	const ok = await pi.setModel(model as any);
	log("trySetDefaultModel", { defaultModelId, ok });
}
