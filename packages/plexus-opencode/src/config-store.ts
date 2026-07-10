import type { ProviderConfig } from "@opencode-ai/sdk/v2"
import { ENV_API_KEY, ENV_API_URL, ENV_BASE_URL, PLEXUS_BASE_URL_OPTION } from "./constants.ts"
import { rootURL } from "./url.ts"

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/

export const AUTH_METADATA_BASE_URL = "plexusBaseURL"

type AuthMetadata = Record<string, string> | undefined

/** Resolve pi-style "$VAR" / "${VAR}" config templates. */
export function resolveConfigTemplate(value: string): string | undefined {
  let result = ""
  let index = 0

  while (index < value.length) {
    const dollarIndex = value.indexOf("$", index)
    if (dollarIndex < 0) {
      result += value.slice(index)
      break
    }

    result += value.slice(index, dollarIndex)
    const nextChar = value[dollarIndex + 1]

    if (nextChar === "$" || nextChar === "!") {
      result += nextChar
      index = dollarIndex + 2
      continue
    }

    if (nextChar === "{") {
      const endIndex = value.indexOf("}", dollarIndex + 2)
      if (endIndex < 0) {
        result += "$"
        index = dollarIndex + 1
        continue
      }

      const name = value.slice(dollarIndex + 2, endIndex)
      if (!ENV_VAR_NAME_RE.test(name)) {
        result += value.slice(dollarIndex, endIndex + 1)
        index = endIndex + 1
        continue
      }

      const envValue = process.env[name]
      if (envValue === undefined) return undefined
      result += envValue
      index = endIndex + 1
      continue
    }

    const match = value.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE)
    if (match) {
      const envValue = process.env[match[0]]
      if (envValue === undefined) return undefined
      result += envValue
      index = dollarIndex + 1 + match[0].length
      continue
    }

    result += "$"
    index = dollarIndex + 1
  }

  return result
}

function resolveStringOption(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const resolved = resolveConfigTemplate(value)?.trim()
  return resolved || undefined
}

/**
 * Resolve { baseURL, apiKey } with priority:
 *   1. Environment variables
 *   2. OpenCode auth metadata from /connect
 *   3. cfg.provider.plexus.options.{plexusBaseURL,apiKey}
 *   4. legacy cfg.provider.plexus.options.baseURL
 */
export function resolveConfig(
  provider?: ProviderConfig,
  authMetadata?: AuthMetadata,
): { baseURL?: string; apiKey?: string } {
  const envBaseURL = process.env[ENV_API_URL] ?? process.env[ENV_BASE_URL]
  const envApiKey = process.env[ENV_API_KEY]

  const authBaseURL = resolveStringOption(authMetadata?.[AUTH_METADATA_BASE_URL])
  const optBaseURL = resolveStringOption(provider?.options?.[PLEXUS_BASE_URL_OPTION])
  const legacyBaseURL = resolveStringOption(provider?.options?.baseURL)
  const optApiKey = resolveStringOption(provider?.options?.apiKey)

  const baseURL =
    (envBaseURL ? rootURL(envBaseURL) : undefined) ||
    (authBaseURL ? rootURL(authBaseURL) : undefined) ||
    (optBaseURL ? rootURL(optBaseURL) : undefined) ||
    (legacyBaseURL ? rootURL(legacyBaseURL) : undefined) ||
    undefined
  const apiKey = (envApiKey ? envApiKey.trim() : undefined) || optApiKey || undefined

  return { baseURL: baseURL || undefined, apiKey: apiKey || undefined }
}
