import type { Plugin } from "@opencode-ai/plugin"
import { fetchPlexusModels } from "../../plexus-models/src/index.ts"
import { readCachedModels, readCachedModelsSync, writeCache } from "./cache.ts"
import { resolveConfig, persistToGlobalConfig } from "./config-store.ts"
import { createLogger } from "./log.ts"
import { buildModels, type ConfigModel } from "./mapper.ts"
import {
  OPENAI_COMPATIBLE_NPM,
  PLACEHOLDER_MODEL_ID,
  PLEXUS_PROVIDER_ID,
  PLEXUS_PROVIDER_NAME,
  REFRESH_TTL_MS,
} from "./constants.ts"
import { apiBase, modelsUrl, trimURL } from "./url.ts"

// ---------------------------------------------------------------------------
// In-process TTL cache for model refresh
// ---------------------------------------------------------------------------

let lastRefresh: { at: number; models: Record<string, ConfigModel> } | null = null

async function refreshModels(
  client: Parameters<Plugin>[0]["client"],
  baseURL: string,
  apiKey?: string,
): Promise<Record<string, ConfigModel>> {
  if (lastRefresh && Date.now() - lastRefresh.at < REFRESH_TTL_MS) {
    return lastRefresh.models
  }

  // fetchPlexusModels in plexus-models takes (apiKey, modelsUrl) — apiKey is
  // required by that signature. Fall back to empty string when not provided so
  // the unauthenticated model list still works.
  const url = modelsUrl(baseURL)
  const { models: apiModels, raw } = await fetchPlexusModels(apiKey ?? "", url)
  const built = buildModels(apiModels)
  lastRefresh = { at: Date.now(), models: built }
  // fire-and-forget
  writeCache(client, built, raw).catch(() => {})
  return built
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const PlexusProviderPlugin: Plugin = async (ctx) => {
  const { client } = ctx
  const log = createLogger(client)

  return {
    config: async (cfg) => {
      cfg.provider ??= {}

      // Merge on top of any user-supplied overrides in opencode.json
      const existing = (cfg.provider[PLEXUS_PROVIDER_ID] ?? {}) as Record<string, unknown>
      const existingOptions = (
        typeof existing["options"] === "object" && existing["options"] !== null
          ? existing["options"]
          : {}
      ) as Record<string, unknown>
      const existingModels = (
        typeof existing["models"] === "object" && existing["models"] !== null
          ? (existing["models"] as Record<string, ConfigModel>)
          : null
      )

      const { baseURL, apiKey } = resolveConfig(existing as never)

      // Start with sync-readable cache as fallback
      const cachedSync = readCachedModelsSync()

      const merged: Record<string, unknown> = {
        ...existing,
        name: (existing["name"] as string | undefined) ?? PLEXUS_PROVIDER_NAME,
        npm: (existing["npm"] as string | undefined) ?? OPENAI_COMPATIBLE_NPM,
        options: {
          ...existingOptions,
          ...(baseURL ? { baseURL: apiBase(baseURL) } : {}),
          ...(apiKey ? { apiKey } : {}),
        },
        // Always seed at least one model so OpenCode doesn't prune the provider
        // before /connect runs. The placeholder is replaced once a live fetch
        // succeeds or a real cache exists.
        models: existingModels ?? cachedSync ?? {
          [PLACEHOLDER_MODEL_ID]: {
            id: PLACEHOLDER_MODEL_ID,
            name: "Plexus (run /connect to configure)",
            limit: { context: 1024, output: 1024 },
            modalities: { input: ["text" as const], output: ["text" as const] },
          },
        },
      }

      if (baseURL) {
        try {
          const built = await refreshModels(client, baseURL, apiKey)
          // User-defined model overrides in opencode.json win on a per-id basis
          merged["models"] = { ...built, ...(existingModels ?? {}) }
          log.info(`Loaded ${Object.keys(built).length} plexus models from ${baseURL}`)
        } catch (e) {
          log.warn(`Live model refresh failed, using cache: ${String(e)}`)
          const cached = await readCachedModels(client)
          if (cached) {
            merged["models"] = { ...cached, ...(existingModels ?? {}) }
          }
        }
      } else {
        log.info("Plexus baseURL not configured; skipping live refresh")
      }

      cfg.provider[PLEXUS_PROVIDER_ID] = merged as never
    },

    auth: {
      provider: PLEXUS_PROVIDER_ID,

      // Defensive loader — most call paths resolve via cfg.provider.plexus.options,
      // but this ensures auth is available even if the config hook hasn't run yet.
      async loader(getAuth, providerInfo) {
        const auth = await getAuth()

        const { baseURL, apiKey } = resolveConfig(providerInfo as never)
        const key =
          (auth?.type === "api" ? (auth as { type: string; key: string }).key : undefined) ??
          apiKey

        return {
          ...(baseURL ? { baseURL: apiBase(baseURL) } : {}),
          ...(key ? { apiKey: key } : {}),
        }
      },

      methods: [
        {
          type: "api" as const,
          label: "Plexus API key",
          prompts: [
            {
              type: "text" as const,
              key: "baseURL",
              message: "Plexus base URL",
              placeholder: "https://plexus.example.com",
              validate: (v: string) => (trimURL(v) ? undefined : "URL is required"),
            },
          ],
          async authorize(inputs: Record<string, string> = {}) {
            const baseURL = trimURL(inputs["baseURL"] ?? "")
            const apiKey = (inputs["apiKey"] ?? "").trim()

            if (!baseURL || !apiKey) return { type: "failed" as const }

            // Probe URL reachability — /v1/models doesn't require auth
            try {
              const url = modelsUrl(baseURL)
              await fetchPlexusModels("", url)
            } catch (e) {
              log.error(`Plexus URL probe failed at ${baseURL}: ${String(e)}`)
              return { type: "failed" as const }
            }

            try {
              await persistToGlobalConfig(ctx.serverUrl, client, baseURL, apiKey)
            } catch (e) {
              log.error(`Failed to persist Plexus config: ${String(e)}`)
              // Don't fail auth just because config persistence failed
            }

            // Force the next config() call to fetch fresh models
            lastRefresh = null

            return { type: "success" as const, provider: PLEXUS_PROVIDER_ID, key: apiKey }
          },
        },
      ],
    },
  }
}
