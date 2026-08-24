/**
 * plexus-oh-my-pi — Oh My Pi (can1357/oh-my-pi) adapter for the Plexus model proxy.
 *
 * Oh My Pi is a fork of pi and ships a compatibility shim for legacy pi
 * extensions, but its native provider API is intentionally used here. OMP 18's
 * fetchDynamicModels hook owns asynchronous discovery and persists results in
 * its SQLite model cache, keeping startup off the network path.
 */

// Type-only — erased at runtime, never resolved by the module loader
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderConfig,
} from "@oh-my-pi/pi-coding-agent";
import type { Api, Model, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { convertDescriptors, fetchPlexusModels, isModelSuppressed } from "../../plexus-models/src/index.ts";
import {
	ENV_API_KEY,
	getBaseUrl,
	getEnvApiKey,
	getModelsUrl,
	getSuppressedModels,
	saveBaseUrl,
	saveDefaultModel,
} from "./config.ts";
import { readCachedModelsSync, writeCachedModels, writeRawResponse } from "./cache.ts";
import { log } from "./log.ts";
import { descriptorToOhMyPiModel } from "./mapper.ts";

const PROVIDER_NAME = "plexus";

// Keep the current model list in module scope so commands can use it for
// completion and set-default-model without touching the mutable registry.
let currentModels: Model[] = [];

export function getProviderApiKeyConfig(): Pick<ProviderConfig, "apiKey" | "authHeader"> {
	// OMP resolves provider env references through Bun.env and treats an unknown
	// name as a literal key. Check the same source before registering it.
	return Bun.env[ENV_API_KEY]?.trim() ? { apiKey: ENV_API_KEY, authHeader: true } : {};
}

export default function plexusExtension(pi: ExtensionAPI): void {
	const startupBaseUrl = getBaseUrl() ?? "http://localhost/v1";
	log("startup", {
		startupBaseUrl,
		hasEnvApiKey: !!getEnvApiKey(),
	});
	pi.registerProvider(PROVIDER_NAME, {
		api: "openai-completions" as Api,
		...getProviderApiKeyConfig(),
		baseUrl: startupBaseUrl,
		authHeader: true,
		fetchDynamicModels: fetchDynamicPlexusModels,
		oauth: createPlexusLoginProvider(),
	});

	// Refresh the runtime provider without awaiting it. Cached models remain
	// usable immediately while a live catalog update happens in the background.
	pi.on("session_start", (_event, ctx) => {
		syncCurrentModels(ctx);
		const baseUrl = getBaseUrl();
		log("session_start", { baseUrl, modelCount: currentModels.length });
		if (!baseUrl) {
			log("session_start: no base URL configured, skipping refresh");
			return;
		}

		void ctx.modelRegistry.refreshRuntimeProviders("online-if-uncached").then(() => {
			syncCurrentModels(ctx);
			log("session_start: background refresh complete", { count: currentModels.length });
		}).catch((error) => {
			log("session_start: background refresh failed", { error: String(error) });
		});
	});

	pi.registerCommand(PROVIDER_NAME, {
		description: "Plexus provider commands: refresh, set-default-model (setup: /login plexus)",
		getArgumentCompletions: (prefix) => {
			const subcommands = [
				{ value: "refresh", label: "refresh", description: "Refresh Plexus models from the API" },
				{
					value: "set-default-model",
					label: "set-default-model",
					description: "Choose the model Oh My Pi should use by default",
				},
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

function createPlexusLoginProvider(): NonNullable<ProviderConfig["oauth"]> {
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

			// OMP persists the returned credential and drives dynamic discovery after
			// login. Saving the URL before returning lets that refresh resolve it.
			await saveBaseUrl(baseUrl);
			callbacks.onProgress?.("Plexus configured; model discovery is running in the background.");
			return apiKey;
		},
	};
}

async function handleRefresh(ctx: ExtensionCommandContext): Promise<void> {
	const apiKey = (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME)) ?? getEnvApiKey();
	if (!apiKey) {
		ctx.ui.notify("No Plexus API key configured. Run /login plexus first.", "error");
		return;
	}
	if (!getBaseUrl()) {
		ctx.ui.notify("Plexus base URL not configured. Run /login plexus first.", "error");
		return;
	}

	ctx.ui.notify("Refreshing Plexus models…", "info");
	await ctx.modelRegistry.refreshProvider(PROVIDER_NAME, "online");
	syncCurrentModels(ctx);
	ctx.ui.notify(
		currentModels.length > 0
			? `Refreshed ${currentModels.length} Plexus models`
			: "Refresh finished but no Plexus models are available. Check the Plexus server and /login plexus.",
		currentModels.length > 0 ? "info" : "warning",
	);
}

function syncCurrentModels(ctx: ExtensionContext): void {
	currentModels = ctx.models.list().filter((model) => model.provider === PROVIDER_NAME);
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
	const registryModel = ctx.modelRegistry.find(PROVIDER_NAME, model.id) ?? model;
	const active = await pi.setModel(registryModel);
	ctx.ui.notify(
		active
			? `Plexus model selected: ${model.id}.`
			: `Plexus model ${model.id} was saved but could not be selected in this session.`,
		active ? "info" : "warning",
	);
}

async function fetchDynamicPlexusModels(apiKey: string | undefined) {
	const modelsUrl = getModelsUrl();
	const baseUrl = getBaseUrl();
	if (!modelsUrl || !baseUrl || !apiKey) return [];

	const cached = readCachedModelsSync();
	const { models: apiModels, raw, etag, notModified } = await fetchPlexusModels(
		apiKey,
		modelsUrl,
		undefined,
		cached?.etag,
	);
	if (notModified) {
		const suppressPatterns = getSuppressedModels();
		const models = (cached?.models ?? [])
			.filter((model) => !isModelSuppressed({ id: model.id, name: model.name }, suppressPatterns))
			.map(descriptorToOhMyPiModel);
		log("fetchDynamicModels: not modified", { count: models.length, etag: cached?.etag });
		return models;
	}

	const descriptors = convertDescriptors(apiModels, baseUrl, getSuppressedModels());
	const models = descriptors.map(descriptorToOhMyPiModel);
	await Promise.all([
		writeCachedModels(descriptors, etag),
		raw ? writeRawResponse(raw) : Promise.resolve(),
	]);
	log("fetchDynamicModels: fetched", { count: models.length });
	return models;
}
