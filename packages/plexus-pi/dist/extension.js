// @bun
// src/extension.ts
import * as os from "os";
import * as path4 from "path";

// ../plexus-models/src/convert.ts
var REASONING_PARAMS = new Set(["reasoning", "include_reasoning", "reasoning_effort"]);
var API_DIALECT_MAP = {
  chat_completions: "openai-completions",
  messages: "anthropic-messages",
  gemini: "google-generative-ai",
  responses: "openai-responses"
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
function convertToDescriptor(raw, baseUrl) {
  const preferredApi = mapPreferredApi(raw.preferred_api);
  const adjustedBaseUrl = adjustBaseUrl(baseUrl, preferredApi);
  const contextWindow = resolveContextWindow(raw);
  const maxTokens = resolveMaxTokens(raw, contextWindow);
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
      cacheWrite: parsePrice(raw.pricing?.input_cache_write)
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
// ../plexus-models/src/config.ts
import * as fs from "fs";
import * as path from "path";
var PLEXUS_DIR = "extensions/plexus";
var CONFIG_FILE = "config.json";
function getConfigPath(agentDir) {
  return path.join(agentDir, PLEXUS_DIR, CONFIG_FILE);
}
function getConfigSync(agentDir) {
  try {
    const raw = fs.readFileSync(getConfigPath(agentDir), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}
async function saveBaseUrl(agentDir, baseUrl, defaultModel) {
  const configPath = getConfigPath(agentDir);
  const dir = path.dirname(configPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const existing = getConfigSync(agentDir);
  const updated = {
    ...existing,
    baseUrl: baseUrl.replace(/\/+$/, "")
  };
  if (defaultModel !== undefined) {
    updated.defaultModel = defaultModel;
  }
  await fs.promises.writeFile(configPath, JSON.stringify(updated, null, 2) + `
`, "utf8");
}
function getRawBaseUrl(agentDir) {
  const cfg = getConfigSync(agentDir);
  const raw = cfg.baseUrl ?? process.env["PLEXUS_BASE_URL"] ?? null;
  if (!raw)
    return null;
  return raw.replace(/\/+$/, "");
}
function getBaseUrl(agentDir) {
  const raw = getRawBaseUrl(agentDir);
  return raw ? `${raw}/v1` : null;
}
function getModelsUrl(agentDir) {
  const raw = getRawBaseUrl(agentDir);
  return raw ? `${raw}/v1/models` : null;
}
// ../plexus-models/src/cache.ts
import * as fs2 from "fs";
import * as path2 from "path";
var PLEXUS_DIR2 = "extensions/plexus";
var CACHE_FILE = "plexus-models-cache.json";
var RAW_RESPONSE_FILE = "plexus-models-response.json";
function getCachePath(agentDir) {
  return path2.join(agentDir, PLEXUS_DIR2, CACHE_FILE);
}
function getRawResponsePath(agentDir) {
  return path2.join(agentDir, PLEXUS_DIR2, RAW_RESPONSE_FILE);
}
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
function readCachedModelsSync(agentDir) {
  try {
    const raw = fs2.readFileSync(getCachePath(agentDir), "utf8");
    return parseCacheData(raw);
  } catch {
    return null;
  }
}
async function writeCachedModels(agentDir, models) {
  const cachePath = getCachePath(agentDir);
  await fs2.promises.mkdir(path2.dirname(cachePath), { recursive: true });
  const payload = { models, timestamp: Date.now() };
  await fs2.promises.writeFile(cachePath, JSON.stringify(payload, null, 2) + `
`, "utf8");
}
async function writeRawResponse(agentDir, data) {
  const rawPath = getRawResponsePath(agentDir);
  await fs2.promises.mkdir(path2.dirname(rawPath), { recursive: true });
  await fs2.promises.writeFile(rawPath, JSON.stringify(data, null, 2) + `
`, "utf8");
}
// ../plexus-models/src/log.ts
import * as fs3 from "fs";
import * as path3 from "path";
var PLEXUS_DIR3 = "extensions/plexus";
var LOG_FILE = "plexus.log";
function log(agentDir, message, data) {
  try {
    const logPath = path3.join(agentDir, PLEXUS_DIR3, LOG_FILE);
    const dir = path3.dirname(logPath);
    fs3.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const line = data !== undefined ? `${ts} ${message} ${JSON.stringify(data)}
` : `${ts} ${message}
`;
    fs3.appendFileSync(logPath, line, "utf8");
  } catch {}
}
// src/mapper.ts
function descriptorToPiModel(descriptor) {
  const cost = {
    input: descriptor.cost.input * 1e6,
    output: descriptor.cost.output * 1e6,
    cacheRead: descriptor.cost.cacheRead * 1e6,
    cacheWrite: descriptor.cost.cacheWrite * 1e6
  };
  let compat;
  if (descriptor.preferredApi === "openai-completions") {
    const heuristic = detectOpenAICompletionsCompat(descriptor.provider, descriptor.baseUrl);
    const merged = descriptor.piOptions ? { ...heuristic, ...descriptor.piOptions } : heuristic;
    compat = merged;
  } else if (descriptor.piOptions) {
    compat = descriptor.piOptions;
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
    ...compat !== undefined ? { compat } : {}
  };
}

// src/extension.ts
var PROVIDER_NAME = "plexus";
function getAgentDir() {
  const override = process.env["PI_CODING_AGENT_DIR"];
  if (override)
    return path4.resolve(override);
  const configDir = process.env["PI_CONFIG_DIR"] || ".pi";
  return path4.join(os.homedir(), configDir, "agent");
}
function getApiKey() {
  return process.env["PLEXUS_API_KEY"];
}
function plexusExtension(pi) {
  const agentDir = getAgentDir();
  const key = getApiKey();
  if (key) {
    const cached = readCachedModelsSync(agentDir);
    if (cached && cached.models.length > 0) {
      const baseUrl = getBaseUrl(agentDir);
      if (baseUrl) {
        pi.registerProvider(PROVIDER_NAME, {
          baseUrl,
          apiKey: key,
          api: "openai-completions",
          authHeader: true,
          models: cached.models.map(descriptorToPiModel)
        });
        log(agentDir, "startup: registered from cache", { count: cached.models.length });
      }
    }
  }
  pi.on("session_start", async () => {
    await doRefresh(pi, agentDir, null);
  });
  pi.registerCommand("plexus", {
    description: "Manage Plexus AI model proxy. Sub-commands: login, refresh",
    async handler(args, ctx) {
      const sub = args.trim().toLowerCase();
      if (sub === "login" || sub === "") {
        await handleLogin(pi, ctx, agentDir);
      } else if (sub === "refresh") {
        await handleRefresh(pi, ctx, agentDir);
      } else {
        ctx.ui.notify(`Unknown sub-command: "${args}". Use: /plexus login | /plexus refresh`, "warning");
      }
    }
  });
}
async function handleLogin(pi, ctx, agentDir) {
  if (!getApiKey()) {
    ctx.ui.notify("PLEXUS_API_KEY env var is not set. Set it and restart omp.", "error");
    return;
  }
  const baseUrlInput = await ctx.ui.input("Plexus base URL", "https://plexus.example.com");
  if (!baseUrlInput) {
    ctx.ui.notify("Login cancelled.", "info");
    return;
  }
  const defaultModelInput = await ctx.ui.input("Default model (optional \u2014 Enter to skip)", "");
  await saveBaseUrl(agentDir, baseUrlInput.trim(), defaultModelInput?.trim() || undefined);
  ctx.ui.notify("Plexus config saved. Refreshing models\u2026", "info");
  await doRefresh(pi, agentDir, ctx);
}
async function handleRefresh(pi, ctx, agentDir) {
  ctx.ui.notify("Refreshing Plexus models\u2026", "info");
  await doRefresh(pi, agentDir, ctx);
}
async function doRefresh(pi, agentDir, notify) {
  const modelsUrl = getModelsUrl(agentDir);
  const baseUrl = getBaseUrl(agentDir);
  const key = getApiKey();
  if (!key) {
    if (notify)
      notify.ui.notify("PLEXUS_API_KEY env var is not set.", "error");
    return;
  }
  if (!modelsUrl || !baseUrl) {
    if (notify)
      notify.ui.notify("Plexus base URL not configured. Run /plexus login first.", "warning");
    return;
  }
  try {
    const { models: raw, raw: rawResponse } = await fetchPlexusModels(key, modelsUrl);
    const descriptors = convertDescriptors(raw, baseUrl);
    await writeCachedModels(agentDir, descriptors);
    await writeRawResponse(agentDir, rawResponse);
    pi.registerProvider(PROVIDER_NAME, {
      baseUrl,
      apiKey: key,
      api: "openai-completions",
      authHeader: true,
      models: descriptors.map(descriptorToPiModel)
    });
    log(agentDir, "refresh: ok", { count: descriptors.length });
    if (notify)
      notify.ui.notify(`Plexus: loaded ${descriptors.length} models.`, "info");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(agentDir, "refresh: error", { error: message });
    if (notify)
      notify.ui.notify(`Plexus refresh failed: ${message}`, "error");
  }
}
export {
  plexusExtension as default
};
