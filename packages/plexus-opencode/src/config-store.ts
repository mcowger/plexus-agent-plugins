import type { PluginInput } from "@opencode-ai/plugin"
import type { ProviderConfig } from "@opencode-ai/sdk/v2"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { ENV_API_KEY, ENV_BASE_URL, PLEXUS_PROVIDER_ID } from "./constants.ts"
import { trimURL } from "./url.ts"

type HarnessClientConfig = {
  fetch?: typeof fetch
  headers?: Record<string, string>
}

/** Extract the underlying HTTP config from the v1 plugin harness client. */
function getV1ClientConfig(input: PluginInput["client"]): HarnessClientConfig {
  return (
    (input as unknown as { _client?: { getConfig?: () => HarnessClientConfig } })
      ._client?.getConfig?.() ?? {}
  ) as HarnessClientConfig
}

/** Create a v2 OpenCode client, reusing the harness transport for consistency. */
function createV2Client(serverUrl: URL, input: PluginInput["client"]) {
  const v1Config = getV1ClientConfig(input)
  return createOpencodeClient({
    baseUrl: serverUrl.toString(),
    fetch: v1Config.fetch,
    headers: v1Config.headers,
    throwOnError: true,
  })
}

/**
 * Resolve { baseURL, apiKey } with priority:
 *   1. Environment variables
 *   2. cfg.provider.plexus.options.{baseURL, apiKey}
 */
export function resolveConfig(provider?: ProviderConfig): { baseURL?: string; apiKey?: string } {
  const envBaseURL = process.env[ENV_BASE_URL]
  const envApiKey = process.env[ENV_API_KEY]

  const optBaseURL =
    typeof provider?.options?.baseURL === "string" ? trimURL(provider.options.baseURL) : undefined
  const optApiKey =
    typeof provider?.options?.apiKey === "string"
      ? (provider.options.apiKey as string).trim()
      : undefined

  const baseURL = (envBaseURL ? trimURL(envBaseURL) : undefined) || optBaseURL || undefined
  const apiKey = (envApiKey ? envApiKey.trim() : undefined) || optApiKey || undefined

  return { baseURL: baseURL || undefined, apiKey: apiKey || undefined }
}

/**
 * Persist baseURL and apiKey into OpenCode's global config so subsequent
 * loads pick them up via cfg.provider.plexus.options.
 */
export async function persistToGlobalConfig(
  serverUrl: URL,
  client: PluginInput["client"],
  baseURL: string,
  apiKey: string,
): Promise<void> {
  const v2 = createV2Client(serverUrl, client)
  await v2.global.config.update({
    config: {
      provider: {
        [PLEXUS_PROVIDER_ID]: {
          options: { baseURL, apiKey },
        },
      },
    },
  })
}
