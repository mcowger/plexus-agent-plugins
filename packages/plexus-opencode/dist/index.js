// @bun
// src/constants.ts
var PLEXUS_PROVIDER_ID = "plexus";
var PLEXUS_PROVIDER_NAME = "Plexus";
var PLEXUS_PLUGIN_ID = "@mcowger/opencode-plexus";
var PLEXUS_LOG_SERVICE = "opencode-plexus";
var OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
var PLEXUS_BASE_URL_OPTION = "plexusBaseURL";
var ENV_BASE_URL = "PLEXUS_BASE_URL";
var ENV_API_URL = "PLEXUS_API_URL";
var ENV_API_KEY = "PLEXUS_API_KEY";
var MODELS_FETCH_TIMEOUT_MS = 1e4;
var REFRESH_TTL_MS = 60000;
var CONFIG_HOOK_REFRESH_BUDGET_MS = 3000;
var PLACEHOLDER_MODEL_ID = "plexus-unconfigured";

// ../plexus-models/src/convert.ts
var REASONING_PARAMS = new Set(["reasoning", "include_reasoning", "reasoning_effort"]);
var NON_CHAT_ID_PATTERN = /embedding|embed|tts|whisper|image-[0-9]|image\b.*gen|diffusion|dall-e|stable-diff|sdxl|dream/i;
var API_DIALECT_MAP = {
  chat_completions: "openai-completions",
  "openai-completions": "openai-completions",
  messages: "anthropic-messages",
  "anthropic-messages": "anthropic-messages",
  gemini: "google-generative-ai",
  "google-generative-ai": "google-generative-ai",
  responses: "openai-responses",
  "openai-responses": "openai-responses"
};
function mapPreferredApi(raw) {
  if (raw === undefined)
    return "openai-completions";
  const candidates = Array.isArray(raw) ? raw : [raw];
  for (const candidate of candidates) {
    const mapped = API_DIALECT_MAP[candidate];
    if (mapped !== undefined)
      return mapped;
  }
  return "openai-completions";
}
function adjustBaseUrl(baseUrl, preferredApi) {
  const stripped = baseUrl.replace(/\/+$/, "");
  switch (preferredApi) {
    case "anthropic-messages":
      return stripped.endsWith("/v1") ? stripped.slice(0, -3) : stripped;
    case "google-generative-ai":
      return stripped.endsWith("/v1") ? `${stripped.slice(0, -3)}/v1beta` : stripped;
    default:
      return stripped;
  }
}
function isChatModel(model) {
  const outputModalities = model.architecture?.output_modalities;
  if (outputModalities !== undefined)
    return outputModalities.includes("text");
  return !NON_CHAT_ID_PATTERN.test(model.id);
}
var DEFAULT_MODELS_FETCH_TIMEOUT_MS = 1e4;
async function fetchPlexusModels(apiKey, modelsUrl, timeoutMs = DEFAULT_MODELS_FETCH_TIMEOUT_MS) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (apiKey)
      headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(modelsUrl, {
      headers,
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Plexus models fetch failed: ${res.status} ${res.statusText}`);
    }
    const raw = await res.json();
    return { models: raw.data ?? [], raw };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Plexus models fetch timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
// src/cache.ts
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
var PLUGIN_SUBDIR = join("plugins", "plexus");
var CACHE_FILE = "models-cache.json";
var RAW_FILE = "models-raw.json";
function fallbackDir() {
  return join(homedir(), ".local", "share", "opencode", PLUGIN_SUBDIR);
}
function getDir() {
  return fallbackDir();
}
async function readCachedModels(_client) {
  try {
    const dir = getDir();
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
async function writeCache(_client, models, raw) {
  try {
    const dir = getDir();
    await mkdir(dir, { recursive: true });
    const cache = { models, timestamp: Date.now() };
    await writeFile(join(dir, CACHE_FILE), JSON.stringify(cache, null, 2) + `
`, "utf8");
    if (raw !== undefined) {
      await writeFile(join(dir, RAW_FILE), JSON.stringify(raw, null, 2) + `
`, "utf8");
    }
  } catch {}
}

// src/url.ts
function trimURL(s) {
  return s.trim().replace(/\/+$/, "");
}
function rootURL(s) {
  const next = trimURL(s);
  if (!next)
    return "";
  return next.endsWith("/v1") ? next.slice(0, -3) : next;
}
function apiBase(baseURL) {
  const next = rootURL(baseURL);
  if (!next)
    return "";
  return `${next}/v1`;
}
function modelsUrl(baseURL) {
  const base = apiBase(baseURL);
  return base ? `${base}/models` : "";
}

// src/config-store.ts
var ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
var AUTH_METADATA_BASE_URL = "plexusBaseURL";
function resolveConfigTemplate(value) {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const dollarIndex = value.indexOf("$", index);
    if (dollarIndex < 0) {
      result += value.slice(index);
      break;
    }
    result += value.slice(index, dollarIndex);
    const nextChar = value[dollarIndex + 1];
    if (nextChar === "$" || nextChar === "!") {
      result += nextChar;
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === "{") {
      const endIndex = value.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        result += "$";
        index = dollarIndex + 1;
        continue;
      }
      const name = value.slice(dollarIndex + 2, endIndex);
      if (!ENV_VAR_NAME_RE.test(name)) {
        result += value.slice(dollarIndex, endIndex + 1);
        index = endIndex + 1;
        continue;
      }
      const envValue = process.env[name];
      if (envValue === undefined)
        return;
      result += envValue;
      index = endIndex + 1;
      continue;
    }
    const match = value.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      const envValue = process.env[match[0]];
      if (envValue === undefined)
        return;
      result += envValue;
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    result += "$";
    index = dollarIndex + 1;
  }
  return result;
}
function resolveStringOption(value) {
  if (typeof value !== "string")
    return;
  const resolved = resolveConfigTemplate(value)?.trim();
  return resolved || undefined;
}
function resolveConfig(provider, authMetadata) {
  const envBaseURL = process.env[ENV_API_URL] ?? process.env[ENV_BASE_URL];
  const envApiKey = process.env[ENV_API_KEY];
  const authBaseURL = resolveStringOption(authMetadata?.[AUTH_METADATA_BASE_URL]);
  const optBaseURL = resolveStringOption(provider?.options?.[PLEXUS_BASE_URL_OPTION]);
  const legacyBaseURL = resolveStringOption(provider?.options?.baseURL);
  const optApiKey = resolveStringOption(provider?.options?.apiKey);
  const baseURL = (envBaseURL ? rootURL(envBaseURL) : undefined) || (authBaseURL ? rootURL(authBaseURL) : undefined) || (optBaseURL ? rootURL(optBaseURL) : undefined) || (legacyBaseURL ? rootURL(legacyBaseURL) : undefined) || undefined;
  const apiKey = (envApiKey ? envApiKey.trim() : undefined) || optApiKey || undefined;
  return { baseURL: baseURL || undefined, apiKey: apiKey || undefined };
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
var PER_TOKEN_TO_PER_MILLION = 1e6;
function resolveModelProvider(model, baseURL) {
  const preferredApi = mapPreferredApi(model.preferred_api);
  const api = adjustBaseUrl(baseURL, preferredApi);
  switch (preferredApi) {
    case "anthropic-messages":
      return { npm: "@ai-sdk/anthropic", api };
    case "google-generative-ai":
      return { npm: "@ai-sdk/google", api };
    case "openai-responses":
      return { npm: "@ai-sdk/openai", api };
    case "openai-completions":
      return { api };
    default:
      return { api };
  }
}
function parsePrice(value) {
  if (!value)
    return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n * PER_TOKEN_TO_PER_MILLION : 0;
}
function buildPricingTiers(model) {
  const pricing = model.pricing;
  if (!pricing?.tiers)
    return;
  const tiers = pricing.tiers.flatMap((tier) => {
    if (!Number.isFinite(tier.input_tokens_above) || tier.input_tokens_above < 0)
      return [];
    return [{
      inputTokensAbove: tier.input_tokens_above,
      input: parsePrice(tier.prompt ?? pricing.prompt),
      output: parsePrice(tier.completion ?? pricing.completion),
      cacheRead: parsePrice(tier.input_cache_read ?? pricing.input_cache_read),
      cacheWrite: parsePrice(tier.input_cache_write ?? pricing.input_cache_write)
    }];
  });
  return tiers.length > 0 ? tiers : undefined;
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
function buildOutputModalities(model) {
  const raw = model.architecture?.output_modalities;
  if (raw !== undefined) {
    if (!raw.includes("text"))
      return null;
    const mapped = raw.map(mapModality).filter((m) => m !== null);
    return mapped.length > 0 ? [...new Set(mapped)] : ["text"];
  }
  return ["text"];
}
function buildModels(models, baseURL) {
  const result = {};
  for (const m of models) {
    if (!m.id || !isChatModel(m))
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
    const pricingTiers = buildPricingTiers(m);
    const hasNonTextInput = inputModalities.some((mod) => mod !== "text");
    const provider = resolveModelProvider(m, baseURL);
    const entry = {
      id: m.id,
      name: m.name ?? m.id,
      provider,
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
      ...hasNonTextInput ? { attachment: true } : {},
      ...pricingTiers ? { pricingTiers } : {}
    };
    result[m.id] = entry;
  }
  return result;
}

// src/plugin.ts
var lastRefresh = null;
var inFlightRefresh = null;
function toRuntimeCapabilities(model) {
  const input = new Set(model.modalities.input);
  const output = new Set(model.modalities.output);
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
      pdf: input.has("pdf")
    },
    output: {
      text: output.has("text"),
      audio: output.has("audio"),
      image: output.has("image"),
      video: output.has("video"),
      pdf: output.has("pdf")
    },
    interleaved: false
  };
}
function toRuntimeModels(models, provider) {
  const result = {};
  const providerNpm = typeof provider.options?.["npm"] === "string" ? provider.options["npm"] : OPENAI_COMPATIBLE_NPM;
  const providerApi = typeof provider.options?.[PLEXUS_BASE_URL_OPTION] === "string" ? apiBase(provider.options[PLEXUS_BASE_URL_OPTION]) : "";
  for (const [id, model] of Object.entries(models)) {
    result[id] = {
      id: model.id,
      providerID: provider.id,
      api: {
        id: provider.id,
        url: model.provider?.api ?? providerApi,
        npm: model.provider?.npm ?? providerNpm
      },
      name: model.name,
      capabilities: toRuntimeCapabilities(model),
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0
        },
        ...model.pricingTiers ? {
          tiers: model.pricingTiers.map((tier) => ({
            input: tier.input,
            output: tier.output,
            cache: { read: tier.cacheRead, write: tier.cacheWrite },
            tier: { type: "context", size: tier.inputTokensAbove }
          }))
        } : {}
      },
      limit: model.limit,
      status: "active",
      options: {},
      headers: {},
      release_date: ""
    };
  }
  return result;
}
function toConfigModels(models) {
  return Object.fromEntries(Object.entries(models).map(([id, model]) => {
    const { pricingTiers: _pricingTiers, ...configModel } = model;
    return [id, configModel];
  }));
}
function authMetadata(auth) {
  return auth?.type === "api" ? auth.metadata : undefined;
}
function raceWithTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve({ status: "resolved", value });
    }, (error) => {
      clearTimeout(timer);
      resolve({ status: "rejected", error });
    });
  });
}
function refreshModels(client, baseURL, log, apiKey) {
  if (lastRefresh && Date.now() - lastRefresh.at < REFRESH_TTL_MS) {
    log.info(`Using in-memory plexus model cache (${Object.keys(lastRefresh.models).length} models)`);
    return Promise.resolve(lastRefresh.models);
  }
  if (inFlightRefresh)
    return inFlightRefresh;
  const run = async () => {
    const url = modelsUrl(baseURL);
    const { models: apiModels, raw } = await fetchPlexusModels(apiKey ?? "", url);
    const built = buildModels(apiModels, apiBase(baseURL));
    for (const [id, model] of Object.entries(built)) {
      const providerNpm = model.provider?.npm ?? OPENAI_COMPATIBLE_NPM;
      const providerApi = model.provider?.api ?? "(missing)";
      log.info(`Model mapping ${id}: npm=${providerNpm} api=${providerApi}`);
    }
    lastRefresh = { at: Date.now(), models: built };
    writeCache(client, built, raw).catch(() => {});
    return built;
  };
  inFlightRefresh = run().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
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
      log.info(`Resolved plexus config: baseURL=${baseURL ?? "(missing)"} apiKey=${apiKey ? "present" : "missing"}`);
      if (typeof existingOptions["baseURL"] === "string") {
        log.warn(`Ignoring legacy provider.options.baseURL=${String(existingOptions["baseURL"])}`);
      }
      const cachedAsync = await readCachedModels(client);
      if (cachedAsync) {
        log.info(`Loaded plexus cache with ${Object.keys(cachedAsync).length} models`);
      }
      const merged = {
        ...existing,
        name: existing["name"] ?? PLEXUS_PROVIDER_NAME,
        npm: existing["npm"] ?? OPENAI_COMPATIBLE_NPM,
        options: {
          ...existingOptions,
          ...baseURL ? { [PLEXUS_BASE_URL_OPTION]: baseURL } : {},
          ...apiKey ? { apiKey } : {}
        },
        models: existingModels ?? (cachedAsync ? toConfigModels(cachedAsync) : null) ?? {
          [PLACEHOLDER_MODEL_ID]: {
            id: PLACEHOLDER_MODEL_ID,
            name: "Plexus (run /connect to configure)",
            limit: { context: 1024, output: 1024 },
            modalities: { input: ["text"], output: ["text"] }
          }
        }
      };
      const mergedOptions = merged["options"];
      delete mergedOptions["baseURL"];
      if (baseURL) {
        log.info("Plexus baseURL configured; live discovery delegated to provider.models hook");
      } else {
        log.info("Plexus baseURL not configured; skipping live refresh");
      }
      try {
        const mergedModels = merged["models"];
        for (const id of ["gemini-3.5-flash", "claude-haiku-4-5", "small-fast"]) {
          const m = mergedModels?.[id];
          if (!m)
            continue;
          log.info(`Merged model ${id}: provider.npm=${m.provider?.npm ?? "(unset)"} provider.api=${m.provider?.api ?? "(unset)"}`);
        }
      } catch {}
      cfg.provider[PLEXUS_PROVIDER_ID] = merged;
    },
    provider: {
      id: PLEXUS_PROVIDER_ID,
      models: async (provider, hookCtx) => {
        const authKey = hookCtx.auth?.type === "api" ? hookCtx.auth.key : undefined;
        const { baseURL, apiKey } = resolveConfig(provider, authMetadata(hookCtx.auth));
        const key = authKey ?? apiKey;
        if (!baseURL) {
          log.info("Provider hook skipped live refresh; baseURL missing");
          const cached2 = await readCachedModels(client);
          return cached2 ? toRuntimeModels(cached2, provider) : {};
        }
        const refreshPromise = refreshModels(client, baseURL, log, key);
        const race = await raceWithTimeout(refreshPromise, CONFIG_HOOK_REFRESH_BUDGET_MS);
        if (race.status === "resolved") {
          log.info(`Provider hook loaded ${Object.keys(race.value).length} plexus models from ${baseURL}`);
          return toRuntimeModels(race.value, provider);
        }
        const cached = await readCachedModels(client);
        if (race.status === "rejected") {
          log.warn(`Provider hook live refresh failed, using cache: ${String(race.error)}`);
        } else {
          log.info(`Provider hook refresh still pending after ${CONFIG_HOOK_REFRESH_BUDGET_MS}ms; using cache and continuing in background`);
          refreshPromise.catch((e) => {
            log.warn(`Background plexus model refresh failed: ${String(e)}`);
          });
        }
        return cached ? toRuntimeModels(cached, provider) : {};
      }
    },
    auth: {
      provider: PLEXUS_PROVIDER_ID,
      async loader(getAuth, providerInfo) {
        const auth = await getAuth();
        const authMetadataValue = auth?.type === "api" ? auth.metadata : undefined;
        const { baseURL, apiKey } = resolveConfig(providerInfo, authMetadataValue);
        const key = (auth?.type === "api" ? auth.key : undefined) ?? apiKey;
        log.info(`Auth loader resolved plexus config: baseURL=${baseURL ?? "(missing)"} apiKey=${key ? "present" : "missing"}`);
        return {
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
            const baseURL = rootURL(inputs["baseURL"] ?? "");
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
            lastRefresh = null;
            return {
              type: "success",
              provider: PLEXUS_PROVIDER_ID,
              key: apiKey,
              metadata: { [AUTH_METADATA_BASE_URL]: baseURL }
            };
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
  PLEXUS_BASE_URL_OPTION,
  PLACEHOLDER_MODEL_ID,
  OPENAI_COMPATIBLE_NPM,
  MODELS_FETCH_TIMEOUT_MS,
  ENV_BASE_URL,
  ENV_API_URL,
  ENV_API_KEY,
  CONFIG_HOOK_REFRESH_BUDGET_MS
};
