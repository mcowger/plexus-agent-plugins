export const PLEXUS_PROVIDER_ID = "plexus"
export const PLEXUS_PROVIDER_NAME = "Plexus"
export const PLEXUS_PLUGIN_ID = "@mcowger/opencode-plexus"
export const PLEXUS_LOG_SERVICE = "opencode-plexus"
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
export const PLEXUS_BASE_URL_OPTION = "plexusBaseURL"

export const ENV_BASE_URL = "PLEXUS_BASE_URL"
export const ENV_API_URL = "PLEXUS_API_URL"
export const ENV_API_KEY = "PLEXUS_API_KEY"

export const MODELS_FETCH_TIMEOUT_MS = 10_000
export const REFRESH_TTL_MS = 60_000

/** Max time the config() hook will block waiting on a live model refresh
 *  before falling back to cache and letting the refresh finish in the
 *  background. Keeps OpenCode startup snappy even when the Plexus server
 *  is slow to respond (bounded separately by MODELS_FETCH_TIMEOUT_MS). */
export const CONFIG_HOOK_REFRESH_BUDGET_MS = 3_000

/** Sentinel model written when no baseURL is configured yet, so the provider
 *  survives OpenCode's "zero-models → delete" pruning and appears in /connect. */
export const PLACEHOLDER_MODEL_ID = "plexus-unconfigured"
