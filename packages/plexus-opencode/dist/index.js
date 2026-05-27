// @bun
// src/constants.ts
var PLEXUS_PROVIDER_ID = "plexus";
var PLEXUS_PROVIDER_NAME = "Plexus";
var PLEXUS_PLUGIN_ID = "@mcowger/opencode-plexus";
var PLEXUS_LOG_SERVICE = "opencode-plexus";
var OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
var ENV_BASE_URL = "PLEXUS_BASE_URL";
var ENV_API_KEY = "PLEXUS_API_KEY";
var MODELS_FETCH_TIMEOUT_MS = 1e4;
var REFRESH_TTL_MS = 60000;
var PLACEHOLDER_MODEL_ID = "plexus-unconfigured";

// ../plexus-models/src/convert.ts
var REASONING_PARAMS = new Set(["reasoning", "include_reasoning", "reasoning_effort"]);
async function fetchPlexusModels(apiKey, modelsUrl) {
  const res = await fetch(modelsUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    }
  });
  if (!res.ok) {
    throw new Error(`Plexus models fetch failed: ${res.status} ${res.statusText}`);
  }
  const raw = await res.json();
  return { models: raw.data ?? [], raw };
}
// src/cache.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
var PLUGIN_SUBDIR = join("plugins", "plexus");
var CACHE_FILE = "models-cache.json";
var RAW_FILE = "models-raw.json";
var resolvedDir = null;
function fallbackDir() {
  return join(homedir(), ".local", "share", "opencode", PLUGIN_SUBDIR);
}
async function getDir(client) {
  if (resolvedDir)
    return resolvedDir;
  try {
    const res = await client.path.get();
    const data = res?.data;
    const state = typeof data?.state === "string" && data.state ? data.state : undefined;
    if (state) {
      resolvedDir = join(state, PLUGIN_SUBDIR);
      return resolvedDir;
    }
  } catch {}
  resolvedDir = fallbackDir();
  return resolvedDir;
}
function syncCachePath() {
  return join(fallbackDir(), CACHE_FILE);
}
function readCachedModelsSync() {
  try {
    const path = syncCachePath();
    if (!existsSync(path))
      return null;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.models === "object" && !Array.isArray(parsed.models)) {
      return parsed.models;
    }
    return null;
  } catch {
    return null;
  }
}
async function readCachedModels(client) {
  try {
    const dir = await getDir(client);
    const content = await readFile(join(dir, CACHE_FILE), "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.models === "object" && !Array.isArray(parsed.models)) {
      return parsed.models;
    }
    return null;
  } catch {
    return null;
  }
}
async function writeCache(client, models, raw) {
  try {
    const dir = await getDir(client);
    await mkdir(dir, { recursive: true });
    const cache = { models, timestamp: Date.now() };
    await writeFile(join(dir, CACHE_FILE), JSON.stringify(cache, null, 2) + `
`, "utf8");
    if (raw !== undefined) {
      await writeFile(join(dir, RAW_FILE), JSON.stringify(raw, null, 2) + `
`, "utf8");
    }
    try {
      const syncDir = fallbackDir();
      mkdirSync(syncDir, { recursive: true });
      writeFileSync(join(syncDir, CACHE_FILE), JSON.stringify(cache, null, 2) + `
`, "utf8");
    } catch {}
  } catch {}
}

// src/config-store.ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

// src/url.ts
function trimURL(s) {
  return s.trim().replace(/\/+$/, "");
}
function apiBase(baseURL) {
  const next = trimURL(baseURL);
  if (!next)
    return "";
  return next.endsWith("/v1") ? next : `${next}/v1`;
}
function modelsUrl(baseURL) {
  const base = apiBase(baseURL);
  return base ? `${base}/models` : "";
}

// src/config-store.ts
function getV1ClientConfig(input) {
  return input._client?.getConfig?.() ?? {};
}
function createV2Client(serverUrl, input) {
  const v1Config = getV1ClientConfig(input);
  return createOpencodeClient({
    baseUrl: serverUrl.toString(),
    fetch: v1Config.fetch,
    headers: v1Config.headers,
    throwOnError: true
  });
}
function resolveConfig(provider) {
  const envBaseURL = process.env[ENV_BASE_URL];
  const envApiKey = process.env[ENV_API_KEY];
  const optBaseURL = typeof provider?.options?.baseURL === "string" ? trimURL(provider.options.baseURL) : undefined;
  const optApiKey = typeof provider?.options?.apiKey === "string" ? provider.options.apiKey.trim() : undefined;
  const baseURL = (envBaseURL ? trimURL(envBaseURL) : undefined) || optBaseURL || undefined;
  const apiKey = (envApiKey ? envApiKey.trim() : undefined) || optApiKey || undefined;
  return { baseURL: baseURL || undefined, apiKey: apiKey || undefined };
}
async function persistToGlobalConfig(serverUrl, client, baseURL, apiKey) {
  const v2 = createV2Client(serverUrl, client);
  await v2.global.config.update({
    config: {
      provider: {
        [PLEXUS_PROVIDER_ID]: {
          options: { baseURL, apiKey }
        }
      }
    }
  });
}

// src/log.ts
function createLogger(client) {
  function log(level, message) {
    client.app.log({ body: { service: PLEXUS_LOG_SERVICE, level, message } }).catch(() => {});
  }
  return {
    info: (message) => log("info", message),
    warn: (message) => log("warn", message),
    error: (message) => log("error", message)
  };
}

// src/mapper.ts
var REASONING_PARAMS2 = new Set(["reasoning", "include_reasoning", "reasoning_effort"]);
var DEFAULT_CONTEXT = 8192;
function parsePrice(value) {
  if (!value)
    return 0;
  const n = parseFloat(value);
  return Number.isNaN(n) ? 0 : n;
}
function mapModality(m) {
  switch (m) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "file":
    case "pdf":
      return "pdf";
    default:
      return null;
  }
}
function buildInputModalities(model) {
  const raw = model.architecture?.input_modalities ?? [];
  const mapped = raw.map(mapModality).filter((m) => m !== null);
  return mapped.length > 0 ? [...new Set(mapped)] : ["text"];
}
var NON_CHAT_ID_PATTERN = /embedding|embed|tts|whisper|image-[0-9]|image\b.*gen|diffusion|dall-e|stable-diff|sdxl|dream/i;
function buildOutputModalities(model) {
  const raw = model.architecture?.output_modalities;
  if (raw !== undefined) {
    if (!raw.includes("text"))
      return null;
    const mapped = raw.map(mapModality).filter((m) => m !== null);
    return mapped.length > 0 ? [...new Set(mapped)] : ["text"];
  }
  if (NON_CHAT_ID_PATTERN.test(model.id))
    return null;
  return ["text"];
}
function buildModels(models) {
  const result = {};
  for (const m of models) {
    if (!m.id)
      continue;
    const outputModalities = buildOutputModalities(m);
    if (outputModalities === null)
      continue;
    const inputModalities = buildInputModalities(m);
    const params = m.supported_parameters ?? [];
    const contextLength = (typeof m.context_length === "number" && m.context_length > 0 ? m.context_length : undefined) ?? (typeof m.top_provider?.context_length === "number" && m.top_provider.context_length > 0 ? m.top_provider.context_length : undefined) ?? DEFAULT_CONTEXT;
    const maxOutput = (typeof m.top_provider?.max_completion_tokens === "number" && m.top_provider.max_completion_tokens > 0 ? m.top_provider.max_completion_tokens : undefined) ?? Math.ceil(contextLength * 0.2);
    const promptPrice = parsePrice(m.pricing?.prompt);
    const completionPrice = parsePrice(m.pricing?.completion);
    const cacheReadPrice = parsePrice(m.pricing?.input_cache_read);
    const cacheWritePrice = parsePrice(m.pricing?.input_cache_write);
    const hasCachePricing = cacheReadPrice > 0 || cacheWritePrice > 0;
    const hasNonTextInput = inputModalities.some((mod) => mod !== "text");
    const entry = {
      id: m.id,
      name: m.name ?? m.id,
      limit: {
        context: contextLength,
        output: maxOutput
      },
      modalities: {
        input: inputModalities,
        output: outputModalities
      },
      ...promptPrice > 0 || completionPrice > 0 ? {
        cost: {
          input: promptPrice,
          output: completionPrice,
          ...hasCachePricing ? { cache_read: cacheReadPrice, cache_write: cacheWritePrice } : {}
        }
      } : {},
      ...params.includes("tools") ? { tool_call: true } : {},
      ...params.some((p) => REASONING_PARAMS2.has(p)) ? { reasoning: true } : {},
      ...params.includes("temperature") ? { temperature: true } : {},
      ...hasNonTextInput ? { attachment: true } : {}
    };
    result[m.id] = entry;
  }
  return result;
}

// src/plugin.ts
var lastRefresh = null;
async function refreshModels(client, baseURL, apiKey) {
  if (lastRefresh && Date.now() - lastRefresh.at < REFRESH_TTL_MS) {
    return lastRefresh.models;
  }
  const url = modelsUrl(baseURL);
  const { models: apiModels, raw } = await fetchPlexusModels(apiKey ?? "", url);
  const built = buildModels(apiModels);
  lastRefresh = { at: Date.now(), models: built };
  writeCache(client, built, raw).catch(() => {});
  return built;
}
var PlexusProviderPlugin = async (ctx) => {
  const { client } = ctx;
  const log = createLogger(client);
  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      const existing = cfg.provider[PLEXUS_PROVIDER_ID] ?? {};
      const existingOptions = typeof existing["options"] === "object" && existing["options"] !== null ? existing["options"] : {};
      const existingModels = typeof existing["models"] === "object" && existing["models"] !== null ? existing["models"] : null;
      const { baseURL, apiKey } = resolveConfig(existing);
      const cachedSync = readCachedModelsSync();
      const merged = {
        ...existing,
        name: existing["name"] ?? PLEXUS_PROVIDER_NAME,
        npm: existing["npm"] ?? OPENAI_COMPATIBLE_NPM,
        options: {
          ...existingOptions,
          ...baseURL ? { baseURL: apiBase(baseURL) } : {},
          ...apiKey ? { apiKey } : {}
        },
        models: existingModels ?? cachedSync ?? {
          [PLACEHOLDER_MODEL_ID]: {
            id: PLACEHOLDER_MODEL_ID,
            name: "Plexus (run /connect to configure)",
            limit: { context: 1024, output: 1024 },
            modalities: { input: ["text"], output: ["text"] }
          }
        }
      };
      if (baseURL) {
        try {
          const built = await refreshModels(client, baseURL, apiKey);
          merged["models"] = { ...built, ...existingModels ?? {} };
          log.info(`Loaded ${Object.keys(built).length} plexus models from ${baseURL}`);
        } catch (e) {
          log.warn(`Live model refresh failed, using cache: ${String(e)}`);
          const cached = await readCachedModels(client);
          if (cached) {
            merged["models"] = { ...cached, ...existingModels ?? {} };
          }
        }
      } else {
        log.info("Plexus baseURL not configured; skipping live refresh");
      }
      cfg.provider[PLEXUS_PROVIDER_ID] = merged;
    },
    auth: {
      provider: PLEXUS_PROVIDER_ID,
      async loader(getAuth, providerInfo) {
        const auth = await getAuth();
        const { baseURL, apiKey } = resolveConfig(providerInfo);
        const key = (auth?.type === "api" ? auth.key : undefined) ?? apiKey;
        return {
          ...baseURL ? { baseURL: apiBase(baseURL) } : {},
          ...key ? { apiKey: key } : {}
        };
      },
      methods: [
        {
          type: "api",
          label: "Plexus API key",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "Plexus base URL",
              placeholder: "https://plexus.example.com",
              validate: (v) => trimURL(v) ? undefined : "URL is required"
            }
          ],
          async authorize(inputs = {}) {
            const baseURL = trimURL(inputs["baseURL"] ?? "");
            const apiKey = (inputs["apiKey"] ?? "").trim();
            if (!baseURL || !apiKey)
              return { type: "failed" };
            try {
              const url = modelsUrl(baseURL);
              await fetchPlexusModels("", url);
            } catch (e) {
              log.error(`Plexus URL probe failed at ${baseURL}: ${String(e)}`);
              return { type: "failed" };
            }
            try {
              await persistToGlobalConfig(ctx.serverUrl, client, baseURL, apiKey);
            } catch (e) {
              log.error(`Failed to persist Plexus config: ${String(e)}`);
            }
            lastRefresh = null;
            return { type: "success", provider: PLEXUS_PROVIDER_ID, key: apiKey };
          }
        }
      ]
    }
  };
};

// src/index.ts
var plugin2 = {
  id: PLEXUS_PLUGIN_ID,
  server: PlexusProviderPlugin
};
var src_default = plugin2;
export {
  src_default as default,
  buildModels,
  REFRESH_TTL_MS,
  PlexusProviderPlugin,
  PLEXUS_PROVIDER_NAME,
  PLEXUS_PROVIDER_ID,
  PLEXUS_PLUGIN_ID,
  PLEXUS_LOG_SERVICE,
  PLACEHOLDER_MODEL_ID,
  OPENAI_COMPATIBLE_NPM,
  MODELS_FETCH_TIMEOUT_MS,
  ENV_BASE_URL,
  ENV_API_KEY
};
