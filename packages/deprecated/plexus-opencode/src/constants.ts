export const PLEXUS_PROVIDER_ID = "plexus"
export const PLEXUS_PROVIDER_NAME = "Plexus"
export const PLEXUS_PLUGIN_ID = "@mcowger/opencode-plexus"
export const PLEXUS_LOG_SERVICE = "opencode-plexus"
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
export const PLEXUS_BASE_URL_OPTION = "plexusBaseURL"

export const ENV_BASE_URL = "PLEXUS_BASE_URL"
export const ENV_API_URL = "PLEXUS_API_URL"
export const ENV_API_KEY = "PLEXUS_API_KEY"
export const ENV_SUPPRESS_MODELS = "PLEXUS_SUPPRESS_MODELS"
export const ENV_SUPPRESSED_MODELS = "PLEXUS_SUPPRESSED_MODELS"
export const ENV_EXCLUDE_MODELS = "PLEXUS_EXCLUDE_MODELS"
export const ENV_IGNORE_MODELS = "PLEXUS_IGNORE_MODELS"
export const PLEXUS_SUPPRESS_MODELS_OPTION = "suppressModels"

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

/** Name of the slash command that forces a live model refresh and rewrites
 *  the on-disk cache. Registered via cfg.command and handled in the
 *  "command.execute.before" hook. */
export const PLEXUS_REFRESH_COMMAND = "plexus-refresh"
