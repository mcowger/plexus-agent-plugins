export const PLEXUS_PROVIDER_ID = "plexus"
export const PLEXUS_PROVIDER_NAME = "Plexus"
export const PLEXUS_PLUGIN_ID = "@mcowger/opencode-plexus"
export const PLEXUS_LOG_SERVICE = "opencode-plexus"
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
export const PLEXUS_BASE_URL_OPTION = "plexusBaseURL"

export const ENV_BASE_URL = "PLEXUS_BASE_URL"
export const ENV_API_KEY = "PLEXUS_API_KEY"

export const MODELS_FETCH_TIMEOUT_MS = 10_000
export const REFRESH_TTL_MS = 60_000

/** Sentinel model written when no baseURL is configured yet, so the provider
 *  survives OpenCode's "zero-models → delete" pruning and appears in /connect. */
export const PLACEHOLDER_MODEL_ID = "plexus-unconfigured"
