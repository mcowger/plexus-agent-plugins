import type { Plugin } from "@opencode-ai/plugin"
import type { Auth, Model as OpenCodeModel, Provider as OpenCodeProvider } from "@opencode-ai/sdk/v2"
import { fetchPlexusModels } from "../../plexus-models/src/index.ts"
import { readCachedModels, writeCache } from "./cache.ts"
import { AUTH_METADATA_BASE_URL, resolveConfig } from "./config-store.ts"
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
import { apiBase, modelsUrl, rootURL, trimURL } from "./url.ts"

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

function toRuntimeCapabilities(model: ConfigModel): OpenCodeModel["capabilities"] {
  const input = new Set(model.modalities.input)
  const output = new Set(model.modalities.output)

  return {
    temperature: model.temperature ?? false,
    reasoning: model.reasoning ?? false,
    attachment: model.attachment ?? false,
    toolcall: model.tool_call ?? false,
    input: {
      text: input.has("text"),
      audio: input.has("audio"),
      image: input.has("image"),
      video: input.has("video"),
      pdf: input.has("pdf"),
    },
    output: {
      text: output.has("text"),
      audio: output.has("audio"),
      image: output.has("image"),
      video: output.has("video"),
      pdf: output.has("pdf"),
    },
    interleaved: model.interleaved ?? false,
  }
}

export function toRuntimeModels(
  models: Record<string, ConfigModel>,
  provider: OpenCodeProvider,
): Record<string, OpenCodeModel> {
  const result: Record<string, OpenCodeModel> = {}
  const providerNpm = typeof provider.options?.["npm"] === "string"
    ? provider.options["npm"]
    : OPENAI_COMPATIBLE_NPM
  const providerApi = typeof provider.options?.[PLEXUS_BASE_URL_OPTION] === "string"
    ? apiBase(provider.options[PLEXUS_BASE_URL_OPTION])
    : ""

  for (const [id, model] of Object.entries(models)) {
    result[id] = {
      id: model.id,
      providerID: provider.id,
      api: {
        // This is the upstream model ID sent on the wire, not the provider ID.
        // OpenCode also keys its native GPT/Claude/Gemini/DeepSeek compatibility
        // and variant generation from api.id.
        id: model.id,
        url: model.provider?.api ?? providerApi,
        npm: model.provider?.npm ?? providerNpm,
      },
      name: model.name,
      capabilities: toRuntimeCapabilities(model),
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        ...(model.pricingTiers
          ? {
              tiers: model.pricingTiers.map((tier) => ({
                input: tier.input,
                output: tier.output,
                cache: { read: tier.cacheRead, write: tier.cacheWrite },
                tier: { type: "context" as const, size: tier.inputTokensAbove },
              })),
            }
          : {}),
      },
      limit: model.limit,
      status: "active",
      options: {},
      headers: {},
      release_date: model.release_date ?? "",
      // Deliberately omit variants. OpenCode populates its current native
      // variants after provider hooks run, using api.id, api.npm, release_date,
      // reasoning capability, output limit, and interleaved metadata above.
    }
  }

  return result
}

function toConfigModels(models: Record<string, ConfigModel>): Record<string, ConfigModel> {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => {
      const { pricingTiers: _pricingTiers, ...configModel } = model
      return [id, configModel]
    }),
  )
}

function authMetadata(auth: Auth | undefined): Record<string, string> | undefined {
  return auth?.type === "api" ? auth.metadata : undefined
}

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
        models: existingModels ?? (cachedAsync ? toConfigModels(cachedAsync) : null) ?? {
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
        log.info("Plexus baseURL configured; live discovery delegated to provider.models hook")
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

    provider: {
      id: PLEXUS_PROVIDER_ID,
      models: async (provider, hookCtx) => {
        const authKey = hookCtx.auth?.type === "api" ? hookCtx.auth.key : undefined
        const { baseURL, apiKey } = resolveConfig(provider as never, authMetadata(hookCtx.auth))
        const key = authKey ?? apiKey

        if (!baseURL) {
          log.info("Provider hook skipped live refresh; baseURL missing")
          const cached = await readCachedModels(client)
          return cached ? toRuntimeModels(cached, provider) : {}
        }

        const refreshPromise = refreshModels(client, baseURL, log, key)
        const race = await raceWithTimeout(refreshPromise, CONFIG_HOOK_REFRESH_BUDGET_MS)

        if (race.status === "resolved") {
          log.info(`Provider hook loaded ${Object.keys(race.value).length} plexus models from ${baseURL}`)
          return toRuntimeModels(race.value, provider)
        }

        const cached = await readCachedModels(client)
        if (race.status === "rejected") {
          log.warn(`Provider hook live refresh failed, using cache: ${String(race.error)}`)
        } else {
          log.info(
            `Provider hook refresh still pending after ${CONFIG_HOOK_REFRESH_BUDGET_MS}ms; using cache and continuing in background`,
          )
          refreshPromise.catch((e) => {
            log.warn(`Background plexus model refresh failed: ${String(e)}`)
          })
        }

        return cached ? toRuntimeModels(cached, provider) : {}
      },
    },

    auth: {
      provider: PLEXUS_PROVIDER_ID,

      // Defensive loader — most call paths resolve via cfg.provider.plexus.options,
      // but this ensures auth is available even if the config hook hasn't run yet.
      async loader(getAuth, providerInfo) {
        const auth = await getAuth()

        const authMetadataValue = auth?.type === "api" ? auth.metadata : undefined
        const { baseURL, apiKey } = resolveConfig(providerInfo as never, authMetadataValue)
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
            const baseURL = rootURL(inputs["baseURL"] ?? "")
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

            // Force the next config() call to fetch fresh models
            lastRefresh = null

            return {
              type: "success" as const,
              provider: PLEXUS_PROVIDER_ID,
              key: apiKey,
              metadata: { [AUTH_METADATA_BASE_URL]: baseURL },
            }
          },
        },
      ],
    },
  }
}
