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
 *       It may also be pre-seeded via the PLEXUS_API_KEY env var, or an
 *       explicitly configured `apiKeyEnv` name (see config.ts).
 *
 * Commands:
 *   /login plexus   — set base URL and API key using Oh My Pi's native login UI
 *   /plexus refresh — re-fetch models from the Plexus endpoint
 *   /plexus status  — show effective configuration and catalog state
 */

// Type-only — erased at runtime, never resolved by the module loader
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { Api, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { convertDescriptors, fetchPlexusModels } from "../../plexus-models/src/index.ts";
import {
	getApiKeyEnvName,
	getBaseUrl,
	getBaseUrlResolution,
	getEnvApiKey,
	getModelsUrl,
	getSuppressedModels,
	resolveApiKey,
	resolveExplicitApiKey,
	saveBaseUrl,
} from "./config.ts";
import { log } from "./log.ts";
import { descriptorToOhMyPiModel } from "./mapper.ts";
import { normalizeProviderConnectionClosed } from "./provider-connection-retry.ts";

const PROVIDER_NAME = "plexus";
export function getProviderApiKeyConfig(): Pick<ProviderConfig, "apiKey" | "authHeader"> {
	// An explicit apiKeyEnv is authoritative and throws when its variable is
	// missing or empty; the default PLEXUS_API_KEY remains an optional fallback.
	// OMP resolves provider env references through Bun.env and treats an unknown
	// name as a literal key, so only register a name that actually resolves.
	const explicitApiKey = resolveExplicitApiKey();
	const envName = getApiKeyEnvName();
	const envValue = explicitApiKey ?? getEnvApiKey();
	return envValue ? { apiKey: envName, authHeader: true } : {};
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
		fetchDynamicModels: fetchPlexusModelConfigs,
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
		let apiKey: string | null;
		try {
			apiKey = resolveApiKey(await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log("session_start: api key resolution failed", { error: message });
			ctx.ui.notify(message, "error");
			return;
		}
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
	let apiKey: string | null;
	try {
		apiKey = resolveApiKey(await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME));
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
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
		`API key: ${describeApiKey(apiKey)}`,
		`Catalog: ${currentModels.length} models (${catalogSource})`,
		"Default model: managed by OMP. Use /model or /models to save the selection there.",
	].join("\n"), "info");
}

function describeApiKey(savedApiKey: string | undefined): string {
	try {
		const envName = getApiKeyEnvName();
		if (resolveExplicitApiKey() !== undefined) return `${envName} (apiKeyEnv)`;
		if (getEnvApiKey()) return `${envName} (overrides host credential)`;
		return savedApiKey ? "host credential" : "not configured";
	} catch (error) {
		return `invalid apiKeyEnv configuration (${error instanceof Error ? error.message : String(error)})`;
	}
}

// ---------------------------------------------------------------------------
// Core refresh logic
// ---------------------------------------------------------------------------
async function fetchPlexusModelConfigs(
	apiKey: string | undefined,
): Promise<readonly ProviderModelConfig[]> {
	const key = resolveApiKey(apiKey);
	const modelsUrl = getModelsUrl();
	const baseUrl = getBaseUrl();
	if (!key || !modelsUrl || !baseUrl) return [];
	const { models: apiModels } = await fetchPlexusModels(key, modelsUrl);
	const descriptors = convertDescriptors(apiModels, baseUrl, getSuppressedModels());
	const models = descriptors.map(descriptorToOhMyPiModel);
	currentModels = [...models];
	catalogSource = "live refresh";
	return models;
}

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
		const resolvedApiKey = resolveApiKey(apiKey);
		if (!resolvedApiKey) {
			if (ctx) ctx.ui.notify("No Plexus API key configured. Run /login plexus first.", "warning");
			log("doRefresh: no API key configured");
			return;
		}
		const { models: apiModels } = await fetchPlexusModels(resolvedApiKey, modelsUrl);

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
			fetchDynamicModels: fetchPlexusModelConfigs,
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
