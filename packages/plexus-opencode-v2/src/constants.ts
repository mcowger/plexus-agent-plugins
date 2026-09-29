export const PLEXUS_PROVIDER_ID = "plexus";
export const PLEXUS_PROVIDER_NAME = "Plexus";
export const PLEXUS_PLUGIN_ID = "@mcowger/opencode-plexus";
export const PLEXUS_INTEGRATION_ID = "plexus";

/** Provider-level runtime package (Vercel AI SDK path, same as built-in catalog
 *  models). Raw `@opencode/ai/providers/*` specifiers resolve only when the
 *  location directory has its own node_modules, so they are unusable here. */
export const OPENAI_COMPATIBLE_PKG = "aisdk:@ai-sdk/openai-compatible";
export const ANTHROPIC_PKG = "aisdk:@ai-sdk/anthropic";
export const GOOGLE_PKG = "aisdk:@ai-sdk/google";

/** Plugin-options / credential-metadata key carrying the Plexus root URL. */
export const PLEXUS_BASE_URL_OPTION = "plexusBaseURL";

export const ENV_BASE_URL = "PLEXUS_BASE_URL";
export const ENV_API_URL = "PLEXUS_API_URL";
export const ENV_API_KEY = "PLEXUS_API_KEY";
export const PLEXUS_SUPPRESS_MODELS_OPTION = "suppressModels";

export const MODELS_FETCH_TIMEOUT_MS = 10_000;
export const REFRESH_TTL_MS = 60_000;

/** Sentinel model published when no baseURL is configured yet, so the
 *  provider survives OpenCode's "zero-models → delete" pruning and still
 *  appears in the picker and /connect. */
export const PLACEHOLDER_MODEL_ID = "plexus-unconfigured";

/** Slash command that forces a live model refresh and reloads the provider. */
export const PLEXUS_REFRESH_COMMAND = "plexus-refresh";
