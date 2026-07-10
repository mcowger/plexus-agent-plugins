// @bun
// ../plexus-models/src/convert.ts
var REASONING_PARAMS = new Set(["reasoning", "include_reasoning", "reasoning_effort"]);
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
function mapInputModalities(model) {
  const raw = model.architecture?.input_modalities;
  if (!raw || raw.length === 0)
    return ["text"];
  const result = [];
  for (const m of raw) {
    if (m === "text" || m === "image")
      result.push(m);
  }
  return result.length > 0 ? result : ["text"];
}
function inferReasoning(model) {
  const params = model.supported_parameters;
  if (!params)
    return false;
  return params.some((p) => REASONING_PARAMS.has(p));
}
function parsePrice(raw) {
  if (raw === undefined)
    return 0;
  const n = parseFloat(raw);
  return isFinite(n) && n >= 0 ? n : 0;
}
function resolveContextWindow(model) {
  const v = model.context_length ?? model.top_provider?.context_length ?? null;
  return v != null && v > 0 ? v : 8192;
}
function resolveMaxTokens(model, contextWindow) {
  const v = model.top_provider?.max_completion_tokens ?? null;
  return v != null && v > 0 ? v : contextWindow;
}
function resolvePricingTiers(model) {
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
function convertToDescriptor(raw, baseUrl) {
  const preferredApi = mapPreferredApi(raw.preferred_api);
  const adjustedBaseUrl = adjustBaseUrl(baseUrl, preferredApi);
  const contextWindow = resolveContextWindow(raw);
  const maxTokens = resolveMaxTokens(raw, contextWindow);
  const tiers = resolvePricingTiers(raw);
  const descriptor = {
    id: raw.id,
    name: raw.name ?? raw.id,
    preferredApi,
    provider: "plexus",
    baseUrl: adjustedBaseUrl,
    reasoning: inferReasoning(raw),
    input: mapInputModalities(raw),
    cost: {
      input: parsePrice(raw.pricing?.prompt),
      output: parsePrice(raw.pricing?.completion),
      cacheRead: parsePrice(raw.pricing?.input_cache_read),
      cacheWrite: parsePrice(raw.pricing?.input_cache_write),
      ...tiers !== undefined ? { tiers } : {}
    },
    contextWindow,
    maxTokens
  };
  if (raw.pi_provider)
    descriptor.piProvider = raw.pi_provider;
  if (raw.pi_model)
    descriptor.piModel = raw.pi_model;
  if (raw.pi_options && Object.keys(raw.pi_options).length > 0)
    descriptor.piOptions = raw.pi_options;
  return descriptor;
}
function convertDescriptors(models, baseUrl) {
  const result = [];
  for (const m of models) {
    if (!m.id)
      continue;
    result.push(convertToDescriptor(m, baseUrl));
  }
  return result;
}
function detectOpenAICompletionsCompat(providerName, baseUrl) {
  const name = providerName.toLowerCase();
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {}
  const isCerebras = name === "cerebras" || host.includes("cerebras");
  const isChutes = name === "chutes.ai" || host.includes("chutes.ai");
  const isXai = name === "xai" || host === "api.x.ai";
  const isZai = name === "zai" || host === "api.zai.com" || host.includes("z.ai");
  const isMoonshot = name === "moonshotai" || name === "moonshotai-cn" || host.includes("moonshot") || host.includes("kimi");
  const isOpencode = name === "opencode" || host.includes("opencode");
  const isCloudflareWorkers = host.includes("workers.cloudflare.com") || host.includes("ai.cloudflare.com");
  const isCloudflareGateway = host.includes("gateway.ai.cloudflare.com");
  const isCloudflare = isCloudflareWorkers || isCloudflareGateway;
  const isDeepSeek = name === "deepseek" || host.includes("deepseek");
  const isOpenRouter = name === "openrouter" || host.includes("openrouter.ai");
  const isNonStandard = isCerebras || isChutes || isXai || isZai || isMoonshot || isOpencode || isCloudflare || isDeepSeek;
  const supportsStore = !isNonStandard;
  const supportsDeveloperRole = !isNonStandard;
  const supportsReasoningEffort = !isXai && !isZai && !isMoonshot && !isCloudflareGateway;
  let maxTokensField = "max_completion_tokens";
  if (isChutes || isMoonshot || isCloudflareGateway) {
    maxTokensField = "max_tokens";
  }
  let thinkingFormat = "openai";
  if (isDeepSeek)
    thinkingFormat = "deepseek";
  else if (isZai)
    thinkingFormat = "zai";
  else if (isOpenRouter)
    thinkingFormat = "openrouter";
  const requiresReasoningContentOnAssistantMessages = isDeepSeek;
  const cacheControlFormat = isOpenRouter ? "anthropic" : undefined;
  const supportsStrictMode = !isMoonshot && !isCloudflareGateway;
  const supportsLongCacheRetention = !isCloudflare;
  const compat = {
    supportsStore,
    supportsDeveloperRole,
    supportsReasoningEffort,
    supportsUsageInStreaming: true,
    maxTokensField,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages,
    thinkingFormat,
    openRouterRouting: {},
    vercelGatewayRouting: {},
    zaiToolStream: false,
    supportsStrictMode,
    sendSessionAffinityHeaders: false,
    supportsLongCacheRetention
  };
  if (cacheControlFormat !== undefined) {
    compat.cacheControlFormat = cacheControlFormat;
  }
  return compat;
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
// src/config.ts
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
var getConfigDir = () => join(getAgentDir(), "extensions", "plexus");
var getConfigPath = () => join(getConfigDir(), "config.json");
var ENV_BASE_URL = "PLEXUS_BASE_URL";
var ENV_API_URL = "PLEXUS_API_URL";
var ENV_API_KEY = "PLEXUS_API_KEY";
var ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
var normalizeRoot = (raw) => raw.trim().replace(/\/+$/, "");
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
  if (!value)
    return;
  const resolved = resolveConfigTemplate(value)?.trim();
  return resolved || undefined;
}
var normalizeConfigBaseUrl = (raw) => {
  const root = normalizeRoot(raw);
  return root.endsWith("/v1") ? root.slice(0, -3) : root;
};
var normalizeApiBase = (raw) => {
  const root = normalizeConfigBaseUrl(raw);
  return root ? `${root}/v1` : "";
};
var cachedConfig = null;
function getConfigSync() {
  if (cachedConfig)
    return cachedConfig;
  try {
    if (existsSync(getConfigPath())) {
      cachedConfig = JSON.parse(readFileSync(getConfigPath(), "utf8"));
      return cachedConfig;
    }
  } catch {}
  cachedConfig = {};
  return cachedConfig;
}
async function saveBaseUrl(baseUrl, defaultModel) {
  await mkdir(getConfigDir(), { recursive: true });
  const existing = getConfigSync();
  const config = {
    ...existing,
    baseUrl: normalizeConfigBaseUrl(baseUrl),
    ...defaultModel !== undefined && { defaultModel }
  };
  await writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}
`, "utf8");
  cachedConfig = config;
}
function getRawBaseUrl() {
  const config = getConfigSync();
  return resolveStringOption(process.env[ENV_API_URL]) ?? resolveStringOption(process.env[ENV_BASE_URL]) ?? resolveStringOption(config.baseUrl) ?? null;
}
function getEnvApiKey() {
  return resolveStringOption(process.env[ENV_API_KEY]) ?? null;
}
function getModelsUrl() {
  const raw = getRawBaseUrl();
  return raw ? `${normalizeApiBase(raw)}/models` : null;
}
function getBaseUrl() {
  const raw = getRawBaseUrl();
  return raw ? normalizeApiBase(raw) : null;
}
function getDefaultModel() {
  return getConfigSync().defaultModel ?? null;
}

// src/cache.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { mkdir as mkdir2, writeFile as writeFile2 } from "fs/promises";
import { join as join2 } from "path";
import { getAgentDir as getAgentDir2 } from "@earendil-works/pi-coding-agent";
var getCacheDir = () => join2(getAgentDir2(), "extensions", "plexus");
var getModelsCachePath = () => join2(getCacheDir(), "plexus-models-cache.json");
var getRawResponsePath = () => join2(getCacheDir(), "plexus-models-response.json");
function parseCacheData(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const obj = parsed;
    if (!Array.isArray(obj["models"]))
      return null;
    return {
      models: obj["models"],
      timestamp: typeof obj["timestamp"] === "number" ? obj["timestamp"] : 0
    };
  } catch {
    return null;
  }
}
function readCachedModelsSync() {
  try {
    const p = getModelsCachePath();
    if (!existsSync2(p))
      return null;
    return parseCacheData(readFileSync2(p, "utf8"));
  } catch {
    return null;
  }
}
async function writeCachedModels(models) {
  await mkdir2(getCacheDir(), { recursive: true });
  const payload = { models, timestamp: Date.now() };
  await writeFile2(getModelsCachePath(), `${JSON.stringify(payload, null, 2)}
`, "utf8");
}
async function writeRawResponse(data) {
  await mkdir2(getCacheDir(), { recursive: true });
  await writeFile2(getRawResponsePath(), `${JSON.stringify(data, null, 2)}
`, "utf8");
}

// src/log.ts
import { mkdir as mkdir3, appendFile } from "fs/promises";
import { join as join3 } from "path";
import { getAgentDir as getAgentDir3 } from "@earendil-works/pi-coding-agent";
var getCacheDir2 = () => join3(getAgentDir3(), "extensions", "plexus");
var getLogPath = () => join3(getCacheDir2(), "plexus.log");
var dirEnsured = false;
function log(message, data) {
  writeLogLine(message, data);
}
async function writeLogLine(message, data) {
  try {
    if (!dirEnsured) {
      await mkdir3(getCacheDir2(), { recursive: true });
      dirEnsured = true;
    }
    const ts = new Date().toISOString();
    const line = data !== undefined ? `${ts} ${message} ${JSON.stringify(data)}
` : `${ts} ${message}
`;
    await appendFile(getLogPath(), line, "utf8");
  } catch {}
}

// src/mapper.ts
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
function descriptorToPiModel(descriptor) {
  let builtinModel;
  if (descriptor.piProvider && descriptor.piModel) {
    try {
      builtinModel = getBuiltinModel(descriptor.piProvider, descriptor.piModel);
    } catch {
      builtinModel = undefined;
    }
  }
  const cost = {
    input: descriptor.cost.input * 1e6,
    output: descriptor.cost.output * 1e6,
    cacheRead: descriptor.cost.cacheRead * 1e6,
    cacheWrite: descriptor.cost.cacheWrite * 1e6,
    ...descriptor.cost.tiers ? {
      tiers: descriptor.cost.tiers.map((tier) => ({
        inputTokensAbove: tier.inputTokensAbove,
        input: tier.input * 1e6,
        output: tier.output * 1e6,
        cacheRead: tier.cacheRead * 1e6,
        cacheWrite: tier.cacheWrite * 1e6
      }))
    } : {}
  };
  let compat;
  if (descriptor.preferredApi === "openai-completions") {
    const heuristic = detectOpenAICompletionsCompat(descriptor.piProvider ?? descriptor.provider, descriptor.baseUrl);
    const builtinCompat = builtinModel?.compat;
    const merged = { ...heuristic, ...builtinCompat ?? {}, ...descriptor.piOptions ?? {} };
    compat = merged;
  } else if (descriptor.piOptions) {
    compat = descriptor.piOptions;
  } else if (builtinModel?.compat) {
    compat = builtinModel.compat;
  }
  return {
    id: descriptor.id,
    name: descriptor.name,
    api: descriptor.preferredApi,
    baseUrl: descriptor.baseUrl,
    reasoning: descriptor.reasoning,
    input: descriptor.input,
    cost,
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
    ...builtinModel?.thinkingLevelMap !== undefined ? { thinkingLevelMap: builtinModel.thinkingLevelMap } : {},
    ...builtinModel?.headers !== undefined ? { headers: builtinModel.headers } : {},
    ...compat !== undefined ? { compat } : {}
  };
}

// src/extension.ts
var PROVIDER_NAME = "plexus";
var PROVIDER_API_KEY_TEMPLATE = "${PLEXUS_API_KEY}";
var PLEXUS_CREDENTIAL_EXPIRES_AT = 253402300799000;
var currentModels = [];
function plexusExtension(pi) {
  const cached = readCachedModelsSync();
  const startupBaseUrl = getBaseUrl() ?? "http://localhost/v1";
  const startupModels = cached?.models.map(descriptorToPiModel) ?? [];
  log("startup", {
    cachedModelCount: startupModels.length,
    startupBaseUrl
  });
  pi.registerProvider(PROVIDER_NAME, {
    api: "openai-completions",
    apiKey: PROVIDER_API_KEY_TEMPLATE,
    authHeader: true,
    baseUrl: startupBaseUrl,
    models: startupModels,
    oauth: createPlexusLoginProvider(pi)
  });
  currentModels = startupModels;
  pi.on("session_start", async (_event, ctx) => {
    const apiKey = await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME) ?? getEnvApiKey();
    const baseUrl = getBaseUrl();
    log("session_start", { hasApiKey: !!apiKey, baseUrl });
    if (!apiKey || !baseUrl) {
      log("session_start: no auth configured, skipping refresh");
      await trySetDefaultModel(pi, startupModels);
      return;
    }
    await doRefresh(pi, apiKey, ctx, true);
  });
  pi.registerCommand("plexus", {
    description: "Plexus provider commands: refresh (setup: /login plexus)",
    getArgumentCompletions: () => [
      { value: "refresh", label: "refresh", description: "Refresh Plexus models from the API" }
    ],
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "refresh" || sub === "") {
        await handleRefresh(pi, ctx);
        return;
      }
      ctx.ui.notify(`Unknown sub-command: "${args}". Use /login plexus for setup or /plexus refresh to refresh models.`, "warning");
    }
  });
}
function createPlexusLoginProvider(pi) {
  return {
    name: "Plexus",
    async login(callbacks) {
      const baseUrl = (await callbacks.onPrompt({
        message: "Plexus base URL",
        placeholder: "https://plexus.example.com"
      })).trim();
      if (!baseUrl)
        throw new Error("Plexus base URL is required.");
      const apiKey = (await callbacks.onPrompt({ message: "Plexus API key" })).trim();
      if (!apiKey)
        throw new Error("Plexus API key is required.");
      await saveBaseUrl(baseUrl);
      callbacks.onProgress?.("Refreshing Plexus models...");
      await doRefresh(pi, apiKey, null, false);
      return {
        access: apiKey,
        refresh: apiKey,
        expires: PLEXUS_CREDENTIAL_EXPIRES_AT,
        plexusBaseUrl: baseUrl
      };
    },
    async refreshToken(credentials) {
      return { ...credentials, expires: PLEXUS_CREDENTIAL_EXPIRES_AT };
    },
    getApiKey(credentials) {
      return String(credentials.access || credentials.refresh || "");
    },
    modifyModels(models, credentials) {
      const baseUrl = credentials.plexusBaseUrl;
      if (!baseUrl)
        return models;
      const apiBase = baseUrl.trim().replace(/\/+$/, "").endsWith("/v1") ? baseUrl.trim().replace(/\/+$/, "") : `${baseUrl.trim().replace(/\/+$/, "")}/v1`;
      return models.map((model) => model.provider === PROVIDER_NAME ? { ...model, baseUrl: apiBase } : model);
    }
  };
}
async function handleRefresh(pi, ctx) {
  const apiKey = await ctx.modelRegistry.authStorage.getApiKey(PROVIDER_NAME) ?? getEnvApiKey();
  if (!apiKey) {
    ctx.ui.notify("No Plexus API key configured. Run /login plexus first.", "error");
    return;
  }
  ctx.ui.notify("Refreshing Plexus models\u2026", "info");
  await doRefresh(pi, apiKey, ctx, true);
}
async function doRefresh(pi, apiKey, ctx, setDefault) {
  const modelsUrl = getModelsUrl();
  const baseUrl = getBaseUrl();
  if (!modelsUrl || !baseUrl) {
    if (ctx)
      ctx.ui.notify("Plexus base URL not configured. Run /login plexus first.", "warning");
    log("doRefresh: no base URL configured");
    return;
  }
  try {
    const { models: apiModels, raw } = await fetchPlexusModels(apiKey, modelsUrl);
    const descriptors = convertDescriptors(apiModels, baseUrl);
    const piModels = descriptors.map(descriptorToPiModel);
    await Promise.all([writeCachedModels(descriptors), writeRawResponse(raw)]);
    currentModels = piModels;
    pi.registerProvider(PROVIDER_NAME, {
      api: "openai-completions",
      apiKey: PROVIDER_API_KEY_TEMPLATE,
      authHeader: true,
      baseUrl,
      models: piModels,
      oauth: createPlexusLoginProvider(pi)
    });
    log("doRefresh: registered", { count: piModels.length });
    if (ctx)
      ctx.ui.notify(`Refreshed ${piModels.length} Plexus models`, "info");
    if (setDefault)
      await trySetDefaultModel(pi, piModels);
  } catch (error) {
    log("doRefresh: failed", { error: String(error) });
    if (ctx) {
      ctx.ui.notify(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}
async function trySetDefaultModel(pi, models) {
  const defaultModelId = getDefaultModel();
  if (!defaultModelId)
    return;
  const model = models.find((m) => m.id === defaultModelId);
  if (!model) {
    log("trySetDefaultModel: model not found", { defaultModelId });
    return;
  }
  const ok = await pi.setModel(model);
  log("trySetDefaultModel", { defaultModelId, ok });
}
export {
  plexusExtension as default
};
