/**
 * plexus-oh-my-pi — Oh My Pi (can1357/oh-my-pi) adapter for the Plexus model proxy.
 *
 * Oh My Pi is a fork of pi (earendil-works/pi-coding-agent) and ships a
 * compatibility shim for legacy pi extensions, but its extension surface has
 * diverged in ways that matter here:
 *   - Runtime packages are published as @oh-my-pi/pi-coding-agent /
 *     @oh-my-pi/pi-ai instead of @earendil-works/*.
 *   - The package.json extension manifest field is `omp` (with `pi` only
 *     honored as a legacy fallback).
 *   - The built-in model registry moved to a dedicated @oh-my-pi/pi-catalog
 *     package (getBundledModel) instead of @earendil-works/pi-ai/compat
 *     (getModel).
 *   - Per-model `thinkingLevelMap` was replaced by a structured `thinking`
 *     config (see mapper.ts).
 * This package is intentionally separate from plexus-pi so each adapter can
 * track its own host's API without one host's fork drifting the other.
 *
 * Auth: API key is stored by Oh My Pi's authStorage (persisted in agent.db).
 *       It may also be pre-seeded via the PLEXUS_API_KEY env var.
 *
 * Commands:
 *   /login plexus   — set base URL and API key using Oh My Pi's native login UI
 *   /plexus refresh — re-fetch models from the Plexus endpoint
 *   /plexus status  — show effective configuration and catalog state
 */

// Type-only — erased at runtime, never resolved by the module loader
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { Api, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { convertDescriptors, fetchPlexusModels } from "../../plexus-models/src/index.ts";
import {
	ENV_API_KEY,
	getBaseUrl,
	getBaseUrlResolution,
	getEnvApiKey,
	getModelsUrl,
	getSuppressedModels,
	saveBaseUrl,
} from "./config.ts";
import { log } from "./log.ts";
import { descriptorToOhMyPiModel } from "./mapper.ts";
import { normalizeProviderConnectionClosed } from "./provider-connection-retry.ts";

const PROVIDER_NAME = "plexus";
export function getProviderApiKeyConfig(): Pick<ProviderConfig, "apiKey" | "authHeader"> {
	// OMP resolves provider env references through Bun.env and treats an
	// unknown name as a literal key. Check the same source before registering it.
	return Bun.env[ENV_API_KEY]?.trim() ? { apiKey: ENV_API_KEY, authHeader: true } : {};
}
let currentModels: ReturnType<typeof descriptorToOhMyPiModel>[] = [];
let catalogSource: "live refresh" | "none" = "none";

export default function plexusExtension(pi: ExtensionAPI): void {
	// -------------------------------------------------------------------------
	// Startup: OMP owns model-cache persistence. This extension only registers
	// the provider and refreshes the dynamic Plexus catalog when auth is ready.
	// -------------------------------------------------------------------------
	const startupBaseUrl = getBaseUrl();

	log("startup", { catalogSource, startupBaseUrl });

	pi.registerProvider(PROVIDER_NAME, {
		api: "openai-completions" as Api,
		...getProviderApiKeyConfig(),
		...(startupBaseUrl ? { baseUrl: startupBaseUrl } : {}),
		oauth: createPlexusLoginProvider(pi),
	});

	// Retag the Plexus proxy's otherwise-unclassified closed-connection error so
	// OMP's native turn recovery retries it using its configured retry budget.
	pi.on("message_end", (event) => {
		normalizeProviderConnectionClosed(event.message, PROVIDER_NAME);
	});

	// -------------------------------------------------------------------------
	// session_start: live-refresh models using the stored API key.
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const apiKey = (await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME)) ?? getEnvApiKey();
		const baseUrl = getBaseUrl();

		log("session_start", { hasApiKey: !!apiKey, baseUrl });

		if (!apiKey || !baseUrl) {
			log("session_start: no auth configured, skipping refresh");
			return;
		}

		await doRefresh(pi, apiKey, ctx);
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
			if (sub === "refresh" || sub === "") return handleRefresh(pi, ctx);
			if (sub === "status") return handleStatus(ctx);
			ctx.ui.notify(`Unknown sub-command: "${args}". Use /login plexus, /plexus refresh, or /plexus status.`, "warning");
		},
	});
}

function createPlexusLoginProvider(pi: ExtensionAPI): NonNullable<ProviderConfig["oauth"]> {
	return {
		name: "Plexus",
		async login(callbacks: OAuthLoginCallbacks): Promise<string> {
			const baseUrl = (await callbacks.onPrompt({
				message: "Plexus base URL",
				placeholder: "https://plexus.example.com",
			})).trim();
			if (!baseUrl) throw new Error("Plexus base URL is required.");

			const apiKey = (await callbacks.onPrompt({ message: "Plexus API key" })).trim();
			if (!apiKey) throw new Error("Plexus API key is required.");

			await saveBaseUrl(baseUrl);
			callbacks.onProgress?.("Refreshing Plexus models...");
			await doRefresh(pi, apiKey, null);

			return apiKey;
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
	await doRefresh(pi, apiKey, ctx);
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
	const baseUrl = getBaseUrlResolution();
	const apiKey = await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME);
	ctx.ui.notify([
		`Plexus base URL: ${baseUrl.baseUrl ?? "not configured"} (${baseUrl.source})`,
		`API key: ${apiKey ? (getEnvApiKey() ? "host credential or PLEXUS_API_KEY fallback" : "host credential") : "not configured"}`,
		`Catalog: ${currentModels.length} models (${catalogSource})`,
		"Default model: managed by OMP. Use /model or /models to save the selection there.",
	].join("\n"), "info");
}

// ---------------------------------------------------------------------------
// Core refresh logic
// ---------------------------------------------------------------------------
async function doRefresh(
	pi: ExtensionAPI,
	apiKey: string,
	ctx: ExtensionContext | null,
): Promise<void> {
	const modelsUrl = getModelsUrl();
	const baseUrl = getBaseUrl();

	if (!modelsUrl || !baseUrl) {
		if (ctx) ctx.ui.notify("Plexus base URL not configured. Run /login plexus first.", "warning");
		log("doRefresh: no base URL configured");
		return;
	}

	try {
		const { models: apiModels } = await fetchPlexusModels(apiKey, modelsUrl);

		const suppressPatterns = getSuppressedModels();
		const descriptors = convertDescriptors(apiModels, baseUrl, suppressPatterns);
		const ohMyPiModels = descriptors.map(descriptorToOhMyPiModel);

		currentModels = ohMyPiModels;
		catalogSource = "live refresh";
		pi.registerProvider(PROVIDER_NAME, {
			api: "openai-completions" as Api,
			...getProviderApiKeyConfig(),
			baseUrl,
			models: ohMyPiModels,
			oauth: createPlexusLoginProvider(pi),
		});

		log("doRefresh: registered", { count: ohMyPiModels.length });
		if (ctx) ctx.ui.notify(`Refreshed ${ohMyPiModels.length} Plexus models`, "info");
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
