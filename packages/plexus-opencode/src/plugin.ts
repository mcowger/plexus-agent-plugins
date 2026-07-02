import type { Plugin } from "@opencode-ai/plugin"
import { fetchPlexusModels } from "../../plexus-models/src/index.ts"
import { readCachedModels, writeCache } from "./cache.ts"
import { resolveConfig, persistToGlobalConfig } from "./config-store.ts"
import { createLogger } from "./log.ts"
import { buildModels, type ConfigModel } from "./mapper.ts"
import {
  CONFIG_HOOK_REFRESH_BUDGET_MS,
  OPENAI_COMPATIBLE_NPM,
  PLACEHOLDER_MODEL_ID,
  PLEXUS_BASE_URL_OPTION,
  PLEXUS_PROVIDER_ID,
  PLEXUS_PROVIDER_NAME,
  REFRESH_TTL_MS,
} from "./constants.ts"
import { apiBase, modelsUrl, trimURL } from "./url.ts"

// ---------------------------------------------------------------------------
// In-process TTL cache for model refresh
// ---------------------------------------------------------------------------

let lastRefresh: { at: number; models: Record<string, ConfigModel> } | null = null

/** Dedupes concurrent refresh attempts so overlapping config() calls (or a
 *  config() call racing an in-progress background refresh) share one fetch. */
let inFlightRefresh: Promise<Record<string, ConfigModel>> | null = null

type RaceResult<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timed-out" }

/**
 * Awaits `promise` for at most `timeoutMs`. If it doesn't settle in time,
 * resolves with { status: "timed-out" } — the original promise keeps
 * running and its eventual outcome is left to the caller (e.g. background
 * cache write, or a .catch() for logging).
 */
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<RaceResult<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve({ status: "resolved", value })
      },
      (error) => {
        clearTimeout(timer)
        resolve({ status: "rejected", error })
      },
    )
  })
}

function mergeModelMaps(
  base: Record<string, ConfigModel>,
  overrides: Record<string, ConfigModel> | null,
): Record<string, ConfigModel> {
  if (!overrides) return base

  const merged: Record<string, ConfigModel> = { ...base }
  for (const [id, override] of Object.entries(overrides)) {
    const existing = merged[id]
    if (!existing) {
      merged[id] = override
      continue
    }

    merged[id] = {
      ...existing,
      ...override,
      provider: {
        ...(existing.provider ?? {}),
        ...(override.provider ?? {}),
      },
      ...(existing.cost || override.cost
        ? {
            cost: {
              ...(existing.cost ?? { input: 0, output: 0 }),
              ...(override.cost ?? {}),
            },
          }
        : {}),
      limit: {
        ...existing.limit,
        ...override.limit,
      },
      modalities: {
        input: override.modalities?.input ?? existing.modalities.input,
        output: override.modalities?.output ?? existing.modalities.output,
      },
    }
  }

  return merged
}

function refreshModels(
  client: Parameters<Plugin>[0]["client"],
  baseURL: string,
  log: ReturnType<typeof createLogger>,
  apiKey?: string,
): Promise<Record<string, ConfigModel>> {
  if (lastRefresh && Date.now() - lastRefresh.at < REFRESH_TTL_MS) {
    log.info(`Using in-memory plexus model cache (${Object.keys(lastRefresh.models).length} models)`)
    return Promise.resolve(lastRefresh.models)
  }

  // Dedupe concurrent callers (e.g. config() racing a prior background
  // refresh) onto a single in-flight fetch.
  if (inFlightRefresh) return inFlightRefresh

  const run = async (): Promise<Record<string, ConfigModel>> => {
    // fetchPlexusModels in plexus-models takes (apiKey, modelsUrl) — apiKey is
    // required by that signature. Fall back to empty string when not provided so
    // the unauthenticated model list still works. It is internally bounded by
    // an AbortController timeout, so this can't hang indefinitely.
    const url = modelsUrl(baseURL)
    const { models: apiModels, raw } = await fetchPlexusModels(apiKey ?? "", url)
    const built = buildModels(apiModels, apiBase(baseURL))
    for (const [id, model] of Object.entries(built)) {
      const providerNpm = model.provider?.npm ?? OPENAI_COMPATIBLE_NPM
      const providerApi = model.provider?.api ?? "(missing)"
      log.info(`Model mapping ${id}: npm=${providerNpm} api=${providerApi}`)
    }
    lastRefresh = { at: Date.now(), models: built }
    // fire-and-forget
    writeCache(client, built, raw).catch(() => {})
    return built
  }

  inFlightRefresh = run().finally(() => {
    inFlightRefresh = null
  })
  return inFlightRefresh
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
      log.info(
        `Resolved plexus config: baseURL=${baseURL ?? "(missing)"} apiKey=${apiKey ? "present" : "missing"}`,
      )
      if (typeof existingOptions["baseURL"] === "string") {
        log.warn(`Ignoring legacy provider.options.baseURL=${String(existingOptions["baseURL"])}`)
      }

      // Async cache read — config() is already async, so there's no reason
      // to pay for a blocking sync file read here.
      const cachedAsync = await readCachedModels(client)
      if (cachedAsync) {
        log.info(`Loaded plexus cache with ${Object.keys(cachedAsync).length} models`)
      }

      const merged: Record<string, unknown> = {
        ...existing,
        name: (existing["name"] as string | undefined) ?? PLEXUS_PROVIDER_NAME,
        npm: (existing["npm"] as string | undefined) ?? OPENAI_COMPATIBLE_NPM,
        options: {
          ...existingOptions,
          ...(baseURL ? { [PLEXUS_BASE_URL_OPTION]: baseURL } : {}),
          ...(apiKey ? { apiKey } : {}),
        },
        // Always seed at least one model so OpenCode doesn't prune the provider
        // before /connect runs. The placeholder is replaced once a live fetch
        // succeeds or a real cache exists.
        models: existingModels ?? cachedAsync ?? {
          [PLACEHOLDER_MODEL_ID]: {
            id: PLACEHOLDER_MODEL_ID,
            name: "Plexus (run /connect to configure)",
            limit: { context: 1024, output: 1024 },
            modalities: { input: ["text" as const], output: ["text" as const] },
          },
        },
      }

      const mergedOptions = merged["options"] as Record<string, unknown>
      delete mergedOptions["baseURL"]

      if (baseURL) {
        // Give the live refresh a short budget to complete inline (covers
        // the common "already warm" case where refreshModels resolves from
        // the in-memory TTL cache almost instantly). If it doesn't finish in
        // time, fall back to cache/placeholder immediately and let the
        // refresh keep running in the background — startup must not block
        // on a slow or unreachable Plexus server.
        const refreshPromise = refreshModels(client, baseURL, log, apiKey)
        const race = await raceWithTimeout(refreshPromise, CONFIG_HOOK_REFRESH_BUDGET_MS)

        if (race.status === "resolved") {
          // User-defined model overrides in opencode.json win on a per-id basis
          merged["models"] = mergeModelMaps(race.value, existingModels)
          log.info(`Loaded ${Object.keys(race.value).length} plexus models from ${baseURL}`)
        } else if (race.status === "rejected") {
          log.warn(`Live model refresh failed, using cache: ${String(race.error)}`)
          if (cachedAsync) {
            merged["models"] = mergeModelMaps(cachedAsync, existingModels)
          }
        } else {
          log.info(
            `Live model refresh still pending after ${CONFIG_HOOK_REFRESH_BUDGET_MS}ms; using cache and continuing in background`,
          )
          if (cachedAsync) {
            merged["models"] = mergeModelMaps(cachedAsync, existingModels)
          }
          // Let it finish in the background; refreshModels() already caches
          // the result in lastRefresh and writes it to disk. Swallow errors
          // here — they're logged inside refreshModels' caller paths only
          // when awaited, so log explicitly for the background case.
          refreshPromise.catch((e) => {
            log.warn(`Background plexus model refresh failed: ${String(e)}`)
          })
        }
      } else {
        log.info("Plexus baseURL not configured; skipping live refresh")
      }

      // Sanity log a few common IDs so we can confirm the final merged config
      // includes model-level provider overrides (npm/api) as expected.
      try {
        const mergedModels = merged["models"] as Record<string, ConfigModel>
        for (const id of ["gemini-3.5-flash", "claude-haiku-4-5", "small-fast"]) {
          const m = mergedModels?.[id]
          if (!m) continue
          log.info(
            `Merged model ${id}: provider.npm=${m.provider?.npm ?? "(unset)"} provider.api=${m.provider?.api ?? "(unset)"}`,
          )
        }
      } catch {
        // ignore
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

        log.info(
          `Auth loader resolved plexus config: baseURL=${baseURL ?? "(missing)"} apiKey=${key ? "present" : "missing"}`,
        )

        return {
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
