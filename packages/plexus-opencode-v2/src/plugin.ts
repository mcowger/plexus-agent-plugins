import { type Model, Plugin, Provider } from "@opencode/plugin";
import { fetchPlexusModels } from "../../plexus-models/src/index.ts";
import { readCachedModels, writeCache } from "./cache.ts";
import {
	type ConnectionCredential,
	getSuppressedModels,
	type PluginOptions,
	resolveConfig,
} from "./config-store.ts";
import {
	MODELS_FETCH_TIMEOUT_MS,
	OPENAI_COMPATIBLE_PKG,
	PLACEHOLDER_MODEL_ID,
	PLEXUS_BASE_URL_OPTION,
	PLEXUS_INTEGRATION_ID,
	PLEXUS_PLUGIN_ID,
	PLEXUS_PROVIDER_ID,
	PLEXUS_PROVIDER_NAME,
	PLEXUS_REFRESH_COMMAND,
	REFRESH_TTL_MS,
} from "./constants.ts";
import { createLogger, type Logger } from "./log.ts";
import {
	buildModels,
	type PlexusModelInfo,
	placeholderModel,
} from "./mapper.ts";
import { apiBase, modelsUrl } from "./url.ts";

type Context = Plugin.Context;

/**
 * Extract a human-readable message from a thrown value. The apiKeyEnv errors
 * thrown by resolveConfig name the offending variable but never its value, so
 * callers can safely surface this text in status messages.
 */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Refresh state (module-scoped, mirrors the V1 adapter)
// ---------------------------------------------------------------------------

let lastRefresh: { at: number; models: PlexusModelInfo[] } | null = null;
let inFlightRefresh: Promise<PlexusModelInfo[]> | null = null;

function toModelInfo(models: PlexusModelInfo[]): Model.Info[] {
	return models as unknown as Model.Info[];
}

async function resolveConnectionCredential(
	ctx: Context,
	log: Logger,
): Promise<{
	connection: unknown;
	credential: ConnectionCredential | undefined;
}> {
	try {
		const connection = await ctx.integration.connection.active(
			PLEXUS_INTEGRATION_ID,
		);
		if (!connection) return { connection: undefined, credential: undefined };
		const resolved = await ctx.integration.connection.resolve(connection);
		if (resolved?.type !== "key") {
			return { connection, credential: undefined };
		}
		return {
			connection,
			credential: {
				key: resolved.key,
				metadata: (resolved.metadata ?? undefined) as
					| Record<string, unknown>
					| undefined,
				configuration: (resolved.configuration ?? undefined) as
					| Record<string, string | number | boolean | string[]>
					| undefined,
			},
		};
	} catch (e) {
		log.warn(`Integration connection lookup failed: ${String(e)}`);
		return { connection: undefined, credential: undefined };
	}
}

function refreshModels(
	baseURL: string,
	log: Logger,
	apiKey?: string,
	force = false,
	suppress?: string | string[] | null,
): Promise<PlexusModelInfo[]> {
	if (!force && lastRefresh && Date.now() - lastRefresh.at < REFRESH_TTL_MS) {
		log.info(
			`Using in-memory plexus model cache (${lastRefresh.models.length} models)`,
		);
		return Promise.resolve(lastRefresh.models);
	}

	if (inFlightRefresh) return inFlightRefresh;

	const run = async (): Promise<PlexusModelInfo[]> => {
		const url = modelsUrl(baseURL);
		const cached = await readCachedModels(suppress);
		const {
			models: apiModels,
			raw,
			etag,
			notModified,
		} = await fetchPlexusModels(
			apiKey ?? "",
			url,
			MODELS_FETCH_TIMEOUT_MS,
			cached?.etag,
		);

		if (notModified && cached?.models) {
			log.info(`Plexus models not modified (etag: ${cached.etag})`);
			lastRefresh = { at: Date.now(), models: cached.models };
			return cached.models;
		}

		const built = buildModels(apiModels, apiBase(baseURL), suppress);
		log.info(`Fetched ${built.length} plexus models from ${baseURL}`);
		lastRefresh = { at: Date.now(), models: built };
		// fire-and-forget
		writeCache(built, raw, etag).catch(() => {});
		return built;
	};

	inFlightRefresh = run().finally(() => {
		inFlightRefresh = null;
	});
	return inFlightRefresh;
}

interface Source {
	models: PlexusModelInfo[];
	baseURL?: string;
	apiKey?: string;
	connection: unknown;
}

async function loadSource(
	ctx: Context,
	log: Logger,
	options: PluginOptions,
	force: boolean,
): Promise<Source> {
	const suppress = getSuppressedModels(options);
	const { connection, credential } = await resolveConnectionCredential(
		ctx,
		log,
	);
	const { baseURL, apiKey } = resolveConfig(options, credential);
	log.info(
		`Resolved plexus config: baseURL=${baseURL ?? "(missing)"} apiKey=${apiKey ? "present" : "missing"}`,
	);

	if (!baseURL) {
		log.info("Plexus baseURL not configured; using cache or placeholder");
		const cached = await readCachedModels(suppress);
		if (cached && cached.models.length > 0) {
			log.info(`Loaded plexus cache with ${cached.models.length} models`);
			return { models: cached.models, baseURL, apiKey, connection };
		}
		return { models: [placeholderModel()], baseURL, apiKey, connection };
	}

	try {
		const models = await refreshModels(baseURL, log, apiKey, force, suppress);
		if (models.length === 0) {
			log.warn(
				"Live fetch returned no models; falling back to cache or placeholder",
			);
			const cached = await readCachedModels(suppress);
			return {
				models:
					cached && cached.models.length > 0
						? cached.models
						: [placeholderModel()],
				baseURL,
				apiKey,
				connection,
			};
		}
		return { models, baseURL, apiKey, connection };
	} catch (e) {
		log.warn(`Live plexus refresh failed, using cache: ${String(e)}`);
		const cached = await readCachedModels(suppress);
		if (cached && cached.models.length > 0) {
			return { models: cached.models, baseURL, apiKey, connection };
		}
		return { models: [placeholderModel()], baseURL, apiKey, connection };
	}
}

export function providerInfo(source: Source): Provider.Info {
	const providerID = Provider.ID.make(PLEXUS_PROVIDER_ID);
	const info = {
		...Provider.Info.empty(providerID),
		name: PLEXUS_PROVIDER_NAME,
		activation: "enabled" as const,
		package: OPENAI_COMPATIBLE_PKG,
		integrationID: PLEXUS_INTEGRATION_ID,
		settings: {
			...(source.baseURL ? { baseURL: apiBase(source.baseURL) } : {}),
			...(source.apiKey ? { apiKey: source.apiKey } : {}),
		},
	};
	return info as unknown as Provider.Info;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default Plugin.define({
	id: PLEXUS_PLUGIN_ID,
	async setup(ctx) {
		const log = createLogger();
		const options = (ctx.options ?? {}) as PluginOptions;
		const source: Source = {
			models: [],
			baseURL: undefined,
			apiKey: undefined,
			connection: undefined,
		};

		const reloadSource = async (force: boolean): Promise<void> => {
			const next = await loadSource(ctx, log, options, force);
			source.models = next.models;
			source.baseURL = next.baseURL;
			source.apiKey = next.apiKey;
			source.connection = next.connection;
		};

		try {
			await reloadSource(false);
		} catch (e) {
			log.error(`Plexus setup failed: ${errorMessage(e)}`);
			throw e;
		}

		// Single plexus provider. Transform callbacks stay synchronous — the
		// live fetch above runs before registering, and models are captured in
		// the closure. Call ctx.provider.reload() after the closure changes.
		const providerID = Provider.ID.make(PLEXUS_PROVIDER_ID);
		await ctx.provider.transform((editor) => {
			const existing = editor.get(providerID);
			if (existing) editor.remove(providerID);
			editor.add({
				info: providerInfo(source),
				models: toModelInfo(source.models),
				...(source.connection
					? { sourceConnection: source.connection as never }
					: {}),
			});
			log.info(
				`Provider transform: registered ${PLEXUS_PROVIDER_ID} with ${source.models.length} models (present=${Boolean(editor.get(providerID))})`,
			);
		});

		// Re-read the connection on every rebuild so key rotation and
		// re-connects flow into settings without a server restart. The model
		// inventory itself only changes via reloadSource() + reload().
		await ctx.provider.transform((editor) => {
			editor.update(providerID, (provider) => {
				const settings = (provider.settings ?? {}) as Record<string, unknown>;
				if (source.baseURL) settings.baseURL = apiBase(source.baseURL);
				else delete settings.baseURL;
				if (source.apiKey) settings.apiKey = source.apiKey;
				else delete settings.apiKey;
				provider.settings = settings as never;
			});
		});

		// Auth: plexus integration with a base-URL prompt. The key method has
		// no authorize hook in V2 — OpenCode stores the key plus the form
		// answer as credential metadata/configuration, and setup resolves the
		// connection on load and on every manual refresh.
		try {
			// update() creates the integration when missing. It must exist: a
			// stored plexus credential becomes the provider's sourceConnection,
			// and core hides providers whose sourceConnection has no matching
			// integration connection.
			await ctx.integration.transform((editor) => {
				editor.update(PLEXUS_INTEGRATION_ID, (ref) => {
					ref.name = PLEXUS_PROVIDER_NAME;
				});
				editor.method.update({
					integrationID: PLEXUS_INTEGRATION_ID,
					method: {
						type: "key",
						label: "Plexus API key",
						form: [
							{
								type: "string",
								key: PLEXUS_BASE_URL_OPTION,
								title: "Plexus base URL",
								description:
									"Plexus root URL (https://host or https://host/v1)",
								placeholder: "https://plexus.example.com",
								required: true,
							},
						],
					},
				});
			});
		} catch (e) {
			log.warn(`Integration transform failed (non-fatal): ${String(e)}`);
		}

		// Manual refresh command: re-fetch and reload the provider. Run
		// /plexus-refresh after /connect or key rotation — no restart needed.
		await ctx.command.transform((editor) => {
			editor.add({
				name: PLEXUS_REFRESH_COMMAND,
				description: "Refresh Plexus models from the live server",
				execute: async ({ sessionID, delivery }) => {
					// A stale in-memory entry would mask a key rotation, so a
					// manual refresh always forces a live fetch.
					lastRefresh = null;
					try {
						await reloadSource(true);
					} catch (e) {
						// Do not silently continue with stale state: report the
						// failure (the message names the variable, never its value).
						const text = `Plexus refresh failed: ${errorMessage(e)}. Existing state left untouched.`;
						log.error(text);
						await ctx.session.synthetic({
							sessionID,
							text,
							description: text,
							delivery,
							resume: false,
						});
						return;
					}
					await ctx.provider.reload();
					const count = source.models.length;
					const placeholderOnly =
						count === 1 && source.models[0]?.id === PLACEHOLDER_MODEL_ID;
					const text = !source.baseURL
						? "Plexus refresh failed: no base URL configured. Run /connect first (plexus integration)."
						: placeholderOnly
							? `Plexus refresh from ${source.baseURL} returned no usable models. Existing state left untouched.`
							: `Plexus models refreshed: ${count} models from ${source.baseURL}.`;
					log.info(text);
					// Synthetic + resume:false posts the status without running the model.
					await ctx.session.synthetic({
						sessionID,
						text,
						description: text,
						delivery,
						resume: false,
					});
				},
			});
		});

		// /connect, logout, and key rotation change the stored credential. The
		// provider is pinned to the connection seen at load (sourceConnection),
		// so re-resolve and reload whenever credentials change.
		void (async () => {
			let pending: Promise<void> | null = null;
			for await (const event of ctx.event.subscribe()) {
				const type = (event as { type?: string }).type;
				if (type !== "credential.updated" && type !== "credential.switched")
					continue;
				if (pending) continue;
				pending = (async () => {
					try {
						lastRefresh = null;
						await reloadSource(true);
						await ctx.provider.reload();
						log.info(
							`Credentials changed (${type}); reloaded ${source.models.length} model(s)`,
						);
					} catch (e) {
						log.warn(`Reload after credential change failed: ${String(e)}`);
					} finally {
						pending = null;
					}
				})();
			}
		})().catch((e) => log.warn(`Credential watcher stopped: ${String(e)}`));

		log.info(
			`Plexus V2 plugin ready: ${source.models.length} model(s)${source.baseURL ? ` from ${source.baseURL}` : " (unconfigured)"}`,
		);
	},
});
