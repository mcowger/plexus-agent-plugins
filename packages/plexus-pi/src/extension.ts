/**
 * plexus-pi — pi (earendil-works/pi) adapter for Plexus model proxy.
 *
 * Requires: PLEXUS_API_KEY env var.
 *
 * Commands:
 *   /plexus login   — set base URL and optional default model
 *   /plexus refresh — re-fetch models from the Plexus endpoint
 */
import * as os from "node:os";
import * as path from "node:path";
// Type-only — erased at runtime, never resolved by the module loader
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	convertDescriptors,
	fetchPlexusModels,
	getBaseUrl,
	getModelsUrl,
	log,
	readCachedModelsSync,
	saveBaseUrl,
	writeCachedModels,
	writeRawResponse,
} from "plexus-models";
import { descriptorToPiModel } from "./mapper.ts";

const PROVIDER_NAME = "plexus";

function getAgentDir(): string {
	const override = process.env["PI_CODING_AGENT_DIR"];
	if (override) return path.resolve(override);
	const configDir = process.env["PI_CONFIG_DIR"] || ".pi";
	return path.join(os.homedir(), configDir, "agent");
}

function getApiKey(): string | undefined {
	return process.env["PLEXUS_API_KEY"];
}

export default function plexusExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();

	// Register from cache on startup if both key and base URL are available.
	const key = getApiKey();
	if (key) {
		const cached = readCachedModelsSync(agentDir);
		if (cached && cached.models.length > 0) {
			const baseUrl = getBaseUrl(agentDir);
			if (baseUrl) {
				pi.registerProvider(PROVIDER_NAME, {
					baseUrl,
					apiKey: key,
					api: "openai-completions",
					authHeader: true,
					models: cached.models.map(descriptorToPiModel),
				});
				log(agentDir, "startup: registered from cache", { count: cached.models.length });
			}
		}
	}

	pi.on("session_start", async () => {
		await doRefresh(pi, agentDir, null);
	});

	pi.registerCommand("plexus", {
		description: "Manage Plexus AI model proxy. Sub-commands: login, refresh",
		async handler(args, ctx) {
			const sub = args.trim().toLowerCase();
			if (sub === "login" || sub === "") {
				await handleLogin(pi, ctx, agentDir);
			} else if (sub === "refresh") {
				await handleRefresh(pi, ctx, agentDir);
			} else {
				ctx.ui.notify(
					`Unknown sub-command: "${args}". Use: /plexus login | /plexus refresh`,
					"warning",
				);
			}
		},
	});
}

async function handleLogin(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentDir: string,
): Promise<void> {
	if (!getApiKey()) {
		ctx.ui.notify("PLEXUS_API_KEY env var is not set. Set it and restart omp.", "error");
		return;
	}

	const baseUrlInput = await ctx.ui.input("Plexus base URL", "https://plexus.example.com");
	if (!baseUrlInput) { ctx.ui.notify("Login cancelled.", "info"); return; }

	const defaultModelInput = await ctx.ui.input("Default model (optional — Enter to skip)", "");

	await saveBaseUrl(agentDir, baseUrlInput.trim(), defaultModelInput?.trim() || undefined);

	ctx.ui.notify("Plexus config saved. Refreshing models…", "info");
	await doRefresh(pi, agentDir, ctx);
}

async function handleRefresh(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentDir: string,
): Promise<void> {
	ctx.ui.notify("Refreshing Plexus models…", "info");
	await doRefresh(pi, agentDir, ctx);
}

async function doRefresh(
	pi: ExtensionAPI,
	agentDir: string,
	notify: ExtensionCommandContext | null,
): Promise<void> {
	const modelsUrl = getModelsUrl(agentDir);
	const baseUrl = getBaseUrl(agentDir);
	const key = getApiKey();

	if (!key) {
		if (notify) notify.ui.notify("PLEXUS_API_KEY env var is not set.", "error");
		return;
	}
	if (!modelsUrl || !baseUrl) {
		if (notify) notify.ui.notify("Plexus base URL not configured. Run /plexus login first.", "warning");
		return;
	}

	try {
		const { models: raw, raw: rawResponse } = await fetchPlexusModels(key, modelsUrl);
		const descriptors = convertDescriptors(raw, baseUrl);

		await writeCachedModels(agentDir, descriptors);
		await writeRawResponse(agentDir, rawResponse);

		pi.registerProvider(PROVIDER_NAME, {
			baseUrl,
			apiKey: key,
			api: "openai-completions",
			authHeader: true,
			models: descriptors.map(descriptorToPiModel),
		});

		log(agentDir, "refresh: ok", { count: descriptors.length });
		if (notify) notify.ui.notify(`Plexus: loaded ${descriptors.length} models.`, "info");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(agentDir, "refresh: error", { error: message });
		if (notify) notify.ui.notify(`Plexus refresh failed: ${message}`, "error");
	}
}
